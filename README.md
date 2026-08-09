# OpenCode JavaScript REPL

Persistent, interactive browser and Electron QA for OpenCode, powered by a JavaScript REPL and Playwright.



<video controls src="https://github.com/user-attachments/assets/b015fe51-692f-475b-a8ac-a772695db35e"></video>

## Advantages

Compared with one-shot shell commands, ad hoc Node scripts, or a fresh browser launch for every check, `js_repl` keeps JavaScript bindings, imports, and browser objects alive for the current OpenCode session. This makes iterative debugging faster: inspect a page, change the application, query the same page again, and retain the variables and helpers built along the way.

The Playwright skill turns that persistent runtime into an interactive QA loop for browser and Electron applications. It supports targeted inspection, repeatable interactions, screenshots, and follow-up assertions without adding Playwright dependencies or browser binaries to each application workspace. The shared, managed runtime also avoids setup drift between projects while leaving each REPL session isolated.

Chromium web sessions use the skill's managed stealth runtime. One short `js_repl` startup snippet imports the runtime, opens its persistent context, and verifies its required capabilities. Each OpenCode session gets its own Chrome profile under its unique `opencode.tmpDir`, so multiple OpenCode sessions can run browsers simultaneously without conflict. The runtime automatically registers every page and popup, and exposes behavior-sensitive session methods such as `await stealth.click(page, locator)`. This is not a guarantee of undetectability or protection bypass.

## Install

Copy both directories into the global OpenCode configuration directory, or place the skill under `.opencode/skills/` for a project-local install. The startup snippet checks the project-local path before the global path:

```text
~/.config/opencode/
  tools/
    js_repl.ts
    LICENSE.txt
    NOTICE.txt
  skills/
    playwright-interactive/
      SKILL.md
      LICENSE.txt
      NOTICE.txt
      scripts/
        stealth-runtime.mjs
```

Do not copy only `SKILL.md`; the complete skill directory, including `scripts/`, is required. No project package manifest or workspace install step is required. On first use, `js_repl` installs its pinned Meriyah parser in `~/.cache/opencode`; later sessions reuse it. Fully quit and restart OpenCode after copying or changing a tool or skill.

## Requirements

- OpenCode with native custom-tool support
- Node.js 22.22.0 or newer on `PATH`

## Tools

`tools/js_repl.ts` exports three native tools:

- `js_repl`: execute plain JavaScript in a persistent, session-isolated Node.js kernel.
- `js_repl_reset`: clear the current session's bindings and terminate its kernel.
- `js_repl_playwright_setup`: install the shared Playwright runtime and Chromium once in the local user cache.

`js_repl` accepts `code` and optional `timeout_ms` (1 to 300000 milliseconds; default 30000). Send JavaScript directly, without Markdown fences.

```js
// First call
let counter = 1
const path = await import("node:path")
console.log(path.basename("/tmp/example"), counter)

// Later call in the same OpenCode session
counter += 1
console.log(counter)
```

Top-level `const`, `let`, `var`, function, and class bindings persist between calls. Dynamic imports support Node builtins, installed workspace packages, and local ESM `.js`/`.mjs` files. Static imports are not supported; use `await import(...)`.

The kernel exposes `opencode.cwd`, `opencode.homeDir`, `opencode.tmpDir`, `tmpDir`, and `opencode.emitImage(imageLike)`. Image attachments support PNG, JPEG, WebP, and GIF, with a 5 MiB limit per image and at most four images per execution.

Explicitly close browser resources before resetting the REPL or ending a browser QA task. Use `js_repl_reset` when you need to discard the current session; timeouts, cancellation, fatal asynchronous errors, process crashes, and fully closing OpenCode also tear down the kernel. Native custom tools do not receive the plugin session-deletion lifecycle hook, so reset explicitly when a long-lived session no longer needs the REPL.

## Playwright Skill

`skills/playwright-interactive/` provides persistent browser and Electron QA instructions. Before first use, call `js_repl_playwright_setup`; it installs Playwright 1.62.0 and Chromium under `~/.cache/opencode/playwright` by default, rather than modifying each application workspace. The REPL automatically resolves the shared library and browser path thereafter. Set `OPENCODE_PLAYWRIGHT_CACHE_DIR` to relocate the managed cache, `OPENCODE_PLAYWRIGHT_NPM_PATH` or `OPENCODE_PLAYWRIGHT_NPX_PATH` to select package executables, and `PLAYWRIGHT_BROWSERS_PATH` to reuse an existing browser cache.

By default, the skill launches Chromium with `launchPersistentContext()` and stores browser data, `behavior.json`, `persona.json`, and `profile.json` under the session's `opencode.tmpDir/stealth/`. Each OpenCode session gets its own profile, so multiple sessions can run browsers simultaneously. Within one session, desktop and mobile share the profile and must run sequentially. Mobile is an explicit viewport/touch override of that session identity. `resetProfile()` closes the session, deletes the dedicated identity, and does not relaunch; the next `ensureWebBrowser()` or `ensureMobileBrowser()` creates it on demand.

Use `ensureWebBrowser()` or `ensureMobileBrowser()` for every Chromium web session. Each returns a session controller with explicit-page methods including `resolveVisible`, `interactiveElements`, `click`, `doubleClick`, `hover`, `wheel`, `scroll`, `dragTo`, `type`, `fill`, `press`, `focus`, `check`, `uncheck`, `selectOption`, `tap`, `screenshot`, and `stop`. Existing pages, new pages, and popups are registered automatically. Managed target hit testing operates in each element's actual document or open shadow root. When a target's realm is unknown, the controller can resolve an exact semantic locator across current and newly attached frames. When the exact element is unknown, it inventories visible interactive DOM elements across frames and open shadow roots with their live locators, accessible-name evidence, roles, states, and context; agents select semantically from the unfiltered inventory rather than applying guessed language-specific regexes. If no entry fits, the screenshot is the next source of truth. Main-frame absence is not treated as whole-browser absence. Navigation-capable clicks are treated as having three possible outcomes: same-page navigation, a new managed tab or popup, or no navigation. The skill requires agents to resolve that outcome and update their active `page` handle rather than continuing against a stale opener tab. If one failed action or inspection pass leaves the next target unclear, the skill requires an immediate viewport screenshot through the controller and `opencode.emitImage()` before further guessing or scripting; after a click, open managed page URLs are checked first. A remaining target failure is diagnosed with one locator-scoped inspection that reports its frame, root, geometry, and hit element instead of separate speculative frame/shadow/overlay probes. Frames are tracked through normal Playwright lifecycle events; dedicated workers and service workers are observed only, and no inert init script is installed. Direct `locator.*`, `page.mouse`, `page.keyboard`, `page.touchscreen`, `evaluate()` mutation, and DOM assignment remain valid ordinary Playwright but are unmanaged because public Playwright provides no transparent interception layer. Playwright 1.62.0 still enables `Runtime.enable` as part of normal operation; this feature is not suppressed or intercepted. Electron is unchanged.

`interactiveElements()` performs one untruncated snapshot of the main document and currently attached frames with real documents. The first inventory after a main-frame navigation allows one short render window for asynchronously attached UI, but it does not repeatedly count elements or wait for a dynamic page to settle; subsequent inventories are immediate. If the requested control attached after that snapshot, the agent takes a screenshot and then one fresh inventory. Diagnostic and visual-review screenshots use full-page capture when possible, falling back to the viewport only when full-page capture fails or exceeds the attachment limit.

## Configuration

OpenCode prompts before running JavaScript by default. A consumer project may configure the permission explicitly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "js_repl": "ask"
  }
}
```

Set `OPENCODE_JS_REPL_NODE_PATH` to choose a Node binary. Set `OPENCODE_JS_REPL_NODE_MODULE_DIRS` to a platform path-delimited list of additional package resolution roots.

Set `OPENCODE_JS_REPL_CACHE_DIR` to relocate the shared Meriyah cache and `OPENCODE_JS_REPL_NPM_PATH` to select the npm executable used for its one-time install.

## Security

This tool is not an OS sandbox. It blocks direct `process`, `child_process`, and `worker_threads` imports, but evaluated code can access the filesystem and network, and imported dependency code runs with the current user's privileges. Treat `permission.js_repl = "allow"` as permission to run arbitrary local code.

The bundled runtime is adapted from OpenAI Codex revision `219c65dc2f7a2fdb2adef73d572189e80b7470e5`. See `tools/NOTICE.txt` and `tools/LICENSE.txt`.
