import { Plugin } from "@opencode-ai/plugin/effect"
import { Error as ToolError } from "@opencode-ai/schema/tool"
import { Effect, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { ReplRuntime, limits } from "./runtime.ts"

const asToolError = (error: unknown) =>
  error instanceof ToolError
    ? error
    : new ToolError({ message: error instanceof Error ? error.message : String(error), error })

const attempt = <T>(run: () => Promise<T>) =>
  Effect.tryPromise({
    try: run,
    catch: asToolError,
  })

const executeInput = {
  type: "object",
  properties: {
    code: {
      type: "string",
      minLength: 1,
      description: "Plain Node.js source for the REPL.",
    },
    timeout_ms: {
      type: "integer",
      minimum: 1,
      maximum: limits.maxTimeoutMs,
      description: `Execution timeout in milliseconds. Defaults to ${limits.defaultTimeoutMs}.`,
    },
  },
  required: ["code"],
  additionalProperties: false,
} as const

const resetInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

const setupInput = {
  type: "object",
  properties: {
    force: {
      type: "boolean",
      description: "Reinstall Playwright and Chromium even when the shared cache is already ready.",
    },
  },
  additionalProperties: false,
} as const

const textOutput = { type: "string" } as const

export default Plugin.define({
  id: "local.js-repl",
  effect: Effect.fn(function* (context) {
    const skillDirectory = fileURLToPath(new URL("../../skills/playwright-interactive/", import.meta.url))
    const runtime = new ReplRuntime(context.options, skillDirectory)
    const autoRoutedSessions = new Set<string>()

    yield* context.tool.transform((tools) => {
      tools.add({
        name: "js_repl",
        description: "Execute JavaScript in a persistent, session-isolated Node.js kernel with top-level await. Send plain JavaScript without Markdown fences. The final expression value is returned automatically when it is not undefined; console.log is unnecessary for a value such as 2 + 2. Top-level bindings persist until js_repl_reset. Use require(...) or dynamic imports such as await import('node:path'), attach images with await opencode.emitImage({ bytes, mimeType, filename? }), or add diagnostic text with await opencode.emitText({ text }). A timeout ends only the tool call: the kernel and cell continue running, and later calls wait behind it. This is a trusted local-code runtime, not a sandbox.",
        input: executeInput,
        output: textOutput,
        options: { permission: "js_repl" },
        execute: (input, toolContext) =>
          Effect.gen(function* () {
            const args = input as { code: string; timeout_ms?: number }
            const timeout = args.timeout_ms ?? limits.defaultTimeoutMs
            yield* toolContext.progress({ title: "JavaScript REPL", timeout_ms: timeout })
            const session = yield* context.session
              .get({ sessionID: toolContext.sessionID })
              .pipe(Effect.mapError(asToolError))
            const result = yield* attempt(() =>
              runtime.execute(toolContext.sessionID, session.location.directory, args.code, timeout),
            )
            const text = result.output || "JavaScript executed successfully (no console output)."
            const files = result.attachments.map((attachment) => ({
              type: "file" as const,
              uri: attachment.url,
              mime: attachment.mime,
              ...(attachment.filename ? { name: attachment.filename } : {}),
            }))
            return {
              output: text,
              content: files.length ? [{ type: "text" as const, text }, ...files] : text,
              metadata: { timeout_ms: timeout },
            }
          }),
      })

      tools.add({
        name: "js_repl_reset",
        description: "Reset the persistent JavaScript kernel for the current OpenCode session, clearing all bindings and imported state.",
        input: resetInput,
        output: textOutput,
        options: { permission: "js_repl_reset" },
        execute: (_input, toolContext) =>
          Effect.gen(function* () {
            yield* toolContext.progress({ title: "Reset JavaScript REPL" })
            const didReset = yield* attempt(() => runtime.reset(toolContext.sessionID))
            const output = didReset ? "JavaScript REPL kernel reset." : "JavaScript REPL kernel was not initialized."
            return { output, content: output }
          }),
      })

      tools.add({
        name: "js_repl_playwright_setup",
        description: "Install rebrowser-playwright and its matching Chromium once in the shared OpenCode cache for use by js_repl across all workspaces.",
        input: setupInput,
        output: textOutput,
        options: { permission: "js_repl" },
        execute: (input, toolContext) =>
          Effect.gen(function* () {
            const args = input as { force?: boolean }
            yield* toolContext.progress({ title: "Set Up Shared Playwright" })
            const output = yield* attempt(() => runtime.setupPlaywright(args.force))
            return { output, content: output }
          }),
      })
    })

    yield* context.command.transform((commands) => {
      commands.update("playwright", (command) => {
        command.description = "Open a persistent Playwright browser or Electron session for interactive QA. Pass a target URL, app path, or task description."
        command.template = "Use the playwright-interactive skill to handle this request. Run js_repl_playwright_setup first, then select the correct startup mode (Electron, local web, or remote stealth) based on the target, complete the full startup block, and then carry out the task."
      })
    })

    yield* context.tool.hook("execute.before", (event) => {
      if (event.tool !== "execute" || !event.input || typeof event.input !== "object") return Effect.void
      const input = event.input as { code?: unknown; timeout_ms?: unknown }
      if (typeof input.code !== "string" || /tools(?:\.js_repl|\[["']js_repl["']\])\s*\(/.test(input.code)) return Effect.void
      const startsReplRouting = /\bimport\s*\(|\brequire\s*\(/.test(input.code)
      const continuesReplRouting = autoRoutedSessions.has(event.sessionID) && !/\btools(?:\.|\[)/.test(input.code)
      if (!startsReplRouting && !continuesReplRouting) return Effect.void
      const timeout =
        typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms)
          ? Math.min(limits.maxTimeoutMs, Math.max(1, Math.trunc(input.timeout_ms)))
          : limits.defaultTimeoutMs
      input.code = `return await tools.js_repl({ code: ${JSON.stringify(input.code)}, timeout_ms: ${timeout} });`
      autoRoutedSessions.add(event.sessionID)
      return Effect.void
    })

    yield* context.event
      .subscribe()
      .pipe(
        Stream.runForEach((event) =>
          event.type === "session.deleted" || event.type === "session.moved"
            ? Effect.gen(function* () {
                autoRoutedSessions.delete(event.data.sessionID)
                yield* Effect.promise(() => runtime.reset(event.data.sessionID))
              })
            : Effect.void,
        ),
        Effect.forkScoped,
      )
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()))
  }),
})
