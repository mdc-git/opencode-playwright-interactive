---
name: playwright-interactive
description: Persistent Playwright browser and Electron QA through js_repl, with optional humanized input for remote websites.
---

# Playwright Interactive

Use persistent `js_repl` Playwright handles for browser and Electron QA.

## Startup

Run setup first:

```js
return await tools.js_repl_playwright_setup({})
```

Select exactly one startup mode. A local URL uses standard Chromium, a remote URL uses Camoufox, and Electron uses its own launcher. Do not navigate during startup.

### Local Web

```js
return await tools.js_repl({
  code: `var playwright = await import("playwright");
var chromium = playwright.chromium;
var HEADLESS = false;
// Set only when the user explicitly supplies a profile directory.
var PERSISTENT_PROFILE_DIR = undefined;
var browser;
var context;
if (PERSISTENT_PROFILE_DIR) {
  context = await chromium.launchPersistentContext(PERSISTENT_PROFILE_DIR, { headless: HEADLESS });
  browser = context.browser();
} else {
  browser = await chromium.launch({ headless: HEADLESS });
  context = await browser.newContext();
}
var page = context.pages()[0] || (await context.newPage());
({ status: "Standard Chromium opened", persistentProfile: Boolean(PERSISTENT_PROFILE_DIR) });`,
  timeout_ms: 30000
})
```

Local web uses normal Playwright input. Do not load the humanized input module.

### Remote Web

```js
return await tools.js_repl({
  code: `var core = await import("playwright-core");
var { launchOptions } = await import("camoufox-js");
var path = await import("node:path");
var { pathToFileURL } = await import("node:url");
var HEADLESS = false;
// Set only when the user explicitly supplies a profile directory.
var PERSISTENT_PROFILE_DIR = undefined;
var camoufoxOptions = await launchOptions({ enable_cache: true });
var browser;
var context;
if (PERSISTENT_PROFILE_DIR) {
  context = await core.firefox.launchPersistentContext(PERSISTENT_PROFILE_DIR, {
    ...camoufoxOptions,
    headless: HEADLESS,
  });
  browser = context.browser();
} else {
  browser = await core.firefox.launch({ ...camoufoxOptions, headless: HEADLESS });
  context = await browser.newContext();
}
var page = context.pages()[0] || (await context.newPage());
var humanizedInputPath = path.join(opencode.scriptDir, "humanized-input.mjs");
var { createHumanizedInput } = await import(pathToFileURL(humanizedInputPath).href);
var input = createHumanizedInput();
({ status: "Camoufox opened", persistentProfile: Boolean(PERSISTENT_PROFILE_DIR) });`,
  timeout_ms: 30000
})
```

Camoufox supplies the browser-level anti-detection behavior. `input` supplies only humanized input. Playwright owns browser and context lifecycle, pages, tabs, popups, navigation, locators, frames, shadow DOM, waiting, screenshots, and assertions.

### Electron

```js
return await tools.js_repl({
  code: `var playwright = await import("playwright");
var electronLauncher = playwright._electron;
var ELECTRON_ENTRY = ".";
var electronApp = await electronLauncher.launch({ args: [ELECTRON_ENTRY] });
var appWindow = await electronApp.firstWindow();
appWindow.setDefaultTimeout(10000);
({ status: "Loaded Electron window", title: await appWindow.title() });`,
  timeout_ms: 30000
})
```

Electron uses normal Playwright input and never loads humanized web input.

## Persistent Profiles

Profile persistence is opt-in. Set `PERSISTENT_PROFILE_DIR` only when the user explicitly asks to reuse a profile and supplies the exact directory. Otherwise use `browser.launch()` followed by `browser.newContext()`.

A persistent profile may contain credentials, cookies and browsing history. Never inspect or expose those values unless the task explicitly requires it. If Playwright reports that the profile is locked, ask the user to close the other browser; never delete lock files.

## Element Selection

Use Playwright directly for every element lookup. The humanized input module has no locator, accessibility inventory, frame discovery, overlay discovery, popup handling or tab tracking API.

Prefer Playwright's user-facing locators:

```js
var submit = page.getByRole('button', { name: 'Submit' })
var email = page.getByLabel('Email')
```

Playwright locators pierce open shadow roots by default. Use `frameLocator()` or a frame's own locator APIs for iframes. Use normal Playwright inspection and screenshots to identify overlays. Closed shadow roots are not accessible through standard Playwright locators.

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

## Mandatory Remote Cleanup Gate

This gate is the first activity after the first navigation to each remote origin. Before extracting task content, starting the requested workflow, performing the proving pass, or reporting any result, the agent MUST complete all of these steps:

1. Wait roughly 1–2 seconds for delayed consent managers, overlays and popup pages to appear.
2. Inspect the current page, relevant frames, open shadow roots and `context.pages()` with normal Playwright APIs, and capture a viewport screenshot. The screenshot is mandatory because DOM inspection alone does not prove that no visible interruption exists.
3. If a cookie or consent prompt is visible, choose the affirmative control whose meaning is to accept or allow all cookie categories. Its wording and language vary by site; identify it by meaning rather than relying on a fixed label such as `Accept all`. Do not choose a narrower, rejecting or settings option unless the user asks.
4. Dismiss every unrelated, benign interruption that has a safe visible dismissal control. This includes newsletter prompts, surveys, promotional modals, chat invitations, interstitials and unrelated popup pages. Controls may mean close, dismiss, cancel, skip, continue without, not now or an equivalent phrase in another language. Use normal Playwright locators to identify controls and humanized input to activate them. Close an unrelated popup page with Playwright only after confirming it is not part of the requested flow.
5. Reinspect in a separate pass and confirm that each cookie prompt, dismissed overlay and unrelated popup is gone and that the intended workflow page is active. A timed-out dismissal click can still have succeeded when the control removed itself; judge success by this end state and do not retry blindly.

The gate is not complete while a visible cookie prompt or safely dismissible unrelated interruption remains. If a control cannot be identified confidently or the interruption cannot be dismissed, stop and inspect rather than beginning the task underneath it.

Do not automatically dismiss anything that may be relevant to the task, including authentication, permission decisions, destructive confirmations, validation errors, checkout or submission confirmation, file choosers, or dialogs whose consequence is unclear. Inspect or ask instead of guessing.

Interruptions can appear later. If a new cookie prompt, overlay, modal, interstitial or popup page appears at any point, pause the current workflow immediately, apply the same inspect-dismiss-verify gate, and only then resume the task.

## Proof Gate Before Automation

Do not write or execute a large multi-step script, loop, helper or batch of interactions based on untested assumptions about selectors, page state or transitions. Before automating a flow, use the persistent REPL to complete the proposed flow successfully at least once as small, sequential Playwright operations.

For the proving pass, inspect the current state, choose the next locator, perform one interaction, and verify its expected visible result before continuing. A locator resolving successfully is not proof that the interaction or transition works. Do not bundle an unproven next step into the same call.

Only after the complete representative sequence has worked once may the agent consolidate those exact proven steps into a larger script or repeated automation. If the UI, navigation outcome, popup behavior or other assumption differs from the proving pass, stop the automation at that divergence and prove the changed path one step at a time before updating the script.

Do not preemptively build fallback trees, speculative selector lists, retry loops or broad DOM-evaluation scripts to cover states that have not been observed. Inspect the actual state first.

The required startup block, read-only inspection and a single isolated interaction are not automation and do not require a prior proving pass. Irreversible or externally consequential actions must remain incremental; do not repeat them merely to prove that a consolidated script can replay them.

## Humanized Input

For remote web, pass ordinary Playwright locators directly to `input`:

```js
await input.click(page, page.getByRole('button', { name: 'Continue' }))
await input.fill(page, page.getByLabel('Email'), 'user@example.com')
await input.hover(page, page.getByRole('link', { name: 'Details' }))
await input.check(page, page.getByLabel('Remember me'))
await input.selectOption(page, page.getByLabel('Country'), 'DE')
await input.scroll(page, 850)
```

Available methods are `moveTo`, `click`, `doubleClick`, `hover`, `wheel`, `scroll`, `dragTo`, `type`, `fill`, `pressText`, `press`, `focus`, `check`, `uncheck`, and `selectOption`.

The module uses locator bounding boxes and hit testing only to execute pointer input against the Playwright-selected target. It does not search for, reinterpret or replace the locator.

Use direct Playwright methods for lifecycle and inspection:

```js
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' })
await page.screenshot({ type: 'png' })
await page.goBack()
var pages = context.pages()
```

Humanized typing is intentionally slower. Use `timeout_ms: 60000` or higher for `js_repl` calls containing `input.fill`, `input.type`, or long text.

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
