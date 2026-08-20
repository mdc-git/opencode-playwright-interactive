// Adapted from OpenAI Codex's js_repl kernel at revision 219c65d.
import { Buffer } from 'node:buffer'
import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions
} from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'

const envKey = <const K extends string>(k: K): K => k

type ExecFileResult = { stdout: string; stderr: string }

async function execFileAsync(
  command: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; maxBuffer?: number; env?: NodeJS.ProcessEnv }
) {
  return new Promise<ExecFileResult>((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        const cause: Error = error

        reject(cause)
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

const MIN_NODE_VERSION = [22, 22, 0] as const
const FOREGROUND_WAIT_MS = 30_000
const JOB_WAIT_MS = 30_000
const CANCEL_ACK_WAIT_MS = 250
const MAX_RETAINED_TERMINAL_JOBS = 20
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PROTOCOL_LINE_BYTES = 32 * 1024 * 1024
const MERIYAH_VERSION = '7.0.0'
const PLAYWRIGHT_VERSION = '1.60.0'
const CAMOUFOX_VERSION = '0.12.0'
const CAMOUFOX_PACKAGE = 'camoufox-js'
const CAMOUFOX_INSTALL_DIR_NAME = 'camoufox'
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

// The persistent Node kernel lives in scripts/kernel.cjs so the tool stays
// self-contained within the plugin package.
type Attachment = { type: 'file'; mime: string; url: string; filename?: string }
type Result = { output: string; attachments: Attachment[] }
export type JobState = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
export type JobSnapshot = {
  id: string
  state: JobState
  startedAt: string
  finishedAt?: string
  output?: string
  attachments?: Attachment[]
  error?: string
}
export type ExecuteOutcome =
  | { kind: 'completed'; result: Result }
  | { kind: 'background'; job: JobSnapshot }
  | { kind: 'busy'; job: JobSnapshot }
export type JobActionOutcome =
  { kind: 'list'; jobs: JobSnapshot[] } | { kind: 'job'; job: JobSnapshot }
type ReplJob = {
  id: string
  state: JobState
  startedAt: number
  finishedAt?: number
  result?: Result
  error?: Error
  completion: Promise<void>
  complete(): void
  cancelAcknowledged: boolean
  cancelFallback?: NodeJS.Timeout
}
type KernelProcess = ChildProcessWithoutNullStreams & {
  stdio: [
    NodeJS.WritableStream,
    NodeJS.ReadableStream,
    NodeJS.ReadableStream,
    NodeJS.ReadableStream
  ]
}
type Message =
  | {
      type: 'exec_result'
      id: string
      status: 'completed' | 'failed' | 'cancelled'
      output?: string
      attachments?: unknown
      error?: string
    }
  | { type: 'cancel_ack'; id: string }

const checkedNodes = new Map<string, Promise<void>>()

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function parseVersion(value: string) {
  const match = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/v.exec(value.trim())
  if (!match) {
    throw new Error(`Unable to parse Node version: ${value.trim()}`)
  }

  const { major, minor, patch } = match.groups ?? {}
  return [Number(major), Number(minor), Number(patch)] as const
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]) {
  for (const [index, element] of minimum.entries()) {
    if (actual[index] > element) {
      return true
    }

    if (actual[index] < element) {
      return false
    }
  }

  return true
}

async function checkNode(path: string) {
  let check = checkedNodes.get(path)
  if (!check) {
    check = (async () => {
      let stdout: string
      try {
        ;({ stdout } = await execFileAsync(path, ['--version'], {
          encoding: 'utf8',
          timeout: 5000
        }))
      } catch (error) {
        throw new Error(`Failed to start Node runtime at "${path}": ${errorMessage(error)}`, {
          cause: error
        })
      }

      const actual = parseVersion(stdout)
      if (!versionAtLeast(actual, MIN_NODE_VERSION)) {
        throw new Error(
          `js_repl requires Node >=${MIN_NODE_VERSION.join('.')}; "${path}" is ${actual.join('.')}`
        )
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

async function readHeartbeatAge(heartbeatPath: string, lockPath: string) {
  try {
    const info = await stat(heartbeatPath)
    return Date.now() - info.mtimeMs
  } catch {
    // No heartbeat yet; fall back to the lock directory's own age.
    return stat(lockPath)
      .then((info) => Date.now() - info.mtimeMs)
      .catch(() => LOCK_STALE_MS + 1)
  }
}

async function waitForStaleLock(lockPath: string, heartbeatPath: string, start: number) {
  if (Date.now() - start > LOCK_TIMEOUT_MS) {
    throw new Error(
      `Timed out waiting for the js_repl setup lock ${lockPath}; another process may be installing. Remove it manually if the holder is gone.`
    )
  }

  const heartbeatAge = await readHeartbeatAge(heartbeatPath, lockPath)
  if (heartbeatAge > LOCK_STALE_MS) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
  } else {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, LOCK_POLL_MS)
    })
  }
}

async function acquireCacheLock(lockPath: string, heartbeatPath: string) {
  const start = Date.now()
  const attempt = async (): Promise<void> => {
    try {
      await mkdir(lockPath)
      await writeFile(heartbeatPath, `${process.pid} ${Date.now()}\n`, 'utf8').catch(
        () => undefined
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw error
      }

      await waitForStaleLock(lockPath, heartbeatPath, start)
      await attempt()
    }
  }

  await attempt()
}

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
  await acquireCacheLock(lockPath, heartbeatPath)
  const heartbeat = setInterval(() => {
    writeFile(heartbeatPath, `${process.pid} ${Date.now()}\n`, 'utf8').catch(() => undefined)
  }, LOCK_RENEW_MS)
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
  }
}

type RuntimeOptions = Readonly<{
  nodePath?: unknown
  nodeModuleDirs?: unknown
  replCacheDir?: unknown
  playwrightCacheDir?: unknown
  npmPath?: unknown
  playwrightNpmPath?: unknown
  playwrightNpxPath?: unknown
}>

function optionString(options: RuntimeOptions, key: keyof RuntimeOptions, fallback: string) {
  const value = options[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function optionStrings(options: RuntimeOptions, key: keyof RuntimeOptions) {
  const value = options[key]
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : []
}

function defaultCacheDirectory() {
  return join(homedir(), '.cache', 'opencode')
}

function playwrightCacheDirectory(options: RuntimeOptions) {
  return optionString(options, 'playwrightCacheDir', join(defaultCacheDirectory(), 'playwright'))
}

function replCacheDirectory(options: RuntimeOptions) {
  return optionString(options, 'replCacheDir', defaultCacheDirectory())
}

function playwrightBrowserDirectory(options: RuntimeOptions) {
  return join(playwrightCacheDirectory(options), 'browsers')
}

async function doesExist(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function isPackageMatch(file: string, name: string, version: string) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8')) as { name?: string; version?: string }
    return value.name === name && value.version === version
  } catch {
    return false
  }
}

// The .chromium-<version> marker alone cannot prove the browser download
// survived (users clean caches, disks fill, installs crash). Resolve the
// expected executable from the playwright-core browser registry and check
// that it is actually on disk. Playwright 1.60 ships Chrome for Testing
// builds under the Chromium name (chrome-linux64 / chrome-mac-x64 /
// chrome-win64).
async function isChromiumExecutablePresent(directory: string, browserDirectory: string) {
  try {
    const registry = JSON.parse(
      await readFile(join(directory, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8')
    ) as {
      browsers?: Array<{ name?: string; revision?: string; browserRevision?: string }>
    }
    const chromium = registry.browsers?.find((browser) => browser?.name === 'chromium')
    const revision = chromium?.browserRevision ?? chromium?.revision
    if (revision === undefined) {
      return false
    }

    return await doesExist(join(browserDirectory, chromiumExecutableRelative(revision)))
  } catch {
    return false
  }
}

function chromiumExecutableRelative(revision: string) {
  const folder = `chromium-${revision}`
  if (process.platform === 'darwin') {
    const sub = process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64'
    return join(
      folder,
      sub,
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing'
    )
  }

  if (process.platform === 'win32') {
    return join(folder, 'chrome-win64', 'chrome.exe')
  }

  return join(folder, process.arch === 'arm64' ? 'chrome-linux' : 'chrome-linux64', 'chrome')
}

// Camoufox resolves its installation from CAMOUFOX_INSTALL_DIR at launch
// time; the version.json it writes after a successful fetch is the
// authoritative readiness signal (the same check launchOptions performs).
async function isCamoufoxReady(camoufoxDirectory: string) {
  return doesExist(join(camoufoxDirectory, 'version.json'))
}

async function run(command: string, args: string[], environment: NodeJS.ProcessEnv) {
  try {
    await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: 10 * 60_000,
      maxBuffer: 1024 * 1024,
      env: environment
    })
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string }
    const output = [details.stdout, details.stderr].filter(Boolean).join('\n').trim()
    throw new Error(
      `Playwright setup failed: ${errorMessage(error)}${output === '' ? '' : `\n${boundedUtf8(output, 8192)}`}`,
      { cause: error }
    )
  }
}

async function ensureMeriyah(options: RuntimeOptions) {
  const directory = replCacheDirectory(options)
  const packageFile = join(directory, 'node_modules', 'meriyah', 'package.json')
  if (await isPackageMatch(packageFile, 'meriyah', MERIYAH_VERSION)) {
    return
  }

  await mkdir(directory, { recursive: true })
  await withCacheLock(join(directory, '.meriyah-install'), async () => {
    // Re-check under the lock: another process may have finished installing.
    if (await isPackageMatch(packageFile, 'meriyah', MERIYAH_VERSION)) {
      return
    }

    await run(
      optionString(options, 'npmPath', 'npm'),
      ['install', '--prefix', directory, `meriyah@${MERIYAH_VERSION}`],
      process.env
    )
  })
}

function boundedUtf8(value: string, maxBytes: number) {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= maxBytes) {
    return value
  }

  return bytes
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\u{FFFD}$/v, '')
}

function decodedBase64Size(value: string) {
  const compact = value.replaceAll(/\s/gv, '')
  if (compact === '' || !/^[+\/0-9a-z]*={0,2}$/iv.test(compact)) {
    throw new Error('js_repl kernel sent invalid base64 image data')
  }

  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding)
}

function assertValidAttachmentType(attachment: Record<string, unknown>): {
  mime: string
  url: string
} {
  if (
    attachment.type !== 'file' ||
    typeof attachment.mime !== 'string' ||
    !SUPPORTED_IMAGE_MIME_TYPES.has(attachment.mime) ||
    typeof attachment.url !== 'string'
  ) {
    throw new Error('js_repl kernel sent a malformed image attachment')
  }

  return { mime: attachment.mime, url: attachment.url }
}

function assertValidAttachmentFilename(filename: unknown) {
  if (
    filename !== undefined &&
    (typeof filename !== 'string' ||
      filename === '' ||
      filename.length > 255 ||
      /[\0\/\\]/v.test(filename))
  ) {
    throw new Error('js_repl kernel sent an invalid image filename')
  }
}

function validateAttachmentPayload(url: string, mime: string) {
  const match = /^data:(?<mime>[^,;]+);base64,(?<data>[\s\S]+)$/iv.exec(url)
  if (!match || match.groups?.mime?.toLowerCase() !== mime) {
    throw new Error('js_repl kernel sent an invalid image data URL')
  }

  const size = decodedBase64Size(match.groups?.data ?? '')
  if (size === 0 || size > MAX_IMAGE_BYTES) {
    throw new Error('js_repl kernel sent an image outside the allowed size range')
  }
}

function validateAttachment(item: unknown): Attachment {
  if (item === null || typeof item !== 'object') {
    throw new Error('js_repl kernel sent a malformed image attachment')
  }

  const attachment = item as Record<string, unknown>
  const { mime, url } = assertValidAttachmentType(attachment)
  validateAttachmentPayload(url, mime)
  assertValidAttachmentFilename(attachment.filename)
  return {
    type: 'file',
    mime,
    url,
    ...(typeof attachment.filename === 'string' && { filename: attachment.filename })
  }
}

function attachments(value: unknown): Attachment[] {
  if (value === undefined) {
    return []
  }

  if (!Array.isArray(value) || value.length > 4) {
    throw new Error('js_repl kernel sent invalid image attachments')
  }

  return value.map((item) => validateAttachment(item))
}

class ReplController {
  private readonly sessionId: string
  private readonly directory: string
  private readonly options: RuntimeOptions
  private readonly scriptDirectory: string
  private child?: KernelProcess
  private reader?: ReadLineInterface
  private activeJob?: ReplJob
  private readonly jobs = new Map<string, ReplJob>()
  private stderrTail: string[] = []
  private stderrFragment = ''
  private scratch?: string
  private disposed = false
  private request = 0

  constructor(
    sessionID: string,
    directory: string,
    options: RuntimeOptions,
    scriptDirectory: string
  ) {
    this.sessionId = sessionID
    this.directory = directory
    this.options = options
    this.scriptDirectory = scriptDirectory
  }

  private makeJob(id: string): ReplJob {
    const { promise: completion, resolve: complete } = Promise.withResolvers<void>()
    return {
      id,
      state: 'running',
      startedAt: Date.now(),
      completion,
      complete,
      cancelAcknowledged: false
    }
  }

  private snapshot(job: ReplJob, shouldIncludeResult = true): JobSnapshot {
    const snapshot: JobSnapshot = {
      id: job.id,
      state: job.state,
      startedAt: new Date(job.startedAt).toISOString(),
      ...(job.finishedAt !== undefined && { finishedAt: new Date(job.finishedAt).toISOString() })
    }
    if (
      shouldIncludeResult &&
      (job.state === 'completed' || job.state === 'cancelled') &&
      job.result
    ) {
      snapshot.output = job.result.output
      snapshot.attachments = job.result.attachments
    }

    if (job.state === 'failed' && job.error) {
      snapshot.error = job.error.message
    }

    return snapshot
  }

  private finishJob(
    job: ReplJob,
    state: 'completed' | 'failed' | 'cancelled',
    value?: Result | Error
  ) {
    if (job.finishedAt !== undefined) {
      return
    }

    if (state === 'failed') {
      job.error = value instanceof Error ? value : new Error('js_repl execution failed')
    } else if (value && !(value instanceof Error)) {
      job.result = value
    }

    job.state = state
    job.finishedAt = Date.now()
    if (job.cancelFallback) {
      clearTimeout(job.cancelFallback)
      job.cancelFallback = undefined
    }

    if (this.activeJob === job) {
      this.activeJob = undefined
    }

    job.complete()
    this.pruneJobs()
  }

  private pruneJobs() {
    let terminalCount = 0
    for (const job of this.jobs.values()) {
      if (job.finishedAt !== undefined) {
        terminalCount += 1
      }
    }

    if (terminalCount <= MAX_RETAINED_TERMINAL_JOBS) {
      return
    }

    for (const [id, job] of this.jobs) {
      if (job.finishedAt === undefined) {
        continue
      }

      this.jobs.delete(id)
      terminalCount -= 1
      if (terminalCount <= MAX_RETAINED_TERMINAL_JOBS) {
        return
      }
    }
  }

  private startJob(code: string): ReplJob {
    const job = this.makeJob(`repl_${++this.request}`)
    this.jobs.set(job.id, job)
    this.activeJob = job
    void (async () => {
      try {
        const child = await this.ensure()
        if (this.disposed || this.activeJob !== job) {
          await this.stop()
          return
        }

        if (job.state === 'cancelling') {
          this.finishJob(job, 'cancelled', { output: '', attachments: [] })
          return
        }

        child.stdin.write(
          `${JSON.stringify({ type: 'exec', id: job.id, code })}\n`,
          (error: unknown) => {
            if (error !== null && error !== undefined) {
              this.fail(
                child,
                new Error(`Failed to write to js_repl kernel: ${errorMessage(error)}`)
              )
            }
          }
        )
      } catch (error: unknown) {
        this.finishJob(job, 'failed', error instanceof Error ? error : new Error(String(error)))
      }
    })().catch((error: unknown) => {
      this.finishJob(job, 'failed', error instanceof Error ? error : new Error(String(error)))
    })
    return job
  }

  private async prepareKernel(node: string) {
    await ensureMeriyah(this.options)
    this.scratch ??= await mkdtemp(join(tmpdir(), 'opencode-js-repl-'))
    const { scratch } = this
    const source = await readFile(join(this.scriptDirectory, 'kernel.cjs'), 'utf8')
    const kernelPath = join(scratch, 'kernel.cjs')
    await writeFile(kernelPath, source)
    this.stderrTail = []
    this.stderrFragment = ''
    return { node, kernelPath, scratch }
  }

  private buildSpawnOptions(node: string, kernelPath: string): SpawnOptions {
    const moduleDirs = [
      ...optionStrings(this.options, 'nodeModuleDirs'),
      join(replCacheDirectory(this.options), 'node_modules'),
      join(playwrightCacheDirectory(this.options), 'node_modules')
    ]
    return {
      cwd: this.directory,
      env: {
        ...process.env,
        [envKey('NODE_PATH')]: [
          join(replCacheDirectory(this.options), 'node_modules'),
          process.env.NODE_PATH
        ]
          .filter(Boolean)
          .join(delimiter),
        [envKey('PLAYWRIGHT_BROWSERS_PATH')]: playwrightBrowserDirectory(this.options),
        [envKey('CAMOUFOX_INSTALL_DIR')]: join(
          playwrightCacheDirectory(this.options),
          CAMOUFOX_INSTALL_DIR_NAME
        ),
        [envKey('JS_REPL_INTERNAL_SESSION_ID')]: this.sessionId,
        [envKey('JS_REPL_INTERNAL_TMP_DIR')]: this.scratch,
        [envKey('JS_REPL_INTERNAL_MERIYAH_PATH')]: join(
          replCacheDirectory(this.options),
          '__opencode_js_repl__.cjs'
        ),
        [envKey('JS_REPL_INTERNAL_NODE_MODULE_DIRS')]: moduleDirs.join(delimiter),
        [envKey('JS_REPL_INTERNAL_SCRIPT_DIR')]: this.scriptDirectory
      },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'] as SpawnOptions['stdio']
    }
  }

  private async waitForSpawn(child: KernelProcess) {
    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onError)
        resolve()
      }

      const onError = (error: Error) => {
        child.off('spawn', onSpawn)
        reject(new Error(`Failed to start js_repl kernel: ${error.message}`))
      }

      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  private async ensure() {
    if (this.child && !hasChildExited(this.child)) {
      return this.child
    }

    const node = optionString(this.options, 'nodePath', 'node')
    await checkNode(node)
    const { kernelPath, scratch } = await this.prepareKernel(node)
    const child = spawn(
      node,
      ['--no-warnings', '--experimental-vm-modules', kernelPath],
      this.buildSpawnOptions(node, kernelPath)
    ) as KernelProcess
    await this.waitForSpawn(child)
    this.child = child
    // Ownership marker: lets the next service instance identify (and sweep)
    // scratch dirs left behind by dead services without ever touching a dir
    // whose owning service is still alive.
    await writeFile(
      join(scratch, 'owner.json'),
      JSON.stringify({
        servicePid: process.pid,
        kernelPid: child.pid,
        createdAt: new Date().toISOString()
      })
    ).catch(() => undefined)
    child.stdout.resume()
    this.reader = createInterface({ input: child.stdio[3], crlfDelay: Infinity })
    this.reader.on('line', (line) => {
      this.handleLine(child, line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.handleStderr(chunk)
    })
    child.once('close', (code, signal) => {
      this.handleClose(child, code ?? undefined, signal ?? undefined)
    })
    child.once('error', (error) => {
      this.fail(child, new Error(`js_repl kernel process error: ${error.message}`))
    })
    return child
  }

  private handleLine(child: KernelProcess, line: string) {
    if (child !== this.child) {
      return
    }

    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
      this.fail(child, new Error('js_repl kernel exceeded the protocol output limit'))
      return
    }

    let message: Message
    try {
      message = JSON.parse(line) as Message
    } catch {
      this.fail(child, new Error('js_repl kernel sent invalid JSON'))
      return
    }

    const job = this.jobs.get(message.id)
    if (!job) {
      return
    }

    if (message.type === 'cancel_ack') {
      this.handleCancelAcknowledgement(job)
      return
    }

    if (job.finishedAt !== undefined) {
      return
    }

    this.handleExecutionResult(job, message)
  }

  private handleCancelAcknowledgement(job: ReplJob) {
    job.cancelAcknowledged = true
    if (job.cancelFallback) {
      clearTimeout(job.cancelFallback)
      job.cancelFallback = undefined
    }
  }

  private handleExecutionResult(job: ReplJob, message: Extract<Message, { type: 'exec_result' }>) {
    if (message.status === 'failed') {
      this.handleExecutionFailure(job, message)
      return
    }

    try {
      const result = {
        output: typeof message.output === 'string' ? message.output : '',
        attachments: message.status === 'cancelled' ? [] : attachments(message.attachments)
      }
      this.finishJob(job, message.status, result)
    } catch (error) {
      void this.stop().finally(() => {
        this.finishJob(job, 'failed', error as Error)
      })
    }
  }

  private handleExecutionFailure(job: ReplJob, message: Extract<Message, { type: 'exec_result' }>) {
    // Logs captured before the failure are the most useful debugging evidence.
    const partial =
      typeof message.output === 'string' && message.output !== ''
        ? `\nOutput before failure:\n${boundedUtf8(message.output, 8192)}`
        : ''
    const error = new Error(`${message.error ?? 'js_repl execution failed'}${partial}`)
    if (message.error?.includes('kernel reset')) {
      void this.stop().finally(() => {
        this.finishJob(job, 'failed', error)
      })
      return
    }

    this.finishJob(job, 'failed', error)
  }

  private handleStderr(chunk: string) {
    this.stderrFragment += chunk
    const lines = this.stderrFragment.split(/\r?\n/v)
    this.stderrFragment = lines.pop() ?? ''
    for (const line of lines) {
      this.pushStderr(line)
    }
  }

  private pushStderr(line: string) {
    const bounded = boundedUtf8(line, 512)
    if (bounded === '') {
      return
    }

    this.stderrTail.push(bounded)
    while (this.stderrTail.length > 20 || Buffer.byteLength(this.stderrTail.join(' | ')) > 4096) {
      this.stderrTail.shift()
    }
  }

  private handleClose(
    child: KernelProcess,
    code: number | undefined,
    signal: NodeJS.Signals | undefined
  ) {
    if (child !== this.child) {
      return
    }

    if (this.stderrFragment !== '') {
      this.pushStderr(this.stderrFragment)
    }

    this.detach(child)
    const status = code === null ? `signal=${signal ?? 'unknown'}` : `code=${code}`
    const diagnostics = this.stderrTail.length > 0 ? `; stderr: ${this.stderrTail.join(' | ')}` : ''
    if (this.activeJob) {
      this.finishJob(
        this.activeJob,
        'failed',
        new Error(`js_repl kernel exited unexpectedly (${status})${diagnostics}`)
      )
    }
  }

  private fail(child: KernelProcess, error: Error) {
    if (child !== this.child) {
      return
    }

    const job = this.activeJob
    void this.stop().finally(() => {
      if (job) {
        this.finishJob(job, 'failed', error)
      }
    })
  }

  private detach(child: KernelProcess) {
    if (child !== this.child) {
      return
    }

    this.reader?.close()
    this.reader = undefined
    this.child = undefined
  }

  private async stop() {
    const { child } = this
    if (!child) {
      return
    }

    this.detach(child)
    if (hasChildExited(child)) {
      return
    }

    // Graceful first: closing stdin triggers the kernel's stdin "end" handler
    // so it can exit 0 and release browser/profile locks. SIGTERM is the next
    // step and SIGKILL only the last resort, so profile directories are not
    // left in a killed-process state.
    try {
      child.stdin.end()
    } catch {
      /*
      Stdin already closed
      */
    }

    if (await hasChildClosed(child, 1500)) {
      return
    }

    try {
      child.kill('SIGTERM')
    } catch {
      /*
      Already exited
      */
    }

    if (await hasChildClosed(child, 1500)) {
      return
    }

    try {
      child.kill('SIGKILL')
    } catch {
      /*
      Already exited
      */
    }

    await hasChildClosed(child, 2000)
  }

  // Remove the scratch directory, but only once Chromium is done with it: a
  // shutting-down browser can recreate profile files after the rm and leave a
  // partial user-data dir behind. The SingletonLock file is the browser's own
  // shutdown signal; brief retries absorb any remaining late writes.
  private async removeScratch() {
    const { scratch } = this
    if (scratch === undefined) {
      return
    }

    const lockPath = join(scratch, 'stealth', 'user-data', 'SingletonLock')
    const deadline = Date.now() + 2500
    const waitForLockRelease = async (): Promise<void> => {
      if (Date.now() >= deadline || !(await doesExist(lockPath))) {
        return
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100)
      })
      await waitForLockRelease()
    }

    await waitForLockRelease()

    const removeAttempt = async (attempt: number): Promise<void> => {
      if (!(attempt < 3 && (await doesExist(scratch)))) {
        return
      }

      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      if (attempt < 2) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 250)
        })
        await removeAttempt(attempt + 1)
      }
    }

    await removeAttempt(0)

    this.scratch = undefined
  }

  matchesDirectory(directory: string) {
    return this.directory === directory
  }

  async execute(code: string): Promise<ExecuteOutcome> {
    if (code.trim() === '') {
      throw new Error('code must contain JavaScript source')
    }

    if (this.disposed) {
      throw new Error('js_repl controller is disposed')
    }

    if (this.activeJob && ['running', 'cancelling'].includes(this.activeJob.state)) {
      return { kind: 'busy', job: this.snapshot(this.activeJob) }
    }

    const job = this.startJob(code)
    const handoff = Promise.withResolvers<'timeout'>()
    const handoffTimer = setTimeout(() => {
      handoff.resolve('timeout')
    }, FOREGROUND_WAIT_MS)
    const outcome = await Promise.race([
      job.completion.then(() => 'complete' as const),
      handoff.promise
    ])
    clearTimeout(handoffTimer)

    if (outcome === 'timeout') {
      return { kind: 'background', job: this.snapshot(job) }
    }

    if (job.state === 'completed') {
      return { kind: 'completed', result: job.result ?? { output: '', attachments: [] } }
    }

    if (job.state === 'cancelled') {
      throw new Error('JavaScript execution cancelled')
    }

    throw job.error ?? new Error('js_repl execution failed')
  }

  listJobs(): JobSnapshot[] {
    const jobs: ReplJob[] = []
    for (const job of this.jobs.values()) {
      jobs.push(job)
    }

    return jobs.toReversed().map((job) => this.snapshot(job, false))
  }

  getJob(id: string): JobSnapshot {
    const job = this.jobs.get(id)
    if (!job) {
      throw new Error(`Unknown js_repl job: ${id}`)
    }

    return this.snapshot(job)
  }

  async waitForJob(id: string): Promise<JobSnapshot> {
    const job = this.jobs.get(id)
    if (!job) {
      throw new Error(`Unknown js_repl job: ${id}`)
    }

    if (job.finishedAt === undefined) {
      const wait = Promise.withResolvers<void>()
      const waitTimer = setTimeout(wait.resolve, JOB_WAIT_MS)
      await Promise.race([job.completion, wait.promise])
      clearTimeout(waitTimer)
    }

    return this.snapshot(job)
  }

  async cancelJob(id: string): Promise<JobSnapshot> {
    const job = this.jobs.get(id)
    if (!job) {
      throw new Error(`Unknown js_repl job: ${id}`)
    }

    if (job.finishedAt !== undefined) {
      return this.snapshot(job)
    }

    if (job.state === 'running') {
      job.state = 'cancelling'
      const { child } = this
      if (child && this.activeJob === job) {
        child.stdin.write(`${JSON.stringify({ type: 'cancel', id: job.id })}\n`, (error) => {
          if (error) {
            this.fail(child, new Error(`Failed to write to js_repl kernel: ${error.message}`))
          }
        })
        job.cancelFallback = setTimeout(() => {
          if (
            !job.cancelAcknowledged &&
            this.activeJob === job &&
            ['running', 'cancelling'].includes(job.state)
          ) {
            child.kill('SIGINT')
          }
        }, CANCEL_ACK_WAIT_MS)
      }
    }

    return this.snapshot(job)
  }

  async dispose() {
    if (this.disposed) {
      return
    }

    this.disposed = true
    if (this.activeJob) {
      this.finishJob(this.activeJob, 'cancelled', this.activeJob.result)
    }

    await this.stop()
    await this.removeScratch()
  }

  // Graceful per-session teardown used when the OpenCode service is stopping.
  // Closing stdin lets the kernel exit 0; Playwright's own process-exit hooks
  // (inside the kernel) then close browsers and Electron apps in an orderly
  // way and delete their temporary profile dirs. Surviving kernels are killed
  // and the scratch directory (which also holds this session's stealth
  // profile) is removed either way.
  async disposeForShutdown() {
    this.disposed = true
    if (this.activeJob) {
      this.finishJob(this.activeJob, 'cancelled', this.activeJob.result)
    }

    const { child } = this
    if (child) {
      this.detach(child)
      await terminateChild(child)
    }

    await this.removeScratch()
  }
}

async function terminateChild(child: KernelProcess) {
  if (hasChildExited(child)) {
    return
  }

  try {
    child.stdin.end()
  } catch {
    /*
    Stdin already closed
    */
  }

  if (await hasChildClosed(child, 1200)) {
    return
  }

  try {
    child.kill('SIGKILL')
  } catch {
    /*
    Already exited
    */
  }

  await hasChildClosed(child, 1000)
}

async function hasChildClosed(child: KernelProcess, ms: number) {
  return new Promise<boolean>((resolve) => {
    if (hasChildExited(child)) {
      resolve(true)
      return
    }

    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolve(hasChildExited(child))
    }, ms)
    const onClose = () => {
      clearTimeout(timer)
      resolve(true)
    }

    child.once('close', onClose)
  })
}

function hasChildExited(child: KernelProcess) {
  return child.exitCode !== null || child.signalCode !== null
}

const SCRATCH_PREFIX = 'opencode-js-repl-'
const OWNERLESS_SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000
let isStaleSweepStarted = false

async function readOwnerPid(directory: string): Promise<number | undefined> {
  try {
    const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8')) as {
      servicePid?: number
    }
    return typeof owner.servicePid === 'number' ? owner.servicePid : undefined
  } catch {
    return undefined
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

async function didSweepOwnedDir(directory: string, removed: string[]) {
  const servicePid = await readOwnerPid(directory)
  if (servicePid === undefined) {
    return false
  }

  if (isProcessAlive(servicePid)) {
    return true
  }

  await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  removed.push(directory)
  return true
}

async function sweepOwnerlessDir(directory: string) {
  try {
    const info = await stat(directory)
    if (Date.now() - info.mtimeMs > OWNERLESS_SCRATCH_MAX_AGE_MS) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch {
    /*
    Already gone
    */
  }
}

async function sweepStaleScratchDirs() {
  if (isStaleSweepStarted) {
    return
  }

  isStaleSweepStarted = true
  let entries: string[]
  try {
    entries = await readdir(tmpdir())
  } catch {
    return
  }

  const removed: string[] = []
  const sweepEntry = async (index: number): Promise<void> => {
    if (index >= entries.length) {
      return
    }

    const entry = entries[index]
    if (!entry.startsWith(SCRATCH_PREFIX)) {
      await sweepEntry(index + 1)
      return
    }

    const directory = join(tmpdir(), entry)
    try {
      const info = await stat(directory)
      if (!info.isDirectory()) {
        await sweepEntry(index + 1)
        return
      }

      const isHandled = await didSweepOwnedDir(directory, removed)
      if (!isHandled) {
        await sweepOwnerlessDir(directory)
      }
    } catch {
      // Entry vanished or is unreadable; nothing to sweep.
    }

    await sweepEntry(index + 1)
  }

  await sweepEntry(0)

  if (removed.length === 0) {
    return
  }

  setTimeout(() => {
    for (const directory of removed) {
      rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 3000).unref()
}

type InstallConfig = {
  options: RuntimeOptions
  directory: string
  isForce: boolean
  environment: NodeJS.ProcessEnv
}

async function installPackages(config: InstallConfig) {
  const { options, directory, isForce, environment } = config
  const playwrightPackage = join(directory, 'node_modules', 'playwright', 'package.json')
  const playwrightCorePackage = join(directory, 'node_modules', 'playwright-core', 'package.json')
  const camoufoxPackage = join(directory, 'node_modules', CAMOUFOX_PACKAGE, 'package.json')
  const chromiumMarker = join(directory, `.chromium-${PLAYWRIGHT_VERSION}`)
  const camoufoxMarker = join(directory, `.camoufox-${CAMOUFOX_VERSION}`)
  const isPackageReady =
    (await isPackageMatch(playwrightPackage, 'playwright', PLAYWRIGHT_VERSION)) &&
    (await isPackageMatch(playwrightCorePackage, 'playwright-core', PLAYWRIGHT_VERSION)) &&
    (await isPackageMatch(camoufoxPackage, CAMOUFOX_PACKAGE, CAMOUFOX_VERSION))
  if (isForce || !isPackageReady) {
    await run(
      optionString(options, 'playwrightNpmPath', 'npm'),
      [
        'install',
        '--prefix',
        directory,
        `playwright@${PLAYWRIGHT_VERSION}`,
        `${CAMOUFOX_PACKAGE}@${CAMOUFOX_VERSION}`
      ],
      environment
    )
    await rm(chromiumMarker, { force: true })
    await rm(camoufoxMarker, { force: true })
  }

  const isAllReady =
    (await isPackageMatch(playwrightPackage, 'playwright', PLAYWRIGHT_VERSION)) &&
    (await isPackageMatch(playwrightCorePackage, 'playwright-core', PLAYWRIGHT_VERSION)) &&
    (await isPackageMatch(camoufoxPackage, CAMOUFOX_PACKAGE, CAMOUFOX_VERSION))
  if (!isAllReady) {
    throw new Error(
      `Playwright setup did not install playwright ${PLAYWRIGHT_VERSION} and ${CAMOUFOX_PACKAGE} ${CAMOUFOX_VERSION}`
    )
  }
}

async function installChromium(config: InstallConfig, browserDirectory: string) {
  const { options, directory, isForce, environment } = config
  const chromiumMarker = join(directory, `.chromium-${PLAYWRIGHT_VERSION}`)
  const isMarkerReady =
    !isForce &&
    (await doesExist(chromiumMarker)) &&
    (await isChromiumExecutablePresent(directory, browserDirectory))
  if (isMarkerReady) {
    return
  }

  await run(
    optionString(options, 'playwrightNpxPath', 'npx'),
    ['--prefix', directory, 'playwright', 'install', 'chromium'],
    environment
  )
  if (!(await isChromiumExecutablePresent(directory, browserDirectory))) {
    throw new Error(`Chromium executable is missing from ${browserDirectory} after installation`)
  }

  await writeFile(chromiumMarker, '')
}

async function installCamoufox(config: InstallConfig, camoufoxDirectory: string) {
  const { options, directory, isForce, environment } = config
  const camoufoxMarker = join(directory, `.camoufox-${CAMOUFOX_VERSION}`)
  const isMarkerReady =
    !isForce && (await doesExist(camoufoxMarker)) && (await isCamoufoxReady(camoufoxDirectory))
  if (isMarkerReady) {
    return
  }

  await run(
    optionString(options, 'playwrightNpxPath', 'npx'),
    ['--prefix', directory, CAMOUFOX_PACKAGE, 'fetch'],
    environment
  )
  if (!(await isCamoufoxReady(camoufoxDirectory))) {
    throw new Error(`Camoufox is missing from ${camoufoxDirectory} after installation`)
  }

  await writeFile(camoufoxMarker, '')
}

export class ReplRuntime {
  private readonly controllers = new Map<string, ReplController>()
  private disposed = false
  private readonly options: RuntimeOptions
  private readonly scriptDirectory: string

  constructor(options: RuntimeOptions, scriptDirectory: string) {
    this.options = options
    this.scriptDirectory = scriptDirectory
    sweepStaleScratchDirs().catch(() => undefined)
  }

  async execute(sessionID: string, directory: string, code: string) {
    if (this.disposed) {
      throw new Error('js_repl runtime is disposed')
    }

    let controller = this.controllers.get(sessionID)
    if (controller && !controller.matchesDirectory(directory)) {
      this.controllers.delete(sessionID)
      await controller.dispose()
      controller = undefined
    }

    if (!controller) {
      controller = new ReplController(sessionID, directory, this.options, this.scriptDirectory)
      this.controllers.set(sessionID, controller)
    }

    return controller.execute(code)
  }

  listJobs(sessionID: string): JobActionOutcome {
    return { kind: 'list', jobs: this.controllers.get(sessionID)?.listJobs() ?? [] }
  }

  getJob(sessionID: string, id: string): JobActionOutcome {
    const controller = this.controllers.get(sessionID)
    if (!controller) {
      throw new Error('JavaScript REPL kernel was not initialized.')
    }

    return { kind: 'job', job: controller.getJob(id) }
  }

  async waitForJob(sessionID: string, id: string): Promise<JobActionOutcome> {
    const controller = this.controllers.get(sessionID)
    if (!controller) {
      throw new Error('JavaScript REPL kernel was not initialized.')
    }

    return { kind: 'job', job: await controller.waitForJob(id) }
  }

  async cancelJob(sessionID: string, id: string): Promise<JobActionOutcome> {
    const controller = this.controllers.get(sessionID)
    if (!controller) {
      throw new Error('JavaScript REPL kernel was not initialized.')
    }

    return { kind: 'job', job: await controller.cancelJob(id) }
  }

  async reset(sessionID: string) {
    const controller = this.controllers.get(sessionID)
    if (!controller) {
      return false
    }

    this.controllers.delete(sessionID)
    await controller.dispose()
    return true
  }

  async dispose() {
    if (this.disposed) {
      return
    }

    this.disposed = true
    const disposals: Array<Promise<void>> = Array.from(
      this.controllers.values(),
      async (controller) => controller.disposeForShutdown()
    )
    this.controllers.clear()
    await Promise.allSettled(disposals)
  }

  async setupPlaywright(isForce = false) {
    const directory = playwrightCacheDirectory(this.options)
    const browserDirectory = playwrightBrowserDirectory(this.options)
    const camoufoxDirectory = join(directory, CAMOUFOX_INSTALL_DIR_NAME)
    const environment = {
      ...process.env,
      [envKey('PLAYWRIGHT_BROWSERS_PATH')]: browserDirectory,
      [envKey('CAMOUFOX_INSTALL_DIR')]: camoufoxDirectory
    }
    await mkdir(directory, { recursive: true })
    await withCacheLock(join(directory, '.playwright-setup'), async () => {
      const config: InstallConfig = { options: this.options, directory, isForce, environment }
      await installPackages(config)
      await installChromium(config, browserDirectory)
      await installCamoufox(config, camoufoxDirectory)
    })
    return `Shared Playwright ${PLAYWRIGHT_VERSION}, Camoufox ${CAMOUFOX_VERSION} and their browsers are ready at ${directory}.`
  }
}
