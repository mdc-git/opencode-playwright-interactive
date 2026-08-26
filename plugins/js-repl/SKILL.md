---
name: playwright-interactive
description: Persistent Playwright browser and Electron QA through js_repl, with optional humanized input for remote websites.
---

# Playwright Interactive

Use persistent `js_repl` Playwright handles for browser and Electron QA.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this skill are to be interpreted as described in RFC 2119.

Sections marked **CRITICAL** are mandatory execution gates. They are not recommendations. If a CRITICAL gate is skipped or violated, the agent **MUST** stop the browser task, return to the unmet gate, and complete it before continuing. Work performed beyond a skipped gate **MUST NOT** be treated as valid verification.

## REQUIRED: Tool Invocation

All `js_repl` entries are Code Mode tools. The assistant's direct tool namespace does not expose them. The agent **MUST NOT** emit a top-level `js_repl`, `js_repl_job`, `js_repl_reset`, or `js_repl_playwright_setup` tool call.

- Setup through `execute` with `return await tools.js_repl_playwright_setup({})`.
- For a normal browser REPL cell, send only the plain Node.js source as `execute` code. The plugin routes it into the persistent kernel.
- The agent **MUST NOT** wrap a normal cell in `tools.js_repl({ code: ... })`, a string, or a template literal. That creates an unnecessary second JavaScript parser and can interpolate or terminate code before the REPL receives it.
- Job management and reset stay inside `execute`: `return await tools.js_repl_job({ action: 'wait', id: 'repl_1' })` and `return await tools.js_repl_reset({})`.

## Startup

Run setup first:

```js
return await tools.js_repl_playwright_setup({})
```

### REQUIRED: Direct REPL Routing

After setup, the agent **MUST** send each browser REPL cell as plain JavaScript directly in the `execute` tool's `code` input. It **MUST NOT** wrap browser code in a nested `tools.js_repl(...)` call. The plugin safely routes the first cell containing `import(...)` or `require(...)` to `js_repl` and keeps routing later plain JavaScript cells in that session to the same persistent kernel.

`js_repl_playwright_setup`, `js_repl_job`, and `js_repl_reset` are explicit Code Mode calls only within `execute`, as shown above. Browser startup, inspection, and interaction cells do not need an inner tool call.

Long cells require no wrapper or timeout option. If `js_repl` returns a job ID, use `js_repl_job` with `wait` when no other work is available, `status` for an immediate snapshot, and `cancel` to request cancellation. Do not submit another JavaScript cell while the kernel reports an active job. Long-running cells have no automatic wall-clock limit and may remain as background jobs while they make progress. Cancellation starts cooperatively, then interrupts the session kernel and restarts only that kernel if a native operation does not return; escalation loses that session's bindings and browser handles but does not restart OpenCode or affect other sessions. Use `js_repl_reset` only when losing bindings and browser handles is acceptable. Each `wait` observes for roughly five seconds and does not stop or restart the job; if it still reports an active state, call `wait` again when no other work is available.

This avoids nesting JavaScript source inside another template literal. If `execute` reports `Failed to parse TypeScript`, the cell did not reach `js_repl`; correct the outer JavaScript syntax and retry the same small cell without resetting the kernel.

Select exactly one startup mode. A local URL uses standard Chromium, a remote URL uses Camoufox, and Electron uses its own launcher. Do not navigate during startup. Web contexts **MUST** use `viewport: null` so the page viewport follows manual browser-window resizing instead of remaining fixed at Playwright's 1280x720 default.

### Local Web

```js
var playwright = await import('playwright')
var chromium = playwright.chromium
var HEADLESS = false
// Set only when the user explicitly supplies a profile directory.
var PERSISTENT_PROFILE_DIR = undefined
var browser
var context
if (PERSISTENT_PROFILE_DIR) {
  context = await chromium.launchPersistentContext(PERSISTENT_PROFILE_DIR, {
    headless: HEADLESS,
    viewport: null
  })
  browser = context.browser()
} else {
  browser = await chromium.launch({ headless: HEADLESS })
  context = await browser.newContext({ viewport: null })
}
var page = context.pages()[0] || (await context.newPage())
;({ status: 'Standard Chromium opened', persistentProfile: Boolean(PERSISTENT_PROFILE_DIR) })
```

Local web uses normal Playwright input. Do not load the humanized input module.

### Remote Web

Remote web defaults to a non-persistent context. The agent **MUST** execute this lifecycle in the documented order: `firefox.launch()` returns a `Browser`, `browser.newContext()` returns a `BrowserContext`, and `context.newPage()` creates the one allowed bootstrap page. It **MUST NOT** swap the `browser` and `context` assignment targets or call `context.browser()` in this mode.

```js
var core = await import('playwright-core')
var { launchOptions } = await import('camoufox-js')
var path = await import('node:path')
var { pathToFileURL } = await import('node:url')
var HEADLESS = false
var camoufoxOptions = await launchOptions({ enable_cache: true })
var firefoxUserPrefs = {
  ...camoufoxOptions.firefoxUserPrefs,
  'browser.link.open_newwindow': 3,
  'browser.link.open_newwindow.restriction': 0
}
var browser = await core.firefox.launch({
  ...camoufoxOptions,
  firefoxUserPrefs,
  headless: HEADLESS
})
var context = await browser.newContext({ viewport: null })
var page = await context.newPage() // Initial bootstrap only; use window.open() for more tabs.
var humanizedInputPath = path.join(opencode.scriptDir, 'humanized-input.mjs')
var { createHumanizedInput } = await import(pathToFileURL(humanizedInputPath).href)
var input = createHumanizedInput()
;({ status: 'Camoufox opened' })
```

Camoufox supplies the browser-level anti-detection behavior. `input` supplies only humanized input. Playwright owns browser and context lifecycle, pages, tabs, popups, navigation, locators, frames, shadow DOM, waiting, screenshots, and assertions.

When the user explicitly supplies a profile directory, replace only the three non-persistent lifecycle lines from `var browser = ...` through `var page = ...` with this persistent lifecycle. `launchPersistentContext()` returns a `BrowserContext`, not a `Browser`; `context.browser()` then retrieves its browser. The agent **MUST NOT** combine assignments from the two lifecycle variants.

```js
var PERSISTENT_PROFILE_DIR = '/exact/user-supplied/path'
var context = await core.firefox.launchPersistentContext(PERSISTENT_PROFILE_DIR, {
  ...camoufoxOptions,
  firefoxUserPrefs,
  headless: HEADLESS,
  viewport: null
})
var browser = context.browser()
var page = context.pages()[0]
if (!page) throw new Error('Persistent context opened without a startup page')
```

### Electron

```js
var playwright = await import('playwright')
var electronLauncher = playwright._electron
var ELECTRON_ENTRY = '.'
var electronApp = await electronLauncher.launch({ args: [ELECTRON_ENTRY] })
var appWindow = await electronApp.firstWindow()
appWindow.setDefaultTimeout(10000)
;({ status: 'Loaded Electron window', title: await appWindow.title() })
```

Electron uses normal Playwright input and never loads humanized web input.

## REPL Authoring Rules

The persistent kernel keeps top-level bindings across cells. Author cells to reuse existing state rather than rebuild it, and keep the shared binding scope clean.

- **Prefer reusing handles over re-creating them.** `browser`, `context`, `page`, `input`, `electronApp`, `appWindow`, `fs`, `path`, and any helper you assigned in a prior cell persist into the next one. Reference them directly instead of launching a new browser, importing a module again, or recomputing a value that already exists. Re-running a declaration like `const fs = await import('node:fs')` re-creates the binding on purpose when you mean to, but re-declaring a name you only meant to reuse is a needless `Identifier 'X' has already been declared` error. If a value is missing or stale, reassign the existing name (`page = await context.newPage()`) rather than introducing a parallel one.
- **Reuse — do not accumulate — shared state.** Every top-level binding lives for the whole session and is re-imported into every later cell, so each name you add is ongoing pollution the agent must track. Do not declare a helper, counter, scratch object, or intermediate result at the top level when a local variable inside a block or a single returned expression would do. Scope work to the cell: prefer `const x = ...` used immediately and returned, or wrap a multi-step computation in a block (`{ ... }`) or an IIFE so its temporaries never enter the shared scope. Reuse the one browser/context/page trio across the task rather than opening extras; close and null out a handle only when its lifecycle is truly over.
- **Use `await import(...)`, never `eval("…import…")`.** `import` is a module-level declaration; wrapping it in `eval` throws `Unexpected token 'import'`. Use a static `await import('playwright')` at the top of the cell, or `const mod = await import(specifier)` when the specifier is dynamic.
- **It is a Node kernel, not a browser.** `location`, `document`, `window`, `navigator`, and `localStorage` are not defined. Reach the DOM through Playwright: `await page.evaluate(() => location.href)` or `await page.locator(...)`. Use `opencode.tmpDir`/`opencode.cwd` (Node paths) for filesystem work, not browser URLs.
- **Keep cells small and one-purpose.** A long single-line expression built by concatenation (regexes, nested `map`/`filter`, multiple `=>` arrows) is the main source of `Expected '}' / ']' / ')'` and `missing ) after argument list` parse errors. Split it across lines and statements; the kernel preserves bindings between calls, so you do not lose state by splitting.

## Persistent Profiles

Profile persistence is opt-in. Set `PERSISTENT_PROFILE_DIR` only when the user explicitly asks to reuse a profile and supplies the exact directory. Otherwise use `browser.launch()` followed by `browser.newContext()`.

A persistent profile may contain credentials, cookies and browsing history. Never inspect or expose those values unless the task explicitly requires it. If Playwright reports that the profile is locked, ask the user to close the other browser; never delete lock files.

## Element Selection

Use Playwright directly for every element lookup. The humanized input module has no locator, accessibility inventory, frame discovery, overlay discovery, popup handling or tab tracking API.

### REQUIRED: AI-Optimized Element Discovery

When the next target is not already known from current, verified evidence, the agent **MUST** capability-detect and use Playwright's AI-optimized ARIA snapshot as its first element-discovery operation. It **MUST** try `ariaSnapshot` first, then `ariaSnapshotJSON` when the first method is unavailable:

```js
var aiSnapshotOptions = { mode: 'ai', boxes: true, timeout: 5000 }
var uiSnapshot
if (typeof page.ariaSnapshot === 'function') {
  uiSnapshot = await page.ariaSnapshot(aiSnapshotOptions)
} else if (typeof page.ariaSnapshotJSON === 'function') {
  uiSnapshot = await page.ariaSnapshotJSON(aiSnapshotOptions)
} else {
  uiSnapshot = undefined
}
uiSnapshot
```

When either method is available, the agent **MUST** inspect its result before trying selectors. AI mode provides roles, accessible names, element references such as `[ref=e2]` in the text format or equivalent `ref` fields in JSON, and nested iframe snapshots. `boxes: true` adds viewport-relative element bounds. This single Playwright-native representation **SHOULD** replace repeated guessed locators, frame-by-frame searches and broad DOM inspection.

The agent **MUST NOT** assume either method exists solely from a remembered Playwright version. If neither method is available, it **MAY** fall back to exact user-facing Playwright locators plus screenshot inspection and **MUST NOT** recreate an accessibility inventory with custom DOM scripts.

When the snapshot identifies the intended element by reference, the agent **MAY** use that reference immediately for exploratory targeting:

```js
var target = page.locator('aria-ref=e2')
```

`aria-ref` is an implementation-backed, ephemeral selector rather than a documented durable selector API. The agent **MUST** use it in the frame that owns the referenced element and **MUST NOT** persist it in reusable automation. It **SHOULD** derive durable interactions from the observed role, label, text or test id using public locators such as `getByRole()` or `getByLabel()`.

ARIA references are tied to the most recent snapshot and current UI state. After another snapshot in that frame, navigation or a material DOM change, the agent **MUST** take a fresh snapshot before using a reference. It **MUST NOT** guess an `aria-ref` value.

If the relevant region is already known, the agent **SHOULD** scope the snapshot to that Playwright locator to reduce output:

```js
var dialog = page.getByRole('dialog')
var dialogSnapshot =
  typeof dialog.ariaSnapshot === 'function'
    ? await dialog.ariaSnapshot(aiSnapshotOptions)
    : typeof dialog.ariaSnapshotJSON === 'function'
      ? await dialog.ariaSnapshotJSON(aiSnapshotOptions)
      : undefined
```

On exceptionally large pages, the agent **MAY** use `depth` to bound a snapshot, but **MUST NOT** conclude that an element is absent when it may have been excluded by that depth. If the AI snapshot does not expose a visibly present control, the agent **MUST** inspect the screenshot and then use normal Playwright locators against the observed UI. An exact user-facing locator already established by current evidence **MAY** be used directly without another snapshot.

Prefer Playwright's user-facing locators:

```js
var submit = page.getByRole('button', { name: 'Submit' })
var email = page.getByLabel('Email')
```

Playwright locators pierce open shadow roots by default. Use `frameLocator()` or a frame's own locator APIs for iframes. Use normal Playwright inspection and screenshots to identify overlays. Closed shadow roots are not accessible through standard Playwright locators.

### REQUIRED: Camoufox Additional Pages

The Remote Web startup configures Firefox's new-window behavior so browser-originated windows open as tabs in the existing visible browser window. The agent **MUST** navigate the initial page to the first target and **MUST NOT** use `context.newPage()` to open an additional Camoufox page, whether the context is persistent or non-persistent. Playwright-created additional Firefox pages can appear as separate visible browser windows even though `context.pages()` reports them in one context, while browser-originated pages join the same visible window as tabs. The startup block's `context.newPage()` call is allowed only to bootstrap the initial non-persistent page. This restriction does not apply to Chromium.

When a Camoufox/Firefox workflow needs a programmatically opened page rather than a visible link or button, open it through the current page's `window.open()` and let Playwright observe the browser-created page:

```js
var [additionalPage] = await Promise.all([
  context.waitForEvent('page'),
  page.evaluate((url) => window.open(url, '_blank'), TARGET_URL)
])
await additionalPage.waitForLoadState('domcontentloaded')
page = additionalPage
;({ pageCount: context.pages().length, pages: context.pages().map((candidate) => candidate.url()) })
```

For multiple pages, repeat this sequence from an existing loaded page until `context.pages().length` equals the expected count. Verify the count and URLs after every `window.open()` so every page is browser-originated, remains in the same context, and appears as a tab in the same visible browser window. Do not issue multiple `window.open()` calls in one unproven batch.

For a popup or new tab, let Playwright observe the event around the action:

```js
var [popup] = await Promise.all([
  context.waitForEvent('page'),
  input.click(page, page.getByRole('link', { name: 'Open details' }))
])
await popup.waitForLoadState('domcontentloaded')
page = popup
```

When an action may either navigate the current page or open a new one, compare Playwright's pages and current URL before and after the action instead of leaving an unresolved popup promise:

```js
var pagesBefore = new Set(context.pages())
var urlBefore = page.url()
await input.click(page, navigationLocator)
await page.waitForTimeout(500)
var openedPages = context.pages().filter((candidate) => !pagesBefore.has(candidate))
var navigationKind = openedPages.length
  ? 'new-page'
  : page.url() !== urlBefore
    ? 'same-page'
    : 'no-navigation'
if (openedPages.length === 1) page = openedPages[0]
;({ navigationKind, pages: context.pages().map((candidate) => candidate.url()) })
```

Do not assume the outcome.

## CRITICAL: Mandatory Remote Cleanup Gate

**CRITICAL:** This mandatory gate **MUST** be the first activity after the first navigation to each remote origin. Before extracting task content, starting the requested workflow, performing the proving pass, or reporting any result, the agent **MUST** complete all of these steps in order:

1. The agent **MUST** wait roughly 1–2 seconds for delayed consent managers, overlays and popup pages to appear.
2. The agent **MUST** use the capability-detected AI snapshot procedure from **AI-Optimized Element Discovery** as the first DOM inspection, review relevant frames and `context.pages()` with normal Playwright APIs, capture a viewport screenshot, emit it with `opencode.emitImage`, and visually inspect the emitted image. Capturing or emitting a screenshot without visually evaluating it **MUST NOT** be treated as satisfying this step. The AI snapshot or other DOM inspection alone **MUST NOT** be used to conclude that no visible interruption exists.
3. If a cookie or consent prompt is visible, the agent **MUST** choose the affirmative control whose meaning is to accept or allow all cookie categories. Its wording and language vary by site, so the agent **MUST** identify it by meaning rather than rely on a fixed label such as `Accept all`. It **MUST NOT** choose a narrower, rejecting or settings option unless the user asks.
4. The agent **MUST** dismiss every unrelated, benign interruption that has a safe visible dismissal control. This includes newsletter prompts, surveys, promotional modals, chat invitations, interstitials and unrelated popup pages. Controls may mean close, dismiss, cancel, skip, continue without, not now or an equivalent phrase in another language. The agent **MUST** use normal Playwright locators to identify controls and humanized input to activate them. It **MUST NOT** close a popup page until Playwright inspection confirms that the page is unrelated to the requested flow.
5. In a separate pass, the agent **MUST** reinspect the page and open pages, capture and visually inspect a fresh screenshot, and confirm that each cookie prompt, dismissed overlay and unrelated popup is gone and that the intended workflow page is active. A timed-out dismissal click can still have succeeded when the control removed itself; the agent **MUST** judge success by this verified end state and **MUST NOT** retry blindly.

The gate **MUST NOT** be considered complete while a visible cookie prompt or safely dismissible unrelated interruption remains. If a control cannot be identified confidently or the interruption cannot be dismissed, the agent **MUST** stop and inspect rather than begin the task underneath it.

The agent **MUST NOT** automatically dismiss anything that may be relevant to the task, including authentication, permission decisions, destructive confirmations, validation errors, checkout or submission confirmation, file choosers, or dialogs whose consequence is unclear. It **MUST** inspect or ask instead of guessing.

Interruptions can appear later. If a new cookie prompt, overlay, modal, interstitial or popup page appears at any point, the agent **MUST** pause the current workflow immediately, apply the same inspect-dismiss-verify gate, and **MUST NOT** resume the task until that gate is complete.

## CRITICAL: Mandatory Proof Gate Before Automation

**CRITICAL:** The agent **MUST NOT** write or execute a large multi-step script, loop, helper or batch of interactions based on untested assumptions about selectors, page state or transitions. Before automating a flow, it **MUST** use the persistent REPL to complete the proposed flow successfully at least once as small, sequential Playwright operations.

For the proving pass, the agent **MUST** inspect the current state, choose the next locator, perform one interaction, and verify its expected visible result before continuing. A locator resolving successfully **MUST NOT** be treated as proof that the interaction or transition works. The agent **MUST NOT** bundle an unproven next step into the same call.

Only after the complete representative sequence has worked once **MAY** the agent consolidate those exact proven steps into a larger script or repeated automation. If the UI, navigation outcome, popup behavior or other assumption differs from the proving pass, the agent **MUST** stop the automation at that divergence and **MUST** prove the changed path one step at a time before updating the script.

The agent **MUST NOT** preemptively build fallback trees, speculative selector lists, retry loops or broad DOM-evaluation scripts to cover states that have not been observed. It **MUST** inspect the actual state first and **MUST** prove each required branch before including that branch in automation.

The required startup block, read-only inspection and a single isolated interaction **MAY** proceed without a prior proving pass because they are not automation. Irreversible or externally consequential actions **MUST** remain incremental and **MUST NOT** be repeated merely to prove that a consolidated script can replay them.

## Humanized Input

For remote web, pass ordinary Playwright locators directly to `input`:

```js
await input.click(page, page.getByRole('button', { name: 'Continue' }))
await input.fill(page, page.getByLabel('Email'), 'user@example.com')
await input.hover(page, page.getByRole('link', { name: 'Details' }))
await input.check(page, page.getByLabel('Remember me'))
await input.selectOption(page, page.getByLabel('Country'), 'DE')
await input.focus(page, page.getByRole('textbox', { name: 'Search' }))
await input.press(page, 'Enter')
await input.scroll(page, 850)
```

Available methods are `moveTo`, `click`, `doubleClick`, `hover`, `wheel`, `scroll`, `dragTo`, `type`, `fill`, `pressText`, `press`, `focus`, `check`, `uncheck`, and `selectOption`.

`press` and `pressText` operate on the page's currently focused element and accept `(page, key)` and `(page, text)` respectively. Use `focus(page, locator)` first when focus is not already established. Other keyboard and form methods such as `type`, `fill`, `focus`, `check`, `uncheck`, and `selectOption` accept a locator as their second argument.

The module uses locator bounding boxes and hit testing only to execute pointer input against the Playwright-selected target. It does not search for, reinterpret or replace the locator.

Use direct Playwright methods for lifecycle and inspection:

```js
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' })
await page.screenshot({ type: 'png' })
await page.goBack()
var pages = context.pages()
```

Humanized typing is intentionally slower. Long input cells automatically continue as background jobs when they exceed the internal foreground window; use `js_repl_job` to wait for or inspect them.

## Navigation And Inspection

Navigate to the user-requested origin and reach later states through visible UI controls. Do not invent deep links, query strings or form endpoints to bypass the UI.

After completing the mandatory remote cleanup gate, check whether the requested information is already present in the DOM. If it is, read it without unnecessary task interaction. When the current state or target is unclear, inspect a screenshot instead of guessing selectors.

## Session Persistence

Keep browser and Electron sessions open after completing a task. Close them only when the user asks, when switching an exclusive persistent profile between incompatible sessions, or before an unavoidable fatal reset.

```js
if (typeof electronApp !== 'undefined') await electronApp.close().catch(() => {})
if (typeof context !== 'undefined') await context.close().catch(() => {})
if (typeof browser !== 'undefined') await browser.close().catch(() => {})
;('Playwright session closed')
```

After `js_repl_reset`, rerun setup and the complete startup block before interacting again.

If an expected persistent binding such as `browser`, `context`, `page`, or `input` reports `Unknown identifier`, the REPL state was lost, commonly because a service restarted or an old session resumed. The agent **MUST** reload the `playwright-interactive` skill so it has current guidance, rerun setup, and execute one complete current startup block. It **MUST NOT** reconstruct a partial lifecycle from memory or stale tool output in the transcript. After recovery, Camoufox additional pages remain subject to the browser-originated `window.open()` requirement.
