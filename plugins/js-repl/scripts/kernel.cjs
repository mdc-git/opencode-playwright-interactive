#!/usr/bin/env node
// Adapted from OpenAI Codex's js_repl kernel at revision 219c65d.

const { Buffer } = require('node:buffer')
const { AsyncLocalStorage, createHook } = require('node:async_hooks')
const crypto = require('node:crypto')
const fs = require('node:fs')
const { builtinModules, createRequire } = require('node:module')
const { performance } = require('node:perf_hooks')
const path = require('node:path')
const process = require('node:process')
const { fileURLToPath, pathToFileURL } = require('node:url')
const { inspect } = require('node:util')
const vm = require('node:vm')

const { SourceTextModule, SyntheticModule } = vm
const PROTOCOL_FD = 3
const meriyahRequire = createRequire(process.env.JS_REPL_INTERNAL_MERIYAH_PATH ?? __filename)
const meriyahPromise = Promise.resolve(meriyahRequire('meriyah')).then(
  (module) => module.default ?? module
)
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES_PER_EXEC = 4
const MAX_TOTAL_IMAGE_BYTES = MAX_IMAGE_BYTES * MAX_IMAGES_PER_EXEC
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const context = vm.createContext({})
context.globalThis = context
context.global = context
context.Buffer = Buffer
context.console = console
context.URL = URL
context.URLSearchParams = URLSearchParams
context.TextEncoder = TextEncoder
context.TextDecoder = TextDecoder
context.AbortController = AbortController
context.AbortSignal = AbortSignal
context.structuredClone = structuredClone
context.fetch = fetch
context.Headers = Headers
context.Request = Request
context.Response = Response
context.performance = performance
context.crypto = crypto.webcrypto ?? crypto
context.setTimeout = setTimeout
context.clearTimeout = clearTimeout
context.setInterval = setInterval
context.clearInterval = clearInterval
context.queueMicrotask = queueMicrotask
context.setImmediate = setImmediate
context.clearImmediate = clearImmediate
context.atob = (data) => Buffer.from(data, 'base64').toString('binary')
context.btoa = (data) => Buffer.from(data, 'binary').toString('base64')

let previousModule = null
let previousBindings = []
let cellCounter = 0
let internalBindingCounter = 0
let activeExecId = null
let activeExecState = null
let isFatalExitScheduled = false
const unhandledRejections = new Map()
const rejectionScope = new AsyncLocalStorage()
const promiseOwners = new WeakMap()
createHook({
  init(_asyncId, type, _triggerAsyncId, resource) {
    if (type !== 'PROMISE') {
      return
    }

    const owner = rejectionScope.getStore()
    if (owner) {
      promiseOwners.set(resource, owner)
    }
  }
}).enable()

const internalBindingSalt = (() => {
  const raw = process.env.JS_REPL_INTERNAL_SESSION_ID ?? ''
  return raw.replaceAll(/[^\w$]/gv, '_') || 'session'
})()

const cwd = process.cwd()
const temporaryDir = process.env.JS_REPL_INTERNAL_TMP_DIR || cwd
const homeDir = process.env.HOME ?? null
const sessionId = process.env.JS_REPL_INTERNAL_SESSION_ID || null
const scriptDir = process.env.JS_REPL_INTERNAL_SCRIPT_DIR || null
let browserBindingCounter = 0
const workspaceRequire = createRequire(path.join(cwd, '__opencode_js_repl__.cjs'))

// This is a trusted local-code runtime, not a VM security boundary.
context.process = process
context.require = workspaceRequire
context.__filename = path.join(cwd, '__opencode_js_repl__.cjs')
context.__dirname = cwd
context.module = { exports: {} }
context.exports = context.module.exports

function normalizeImageMimeType(value) {
  const mime = typeof value === 'string' ? value.toLowerCase() : ''
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mime)) {
    throw new Error('opencode.emitImage supports PNG, JPEG, WebP, and GIF images only')
  }

  return mime
}

function imageExtension(mime) {
  if (mime === 'image/jpeg') {
    return 'jpg'
  }

  return mime.slice('image/'.length)
}

function normalizeImageFilename(value, mime) {
  if (value === null || value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('opencode.emitImage filename must be a non-empty string')
  }

  const base = path
    .basename(value.trim())
    .replaceAll(/[^\w\-.]/gv, '_')
    .slice(0, 255)
  return base || `js-repl-image.${imageExtension(mime)}`
}

function byteView(value) {
  if (Buffer.isBuffer(value)) {
    return value
  }

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }

  if (
    value instanceof ArrayBuffer ||
    Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  ) {
    return Buffer.from(value)
  }

  return null
}

function decodedBase64Size(value) {
  const compact = value.replaceAll(/\s/gv, '')
  if (!compact || !/^[+\/0-9a-z]*={0,2}$/iv.test(compact)) {
    throw new Error('opencode.emitImage expected valid base64 image data')
  }

  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding)
}

function normalizeImage(value) {
  if (typeof value === 'string') {
    const match = value.match(/^data:(?<mime>[^,;]+);base64,(?<data>[\s\S]+)$/iv)
    if (!match) {
      throw new Error('opencode.emitImage expected a base64 image data URL')
    }

    const mime = normalizeImageMimeType(match.groups.mime)
    const bytes = decodedBase64Size(match.groups.data)
    if (bytes === 0) {
      throw new Error('opencode.emitImage expected non-empty image data')
    }

    if (bytes > MAX_IMAGE_BYTES) {
      throw new Error(`opencode.emitImage image exceeds the ${MAX_IMAGE_BYTES}-byte limit`)
    }

    return { type: 'file', mime, url: value, bytes }
  }

  if (!value || typeof value !== 'object' || !('bytes' in value)) {
    throw new Error('opencode.emitImage expected a data URL or { bytes, mimeType, filename? }')
  }

  const bytes = byteView(value.bytes)
  if (!bytes) {
    throw new Error(
      'opencode.emitImage bytes must be a Buffer, Uint8Array, ArrayBuffer, or array-buffer view'
    )
  }

  if (bytes.byteLength === 0) {
    throw new Error('opencode.emitImage expected non-empty image bytes')
  }

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`opencode.emitImage image exceeds the ${MAX_IMAGE_BYTES}-byte limit`)
  }

  const mime = normalizeImageMimeType(value.mimeType)
  return {
    type: 'file',
    mime,
    url: `data:${mime};base64,${bytes.toString('base64')}`,
    filename: normalizeImageFilename(value.filename, mime),
    bytes: bytes.byteLength
  }
}

function emitImage(imageLike) {
  const state = activeExecState
  if (!state) {
    return Promise.reject(new Error('opencode.emitImage requires an active js_repl execution'))
  }

  const observation = { observed: false }
  const operation = (async () => {
    const image = normalizeImage(await imageLike)
    if (state.attachments.length >= MAX_IMAGES_PER_EXEC) {
      throw new Error(
        `opencode.emitImage supports at most ${MAX_IMAGES_PER_EXEC} images per execution`
      )
    }

    if (state.attachmentBytes + image.bytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new Error(
        `opencode.emitImage images exceed the ${MAX_TOTAL_IMAGE_BYTES}-byte execution limit`
      )
    }

    state.attachmentBytes += image.bytes
    const { bytes: _bytes, ...attachment } = image
    state.attachments.push(attachment)
  })()
  state.pendingImages.push(
    operation
      .then(() => ({ ok: true, observation }))
      .catch((error) => ({ ok: false, error, observation }))
  )
  return new Proxy(operation, {
    get(target, property, receiver) {
      if (['then', 'catch', 'finally'].includes(property)) {
        observation.observed = true
      }

      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

function emitText(textLike) {
  const state = activeExecState
  if (!state) {
    return Promise.reject(new Error('opencode.emitText requires an active js_repl execution'))
  }

  const text = typeof textLike === 'string' ? textLike : textLike?.text
  if (typeof text !== 'string') {
    return Promise.reject(new Error('opencode.emitText expected a string or { text }'))
  }

  const bytes = Buffer.byteLength(text)
  if (bytes > MAX_OUTPUT_BYTES) {
    return Promise.reject(
      new Error(`opencode.emitText text exceeds the ${MAX_OUTPUT_BYTES}-byte limit`)
    )
  }

  // Aggregate budget: console output and emitted text share one execution-wide
  // cap so many small calls cannot grow memory past the protocol line limit.
  if (state.outputBytes + bytes > MAX_OUTPUT_BYTES) {
    return Promise.reject(
      new Error(
        `opencode.emitText output exceeds the execution-wide ${MAX_OUTPUT_BYTES}-byte budget shared with console output`
      )
    )
  }

  state.outputBytes += bytes
  state.emittedText.push(text)
  return Promise.resolve()
}

function bindBrowser({ browser, context: browserContext, browserId, profileKind = 'local' } = {}) {
  if (!sessionId) {
    throw new Error('Could not identify the OpenCode session for browser binding')
  }

  if (
    !browserContext ||
    typeof browserContext.browser !== 'function' ||
    typeof browserContext.on !== 'function'
  ) {
    throw new TypeError('opencode.bindBrowser requires a Playwright BrowserContext')
  }

  const contextBrowser = browserContext.browser()
  const boundBrowser = browser || contextBrowser
  if (boundBrowser && typeof boundBrowser.isConnected !== 'function') {
    throw new TypeError('opencode.bindBrowser received an invalid Playwright Browser')
  }

  if (browser && contextBrowser && contextBrowser !== browser) {
    throw new Error('The BrowserContext does not belong to the supplied Browser')
  }

  let isContextClosed = false
  browserContext.on('close', () => {
    isContextClosed = true
  })
  const resolvedBrowserId =
    typeof browserId === 'string' && browserId
      ? browserId
      : sessionId + ':' + profileKind + ':' + ++browserBindingCounter
  const binding = Object.freeze({ sessionId, browserId: resolvedBrowserId, profileKind })
  const connected = () => !isContextClosed && (!boundBrowser || boundBrowser.isConnected())
  const assertPage = (currentPage) => {
    if (!connected()) {
      throw new Error(
        'Browser ' +
          binding.browserId +
          ' bound to OpenCode session ' +
          binding.sessionId +
          ' is closed. Stop interacting and do not adopt another browser.'
      )
    }

    if (
      !currentPage ||
      typeof currentPage.isClosed !== 'function' ||
      currentPage.isClosed() ||
      currentPage.context() !== browserContext
    ) {
      throw new Error(
        'The target Page does not belong to browser ' +
          binding.browserId +
          ' bound to OpenCode session ' +
          binding.sessionId +
          '.'
      )
    }

    return currentPage
  }

  const assertLocator = (currentPage, locator) => {
    assertPage(currentPage)
    if (locator && typeof locator.page === 'function' && locator.page() !== currentPage) {
      throw new Error('The target locator belongs to a different Page or browser binding')
    }

    return locator
  }

  return Object.freeze({
    binding,
    assertPage,
    assertLocator,
    state: () => Object.freeze({ connected: connected(), binding })
  })
}

context.opencode = Object.freeze({
  cwd,
  homeDir,
  tmpDir: temporaryDir,
  sessionId,
  scriptDir,
  bindBrowser,
  emitImage,
  emitText
})
context.tmpDir = temporaryDir

const builtinModuleSet = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
])
const moduleSearchBases = (() => {
  const bases = []
  const seen = new Set()
  const configured = process.env.JS_REPL_INTERNAL_NODE_MODULE_DIRS ?? ''
  for (const entry of configured.split(path.delimiter)) {
    const trimmed = entry.trim()
    if (!trimmed) {
      continue
    }

    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed)
    const base = path.basename(resolved) === 'node_modules' ? path.dirname(resolved) : resolved
    if (!seen.has(base)) {
      seen.add(base)
      bases.push(base)
    }
  }

  if (!seen.has(cwd)) {
    bases.push(cwd)
  }

  return bases
})()

const requireByBase = new Map()
const linkedFileModules = new Map()
const linkedNativeModules = new Map()
const linkedModuleEvaluations = new Map()

const localModuleStamps = new Map()
function isLocalModuleFresh(modulePath) {
  const stamp = localModuleStamps.get(modulePath)
  if (!stamp) {
    return false
  }

  try {
    const info = fs.statSync(modulePath)
    return info.mtimeMs === stamp.mtimeMs && info.size === stamp.size
  } catch {
    return false
  }
}

// Local file modules stay cached across cells so bindings, singletons and side
// effects persist for the session. A cell only invalidates a cached module
// whose file changed on disk (mtime or size), matching the iterate-and-reload
// workflow without re-running module side effects on every cell.
function pruneStaleLocalFileModules() {
  for (const modulePath of linkedFileModules.keys()) {
    if (isLocalModuleFresh(modulePath)) {
      continue
    }

    linkedFileModules.delete(modulePath)
    linkedModuleEvaluations.delete(modulePath)
    localModuleStamps.delete(modulePath)
  }
}

function canonicalizePath(value) {
  try {
    return fs.realpathSync.native(value)
  } catch {
    return value
  }
}

function getRequireForBase(base) {
  let request = requireByBase.get(base)
  if (!request) {
    request = createRequire(path.join(base, '__opencode_js_repl__.cjs'))
    requireByBase.set(base, request)
  }

  return request
}

function isWithinBaseNodeModules(base, resolvedPath) {
  const root = path.resolve(canonicalizePath(base), 'node_modules')
  const relative = path.relative(root, canonicalizePath(resolvedPath))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isFileUrlSpecifier(specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('file:')) {
    return false
  }

  try {
    return new URL(specifier).protocol === 'file:'
  } catch {
    return false
  }
}

function isPathSpecifier(specifier) {
  if (typeof specifier !== 'string' || !specifier || specifier.trim() !== specifier) {
    return false
  }

  return (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('.\\') ||
    specifier.startsWith('..\\') ||
    path.isAbsolute(specifier) ||
    isFileUrlSpecifier(specifier)
  )
}

function isBarePackageSpecifier(specifier) {
  return (
    typeof specifier === 'string' &&
    Boolean(specifier) &&
    specifier.trim() === specifier &&
    !specifier.startsWith('.') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('\\') &&
    !path.isAbsolute(specifier) &&
    !/^[a-z][\d+\-.a-z]*:/iv.test(specifier) &&
    !specifier.includes('\\')
  )
}

function resolvePathSpecifier(specifier, referrerIdentifier = null) {
  let candidate
  try {
    candidate = isFileUrlSpecifier(specifier)
      ? fileURLToPath(new URL(specifier))
      : path.isAbsolute(specifier)
        ? specifier
        : path.resolve(referrerIdentifier ? path.dirname(referrerIdentifier) : cwd, specifier)
  } catch (error) {
    throw new Error(`Failed to resolve module "${specifier}": ${error.message}`, { cause: error })
  }

  let resolvedPath
  try {
    resolvedPath = fs.realpathSync.native(candidate)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Module not found: ${specifier}`, { cause: error })
    }

    throw error
  }

  if (!fs.statSync(resolvedPath).isFile()) {
    throw new Error(`Directory imports are not supported: ${specifier}`)
  }

  const extension = path.extname(resolvedPath).toLowerCase()
  if (extension !== '.js' && extension !== '.mjs') {
    throw new Error(`Only local .js and .mjs modules are supported: ${specifier}`)
  }

  return { kind: 'file', path: resolvedPath }
}

function resolveBareSpecifier(specifier) {
  let firstError = null
  for (const base of moduleSearchBases) {
    try {
      const resolved = getRequireForBase(base).resolve(specifier, {
        conditions: new Set(['node', 'import'])
      })
      if (isWithinBaseNodeModules(base, resolved)) {
        return resolved
      }
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND' && error?.code !== 'ERR_MODULE_NOT_FOUND') {
        firstError ??= error
      }
    }
  }

  if (firstError) {
    throw firstError
  }

  return null
}

function resolveSpecifier(specifier, referrerIdentifier = null) {
  if (specifier.startsWith('node:') || builtinModuleSet.has(specifier)) {
    const normalized = specifier.startsWith('node:') ? specifier.slice(5) : specifier
    return { kind: 'builtin', specifier: `node:${normalized}` }
  }

  if (isPathSpecifier(specifier)) {
    return resolvePathSpecifier(specifier, referrerIdentifier)
  }

  if (!isBarePackageSpecifier(specifier)) {
    throw new Error(`Unsupported import specifier "${specifier}"`)
  }

  const resolved = resolveBareSpecifier(specifier)
  if (!resolved) {
    throw new Error(`Module not found: ${specifier}`)
  }

  return { kind: 'package', path: resolved, specifier }
}

function resolvedToUrl(resolved) {
  if (resolved.kind === 'builtin') {
    return resolved.specifier
  }

  if (resolved.kind === 'file') {
    return pathToFileURL(resolved.path).href
  }

  // The ESM contract expects a URL string; return the resolved entry point,
  // not the original bare package name.
  if (resolved.kind === 'package') {
    return pathToFileURL(resolved.path).href
  }

  throw new Error(`Unsupported module resolution kind: ${resolved.kind}`)
}

function setImportMeta(meta, module, isMain = false) {
  meta.url = pathToFileURL(module.identifier).href
  meta.filename = module.identifier
  meta.dirname = path.dirname(module.identifier)
  meta.main = isMain
  meta.resolve = (specifier) => resolvedToUrl(resolveSpecifier(specifier, module.identifier))
}

async function loadLinkedNativeModule(resolved) {
  const key = resolved.kind === 'builtin' ? resolved.specifier : resolved.path
  let promise = linkedNativeModules.get(key)
  if (!promise) {
    promise = (async () => {
      const namespace = await import(
        resolved.kind === 'builtin' ? resolved.specifier : pathToFileURL(resolved.path).href
      )
      const names = Object.getOwnPropertyNames(namespace)
      return new SyntheticModule(
        names,
        function () {
          for (const name of names) {
            this.setExport(name, namespace[name])
          }
        },
        { context }
      )
    })()
    linkedNativeModules.set(key, promise)
  }

  return promise
}

async function loadLinkedFileModule(modulePath) {
  let module = linkedFileModules.get(modulePath)
  if (!module) {
    const info = fs.statSync(modulePath)
    module = new SourceTextModule(fs.readFileSync(modulePath, 'utf8'), {
      context,
      identifier: modulePath,
      initializeImportMeta(meta, current) {
        setImportMeta(meta, current, false)
      },
      importModuleDynamically(specifier, referrer) {
        return importResolved(resolveSpecifier(specifier, referrer?.identifier))
      }
    })
    localModuleStamps.set(modulePath, { mtimeMs: info.mtimeMs, size: info.size })
    linkedFileModules.set(modulePath, module)
  }

  if (module.status === 'unlinked') {
    await module.link(async (specifier, referrer) => {
      const resolved = resolveSpecifier(specifier, referrer?.identifier)
      return resolved.kind === 'file'
        ? loadLinkedFileModule(resolved.path)
        : loadLinkedNativeModule(resolved)
    })
  }

  return module
}

async function importResolved(resolved) {
  if (resolved.kind !== 'file') {
    return import(
      resolved.kind === 'builtin' ? resolved.specifier : pathToFileURL(resolved.path).href
    )
  }

  const module = await loadLinkedFileModule(resolved.path)
  let evaluation = linkedModuleEvaluations.get(resolved.path)
  if (!evaluation) {
    evaluation = module.evaluate()
    linkedModuleEvaluations.set(resolved.path, evaluation)
  }

  await evaluation
  return module.namespace
}

function collectPatternNames(pattern, kind, map) {
  if (!pattern) {
    return
  }

  if (pattern.type === 'Identifier') {
    if (!map.has(pattern.name)) {
      map.set(pattern.name, kind)
    }

    return
  }

  if (pattern.type === 'ObjectPattern') {
    for (const property of pattern.properties ?? []) {
      collectPatternNames(
        property.type === 'Property' ? property.value : property.argument,
        kind,
        map
      )
    }

    return
  }

  if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements ?? []) {
      if (element) {
        collectPatternNames(element.type === 'RestElement' ? element.argument : element, kind, map)
      }
    }

    return
  }

  if (pattern.type === 'AssignmentPattern') {
    collectPatternNames(pattern.left, kind, map)
  } else if (pattern.type === 'RestElement') {
    collectPatternNames(pattern.argument, kind, map)
  }
}

function collectBindings(ast) {
  const bindings = new Map()
  for (const statement of ast.body ?? []) {
    collectStatementBindings(statement, bindings)
  }

  return Array.from(bindings, ([name, kind]) => ({ name, kind }))
}

function collectStatementBindings(statement, bindings) {
  if (statement.type === 'VariableDeclaration') {
    collectDeclarationNames(statement.declarations, statement.kind, bindings)
  } else if (statement.type === 'FunctionDeclaration' && statement.id) {
    bindings.set(statement.id.name, 'function')
  } else if (statement.type === 'ClassDeclaration' && statement.id) {
    bindings.set(statement.id.name, 'class')
  } else if (statement.type === 'ImportDeclaration') {
    for (const specifier of statement.specifiers ?? []) {
      if (specifier.local?.name) {
        bindings.set(specifier.local.name, 'const')
      }
    }
  } else if (
    statement.type === 'ForStatement' &&
    statement.init?.type === 'VariableDeclaration' &&
    statement.init.kind === 'var'
  ) {
    collectDeclarationNames(statement.init.declarations, 'var', bindings)
  } else if (
    (statement.type === 'ForInStatement' || statement.type === 'ForOfStatement') &&
    statement.left?.type === 'VariableDeclaration' &&
    statement.left.kind === 'var'
  ) {
    collectDeclarationNames(statement.left.declarations, 'var', bindings)
  }
}

function collectDeclarationNames(declarations, kind, bindings) {
  for (const declaration of declarations) {
    collectPatternNames(declaration.id, kind, bindings)
  }
}

function collectPatternBindingNames(pattern) {
  const names = new Map()
  collectPatternNames(pattern, 'binding', names)
  return names.keys().toArray()
}

function nextInternalBindingName() {
  return `__opencode_internal_commit_${internalBindingSalt}_${internalBindingCounter++}`
}

class ExecutionCancelledError extends Error {
  constructor() {
    super('JavaScript execution cancelled')
    this.name = 'ExecutionCancelledError'
  }
}

function throwIfExecutionCancelled() {
  if (activeExecState?.cancelRequested) {
    throw new ExecutionCancelledError()
  }
}

function markExpression(names, marker) {
  return `(${marker}(${names.map((name) => JSON.stringify(name)).join(', ')}), undefined)`
}

function instrumentVariableDeclaration(code, declaration, marker) {
  if (!declaration.declarations?.length) {
    return code.slice(declaration.start, declaration.end)
  }

  const first = declaration.declarations[0]
  const last = declaration.declarations.at(-1)
  const parts = []
  for (const item of declaration.declarations) {
    parts.push(code.slice(item.start, item.end))
    const names = collectPatternBindingNames(item.id)
    if (names.length > 0) {
      parts.push(`${nextInternalBindingName()} = ${markExpression(names, marker)}`)
    }
  }

  return `${code.slice(declaration.start, first.start)}${parts.join(', ')}${code.slice(last.end, declaration.end)}`
}

function applyReplacements(code, replacements) {
  let output = code
  for (const replacement of replacements.toSorted((a, b) => b.start - a.start)) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end)
  }

  return output
}

function instrumentCurrentBindings(code, ast, marker, completionMarker) {
  const replacements = []
  for (const statement of ast.body ?? []) {
    if (statement.type === 'VariableDeclaration') {
      replacements.push({
        start: statement.start,
        end: statement.end,
        text: instrumentVariableDeclaration(code, statement, marker)
      })
    } else if (
      (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') &&
      statement.id
    ) {
      replacements.push({
        start: statement.start,
        end: statement.end,
        text: `${code.slice(statement.start, statement.end)}\n;${marker}(${JSON.stringify(statement.id.name)});`
      })
    } else if (
      statement.type === 'ForStatement' &&
      statement.init?.type === 'VariableDeclaration' &&
      statement.init.kind === 'var'
    ) {
      replacements.push({
        start: statement.init.start,
        end: statement.init.end,
        text: instrumentVariableDeclaration(code, statement.init, marker)
      })
    }
  }

  const finalStatement = ast.body?.at(-1)
  if (finalStatement?.type === 'ExpressionStatement') {
    replacements.push({
      start: finalStatement.start,
      end: finalStatement.end,
      text:
        ';' +
        completionMarker +
        '((' +
        code.slice(finalStatement.expression.start, finalStatement.expression.end) +
        '));'
    })
  }

  return applyReplacements(code, replacements)
}

function instrumentCancellation(code, ast, checkpoint) {
  const loops = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') {
      return
    }

    if (
      [
        'ForStatement',
        'ForInStatement',
        'ForOfStatement',
        'WhileStatement',
        'DoWhileStatement'
      ].includes(value.type)
    ) {
      loops.push(value)
    }

    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        for (const item of child) {
          visit(item)
        }
      } else {
        visit(child)
      }
    }
  }

  visit(ast)
  const replacements = []
  for (const loop of loops) {
    const { body } = loop
    if (!body) {
      continue
    }

    if (body.type === 'BlockStatement') {
      replacements.push({
        start: body.start + 1,
        end: body.start + 1,
        text: `;${checkpoint}();`,
        kind: 'open'
      })
    } else {
      replacements.push(
        {
          start: body.start,
          end: body.start,
          text: `{;${checkpoint}();`,
          kind: 'open'
        },
        {
          start: body.end,
          end: body.end,
          text: '}',
          kind: 'close'
        }
      )
    }
  }

  let output = code
  for (const replacement of replacements.toSorted((a, b) => {
    const startOrder = b.start - a.start
    return startOrder || (a.kind === 'close' ? -1 : 1)
  })) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end)
  }

  return output
}

function parseModuleSource(code, meriyah) {
  const options = {
    next: true,
    module: true,
    ranges: true,
    loc: false,
    disableWebCompat: true
  }
  // Each repair rewrites one cooked line terminator and re-parses; bound the
  // attempts so pathological input cannot cause a quadratic parse storm.
  const maxRepairs = Math.min(code.length, 64)
  let source = code
  for (let repairs = 0; repairs <= maxRepairs; repairs += 1) {
    try {
      return { source, ast: meriyah.parseModule(source, options) }
    } catch (error) {
      const start = Number(error?.start)
      if (
        error?.description !== 'Unterminated string literal' ||
        !Number.isSafeInteger(start) ||
        !["'", '"'].includes(source[start])
      ) {
        throw error
      }

      const remainder = source.slice(start + 1)
      const match = /[\n\r\u{2028}\u{2029}]/v.exec(remainder)
      if (!match) {
        throw error
      }

      const lineStart = start + 1 + match.index
      const lineEnd =
        lineStart + (source[lineStart] === '\r' && source[lineStart + 1] === '\n' ? 2 : 1)
      source = source.slice(0, lineStart) + String.raw`\n` + source.slice(lineEnd)
    }
  }

  throw new Error('Could not recover cooked line terminators in JavaScript string literals')
}

async function buildModuleSource(code) {
  const meriyah = await meriyahPromise
  const parsed = parseModuleSource(code, meriyah)
  const checkpointName = nextInternalBindingName()
  const cancellableSource = instrumentCancellation(parsed.source, parsed.ast, checkpointName)
  const cancellable = parseModuleSource(cancellableSource, meriyah)
  code = cancellable.source
  const { ast } = cancellable
  const currentBindings = collectBindings(ast)
  const priorBindings = previousModule ? previousBindings : []
  const markCommittedName = nextInternalBindingName()
  const markPreludeName = nextInternalBindingName()
  const captureCompletionName = nextInternalBindingName()
  const instrumented = instrumentCurrentBindings(
    code,
    ast,
    markCommittedName,
    captureCompletionName
  )

  let prelude = [
    `const ${markCommittedName} = import.meta.__opencodeMarkCommitted;`,
    `const ${markPreludeName} = import.meta.__opencodeMarkPrelude;`,
    `const ${captureCompletionName} = import.meta.__opencodeCaptureCompletion;`,
    `const ${checkpointName} = import.meta.__opencodeThrowIfCancelled;`,
    'delete import.meta.__opencodeMarkCommitted;',
    'delete import.meta.__opencodeMarkPrelude;',
    'delete import.meta.__opencodeCaptureCompletion;',
    'delete import.meta.__opencodeThrowIfCancelled;'
  ].join('\n')
  prelude += '\n'
  if (previousModule && priorBindings.length > 0) {
    prelude += 'import * as __prev from "@prev";\n'
    prelude += priorBindings
      .map((binding) => {
        const keyword = binding.kind === 'var' ? 'var' : binding.kind === 'const' ? 'const' : 'let'
        return `${keyword} ${binding.name} = __prev.${binding.name};`
      })
      .join('\n')
    prelude += '\n'
  }

  prelude += `${markPreludeName}();\n`

  const merged = new Map(priorBindings.map((binding) => [binding.name, binding.kind]))
  for (const binding of currentBindings) {
    merged.set(binding.name, binding.kind)
  }

  const exportNames = merged.keys().toArray()
  const exports = exportNames.length > 0 ? `\nexport { ${exportNames.join(', ')} };` : ''
  return {
    source: `${prelude}${instrumented}${exports}`,
    currentBindings,
    priorBindings,
    nextBindings: Array.from(merged, ([name, kind]) => ({ name, kind }))
  }
}

function tryReadBinding(module, name) {
  try {
    return module.namespace[name] === undefined || true
  } catch {
    return false
  }
}

function collectCommittedBindings(module, prior, current, explicitlyCommitted) {
  const merged = new Map(prior.map((binding) => [binding.name, binding.kind]))
  let currentCount = 0
  for (const binding of current) {
    const readableLexical =
      !['var', 'function'].includes(binding.kind) && tryReadBinding(module, binding.name)
    if (readableLexical || explicitlyCommitted.has(binding.name)) {
      merged.set(binding.name, binding.kind)
      currentCount += 1
    }
  }

  return {
    bindings: Array.from(merged, ([name, kind]) => ({ name, kind })),
    currentCount
  }
}

function shouldPreserveModule(input) {
  const { module, isLinked, isPreludeCompleted, priorBindings, result, isInterrupted } = input
  return (
    !isInterrupted &&
    module &&
    isLinked &&
    (result.currentCount > 0 || (isPreludeCompleted && priorBindings.length > 0))
  )
}

const MODULE_CHAIN_COMPACT_INTERVAL = 50
// Rebase the persistent binding chain every N cells: each cell links to the
// previous one through "@prev", so the module graph would otherwise grow
// without bound and retain every prior cell's objects for the kernel's
// lifetime. A snapshot module re-exports the current bindings, letting older
// cell modules (and everything they close over) become collectable.
async function compactPreviousModule() {
  if (!previousModule || previousBindings.length === 0) {
    return
  }

  if (cellCounter % MODULE_CHAIN_COMPACT_INTERVAL !== 0) {
    return
  }

  const bindings = previousBindings
  const sourceModule = previousModule
  const snapshot = new SourceTextModule(
    'export { ' + bindings.map((binding) => binding.name).join(', ') + ' } from "@prev";',
    { context, identifier: path.join(cwd, `.opencode_js_repl_snapshot_${cellCounter}.mjs`) }
  )
  await snapshot.link(async (specifier) => {
    if (specifier !== '@prev') {
      throw new Error(`Unexpected binding snapshot import: ${specifier}`)
    }

    return new SyntheticModule(
      bindings.map((binding) => binding.name),
      function () {
        for (const binding of bindings) {
          this.setExport(binding.name, sourceModule.namespace[binding.name])
        }
      },
      { context }
    )
  })
  await snapshot.evaluate()
  previousModule = snapshot
}

function reportNonFatal(kind, error) {
  try {
    fs.writeSync(
      process.stderr.fd,
      'js_repl kernel non-fatal ' + kind + ' error: ' + formatError(error) + '\n'
    )
  } catch {}
}

function send(message) {
  fs.writeSync(PROTOCOL_FD, `${JSON.stringify(message)}\n`)
}

function formatError(error) {
  return String(error && typeof error === 'object' && 'message' in error ? error.message : error)
}

function scheduleFatalExit(kind, error) {
  if (isFatalExitScheduled) {
    return
  }

  isFatalExitScheduled = true
  const message = `js_repl kernel ${kind}: ${formatError(error)}; kernel reset.`
  if (activeExecId) {
    try {
      fs.writeSync(
        PROTOCOL_FD,
        `${JSON.stringify({
          type: 'exec_result',
          id: activeExecId,
          status: 'failed',
          output: '',
          error: message
        })}\n`
      )
    } catch {}
  }

  try {
    fs.writeSync(process.stderr.fd, `${message}\n`)
  } catch {}

  setImmediate(() => process.exit(1))
}

function takeUnhandledRejections(owner) {
  const errors = []
  for (const [promise, rejection] of unhandledRejections) {
    if (owner !== undefined && rejection.owner !== owner) {
      continue
    }

    unhandledRejections.delete(promise)
    errors.push(rejection.error)
  }

  return errors
}

function formatRejections(errors) {
  const messages = [...new Set(errors.map((error) => formatError(error)))]
  const shown = messages.slice(0, 5)
  if (messages.length > shown.length) {
    shown.push('... and ' + (messages.length - shown.length) + ' more')
  }

  return shown.join(' | ')
}

function formatLog(args) {
  return args
    .map((argument) =>
      typeof argument === 'string' ? argument : inspect(argument, { depth: 4, colors: false })
    )
    .join(' ')
}

async function withCapturedConsole(state, fn) {
  const logs = []
  state.logs = logs
  let isTruncated = false
  const capture = (...args) => {
    if (isTruncated) {
      return
    }

    const line = formatLog(args)
    const next = Buffer.byteLength(line) + (logs.length > 0 ? 1 : 0)
    // Console output and opencode.emitText share one execution-wide budget.
    if (state.outputBytes + next > MAX_OUTPUT_BYTES) {
      logs.push(`[js_repl output truncated at ${MAX_OUTPUT_BYTES} bytes]`)
      isTruncated = true
      return
    }

    logs.push(line)
    state.outputBytes += next
  }

  const original = context.console
  context.console = {
    ...console,
    log: capture,
    info: capture,
    warn: capture,
    error: capture,
    debug: capture
  }
  try {
    return await fn(logs)
  } finally {
    context.console = original
  }
}

async function handleExec(message) {
  pruneStaleLocalFileModules()
  activeExecId = message.id
  const execState = {
    attachments: [],
    attachmentBytes: 0,
    pendingImages: [],
    emittedText: [],
    outputBytes: 0,
    logs: null,
    cancelRequested: false
  }
  activeExecState = execState
  let module = null
  let currentBindings = []
  const previousModuleBeforeExec = previousModule
  const previousBindingsBeforeExec = previousBindings
  let priorBindings = previousBindings
  let nextBindings = []
  let isLinked = false
  let isPreludeCompleted = false
  let completionValue
  let completionPromise = null
  const committed = new Set()

  try {
    const priorUnhandled = takeUnhandledRejections()
    if (priorUnhandled.length > 0) {
      throw new Error(
        'Uncaught rejected Promise from background work: ' +
          formatRejections(priorUnhandled) +
          '; kernel preserved. This cell was not executed; call again to continue.'
      )
    }

    const built = await buildModuleSource(typeof message.code === 'string' ? message.code : '')
    currentBindings = built.currentBindings
    priorBindings = built.priorBindings
    nextBindings = built.nextBindings

    const output = await rejectionScope.run(message.id, () =>
      withCapturedConsole(execState, async (logs) => {
        const identifier = path.join(cwd, `.opencode_js_repl_cell_${cellCounter++}.mjs`)
        module = new SourceTextModule(built.source, {
          context,
          identifier,
          initializeImportMeta(meta, current) {
            setImportMeta(meta, current, true)
            meta.__opencodeThrowIfCancelled = throwIfExecutionCancelled
            meta.__opencodeMarkCommitted = (...names) => {
              for (const name of names) {
                committed.add(name)
              }
            }

            meta.__opencodeMarkPrelude = () => {
              isPreludeCompleted = true
            }

            meta.__opencodeCaptureCompletion = (value) => {
              completionValue = value
              // Promise assimilation handles cross-realm promises and reads a
              // custom thenable's then property exactly once.
              completionPromise = Promise.resolve(value).then((resolved) => {
                completionValue = resolved
              })
            }
          },
          importModuleDynamically(specifier, referrer) {
            return importResolved(resolveSpecifier(specifier, referrer?.identifier))
          }
        })
        await module.link(async (specifier, referrer) => {
          if (specifier === '@prev' && previousModule) {
            const bindings = previousBindings
            const sourceModule = previousModule
            return new SyntheticModule(
              bindings.map((binding) => binding.name),
              function () {
                for (const binding of bindings) {
                  this.setExport(binding.name, sourceModule.namespace[binding.name])
                }
              },
              { context }
            )
          }

          const resolved = resolveSpecifier(specifier, referrer?.identifier)
          return resolved.kind === 'file'
            ? loadLinkedFileModule(resolved.path)
            : loadLinkedNativeModule(resolved)
        })
        isLinked = true
        await module.evaluate({ breakOnSigint: true })
        throwIfExecutionCancelled()
        if (completionPromise) {
          await completionPromise
          throwIfExecutionCancelled()
        }

        if (execState.pendingImages.length > 0) {
          const imageResults = await Promise.all(execState.pendingImages)
          throwIfExecutionCancelled()
          const unhandled = imageResults.find(
            (result) => !result.ok && !result.observation.observed
          )
          if (unhandled) {
            throw unhandled.error
          }
        }

        // Give Node one turn to classify detached rejections created by this
        // cell, then surface them without terminating the persistent kernel.
        await new Promise((resolve) => {
          setImmediate(resolve)
        })
        const unhandled = takeUnhandledRejections(message.id)
        if (unhandled.length > 0) {
          throw new Error(
            'Uncaught rejected Promise: ' + formatRejections(unhandled) + '; kernel preserved.'
          )
        }

        const completion =
          completionValue === undefined
            ? []
            : [inspect(completionValue, { depth: 4, colors: false })]
        if (completion.length > 0) {
          const bytes =
            Buffer.byteLength(completion[0]) +
            (logs.length > 0 || execState.emittedText.length > 0 ? 1 : 0)
          if (execState.outputBytes + bytes > MAX_OUTPUT_BYTES) {
            completion[0] = `[js_repl output truncated at ${MAX_OUTPUT_BYTES} bytes]`
          } else {
            execState.outputBytes += bytes
          }
        }

        return [...logs, ...execState.emittedText, ...completion].join('\n')
      })
    )

    previousModule = module
    previousBindings = nextBindings
    try {
      await compactPreviousModule()
    } catch (snapshotError) {
      reportNonFatal('binding snapshot', snapshotError)
    }

    send({
      type: 'exec_result',
      id: message.id,
      status: 'completed',
      output,
      attachments: execState.attachments
    })
  } catch (error) {
    const isInterrupted = error?.code === 'ERR_SCRIPT_EXECUTION_INTERRUPTED'
    if (isInterrupted) {
      previousModule = previousModuleBeforeExec
      previousBindings = previousBindingsBeforeExec
    }

    const result = collectCommittedBindings(
      isLinked ? module : null,
      priorBindings,
      currentBindings,
      committed
    )
    if (
      shouldPreserveModule({
        module,
        isLinked,
        isPreludeCompleted,
        priorBindings,
        result,
        isInterrupted
      })
    ) {
      previousModule = module
      previousBindings = result.bindings
      try {
        await compactPreviousModule()
      } catch (snapshotError) {
        reportNonFatal('binding snapshot', snapshotError)
      }
    }

    // Preserve console/emitted text captured before the failure; those logs
    // are usually the most useful debugging evidence in an interactive session.
    const partialOutput = [...(execState.logs ?? []), ...execState.emittedText].join('\n')
    const isCancelled =
      error instanceof ExecutionCancelledError || execState.cancelRequested || isInterrupted
    send({
      type: 'exec_result',
      id: message.id,
      status: isCancelled ? 'cancelled' : 'failed',
      output: partialOutput,
      ...(!isCancelled && { error: formatError(error) })
    })
  } finally {
    if (activeExecId === message.id) {
      activeExecId = null
    }

    if (activeExecState === execState) {
      activeExecState = null
    }
  }
}

let queue = Promise.resolve()
let pending = ''

process.on('uncaughtException', (error) => scheduleFatalExit('uncaught exception', error))
process.on('unhandledRejection', (error, promise) =>
  unhandledRejections.set(promise, { error, owner: promiseOwners.get(promise) ?? null })
)
process.on('rejectionHandled', (promise) => unhandledRejections.delete(promise))
process.stdin.setEncoding('utf8')
// The controller owns this pipe. Its closure means OpenCode has shut down.
process.stdin.once('end', () => process.exit(0))
process.stdin.on('data', (chunk) => {
  pending += chunk
  while (true) {
    const newline = pending.indexOf('\n')
    if (newline === -1) {
      break
    }

    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    if (!line.trim()) {
      continue
    }

    try {
      const message = JSON.parse(line)
      if (message.type === 'exec') {
        queue = queue.then(() => handleExec(message))
      } else if (message.type === 'cancel') {
        if (activeExecState && activeExecId === message.id) {
          activeExecState.cancelRequested = true
        }

        send({ type: 'cancel_ack', id: message.id })
      } else {
        reportNonFatal(
          'protocol',
          new Error('ignored message of unknown type ' + JSON.stringify(message?.type ?? null))
        )
      }
    } catch (error) {
      reportNonFatal(
        'protocol',
        new Error('ignored a malformed protocol line: ' + formatError(error))
      )
    }
  }
})
