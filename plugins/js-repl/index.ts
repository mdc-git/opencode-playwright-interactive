import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { Plugin, type Skill } from '@opencode-ai/plugin/effect'
import type { Session } from '@opencode-ai/schema'
import { Error as ToolError } from '@opencode-ai/schema/tool'
import { Effect, Stream } from 'effect'
import { ReplRuntime, limits } from './runtime.ts'

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
        'Plain Node.js source for the REPL. From Code Mode, prefer sending this source directly as execute code so the plugin can route and escape it safely instead of nesting tools.js_repl calls.'
    },
    [key('timeout_ms')]: {
      type: 'integer',
      minimum: 1,
      maximum: limits.maxTimeoutMs,
      description: `Execution timeout in milliseconds. Defaults to ${limits.defaultTimeoutMs}.`
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

type SessionGetter = (a: {
  readonly sessionID: Session.ID
}) => Effect.Effect<{ location: { directory: string } }, unknown>
type ProgressFn = (a: { title: string; timeout_ms?: number }) => Effect.Effect<void>
type ToolCtx = { sessionID: Session.ID; progress: ProgressFn }

function shouldRouteToRepl(
  event: { tool: string; input: unknown; sessionID: string },
  autoRoutedSessions: Set<string>
): boolean {
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

function routeToRepl(input: unknown, autoRoutedSessions: Set<string>, sessionID: string) {
  const args = input as { code?: unknown; timeout_ms?: unknown }
  const timeout =
    typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)
      ? Math.min(limits.maxTimeoutMs, Math.max(1, Math.trunc(args.timeout_ms)))
      : limits.defaultTimeoutMs
  args.code = `return await tools.js_repl({ code: ${JSON.stringify(args.code)}, timeout_ms: ${timeout} });`
  autoRoutedSessions.add(sessionID)
}

const buildResult = (result: {
  output: string
  attachments: Array<{ url: string; mime: string; filename?: string }>
}) => {
  const text =
    result.output === '' ? 'JavaScript executed successfully (no console output).' : result.output
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

const makeReplExecutor =
  (runtime: ReplRuntime, sessionGet: SessionGetter) => (input: unknown, toolContext: ToolCtx) =>
    Effect.gen(function* () {
      const args = input as { code: string; timeout_ms?: number }
      const timeout = args.timeout_ms ?? limits.defaultTimeoutMs
      yield* toolContext.progress({ title: 'JavaScript REPL', [key('timeout_ms')]: timeout })
      const session = yield* sessionGet({ [key('sessionID')]: toolContext.sessionID }).pipe(
        Effect.mapError(asToolError)
      )
      const result = yield* attempt(async () =>
        runtime.execute(toolContext.sessionID, session.location.directory, args.code, timeout)
      )
      return { ...buildResult(result), metadata: { [key('timeout_ms')]: timeout } }
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
    yield* toolContext.progress({ title: 'Set Up Shared Playwright' })
    const args = input as { force?: boolean }
    const output = yield* attempt(async () => runtime.setupPlaywright(args.force))
    return { output, content: output }
  })

const REPL_DESC =
  "Execute JavaScript in a persistent, session-isolated Node.js kernel with top-level await. In Code Mode, send plain JavaScript directly as execute code instead of nesting a tools.js_repl(...) call; the plugin routes and escapes direct source safely. The final expression value is returned automatically when it is not undefined; console.log is unnecessary for a value such as 2 + 2. Top-level bindings persist until js_repl_reset. Use require(...) or dynamic imports such as await import('node:path'), attach images with await opencode.emitImage({ bytes, mimeType, filename? }), or add diagnostic text with await opencode.emitText({ text }). A timeout ends only the tool call: the kernel and cell continue running, and later calls wait behind it. This is a trusted local-code runtime, not a sandbox."

const SKILL_DESC =
  'Persistent Playwright browser and Electron QA through js_repl, with standard Playwright Chromium for local apps and Camoufox plus humanized input for remote websites. Use when opening, debugging, testing, or visually inspecting local web apps, responsive interfaces, remote websites, or Electron applications.'

const PLUGIN_DESC =
  'Open a persistent Playwright browser or Electron session for interactive QA. Pass a target URL, app path, or task description.'
const PLUGIN_TEMPLATE =
  'Use the playwright-interactive skill to handle this request. Run js_repl_playwright_setup first, then send plain browser JavaScript directly through execute without nesting tools.js_repl calls. Select the correct startup mode, use Playwright for browser lifecycle and locators, and use humanized input only for remote-site interactions.'

function applySkillTransform(
  skills: { add(skill: unknown): void },
  pluginDir: string,
  skillBody: string
) {
  skills.add({
    id: 'playwright-interactive' as Skill.ID,
    name: 'playwright-interactive' as Skill.Name,
    description: SKILL_DESC,
    location: pluginDir as Skill.Info['location'],
    content: skillBody
  })
}

function applyToolTransform(
  tools: { add(tool: unknown): void },
  runtime: ReplRuntime,
  sessionGet: SessionGetter
) {
  tools.add({
    name: 'js_repl',
    description: REPL_DESC,
    input: executeInput,
    output: textOutput,
    options: { permission: 'js_repl' },
    execute: makeReplExecutor(runtime, sessionGet)
  })
  tools.add({
    name: 'js_repl_reset',
    description:
      'Reset the persistent JavaScript kernel for the current OpenCode session, clearing all bindings and imported state.',
    input: resetInput,
    output: textOutput,
    options: { permission: 'js_repl_reset' },
    execute: makeResetExecutor(runtime)
  })
  tools.add({
    name: 'js_repl_playwright_setup',
    description:
      'Install Playwright and Camoufox with their matching browsers once in the shared OpenCode cache for use by js_repl across all workspaces.',
    input: setupInput,
    output: textOutput,
    options: { permission: 'js_repl' },
    execute: makeSetupExecutor(runtime)
  })
}

function applyCommandTransform(commands: {
  update(name: string, fn: (command: unknown) => void): void
}) {
  commands.update('playwright', (command) => {
    const target = command as { description: string; template: string }
    target.description = PLUGIN_DESC
    target.template = PLUGIN_TEMPLATE
  })
}

export default Plugin.define({
  id: 'local.js-repl',
  effect: Effect.fn(function* (context) {
    const pluginDir = fileURLToPath(new URL('.', import.meta.url))
    const runtime = new ReplRuntime(
      context.options,
      fileURLToPath(new URL('scripts/', import.meta.url))
    )
    const autoRoutedSessions = new Set<string>()
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
      applyCommandTransform(commands)
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
    yield* Effect.addFinalizer(() => Effect.promise(async () => runtime.dispose()))
  })
})
