import { boundedUtf8 } from './runtime-process.ts'
import { attachments } from './runtime-protocol.ts'
import type { JobSnapshot, JobState, KernelMessage, KernelState, Result } from './runtime-types.ts'

export const MAX_RETAINED_TERMINAL_JOBS = 20

export type ReplJob = {
  id: string
  state: JobState
  startedAt: number
  finishedAt?: number
  result?: Result
  error?: Error
  kernelState?: KernelState
  kernelRestarted?: boolean
  completion: Promise<void>
  complete(): void
  cancelFallback?: NodeJS.Timeout
}

export function createReplJob(id: string): ReplJob {
  const { promise: completion, resolve: complete } = Promise.withResolvers<void>()
  return {
    id,
    state: 'running',
    startedAt: Date.now(),
    completion,
    complete
  }
}

export function snapshotFinishedAt(job: ReplJob) {
  return job.finishedAt === undefined ? {} : { finishedAt: new Date(job.finishedAt).toISOString() }
}

export function snapshotResult(job: ReplJob, shouldIncludeResult: boolean) {
  return shouldIncludeResult &&
    ['completed', 'cancelled'].includes(job.state) &&
    job.result !== undefined
    ? { output: job.result.output, attachments: job.result.attachments }
    : {}
}

export function snapshotError(job: ReplJob) {
  return job.state === 'failed' && job.error ? { error: job.error.message } : {}
}

export function setJobOutcome(
  job: ReplJob,
  state: 'completed' | 'failed' | 'cancelled',
  value?: Result | Error
) {
  if (state === 'failed') {
    job.error = value instanceof Error ? value : new Error('node_repl execution failed')
    return
  }

  setJobResult(job, value)
}

function setJobResult(job: ReplJob, value?: Result | Error) {
  if (value && !(value instanceof Error)) {
    job.result = value
  }
}

export function clearCancelFallback(job: ReplJob) {
  if (!job.cancelFallback) {
    return
  }

  clearTimeout(job.cancelFallback)
  job.cancelFallback = undefined
}

export function executionResult(message: Extract<KernelMessage, { type: 'exec_result' }>): Result {
  return {
    output: typeof message.output === 'string' ? message.output : '',
    attachments: message.status === 'cancelled' ? [] : attachments(message.attachments)
  }
}

function partialFailureOutput(output: unknown) {
  if (typeof output !== 'string' || output === '') {
    return ''
  }

  return `\nOutput before failure:\n${boundedUtf8(output, 8192)}`
}

function redeclarationHint(error: string | undefined) {
  if (!error?.includes('has already been declared')) {
    return ''
  }

  return ' Top-level const/let declarations persist across cells, including interrupted cells; use var or globalThis for reusable state, or reset the kernel.'
}

export function executionFailureError(message: Extract<KernelMessage, { type: 'exec_result' }>) {
  return new Error(
    `${message.error ?? 'node_repl execution failed'}${redeclarationHint(message.error)}${partialFailureOutput(message.output)}`
  )
}

export function formatCancellationState(job: ReplJob) {
  if (job.kernelState === 'preserved') {
    return 'Kernel preserved; cancellation is not rollback and bindings or external effects may be partial.'
  }

  if (job.kernelState === 'terminated') {
    return 'Kernel terminated; REPL bindings and in-process browser/Appium handles were lost.'
  }

  return 'Kernel state is not yet known; inspect the completed job before continuing.'
}

export function formatExecutionFailure(job: ReplJob) {
  const error = job.error ?? new Error('node_repl execution failed')
  if (!job.kernelRestarted) {
    return error
  }

  return new Error(
    'Node.js REPL kernel restarted before this cell. Previous REPL bindings and in-process browser/Appium handles were lost; rerun the complete startup block before browser work.\n\n' +
      error.message,
    { cause: error }
  )
}
