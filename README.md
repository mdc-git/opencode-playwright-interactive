# OpenCode JavaScript REPL

A persistent JavaScript REPL and Playwright workflow for browser and Electron
QA in OpenCode.

<!-- markdownlint-disable-next-line MD033 -->
<video controls src="https://github.com/user-attachments/assets/b015fe51-692f-475b-a8ac-a772695db35e"></video>

## Why use it

`js_repl` keeps bindings, imports and browser objects alive for the current
OpenCode session. Inspect a page, change the application and query the same
page again without rebuilding the script or reopening the browser.

The Playwright skill adds instructions for repeatable interactions,
screenshots and follow-up checks. Playwright and Chromium live in a shared
user cache, so they do not need to be installed in every application.

Local web apps use standard Playwright Chromium, and Electron uses Playwright's
normal Electron launcher. Remote websites run through the skill's managed
stealth runtime, which includes a session profile and managed input methods
such as `await stealth.click(page, locator)`. It does not guarantee that a site
cannot detect automation.

## Install

This project uses the OpenCode V2 plugin API. Copy `plugins/`, `tools/` and
`skills/` together into the global OpenCode config directory:

```text
~/.config/opencode/
  plugins/
    js-repl.ts
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

For a project-only install, put the same directories under
`<project>/.opencode/`. Keep the full skill directory. The startup code needs
`scripts/stealth-runtime.mjs`, not only `SKILL.md`.

Install the V2 plugin package in the same config directory:

```sh
# Global install
npm install --prefix ~/.config/opencode @opencode-ai/plugin@next

# Project-only install
npm install --prefix .opencode @opencode-ai/plugin@next
```

OpenCode discovers plugins in `.opencode/plugins/` and
`~/.config/opencode/plugins/` automatically. No `plugins` config entry is
needed for this layout. Check that the plugin loaded with:

```sh
opencode2 api get /api/plugin
```

The returned list should contain `local.js-repl`.

On its first run, `js_repl` installs Meriyah in `~/.cache/opencode`. Later
sessions reuse that installation. OpenCode reloads discovered plugin and
config files when they change. After updating `@opencode-ai/plugin` or another
dependency, restart the service:

```sh
opencode2 service restart
```

## Requirements

- OpenCode V2
- Node.js 22.22.0 or newer on `PATH`
- npm and npx on `PATH`, unless custom executable paths are configured

## Tools

The `local.js-repl` plugin registers these tools:

- `js_repl` runs JavaScript in a persistent Node.js kernel.
- `js_repl_reset` clears the current session's bindings and stops its kernel.
- `js_repl_playwright_setup` installs rebrowser-playwright and Chromium in the
  user cache.

`js_repl` accepts `code` and an optional `timeout_ms` from 1 to 300000. The
default is 30000 milliseconds. Send plain JavaScript without Markdown fences.

When OpenCode exposes the tool through Code Mode, `execute` only accepts
orchestration syntax. Keep imports and all other Node.js source inside the
`code` string passed to `tools.js_repl`:

```js
return await tools.js_repl({
  code: `var path = await import("node:path");
console.log(path.basename("/tmp/example"));`,
});
```

Sending the `import(...)` expression directly to `execute` produces an
`ImportExpression is not supported` error before `js_repl` is called.
Likewise, do not put an unescaped REPL template literal inside the outer
`` code: `...` `` wrapper. Use string concatenation in the REPL source or pass
the source as a quoted JSON string so an inner backtick cannot terminate the
outer wrapper. Code Mode also cooks backslash escapes in that outer template.
The kernel restores cooked line terminators inside quoted REPL strings before
parsing, so common inner expressions such as `join("\n")` remain valid.

```js
// First call
let counter = 1
const path = await import("node:path")
console.log(path.basename("/tmp/example"), counter)

// Later call in the same OpenCode session
counter += 1
console.log(counter)
```

Top-level `const`, `let`, `var`, function, class and static import bindings
persist between calls. `require(...)` resolves from the workspace. Static and
dynamic imports support Node built-ins, installed workspace packages and local
ESM `.js` or `.mjs` files.

The kernel exposes `opencode.cwd`, `opencode.homeDir`, `opencode.tmpDir`,
`opencode.sessionId`, `opencode.bindBrowser(options)`, `tmpDir`,
`opencode.emitImage(imageLike)` and `opencode.emitText(textLike)`.
`emitText` accepts a string or `{ text }` and appends it to the tool result.
Image attachments may be PNG, JPEG, WebP or GIF. Each image is limited to 5
MiB, with at most four images per execution.

A timeout or cancellation stops the tool call but does not stop its cell. The
cell keeps running in the kernel, and later calls wait behind it. Check the
resulting state before repeating an action. Use `js_repl_reset` to stop a stuck
cell.

Close browser resources before resetting the REPL. The OpenCode background
service owns the plugin, so closing the TUI may leave the kernel running. Reset
long-lived sessions when they no longer need the REPL. Restarting the service
stops every plugin kernel.

## Playwright skill

Call `js_repl_playwright_setup` before the first browser session. It installs
rebrowser-playwright 1.52.0 and its matching Chromium under
`~/.cache/opencode/playwright` by default. The maintained drop-in package closes
the `Runtime.enable` CDP automation leak and renames the default utility world.
Setup verifies both package identities on every run and applies a guarded fix
for rebrowser's session-wide execution-context clear on child-frame navigation.
Without that fix, navigating an ordinary iframe can destroy the main frame's
live handles and destabilize concurrent navigation work. The REPL then resolves
the shared package and browser path automatically.

For local web apps, the skill launches standard Chromium and uses ordinary
Playwright APIs without loading the stealth runtime. Local targets include
apps identified as running on the local machine, `file:` URLs, `localhost`,
`*.localhost`, `127.0.0.0/8` and `[::1]`. Electron likewise starts without a
Chromium or stealth session.

For remote websites, the skill opens Chromium with
`launchPersistentContext()`. Browser data, `behavior.json`, `persona.json` and
`profile.json` are stored under the session's `opencode.tmpDir/stealth/`
directory. The runtime keeps Chromium's native version-coherent user agent and
suppresses the automation-controlled disclosure with launch arguments; it
rejects identity-critical caller overrides. Managed input
is task-bound and emits no periodic pointer movement while idle. Separate
OpenCode sessions can run browsers at the same time. Desktop and responsive
touch modes in one remote session share a profile, so they must run one after
the other. Responsive touch mode does not impersonate Safari or a physical
device.

Every local and remote browser uses `opencode.bindBrowser()` to bind the
Playwright browser, context and pages to the OpenCode session that launched it.
Local startup exposes `localBrowserBinding` and `assertLocalPage(page)`. Remote
startup exposes `stealth.binding` and includes the binding in
`stealth.pageState(page)`. A closed binding fails closed and cannot adopt a
browser or page from another session.

Remote mode uses `ensureWebBrowser()` or `ensureMobileBrowser()` to create a
Chromium session. The returned controller provides:

- Page discovery through `pages()` and `newPage()`, including automatic popup
  registration
- Cross-frame and open-shadow-root lookup through `resolveVisible()` and
  `interactiveElements()`
- Managed input methods including `click`, `doubleClick`, `hover`, `scroll`,
  `dragTo`, `type`, `fill`, `press`, `check`, `selectOption` and `tap`
- Screenshots through `screenshot()` and cleanup through `stop()`
- Coarse, in-memory identity and session diagnostics through `identity`,
  `capabilities()`, `telemetry()` and `pageState()`

`interactiveElements()` takes one untruncated inventory of visible controls in
the main document and attached frames. The first inventory after navigation
allows a short render window for frames that attach asynchronously. Later
inventories return immediately. If a control appears after the snapshot, the
skill takes a screenshot and then one fresh inventory.

The skill checks whether a click navigated the current page, opened another
page or did neither. When a target is unclear after one failed action or
inspection, it takes a screenshot before trying another selector. Target
diagnostics report the element's frame, root, geometry and hit-tested element
in one inspection.

Remote mode does not add a user-agent override, rotate network identity or
manipulate challenge systems. The patched driver avoids `Runtime.enable`, and
Chromium launches with automation-controlled Blink features disabled. The
runtime blocks custom user agent, locale, timezone, viewport,
mobile, touch, scale, screen, identity-bearing HTTP header and Chromium
argument overrides so these settings cannot silently contradict each other.
Its telemetry is coarse and in-memory: action, failure, navigation and popup
counts plus the latest main document status. It does not collect URLs, page
fingerprints, tokens or input contents.

Direct Playwright calls such as `locator.*`, `page.mouse`, `page.keyboard`,
`page.touchscreen` and DOM mutation through `evaluate()` still work, but they
do not use the managed input layer. Frames follow the normal Playwright
lifecycle. Dedicated workers and service workers are observed but not
modified. The rebrowser-patched driver does not enable `Runtime.enable`;
the fix mode defaults to `addBinding` and can be changed with
`REBROWSER_PATCHES_RUNTIME_FIX_MODE`.
Local web and Electron testing use ordinary Playwright calls instead of these
controller methods. Electron support is separate from the Chromium stealth
runtime.

Calling `resetProfile()` closes the browser and deletes the session's stored
identity. It does not reopen the browser. The next `ensureWebBrowser()` or
`ensureMobileBrowser()` call creates a new profile.

Profile reset is lifecycle cleanup, not a way to retry an access decision.
The skill stops on bot challenges, challenge loops, explicit automated-access
denials and HTTP `403` or `429` responses. It does not solve CAPTCHAs or retry,
switch modes, reset identity or open parallel sessions to seek a different
result. Authorized tests should use provider test keys, staging, narrow
allowlisting or headed human completion.

## Configuration

OpenCode asks when no permission rule matches. To state that policy explicitly,
add this V2 rule to `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "js_repl", "resource": "*", "effect": "ask" }
  ]
}
```

Use `allow` to run all three tools without prompting or `deny` to block them.
The rule may be global, project-specific or part of an agent's `permissions`
array.

The runtime reads these environment variables:

- `OPENCODE_JS_REPL_NODE_PATH` selects the Node.js binary.
- `OPENCODE_JS_REPL_NODE_MODULE_DIRS` adds package resolution roots using the
  platform path delimiter.
- `OPENCODE_JS_REPL_CACHE_DIR` changes the Meriyah cache directory.
- `OPENCODE_JS_REPL_NPM_PATH` selects npm for the Meriyah installation.
- `OPENCODE_PLAYWRIGHT_CACHE_DIR` changes the Playwright cache directory.
- `OPENCODE_PLAYWRIGHT_NPM_PATH` and `OPENCODE_PLAYWRIGHT_NPX_PATH` select the
  package executables used by Playwright setup.
- `PLAYWRIGHT_BROWSERS_PATH` reuses or relocates a Playwright browser cache.

## Security

The REPL is a trusted local-code runtime, not a sandbox. Evaluated code runs
with the current user's Node.js permissions. It can access the filesystem and
network and can load modules including `child_process` and `worker_threads`.
An `allow` rule for the `js_repl` action permits arbitrary local code
execution.

The runtime is adapted from OpenAI Codex revision
`219c65dc2f7a2fdb2adef73d572189e80b7470e5`. See `tools/NOTICE.txt` and
`tools/LICENSE.txt`.
