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
  abort: new AbortController().signal,
  metadata: (update: Record<string, unknown>) => void context.progress(update),
  ask: context.ask ?? (async () => undefined),
})

const register = (plugin: any, tools: any, name: string, legacy: LegacyTool, input: Record<string, unknown>) => {
  tools.add({
    name,
    description: legacy.description,
    input,
    output: { type: "string" },
    options: { permission: "js_repl" },
    execute: async (args: Record<string, unknown>, context: Record<string, unknown>) => {
      const session = await plugin.session.get({ sessionID: context.sessionID })
      const result = await legacy.execute(args, legacyContext(context, session.location.directory)) as LegacyResult
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
          code: { type: "string", description: "Plain JavaScript source to execute." },
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
