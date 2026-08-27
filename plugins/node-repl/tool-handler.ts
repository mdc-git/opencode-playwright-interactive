import type { Plugin } from '@opencode-ai/plugin/effect'
import type { ToolDraft } from '@opencode-ai/plugin/effect/tool'
import { Error as ToolError, type Tool } from '@opencode-ai/schema/tool'
import { Effect } from 'effect'
import {
  formatExecutionOutcome,
  formatJobActionResult,
  formatJobListResult
} from './tool-result.ts'
import {
  jobInput,
  replInput,
  resetInput,
  setupInput,
  textOutput,
  type JobInput,
  type ReplInput,
  type ResetInput,
  type SetupInput
} from './tool-schema.ts'
import type { ReplRuntime } from './runtime.ts'

type SessionGetter = Plugin.Context['session']['get']

const key = <const K extends string>(value: K): K => value

const asToolError = (error: unknown) =>
  error instanceof ToolError
    ? error
    : new ToolError({ message: error instanceof Error ? error.message : String(error), error })

const attempt = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: asToolError
  })

const REPL_DESC =
  "Execute JavaScript in a persistent, session-isolated Node.js kernel with top-level await. This is a native OpenCode tool: call `node_repl` directly with plain JavaScript in its `code` input. Do not wrap the source in `execute`, `tools.node_repl`, a string, or a template literal. The final expression value is returned automatically when it is not undefined; console.log is unnecessary for a value such as 2 + 2. Top-level bindings persist until `node_repl_reset`. Use require(...) or dynamic imports such as await import('node:path'), attach images with await opencode.emitImage({ bytes, mimeType, filename? }), or add diagnostic text with await opencode.emitText({ text }). Quick cells return normally. A cell still running after the internal foreground window continues as a background job without an automatic wall-clock limit; use `node_repl_job` to inspect, wait for, or cancel it. While a job is active, new cells are rejected as busy rather than queued. Cancellation escalates to restarting only the session kernel when native work does not return. Reset is the last resort for work that cannot be cancelled safely. This is a trusted local-code runtime, not a sandbox."

const JOB_DESC =
  'Native REPL job control. Call `node_repl_job(...)` directly to inspect, wait briefly for, or cancel controller-managed Node.js REPL jobs. Job actions remain responsive while the session kernel is busy. Cancellation may restart only this session kernel when native work does not return.'

const RESET_DESC =
  'Native REPL control. Call `node_repl_reset({})` directly to reset the persistent Node.js kernel for the current OpenCode session, clearing all bindings and imported state.'

const SETUP_DESC =
  'Native REPL control. Call `node_repl_playwright_setup({})` directly to install Playwright and Camoufox with their matching browsers once in the shared OpenCode cache for use by node_repl across all workspaces.'

const makeReplExecutor =
  (runtime: ReplRuntime, sessionGet: SessionGetter) =>
  (input: ReplInput, toolContext: Tool.Context) =>
    Effect.gen(function* () {
      yield* toolContext.progress({ title: 'Node.js REPL' })
      const session = yield* sessionGet({ [key('sessionID')]: toolContext.sessionID }).pipe(
        Effect.mapError(asToolError)
      )
      const result = yield* attempt(async () =>
        runtime.execute(toolContext.sessionID, session.location.directory, input.code)
      )
      return formatExecutionOutcome(result)
    })

const makeJobExecutor = (runtime: ReplRuntime) => (input: JobInput, toolContext: Tool.Context) =>
  Effect.gen(function* () {
    yield* toolContext.progress({ title: 'Node.js REPL job' })
    if (input.action === 'list') {
      const result = yield* Effect.try({
        try: () => runtime.listJobs(toolContext.sessionID),
        catch: asToolError
      })
      if (result.kind !== 'list') {
        throw new Error('Unexpected Node.js REPL job result')
      }

      return formatJobListResult(result.jobs)
    }

    const run = async () => {
      if (input.action === 'status') {
        return runtime.getJob(toolContext.sessionID, input.id)
      }

      if (input.action === 'wait') {
        return runtime.waitForJob(toolContext.sessionID, input.id)
      }

      return runtime.cancelJob(toolContext.sessionID, input.id)
    }

    const result = yield* attempt(run)
    if (result.kind !== 'job') {
      throw new Error('Unexpected Node.js REPL job result')
    }

    return formatJobActionResult(result.job)
  })

const makeResetExecutor =
  (runtime: ReplRuntime) => (_input: ResetInput, toolContext: Tool.Context) =>
    Effect.gen(function* () {
      yield* toolContext.progress({ title: 'Reset Node.js REPL' })
      const didReset = yield* attempt(async () => runtime.reset(toolContext.sessionID))
      const output = didReset
        ? 'Node.js REPL kernel reset.'
        : 'Node.js REPL kernel was not initialized.'
      return { output, content: output }
    })

const makeSetupExecutor =
  (runtime: ReplRuntime) => (input: SetupInput, toolContext: Tool.Context) =>
    Effect.gen(function* () {
      yield* toolContext.progress({ title: 'Set Up Shared Playwright' })
      const output = yield* attempt(async () => runtime.setupPlaywright(input.force))
      return { output, content: output }
    })

export function registerTools(tools: ToolDraft, runtime: ReplRuntime, sessionGet: SessionGetter) {
  tools.add({
    name: 'node_repl',
    description: REPL_DESC,
    input: replInput,
    output: textOutput,
    options: { permission: 'node_repl', codemode: false },
    execute: makeReplExecutor(runtime, sessionGet)
  })
  tools.add({
    name: 'node_repl_job',
    description: JOB_DESC,
    input: jobInput,
    output: textOutput,
    options: { permission: 'node_repl', codemode: false },
    execute: makeJobExecutor(runtime)
  })
  tools.add({
    name: 'node_repl_reset',
    description: RESET_DESC,
    input: resetInput,
    output: textOutput,
    options: { permission: 'node_repl_reset', codemode: false },
    execute: makeResetExecutor(runtime)
  })
  tools.add({
    name: 'node_repl_playwright_setup',
    description: SETUP_DESC,
    input: setupInput,
    output: textOutput,
    options: { permission: 'node_repl', codemode: false },
    execute: makeSetupExecutor(runtime)
  })
}
