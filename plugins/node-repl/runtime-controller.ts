import { ReplControllerCore } from './runtime-controller-core.ts'
import { formatCancellationState, formatExecutionFailure, type ReplJob } from './runtime-job.ts'
import type { ExecuteOutcome, JobSnapshot } from './runtime-types.ts'

const FOREGROUND_WAIT_MS = 35_000
const JOB_WAIT_MS = 5000
const CANCEL_COOPERATIVE_WAIT_MS = 2000
const CANCEL_FORCE_WAIT_MS = 5000

export class ReplController extends ReplControllerCore {
  private busyOutcome(): ExecuteOutcome | undefined {
    const { activeJob } = this
    if (!activeJob) {
      return undefined
    }

    if (!['running', 'cancelling'].includes(activeJob.state)) {
      return undefined
    }

    return { kind: 'busy', job: this.snapshot(activeJob) }
  }

  private async waitForForeground(job: ReplJob) {
    const handoff = Promise.withResolvers<'timeout'>()
    const handoffTimer = setTimeout(() => {
      handoff.resolve('timeout')
    }, FOREGROUND_WAIT_MS)
    const outcome = await Promise.race([
      job.completion.then(() => 'complete' as const),
      handoff.promise
    ])
    clearTimeout(handoffTimer)
    return outcome
  }

  private finishedOutcome(job: ReplJob): ExecuteOutcome {
    if (job.state === 'completed') {
      return {
        kind: 'completed',
        result: job.result ?? { output: '', attachments: [] },
        kernelRestarted: job.kernelRestarted
      }
    }

    if (job.state === 'cancelled') {
      throw new Error(`JavaScript execution cancelled. ${formatCancellationState(job)}`)
    }

    throw formatExecutionFailure(job)
  }

  private forceCancelJob(job: ReplJob) {
    if (this.activeJob !== job || job.state !== 'cancelling') {
      return
    }

    job.kernelState = 'terminated'
    void this.kernel.stop().finally(() => {
      this.finishJob(job, 'cancelled', { output: '', attachments: [] })
    })
  }

  private scheduleCancelFallback(job: ReplJob) {
    job.cancelFallback = setTimeout(() => {
      if (this.activeJob !== job || job.state !== 'cancelling') {
        return
      }

      job.cancelFallback = setTimeout(() => {
        this.forceCancelJob(job)
      }, CANCEL_FORCE_WAIT_MS)
    }, CANCEL_COOPERATIVE_WAIT_MS)
  }

  private cancelRunningJob(job: ReplJob) {
    job.state = 'cancelling'
    if (this.activeJob === job && this.kernel.cancel(job.id)) {
      this.scheduleCancelFallback(job)
    }
  }

  async execute(code: string): Promise<ExecuteOutcome> {
    this.assertCanExecute(code)
    const busy = this.busyOutcome()
    if (busy) {
      return busy
    }

    const job = this.startJob(code)
    const outcome = await this.waitForForeground(job)

    if (outcome === 'timeout') {
      return { kind: 'background', job: this.snapshot(job) }
    }

    return this.finishedOutcome(job)
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
      this.cancelRunningJob(job)
    }

    return this.snapshot(job)
  }

  async dispose(isShutdown = false) {
    if (this.disposed) {
      return
    }

    this.disposed = true
    if (this.activeJob) {
      this.activeJob.kernelState = 'terminated'
      this.finishJob(this.activeJob, 'cancelled', this.activeJob.result)
    }

    await this.kernel.dispose(isShutdown)
  }
}
