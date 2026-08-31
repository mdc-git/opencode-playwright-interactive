import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Location } from '@opencode-ai/schema/location'
import type { Session } from '@opencode-ai/schema/session'

export type SessionId = Session.ID
export type WorkspaceDirectory = Location.Ref['directory']

export type RuntimeOptions = Readonly<{
  nodePath?: unknown
  nodeModuleDirs?: unknown
  replCacheDir?: unknown
  playwrightCacheDir?: unknown
  playwrightNpmPath?: unknown
  playwrightNpxPath?: unknown
}>

export type Attachment = { type: 'file'; mime: string; url: string; filename?: string }
export type Result = { output: string; attachments: Attachment[] }

export type JobState = 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'
export type KernelState = 'preserved' | 'terminated'
export type JobSnapshot = {
  id: string
  state: JobState
  startedAt: string
  finishedAt?: string
  output?: string
  attachments?: Attachment[]
  error?: string
  kernelState?: KernelState
  kernelRestarted?: boolean
}
export type ExecuteOutcome =
  | { kind: 'completed'; result: Result; kernelRestarted?: boolean }
  | { kind: 'background'; job: JobSnapshot }
  | { kind: 'busy'; job: JobSnapshot }

export type KernelProcess = ChildProcessWithoutNullStreams & {
  stdio: [
    NodeJS.WritableStream,
    NodeJS.ReadableStream,
    NodeJS.ReadableStream,
    NodeJS.ReadableStream
  ]
}

export type KernelMessage =
  | {
      type: 'exec_result'
      id: string
      status: 'completed' | 'failed' | 'cancelled'
      output?: string
      attachments?: unknown
      error?: string
    }
  | { type: 'cancel_ack'; id: string }
