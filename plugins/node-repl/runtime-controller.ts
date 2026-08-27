import { Buffer } from 'node:buffer'
import { spawn, type SpawnOptions } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'
import {
  optionString,
  optionStrings,
  playwrightBrowserDirectory,
  playwrightCacheDirectory,
  replCacheDirectory
} from './runtime-cache.ts'
import {
  boundedUtf8,
  checkNode,
  doesExist,
  errorMessage,
  hasChildClosed,
  hasChildExited,
  terminateChild
} from './runtime-process.ts'
import { attachments } from './runtime-protocol.ts'
import type {
  Attachment,
  ExecuteOutcome,
  JobSnapshot,
  JobState,
  KernelMessage,
  KernelProcess,
  Result,
  RuntimeOptions,
  SessionId,
  WorkspaceDirectory
} from './runtime-types.ts'

const envKey = <const K extends string>(key: K): K => key

const FOREGROUND_WAIT_MS = 35_000
const JOB_WAIT_MS = 5000
const CANCEL_INTERRUPT_WAIT_MS = 250
const CANCEL_RESTART_WAIT_MS = 1500
const MAX_RETAINED_TERMINAL_JOBS = 20
const MAX_PROTOCOL_LINE_BYTES = 32 * 1024 * 1024

type ReplJob = {
  id: string
  state: JobState
  startedAt: number
  finishedAt?: number
  result?: Result
  error?: Error
  completion: Promise<void>
  complete(): void
  cancelFallback?: NodeJS.Timeout
}

export class ReplController {
  private readonly sessionId: SessionId
  private readonly directory: WorkspaceDirectory
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
    sessionID: SessionId,
    directory: WorkspaceDirectory,
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
      complete
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
      job.error = value instanceof Error ? value : new Error('node_repl execution failed')
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
                new Error(`Failed to write to node_repl kernel: ${errorMessage(error)}`)
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
    this.scratch ??= await mkdtemp(join(tmpdir(), 'opencode-node-repl-'))
    const { scratch } = this
    const source = await readFile(join(this.scriptDirectory, 'kernel.cjs'), 'utf8')
    const kernelPath = join(scratch, 'kernel.cjs')
    await writeFile(kernelPath, source)
    this.stderrTail = []
    this.stderrFragment = ''
    return { node, kernelPath, scratch }
  }

  private buildSpawnOptions(kernelPath: string): SpawnOptions {
    const moduleDirs = [
      ...optionStrings(this.options, 'nodeModuleDirs'),
      join(replCacheDirectory(this.options), 'node_modules'),
      join(playwrightCacheDirectory(this.options), 'node_modules')
    ]
    const nodePath = [...moduleDirs, ...(process.env.NODE_PATH?.split(delimiter) ?? [])]
      .filter(Boolean)
      .join(delimiter)
    return {
      cwd: this.directory,
      env: {
        ...process.env,
        [envKey('NODE_PATH')]: nodePath,
        [envKey('PLAYWRIGHT_BROWSERS_PATH')]: playwrightBrowserDirectory(this.options),
        [envKey('CAMOUFOX_INSTALL_DIR')]: join(playwrightCacheDirectory(this.options), 'camoufox'),
        [envKey('NODE_REPL_INTERNAL_SESSION_ID')]: this.sessionId,
        [envKey('NODE_REPL_INTERNAL_TMP_DIR')]: this.scratch,
        [envKey('NODE_REPL_INTERNAL_SCRIPT_DIR')]: this.scriptDirectory
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
        reject(new Error(`Failed to start node_repl kernel: ${error.message}`))
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
      ['--no-warnings', kernelPath],
      this.buildSpawnOptions(kernelPath)
    ) as KernelProcess
    await this.waitForSpawn(child)
    this.child = child
    // Ownership marker: lets the next service instance identify and sweep
    // scratch dirs left behind by dead services without touching live ones.
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
      this.fail(child, new Error(`node_repl kernel process error: ${error.message}`))
    })
    return child
  }

  private handleLine(child: KernelProcess, line: string) {
    if (child !== this.child) {
      return
    }

    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
      this.fail(child, new Error('node_repl kernel exceeded the protocol output limit'))
      return
    }

    let message: KernelMessage
    try {
      message = JSON.parse(line) as KernelMessage
    } catch {
      this.fail(child, new Error('node_repl kernel sent invalid JSON'))
      return
    }

    const job = this.jobs.get(message.id)
    if (!job) {
      return
    }

    if (message.type === 'cancel_ack') {
      return
    }

    if (job.finishedAt !== undefined) {
      return
    }

    this.handleExecutionResult(job, message)
  }

  private handleExecutionResult(
    job: ReplJob,
    message: Extract<KernelMessage, { type: 'exec_result' }>
  ) {
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

  private handleExecutionFailure(
    job: ReplJob,
    message: Extract<KernelMessage, { type: 'exec_result' }>
  ) {
    // Logs captured before the failure are the most useful debugging evidence.
    const partial =
      typeof message.output === 'string' && message.output !== ''
        ? `\nOutput before failure:\n${boundedUtf8(message.output, 8192)}`
        : ''
    const error = new Error(`${message.error ?? 'node_repl execution failed'}${partial}`)
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
      if (this.activeJob.state === 'cancelling') {
        this.finishJob(this.activeJob, 'cancelled', { output: '', attachments: [] })
      } else {
        this.finishJob(
          this.activeJob,
          'failed',
          new Error(`node_repl kernel exited unexpectedly (${status})${diagnostics}`)
        )
      }
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

    // Graceful first: closing stdin lets the kernel release browser/profile
    // locks before escalation becomes necessary.
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

  // Remove the scratch directory only after Chromium releases its profile lock.
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

  matchesDirectory(directory: WorkspaceDirectory) {
    return this.directory === directory
  }

  async execute(code: string): Promise<ExecuteOutcome> {
    if (code.trim() === '') {
      throw new Error('code must contain JavaScript source')
    }

    if (this.disposed) {
      throw new Error('node_repl controller is disposed')
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

    throw job.error ?? new Error('node_repl execution failed')
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
      throw new Error(`Unknown node_repl job: ${id}`)
    }

    return this.snapshot(job)
  }

  async waitForJob(id: string): Promise<JobSnapshot> {
    const job = this.jobs.get(id)
    if (!job) {
      throw new Error(`Unknown node_repl job: ${id}`)
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
      throw new Error(`Unknown node_repl job: ${id}`)
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
            this.fail(child, new Error(`Failed to write to node_repl kernel: ${error.message}`))
          }
        })
        job.cancelFallback = setTimeout(() => {
          if (this.activeJob !== job || job.state !== 'cancelling') {
            return
          }

          child.kill('SIGINT')
          job.cancelFallback = setTimeout(() => {
            if (this.activeJob !== job || job.state !== 'cancelling') {
              return
            }

            void this.stop().finally(() => {
              this.finishJob(job, 'cancelled', { output: '', attachments: [] })
            })
          }, CANCEL_RESTART_WAIT_MS)
        }, CANCEL_INTERRUPT_WAIT_MS)
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
