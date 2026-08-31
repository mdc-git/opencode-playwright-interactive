import { Buffer } from 'node:buffer'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  boundedUtf8,
  doesExist,
  hasChildClosed,
  hasChildExited,
  terminateChild
} from './runtime-process.ts'
import { KernelControllerBase } from './runtime-kernel-base.ts'
import type { KernelMessage, KernelProcess } from './runtime-types.ts'

const MAX_PROTOCOL_LINE_BYTES = 32 * 1024 * 1024

type KernelRequest = { type: 'exec'; id: string; code: string } | { type: 'cancel'; id: string }

function unexpectedExitError(
  code: number | undefined,
  signal: NodeJS.Signals | undefined,
  stderrTail: string[]
) {
  const status = code === null ? `signal=${signal ?? 'unknown'}` : `code=${code}`
  const diagnostics = stderrTail.length > 0 ? `; stderr: ${stderrTail.join(' | ')}` : ''
  return new Error(`node_repl kernel exited unexpectedly (${status})${diagnostics}`)
}

function closeChildStdin(child: KernelProcess) {
  try {
    child.stdin.end()
  } catch {
    /*
    Stdin already closed
    */
  }
}

function signalChild(child: KernelProcess, signal: NodeJS.Signals) {
  try {
    child.kill(signal)
  } catch {
    /*
    Already exited
    */
  }
}

async function gracefullyStopChild(child: KernelProcess) {
  if (hasChildExited(child)) {
    return
  }

  closeChildStdin(child)
  if (await hasChildClosed(child, 1500)) {
    return
  }

  signalChild(child, 'SIGTERM')
  if (await hasChildClosed(child, 1500)) {
    return
  }

  signalChild(child, 'SIGKILL')
  await hasChildClosed(child, 2000)
}

export class KernelController extends KernelControllerBase {
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

  private write(child: KernelProcess, message: KernelRequest) {
    child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        this.handleKernelWriteError(child, error)
      }
    })
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

  private async stopChild(terminate: (child: KernelProcess) => Promise<void>) {
    if (this.stopping) {
      await this.stopping
      return
    }

    const { child } = this
    if (!child) {
      return
    }

    this.detach(child)
    const stopping = terminate(child)
    this.stopping = stopping
    try {
      await stopping
    } finally {
      if (this.stopping === stopping) {
        this.stopping = undefined
      }
    }
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

  protected handleLine(child: KernelProcess, line: string) {
    const message = this.parseKernelLine(child, line)
    if (message !== undefined) {
      this.callbacks.onMessage(message)
    }
  }

  protected handleKernelWriteError(child: KernelProcess, error: unknown) {
    if (child === this.child) {
      this.callbacks.onWriteError(error)
    }
  }

  protected handleStderr(chunk: string) {
    this.stderrFragment += chunk
    const lines = this.stderrFragment.split(/\r?\n/v)
    this.stderrFragment = lines.pop() ?? ''
    for (const line of lines) {
      this.pushStderr(line)
    }
  }

  protected handleClose(
    child: KernelProcess,
    code: number | undefined,
    signal: NodeJS.Signals | undefined
  ) {
    if (child !== this.child) {
      return
    }

    this.flushStderr()
    this.detach(child)
    this.callbacks.onClose(unexpectedExitError(code, signal, this.stderrTail))
  }

  protected fail(child: KernelProcess, error: Error) {
    if (child !== this.child) {
      return
    }

    this.callbacks.onFailure(error)
  }

  protected async waitForStartup() {
    const startup = this.starting
    if (startup) {
      await startup.catch(() => undefined)
    }
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

  writeExecution(child: KernelProcess, id: string, code: string) {
    this.write(child, { type: 'exec', id, code })
  }

  writeCancellation(id: string) {
    const { child } = this
    if (!child) {
      return false
    }

    this.write(child, { type: 'cancel', id })
    return true
  }

  async stop() {
    return this.stopChild(gracefullyStopChild)
  }

  async dispose() {
    await this.waitForStartup()
    await this.stop()
    await this.removeScratch()
  }

  async disposeForShutdown() {
    await this.waitForStartup()
    await this.stopChild(terminateChild)
    await this.removeScratch()
  }
}
