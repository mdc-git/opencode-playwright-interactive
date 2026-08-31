import { KernelController } from './runtime-kernel.ts'
import {
  asExecutionError,
  clearCancelFallback,
  createReplJob,
  executionFailureError,
  executionResult,
  markCancelledJob,
  MAX_RETAINED_TERMINAL_JOBS,
  setJobOutcome,
  snapshotError,
  snapshotFinishedAt,
  snapshotResult,
  type ReplJob
} from './runtime-job.ts'
import { errorMessage } from './runtime-process.ts'
import type {
  JobSnapshot,
  KernelMessage,
  Result,
  RuntimeOptions,
  SessionId,
  WorkspaceDirectory
} from './runtime-types.ts'

export class ReplControllerCore {
  private request = 0
  protected readonly directory: WorkspaceDirectory
  protected readonly kernel: KernelController
  protected activeJob?: ReplJob
  protected readonly jobs = new Map<string, ReplJob>()
  protected disposed = false

  constructor(
    sessionID: SessionId,
    directory: WorkspaceDirectory,
    options: RuntimeOptions,
    scriptDirectory: string
  ) {
    this.directory = directory
    this.kernel = new KernelController({
      sessionId: sessionID,
      directory,
      options,
      scriptDirectory,
      callbacks: {
        onMessage: (message) => {
          this.handleKernelMessage(message)
        },
        onWriteError: (error) => {
          this.handleKernelWriteError(error)
        },
        onFailure: (error) => {
          this.handleKernelFailure(error)
        },
        onClose: (error) => {
          this.handleKernelClose(error)
        }
      }
    })
  }

  private pruneJobs() {
    const terminalJobs = [...this.jobs].filter(([, job]) => job.finishedAt !== undefined)
    const excessCount = terminalJobs.length - MAX_RETAINED_TERMINAL_JOBS
    if (excessCount <= 0) {
      return
    }

    for (const [id] of terminalJobs.slice(0, excessCount)) {
      this.jobs.delete(id)
    }
  }

  private async runJob(code: string, job: ReplJob) {
    const { child, wasRestarted } = await this.kernel.awaitStartup()
    job.kernelRestarted = wasRestarted
    if (this.disposed || this.activeJob !== job) {
      await this.kernel.stop()
      return
    }

    if (job.state === 'cancelling') {
      job.kernelState = 'preserved'
      this.finishJob(job, 'cancelled', { output: '', attachments: [] })
      return
    }

    this.kernel.writeExecution(child, job.id, code)
  }

  private handleKernelMessage(message: KernelMessage) {
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
      const result = executionResult(message)
      markCancelledJob(job, message)
      this.finishJob(job, message.status, result)
    } catch (error) {
      job.kernelState = 'terminated'
      void this.kernel.stop().finally(() => {
        this.finishJob(job, 'failed', error as Error)
      })
    }
  }

  private handleExecutionFailure(
    job: ReplJob,
    message: Extract<KernelMessage, { type: 'exec_result' }>
  ) {
    const error = executionFailureError(message)
    if (message.error?.includes('kernel reset')) {
      job.kernelState = 'terminated'
      void this.kernel.stop().finally(() => {
        this.finishJob(job, 'failed', error)
      })
      return
    }

    this.finishJob(job, 'failed', error)
  }

  private handleKernelWriteError(error: unknown) {
    const job = this.activeJob
    if (job?.state === 'cancelling') {
      job.kernelState = 'terminated'
      void this.kernel.stop().finally(() => {
        this.finishJob(job, 'cancelled', { output: '', attachments: [] })
      })
      return
    }

    this.handleKernelFailure(
      new Error(`Failed to write to node_repl kernel: ${errorMessage(error)}`)
    )
  }

  private handleKernelClose(error: Error) {
    const job = this.activeJob
    if (!job) {
      return
    }

    job.kernelState = 'terminated'
    if (job.state === 'cancelling') {
      this.finishJob(job, 'cancelled', { output: '', attachments: [] })
      return
    }

    this.finishJob(job, 'failed', error)
  }

  private handleKernelFailure(error: Error) {
    const job = this.activeJob
    if (job) {
      job.kernelState = 'terminated'
    }

    void this.kernel.stop().finally(() => {
      if (job) {
        this.finishJob(job, 'failed', error)
      }
    })
  }

  protected snapshot(job: ReplJob, shouldIncludeResult = true): JobSnapshot {
    return {
      id: job.id,
      state: job.state,
      startedAt: new Date(job.startedAt).toISOString(),
      ...snapshotFinishedAt(job),
      ...snapshotResult(job, shouldIncludeResult),
      ...snapshotError(job),
      kernelState: job.kernelState,
      kernelRestarted: job.kernelRestarted
    }
  }

  protected finishJob(
    job: ReplJob,
    state: 'completed' | 'failed' | 'cancelled',
    value?: Result | Error
  ) {
    if (job.finishedAt !== undefined) {
      return
    }

    setJobOutcome(job, state, value)
    job.state = state
    job.finishedAt = Date.now()
    clearCancelFallback(job)

    if (this.activeJob === job) {
      this.activeJob = undefined
    }

    job.complete()
    this.pruneJobs()
  }

  protected startJob(code: string): ReplJob {
    const job = createReplJob(`repl_${++this.request}`)
    this.jobs.set(job.id, job)
    this.activeJob = job
    void this.runJob(code, job).catch((error: unknown) => {
      this.finishJob(job, 'failed', asExecutionError(error))
    })
    return job
  }

  protected assertCanExecute(code: string) {
    if (code.trim() === '') {
      throw new Error('code must contain JavaScript source')
    }

    if (this.disposed) {
      throw new Error('node_repl controller is disposed')
    }
  }
}
