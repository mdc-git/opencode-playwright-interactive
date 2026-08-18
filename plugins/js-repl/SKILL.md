---
name: playwright-interactive
description: Persistent Playwright browser and Electron QA through js_repl, with standard Playwright for local apps and managed stealth for remote websites. Use when opening, debugging, testing, or visually inspecting local web apps, responsive interfaces, remote websites, or Electron applications.
license: Apache-2.0
compatibility: OpenCode V2 with the js-repl plugin and Node.js 22.22 or newer
metadata:
  source: openai/skills playwright-interactive
  adapted-for: opencode
---

# Playwright Interactive

Use persistent `js_repl` browser handles for iterative browser and Electron QA.

## Required Startup Selection

The words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** throughout this skill are interpreted as described in RFC 2119.

Run setup first:

```js
return await tools.js_repl_playwright_setup({})
```

For every browser or Electron request, the agent **MUST** run setup as above, then select exactly one startup mode before the first `tools.js_repl` call:

- **Electron:** use Electron startup only. Do not launch Chromium or load the stealth runtime.
- **Local web app:** use standard Chromium startup. A request to start, open, inspect, or test "the dev server" in the current workspace is local even before its port is known. A target is also local when the user identifies it as running on the local machine, or its URL uses `file:`, `localhost`, `*.localhost`, `127.0.0.0/8`, or `[::1]`. Do not load or use the stealth runtime.
- **Remote website:** use managed Camoufox stealth startup.

If the target mode cannot be determined from the request, ask for the target URL or application type before startup. Do not start stealth and later switch a local target to standard mode.

### Electron Startup

Send this complete block as the first `execute` call after setup:

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

Set `ELECTRON_ENTRY` to `.` when `package.json.main` is correct, or use a direct main-process path. Do not add Chromium setup to this block.

### Standard Local Web Startup

Send this complete block as the first `execute` call after setup:

```js
return await tools.js_repl({
  code: `var playwright = await import("playwright");
var chromium = playwright.chromium;
var HEADLESS = false;
// Set only when the user explicitly provides a profile directory.
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
var page = await context.newPage();
var localBrowserSession = opencode.bindBrowser({ browser, context, profileKind: "local" });
var localBrowserBinding = localBrowserSession.binding;
var assertLocalPage = localBrowserSession.assertPage;
({ status: "Standard Chromium opened", binding: localBrowserBinding });`,
  timeout_ms: 30000
})
```

Set `HEADLESS = true` only when the environment has no graphical display. Local mode uses ordinary Playwright locators, input, pages, contexts, screenshots, and lifecycle methods. The agent **MUST NOT** import `stealth-runtime.mjs`, create a stealth controller, use a stealth profile, or apply managed behavioral input in this mode.

### Managed Remote Web Startup

There are no alternative remote browser initialization steps. The agent **MUST NOT** read, grep, extract, copy, reconstruct, evaluate, or inspect `SKILL.md`, `scripts/stealth-runtime.mjs`, or saved tool output before startup. The agent **MUST NOT** use `eval`, `new Function`, `vm`, or a subagent. The agent **MUST NOT** call `chromium.launch()` or `chromium.launchPersistentContext()` directly, create a non-managed context, or define another `ensureWebBrowser` for a remote target.

Send this complete block as the first `execute` call after setup:

```js
return await tools.js_repl({
  code: `var core = await import("playwright-core");
var { launchOptions } = await import("camoufox-js");
var chromium = {
  launchPersistentContext: async (userDataDir, overrideOptions) =>
    // enable_cache is REQUIRED: camoufox disables caching by default and the
    // official docs state page.go_back()/go_forward() do not work without it.
    core.firefox.launchPersistentContext(userDataDir, { ...(await launchOptions({ enable_cache: true })), ...overrideOptions }),
};
var path = await import("node:path");
var fs = await import("node:fs/promises");
var { pathToFileURL } = await import("node:url");
var HEADLESS = false;
// Set only when the user explicitly provides a profile directory.
var PERSISTENT_PROFILE_DIR = undefined;
var stealthRuntimePath = path.join(opencode.scriptDir, "stealth-runtime.mjs");
await fs.access(stealthRuntimePath);
var { installStealthRuntime } = await import(pathToFileURL(stealthRuntimePath).href);
var stealthRuntime = await installStealthRuntime({
  chromium,
  browserEngine: "camoufox",
  opencode,
  headless: HEADLESS,
  webProfileDir: PERSISTENT_PROFILE_DIR,
});
var ensureWebBrowser = stealthRuntime.ensureWebBrowser;
var ensureMobileBrowser = stealthRuntime.ensureMobileBrowser;
var stealth = await ensureWebBrowser();
var context = stealth.context;
var browser = context.browser();
// Reuse Camoufox's initial page so startup does not create an extra window.
var page = stealth.pages()[0] || (await stealth.newPage());
var stealthCapabilities = stealth.capabilities();
if (
  stealthCapabilities.managedInput !== true ||
  stealthCapabilities.persistentIdentity !== true ||
  stealthCapabilities.automaticPagesAndPopups !== true ||
  stealthCapabilities.binding?.sessionId !== opencode.sessionId ||
  stealthCapabilities.identity?.browserIdentity !== "native" ||
  stealthCapabilities.identity?.userAgentOverride !== false ||
  stealthCapabilities.identity?.automationControlledOverride !== true
) {
  await stealth.close().catch(() => {});
  throw new Error("Managed stealth capability verification failed");
}
({ status: "Managed stealth browser opened", capabilities: stealthCapabilities });`,
  timeout_ms: 30000
})
```

The agent **MUST NOT** split, shorten, rewrite, or precede the selected startup block with exploratory `js_repl` calls. In remote mode, `Managed stealth browser opened` is the only successful startup result. If setup or the selected block fails, the agent **MUST** stop and report the exact error without attempting another startup mode.

For managed remote startup, set `HEADLESS = true` only when the environment has no graphical display. Do not change any other line in that block.

## Standard Local Web Rules

- Use ordinary Playwright APIs directly, such as `page.getByRole()`, `locator.click()`, `locator.fill()`, `page.mouse`, `page.keyboard`, `context.pages()`, and `context.newPage()`.
- `opencode.bindBrowser()` provides the shared session-binding checks used by local and managed remote mode. `localBrowserBinding` identifies the OpenCode session and standard Chromium process. Call `assertLocalPage(page)` before every interaction call and after any page, context or browser lifecycle event. It rejects closed pages and pages from another context or browser.
- If the bound standard Chromium browser is closed or disconnected, stop. Do not launch a replacement, connect over CDP, enumerate other browsers or reuse a page from another context. A new browser may be opened only after the user explicitly requests it and the REPL has been reset.
- Use `page.screenshot()` for captures. Call `browser.close()` only when the user explicitly asks to close the browser or before an unavoidable fatal reset while the kernel is still responsive. Normal task completion is not cleanup.
- Do not use any `stealth`, `mobileStealth`, `ensureWebBrowser`, or `ensureMobileBrowser` APIs.
- Before every local-mode `tools.js_repl` call, inspect its `code` payload. If it contains a stealth-runtime identifier such as `stealth`, `mobileStealth`, `interactiveElements`, or `resolveVisible`, do not execute it; replace it with the ordinary Playwright equivalent.
- For mobile-sized local QA, create a normal context with the required viewport and touch options rather than using the stealth mobile controller.
- Never use a personal browser profile unless the user explicitly supplies its
  directory and asks for it to be reused.

### Explicit Persistent Profiles

Browser profile persistence is opt-in. If the user explicitly asks to reuse a
profile and supplies a directory, set `PERSISTENT_PROFILE_DIR` to that exact
directory in the selected startup block. Do not infer, choose, or reuse a
profile directory when the user has not supplied one.

- Local web uses Chromium's `launchPersistentContext()` with the supplied directory.
- Remote web passes the supplied directory through the managed Camoufox runtime.
- The directory is exclusive while its browser is running; report the profile-lock error and ask the user to close the other browser rather than deleting lock files or profile data.
- Do not combine a supplied profile directory with a different startup mode or silently fall back to an ephemeral profile.
- A supplied profile can contain cookies, credentials, history, and other sensitive state. Use it only for the user's explicit request and do not expose its contents.
- When no directory is supplied, retain the normal ephemeral local context or session-scoped managed remote profile.

## Managed Remote Web Rules

The managed-controller sections from **Scrolling** through **Mobile** apply only to remote web mode. Standard local web and Electron mode must ignore all instructions in those sections that require `stealth`, controller-produced locators, managed input, or stealth screenshots.

- Every managed page **MUST** belong to the controller returned by `ensureWebBrowser()` or `ensureMobileBrowser()`.
- Use `stealth.newPage()` rather than `browser.newPage()`.
- Use controller methods with an explicit `Page` for behavior-sensitive input.
- Direct locator, mouse, keyboard, touchscreen, and DOM mutation calls are ordinary unmanaged Playwright and do not receive behavioral shaping.
- Each OpenCode session gets its own browser profile under its unique `opencode.tmpDir`, so multiple OpenCode sessions can run browsers simultaneously without conflict. Desktop and mobile within one session share that session's profile and must run sequentially.
- `stealth.binding` and `stealth.pageState(page)` identify the OpenCode session, managed browser and managed page. Before resuming after any browser lifecycle change, the agent **MUST** verify that the active controller and page report the same binding. A controller rejects pages, locators and profile metadata from another session.
- Never use a personal browser profile.

The runtime keeps the browser's native user agent and identity. Setup installs Playwright 1.60 for standard local Chromium and Electron QA, plus Camoufox — a Firefox fork with anti-detection built into the browser itself: fingerprints are injected at the C++/Juggler level, page-agent JavaScript runs sandboxed outside the page's scope, and `navigator.webdriver` is hidden natively. The managed remote runtime drives Camoufox through `playwright-core`'s `firefox`; Chromium stealth flags are never applied to it. The runtime rejects caller-supplied identity-critical launch options, context options, HTTP headers, and browser arguments rather than combining contradictory browser, locale, viewport, device, or automation claims. Mobile mode is responsive touch emulation, not Safari or physical-device impersonation. Managed input is task-bound: the runtime emits no ambient pointer movement while idle.

### Diagnostics And Sensitive Artifacts

Use `stealth.identity`, `stealth.capabilities()`, `stealth.telemetry()`, and `stealth.pageState(page)` for coarse diagnostics. They report browser/version policy, emulation mode, managed-action counts, navigation counts, popup counts, failures, and the most recent main-document status, and they record no page fingerprints, interaction traces, or credentials. URLs appear only where targeting needs them: element inventories list computed roles, accessible names, and control states, and target-resolution errors report the frame URLs that were searched.

```js
;({
  identity: stealth.identity,
  telemetry: stealth.telemetry(),
  page: stealth.pageState(page)
})
```

Traces, HAR files, video, screenshots, storage state, cookies, and challenge tokens may contain credentials or personal data. Capture only what the task requires, avoid recording secret-bearing states, do not print tokens or cookies, and keep emitted diagnostics coarse. The managed runtime leaves tracing, HAR, and video disabled by default.

## Navigate

Start and verify the application server before navigating. Prefer `127.0.0.1` over `localhost`.

```js
var TARGET_URL = 'http://127.0.0.1:3000'
page.setDefaultTimeout(10000)
page.setDefaultNavigationTimeout(30000)
await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' })
;({ url: page.url(), title: await page.title() })
```

Do not navigate during startup merely to prove that the browser opened. The selected startup block's result is sufficient.

## Navigation Integrity

`page.goto()` opens a site, not an application action. The agent **MUST NOT** use a deep link, query string, fragment, result URL, form endpoint, or guessed route to bypass the user-facing flow. It **MUST** navigate only to the requested site’s origin, then use the visible UI with the input API for the selected mode to complete the request. For example, to search Google, navigate to `https://www.google.com/`, inspect the page, fill the visible search field, and submit it; never navigate directly to `https://www.google.com/search?q=...`.

The same rule applies after recovery and to local applications: use the application origin root, then reach every state through visible controls. A URL supplied verbatim by the user may be opened as requested, but its path, query, and fragment must not be invented, edited, or reused to shortcut an interaction.

## First Visit Cleanup

After the first navigation to a remote origin in the current browser profile, the agent **MUST** wait briefly for delayed consent managers and modal frames to attach, then run a first-visit cleanup gate before performing the user’s task or reporting completion. Use the controller’s normal post-navigation grace window or an explicit wait of roughly 1–2 seconds, not an arbitrary stability loop. It **MUST** inspect the complete cross-frame interactive inventory and capture a viewport screenshot; inventory alone is not evidence that a banner or modal is absent. If the inventory or screenshot shows a cookie consent banner, the agent **MUST** accept it using its affirmative control such as `Accept All`, `Accept`, or `Allow`; do not choose a narrower or rejecting option unless the user asks. If the inventory or screenshot shows a benign, dismissible modal overlay, the agent **MUST** dismiss it using its visible `Close`, `Dismiss`, or `Cancel` control, including overlays hosted in iframes or shadow roots. When the screenshot reveals a control missing from the inventory, use the screenshot’s actual visible wording with `resolveVisible()` and inspect the result before acting. If neither the inventory nor screenshot shows a cookie banner or benign modal, the gate is complete and the agent may proceed. Verify any accepted or dismissed overlays are gone in a separate inspection pass, and use the self-removing-control guidance if a dismissal click times out.

## Information Before Interaction

Before any browser interaction, the agent **MUST** decide whether the request can be answered from the current document DOM/source. An interaction includes navigation, clicking, filling, pressing, hovering, dragging, tapping, scrolling, or any other input. If the needed information is already present in the current DOM/source, the agent **MUST** inspect it and answer directly without interacting. Text outside the viewport or a scroll container can still already be present in the DOM; it is not evidence that scrolling or clicking is required.

Use locator-scoped DOM inspection or `evaluate` only to read the current page state; neither may mutate the page or trigger application behavior. For remote mode, this does not relax the cross-frame controller rules for finding controls.

If the information is not present, or the user asks to change application state, use the smallest necessary visible UI flow. Use managed input in remote mode and ordinary Playwright input in local mode. Do not substitute a deep link, a constructed URL, or any other shortcut for that interaction.

## Fallback, Empty, And Partial States

Do not treat a fallback, empty-state, loading message, error notice, or one matching heading as proof that the requested content is absent. Modern pages often keep a placeholder, failed variant, duplicate responsive variant, or collapsed summary in the DOM alongside the real content. Before reporting absence or using a fallback as the answer, inspect the complete relevant result region and reconcile all matching occurrences across the main document and frames.

For content extraction, prefer the largest semantically relevant visible container over the nearest ancestor of a heading. Collect the visible text and state of every matching region, then distinguish these cases explicitly: requested content found, requested feature unavailable, still loading, or extraction ambiguous. If multiple variants disagree, do not choose the first match. Capture and inspect a screenshot, wait once for the page's normal render window, and re-read the relevant regions. Report a fallback only when the fallback state remains after that verification and no matching content is present elsewhere.

Never infer absence from a short result such as a heading-only container, an empty text node, a failed narrow selector, or a single DOM occurrence. A fallback sentence is evidence about one region, not the whole page.

## Scrolling

Use managed scrolling only when the current DOM/source does not already answer the request or the user requires a visible state change. To scroll the document at the current pointer position, use `await stealth.scroll(page, 850)`. To scroll a nested panel, list, or other surface, pass its controller-produced locator and the delta: `await stealth.scroll(page, panelLocator, 850)`. This moves the pointer to the intended surface before issuing the humanized wheel sequence.

Passing a locator without a delta, `await stealth.scroll(page, targetLocator)`, preserves the existing behavior of bringing that target into view. Do not send raw mouse-wheel calls or script `scrollTop`; use the controller method so scrolling stays managed.

## Closed Browser Isolation

If a user closes the browser window or process, the managed context and every former `page` handle are gone. The controller enters `externally-closed` state and reports the session and browser binding that was closed. This is **not** a navigation, selector, popup, screenshot, or stale-page diagnostic.

On that error, the agent **MUST NOT** call `ensureWebBrowser()` or `ensureMobileBrowser()`, inspect pages, screenshot, create a page, navigate, retry an action or use any other visible browser window. It **MUST** stop and report that the browser bound to this OpenCode session was closed. The runtime refuses to relaunch from that controller or adopt a browser owned by another session.

A new browser may be opened only after the user explicitly requests it. Reset the REPL, rerun setup and the complete startup block, then verify the new `stealth.binding` before navigating. The new controller remains scoped to the same OpenCode session and its own profile.

## Tabs And Navigation

A click may navigate the current page, open a new tab or popup, or leave navigation unchanged. The agent **MUST NOT** assume which outcome occurred. For any click that may navigate, snapshot the managed pages and current URL, perform the click, then resolve the observed outcome:

```js
var pageBeforeClick = page
var urlBeforeClick = page.url()
var pagesBeforeClick = new Set(stealth.pages())
await stealth.click(page, navigationLocator)

var openedPages = []
var navigationDeadline = Date.now() + 5000
while (Date.now() < navigationDeadline) {
  openedPages = stealth.pages().filter((candidate) => !pagesBeforeClick.has(candidate))
  if (
    openedPages.length ||
    (!pageBeforeClick.isClosed() && pageBeforeClick.url() !== urlBeforeClick)
  )
    break
  await new Promise((resolve) => setTimeout(resolve, 50))
}

var navigationKind = openedPages.length
  ? 'new-page'
  : !pageBeforeClick.isClosed() && pageBeforeClick.url() !== urlBeforeClick
    ? 'same-page'
    : 'no-navigation'

if (openedPages.length === 1) page = openedPages[0]
else page = pageBeforeClick
if (navigationKind !== 'no-navigation' && !page.isClosed()) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
}
;({ navigationKind, pages: stealth.pages().map((candidate) => candidate.url()) })
```

New tabs and popups are registered automatically by the controller. After a navigation-capable click, the agent **MUST** update the shared `page` handle when one new page opened and **MUST** inspect `stealth.pages()` when multiple pages opened or the observed UI is not on the expected page. It **MUST NOT** keep querying the original tab merely because that handle still exists. A new tab is possible, not guaranteed; do not require one unless the application behavior requires it.

For history back/forward navigation, use `page.goBack()` / `page.goForward()`; they work on the Camoufox driver because startup enables `enable_cache`. Avoid expecting `Alt+ArrowLeft` or other browser-chrome shortcuts to navigate: Juggler-synthesized input does not trigger chrome-level shortcuts in Firefox (fails on vanilla Playwright Firefox too).

## Stuck Or Guessing

If the agent cannot confidently identify the current UI state or the correct interaction target, it **MUST** stop guessing and inspect a screenshot. This rule applies immediately after any one of these conditions:

- One locator or managed action fails because the expected element is missing, ambiguous, obscured, or timed out.
- One DOM inspection pass does not clearly establish what to interact with next.
- The page differs from the expected state, or the agent is considering speculative selectors, repeated scripts, broad `evaluate()` calls, or source inspection to infer what is visible.

If the unexpected state followed a click, first list the open managed pages and their URLs because the destination may be in another tab:

```js
stealth.pages().map((candidate, index) => ({
  index,
  url: candidate.url(),
  closed: candidate.isClosed()
}))
```

Select the page containing the expected destination before taking the required screenshot. Do not screenshot and debug a stale opener tab when the click opened a new managed page.

Before running another inspection script or attempting another locator, capture the current viewport and emit it:

```js
var stuckScreenshot = await stealth.screenshot(page, {
  type: 'png',
  scale: 'css',
  fullPage: true
})
await opencode.emitImage({
  bytes: stuckScreenshot,
  mimeType: 'image/png',
  filename: 'playwright-stuck-state.png'
})
```

The agent **MUST** visually inspect the emitted image before choosing the next action. It **MUST NOT** continue cycling through selectors, code inspection, or speculative scripts without this visual checkpoint. For mobile, use `mobileStealth.screenshot(mobilePage, ...)` with the same options. Screenshots **SHOULD** use `fullPage: true`; fall back to a viewport capture only when full-page capture fails or exceeds the image attachment limit.

## Dynamic And Framed UI

`page.getByRole()` and other bare `page.*` locators search the main frame only, never child frames or shadow roots. Because of this, **the first lookup for any visible control should go through the controller**, never a bare `page.getByRole(...)`. Cross-frame lookup is the default posture, not an opt-in:

```js
// preferred, frame- and shadow-root-aware:
var t = await stealth.resolveVisible(page, (frame) =>
  frame.getByRole('button', { name: 'Continue' })
)
// avoid: bare main-document-only lookup
await stealth.click(page, page.getByRole('button', { name: 'Continue' }))
```

A control you can see on screen may live in a same-origin or cross-origin iframe, and child frames may attach asynchronously after `domcontentloaded`. Absence of an element from the main-frame DOM is **never** evidence that a visible control is absent from the browser UI. In particular, cookie/consent/data-protection banners are commonly hosted in a third-party iframe (a "CMP") precisely to keep them out of the main document.

When the exact accessible name is already known, resolve it across current and newly attached frames through the controller. If the role/name lookups miss (for example the site's markup makes the browser compute a role or name different from the raw attributes), `resolveVisible()` also re-checks the browser-computed interactive inventory and returns its controller-owned locator when that semantic match is unique:

```js
var resolvedTarget = await stealth.resolveVisible(
  page,
  (frame) => frame.getByRole('button', { name: 'Continue', exact: true }),
  { timeout: 5000 }
)
await stealth.click(page, resolvedTarget.locator)
resolvedTarget.frame.url()
```

When the exact element is unknown, take one snapshot of the browser accessibility tree across every current frame and open shadow root. The first inventory after navigation allows one short render window for asynchronously attached UI; it does not wait for element counts to settle or truncate the result, and later inventories are immediate. It returns live locators plus semantic evidence; choose the element whose role, accessible-name evidence, state, and context fit the user's request. On very large pages the caller **MAY** bound the result with `{ limit: N }` (default is untruncated):

```js
var interactive = await stealth.interactiveElements(page)
interactive
  .map(
    (entry, index) =>
      index + ' ' + entry.role + ' ' + JSON.stringify(entry.name) + ' disabled=' + entry.disabled
  )
  .join('\n')
```

The agent **MUST** read the complete inventory and identify the intended entry semantically. Before that review it **MUST NOT** filter entries by role, frame, URL, guessed keyword, or language-specific regex; controls that look like buttons may be links or custom-role elements. Once identified, retain and interact with the returned locator directly, for example `var target = interactive[index]; await stealth.click(page, target.locator)`. It **MUST NOT** discard that locator and reconstruct `getByRole()` from the reported role: the inventory reports the browser-computed accessible role and name (real WAI-ARIA name computation, including `aria-labelledby` chains, `<label>` elements, and shadow-root content), which can differ from the raw markup. If no inventory entry clearly fits the request, capture and visually inspect the required full-page screenshot; use its actual visible wording with `stealth.resolveVisible()` rather than guessing another selector. If a frame or control attaches after the snapshot, take one fresh complete inventory rather than waiting for arbitrary DOM stability.

The agent **MUST NOT** conclude that a requested visible control does not exist after querying only the main frame. It **MUST NOT** inspect frames one by one across multiple tool calls when these controller methods can establish the result once.

### Structural Containers Are Not Controls

ARIA landmarks and structural roles such as `search`, `main`, `navigation`, `banner`, `region`, `heading`, `list`, and `presentation` normally describe containers. The agent **MUST NOT** click, fill, or otherwise act on a structural element with one of these roles. It must locate the nested `button`, `link`, `textbox`, `searchbox`, or `combobox` instead.

Sites sometimes put a structural role on a native control: an `<a href="/search" role="search">` is still clickable, and the browser reports it under the explicit `search` role with a pointer cursor. `interactiveElements()` keeps any element the browser also reports with a pointer cursor, under its computed role, so such controls stay actionable while plain landmarks and focusable content containers stay excluded. The computed role is selection evidence, not a valid `getByRole()` query for such markup; use the returned locator. If a screenshot shows a search affordance but the inventory has no matching control, use the visible wording to resolve a nested actionable role across frames. If that still produces no clear target, follow **Stuck Or Guessing** rather than clicking the surrounding container.

## Target Diagnostics

Playwright locators can resolve elements inside frames and open shadow roots. A uniquely resolved, visible locator can still fail because of an overlay, animation, retargeted hit testing, or another interaction boundary. After the required screenshot, the agent **SHOULD** diagnose all of these in one locator-scoped call rather than separately probing documents, every frame, and possible shadow roots:

```js
var targetDiagnostic = await targetLocator.evaluate((element) => {
  var rect = element.getBoundingClientRect()
  var root = element.getRootNode()
  var hitTestRoot = typeof root.elementFromPoint === 'function' ? root : element.ownerDocument
  var hit = hitTestRoot.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
  return {
    frameUrl: element.ownerDocument.defaultView?.location?.href,
    rootType: root.constructor?.name,
    tag: element.tagName,
    role: element.getAttribute('role'),
    text: element.textContent?.trim().slice(0, 120),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    hitTag: hit?.tagName,
    hitClass: typeof hit?.className === 'string' ? hit.className : undefined,
    targetOwnsHit: hit === element || element.contains(hit)
  }
})
targetDiagnostic
```

Because `locator.evaluate()` runs in the target's own realm, this single inspection already identifies its frame URL and document-versus-shadow-root context. The agent **MUST NOT** repeat the same failed managed action unchanged or enumerate unrelated frames and roots after this diagnostic. If an unrelated element owns the hit point, wait for or dismiss the blocking UI using managed input. If the target owns the hit point but the managed action still fails, report the controller defect with the diagnostic and screenshot instead of silently forcing the action.

## Self-Removing Controls And Dismissals

A **dismiss action — clicking an accept/reject/close control — often deletes the very element (and its parent frame or overlay) that was just clicked.** Accepting a cookie banner tears down the CMP iframe; closing a modal removes the dialog. Playwright's `click()` then keeps waiting on a now-gone element and can raise a timeout _even though the click worked_. A timeout after such an action is therefore **not proof of failure**: a click that succeeded might still surface as a timeout.

```js
// Run the dismiss action in its own js_repl call.
await stealth.click(page, target.locator, { timeout: 5000 })
```

Whether the action resolves or reports an error, verify the result in a separate `js_repl` call so an unexpectedly slow inventory cannot keep the action cell running:

```js
await page.waitForTimeout(1200)
var stillThere = await stealth
  .interactiveElements(page)
  .then((list) => list.filter((e) => /Einverstanden|Alle akzeptieren/i.test(e.name || '')))
  .then((hits) => hits.length)
stillThere === 0
```

After a dismiss click, the agent **must** judge success by the _desired end-state_ (the banner gone, the intended page shown), not by whether `click` resolved cleanly. If the click threw but the end-state is already achieved, treat it as success. Do not rerun startup or screenshot repeatedly because the parent node detached.

Because such controls are often the dismiss button of a frame-hosted banner, diagnosing them follows the same cross-frame rules as `Dynamic And Framed UI`.

## The REPL Call Budget

### Errors And Timeouts

Let unexpected JavaScript and Playwright errors reject normally. A timeout is different: it abandons only the tool call while the cell continues running and may commit bindings later. After a timeout, do not rerun the action; confirm the real state with one short cell, then follow the bounded diagnosis below.

Each `js_repl` call has a default duration cap. A timeout ends only the tool call: the cell and every live handle (`playwright`, `stealth`, `page`) remain in the kernel, and later calls wait behind the unfinished cell. Multi-step sequences (`click` page-timeout + `waitForTimeout(9000)` + networkidle) routinely exceed 30 seconds. To keep the session responsive:

- Set `timeout_ms` on every call that chains waits or uses managed typing. A click’s default page timeout is 10s, so a single click+wait can consume 15–20s. `stealth.fill`, `stealth.type`, and `stealth.pressText` use humanized per-key timing and can take materially longer than ordinary Playwright input, even for short strings. Budget at least 60s for a cell containing managed typing, and add navigation/wait time on top of that.
- **Do not put successive waits in one call.** Split long flows across separate `js_repl` calls so none trips the cap.
- For a typing-driven navigation flow, resolve and fill the field in one call, then press/verify in a later call. If combining them is necessary, use `timeout_ms: 60000` or higher rather than the 30s default.
- Do not repeat an action after a timeout: the original cell may still complete. Treat the result as ambiguous and begin diagnosis rather than retrying.
- After the first timeout, run one bounded diagnostic cell that lists managed pages and URLs, reports `stealth.pageState(page)` and `stealth.telemetry()`, and captures a full-page screenshot. Inspect that screenshot and use the evidence to identify whether the action completed, a page changed, an overlay blocked it, or the controller/browser is unhealthy. Do not enqueue speculative selectors or modified actions before this diagnosis.
- If that diagnostic cell also times out, the action queue is blocked and no screenshot or further in-kernel debugging can run. Use `js_repl_reset` as the last resort, then rerun the full startup block and reproduce the user-visible state through the normal UI flow. A reset is recovery from an unrecoverable kernel, not the default response to a single action timeout.
- To stop an indefinitely stuck cell, use `js_repl_reset`; it destroys every live handle, so rerun the full startup block before touching `page`.
- Prefer resuming the existing session over resetting it: the persistent profile makes the open page recoverable.

## Managed Input

Use the session controller as the default interaction surface, and drive every action from a **controller-produced locator** (from `resolveVisible` or `interactiveElements`) rather than from a raw `page.getByRole(...)` you wrote yourself:

```js
var target = await stealth.resolveVisible(page, (frame) =>
  frame.getByRole('button', { name: 'Continue', exact: true })
)
await stealth.click(page, target.locator)
var email = await stealth.resolveVisible(page, (frame) => frame.getByLabel('Email'))
// Managed typing is cadence-shaped; give this cell enough REPL time.
await stealth.fill(page, email.locator, 'user@example.com')
await stealth.press(page, 'Enter')
var details = await stealth.resolveVisible(page, (frame) =>
  frame.getByRole('link', { name: 'Details' })
)
await stealth.hover(page, details.locator)
await stealth.check(
  page,
  (await stealth.resolveVisible(page, (frame) => frame.getByLabel('Remember me'))).locator
)
await stealth.selectOption(
  page,
  (await stealth.resolveVisible(page, (frame) => frame.getByLabel('Country'))).locator,
  'DE'
)
```

`stealth.*` action methods **MUST** receive a locator produced by `resolveVisible` or `interactiveElements` (which accept a `frame => frame.getByRole(...)` callback and search every current and newly attached frame plus open shadow roots). Pass bare `page.getByRole(...)` or `page.getByLabel(...)` locators to a controller action **only** when you have already confirmed the control is in the main document; never reach for one as the default. A bare `page.getByRole("button", { name: "X" })` resolves only in the main document, so the moment a control sits in a frame or shadow root (a cookie/consent banner, a login iframe, an embedded widget), that locator silently misses it and times out. With the exact name unknown, obtain the locator from the inventory instead:

```js
var interactive = await stealth.interactiveElements(page);
await stealth.click(page, interactive[<index>].locator);
```

Available methods include `resolveVisible`, `interactiveElements`, `moveTo`, `click`, `doubleClick`, `hover`, `wheel`, `scroll`, `dragTo`, `type`, `fill`, `pressText`, `press`, `focus`, `check`, `uncheck`, `selectOption`, `tap`, `think`, `screenshot`, and `stop`.

## Mobile

Managed mobile mode is a responsive-touch cohort with a 390x844 viewport, matching screen dimensions, and device scale factor 3. It deliberately retains the engine's native version-coherent user agent instead of claiming to be iPhone Safari.

Desktop and mobile cannot share the session profile concurrently. Only when the user explicitly requests a switch to mobile, close desktop first and then use the existing runtime:

```js
await stealth.close()
var mobileStealth = await ensureMobileBrowser()
var mobileContext = mobileStealth.context
var mobilePage = mobileStealth.pages()[0] || (await mobileStealth.newPage())
;({ status: 'Managed mobile stealth browser opened', capabilities: mobileStealth.capabilities() })
```

Use `mobileStealth.tap(mobilePage, locator)` for managed touch input.

The remaining sections apply to every selected mode unless stated otherwise.

## Reload

Reuse the current page across iterations:

```js
await page.reload({ waitUntil: 'domcontentloaded' })
```

Do not rerun startup after ordinary application changes. Rerun it only after `js_repl_reset`, kernel termination, or a new OpenCode session.

## Functional QA

- Inventory the user requirements, visible controls, state transitions, and claims after application startup.
- Exercise every relevant control with the input API for the selected mode.
- Verify one end-to-end critical flow and its visible result.
- Verify toggles and reversible controls in initial, changed, and restored states.
- Use `evaluate` for inspection only; it does not count as signoff input.
- Run a short exploratory pass after scripted checks.

## Visual QA

- Inspect the initial viewport and every relevant post-interaction state.
- Check clipping, overflow, distortion, spacing, alignment, contrast, layering, and motion.
- Test the minimum supported viewport and the densest realistic state.
- Prefer viewport screenshots and use full-page captures only as secondary evidence.

```js
var screenshotBytes = await page.screenshot({
  type: 'jpeg',
  quality: 85,
  scale: 'css'
})
await opencode.emitImage({
  bytes: screenshotBytes,
  mimeType: 'image/jpeg',
  filename: 'playwright-current.jpg'
})
```

Use `appWindow.screenshot()` instead in Electron mode.

## Electron

Electron is always separate from managed stealth and uses the Electron startup block. Use ordinary Playwright APIs against `appWindow`.

Do not create scratch pages from an Electron context. Reload renderer-only changes with `appWindow.reload()` and relaunch for main-process, preload, startup, or process-ownership changes.

## Browser Persistence And Explicit Close

Browser and Electron sessions remain open after the requested task is complete so the user can inspect the result and continue in a later turn. The agent **MUST NOT** call `stealth.close()`, `mobileStealth.close()`, `browser.close()`, `context.close()`, `electronApp.close()`, `js_repl_reset`, or the cleanup block below merely because it is about to answer, has finished verification, has encountered a recoverable site error, or is ending the task. It **MUST NOT** print `Playwright session closed` unless it actually closed the session for one of the allowed reasons.

Closing is allowed only when:

- The user explicitly asks to close the browser or application.
- The user explicitly requests a desktop/mobile mode switch that requires closing the active profile first.
- An unrecoverable blocked or fatally corrupted kernel requires `js_repl_reset`. If the kernel still accepts calls, close owned resources first. If it is blocked, reset directly rather than enqueueing cleanup behind the blocked cell.
- Startup capability verification fails before a usable managed session is established.

For an explicit close request or a responsive fatal-reset path, close only resources owned by this OpenCode session:

```js
if (typeof electronApp !== 'undefined') await electronApp.close().catch(() => {})
if (typeof mobileStealth !== 'undefined') await mobileStealth.close().catch(() => {})
if (typeof stealth !== 'undefined') await stealth.close().catch(() => {})
if (typeof stealth === 'undefined' && typeof browser !== 'undefined')
  await browser.close().catch(() => {})
;('Playwright session closed')
```

Wait for `Playwright session closed` before resetting the REPL when cleanup can run. Do not reset after an ordinary explicit close unless the user also requests a new browser. Normal remote-mode close preserves the stealth session profile. `await stealth.resetProfile()` is destructive: it closes the remote session and deletes its complete dedicated identity without relaunching, so use it only when the user explicitly requests a profile reset.

## Remote Stealth Limits

It improves persistent identity, lifecycle consistency, task-bound humanized input, and identity coherence, and it relies on Camoufox's native anti-detection patches — C++-level fingerprint injection, sandboxed page-agent execution, and `navigator.webdriver` hiding — instead of Chromium JavaScript-level stealth flags, but it does not guarantee undetectability. It does not spoof another browser, generate ambient input, rotate network identity, or manipulate challenge systems. TLS/HTTP-2 fingerprinting, GPU and OS-level signals, profile history, worker and service-worker realms, and long-horizon behavioral coherence remain outside skill control.
