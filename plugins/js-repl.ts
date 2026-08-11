import { Plugin } from "@opencode-ai/plugin"
import jsRepl, { playwright_setup, reset } from "../tools/js_repl.ts"

type LegacyTool = {
  description: string
  execute(args: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown>
}

type LegacyResult = {
  output?: string
  attachments?: Array<{
    type: "file"
    mime: string
    url: string
    filename?: string
  }>
}

const legacyContext = (context: Record<string, any>, directory: string) => ({
  ...context,
  directory,
  worktree: directory,
  // Propagate the host request's abort signal when available so user
  // cancellation actually reaches the tool. Fall back to a never-fired signal
  // only when the V2 context does not expose one.
  abort: context.abort ?? context.signal ?? new AbortController().signal,
  metadata: (update: Record<string, unknown>) => {
    if (typeof context.progress === "function") context.progress(update)
    else if (typeof context.metadata === "function") context.metadata(update)
  },
  ask: context.ask ?? (async () => undefined),
})

const formatToolError = (error: unknown) => {
  if (error instanceof Error) return error.stack ?? error.message
  return String(error)
}

const register = (plugin: any, tools: any, name: string, legacy: LegacyTool, input: Record<string, unknown>) => {
  tools.add({
    name,
    description: legacy.description,
    input,
    output: { type: "string" },
    options: { permission: "js_repl" },
    execute: async (args: Record<string, unknown>, context: Record<string, unknown>) => {
      // The host reduces rejected tool calls to a generic failure. Return the
      // underlying error as output so the agent can diagnose it directly.
      let result: LegacyResult
      try {
        const session = await plugin.session.get({ sessionID: context.sessionID })
        result = await legacy.execute(args, legacyContext(context, session.location.directory)) as LegacyResult
      } catch (error) {
        const output = `JavaScript REPL error:\n${formatToolError(error)}`
        return { output, content: output }
      }
      const output = result.output ?? ""
      const files = result.attachments?.map((attachment) => ({
        type: "file" as const,
        uri: attachment.url,
        mime: attachment.mime,
        ...(attachment.filename ? { name: attachment.filename } : {}),
      })) ?? []
      return {
        output,
        content: files.length ? [{ type: "text", text: output }, ...files] : output,
      }
    },
  })
}

export default Plugin.define({
  id: "local.js-repl",
  setup: async (context) => {
    await (context as any).tool.transform((tools: any) => {
      register(context, tools, "js_repl", jsRepl as LegacyTool, {
        type: "object",
        properties: {
          code: { type: "string", description: "Plain Node.js source for the REPL. Keep imports here; do not place them in top-level Code Mode execute source." },
          timeout_ms: { type: "integer", minimum: 1, maximum: 300000 },
        },
        required: ["code"],
        additionalProperties: false,
      })
      register(context, tools, "js_repl_reset", reset as LegacyTool, {
        type: "object",
        properties: {},
        additionalProperties: false,
      })
      register(context, tools, "js_repl_playwright_setup", playwright_setup as LegacyTool, {
        type: "object",
        properties: {
          force: { type: "boolean" },
        },
        additionalProperties: false,
      })
    })
  },
})
