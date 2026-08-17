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
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
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
type Pending = { id: string; resolve(result: Result): void; reject(error: Error): void }
type KernelProcess = ChildProcessWithoutNullStreams & {
  stdio: [
    NodeJS.WritableStream,
    NodeJS.ReadableStream,
    NodeJS.ReadableStream,
    NodeJS.ReadableStream
  ]
}
type Message = {
  type: 'exec_result'
  id: string
  ok: boolean
  output?: string
  attachments?: unknown
  error?: string | undefined
}

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
  private pending?: Pending
  private queue: Promise<void> = Promise.resolve()
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

  private async enqueue<T>(operation: () => Promise<T>) {
    const result = this.queue.then(operation).catch(operation)
    this.queue = result.then(() => undefined).catch(() => undefined)
    return result
  }

  private async executeNow(code: string, timeoutMs: number) {
    if (this.disposed) {
      throw new Error('js_repl controller is disposed')
    }

    const child = await this.ensure()
    const id = `${this.sessionId}-${++this.request}`
    return this.execOn(child, id, code, timeoutMs)
  }

  private async execOn(child: KernelProcess, id: string, code: string, timeoutMs: number) {
    return new Promise<Result>((resolve, reject) => {
      let isSettled = false
      const finish = (error?: Error, result?: Result) => {
        if (isSettled) {
          return
        }

        isSettled = true
        clearTimeout(timer)
        if (this.pending?.id === id) {
          this.pending = undefined
        }

        if (error) {
          reject(error)
        } else {
          resolve(result ?? { output: '', attachments: [] })
        }
      }

      const abandon = (error: Error) => {
        if (isSettled) {
          return
        }

        if (this.pending?.id === id) {
          this.pending = undefined
        }

        finish(error)
      }

      const timer = setTimeout(() => {
        abandon(
          new Error(
            'js_repl execution timed out; kernel continues running and later calls will wait behind it'
          )
        )
      }, timeoutMs)
      this.pending = {
        id,
        resolve(result) {
          finish(undefined, result)
        },
        reject(error) {
          finish(error)
        }
      }
      child.stdin.write(`${JSON.stringify({ type: 'exec', id, code })}\n`, (error) => {
        if (error) {
          this.fail(child, new Error(`Failed to write to js_repl kernel: ${error.message}`))
        }
      })
    })
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
    if (this.child && !this.child.killed && this.child.exitCode === null) {
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

    if (message.type !== 'exec_result' || message.id !== this.pending?.id) {
      return
    }

    const { pending } = this
    this.pending = undefined
    this.processExecResult(pending, message)
  }

  private processExecResult(pending: Pending, message: Message) {
    if (!message.ok) {
      // Logs captured before the failure are the most useful debugging
      // evidence; surface a bounded excerpt with the error.
      const partial =
        typeof message.output === 'string' && message.output !== ''
          ? `\nOutput before failure:\n${boundedUtf8(message.output, 8192)}`
          : ''
      const error = new Error(`${message.error ?? 'js_repl execution failed'}${partial}`)
      if (message.error?.includes('kernel reset')) {
        void this.stop().finally(() => {
          pending.reject(error)
        })
      } else {
        pending.reject(error)
      }

      return
    }

    try {
      pending.resolve({
        output: typeof message.output === 'string' ? message.output : '',
        attachments: attachments(message.attachments)
      })
    } catch (error) {
      void this.stop().finally(() => {
        pending.reject(error as Error)
      })
    }
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
    const { pending } = this
    this.pending = undefined
    pending?.reject(new Error(`js_repl kernel exited unexpectedly (${status})${diagnostics}`))
  }

  private fail(child: KernelProcess, error: Error) {
    if (child !== this.child) {
      return
    }

    const { pending } = this
    this.pending = undefined
    void this.stop().finally(() => pending?.reject(error))
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
    if (child.exitCode !== null || child.killed) {
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

  async execute(code: string, timeoutMs: number | undefined) {
    if (code.trim() === '') {
      throw new Error('code must contain JavaScript source')
    }

    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS
    return this.enqueue(async () => this.executeNow(code, timeout))
  }

  async dispose() {
    if (this.disposed) {
      return
    }

    this.disposed = true
    const { pending } = this
    this.pending = undefined
    pending?.reject(new Error('js_repl controller disposed'))
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
    const { pending } = this
    this.pending = undefined
    pending?.reject(new Error('js_repl controller disposed'))
    const { child } = this
    if (child) {
      this.detach(child)
      await terminateChild(child)
    }

    await this.removeScratch()
  }
}

async function terminateChild(child: KernelProcess) {
  if (child.exitCode !== null || child.killed) {
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
    if (child.exitCode !== null) {
      resolve(true)
      return
    }

    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolve(child.exitCode !== null)
    }, ms)
    const onClose = () => {
      clearTimeout(timer)
      resolve(true)
    }

    child.once('close', onClose)
  })
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

  async execute(
    sessionID: string,
    directory: string,
    code: string,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ) {
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

    return controller.execute(code, timeoutMs)
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

export const limits = {
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: MAX_TIMEOUT_MS
} as const
