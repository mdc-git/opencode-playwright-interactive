import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'
import { boundedUtf8, doesExist, hasChildExited, terminateChild } from './runtime-process.ts'
import { gracefullyStopChild, startKernel } from './runtime-kernel-start.ts'
import type {
  KernelMessage,
  KernelProcess,
  RuntimeOptions,
  SessionId,
  WorkspaceDirectory
} from './runtime-types.ts'

const MAX_PROTOCOL_LINE_BYTES = 32 * 1024 * 1024

type KernelRequest = { type: 'exec'; id: string; code: string } | { type: 'cancel'; id: string }

type KernelControllerOptions = {
  sessionId: SessionId
  directory: WorkspaceDirectory
  options: RuntimeOptions
  scriptDirectory: string
  callbacks: {
    onMessage: (message: KernelMessage) => void
    onWriteError: (error: unknown) => void
    onFailure: (error: Error) => void
    onClose: (error: Error) => void
  }
}

type KernelStartup = { child: KernelProcess; wasRestarted: boolean }

function unexpectedExitError(
  code: number | undefined,
  signal: NodeJS.Signals | undefined,
  stderrTail: string[]
) {
  const status = code === null ? `signal=${signal ?? 'unknown'}` : `code=${code}`
  const diagnostics = stderrTail.length > 0 ? `; stderr: ${stderrTail.join(' | ')}` : ''
  return new Error(`node_repl kernel exited unexpectedly (${status})${diagnostics}`)
}

export class KernelController {
  private readonly config: KernelControllerOptions
  private child?: KernelProcess
  private reader?: ReadLineInterface
  private stderrTail: string[] = []
  private stderrFragment = ''
  private scratch?: string
  private kernelGeneration = 0
  private stopping?: Promise<void>
  private starting?: Promise<KernelStartup>

  constructor(config: KernelControllerOptions) {
    this.config = config
  }

  private async ensure(): Promise<KernelStartup> {
    if (this.child && !hasChildExited(this.child)) {
      return { child: this.child, wasRestarted: false }
    }

    const scratch = this.scratch ?? (await mkdtemp(join(tmpdir(), 'opencode-node-repl-')))
    this.scratch = scratch
    const child = await startKernel({
      sessionId: this.config.sessionId,
      directory: this.config.directory,
      options: this.config.options,
      scriptDirectory: this.config.scriptDirectory,
      scratch
    })
    const wasRestarted = this.kernelGeneration > 0
    this.stderrTail = []
    this.stderrFragment = ''
    this.kernelGeneration += 1
    this.child = child
    child.stdout.resume()
    this.reader = createInterface({ input: child.stdio[3], crlfDelay: Infinity })
    this.reader.on('line', (line) => {
      this.handleLine(child, line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.handleStderr(chunk)
    })
    child.stdin.on('error', (error) => {
      this.handleKernelWriteError(child, error)
    })
    child.once('close', (code, signal) => {
      this.handleClose(child, code ?? undefined, signal ?? undefined)
    })
    child.once('error', (error) => {
      this.fail(child, new Error(`node_repl kernel process error: ${error.message}`))
    })
    return { child, wasRestarted }
  }

  private parseKernelLine(child: KernelProcess, line: string) {
    if (child !== this.child) {
      return
    }

    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
      this.fail(child, new Error('node_repl kernel exceeded the protocol output limit'))
      return
    }

    try {
      return JSON.parse(line) as KernelMessage
    } catch {
      this.fail(child, new Error('node_repl kernel sent invalid JSON'))
      return undefined
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

  private flushStderr() {
    if (this.stderrFragment !== '') {
      this.pushStderr(this.stderrFragment)
    }
  }

  private detach(child: KernelProcess) {
    if (child !== this.child) {
      return
    }

    this.reader?.close()
    this.reader = undefined
    this.child = undefined
  }

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

  private handleLine(child: KernelProcess, line: string) {
    const message = this.parseKernelLine(child, line)
    if (message !== undefined) {
      this.config.callbacks.onMessage(message)
    }
  }

  private handleKernelWriteError(child: KernelProcess, error: unknown) {
    if (child === this.child) {
      this.config.callbacks.onWriteError(error)
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

  private handleClose(
    child: KernelProcess,
    code: number | undefined,
    signal: NodeJS.Signals | undefined
  ) {
    if (child !== this.child) {
      return
    }

    this.flushStderr()
    this.detach(child)
    this.config.callbacks.onClose(unexpectedExitError(code, signal, this.stderrTail))
  }

  private fail(child: KernelProcess, error: Error) {
    if (child !== this.child) {
      return
    }

    this.config.callbacks.onFailure(error)
  }

  send(child: KernelProcess, message: KernelRequest) {
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        this.handleKernelWriteError(child, error)
      }
    })
  }

  async stop(isShutdown = false) {
    const { child } = this
    if (!child) {
      return this.stopping
    }

    this.detach(child)
    const stopping = (isShutdown ? terminateChild : gracefullyStopChild)(child)
    this.stopping = stopping
    await stopping.finally(() => {
      this.stopping = undefined
    })
  }

  async awaitStartup() {
    const startup = this.ensure()
    this.starting = startup
    try {
      return await startup
    } finally {
      if (this.starting === startup) {
        this.starting = undefined
      }
    }
  }

  cancel(id: string) {
    const { child } = this
    if (!child) {
      return false
    }

    this.send(child, { type: 'cancel', id })
    return true
  }

  async dispose(isShutdown = false) {
    if (this.starting) {
      await this.starting.catch(() => undefined)
    }

    await this.stop(isShutdown)
    await this.removeScratch()
  }
}
