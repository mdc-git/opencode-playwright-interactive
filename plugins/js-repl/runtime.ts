// Adapted from OpenAI Codex's js_repl kernel at revision 219c65d.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { createInterface, type Interface as ReadLineInterface } from "node:readline"
import { delimiter, join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MIN_NODE_VERSION = [22, 22, 0] as const
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PROTOCOL_LINE_BYTES = 32 * 1024 * 1024
const MERIYAH_VERSION = "7.0.0"
const PLAYWRIGHT_VERSION = "1.52.0"
const PLAYWRIGHT_PACKAGE = "rebrowser-playwright"
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])

// The persistent Node kernel is kept inline so this tool is self-contained.
const KERNEL_SOURCE = `// Adapted from OpenAI Codex's js_repl kernel at revision 219c65d.

const { Buffer } = require("node:buffer");
const { AsyncLocalStorage, createHook } = require("node:async_hooks");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { builtinModules, createRequire } = require("node:module");
const { performance } = require("node:perf_hooks");
const path = require("node:path");
const { URL, URLSearchParams, fileURLToPath, pathToFileURL } = require("node:url");
const { inspect, TextDecoder, TextEncoder } = require("node:util");
const vm = require("node:vm");

const { SourceTextModule, SyntheticModule } = vm;
const PROTOCOL_FD = 3;
const meriyahRequire = createRequire(process.env.OPENCODE_JS_REPL_MERIYAH_RESOLUTION_PATH ?? __filename);
const meriyahPromise = Promise.resolve(meriyahRequire("meriyah")).then((module) => module.default ?? module);
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
const unhandledRejections = new Map();
const rejectionScope = new AsyncLocalStorage();
const promiseOwners = new WeakMap();
createHook({
  init(_asyncId, type, _triggerAsyncId, resource) {
    if (type !== "PROMISE") return;
    const owner = rejectionScope.getStore();
    if (owner) promiseOwners.set(resource, owner);
  },
}).enable();

const internalBindingSalt = (() => {
  const raw = process.env.OPENCODE_JS_REPL_SESSION_ID ?? "";
  return raw.replace(/[^A-Za-z0-9_$]/g, "_") || "session";
})();

const cwd = process.cwd();
const tmpDir = process.env.OPENCODE_JS_REPL_TMP_DIR || cwd;
const homeDir = process.env.HOME ?? null;
const sessionId = process.env.OPENCODE_JS_REPL_SESSION_ID || null;
let browserBindingCounter = 0;
const workspaceRequire = createRequire(path.join(cwd, "__opencode_js_repl__.cjs"));

// This is a trusted local-code runtime, not a VM security boundary.
context.process = process;
context.require = workspaceRequire;
context.__filename = path.join(cwd, "__opencode_js_repl__.cjs");
context.__dirname = cwd;
context.module = { exports: {} };
context.exports = context.module.exports;

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
  return base || \`js-repl-image.\${imageExtension(mime)}\`;
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
  const compact = value.replace(/\\s/g, "");
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("opencode.emitImage expected valid base64 image data");
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function normalizeImage(value) {
  if (typeof value === "string") {
    const match = value.match(/^data:([^;,]+);base64,([\\s\\S]+)$/i);
    if (!match) throw new Error("opencode.emitImage expected a base64 image data URL");
    const mime = normalizeImageMimeType(match[1]);
    const bytes = decodedBase64Size(match[2]);
    if (bytes === 0) throw new Error("opencode.emitImage expected non-empty image data");
    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error(\`opencode.emitImage image exceeds the \${MAX_IMAGE_BYTES}-byte limit\`);
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
    throw new Error(\`opencode.emitImage image exceeds the \${MAX_IMAGE_BYTES}-byte limit\`);
  }
  const mime = normalizeImageMimeType(value.mimeType);
  return {
    type: "file",
    mime,
    url: \`data:\${mime};base64,\${bytes.toString("base64")}\`,
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
      throw new Error(\`opencode.emitImage supports at most \${MAX_IMAGES_PER_EXEC} images per execution\`);
    }
    if (state.attachmentBytes + image.bytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error(\`opencode.emitImage images exceed the \${MAX_TOTAL_IMAGE_BYTES}-byte execution limit\`);
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

function emitText(textLike) {
  const state = activeExecState;
  if (!state) return Promise.reject(new Error("opencode.emitText requires an active js_repl execution"));
  const text = typeof textLike === "string" ? textLike : textLike?.text;
  if (typeof text !== "string") return Promise.reject(new Error("opencode.emitText expected a string or { text }"));
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_OUTPUT_BYTES) {
    return Promise.reject(new Error(\`opencode.emitText text exceeds the \${MAX_OUTPUT_BYTES}-byte limit\`));
  }
  // Aggregate budget: console output and emitted text share one execution-wide
  // cap so many small calls cannot grow memory past the protocol line limit.
  if (state.outputBytes + bytes > MAX_OUTPUT_BYTES) {
    return Promise.reject(new Error(\`opencode.emitText output exceeds the execution-wide \${MAX_OUTPUT_BYTES}-byte budget shared with console output\`));
  }
  state.outputBytes += bytes;
  state.emittedText.push(text);
  return Promise.resolve();
}

function bindBrowser({ browser, context: browserContext, browserId, profileKind = "local" } = {}) {
  if (!sessionId) throw new Error("Could not identify the OpenCode session for browser binding");
  if (!browserContext || typeof browserContext.browser !== "function" || typeof browserContext.on !== "function") throw new TypeError("opencode.bindBrowser requires a Playwright BrowserContext");
  const contextBrowser = browserContext.browser();
  const boundBrowser = browser || contextBrowser;
  if (boundBrowser && typeof boundBrowser.isConnected !== "function") throw new TypeError("opencode.bindBrowser received an invalid Playwright Browser");
  if (browser && contextBrowser && contextBrowser !== browser) throw new Error("The BrowserContext does not belong to the supplied Browser");
  let contextClosed = false;
  browserContext.on("close", () => { contextClosed = true; });
  const resolvedBrowserId = typeof browserId === "string" && browserId ? browserId : sessionId + ":" + profileKind + ":" + (++browserBindingCounter);
  const binding = Object.freeze({ sessionId, browserId: resolvedBrowserId, profileKind });
  const connected = () => !contextClosed && (!boundBrowser || boundBrowser.isConnected());
  const assertPage = (currentPage) => {
    if (!connected()) throw new Error("Browser " + binding.browserId + " bound to OpenCode session " + binding.sessionId + " is closed. Stop interacting and do not adopt another browser.");
    if (!currentPage || typeof currentPage.isClosed !== "function" || currentPage.isClosed() || currentPage.context() !== browserContext) throw new Error("The target Page does not belong to browser " + binding.browserId + " bound to OpenCode session " + binding.sessionId + ".");
    return currentPage;
  };
  const assertLocator = (currentPage, locator) => {
    assertPage(currentPage);
    if (locator && typeof locator.page === "function" && locator.page() !== currentPage) throw new Error("The target locator belongs to a different Page or browser binding");
    return locator;
  };
  return Object.freeze({
    binding,
    assertPage,
    assertLocator,
    state: () => Object.freeze({ connected: connected(), binding }),
  });
}

context.opencode = Object.freeze({ cwd, homeDir, tmpDir, sessionId, bindBrowser, emitImage, emitText });
context.tmpDir = tmpDir;

const builtinModuleSet = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => \`node:\${name}\`),
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

const localModuleStamps = new Map();
function isLocalModuleFresh(modulePath) {
  const stamp = localModuleStamps.get(modulePath);
  if (!stamp) return false;
  try {
    const info = fs.statSync(modulePath);
    return info.mtimeMs === stamp.mtimeMs && info.size === stamp.size;
  } catch {
    return false;
  }
}
// Local file modules stay cached across cells so bindings, singletons and side
// effects persist for the session. A cell only invalidates a cached module
// whose file changed on disk (mtime or size), matching the iterate-and-reload
// workflow without re-running module side effects on every cell.
function pruneStaleLocalFileModules() {
  for (const modulePath of Array.from(linkedFileModules.keys())) {
    if (isLocalModuleFresh(modulePath)) continue;
    linkedFileModules.delete(modulePath);
    linkedModuleEvaluations.delete(modulePath);
    localModuleStamps.delete(modulePath);
  }
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
    specifier.startsWith(".\\\\") ||
    specifier.startsWith("..\\\\") ||
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
    !specifier.startsWith("\\\\") &&
    !path.isAbsolute(specifier) &&
    !/^[a-zA-Z][a-zA-Z\\d+.-]*:/.test(specifier) &&
    !specifier.includes("\\\\")
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
    throw new Error(\`Failed to resolve module "\${specifier}": \${error.message}\`);
  }

  let resolvedPath;
  try {
    resolvedPath = fs.realpathSync.native(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(\`Module not found: \${specifier}\`);
    throw error;
  }
  if (!fs.statSync(resolvedPath).isFile()) {
    throw new Error(\`Directory imports are not supported: \${specifier}\`);
  }
  const extension = path.extname(resolvedPath).toLowerCase();
  if (extension !== ".js" && extension !== ".mjs") {
    throw new Error(\`Only local .js and .mjs modules are supported: \${specifier}\`);
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
    return { kind: "builtin", specifier: \`node:\${normalized}\` };
  }
  if (isPathSpecifier(specifier)) return resolvePathSpecifier(specifier, referrerIdentifier);
  if (!isBarePackageSpecifier(specifier)) {
    throw new Error(\`Unsupported import specifier "\${specifier}"\`);
  }
  const resolved = resolveBareSpecifier(specifier);
  if (!resolved) throw new Error(\`Module not found: \${specifier}\`);
  return { kind: "package", path: resolved, specifier };
}

function resolvedToUrl(resolved) {
  if (resolved.kind === "builtin") return resolved.specifier;
  if (resolved.kind === "file") return pathToFileURL(resolved.path).href;
  // The ESM contract expects a URL string; return the resolved entry point,
  // not the original bare package name.
  if (resolved.kind === "package") return pathToFileURL(resolved.path).href;
  throw new Error(\`Unsupported module resolution kind: \${resolved.kind}\`);
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
    const info = fs.statSync(modulePath);
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
    localModuleStamps.set(modulePath, { mtimeMs: info.mtimeMs, size: info.size });
    linkedFileModules.set(modulePath, module);
  }
  if (module.status === "unlinked") {
    await module.link(async (specifier, referrer) => {
      const resolved = resolveSpecifier(specifier, referrer?.identifier);
      return resolved.kind === "file" ? loadLinkedFileModule(resolved.path) : loadLinkedNativeModule(resolved);
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
    } else if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.local?.name) bindings.set(specifier.local.name, "const");
      }
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
  return \`__opencode_internal_commit_\${internalBindingSalt}_\${internalBindingCounter++}\`;
}

function markExpression(names, marker) {
  return \`(\${marker}(\${names.map((name) => JSON.stringify(name)).join(", ")}), undefined)\`;
}

function instrumentVariableDeclaration(code, declaration, marker) {
  if (!declaration.declarations?.length) return code.slice(declaration.start, declaration.end);
  const first = declaration.declarations[0];
  const last = declaration.declarations[declaration.declarations.length - 1];
  const parts = [];
  for (const item of declaration.declarations) {
    parts.push(code.slice(item.start, item.end));
    const names = collectPatternBindingNames(item.id);
    if (names.length) parts.push(\`\${nextInternalBindingName()} = \${markExpression(names, marker)}\`);
  }
  return \`\${code.slice(declaration.start, first.start)}\${parts.join(", ")}\${code.slice(last.end, declaration.end)}\`;
}

function applyReplacements(code, replacements) {
  let output = code;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  }
  return output;
}

function instrumentCurrentBindings(code, ast, marker, completionMarker) {
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
        text: \`\${code.slice(statement.start, statement.end)}\\n;\${marker}(\${JSON.stringify(statement.id.name)});\`,
      });
    } else if (statement.type === "ClassDeclaration" && statement.id) {
      replacements.push({
        start: statement.start,
        end: statement.end,
        text: \`\${code.slice(statement.start, statement.end)}\\n;\${marker}(\${JSON.stringify(statement.id.name)});\`,
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
  const finalStatement = ast.body?.[ast.body.length - 1];
  if (finalStatement?.type === "ExpressionStatement") {
    replacements.push({
      start: finalStatement.start,
      end: finalStatement.end,
      text: ";" + completionMarker + "((" + code.slice(finalStatement.expression.start, finalStatement.expression.end) + "));",
    });
  }
  return applyReplacements(code, replacements);
}

function parseModuleSource(code, meriyah) {
  const options = {
    next: true,
    module: true,
    ranges: true,
    loc: false,
    disableWebCompat: true,
  };
  // Each repair rewrites one cooked line terminator and re-parses; bound the
  // attempts so pathological input cannot cause a quadratic parse storm.
  const maxRepairs = Math.min(code.length, 64);
  let source = code;
  for (let repairs = 0; repairs <= maxRepairs; repairs += 1) {
    try {
      return { source, ast: meriyah.parseModule(source, options) };
    } catch (error) {
      const start = Number(error?.start);
      if (error?.description !== "Unterminated string literal" || !Number.isInteger(start) || !["'", '"'].includes(source[start])) throw error;
      const remainder = source.slice(start + 1);
      const match = /[\\r\\n\\u2028\\u2029]/u.exec(remainder);
      if (!match) throw error;
      const lineStart = start + 1 + match.index;
      const lineEnd = source[lineStart] === "\\r" && source[lineStart + 1] === "\\n" ? lineStart + 2 : lineStart + 1;
      source = source.slice(0, lineStart) + "\\\\n" + source.slice(lineEnd);
    }
  }
  throw new Error("Could not recover cooked line terminators in JavaScript string literals");
}

async function buildModuleSource(code) {
  const meriyah = await meriyahPromise;
  const parsed = parseModuleSource(code, meriyah);
  code = parsed.source;
  const ast = parsed.ast;
  const currentBindings = collectBindings(ast);
  const priorBindings = previousModule ? previousBindings : [];
  const markCommittedName = nextInternalBindingName();
  const markPreludeName = nextInternalBindingName();
  const captureCompletionName = nextInternalBindingName();
  const instrumented = instrumentCurrentBindings(code, ast, markCommittedName, captureCompletionName);

  let prelude = [
    \`const \${markCommittedName} = import.meta.__opencodeMarkCommitted;\`,
    \`const \${markPreludeName} = import.meta.__opencodeMarkPrelude;\`,
    \`const \${captureCompletionName} = import.meta.__opencodeCaptureCompletion;\`,
    "delete import.meta.__opencodeMarkCommitted;",
    "delete import.meta.__opencodeMarkPrelude;",
    "delete import.meta.__opencodeCaptureCompletion;",
  ].join("\\n");
  prelude += "\\n";
  if (previousModule && priorBindings.length) {
    prelude += 'import * as __prev from "@prev";\\n';
    prelude += priorBindings
      .map((binding) => {
        const keyword = binding.kind === "var" ? "var" : binding.kind === "const" ? "const" : "let";
        return \`\${keyword} \${binding.name} = __prev.\${binding.name};\`;
      })
      .join("\\n");
    prelude += "\\n";
  }
  prelude += \`\${markPreludeName}();\\n\`;

  const merged = new Map(priorBindings.map((binding) => [binding.name, binding.kind]));
  for (const binding of currentBindings) merged.set(binding.name, binding.kind);
  const exportNames = Array.from(merged.keys());
  const exports = exportNames.length ? \`\\nexport { \${exportNames.join(", ")} };\` : "";
  return {
    source: \`\${prelude}\${instrumented}\${exports}\`,
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

const MODULE_CHAIN_COMPACT_INTERVAL = 50;
// Rebase the persistent binding chain every N cells: each cell links to the
// previous one through "@prev", so the module graph would otherwise grow
// without bound and retain every prior cell's objects for the kernel's
// lifetime. A snapshot module re-exports the current bindings, letting older
// cell modules (and everything they close over) become collectable.
async function compactPreviousModule() {
  if (!previousModule || !previousBindings.length) return;
  if (cellCounter % MODULE_CHAIN_COMPACT_INTERVAL !== 0) return;
  const bindings = previousBindings;
  const sourceModule = previousModule;
  const snapshot = new SourceTextModule(
    "export { " + bindings.map((binding) => binding.name).join(", ") + ' } from "@prev";',
    { context, identifier: path.join(cwd, \`.opencode_js_repl_snapshot_\${cellCounter}.mjs\`) },
  );
  await snapshot.link(async (specifier) => {
    if (specifier !== "@prev") throw new Error(\`Unexpected binding snapshot import: \${specifier}\`);
    return new SyntheticModule(
      bindings.map((binding) => binding.name),
      function initializeSnapshot() {
        for (const binding of bindings) this.setExport(binding.name, sourceModule.namespace[binding.name]);
      },
      { context },
    );
  });
  await snapshot.evaluate();
  previousModule = snapshot;
}

function reportNonFatal(kind, error) {
  try {
    fs.writeSync(process.stderr.fd, "js_repl kernel non-fatal " + kind + " error: " + formatError(error) + "\\n");
  } catch {}
}

function send(message) {
  fs.writeSync(PROTOCOL_FD, \`\${JSON.stringify(message)}\\n\`);
}

function formatError(error) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
}

function scheduleFatalExit(kind, error) {
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;
  const message = \`js_repl kernel \${kind}: \${formatError(error)}; kernel reset.\`;
  if (activeExecId) {
    try {
      fs.writeSync(PROTOCOL_FD, \`\${JSON.stringify({
        type: "exec_result",
        id: activeExecId,
        ok: false,
        output: "",
        error: message,
      })}\\n\`);
    } catch {}
  }
  try {
    fs.writeSync(process.stderr.fd, \`\${message}\\n\`);
  } catch {}
  setImmediate(() => process.exit(1));
}

function takeUnhandledRejections(owner) {
  const errors = [];
  for (const [promise, rejection] of unhandledRejections) {
    if (owner !== undefined && rejection.owner !== owner) continue;
    unhandledRejections.delete(promise);
    errors.push(rejection.error);
  }
  return errors;
}

function formatRejections(errors) {
  const messages = [...new Set(errors.map(formatError))];
  const shown = messages.slice(0, 5);
  if (messages.length > shown.length) shown.push("... and " + (messages.length - shown.length) + " more");
  return shown.join(" | ");
}

function formatLog(args) {
  return args
    .map((argument) =>
      typeof argument === "string" ? argument : inspect(argument, { depth: 4, colors: false }),
    )
    .join(" ");
}

async function withCapturedConsole(state, fn) {
  const logs = [];
  state.logs = logs;
  let truncated = false;
  const capture = (...args) => {
    if (truncated) return;
    const line = formatLog(args);
    const next = Buffer.byteLength(line) + (logs.length ? 1 : 0);
    // Console output and opencode.emitText share one execution-wide budget.
    if (state.outputBytes + next > MAX_OUTPUT_BYTES) {
      logs.push(\`[js_repl output truncated at \${MAX_OUTPUT_BYTES} bytes]\`);
      truncated = true;
      return;
    }
    logs.push(line);
    state.outputBytes += next;
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
  pruneStaleLocalFileModules();
  activeExecId = message.id;
  const execState = { attachments: [], attachmentBytes: 0, pendingImages: [], emittedText: [], outputBytes: 0, logs: null };
  activeExecState = execState;
  let module = null;
  let currentBindings = [];
  let priorBindings = previousBindings;
  let nextBindings = [];
  let linked = false;
  let preludeCompleted = false;
  let completionValue;
  let completionPromise = null;
  const committed = new Set();

  try {
    const priorUnhandled = takeUnhandledRejections();
    if (priorUnhandled.length) {
      throw new Error(
        "Uncaught rejected Promise from background work: " + formatRejections(priorUnhandled) +
        "; kernel preserved. This cell was not executed; call again to continue.",
      );
    }
    const built = await buildModuleSource(typeof message.code === "string" ? message.code : "");
    currentBindings = built.currentBindings;
    priorBindings = built.priorBindings;
    nextBindings = built.nextBindings;

    const output = await rejectionScope.run(message.id, () => withCapturedConsole(execState, async (logs) => {
      const identifier = path.join(cwd, \`.opencode_js_repl_cell_\${cellCounter++}.mjs\`);
      module = new SourceTextModule(built.source, {
        context,
        identifier,
        initializeImportMeta(meta, current) {
          setImportMeta(meta, current, true);
          meta.__opencodeMarkCommitted = (...names) => names.forEach((name) => committed.add(name));
          meta.__opencodeMarkPrelude = () => {
            preludeCompleted = true;
          };
          meta.__opencodeCaptureCompletion = (value) => {
            completionValue = value;
            // Promise assimilation handles cross-realm promises and reads a
            // custom thenable's then property exactly once.
            completionPromise = Promise.resolve(value).then((resolved) => {
              completionValue = resolved;
            });
          };
        },
        importModuleDynamically(specifier, referrer) {
          return importResolved(resolveSpecifier(specifier, referrer?.identifier));
        },
      });
      await module.link(async (specifier, referrer) => {
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
        const resolved = resolveSpecifier(specifier, referrer?.identifier);
        return resolved.kind === "file" ? loadLinkedFileModule(resolved.path) : loadLinkedNativeModule(resolved);
      });
      linked = true;
      await module.evaluate();
      if (completionPromise) await completionPromise;
      if (execState.pendingImages.length) {
        const imageResults = await Promise.all(execState.pendingImages);
        const unhandled = imageResults.find((result) => !result.ok && !result.observation.observed);
        if (unhandled) throw unhandled.error;
      }
      // Give Node one turn to classify detached rejections created by this
      // cell, then surface them without terminating the persistent kernel.
      await new Promise((resolve) => setImmediate(resolve));
      const unhandled = takeUnhandledRejections(message.id);
      if (unhandled.length) throw new Error("Uncaught rejected Promise: " + formatRejections(unhandled) + "; kernel preserved.");
      const completion = completionValue === undefined
        ? []
        : [inspect(completionValue, { depth: 4, colors: false })];
      if (completion.length) {
        const bytes = Buffer.byteLength(completion[0]) + (logs.length || execState.emittedText.length ? 1 : 0);
        if (execState.outputBytes + bytes > MAX_OUTPUT_BYTES) {
          completion[0] = \`[js_repl output truncated at \${MAX_OUTPUT_BYTES} bytes]\`;
        } else {
          execState.outputBytes += bytes;
        }
      }
      return [...logs, ...execState.emittedText, ...completion].join("\\n");
    }));

    previousModule = module;
    previousBindings = nextBindings;
    try { await compactPreviousModule(); } catch (snapshotError) { reportNonFatal("binding snapshot", snapshotError); }
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
      try { await compactPreviousModule(); } catch (snapshotError) { reportNonFatal("binding snapshot", snapshotError); }
    }
    // Preserve console/emitted text captured before the failure; those logs
    // are usually the most useful debugging evidence in an interactive session.
    const partialOutput = [...(execState.logs ?? []), ...execState.emittedText].join("\\n");
    send({ type: "exec_result", id: message.id, ok: false, output: partialOutput, error: formatError(error) });
  } finally {
    if (activeExecId === message.id) activeExecId = null;
    if (activeExecState === execState) activeExecState = null;
  }
}

let queue = Promise.resolve();
let pending = "";

process.on("uncaughtException", (error) => scheduleFatalExit("uncaught exception", error));
process.on("unhandledRejection", (error, promise) =>
  unhandledRejections.set(promise, { error, owner: promiseOwners.get(promise) ?? null })
);
process.on("rejectionHandled", (promise) => unhandledRejections.delete(promise));
process.stdin.setEncoding("utf8");
// The controller owns this pipe. Its closure means OpenCode has shut down.
process.stdin.once("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  pending += chunk;
  while (true) {
    const newline = pending.indexOf("\\n");
    if (newline < 0) break;
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (message.type === "exec") queue = queue.then(() => handleExec(message));
      else reportNonFatal("protocol", new Error("ignored message of unknown type " + JSON.stringify(message?.type ?? null)));
    } catch (error) {
      reportNonFatal("protocol", new Error("ignored a malformed protocol line: " + formatError(error)));
    }
  }
});
`

export type Attachment = { type: "file"; mime: string; url: string; filename?: string }
export type Result = { output: string; attachments: Attachment[] }
type Pending = { id: string; resolve(result: Result): void; reject(error: Error): void }
type KernelProcess = ChildProcessWithoutNullStreams & {
  stdio: [NodeJS.WritableStream, NodeJS.ReadableStream, NodeJS.ReadableStream, NodeJS.ReadableStream]
}
type Message = {
  type: "exec_result"
  id: string
  ok: boolean
  output?: string
  attachments?: unknown
  error?: string | null
}

const checkedNodes = new Map<string, Promise<void>>()

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function parseVersion(value: string) {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) throw new Error(`Unable to parse Node version: ${value.trim()}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])] as const
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true
    if (actual[index]! < minimum[index]!) return false
  }
  return true
}

async function checkNode(path: string) {
  let check = checkedNodes.get(path)
  if (!check) {
    check = (async () => {
      let stdout: string
      try {
        ;({ stdout } = await execFileAsync(path, ["--version"], { encoding: "utf8", timeout: 5_000 }))
      } catch (error) {
        throw new Error(`Failed to start Node runtime at "${path}": ${errorMessage(error)}`)
      }
      const actual = parseVersion(stdout)
      if (!versionAtLeast(actual, MIN_NODE_VERSION)) {
        throw new Error(`js_repl requires Node >=${MIN_NODE_VERSION.join(".")}; "${path}" is ${actual.join(".")}`)
      }
    })()
    checkedNodes.set(path, check)
  }
  return check
}

const LOCK_STALE_MS = 15 * 60_000
const LOCK_TIMEOUT_MS = 10 * 60_000
const LOCK_POLL_MS = 250
const LOCK_RENEW_MS = 30_000

// Cross-process mutex for the shared user cache. Multiple OpenCode services
// (or concurrent sessions) may run setup at the same time; npm installs,
// source patching and browser downloads must not interleave. The lock is a
// directory because mkdir is atomic on all supported platforms. A heartbeat
// file keeps the lock fresh during long installs; locks whose heartbeat is
// older than LOCK_STALE_MS are considered abandoned (e.g. after a crash) and
// reclaimed.
async function withCacheLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`
  const heartbeatPath = `${lockPath}/heartbeat`
  const start = Date.now()
  for (;;) {
    try {
      await mkdir(lockPath)
      await writeFile(heartbeatPath, `${process.pid} ${Date.now()}\n`, "utf8").catch(() => undefined)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for the js_repl setup lock ${lockPath}; another process may be installing. Remove it manually if the holder is gone.`)
      }
      let heartbeatAge = 0
      try {
        const info = await stat(heartbeatPath)
        heartbeatAge = Date.now() - info.mtimeMs
      } catch {
        // No heartbeat yet; fall back to the lock directory's own age.
        heartbeatAge = await stat(lockPath).then((info) => Date.now() - info.mtimeMs).catch(() => LOCK_STALE_MS + 1)
      }
      if (heartbeatAge > LOCK_STALE_MS) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
      else await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
    }
  }
  const heartbeat = setInterval(() => {
    void writeFile(heartbeatPath, `${process.pid} ${Date.now()}\n`, "utf8").catch(() => undefined)
  }, LOCK_RENEW_MS)
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
  }
}

function playwrightCacheDirectory() {
  return process.env.OPENCODE_PLAYWRIGHT_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode", "playwright")
}

function replCacheDirectory() {
  return process.env.OPENCODE_JS_REPL_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode")
}

function playwrightBrowserDirectory() {
  return process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(playwrightCacheDirectory(), "browsers")
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function packageMatches(file: string, name: string, version: string) {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { name?: string; version?: string }
    return value.name === name && value.version === version
  } catch {
    return false
  }
}

// The .chromium-<version> marker alone cannot prove the browser download
// survived (users clean caches, disks fill, installs crash). Resolve the
// expected executable from playwright-core's own browser registry and check
// that it is actually on disk.
async function chromiumExecutableExists(directory: string) {
  try {
    const registry = JSON.parse(await readFile(join(directory, "node_modules", "playwright-core", "browsers.json"), "utf8")) as {
      browsers?: Array<{ name?: string; revision?: string; browserRevision?: string }>
    }
    const chromium = registry.browsers?.find((browser) => browser?.name === "chromium")
    const revision = chromium?.browserRevision ?? chromium?.revision
    if (!revision) return false
    const relative =
      process.platform === "darwin"
        ? join(`chromium-${revision}`, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
        : process.platform === "win32"
          ? join(`chromium-${revision}`, "chrome-win", "chrome.exe")
          : join(`chromium-${revision}`, "chrome-linux", "chrome")
    return await exists(join(playwrightBrowserDirectory(), relative))
  } catch {
    return false
  }
}

// Guarded compatibility patch for rebrowser-playwright's upstream frame
// lifecycle: on child-frame navigation, rebrowser's Frame emits
// Runtime.executionContextsCleared on the whole CDP session, which makes
// crPage destroy the execution contexts of *every* frame, including the main
// frame's live handles. The patch scopes the clear to the affected frame
// instead. It applies exact single-occurrence string replacements against the
// installed playwright-core sources and fails loudly if the shape drifts (for
// example after a version bump), rather than silently half-patching.
async function ensureRebrowserFrameContextFix(directory: string) {
  const framesFile = join(directory, "node_modules", "playwright-core", "lib", "server", "frames.js")
  const chromiumPageFile = join(directory, "node_modules", "playwright-core", "lib", "server", "chromium", "crPage.js")
  const originalClear = `    const crSession = (this._page._delegate._sessions.get(this._id) || this._page._delegate._mainFrameSession)._client;\n    crSession.emit("Runtime.executionContextsCleared");`
  const fixedClear = `    const frameSession = this._page._delegate._sessions.get(this._id) || this._page._delegate._mainFrameSession;\n    frameSession._onFrameExecutionContextsCleared(this);`
  const methodAnchor = `  _onExecutionContextsCleared() {\n    for (const contextId of Array.from(this._contextIdToContext.keys()))\n      this._onExecutionContextDestroyed(contextId);\n  }`
  const fixedMethod = `${methodAnchor}\n  _onFrameExecutionContextsCleared(frame) {\n    for (const [contextId, context] of this._contextIdToContext) {\n      if (context.frame === frame)\n        this._onExecutionContextDestroyed(contextId);\n    }\n  }`
  const methodMarker = "  _onFrameExecutionContextsCleared(frame) {"
  const occurrences = (source: string, needle: string) => source.split(needle).length - 1
  let frames = await readFile(framesFile, "utf8")
  let chromiumPage = await readFile(chromiumPageFile, "utf8")
  const clearReady = frames.includes(fixedClear)
  const methodReady = chromiumPage.includes(methodMarker)
  if (!clearReady) {
    if (occurrences(frames, originalClear) !== 1) throw new Error(`Could not apply the rebrowser frame-context fix: ${framesFile} has an unexpected shape`)
    frames = frames.replace(originalClear, fixedClear)
    await writeFile(framesFile, frames)
  }
  if (!methodReady) {
    if (occurrences(chromiumPage, methodAnchor) !== 1) throw new Error(`Could not apply the rebrowser frame-context fix: ${chromiumPageFile} has an unexpected shape`)
    chromiumPage = chromiumPage.replace(methodAnchor, fixedMethod)
    await writeFile(chromiumPageFile, chromiumPage)
  }
  if (!frames.includes(fixedClear) || !chromiumPage.includes(methodMarker)) {
    throw new Error("The rebrowser frame-context fix could not be verified after installation")
  }
}

async function run(command: string, args: string[], environment: NodeJS.ProcessEnv) {
  try {
    await execFileAsync(command, args, { encoding: "utf8", timeout: 10 * 60_000, maxBuffer: 1024 * 1024, env: environment })
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string }
    const output = [details.stdout, details.stderr].filter(Boolean).join("\n").trim()
    throw new Error(`Playwright setup failed: ${errorMessage(error)}${output ? `\n${boundedUtf8(output, 8192)}` : ""}`)
  }
}

async function ensureMeriyah() {
  const directory = replCacheDirectory()
  const packageFile = join(directory, "node_modules", "meriyah", "package.json")
  if (await packageMatches(packageFile, "meriyah", MERIYAH_VERSION)) return
  await mkdir(directory, { recursive: true })
  await withCacheLock(join(directory, ".meriyah-install"), async () => {
    // Re-check under the lock: another process may have finished installing.
    if (await packageMatches(packageFile, "meriyah", MERIYAH_VERSION)) return
    await run(process.env.OPENCODE_JS_REPL_NPM_PATH ?? "npm", ["install", "--prefix", directory, `meriyah@${MERIYAH_VERSION}`], process.env)
  })
}

function boundedUtf8(value: string, maxBytes: number) {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= maxBytes) return value
  return bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "")
}

function decodedBase64Size(value: string) {
  const compact = value.replace(/\s/g, "")
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new Error("js_repl kernel sent invalid base64 image data")
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding)
}

function attachments(value: unknown): Attachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 4) throw new Error("js_repl kernel sent invalid image attachments")
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("js_repl kernel sent a malformed image attachment")
    const attachment = item as Record<string, unknown>
    if (attachment.type !== "file" || typeof attachment.mime !== "string" || !SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mime) || typeof attachment.url !== "string") {
      throw new Error("js_repl kernel sent a malformed image attachment")
    }
    const match = attachment.url.match(/^data:([^;,]+);base64,([\s\S]+)$/i)
    if (!match || match[1]?.toLowerCase() !== attachment.mime) throw new Error("js_repl kernel sent an invalid image data URL")
    const size = decodedBase64Size(match[2]!)
    if (!size || size > MAX_IMAGE_BYTES) throw new Error("js_repl kernel sent an image outside the allowed size range")
    if (attachment.filename !== undefined && (typeof attachment.filename !== "string" || !attachment.filename || attachment.filename.length > 255 || /[/\\\0]/.test(attachment.filename))) {
      throw new Error("js_repl kernel sent an invalid image filename")
    }
    return { type: "file", mime: attachment.mime, url: attachment.url, ...(typeof attachment.filename === "string" ? { filename: attachment.filename } : {}) }
  })
}

class ReplController {
  private readonly sessionID: string
  private readonly directory: string
  private child?: KernelProcess
  private reader?: ReadLineInterface
  private pending?: Pending
  private queue: Promise<void> = Promise.resolve()
  private stderrTail: string[] = []
  private stderrFragment = ""
  private scratch?: string
  private disposed = false
  private request = 0

  constructor(sessionID: string, directory: string) {
    this.sessionID = sessionID
    this.directory = directory
  }

  matchesDirectory(directory: string) {
    return this.directory === directory
  }

  execute(code: string, timeoutMs: number | undefined) {
    if (!code.trim()) return Promise.reject(new Error("code must contain JavaScript source"))
    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS
    return this.enqueue(() => this.executeNow(code, timeout))
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    const pending = this.pending
    this.pending = undefined
    pending?.reject(new Error("js_repl controller disposed"))
    await this.stop()
    await this.removeScratch()
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async executeNow(code: string, timeoutMs: number) {
    if (this.disposed) throw new Error("js_repl controller is disposed")
    const child = await this.ensure()
    const id = `${this.sessionID}-${++this.request}`
    return new Promise<Result>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, result?: Result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (this.pending?.id === id) this.pending = undefined
        if (error) reject(error)
        else resolve(result ?? { output: "", attachments: [] })
      }
      const abandon = (error: Error) => {
        if (settled) return
        if (this.pending?.id === id) this.pending = undefined
        finish(error)
      }
      const timer = setTimeout(() => abandon(new Error("js_repl execution timed out; kernel continues running and later calls will wait behind it")), timeoutMs)
      this.pending = { id, resolve: (result) => finish(undefined, result), reject: (error) => finish(error) }
      child.stdin.write(`${JSON.stringify({ type: "exec", id, code })}\n`, (error) => {
        if (error) this.fail(child, new Error(`Failed to write to js_repl kernel: ${error.message}`))
      })
    })
  }

  private async ensure() {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child
    const node = process.env.OPENCODE_JS_REPL_NODE_PATH ?? "node"
    await checkNode(node)
    await ensureMeriyah()
    this.scratch ??= await mkdtemp(join(tmpdir(), "opencode-js-repl-"))
    const source = KERNEL_SOURCE
    const kernelPath = join(this.scratch, "kernel.cjs")
    await writeFile(kernelPath, source)
    this.stderrTail = []
    this.stderrFragment = ""
    const moduleDirs = [
      ...(process.env.OPENCODE_JS_REPL_NODE_MODULE_DIRS?.split(delimiter).filter(Boolean) ?? []),
      join(replCacheDirectory(), "node_modules"),
      join(playwrightCacheDirectory(), "node_modules"),
    ]
    const child = spawn(node, ["--no-warnings", "--experimental-vm-modules", kernelPath], {
      cwd: this.directory,
      env: { ...process.env, NODE_PATH: [join(replCacheDirectory(), "node_modules"), process.env.NODE_PATH].filter(Boolean).join(delimiter), OPENCODE_JS_REPL_SESSION_ID: this.sessionID, OPENCODE_JS_REPL_TMP_DIR: this.scratch, OPENCODE_JS_REPL_MERIYAH_RESOLUTION_PATH: join(replCacheDirectory(), "__opencode_js_repl__.cjs"), PLAYWRIGHT_BROWSERS_PATH: playwrightBrowserDirectory(), REBROWSER_PATCHES_RUNTIME_FIX_MODE: process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE ?? "addBinding", OPENCODE_JS_REPL_NODE_MODULE_DIRS: moduleDirs.join(delimiter) },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    }) as KernelProcess
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { child.off("error", onError); resolve() }
      const onError = (error: Error) => { child.off("spawn", onSpawn); reject(new Error(`Failed to start js_repl kernel: ${error.message}`)) }
      child.once("spawn", onSpawn)
      child.once("error", onError)
    })
    this.child = child
    // Ownership marker: lets the next service instance identify (and sweep)
    // scratch dirs left behind by dead services without ever touching a dir
    // whose owning service is still alive.
    await writeFile(join(this.scratch, "owner.json"), JSON.stringify({ servicePid: process.pid, kernelPid: child.pid, createdAt: new Date().toISOString() })).catch(() => undefined)
    child.stdout.resume()
    this.reader = createInterface({ input: child.stdio[3], crlfDelay: Infinity })
    this.reader.on("line", (line) => this.handleLine(child, line))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => this.handleStderr(chunk))
    child.once("close", (code, signal) => this.handleClose(child, code, signal))
    child.once("error", (error) => this.fail(child, new Error(`js_repl kernel process error: ${error.message}`)))
    return child
  }

  private handleLine(child: KernelProcess, line: string) {
    if (child !== this.child) return
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) return void this.fail(child, new Error("js_repl kernel exceeded the protocol output limit"))
    let message: Message
    try { message = JSON.parse(line) as Message } catch { return void this.fail(child, new Error("js_repl kernel sent invalid JSON")) }
    if (message.type !== "exec_result" || !this.pending || message.id !== this.pending.id) return
    const pending = this.pending
    this.pending = undefined
    if (!message.ok) {
      // Logs captured before the failure are the most useful debugging
      // evidence; surface a bounded excerpt with the error.
      const partial = typeof message.output === "string" && message.output
        ? `\nOutput before failure:\n${boundedUtf8(message.output, 8_192)}`
        : ""
      const error = new Error(`${message.error || "js_repl execution failed"}${partial}`)
      if (message.error?.includes("kernel reset")) void this.stop().finally(() => pending.reject(error))
      else pending.reject(error)
      return
    }
    try { pending.resolve({ output: typeof message.output === "string" ? message.output : "", attachments: attachments(message.attachments) }) }
    catch (error) { void this.stop().finally(() => pending.reject(error as Error)) }
  }

  private handleStderr(chunk: string) {
    this.stderrFragment += chunk
    const lines = this.stderrFragment.split(/\r?\n/)
    this.stderrFragment = lines.pop() ?? ""
    for (const line of lines) this.pushStderr(line)
  }

  private pushStderr(line: string) {
    const bounded = boundedUtf8(line, 512)
    if (!bounded) return
    this.stderrTail.push(bounded)
    while (this.stderrTail.length > 20 || Buffer.byteLength(this.stderrTail.join(" | ")) > 4096) this.stderrTail.shift()
  }

  private handleClose(child: KernelProcess, code: number | null, signal: NodeJS.Signals | null) {
    if (child !== this.child) return
    if (this.stderrFragment) this.pushStderr(this.stderrFragment)
    this.detach(child)
    const status = code === null ? `signal=${signal ?? "unknown"}` : `code=${code}`
    const diagnostics = this.stderrTail.length ? `; stderr: ${this.stderrTail.join(" | ")}` : ""
    const pending = this.pending
    this.pending = undefined
    pending?.reject(new Error(`js_repl kernel exited unexpectedly (${status})${diagnostics}`))
  }

  private fail(child: KernelProcess, error: Error) {
    if (child !== this.child) return
    const pending = this.pending
    this.pending = undefined
    void this.stop().finally(() => pending?.reject(error))
  }

  private detach(child: KernelProcess) {
    if (child !== this.child) return
    this.reader?.close()
    this.reader = undefined
    this.child = undefined
  }

  private async stop() {
    const child = this.child
    if (!child) return
    this.detach(child)
    if (child.exitCode !== null || child.killed) return
    // Graceful first: closing stdin triggers the kernel's stdin "end" handler
    // so it can exit 0 and release browser/profile locks. SIGTERM is the next
    // step and SIGKILL only the last resort, so profile directories are not
    // left in a killed-process state.
    try { child.stdin.end() } catch { /* stdin already closed */ }
    if (await waitForChildClose(child, 1_500)) return
    try { child.kill("SIGTERM") } catch { /* already exited */ }
    if (await waitForChildClose(child, 1_500)) return
    try { child.kill("SIGKILL") } catch { /* already exited */ }
    await waitForChildClose(child, 2_000)
  }

  // Remove the scratch directory, but only once Chromium is done with it: a
  // shutting-down browser can recreate profile files after the rm and leave a
  // partial user-data dir behind. The SingletonLock file is the browser's own
  // shutdown signal; brief retries absorb any remaining late writes.
  private async removeScratch() {
    const scratch = this.scratch
    if (!scratch) return
    const lockPath = join(scratch, "stealth", "user-data", "SingletonLock")
    const deadline = Date.now() + 2_500
    while (Date.now() < deadline && (await exists(lockPath))) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    for (let attempt = 0; attempt < 3 && (await exists(scratch)); attempt += 1) {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250))
    }
    this.scratch = undefined
  }

  // Graceful per-session teardown used when the OpenCode service is stopping.
  // Closing stdin lets the kernel exit 0; Playwright's own process-exit hooks
  // (inside the kernel) then close browsers and Electron apps in an orderly
  // way and delete their temporary profile dirs. Surviving kernels are killed
  // and the scratch directory (which also holds this session's stealth
  // profile) is removed either way.
  async disposeForShutdown() {
    this.disposed = true
    const pending = this.pending
    this.pending = undefined
    pending?.reject(new Error("js_repl controller disposed"))
    const child = this.child
    if (child) {
      this.detach(child)
      if (child.exitCode === null && !child.killed) {
        try { child.stdin.end() } catch { /* stdin already closed */ }
        if (!(await waitForChildClose(child, 1_200))) {
          try { child.kill("SIGKILL") } catch { /* already exited */ }
          await waitForChildClose(child, 1_000)
        }
      }
    }
    await this.removeScratch()
  }

}

function waitForChildClose(child: KernelProcess, ms: number) {
  return new Promise<boolean>((resolve) => {
    if (child.exitCode !== null) return resolve(true)
    const timer = setTimeout(() => {
      child.off("close", onClose)
      resolve(child.exitCode !== null)
    }, ms)
    const onClose = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once("close", onClose)
  })
}

const SCRATCH_PREFIX = "opencode-js-repl-"
const OWNERLESS_SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000
let staleSweepStarted = false

// Sweep scratch dirs whose owning OpenCode service is dead. Owner-marked dirs
// are removed only once their service pid is gone; unmarked dirs (older
// versions or crash residue) are removed only once obviously stale. Dirs
// owned by a live service — including other instances of this plugin — are
// never touched. Runs once per service process, at plugin load, so shutdown
// races that leave residue behind are cleaned on the next startup.
async function sweepStaleScratchDirs() {
  if (staleSweepStarted) return
  staleSweepStarted = true
  let entries: string[]
  try {
    entries = await readdir(tmpdir())
  } catch {
    return
  }
  const removed: string[] = []
  const removeKnownResidue = async (directory: string) => {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    removed.push(directory)
  }
  for (const entry of entries) {
    if (!entry.startsWith(SCRATCH_PREFIX)) continue
    const directory = join(tmpdir(), entry)
    try {
      if (!(await stat(directory)).isDirectory()) continue
    } catch {
      continue
    }
    let servicePid: number | undefined
    try {
      const owner = JSON.parse(await readFile(join(directory, "owner.json"), "utf8")) as { servicePid?: number }
      if (typeof owner.servicePid === "number") servicePid = owner.servicePid
    } catch { /* no owner file */ }
    if (servicePid !== undefined) {
      try {
        process.kill(servicePid, 0)
        continue // owning service process is alive; possibly another instance
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "EPERM") continue
      }
      await removeKnownResidue(directory)
      continue
    }
    try {
      const info = await stat(directory)
      if (Date.now() - info.mtimeMs > OWNERLESS_SCRATCH_MAX_AGE_MS) {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch { /* already gone */ }
  }
  if (!removed.length) return
  // Second pass: a browser still shutting down can recreate parts of its
  // user-data after the first sweep. These paths were known-dead residue, so
  // a reappearing directory is safe to remove once more.
  setTimeout(() => {
    for (const directory of removed) {
      void rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 3_000).unref()
}
export class ReplRuntime {
  private readonly controllers = new Map<string, ReplController>()
  private disposed = false

  constructor() {
    void sweepStaleScratchDirs().catch(() => undefined)
  }

  async execute(sessionID: string, directory: string, code: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.disposed) throw new Error("js_repl runtime is disposed")
    let controller = this.controllers.get(sessionID)
    if (controller && !controller.matchesDirectory(directory)) {
      this.controllers.delete(sessionID)
      await controller.dispose()
      controller = undefined
    }
    if (!controller) {
      controller = new ReplController(sessionID, directory)
      this.controllers.set(sessionID, controller)
    }
    return controller.execute(code, timeoutMs)
  }

  async reset(sessionID: string) {
    const controller = this.controllers.get(sessionID)
    if (!controller) return false
    this.controllers.delete(sessionID)
    await controller.dispose()
    return true
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    const controllers = Array.from(this.controllers.values())
    this.controllers.clear()
    await Promise.allSettled(controllers.map((controller) => controller.disposeForShutdown()))
  }

  async setupPlaywright(force = false) {
    const directory = playwrightCacheDirectory()
    const marker = join(directory, `.chromium-${PLAYWRIGHT_VERSION}`)
    const playwrightPackage = join(directory, "node_modules", "playwright", "package.json")
    const playwrightCorePackage = join(directory, "node_modules", "playwright-core", "package.json")
    const environment = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowserDirectory(), REBROWSER_PATCHES_RUNTIME_FIX_MODE: process.env.REBROWSER_PATCHES_RUNTIME_FIX_MODE ?? "addBinding" }
    await mkdir(directory, { recursive: true })
    // Everything that mutates the shared cache (package install, source
    // patching, browser download, marker) runs under one inter-process lock.
    await withCacheLock(join(directory, ".playwright-setup"), async () => {
      const packageReady = await packageMatches(playwrightPackage, PLAYWRIGHT_PACKAGE, PLAYWRIGHT_VERSION)
        && await packageMatches(playwrightCorePackage, "rebrowser-playwright-core", PLAYWRIGHT_VERSION)
      if (force || !packageReady) {
        await run(process.env.OPENCODE_PLAYWRIGHT_NPM_PATH ?? "npm", ["install", "--prefix", directory, `playwright@npm:${PLAYWRIGHT_PACKAGE}@${PLAYWRIGHT_VERSION}`], environment)
        await rm(marker, { force: true })
      }
      if (!(await packageMatches(playwrightPackage, PLAYWRIGHT_PACKAGE, PLAYWRIGHT_VERSION)) || !(await packageMatches(playwrightCorePackage, "rebrowser-playwright-core", PLAYWRIGHT_VERSION))) {
        throw new Error(`Playwright setup did not install ${PLAYWRIGHT_PACKAGE} ${PLAYWRIGHT_VERSION} and its matching core package`)
      }
      await ensureRebrowserFrameContextFix(directory)
      const markerReady = !force && (await exists(marker)) && (await chromiumExecutableExists(directory))
      if (!markerReady) {
        await run(process.env.OPENCODE_PLAYWRIGHT_NPX_PATH ?? "npx", ["--prefix", directory, "playwright", "install", "chromium"], environment)
        if (!(await chromiumExecutableExists(directory))) {
          throw new Error(`Chromium executable is missing from ${playwrightBrowserDirectory()} after installation`)
        }
        await writeFile(marker, "")
      }
    })
    return `Shared ${PLAYWRIGHT_PACKAGE} ${PLAYWRIGHT_VERSION}, its frame-context navigation fix and Chromium are ready at ${directory}.`
  }
}

export const limits = {
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: MAX_TIMEOUT_MS,
} as const
