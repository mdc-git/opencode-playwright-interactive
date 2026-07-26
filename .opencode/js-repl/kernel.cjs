// Adapted from OpenAI Codex's js_repl kernel at revision 219c65d.
// Licensed under Apache-2.0. See LICENSE and NOTICE at the project root.

const { Buffer } = require("node:buffer");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { builtinModules, createRequire } = require("node:module");
const { performance } = require("node:perf_hooks");
const path = require("node:path");
const { URL, URLSearchParams, fileURLToPath, pathToFileURL } = require("node:url");
const { inspect, TextDecoder, TextEncoder } = require("node:util");
const vm = require("node:vm");

const { SourceTextModule, SyntheticModule } = vm;
const meriyahPromise = import("meriyah").then((module) => module.default ?? module);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_EXEC = 4;
const MAX_TOTAL_IMAGE_BYTES = MAX_IMAGE_BYTES * MAX_IMAGES_PER_EXEC;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const context = vm.createContext({});
context.globalThis = context;
context.global = context;
context.Buffer = Buffer;
context.console = console;
context.URL = URL;
context.URLSearchParams = URLSearchParams;
context.TextEncoder = TextEncoder;
context.TextDecoder = TextDecoder;
context.AbortController = AbortController;
context.AbortSignal = AbortSignal;
context.structuredClone = structuredClone;
context.fetch = fetch;
context.Headers = Headers;
context.Request = Request;
context.Response = Response;
context.performance = performance;
context.crypto = crypto.webcrypto ?? crypto;
context.setTimeout = setTimeout;
context.clearTimeout = clearTimeout;
context.setInterval = setInterval;
context.clearInterval = clearInterval;
context.queueMicrotask = queueMicrotask;
context.setImmediate = setImmediate;
context.clearImmediate = clearImmediate;
context.atob = (data) => Buffer.from(data, "base64").toString("binary");
context.btoa = (data) => Buffer.from(data, "binary").toString("base64");

let previousModule = null;
let previousBindings = [];
let cellCounter = 0;
let internalBindingCounter = 0;
let activeExecId = null;
let activeExecState = null;
let fatalExitScheduled = false;

const internalBindingSalt = (() => {
  const raw = process.env.OPENCODE_JS_REPL_SESSION_ID ?? "";
  return raw.replace(/[^A-Za-z0-9_$]/g, "_") || "session";
})();

const cwd = process.cwd();
const tmpDir = process.env.OPENCODE_JS_REPL_TMP_DIR || cwd;
const homeDir = process.env.HOME ?? null;

function normalizeImageMimeType(value) {
  const mime = typeof value === "string" ? value.toLowerCase() : "";
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mime)) {
    throw new Error("opencode.emitImage supports PNG, JPEG, WebP, and GIF images only");
  }
  return mime;
}

function imageExtension(mime) {
  if (mime === "image/jpeg") return "jpg";
  return mime.slice("image/".length);
}

function normalizeImageFilename(value, mime) {
  if (value == null) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("opencode.emitImage filename must be a non-empty string");
  }
  const base = path.basename(value.trim()).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 255);
  return base || `js-repl-image.${imageExtension(mime)}`;
}

function byteView(value) {
  if (Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return Buffer.from(value);
  }
  return null;
}

function decodedBase64Size(value) {
  const compact = value.replace(/\s/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("opencode.emitImage expected valid base64 image data");
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function normalizeImage(value) {
  if (typeof value === "string") {
    const match = value.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
    if (!match) throw new Error("opencode.emitImage expected a base64 image data URL");
    const mime = normalizeImageMimeType(match[1]);
    const bytes = decodedBase64Size(match[2]);
    if (bytes === 0) throw new Error("opencode.emitImage expected non-empty image data");
    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error(`opencode.emitImage image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
    }
    return { type: "file", mime, url: value, bytes };
  }

  if (!value || typeof value !== "object" || !("bytes" in value)) {
    throw new Error("opencode.emitImage expected a data URL or { bytes, mimeType, filename? }");
  }
  const bytes = byteView(value.bytes);
  if (!bytes) {
    throw new Error("opencode.emitImage bytes must be a Buffer, Uint8Array, ArrayBuffer, or array-buffer view");
  }
  if (bytes.byteLength === 0) throw new Error("opencode.emitImage expected non-empty image bytes");
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`opencode.emitImage image exceeds the ${MAX_IMAGE_BYTES}-byte limit`);
  }
  const mime = normalizeImageMimeType(value.mimeType);
  return {
    type: "file",
    mime,
    url: `data:${mime};base64,${bytes.toString("base64")}`,
    filename: normalizeImageFilename(value.filename, mime),
    bytes: bytes.byteLength,
  };
}

function emitImage(imageLike) {
  const state = activeExecState;
  if (!state) return Promise.reject(new Error("opencode.emitImage requires an active js_repl execution"));
  const observation = { observed: false };
  const operation = (async () => {
    const image = normalizeImage(await imageLike);
    if (state.attachments.length >= MAX_IMAGES_PER_EXEC) {
      throw new Error(`opencode.emitImage supports at most ${MAX_IMAGES_PER_EXEC} images per execution`);
    }
    if (state.attachmentBytes + image.bytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error(`opencode.emitImage images exceed the ${MAX_TOTAL_IMAGE_BYTES}-byte execution limit`);
    }
    state.attachmentBytes += image.bytes;
    const { bytes: _bytes, ...attachment } = image;
    state.attachments.push(attachment);
  })();
  state.pendingImages.push(
    operation.then(
      () => ({ ok: true, observation }),
      (error) => ({ ok: false, error, observation }),
    ),
  );
  return {
    then(onFulfilled, onRejected) {
      observation.observed = true;
      return operation.then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      observation.observed = true;
      return operation.catch(onRejected);
    },
    finally(onFinally) {
      observation.observed = true;
      return operation.finally(onFinally);
    },
  };
}

context.opencode = Object.freeze({ cwd, homeDir, tmpDir, emitImage });
context.tmpDir = tmpDir;

const builtinModuleSet = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const deniedBuiltinModules = new Set([
  "process",
  "node:process",
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
]);
const moduleSearchBases = (() => {
  const bases = [];
  const seen = new Set();
  const configured = process.env.OPENCODE_JS_REPL_NODE_MODULE_DIRS ?? "";
  for (const entry of configured.split(path.delimiter)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
    const base = path.basename(resolved) === "node_modules" ? path.dirname(resolved) : resolved;
    if (!seen.has(base)) {
      seen.add(base);
      bases.push(base);
    }
  }
  if (!seen.has(cwd)) bases.push(cwd);
  return bases;
})();

const requireByBase = new Map();
const linkedFileModules = new Map();
const linkedNativeModules = new Map();
const linkedModuleEvaluations = new Map();

function clearLocalFileModuleCaches() {
  linkedFileModules.clear();
  linkedModuleEvaluations.clear();
}

function canonicalizePath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value;
  }
}

function getRequireForBase(base) {
  let req = requireByBase.get(base);
  if (!req) {
    req = createRequire(path.join(base, "__opencode_js_repl__.cjs"));
    requireByBase.set(base, req);
  }
  return req;
}

function isWithinBaseNodeModules(base, resolvedPath) {
  const root = path.resolve(canonicalizePath(base), "node_modules");
  const relative = path.relative(root, canonicalizePath(resolvedPath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isFileUrlSpecifier(specifier) {
  if (typeof specifier !== "string" || !specifier.startsWith("file:")) return false;
  try {
    return new URL(specifier).protocol === "file:";
  } catch {
    return false;
  }
}

function isPathSpecifier(specifier) {
  if (typeof specifier !== "string" || !specifier || specifier.trim() !== specifier) return false;
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith(".\\") ||
    specifier.startsWith("..\\") ||
    path.isAbsolute(specifier) ||
    isFileUrlSpecifier(specifier)
  );
}

function isBarePackageSpecifier(specifier) {
  return (
    typeof specifier === "string" &&
    Boolean(specifier) &&
    specifier.trim() === specifier &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("\\") &&
    !path.isAbsolute(specifier) &&
    !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier) &&
    !specifier.includes("\\")
  );
}

function resolvePathSpecifier(specifier, referrerIdentifier = null) {
  let candidate;
  try {
    candidate = isFileUrlSpecifier(specifier)
      ? fileURLToPath(new URL(specifier))
      : path.isAbsolute(specifier)
        ? specifier
        : path.resolve(referrerIdentifier ? path.dirname(referrerIdentifier) : cwd, specifier);
  } catch (error) {
    throw new Error(`Failed to resolve module "${specifier}": ${error.message}`);
  }

  let resolvedPath;
  try {
    resolvedPath = fs.realpathSync.native(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Module not found: ${specifier}`);
    throw error;
  }
  if (!fs.statSync(resolvedPath).isFile()) {
    throw new Error(`Directory imports are not supported: ${specifier}`);
  }
  const extension = path.extname(resolvedPath).toLowerCase();
  if (extension !== ".js" && extension !== ".mjs") {
    throw new Error(`Only local .js and .mjs modules are supported: ${specifier}`);
  }
  return { kind: "file", path: resolvedPath };
}

function resolveBareSpecifier(specifier) {
  let firstError = null;
  for (const base of moduleSearchBases) {
    try {
      const resolved = getRequireForBase(base).resolve(specifier, {
        conditions: new Set(["node", "import"]),
      });
      if (isWithinBaseNodeModules(base, resolved)) return resolved;
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_MODULE_NOT_FOUND") {
        firstError ??= error;
      }
    }
  }
  if (firstError) throw firstError;
  return null;
}

function resolveSpecifier(specifier, referrerIdentifier = null) {
  if (specifier.startsWith("node:") || builtinModuleSet.has(specifier)) {
    const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (deniedBuiltinModules.has(specifier) || deniedBuiltinModules.has(normalized)) {
      throw new Error(`Importing module "${specifier}" is not allowed in js_repl`);
    }
    return { kind: "builtin", specifier: `node:${normalized}` };
  }
  if (isPathSpecifier(specifier)) return resolvePathSpecifier(specifier, referrerIdentifier);
  if (!isBarePackageSpecifier(specifier)) {
    throw new Error(`Unsupported import specifier "${specifier}"`);
  }
  const resolved = resolveBareSpecifier(specifier);
  if (!resolved) throw new Error(`Module not found: ${specifier}`);
  return { kind: "package", path: resolved, specifier };
}

function resolvedToUrl(resolved) {
  if (resolved.kind === "builtin") return resolved.specifier;
  if (resolved.kind === "file") return pathToFileURL(resolved.path).href;
  if (resolved.kind === "package") return resolved.specifier;
  throw new Error(`Unsupported module resolution kind: ${resolved.kind}`);
}

function setImportMeta(meta, module, isMain = false) {
  meta.url = pathToFileURL(module.identifier).href;
  meta.filename = module.identifier;
  meta.dirname = path.dirname(module.identifier);
  meta.main = isMain;
  meta.resolve = (specifier) => resolvedToUrl(resolveSpecifier(specifier, module.identifier));
}

async function loadLinkedNativeModule(resolved) {
  const key = resolved.kind === "builtin" ? resolved.specifier : resolved.path;
  let promise = linkedNativeModules.get(key);
  if (!promise) {
    promise = (async () => {
      const namespace = await import(
        resolved.kind === "builtin" ? resolved.specifier : pathToFileURL(resolved.path).href
      );
      const names = Object.getOwnPropertyNames(namespace);
      return new SyntheticModule(
        names,
        function initialize() {
          for (const name of names) this.setExport(name, namespace[name]);
        },
        { context },
      );
    })();
    linkedNativeModules.set(key, promise);
  }
  return promise;
}

async function loadLinkedFileModule(modulePath) {
  let module = linkedFileModules.get(modulePath);
  if (!module) {
    module = new SourceTextModule(fs.readFileSync(modulePath, "utf8"), {
      context,
      identifier: modulePath,
      initializeImportMeta(meta, current) {
        setImportMeta(meta, current, false);
      },
      importModuleDynamically(specifier, referrer) {
        return importResolved(resolveSpecifier(specifier, referrer?.identifier));
      },
    });
    linkedFileModules.set(modulePath, module);
  }
  if (module.status === "unlinked") {
    await module.link(async (specifier, referrer) => {
      const resolved = resolveSpecifier(specifier, referrer?.identifier);
      if (resolved.kind !== "file") {
        throw new Error(
          `Static import "${specifier}" is not supported from local files; use await import(...)`,
        );
      }
      return loadLinkedFileModule(resolved.path);
    });
  }
  return module;
}

async function importResolved(resolved) {
  if (resolved.kind !== "file") {
    return import(resolved.kind === "builtin" ? resolved.specifier : pathToFileURL(resolved.path).href);
  }
  const module = await loadLinkedFileModule(resolved.path);
  let evaluation = linkedModuleEvaluations.get(resolved.path);
  if (!evaluation) {
    evaluation = module.evaluate();
    linkedModuleEvaluations.set(resolved.path, evaluation);
  }
  await evaluation;
  return module.namespace;
}

function collectPatternNames(pattern, kind, map) {
  if (!pattern) return;
  if (pattern.type === "Identifier") {
    if (!map.has(pattern.name)) map.set(pattern.name, kind);
    return;
  }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties ?? []) {
      collectPatternNames(property.type === "Property" ? property.value : property.argument, kind, map);
    }
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements ?? []) {
      if (element) collectPatternNames(element.type === "RestElement" ? element.argument : element, kind, map);
    }
    return;
  }
  if (pattern.type === "AssignmentPattern") collectPatternNames(pattern.left, kind, map);
  if (pattern.type === "RestElement") collectPatternNames(pattern.argument, kind, map);
}

function collectBindings(ast) {
  const bindings = new Map();
  for (const statement of ast.body ?? []) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        collectPatternNames(declaration.id, statement.kind, bindings);
      }
    } else if (statement.type === "FunctionDeclaration" && statement.id) {
      bindings.set(statement.id.name, "function");
    } else if (statement.type === "ClassDeclaration" && statement.id) {
      bindings.set(statement.id.name, "class");
    } else if (statement.type === "ForStatement" && statement.init?.type === "VariableDeclaration") {
      if (statement.init.kind === "var") {
        for (const declaration of statement.init.declarations) {
          collectPatternNames(declaration.id, "var", bindings);
        }
      }
    } else if (
      (statement.type === "ForInStatement" || statement.type === "ForOfStatement") &&
      statement.left?.type === "VariableDeclaration" &&
      statement.left.kind === "var"
    ) {
      for (const declaration of statement.left.declarations) {
        collectPatternNames(declaration.id, "var", bindings);
      }
    }
  }
  return Array.from(bindings, ([name, kind]) => ({ name, kind }));
}

function collectPatternBindingNames(pattern) {
  const names = new Map();
  collectPatternNames(pattern, "binding", names);
  return Array.from(names.keys());
}

function nextInternalBindingName() {
  return `__opencode_internal_commit_${internalBindingSalt}_${internalBindingCounter++}`;
}

function markExpression(names, marker) {
  return `(${marker}(${names.map((name) => JSON.stringify(name)).join(", ")}), undefined)`;
}

function instrumentVariableDeclaration(code, declaration, marker) {
  if (!declaration.declarations?.length) return code.slice(declaration.start, declaration.end);
  const first = declaration.declarations[0];
  const last = declaration.declarations[declaration.declarations.length - 1];
  const parts = [];
  for (const item of declaration.declarations) {
    parts.push(code.slice(item.start, item.end));
    const names = collectPatternBindingNames(item.id);
    if (names.length) parts.push(`${nextInternalBindingName()} = ${markExpression(names, marker)}`);
  }
  return `${code.slice(declaration.start, first.start)}${parts.join(", ")}${code.slice(last.end, declaration.end)}`;
}

function applyReplacements(code, replacements) {
  let output = code;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  }
  return output;
}

function instrumentCurrentBindings(code, ast, marker) {
  const replacements = [];
  for (const statement of ast.body ?? []) {
    if (statement.type === "VariableDeclaration") {
      replacements.push({
        start: statement.start,
        end: statement.end,
        text: instrumentVariableDeclaration(code, statement, marker),
      });
    } else if (statement.type === "FunctionDeclaration" && statement.id) {
      replacements.push({
        start: statement.start,
        end: statement.end,
        text: `${code.slice(statement.start, statement.end)}\n;${marker}(${JSON.stringify(statement.id.name)});`,
      });
    } else if (statement.type === "ClassDeclaration" && statement.id) {
      replacements.push({
        start: statement.start,
        end: statement.end,
        text: `${code.slice(statement.start, statement.end)}\n;${marker}(${JSON.stringify(statement.id.name)});`,
      });
    } else if (
      statement.type === "ForStatement" &&
      statement.init?.type === "VariableDeclaration" &&
      statement.init.kind === "var"
    ) {
      replacements.push({
        start: statement.init.start,
        end: statement.init.end,
        text: instrumentVariableDeclaration(code, statement.init, marker),
      });
    }
  }
  return applyReplacements(code, replacements);
}

async function buildModuleSource(code) {
  const meriyah = await meriyahPromise;
  const ast = meriyah.parseModule(code, {
    next: true,
    module: true,
    ranges: true,
    loc: false,
    disableWebCompat: true,
  });
  const currentBindings = collectBindings(ast);
  const priorBindings = previousModule ? previousBindings : [];
  const markCommittedName = nextInternalBindingName();
  const markPreludeName = nextInternalBindingName();
  const instrumented = instrumentCurrentBindings(code, ast, markCommittedName);

  let prelude = [
    `const ${markCommittedName} = import.meta.__opencodeMarkCommitted;`,
    `const ${markPreludeName} = import.meta.__opencodeMarkPrelude;`,
    "delete import.meta.__opencodeMarkCommitted;",
    "delete import.meta.__opencodeMarkPrelude;",
  ].join("\n");
  prelude += "\n";
  if (previousModule && priorBindings.length) {
    prelude += 'import * as __prev from "@prev";\n';
    prelude += priorBindings
      .map((binding) => {
        const keyword = binding.kind === "var" ? "var" : binding.kind === "const" ? "const" : "let";
        return `${keyword} ${binding.name} = __prev.${binding.name};`;
      })
      .join("\n");
    prelude += "\n";
  }
  prelude += `${markPreludeName}();\n`;

  const merged = new Map(priorBindings.map((binding) => [binding.name, binding.kind]));
  for (const binding of currentBindings) merged.set(binding.name, binding.kind);
  const exportNames = Array.from(merged.keys());
  const exports = exportNames.length ? `\nexport { ${exportNames.join(", ")} };` : "";
  return {
    source: `${prelude}${instrumented}${exports}`,
    currentBindings,
    priorBindings,
    nextBindings: Array.from(merged, ([name, kind]) => ({ name, kind })),
  };
}

function tryReadBinding(module, name) {
  try {
    module.namespace[name];
    return true;
  } catch {
    return false;
  }
}

function collectCommittedBindings(module, prior, current, explicitlyCommitted) {
  const merged = new Map(prior.map((binding) => [binding.name, binding.kind]));
  let currentCount = 0;
  for (const binding of current) {
    const readableLexical = !["var", "function"].includes(binding.kind) && tryReadBinding(module, binding.name);
    if (explicitlyCommitted.has(binding.name) || readableLexical) {
      merged.set(binding.name, binding.kind);
      currentCount += 1;
    }
  }
  return {
    bindings: Array.from(merged, ([name, kind]) => ({ name, kind })),
    currentCount,
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function formatError(error) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}

function scheduleFatalExit(kind, error) {
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;
  const message = `js_repl kernel ${kind}: ${formatError(error)}; kernel reset. Catch asynchronous errors to avoid kernel termination.`;
  if (activeExecId) {
    try {
      fs.writeSync(process.stdout.fd, `${JSON.stringify({
        type: "exec_result",
        id: activeExecId,
        ok: false,
        output: "",
        error: message,
      })}\n`);
    } catch {}
  }
  try {
    fs.writeSync(process.stderr.fd, `${message}\n`);
  } catch {}
  setImmediate(() => process.exit(1));
}

function formatLog(args) {
  return args
    .map((argument) =>
      typeof argument === "string" ? argument : inspect(argument, { depth: 4, colors: false }),
    )
    .join(" ");
}

async function withCapturedConsole(fn) {
  const logs = [];
  let bytes = 0;
  let truncated = false;
  const capture = (...args) => {
    if (truncated) return;
    const line = formatLog(args);
    const next = Buffer.byteLength(line) + (logs.length ? 1 : 0);
    if (bytes + next > MAX_OUTPUT_BYTES) {
      logs.push(`[js_repl output truncated at ${MAX_OUTPUT_BYTES} bytes]`);
      truncated = true;
      return;
    }
    logs.push(line);
    bytes += next;
  };
  const original = context.console;
  context.console = { ...console, log: capture, info: capture, warn: capture, error: capture, debug: capture };
  try {
    return await fn(logs);
  } finally {
    context.console = original;
  }
}

async function handleExec(message) {
  clearLocalFileModuleCaches();
  activeExecId = message.id;
  const execState = { attachments: [], attachmentBytes: 0, pendingImages: [] };
  activeExecState = execState;
  let module = null;
  let currentBindings = [];
  let priorBindings = previousBindings;
  let nextBindings = [];
  let linked = false;
  let preludeCompleted = false;
  const committed = new Set();

  try {
    const built = await buildModuleSource(typeof message.code === "string" ? message.code : "");
    currentBindings = built.currentBindings;
    priorBindings = built.priorBindings;
    nextBindings = built.nextBindings;

    const output = await withCapturedConsole(async (logs) => {
      const identifier = path.join(cwd, `.opencode_js_repl_cell_${cellCounter++}.mjs`);
      module = new SourceTextModule(built.source, {
        context,
        identifier,
        initializeImportMeta(meta, current) {
          setImportMeta(meta, current, true);
          meta.__opencodeMarkCommitted = (...names) => names.forEach((name) => committed.add(name));
          meta.__opencodeMarkPrelude = () => {
            preludeCompleted = true;
          };
        },
        importModuleDynamically(specifier, referrer) {
          return importResolved(resolveSpecifier(specifier, referrer?.identifier));
        },
      });
      await module.link(async (specifier) => {
        if (specifier === "@prev" && previousModule) {
          const bindings = previousBindings;
          const sourceModule = previousModule;
          return new SyntheticModule(
            bindings.map((binding) => binding.name),
            function initializePrevious() {
              for (const binding of bindings) this.setExport(binding.name, sourceModule.namespace[binding.name]);
            },
            { context },
          );
        }
        throw new Error(`Top-level static import "${specifier}" is not supported; use await import(...)`);
      });
      linked = true;
      await module.evaluate();
      if (execState.pendingImages.length) {
        const imageResults = await Promise.all(execState.pendingImages);
        const unhandled = imageResults.find((result) => !result.ok && !result.observation.observed);
        if (unhandled) throw unhandled.error;
      }
      return logs.join("\n");
    });

    previousModule = module;
    previousBindings = nextBindings;
    send({
      type: "exec_result",
      id: message.id,
      ok: true,
      output,
      attachments: execState.attachments,
      error: null,
    });
  } catch (error) {
    const result = collectCommittedBindings(linked ? module : null, priorBindings, currentBindings, committed);
    if (module && linked && (result.currentCount > 0 || (preludeCompleted && priorBindings.length > 0))) {
      previousModule = module;
      previousBindings = result.bindings;
    }
    send({ type: "exec_result", id: message.id, ok: false, output: "", error: formatError(error) });
  } finally {
    if (activeExecId === message.id) activeExecId = null;
    if (activeExecState === execState) activeExecState = null;
  }
}

let queue = Promise.resolve();
let pending = "";

process.on("uncaughtException", (error) => scheduleFatalExit("uncaught exception", error));
process.on("unhandledRejection", (error) => scheduleFatalExit("unhandled rejection", error));
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  while (true) {
    const newline = pending.indexOf("\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message.type === "exec") queue = queue.then(() => handleExec(message));
    } catch {}
  }
});
