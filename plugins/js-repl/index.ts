import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { Plugin, type Skill } from '@opencode-ai/plugin/effect'
import type { CommandDefinition, CommandDraft } from '@opencode-ai/plugin/effect/command'
import type { SkillDraft } from '@opencode-ai/plugin/effect/skill'
import type { ToolDraft, ToolHooks } from '@opencode-ai/plugin/effect/tool'
import { Error as ToolError, type Tool } from '@opencode-ai/schema/tool'
import { Effect, Stream } from 'effect'
import {
  ReplRuntime,
  type ExecuteOutcome,
  type JobActionOutcome,
  type JobSnapshot,
  type RuntimeOptions
} from './runtime.ts'

const asToolError = (error: unknown) =>
  error instanceof ToolError
    ? error
    : new ToolError({ message: error instanceof Error ? error.message : String(error), error })

const key = <const K extends string>(k: K): K => k

const attempt = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: asToolError
  })

const executeInput = {
  type: 'object',
  properties: {
    code: {
      type: 'string',
      minLength: 1,
      description:
        "Plain Node.js source for the REPL. This is a Code Mode catalog tool, not a direct assistant tool: never emit a top-level `js_repl` call. For normal REPL work, send this source unchanged as the `execute` tool's `code`; the plugin routes it. `tools.js_repl` exists only inside `execute`, and wrapping normal cells in it adds a fragile second JavaScript parsing layer."
    }
  },
  required: ['code'],
  additionalProperties: false
} as const

const resetInput = { type: 'object', properties: {}, additionalProperties: false } as const
const setupInput = {
  type: 'object',
  properties: {
    force: {
      type: 'boolean',
      description: 'Reinstall Playwright and Chromium even when the shared cache is already ready.'
    }
  },
  additionalProperties: false
} as const
const textOutput = { type: 'string' } as const

const REPL_ROUTING_PATTERN = /tools(?:\.js_repl|\[["']js_repl["']\])\s*\(/v
const IMPORT_OR_REQUIRE = /\bimport\s*\(|\brequire\s*\(/v
const TOOLS_REFERENCE = /\btools(?:\.|\[)/v

type SessionGetter = Plugin.Context['session']['get']
type ToolCtx = Pick<Tool.Context, 'sessionID' | 'progress'>
type ExecuteBeforeHook = Pick<ToolHooks['execute.before'], 'tool' | 'input' | 'sessionID'>
type ExecuteInput = { code: string }
type JobInput = { action: 'list' | 'status' | 'wait' | 'cancel'; id?: string }
type SetupInput = { force?: boolean }
type RuntimeHolder = {
  runtime: ReplRuntime
  autoRoutedSessions: Set<string>
  references: number
  disposeTimer?: NodeJS.Timeout
}
type RuntimeGlobal = typeof globalThis & {
  __opencodeJsReplRuntimes?: Map<string, RuntimeHolder>
}

const RUNTIME_DISPOSE_GRACE_MS = 5000
const runtimeGlobal = globalThis as RuntimeGlobal
const runtimeRegistry: Map<string, RuntimeHolder> =
  runtimeGlobal.__opencodeJsReplRuntimes ?? new Map<string, RuntimeHolder>()
runtimeGlobal.__opencodeJsReplRuntimes = runtimeRegistry

function acquireRuntime(
  options: RuntimeOptions,
  scriptDirectory: string
): { runtimeId: string; holder: RuntimeHolder } {
  const runtimeId = `${scriptDirectory}\0${JSON.stringify(options)}`
  let holder = runtimeRegistry.get(runtimeId)
  if (holder === undefined) {
    holder = {
      runtime: new ReplRuntime(options, scriptDirectory),
      autoRoutedSessions: new Set(),
      references: 0
    }
    runtimeRegistry.set(runtimeId, holder)
  }

  if (holder.disposeTimer !== undefined) {
    clearTimeout(holder.disposeTimer)
    holder.disposeTimer = undefined
  }

  holder.references += 1
  return { runtimeId, holder }
}

function releaseRuntime(runtimeId: string, holder: RuntimeHolder) {
  holder.references = Math.max(0, holder.references - 1)
  if (holder.references > 0 || holder.disposeTimer !== undefined) {
    return
  }

  holder.disposeTimer = setTimeout(() => {
    holder.disposeTimer = undefined
    if (holder.references > 0 || runtimeRegistry.get(runtimeId) !== holder) {
      return
    }

    runtimeRegistry.delete(runtimeId)
    void holder.runtime.dispose()
  }, RUNTIME_DISPOSE_GRACE_MS)
  holder.disposeTimer.unref()
}

function shouldRouteToRepl(event: ExecuteBeforeHook, autoRoutedSessions: Set<string>): boolean {
  if (event.tool !== 'execute' || typeof event.input !== 'object' || event.input === null) {
    return false
  }

  const { code } = event.input as { code?: unknown }
  if (typeof code !== 'string' || REPL_ROUTING_PATTERN.test(code)) {
    return false
  }

  return (
    IMPORT_OR_REQUIRE.test(code) ||
    (autoRoutedSessions.has(event.sessionID) && !TOOLS_REFERENCE.test(code))
  )
}

function routeToRepl(
  input: ExecuteBeforeHook['input'],
  autoRoutedSessions: Set<string>,
  sessionID: ExecuteBeforeHook['sessionID']
) {
  const args = input as { code?: unknown }
  args.code = `return await tools.js_repl({ code: ${JSON.stringify(args.code)} });`
  autoRoutedSessions.add(sessionID)
}

const buildResult = (result: {
  output: string
  attachments: Array<{ url: string; mime: string; filename?: string }>
  notice?: string
}): Tool.Result => {
  const noticeSuffix =
    typeof result.notice === 'string' && result.notice !== '' ? `\n\n${result.notice}` : ''
  const text =
    noticeSuffix === ''
      ? result.output === ''
        ? 'JavaScript executed successfully (no console output).'
        : result.output
      : result.output + noticeSuffix
  const files = result.attachments.map((a) => {
    const hasFilename = a.filename !== undefined && a.filename !== ''
    return {
      type: 'file' as const,
      uri: a.url,
      mime: a.mime,
      ...(hasFilename && { name: a.filename })
    }
  })
  return {
    output: text,
    content: files.length > 0 ? [{ type: 'text' as const, text }, ...files] : text
  }
}

const jobInput = {
  oneOf: [
    {
      type: 'object',
      properties: { action: { const: 'list' } },
      required: ['action'],
      additionalProperties: false
    },
    ...['status', 'wait', 'cancel'].map((action) => ({
      type: 'object',
      properties: {
        action: { const: action },
        id: { type: 'string', minLength: 1 }
      },
      required: ['action', 'id'],
      additionalProperties: false
    }))
  ]
} as const

function formatJob(job: JobSnapshot) {
  const lines = [`Job: ${job.id}`, `State: ${job.state}`, `Started: ${job.startedAt}`]
  if (job.finishedAt !== undefined) {
    lines.push(`Finished: ${job.finishedAt}`)
  }

  if (job.output !== undefined) {
    lines.push(`Output:\n${job.output === '' ? '(no output)' : job.output}`)
  }

  if (job.error !== undefined) {
    lines.push(`Error: ${job.error}`)
  }

  return lines.join('\n')
}

function buildJobResult(job: JobSnapshot): Tool.Result {
  const activeGuidance = ['running', 'cancelling'].includes(job.state)
    ? `\n\nThe job is still ${job.state}. Call js_repl_job with wait again when no other work is available, or status for an immediate snapshot. Do not submit another REPL cell.`
    : ''
  return buildResult({
    output: formatJob(job) + activeGuidance,
    attachments: job.attachments ?? []
  })
}

function formatJobList(jobs: JobSnapshot[]) {
  return jobs.length === 0
    ? 'No JavaScript REPL jobs.'
    : jobs.map((job) => formatJob(job)).join('\n\n')
}

function formatExecutionOutcome(outcome: ExecuteOutcome): Tool.Result {
  if (outcome.kind === 'completed') {
    return buildResult(outcome.result)
  }

  if (outcome.kind === 'background') {
    return {
      output: `JavaScript is still running. Call js_repl_job with wait when no other work is available, or status for an immediate snapshot. Do not submit another REPL cell while this job is active.\n\n${formatJob(outcome.job)}`,
      content: `JavaScript is still running. Call js_repl_job with wait when no other work is available, or status for an immediate snapshot. Do not submit another REPL cell while this job is active.\n\n${formatJob(outcome.job)}`,
      metadata: { [key('job_id')]: outcome.job.id, state: outcome.job.state }
    }
  }

  const output = `JavaScript kernel is busy running ${outcome.job.id}.\n\nState: ${outcome.job.state}\nInspect, wait for, or cancel that job before submitting another cell.`
  return {
    output,
    content: output,
    metadata: { [key('job_id')]: outcome.job.id, state: outcome.job.state }
  }
}

const makeReplExecutor =
  (runtime: ReplRuntime, sessionGet: SessionGetter) => (input: unknown, toolContext: ToolCtx) =>
    Effect.gen(function* () {
      const args = input as ExecuteInput
      yield* toolContext.progress({ title: 'JavaScript REPL' })
      const session = yield* sessionGet({ [key('sessionID')]: toolContext.sessionID }).pipe(
        Effect.mapError(asToolError)
      )
      const result = yield* attempt(async () =>
        runtime.execute(toolContext.sessionID, session.location.directory, args.code)
      )
      return formatExecutionOutcome(result)
    })

const makeJobExecutor = (runtime: ReplRuntime) => (input: unknown, toolContext: ToolCtx) =>
  Effect.gen(function* () {
    const args = input as JobInput
    yield* toolContext.progress({ title: 'JavaScript REPL job' })
    if (args.action === 'list') {
      const result: JobActionOutcome = yield* Effect.try({
        try: () => runtime.listJobs(toolContext.sessionID),
        catch: asToolError
      })
      if (result.kind !== 'list') {
        throw new Error('Unexpected JavaScript REPL job result')
      }

      const output = formatJobList(result.jobs)
      return { output, content: output }
    }

    const run =
      args.action === 'status'
        ? async () => runtime.getJob(toolContext.sessionID, args.id ?? '')
        : args.action === 'wait'
          ? async () => runtime.waitForJob(toolContext.sessionID, args.id ?? '')
          : async () => runtime.cancelJob(toolContext.sessionID, args.id ?? '')
    const result = yield* attempt(run)
    if (result.kind !== 'job') {
      throw new Error('Unexpected JavaScript REPL job result')
    }

    const { job } = result
    return {
      ...buildJobResult(job),
      metadata: { [key('job_id')]: job.id, state: job.state }
    }
  })

const makeResetExecutor = (runtime: ReplRuntime) => (_input: unknown, toolContext: ToolCtx) =>
  Effect.gen(function* () {
    yield* toolContext.progress({ title: 'Reset JavaScript REPL' })
    const didReset = yield* attempt(async () => runtime.reset(toolContext.sessionID))
    const output = didReset
      ? 'JavaScript REPL kernel reset.'
      : 'JavaScript REPL kernel was not initialized.'
    return { output, content: output }
  })

const makeSetupExecutor = (runtime: ReplRuntime) => (input: unknown, toolContext: ToolCtx) =>
  Effect.gen(function* () {
    const args = input as SetupInput
    yield* toolContext.progress({ title: 'Set Up Shared Playwright' })
    const output = yield* attempt(async () => runtime.setupPlaywright(args.force))
    return { output, content: output }
  })

const REPL_DESC =
  "Execute JavaScript in a persistent, session-isolated Node.js kernel with top-level await. This is a Code Mode-only tool: never emit `js_repl` as a direct assistant tool call. For a normal REPL cell, call `execute` with plain JavaScript in its `code` input; the plugin routes it automatically. Do not nest the source in `tools.js_repl({ code: ... })`, especially not in a template literal. `tools.js_repl` is only the Code Mode spelling inside `execute`. Call js_repl_playwright_setup, js_repl_job, and js_repl_reset inside execute as `tools.js_repl_playwright_setup(...)`, `tools.js_repl_job(...)`, and `tools.js_repl_reset(...)`; never call those controls directly either. The final expression value is returned automatically when it is not undefined; console.log is unnecessary for a value such as 2 + 2. Top-level bindings persist until js_repl_reset. Use require(...) or dynamic imports such as await import('node:path'), attach images with await opencode.emitImage({ bytes, mimeType, filename? }), or add diagnostic text with await opencode.emitText({ text }). Quick cells return normally. A cell still running after the internal foreground window continues as a background job without an automatic wall-clock limit; use js_repl_job to inspect, wait for, or cancel it. While a job is active, new cells are rejected as busy rather than queued. Cancellation escalates to restarting only the session kernel when native work does not return. Reset is the last resort for work that cannot be cancelled safely. This is a trusted local-code runtime, not a sandbox."

const SKILL_DESC =
  'Persistent Playwright browser and Electron QA through js_repl, with standard Playwright Chromium for local apps and Camoufox plus humanized input for remote websites. Use when opening, debugging, testing, or visually inspecting local web apps, responsive interfaces, remote websites, or Electron applications.'

const PLUGIN_DESC =
  'Open a persistent Playwright browser or Electron session for interactive QA. Pass a target URL, app path, or task description.'
const PLUGIN_TEMPLATE =
  'Use the playwright-interactive skill to handle this request. All js_repl tools are Code Mode-only: never emit them as direct tool calls. First use execute with `return await tools.js_repl_playwright_setup({})`. Then send each browser cell as plain JavaScript directly through execute, without wrapping it in tools.js_repl(...). Use tools.js_repl_job(...) and tools.js_repl_reset(...) only inside execute. Select the correct startup mode, use Playwright for browser lifecycle and locators, and use humanized input only for remote-site interactions.'

function applySkillTransform(skills: SkillDraft, pluginDir: string, skillBody: string) {
  skills.add({
    id: 'playwright-interactive' as Skill.ID,
    name: 'playwright-interactive' as Skill.Name,
    description: SKILL_DESC,
    location: pluginDir as Skill.Info['location'],
    content: skillBody
  })
}

function applyToolTransform(tools: ToolDraft, runtime: ReplRuntime, sessionGet: SessionGetter) {
  tools.add({
    name: 'js_repl',
    description: REPL_DESC,
    input: executeInput,
    output: textOutput,
    options: { permission: 'js_repl' },
    execute: makeReplExecutor(runtime, sessionGet)
  })
  tools.add({
    name: 'js_repl_job',
    description:
      'Code Mode-only REPL job control. Call it from execute as `tools.js_repl_job(...)`, never as a direct assistant tool. Inspect, wait briefly for, or cancel controller-managed JavaScript REPL jobs. Job actions remain responsive while the session kernel is busy. Cancellation may restart only this session kernel when native work does not return.',
    input: jobInput,
    output: textOutput,
    options: { permission: 'js_repl' },
    execute: makeJobExecutor(runtime)
  })
  tools.add({
    name: 'js_repl_reset',
    description:
      'Code Mode-only REPL control. Call it from execute as `tools.js_repl_reset({})`, never as a direct assistant tool. Reset the persistent JavaScript kernel for the current OpenCode session, clearing all bindings and imported state.',
    input: resetInput,
    output: textOutput,
    options: { permission: 'js_repl_reset' },
    execute: makeResetExecutor(runtime)
  })
  tools.add({
    name: 'js_repl_playwright_setup',
    description:
      'Code Mode-only REPL control. Call it from execute as `tools.js_repl_playwright_setup({})`, never as a direct assistant tool. Install Playwright and Camoufox with their matching browsers once in the shared OpenCode cache for use by js_repl across all workspaces.',
    input: setupInput,
    output: textOutput,
    options: { permission: 'js_repl' },
    execute: makeSetupExecutor(runtime)
  })
}

function applyCommandTransform(commands: CommandDraft, execute: CommandDefinition['execute']) {
  commands.add({ name: 'playwright', description: PLUGIN_DESC, execute })
}

export default Plugin.define({
  id: 'local.js-repl',
  effect: Effect.fn(function* (context) {
    const pluginDir = fileURLToPath(new URL('.', import.meta.url))
    const scriptDirectory = fileURLToPath(new URL('scripts/', import.meta.url))
    const { runtimeId, holder: runtimeHolder } = acquireRuntime(context.options, scriptDirectory)
    const { runtime, autoRoutedSessions } = runtimeHolder
    const skillBody = readFileSync(
      fileURLToPath(new URL('SKILL.md', import.meta.url)),
      'utf8'
    ).replace(/^---\n[\s\S]*?\n---\n/v, '')

    yield* context.skill.transform((skills) => {
      applySkillTransform(skills, pluginDir, skillBody)
    })

    yield* context.tool.transform((tools) => {
      applyToolTransform(tools, runtime, context.session.get)
    })
    yield* context.command.transform((commands) => {
      applyCommandTransform(commands, ({ sessionID, prompt, delivery }) =>
        context.session
          .prompt({
            [key('sessionID')]: sessionID,
            text: `${PLUGIN_TEMPLATE}\n\n${prompt.text}`,
            files: prompt.files,
            agents: prompt.agents,
            skills: [...(prompt.skills ?? []), { id: 'playwright-interactive' as Skill.ID }],
            delivery
          })
          .pipe(Effect.asVoid)
      )
    })

    yield* context.tool.hook('execute.before', (event) => {
      if (!shouldRouteToRepl(event, autoRoutedSessions)) {
        return Effect.void
      }

      routeToRepl(event.input, autoRoutedSessions, event.sessionID)
      return Effect.void
    })

    yield* context.event.subscribe().pipe(
      Stream.runForEach((event) =>
        event.type === 'session.deleted' || event.type === 'session.moved'
          ? Effect.gen(function* () {
              autoRoutedSessions.delete(event.data.sessionID)
              yield* Effect.promise(async () => runtime.reset(event.data.sessionID))
            })
          : Effect.void
      ),
      Effect.forkScoped
    )
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        releaseRuntime(runtimeId, runtimeHolder)
      })
    )
  })
})
