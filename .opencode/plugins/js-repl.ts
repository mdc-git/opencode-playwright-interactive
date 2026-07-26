import { type Plugin, tool } from "@opencode-ai/plugin"
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  ReplController,
} from "../js-repl/manager.js"

export const JsReplPlugin: Plugin = async () => {
  const controllers = new Map<string, ReplController>()

  const controllerFor = (sessionID: string, directory: string) => {
    let controller = controllers.get(sessionID)
    if (!controller) {
      controller = new ReplController({ sessionID, directory })
      controllers.set(sessionID, controller)
    }
    return controller
  }

  const removeController = async (sessionID: string) => {
    const controller = controllers.get(sessionID)
    if (!controller) return false
    controllers.delete(sessionID)
    await controller.dispose()
    return true
  }

  return {
    tool: {
      js_repl: tool({
        description: [
          "Execute JavaScript in a persistent, session-isolated Node.js kernel with top-level await.",
          "Send plain JavaScript in the code argument, without markdown fences.",
          "Top-level bindings persist until js_repl_reset; use console.log() to produce output.",
          "Use dynamic imports such as await import('node:path') or await import('./module.mjs').",
          "Attach images with await opencode.emitImage({ bytes, mimeType, filename? }).",
          "A timeout or cancellation resets the kernel and discards its state.",
        ].join(" "),
        args: {
          code: tool.schema
            .string()
            .min(1)
            .describe("Plain JavaScript source to execute. Do not wrap it in JSON or markdown fences."),
          timeout_ms: tool.schema
            .number()
            .int()
            .min(1)
            .max(MAX_TIMEOUT_MS)
            .optional()
            .describe(`Execution timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`),
        },
        async execute(args, context) {
          await context.ask({
            permission: "js_repl",
            patterns: ["execute"],
            always: ["execute"],
            metadata: {
              warning:
                "JavaScript runs in Node with the current user's filesystem and network privileges.",
            },
          })
          context.metadata({
            title: "JavaScript REPL",
            metadata: { timeout_ms: args.timeout_ms ?? DEFAULT_TIMEOUT_MS },
          })
          const result = await controllerFor(context.sessionID, context.directory).executeResult(
            args.code,
            args.timeout_ms,
            context.abort,
          )
          return {
            title: "JavaScript REPL",
            output: result.output || "JavaScript executed successfully (no console output).",
            attachments: result.attachments,
            metadata: { timeout_ms: args.timeout_ms ?? DEFAULT_TIMEOUT_MS },
          }
        },
      }),
      js_repl_reset: tool({
        description:
          "Reset the persistent JavaScript kernel for the current OpenCode session, clearing all bindings and imported state.",
        args: {},
        async execute(_args, context) {
          context.metadata({ title: "Reset JavaScript REPL" })
          const reset = await removeController(context.sessionID)
          return {
            title: "Reset JavaScript REPL",
            output: reset
              ? "JavaScript REPL kernel reset."
              : "JavaScript REPL kernel was not initialized.",
          }
        },
      }),
    },
    event: async ({ event }) => {
      if (event.type !== "session.deleted") return
      const properties = (event as unknown as {
        properties?: { info?: { id?: string }; sessionID?: string }
      }).properties
      const sessionID = properties?.info?.id ?? properties?.sessionID
      if (sessionID) await removeController(sessionID)
    },
    dispose: async () => {
      const active = [...controllers.values()]
      controllers.clear()
      await Promise.all(active.map((controller) => controller.dispose()))
    },
  }
}
