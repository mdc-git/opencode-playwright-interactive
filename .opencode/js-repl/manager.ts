import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { createInterface, type Interface as ReadLineInterface } from "node:readline"

const execFileAsync = promisify(execFile)
const MIN_NODE_VERSION = [22, 22, 0] as const
const STDERR_LINE_LIMIT = 20
const STDERR_LINE_BYTES = 512
const STDERR_TOTAL_BYTES = 4096
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PROTOCOL_LINE_BYTES = 32 * 1024 * 1024
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_TIMEOUT_MS = 300_000

export type ReplAttachment = {
  type: "file"
  mime: string
  url: string
  filename?: string
}

export type ReplExecutionResult = {
  output: string
  attachments: ReplAttachment[]
}

type PendingExecution = {
  id: string
  resolve(result: ReplExecutionResult): void
  reject(error: Error): void
}

type ExecResultMessage = {
  type: "exec_result"
  id: string
  ok: boolean
  output?: string
  attachments?: unknown
  error?: string | null
}

export type ReplControllerOptions = {
  sessionID: string
  directory: string
  kernelPath?: string
  nodePath?: string
  moduleDirs?: string[]
}

const checkedNodePaths = new Map<string, Promise<void>>()

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

async function checkNode(nodePath: string) {
  let check = checkedNodePaths.get(nodePath)
  if (!check) {
    check = (async () => {
      let stdout: string
      try {
        ;({ stdout } = await execFileAsync(nodePath, ["--version"], {
          encoding: "utf8",
          timeout: 5_000,
        }))
      } catch (error) {
        throw new Error(`Failed to start Node runtime at "${nodePath}": ${errorMessage(error)}`)
      }
      const actual = parseVersion(stdout)
      if (!versionAtLeast(actual, MIN_NODE_VERSION)) {
        throw new Error(
          `js_repl requires Node >=${MIN_NODE_VERSION.join(".")}; "${nodePath}" is ${actual.join(".")}`,
        )
      }
    })()
    checkedNodePaths.set(nodePath, check)
  }
  return check
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function boundedUtf8(value: string, maxBytes: number) {
  const buffer = Buffer.from(value)
  if (buffer.byteLength <= maxBytes) return value
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "")
}

function decodedBase64Size(value: string) {
  const compact = value.replace(/\s/g, "")
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new Error("js_repl kernel sent invalid base64 image data")
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding)
}

function validateAttachments(value: unknown): ReplAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error("js_repl kernel sent invalid image attachments")
  }
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("js_repl kernel sent a malformed image attachment")
    }
    const attachment = item as Record<string, unknown>
    if (
      attachment.type !== "file" ||
      typeof attachment.mime !== "string" ||
      !SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mime) ||
      typeof attachment.url !== "string"
    ) {
      throw new Error("js_repl kernel sent a malformed image attachment")
    }
    const match = attachment.url.match(/^data:([^;,]+);base64,([\s\S]+)$/i)
    if (!match || match[1]?.toLowerCase() !== attachment.mime) {
      throw new Error("js_repl kernel sent an invalid image data URL")
    }
    const size = decodedBase64Size(match[2]!)
    if (size === 0 || size > MAX_IMAGE_BYTES) {
      throw new Error("js_repl kernel sent an image outside the allowed size range")
    }
    if (
      attachment.filename !== undefined &&
      (typeof attachment.filename !== "string" ||
        !attachment.filename ||
        attachment.filename.length > 255 ||
        attachment.filename.includes("/") ||
        attachment.filename.includes("\\") ||
        attachment.filename.includes("\0"))
    ) {
      throw new Error("js_repl kernel sent an invalid image filename")
    }
    return {
      type: "file",
      mime: attachment.mime,
      url: attachment.url,
      ...(typeof attachment.filename === "string" ? { filename: attachment.filename } : {}),
    }
  })
}

export function validateTimeout(timeoutMs: number | undefined) {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be an integer between 1 and ${MAX_TIMEOUT_MS}`)
  }
  return timeoutMs
}

export class ReplController {
  readonly sessionID: string
  readonly directory: string

  private readonly kernelPath: string
  private readonly nodePath: string
  private readonly moduleDirs: string[]
  private child?: ChildProcessWithoutNullStreams
  private reader?: ReadLineInterface
  private pending?: PendingExecution
  private queue: Promise<void> = Promise.resolve()
  private stderrTail: string[] = []
  private stderrFragment = ""
  private scratchDirectory?: string
  private disposed = false
  private requestCounter = 0

  constructor(options: ReplControllerOptions) {
    this.sessionID = options.sessionID
    this.directory = options.directory
    this.kernelPath =
      options.kernelPath ?? fileURLToPath(new URL("./kernel.cjs", import.meta.url))
    this.nodePath = options.nodePath ?? process.env.OPENCODE_JS_REPL_NODE_PATH ?? "node"
    this.moduleDirs = options.moduleDirs ?? []
  }

  execute(code: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal) {
    return this.executeResult(code, timeoutMs, signal).then((result) => result.output)
  }

  executeResult(code: string, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal) {
    const timeout = validateTimeout(timeoutMs)
    if (!code.trim()) return Promise.reject(new Error("code must contain JavaScript source"))
    return this.enqueue(() => this.executeNow(code, timeout, signal))
  }

  reset() {
    return this.enqueue(async () => {
      await this.stopKernel("reset")
    })
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    const pending = this.pending
    this.pending = undefined
    pending?.reject(new Error("js_repl controller disposed"))
    await this.stopKernel("dispose")
    if (this.scratchDirectory) {
      await rm(this.scratchDirectory, { recursive: true, force: true }).catch(() => undefined)
      this.scratchDirectory = undefined
    }
  }

  private enqueue<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async executeNow(code: string, timeoutMs: number, signal?: AbortSignal) {
    if (this.disposed) throw new Error("js_repl controller is disposed")
    if (signal?.aborted) throw abortError()
    const child = await this.ensureKernel()
    if (signal?.aborted) {
      await this.stopKernel("abort")
      throw abortError()
    }

    const id = `${this.sessionID}-${++this.requestCounter}`
    return new Promise<ReplExecutionResult>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, result?: ReplExecutionResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        if (this.pending?.id === id) this.pending = undefined
        if (error) reject(error)
        else resolve(result ?? { output: "", attachments: [] })
      }
      const resetAndFinish = (error: Error, reason: string) => {
        if (settled) return
        if (this.pending?.id === id) this.pending = undefined
        void this.stopKernel(reason).finally(() => finish(error))
      }
      const onAbort = () => resetAndFinish(abortError(), "abort")
      const timer = setTimeout(() => {
        resetAndFinish(
          new Error("js_repl execution timed out; kernel reset, rerun your request"),
          "timeout",
        )
      }, timeoutMs)

      this.pending = {
        id,
        resolve: (result) => finish(undefined, result),
        reject: (error) => finish(error),
      }
      signal?.addEventListener("abort", onAbort, { once: true })

      const payload = `${JSON.stringify({ type: "exec", id, code })}\n`
      child.stdin.write(payload, (error) => {
        if (error) resetAndFinish(new Error(`Failed to write to js_repl kernel: ${error.message}`), "write")
      })
    })
  }

  private async ensureKernel() {
    if (this.child && !this.child.killed && this.child.exitCode === null) return this.child
    await checkNode(this.nodePath)
    this.scratchDirectory ??= await mkdtemp(join(tmpdir(), "opencode-js-repl-"))
    this.stderrTail = []
    this.stderrFragment = ""

    const configuredDirs = process.env.OPENCODE_JS_REPL_NODE_MODULE_DIRS
      ?.split(delimiter)
      .filter(Boolean)
    const moduleDirs = [...(configuredDirs ?? []), ...this.moduleDirs]
    const child = spawn(this.nodePath, ["--no-warnings", "--experimental-vm-modules", this.kernelPath], {
      cwd: this.directory,
      env: {
        ...process.env,
        OPENCODE_JS_REPL_SESSION_ID: this.sessionID,
        OPENCODE_JS_REPL_TMP_DIR: this.scratchDirectory,
        ...(moduleDirs.length
          ? { OPENCODE_JS_REPL_NODE_MODULE_DIRS: moduleDirs.join(delimiter) }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError)
        resolve()
      }
      const onError = (error: Error) => {
        child.off("spawn", onSpawn)
        reject(new Error(`Failed to start js_repl kernel: ${error.message}`))
      }
      child.once("spawn", onSpawn)
      child.once("error", onError)
    })

    this.child = child
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.reader.on("line", (line) => this.handleLine(child, line))
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => this.handleStderr(chunk))
    child.once("close", (code, signal) => this.handleClose(child, code, signal))
    child.once("error", (error) => this.handleProcessError(child, error))
    return child
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string) {
    if (child !== this.child) return
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
      void this.failKernel(new Error("js_repl kernel exceeded the protocol output limit"), "protocol")
      return
    }
    let message: ExecResultMessage
    try {
      message = JSON.parse(line) as ExecResultMessage
    } catch {
      void this.failKernel(new Error("js_repl kernel sent invalid JSON"), "protocol")
      return
    }
    if (message.type !== "exec_result" || !this.pending || message.id !== this.pending.id) return
    const pending = this.pending
    this.pending = undefined
    if (message.ok) {
      let attachments: ReplAttachment[]
      try {
        attachments = validateAttachments(message.attachments)
      } catch (error) {
        void this.stopKernel("protocol").finally(() => pending.reject(error as Error))
        return
      }
      pending.resolve({
        output: typeof message.output === "string" ? message.output : "",
        attachments,
      })
    } else {
      const error = new Error(message.error || "js_repl execution failed")
      if (message.error?.includes("kernel reset")) {
        void this.stopKernel("fatal").finally(() => pending.reject(error))
      } else {
        pending.reject(error)
      }
    }
  }

  private handleStderr(chunk: string) {
    this.stderrFragment += chunk
    const lines = this.stderrFragment.split(/\r?\n/)
    this.stderrFragment = lines.pop() ?? ""
    for (const line of lines) this.pushStderr(line)
  }

  private pushStderr(line: string) {
    const bounded = boundedUtf8(line, STDERR_LINE_BYTES)
    if (!bounded) return
    this.stderrTail.push(bounded)
    while (
      this.stderrTail.length > STDERR_LINE_LIMIT ||
      Buffer.byteLength(this.stderrTail.join(" | ")) > STDERR_TOTAL_BYTES
    ) {
      this.stderrTail.shift()
    }
  }

  private handleClose(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) {
    if (child !== this.child) return
    if (this.stderrFragment) this.pushStderr(this.stderrFragment)
    this.detachKernel(child)
    const status = code === null ? `signal=${signal ?? "unknown"}` : `code=${code}`
    const diagnostics = this.stderrTail.length ? `; stderr: ${this.stderrTail.join(" | ")}` : ""
    const pending = this.pending
    this.pending = undefined
    pending?.reject(new Error(`js_repl kernel exited unexpectedly (${status})${diagnostics}`))
  }

  private handleProcessError(child: ChildProcessWithoutNullStreams, error: Error) {
    if (child !== this.child) return
    void this.failKernel(new Error(`js_repl kernel process error: ${error.message}`), "process")
  }

  private async failKernel(error: Error, reason: string) {
    const pending = this.pending
    this.pending = undefined
    await this.stopKernel(reason)
    pending?.reject(error)
  }

  private detachKernel(child: ChildProcessWithoutNullStreams) {
    if (child !== this.child) return
    this.reader?.close()
    this.reader = undefined
    this.child = undefined
  }

  private async stopKernel(_reason: string) {
    const child = this.child
    if (!child) return
    this.detachKernel(child)
    if (child.exitCode !== null || child.killed) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000)
      child.once("close", () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill("SIGKILL")
    })
  }
}
