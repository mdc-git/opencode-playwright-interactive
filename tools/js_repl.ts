// Adapted from OpenAI Codex's js_repl kernel at revision 219c65d.
// Bundled third-party notices are in tools/NOTICE.txt.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createInterface, type Interface as ReadLineInterface } from "node:readline"
import { delimiter, join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { promisify } from "node:util"
import { gunzipSync } from "node:zlib"
import { tool } from "@opencode-ai/plugin"

const execFileAsync = promisify(execFile)
const MIN_NODE_VERSION = [22, 22, 0] as const
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PROTOCOL_LINE_BYTES = 32 * 1024 * 1024
const MERIYAH_VERSION = "7.0.0"
const PLAYWRIGHT_VERSION = "1.62.0"
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
const controllers = new Map<string, ReplController>()

// Replaced during the release-layout generation step with gzip(base64(JSON({ kernel, meriyah }))).
const BUNDLED_RUNTIME = "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"

type Attachment = { type: "file"; mime: string; url: string; filename?: string }
type Result = { output: string; attachments: Attachment[] }
type Pending = { id: string; resolve(result: Result): void; reject(error: Error): void }
type Message = {
  type: "exec_result"
  id: string
  ok: boolean
  output?: string
  attachments?: unknown
  error?: string | null
}

let bundledRuntime: { kernel: string } | undefined
const checkedNodes = new Map<string, Promise<void>>()
let cleanupRegistered = false

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function abortError() {
  return new DOMException("js_repl execution aborted; kernel reset", "AbortError")
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

function runtime() {
  if (bundledRuntime) return bundledRuntime
  if (BUNDLED_RUNTIME === "__OPENCODE_JS_REPL_BUNDLE__") {
    throw new Error("js_repl tool bundle is incomplete")
  }
  bundledRuntime = JSON.parse(gunzipSync(Buffer.from(BUNDLED_RUNTIME, "base64")).toString("utf8"))
  return bundledRuntime
}

function playwrightCacheDirectory() {
  return process.env.OPENCODE_PLAYWRIGHT_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode", "playwright")
}

function replCacheDirectory() {
  return process.env.OPENCODE_JS_REPL_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode", "js-repl")
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
  if (await exists(join(directory, "node_modules", "meriyah", "package.json"))) return
  await mkdir(directory, { recursive: true })
  await run(process.env.OPENCODE_JS_REPL_NPM_PATH ?? "npm", ["install", "--prefix", directory, `meriyah@${MERIYAH_VERSION}`], process.env)
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
  private child?: ChildProcessWithoutNullStreams
  private reader?: ReadLineInterface
  private pending?: Pending
  private queue: Promise<void> = Promise.resolve()
  private stderrTail: string[] = []
  private stderrFragment = ""
  private scratch?: string
  private disposed = false
  private request = 0

  constructor(private readonly sessionID: string, private readonly directory: string) {}

  execute(code: string, timeoutMs: number | undefined, signal: AbortSignal) {
    if (!code.trim()) return Promise.reject(new Error("code must contain JavaScript source"))
    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS
    return this.enqueue(() => this.executeNow(code, timeout, signal))
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    const pending = this.pending
    this.pending = undefined
    pending?.reject(new Error("js_repl controller disposed"))
    await this.stop()
    if (this.scratch) await rm(this.scratch, { recursive: true, force: true }).catch(() => undefined)
    this.scratch = undefined
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async executeNow(code: string, timeoutMs: number, signal: AbortSignal) {
    if (this.disposed) throw new Error("js_repl controller is disposed")
    if (signal.aborted) throw abortError()
    const child = await this.ensure()
    if (signal.aborted) {
      await this.stop()
      throw abortError()
    }
    const id = `${this.sessionID}-${++this.request}`
    return new Promise<Result>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, result?: Result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        if (this.pending?.id === id) this.pending = undefined
        if (error) reject(error)
        else resolve(result ?? { output: "", attachments: [] })
      }
      const reset = (error: Error) => {
        if (settled) return
        if (this.pending?.id === id) this.pending = undefined
        void this.stop().finally(() => finish(error))
      }
      const onAbort = () => reset(abortError())
      const timer = setTimeout(() => reset(new Error("js_repl execution timed out; kernel reset, rerun your request")), timeoutMs)
      this.pending = { id, resolve: (result) => finish(undefined, result), reject: (error) => finish(error) }
      signal.addEventListener("abort", onAbort, { once: true })
      child.stdin.write(`${JSON.stringify({ type: "exec", id, code })}\n`, (error) => {
        if (error) reset(new Error(`Failed to write to js_repl kernel: ${error.message}`))
      })
    })
  }

  private async ensure() {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child
    const node = process.env.OPENCODE_JS_REPL_NODE_PATH ?? "node"
    await checkNode(node)
    await ensureMeriyah()
    this.scratch ??= await mkdtemp(join(tmpdir(), "opencode-js-repl-"))
    const source = runtime()
    const kernelPath = join(this.scratch, "kernel.cjs")
    await writeFile(kernelPath, source.kernel)
    this.stderrTail = []
    this.stderrFragment = ""
    const moduleDirs = [
      ...(process.env.OPENCODE_JS_REPL_NODE_MODULE_DIRS?.split(delimiter).filter(Boolean) ?? []),
      join(replCacheDirectory(), "node_modules"),
      join(playwrightCacheDirectory(), "node_modules"),
    ]
    const child = spawn(node, ["--no-warnings", "--experimental-vm-modules", kernelPath], {
      cwd: this.directory,
      env: { ...process.env, NODE_PATH: [join(replCacheDirectory(), "node_modules"), process.env.NODE_PATH].filter(Boolean).join(delimiter), OPENCODE_JS_REPL_SESSION_ID: this.sessionID, OPENCODE_JS_REPL_TMP_DIR: this.scratch, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowserDirectory(), OPENCODE_JS_REPL_NODE_MODULE_DIRS: moduleDirs.join(delimiter) },
      stdio: ["pipe", "pipe", "pipe"],
    })
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => { child.off("error", onError); resolve() }
      const onError = (error: Error) => { child.off("spawn", onSpawn); reject(new Error(`Failed to start js_repl kernel: ${error.message}`)) }
      child.once("spawn", onSpawn)
      child.once("error", onError)
    })
    this.child = child
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.reader.on("line", (line) => this.handleLine(child, line))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => this.handleStderr(chunk))
    child.once("close", (code, signal) => this.handleClose(child, code, signal))
    child.once("error", (error) => this.fail(child, new Error(`js_repl kernel process error: ${error.message}`)))
    return child
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string) {
    if (child !== this.child) return
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) return void this.fail(child, new Error("js_repl kernel exceeded the protocol output limit"))
    let message: Message
    try { message = JSON.parse(line) as Message } catch { return void this.fail(child, new Error("js_repl kernel sent invalid JSON")) }
    if (message.type !== "exec_result" || !this.pending || message.id !== this.pending.id) return
    const pending = this.pending
    this.pending = undefined
    if (!message.ok) {
      const error = new Error(message.error || "js_repl execution failed")
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

  private handleClose(child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null) {
    if (child !== this.child) return
    if (this.stderrFragment) this.pushStderr(this.stderrFragment)
    this.detach(child)
    const status = code === null ? `signal=${signal ?? "unknown"}` : `code=${code}`
    const diagnostics = this.stderrTail.length ? `; stderr: ${this.stderrTail.join(" | ")}` : ""
    const pending = this.pending
    this.pending = undefined
    pending?.reject(new Error(`js_repl kernel exited unexpectedly (${status})${diagnostics}`))
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error) {
    if (child !== this.child) return
    const pending = this.pending
    this.pending = undefined
    void this.stop().finally(() => pending?.reject(error))
  }

  private detach(child: ChildProcessWithoutNullStreams) {
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
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000)
      child.once("close", () => { clearTimeout(timer); resolve() })
      child.kill("SIGKILL")
    })
  }
}

function controllerFor(sessionID: string, directory: string) {
  let controller = controllers.get(sessionID)
  if (!controller) {
    controller = new ReplController(sessionID, directory)
    controllers.set(sessionID, controller)
  }
  if (!cleanupRegistered) {
    cleanupRegistered = true
    const cleanup = () => { for (const controller of controllers.values()) void controller.dispose(); controllers.clear() }
    process.once("exit", cleanup)
  }
  return controller
}

async function removeController(sessionID: string) {
  const controller = controllers.get(sessionID)
  if (!controller) return false
  controllers.delete(sessionID)
  await controller.dispose()
  return true
}

export default tool({
  description: "Execute JavaScript in a persistent, session-isolated Node.js kernel with top-level await. Send plain JavaScript in code without markdown fences. Top-level bindings persist until js_repl_reset. Use dynamic imports such as await import('node:path') and attach images with await opencode.emitImage({ bytes, mimeType, filename? }). A timeout or cancellation resets the kernel and discards its state.",
  args: {
    code: tool.schema.string().min(1).describe("Plain JavaScript source to execute. Do not wrap it in JSON or markdown fences."),
    timeout_ms: tool.schema.number().int().min(1).max(MAX_TIMEOUT_MS).optional().describe(`Execution timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`),
  },
  async execute(args, context) {
    await context.ask({ permission: "js_repl", patterns: ["execute"], always: ["execute"], metadata: { warning: "JavaScript runs in Node with the current user's filesystem and network privileges." } })
    const timeout = args.timeout_ms ?? DEFAULT_TIMEOUT_MS
    context.metadata({ title: "JavaScript REPL", metadata: { timeout_ms: timeout } })
    const result = await controllerFor(context.sessionID, context.directory).execute(args.code, timeout, context.abort)
    return { title: "JavaScript REPL", output: result.output || "JavaScript executed successfully (no console output).", attachments: result.attachments, metadata: { timeout_ms: timeout } }
  },
})

export const reset = tool({
  description: "Reset the persistent JavaScript kernel for the current OpenCode session, clearing all bindings and imported state.",
  args: {},
  async execute(_args, context) {
    context.metadata({ title: "Reset JavaScript REPL" })
    const didReset = await removeController(context.sessionID)
    return { title: "Reset JavaScript REPL", output: didReset ? "JavaScript REPL kernel reset." : "JavaScript REPL kernel was not initialized." }
  },
})

export const playwright_setup = tool({
  description: "Install Playwright and Chromium once in the shared OpenCode cache for use by js_repl across all workspaces.",
  args: {
    force: tool.schema.boolean().optional().describe("Reinstall Playwright and Chromium even when the shared cache is already ready."),
  },
  async execute(args, context) {
    await context.ask({ permission: "js_repl", patterns: ["playwright_setup"], always: ["playwright_setup"], metadata: { warning: "This downloads Playwright and Chromium into a shared user cache." } })
    const directory = playwrightCacheDirectory()
    const marker = join(directory, `.chromium-${PLAYWRIGHT_VERSION}`)
    const environment = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowserDirectory() }
    context.metadata({ title: "Set Up Shared Playwright" })
    await mkdir(directory, { recursive: true })
    if (args.force || !(await exists(join(directory, "node_modules", "playwright", "package.json")))) {
      await run(process.env.OPENCODE_PLAYWRIGHT_NPM_PATH ?? "npm", ["install", "--prefix", directory, `playwright@${PLAYWRIGHT_VERSION}`], environment)
    }
    if (args.force || !(await exists(marker))) {
      await run(process.env.OPENCODE_PLAYWRIGHT_NPX_PATH ?? "npx", ["--prefix", directory, "playwright", "install", "chromium"], environment)
      await writeFile(marker, "")
    }
    return { title: "Set Up Shared Playwright", output: `Shared Playwright ${PLAYWRIGHT_VERSION} and Chromium are ready at ${directory}.` }
  },
})
