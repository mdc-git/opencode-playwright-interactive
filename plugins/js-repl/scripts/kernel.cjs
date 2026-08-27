#!/usr/bin/env node
// Adapted from OpenAI Codex's js_repl kernel at revision 219c65d.

const { Buffer } = require('node:buffer')
const { AsyncLocalStorage, createHook } = require('node:async_hooks')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const process = require('node:process')
const repl = require('node:repl')
const { PassThrough, Writable } = require('node:stream')
const { inspect } = require('node:util')

const PROTOCOL_FD = 3
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES_PER_EXEC = 4
const MAX_TOTAL_IMAGE_BYTES = MAX_IMAGE_BYTES * MAX_IMAGES_PER_EXEC
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

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

const cwd = process.cwd()
const temporaryDir = process.env.JS_REPL_INTERNAL_TMP_DIR || cwd
const homeDir = process.env.HOME ?? null
const sessionId = process.env.JS_REPL_INTERNAL_SESSION_ID || null
const scriptDir = process.env.JS_REPL_INTERNAL_SCRIPT_DIR || null
let browserBindingCounter = 0
const workspaceRequire = createRequire(path.join(cwd, '__opencode_js_repl__.cjs'))

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

const replInput = new PassThrough()
const replOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback()
  }
})
const replServer = repl.start({
  prompt: '',
  input: replInput,
  output: replOutput,
  terminal: false,
  useGlobal: false,
  ignoreUndefined: true,
  breakEvalOnSigint: true
})
const { context } = replServer
context.require = workspaceRequire
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

function createReplEvaluator(server) {
  const domain = server?._domain
  if (
    !domain ||
    typeof domain.on !== 'function' ||
    typeof domain.prependListener !== 'function' ||
    typeof server?.eval !== 'function' ||
    !server.context
  ) {
    throw new Error('js_repl requires a Node REPL with programmatic domain error routing')
  }

  let active = null
  // The default evaluator sends execution errors through this private domain
  // before returning to its callback, so observe it ahead of Node's writer.
  domain.prependListener('error', (error) => {
    if (active && error?.domainThrown !== true) {
      active.fail(error)
      return
    }

    if (error?.domainThrown !== true) {
      rememberUnhandledRejection(error, rejectionScope.getStore())
      return
    }

    scheduleFatalExit('REPL domain error', error)
  })

  return (code, resourceName) =>
    new Promise((resolve, reject) => {
      let isSettled = false
      const evaluation = {
        fail(error) {
          finish(error)
        }
      }
      const finish = (error, value) => {
        if (isSettled) {
          return
        }

        isSettled = true
        if (active === evaluation) {
          active = null
        }

        if (error) {
          reject(error)
        } else {
          resolve(value)
        }
      }

      active = evaluation
      try {
        server.eval(code, server.context, resourceName, finish)
      } catch (error) {
        finish(error)
      }
    })
}

const evaluateInRepl = createReplEvaluator(replServer)

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

function rememberUnhandledRejection(error, owner) {
  // REPL-domain rejection events do not include their Promise object.
  unhandledRejections.set({}, { error, owner: owner ?? null })
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

  try {
    const priorUnhandled = takeUnhandledRejections()
    if (priorUnhandled.length > 0) {
      throw new Error(
        'Uncaught rejected Promise from background work: ' +
          formatRejections(priorUnhandled) +
          '; kernel preserved. This cell was not executed; call again to continue.'
      )
    }

    const output = await rejectionScope.run(message.id, () =>
      withCapturedConsole(execState, async (logs) => {
        const value = await evaluateInRepl(
          typeof message.code === 'string' ? message.code : '',
          path.join(cwd, '__opencode_js_repl__.cjs')
        )
        throwIfExecutionCancelled()

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

        throwIfExecutionCancelled()

        const completion = value === undefined ? [] : [inspect(value, { depth: 4, colors: false })]
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

    send({
      type: 'exec_result',
      id: message.id,
      status: 'completed',
      output,
      attachments: execState.attachments
    })
  } catch (error) {
    const isInterrupted = error?.code === 'ERR_SCRIPT_EXECUTION_INTERRUPTED'

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
