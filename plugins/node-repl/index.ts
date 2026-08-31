import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Plugin, type Skill } from '@opencode-ai/plugin/effect'
import { Effect, Stream } from 'effect'
import { acquireRuntime, releaseRuntime } from './runtime-registry.ts'
import { registerTools } from './tool-handler.ts'

const SKILL_DESC =
  'Persistent Playwright browser and Electron QA through node_repl, with standard Playwright Chromium for local apps and Camoufox plus humanized input for remote websites. Use when opening, debugging, testing, or visually inspecting local web apps, responsive interfaces, remote websites, or Electron applications.'

const PLUGIN_DESC =
  'Open a persistent Playwright browser or Electron session for interactive QA. Pass a target URL, app path, or task description.'
const PLUGIN_TEMPLATE =
  'Use the playwright-interactive skill to handle this request. The plugin exposes node_repl, node_repl_job, node_repl_reset, and node_repl_playwright_setup as native tools. First call node_repl_playwright_setup({}). Then send each browser cell as plain JavaScript in node_repl({ code: ... }). Use node_repl_job(...) and node_repl_reset(...) directly as needed. Select the correct startup mode, use Playwright for browser lifecycle and locators, and use humanized input only for remote-site interactions. Cancellation may terminate only this session kernel if a native operation remains stuck; follow the reported kernel state, use var or globalThis for reused state, and rerun the complete startup block only after a reported termination or restart.'
const pluginDir = fileURLToPath(new URL('.', import.meta.url))
const scriptDirectory = fileURLToPath(new URL('scripts/', import.meta.url))
const skillBody = readFileSync(fileURLToPath(new URL('SKILL.md', import.meta.url)), 'utf8').replace(
  /^---\n[\s\S]*?\n---\n/v,
  ''
)
const sessionIdField = 'sessionID'

export default Plugin.define({
  id: 'github.node_repl',
  effect: Effect.fn(function* (context) {
    const { runtimeId, holder: runtimeHolder } = acquireRuntime(context.options, scriptDirectory)

    yield* context.skill.transform((skills) => {
      skills.add({
        id: 'playwright-interactive' as Skill.ID,
        name: 'playwright-interactive' as Skill.Name,
        description: SKILL_DESC,
        location: pluginDir as Skill.Info['location'],
        content: skillBody
      })
    })

    yield* context.tool.transform((tools) => {
      registerTools(tools, runtimeHolder.runtime, context.session.get, context.options)
    })
    yield* context.command.transform((commands) => {
      commands.add({
        name: 'playwright',
        description: PLUGIN_DESC,
        execute: ({ sessionID, prompt, delivery }) =>
          context.session
            .prompt({
              [sessionIdField]: sessionID,
              text: `${PLUGIN_TEMPLATE}\n\n${prompt.text}`,
              files: prompt.files,
              agents: prompt.agents,
              skills: [...(prompt.skills ?? []), { id: 'playwright-interactive' as Skill.ID }],
              delivery
            })
            .pipe(Effect.asVoid)
      })
    })

    yield* context.event.subscribe().pipe(
      Stream.runForEach((event) =>
        event.type === 'session.deleted' || event.type === 'session.moved'
          ? Effect.gen(function* () {
              yield* Effect.promise(async () => runtimeHolder.runtime.reset(event.data.sessionID))
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
