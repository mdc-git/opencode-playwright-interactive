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

### Code Mode Routing

When `js_repl` is exposed inside the `execute` tool's Code Mode catalog, `execute` is only an orchestrator. Node.js source such as `import(...)`, `require(...)`, Playwright calls, and browser variables **MUST NOT** appear at the top level of `execute` code. Put all such source inside the `code` string passed to `tools.js_repl`.

Call setup through `execute` with exactly this orchestration code:

```js
return await tools.js_repl_playwright_setup({});
```

Every later REPL example in this skill is also a `tools.js_repl` payload. If an example is not already wrapped, call it through `execute` in this form:

```js
return await tools.js_repl({
  code: `// REPL source goes here, including any import(...) expression`,
  timeout_ms: 30000,
});
```

The outer `code: ` template literal cannot contain an unescaped backtick. Before wrapping a REPL snippet, replace any inner template literal with string concatenation or encode the complete snippet as a quoted JSON string. The agent **MUST NOT** nest a REPL template literal such as `` `${value}` `` inside the outer Code Mode template literal; Code Mode will parse the inner backtick as the end of `code` and fail before `js_repl` runs.

The agent **MUST NOT** send a REPL example directly as `execute` orchestration code. An `execute` error saying `ImportExpression is not supported` means this routing rule was violated; retry by moving the unchanged source into `tools.js_repl({ code: ... })`, not by rewriting or removing the import.

For every browser or Electron request, the agent **MUST** run setup as above, then select exactly one startup mode before the first `tools.js_repl` call:

- **Electron:** use Electron startup only. Do not launch Chromium or load the stealth runtime.
- **Local web app:** use standard Chromium startup. A request to start, open, inspect, or test "the dev server" in the current workspace is local even before its port is known. A target is also local when the user identifies it as running on the local machine, or its URL uses `file:`, `localhost`, `*.localhost`, `127.0.0.0/8`, or `[::1]`. Do not load or use the stealth runtime.
- **Remote website:** use managed stealth Chromium startup.

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
console.log("Loaded Electron window:", await appWindow.title());`,
  timeout_ms: 30000,
});
```

Set `ELECTRON_ENTRY` to `.` when `package.json.main` is correct, or use a direct main-process path. Do not add Chromium setup to this block.

### Standard Local Web Startup

Send this complete block as the first `execute` call after setup:

```js
return await tools.js_repl({
  code: `var playwright = await import("playwright");
var chromium = playwright.chromium;
var HEADLESS = false;
var browser = await chromium.launch({ headless: HEADLESS });
var context = await browser.newContext();
var page = await context.newPage();
console.log("Standard Chromium opened");`,
  timeout_ms: 30000,
});
```

Set `HEADLESS = true` only when the environment has no graphical display. Local mode uses ordinary Playwright locators, input, pages, contexts, screenshots, and lifecycle methods. The agent **MUST NOT** import `stealth-runtime.mjs`, create a stealth controller, use a stealth profile, or apply managed behavioral input in this mode.

### Managed Remote Web Startup

There are no alternative remote Chromium initialization steps. The agent **MUST NOT** read, grep, extract, copy, reconstruct, evaluate, or inspect `SKILL.md`, `scripts/stealth-runtime.mjs`, or saved tool output before startup. The agent **MUST NOT** use `eval`, `new Function`, `vm`, a subagent, a wrapper, a factory, or a replacement launcher. The agent **MUST NOT** call `chromium.launch()`, call `chromium.launchPersistentContext()` directly, create a non-managed context, or define another `ensureWebBrowser` for a remote target.

Send this complete block as the first `execute` call after setup:

```js
return await tools.js_repl({
  code: `var playwright = await import("playwright");
var chromium = playwright.chromium;
var electronLauncher = playwright._electron;
var path = await import("node:path");
var fs = await import("node:fs/promises");
var { pathToFileURL } = await import("node:url");
var HEADLESS = false;
var webProfileDir;
var mobileProfileDir;
var stealthRuntimeCandidates = [
  path.join(opencode.cwd, ".opencode", "skills", "playwright-interactive", "scripts", "stealth-runtime.mjs"),
  path.join(opencode.homeDir, ".config", "opencode", "skills", "playwright-interactive", "scripts", "stealth-runtime.mjs"),
];
var stealthRuntimePath;
for (var candidate of stealthRuntimeCandidates) {
  try {
    await fs.access(candidate);
    stealthRuntimePath = candidate;
    break;
  } catch {}
}
if (!stealthRuntimePath) throw new Error("Could not locate the playwright-interactive stealth runtime");
var { installStealthRuntime } = await import(pathToFileURL(stealthRuntimePath).href);
var stealthRuntime = await installStealthRuntime({
  chromium,
  opencode,
  headless: HEADLESS,
  webProfileDir,
  mobileProfileDir,
});
var ensureWebBrowser = stealthRuntime.ensureWebBrowser;
var ensureMobileBrowser = stealthRuntime.ensureMobileBrowser;
var createStealthController = stealthRuntime.createStealthController;
var launchStealthChromium = stealthRuntime.launchStealthChromium;
var resetStealthProfile = stealthRuntime.resetStealthProfile;
var stealthControllerRegistry = stealthRuntime.stealthControllerRegistry;
var stealth = await ensureWebBrowser();
var context = stealth.context;
var browser = context.browser();
var page = stealth.pages()[0] || await stealth.newPage();
var stealthCapabilities = stealth.capabilities();
if (
  stealthCapabilities.managedInput !== true ||
  stealthCapabilities.persistentIdentity !== true ||
  stealthCapabilities.automaticPagesAndPopups !== true ||
  stealthCapabilities.identity?.browserIdentity !== "native" ||
  stealthCapabilities.identity?.userAgentOverride !== false ||
  stealthCapabilities.identity?.automationControlledOverride !== false
) {
  await stealth.close().catch(() => {});
  throw new Error("Managed stealth capability verification failed");
}
console.log("Managed stealth browser opened", stealthCapabilities);`,
  timeout_ms: 30000,
});
```

The agent **MUST NOT** split, shorten, rewrite, or precede the selected startup block with exploratory `js_repl` calls. In remote mode, `Managed stealth browser opened` is the only successful startup result. If setup or the selected block fails, the agent **MUST** stop and report the exact error without attempting another startup mode.

For managed remote startup, set `HEADLESS = true` only when the environment has no graphical display. Do not change any other line in that block.

## Standard Local Web Rules

- Use ordinary Playwright APIs directly, such as `page.getByRole()`, `locator.click()`, `locator.fill()`, `page.mouse`, `page.keyboard`, `context.pages()`, and `context.newPage()`.
- Use `page.screenshot()` for captures and `browser.close()` for cleanup.
- Do not use any `stealth`, `mobileStealth`, `ensureWebBrowser`, or `ensureMobileBrowser` APIs.
- Before every local-mode `tools.js_repl` call, inspect its `code` payload. If it contains a stealth-runtime identifier such as `stealth`, `mobileStealth`, `interactiveElements`, or `resolveVisible`, do not execute it; replace it with the ordinary Playwright equivalent.
- For mobile-sized local QA, create a normal context with the required viewport and touch options rather than using the stealth mobile controller.
- Never use a personal Chrome profile.

## Managed Remote Web Rules

The managed-controller sections from **Scrolling** through **Mobile** apply only to remote web mode. Standard local web and Electron mode must ignore all instructions in those sections that require `stealth`, controller-produced locators, managed input, or stealth screenshots.

- Every Chromium page **MUST** belong to the controller returned by `ensureWebBrowser()` or `ensureMobileBrowser()`.
- Use `stealth.newPage()` rather than `browser.newPage()`.
- Use controller methods with an explicit `Page` for behavior-sensitive input.
- Direct locator, mouse, keyboard, touchscreen, and DOM mutation calls are ordinary unmanaged Playwright and do not receive behavioral shaping.
- Each OpenCode session gets its own Chrome profile under its unique `opencode.tmpDir`, so multiple OpenCode sessions can run browsers simultaneously without conflict. Desktop and mobile within one session share that session's profile and must run sequentially.
- Never use a personal Chrome profile.

### Authorization And Bot Controls

Managed remote mode improves interaction consistency; it does not authorize access or override a site's rules. The agent **MUST** stay within the user's authorized scope and the visible user flow.

- The agent **MUST NOT** solve, outsource, bypass, suppress, or repeatedly probe a CAPTCHA, proof-of-work page, waiting room, rate limit, access denial, or bot challenge.
- The agent **MUST NOT** reset the profile, switch desktop/mobile mode, change identity-critical launch settings, open parallel sessions, or retry an action to seek a different security decision.
- An HTTP `403` or `429`, a challenge loop, an explicit automated-access denial, or a provider request to stop is a stop condition. Inspect the current state once, then report it without another attempt.
- For a system the user owns or is explicitly authorized to test, prefer the provider's test keys or sandbox, a staging environment, or a narrowly scoped allowlist. Do not weaken production protection globally.
- If an authorized flow requires a real interactive challenge, pause in headed mode and ask the user to complete it. Resume only after the user confirms completion; never inspect or reuse challenge tokens.
- Keep retries bounded to ordinary transient application failures. A retry **MUST NOT** be used to search for a more favorable bot score or access decision.

The runtime keeps the native Chromium user agent and automation state. It rejects caller-supplied identity-critical launch options, context options, HTTP headers, and Chromium arguments rather than combining contradictory browser, locale, viewport, device, or automation claims. Mobile mode is responsive touch emulation in Chromium, not Safari or physical-device impersonation. Managed input is task-bound: the runtime emits no ambient pointer movement while idle.

### Diagnostics And Sensitive Artifacts

Use `stealth.identity`, `stealth.capabilities()`, `stealth.telemetry()`, and `stealth.pageState(page)` for coarse diagnostics. They report browser/version policy, emulation mode, managed-action counts, navigation counts, popup counts, failures, and the most recent main-document status without collecting page fingerprints, URLs, interaction traces, or credentials.

```js
console.log({
  identity: stealth.identity,
  telemetry: stealth.telemetry(),
  page: stealth.pageState(page),
});
```

Traces, HAR files, video, screenshots, storage state, cookies, and challenge tokens may contain credentials or personal data. Capture only what the task requires, avoid recording secret-bearing states, do not print tokens or cookies, and keep emitted diagnostics coarse. The managed runtime leaves tracing, HAR, and video disabled by default.

## Navigate

Start and verify the application server before navigating. Prefer `127.0.0.1` over `localhost`.

```js
var TARGET_URL = "http://127.0.0.1:3000";
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(30000);
await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
console.log("Loaded:", await page.title());
```

Do not navigate during startup merely to prove that the browser opened. The selected startup block's result is sufficient.

## Navigation Integrity

`page.goto()` opens a site, not an application action. The agent **MUST NOT** use a deep link, query string, fragment, result URL, form endpoint, or guessed route to bypass the user-facing flow. It **MUST** navigate only to the requested site’s origin, then use the visible UI with the input API for the selected mode to complete the request. For example, to search Google, navigate to `https://www.google.com/`, inspect the page, fill the visible search field, and submit it; never navigate directly to `https://www.google.com/search?q=...`.

The same rule applies after recovery and to local applications: use the application origin root, then reach every state through visible controls. A URL supplied verbatim by the user may be opened as requested, but its path, query, and fragment must not be invented, edited, or reused to shortcut an interaction.

## Information Before Interaction

Before any browser interaction, the agent **MUST** decide whether the request can be answered from the current document DOM/source. An interaction includes navigation, clicking, filling, pressing, hovering, dragging, tapping, scrolling, or any other input. If the needed information is already present in the current DOM/source, the agent **MUST** inspect it and answer directly without interacting. Text outside the viewport or a scroll container can still already be present in the DOM; it is not evidence that scrolling or clicking is required.

Use locator-scoped DOM inspection or `evaluate` only to read the current page state; neither may mutate the page or trigger application behavior. For remote mode, this does not relax the cross-frame controller rules for finding controls.

If the information is not present, or the user asks to change application state, use the smallest necessary visible UI flow. Use managed input in remote mode and ordinary Playwright input in local mode. Do not substitute a deep link, a constructed URL, or any other shortcut for that interaction.

## Scrolling

Use managed scrolling only when the current DOM/source does not already answer the request or the user requires a visible state change. To scroll the document at the current pointer position, use `await stealth.scroll(page, 850)`. To scroll a nested panel, list, or other surface, pass its controller-produced locator and the delta: `await stealth.scroll(page, panelLocator, 850)`. This moves the pointer to the intended surface before issuing the humanized wheel sequence.

Passing a locator without a delta, `await stealth.scroll(page, targetLocator)`, preserves the existing behavior of bringing that target into view. Do not send raw mouse-wheel calls or script `scrollTop`; use the controller method so scrolling stays managed.

## Closed Browser Recovery

If a user closes the Chromium window or browser process, the managed context and every former `page` handle are gone. The controller reports this explicitly as `Managed desktop browser is closed` or `Managed mobile browser is closed`. This is **not** a navigation, selector, popup, screenshot, or stale-page diagnostic.

On that error, the agent **MUST NOT** inspect `stealth.pages()`, screenshot, create a page, navigate, or retry an action through the closed controller. It **MUST** record the old controller's `lastManagedOrigin`, then immediately replace the handles through the existing launcher without rerunning Playwright setup or the full startup block:

```js
var recoveryOrigin = stealth.capabilities().lastManagedOrigin;
stealth = await ensureWebBrowser();
context = stealth.context;
browser = context.browser();
page = stealth.pages()[0] || await stealth.newPage();
if (recoveryOrigin) await page.goto(recoveryOrigin, { waitUntil: "domcontentloaded" });
console.log("Managed stealth browser reopened", stealth.capabilities());
```

The replacement tab is blank by design. The preserved value is an origin only, never a deep link. After its root page loads, inventory the visible controls and resume through managed UI interaction. For mobile, use `mobileStealth = await ensureMobileBrowser()` and replace `mobileContext` and `mobilePage` the same way. Do not assume the browser retained the previous URL path, form values, tabs, or pending navigation.

## Tabs And Navigation

A click may navigate the current page, open a new tab or popup, or leave navigation unchanged. The agent **MUST NOT** assume which outcome occurred. For any click that may navigate, snapshot the managed pages and current URL, perform the click, then resolve the observed outcome:

```js
var pageBeforeClick = page;
var urlBeforeClick = page.url();
var pagesBeforeClick = new Set(stealth.pages());
await stealth.click(page, navigationLocator);

var openedPages = [];
var navigationDeadline = Date.now() + 1500;
while (Date.now() < navigationDeadline) {
  openedPages = stealth.pages().filter((candidate) => !pagesBeforeClick.has(candidate));
  if (openedPages.length || (!pageBeforeClick.isClosed() && pageBeforeClick.url() !== urlBeforeClick)) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}

var navigationKind = openedPages.length
  ? "new-page"
  : (!pageBeforeClick.isClosed() && pageBeforeClick.url() !== urlBeforeClick)
    ? "same-page"
    : "no-navigation";

if (openedPages.length === 1) page = openedPages[0];
else page = pageBeforeClick;
if (navigationKind !== "no-navigation" && !page.isClosed()) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
}
console.log("Click outcome:", navigationKind, "pages:", stealth.pages().map((candidate) => candidate.url()));
```

New tabs and popups are registered automatically by the controller. After a navigation-capable click, the agent **MUST** update the shared `page` handle when one new page opened and **MUST** inspect `stealth.pages()` when multiple pages opened or the observed UI is not on the expected page. It **MUST NOT** keep querying the original tab merely because that handle still exists. A new tab is possible, not guaranteed; do not require one unless the application behavior requires it.

## Stuck Or Guessing

If the agent cannot confidently identify the current UI state or the correct interaction target, it **MUST** stop guessing and inspect a screenshot. This rule applies immediately after any one of these conditions:

- One locator or managed action fails because the expected element is missing, ambiguous, obscured, or timed out.
- One DOM inspection pass does not clearly establish what to interact with next.
- The page differs from the expected state, or the agent is considering speculative selectors, repeated scripts, broad `evaluate()` calls, or source inspection to infer what is visible.

If the unexpected state followed a click, first list the open managed pages and their URLs because the destination may be in another tab:

```js
console.log(stealth.pages().map((candidate, index) => ({
  index,
  url: candidate.url(),
  closed: candidate.isClosed(),
})));
```

Select the page containing the expected destination before taking the required screenshot. Do not screenshot and debug a stale opener tab when the click opened a new managed page.

Before running another inspection script or attempting another locator, capture the current viewport and emit it:

```js
var stuckScreenshot = await stealth.screenshot(page, {
  type: "png",
  scale: "css",
  fullPage: true,
});
await opencode.emitImage({
  bytes: stuckScreenshot,
  mimeType: "image/png",
  filename: "playwright-stuck-state.png",
});
```

The agent **MUST** visually inspect the emitted image before choosing the next action. It **MUST NOT** continue cycling through selectors, code inspection, or speculative scripts without this visual checkpoint. For mobile, use `mobileStealth.screenshot(mobilePage, ...)` with the same options. Screenshots **SHOULD** use `fullPage: true`; fall back to a viewport capture only when full-page capture fails or exceeds the image attachment limit.

## Dynamic And Framed UI

`page.getByRole()` and other bare `page.*` locators search the main frame only, never child frames or shadow roots. Because of this, **the first lookup for any visible control should go through the controller**, never a bare `page.getByRole(...)`. Cross-frame lookup is the default posture, not an opt-in:

```js
// preferred, frame- and shadow-root-aware:
var t = await stealth.resolveVisible(page, (frame) => frame.getByRole("button", { name: "Continue" }));
// avoid: bare main-document-only lookup
await stealth.click(page, page.getByRole("button", { name: "Continue" }));
```

A control you can see on screen may live in a same-origin or cross-origin iframe, and child frames may attach asynchronously after `domcontentloaded`. Absence of an element from the main-frame DOM is **never** evidence that a visible control is absent from the browser UI. In particular, cookie/consent/data-protection banners are commonly hosted in a third-party iframe (a "CMP") precisely to keep them out of the main document.

When the exact accessible name is already known, resolve it across current and newly attached frames through the controller:

```js
var resolvedTarget = await stealth.resolveVisible(
  page,
  (frame) => frame.getByRole("button", { name: "Continue", exact: true }),
  { timeout: 5000 },
);
console.log("Target frame:", resolvedTarget.frame.url());
await stealth.click(page, resolvedTarget.locator);
```

When the exact element is unknown, take one snapshot of all visible interactive DOM elements across every current frame and open shadow root. The first inventory after navigation allows one short render window for asynchronously attached UI; it does not wait for element counts to settle or truncate the result, and later inventories are immediate. It returns live locators plus semantic evidence; choose the element whose role, accessible-name evidence, state, and context fit the user's request:

```js
var interactive = await stealth.interactiveElements(page);
console.log(interactive.map((entry, index) =>
  index + " frame=" + entry.frameIndex + " " + (entry.role || entry.tag) + " " + JSON.stringify(entry.name) + " disabled=" + entry.disabled
).join("\n"));
```

The agent **MUST** read the complete inventory and identify the intended entry semantically. Before that review it **MUST NOT** filter entries by role, tag, frame, URL, guessed keyword, or language-specific regex; controls that look like buttons may be links or custom-role elements. Once identified, interact with the returned locator directly, for example `await stealth.click(page, interactive[index].locator)`. If no inventory entry clearly fits the request, capture and visually inspect the required full-page screenshot; use its actual visible wording with `stealth.resolveVisible()` rather than guessing another selector. If a frame or control attaches after the snapshot, take one fresh complete inventory rather than waiting for arbitrary DOM stability.

The agent **MUST NOT** conclude that a requested visible control does not exist after querying only the main frame. It **MUST NOT** inspect frames one by one across multiple tool calls when these controller methods can establish the result once.

## Target Diagnostics

Playwright locators can resolve elements inside frames and open shadow roots. A uniquely resolved, visible locator can still fail because of an overlay, animation, retargeted hit testing, or another interaction boundary. After the required screenshot, the agent **SHOULD** diagnose all of these in one locator-scoped call rather than separately probing documents, every frame, and possible shadow roots:

```js
var targetDiagnostic = await targetLocator.evaluate((element) => {
  var rect = element.getBoundingClientRect();
  var root = element.getRootNode();
  var hitTestRoot = typeof root.elementFromPoint === "function"
    ? root
    : element.ownerDocument;
  var hit = hitTestRoot.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  return {
    frameUrl: element.ownerDocument.defaultView?.location?.href,
    rootType: root.constructor?.name,
    tag: element.tagName,
    role: element.getAttribute("role"),
    text: element.textContent?.trim().slice(0, 120),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    hitTag: hit?.tagName,
    hitClass: typeof hit?.className === "string" ? hit.className : undefined,
    targetOwnsHit: hit === element || element.contains(hit),
  };
});
console.log(targetDiagnostic);
```

Because `locator.evaluate()` runs in the target's own realm, this single inspection already identifies its frame URL and document-versus-shadow-root context. The agent **MUST NOT** repeat the same failed managed action unchanged or enumerate unrelated frames and roots after this diagnostic. If an unrelated element owns the hit point, wait for or dismiss the blocking UI using managed input. If the target owns the hit point but the managed action still fails, report the controller defect with the diagnostic and screenshot instead of silently forcing the action.

## Self-Removing Controls And Dismissals

A **dismiss action — clicking an accept/reject/close control — often deletes the very element (and its parent frame or overlay) that was just clicked.** Accepting a cookie banner tears down the CMP iframe; closing a modal removes the dialog. Playwright's `click()` then keeps waiting on a now-gone element and can raise a timeout *even though the click worked*. A timeout after such an action is therefore **not proof of failure**: a click that succeeded might still surface as a timeout.

```js
// Trust the outcome, not the throw. Click, then verify by the absence of the banner:
try {
  await stealth.click(page, target.locator, { timeout: 5000 });
} catch (e) { /* click may still have taken effect */ }
await page.waitForTimeout(1200);
var stillThere = await stealth.interactiveElements(page)
  .then((list) => list.filter((e) => /Einverstanden|Alle akzeptieren/i.test(e.name || "")))
  .then((hits) => hits.length);
console.log("Dismissed:", stillThere === 0);
```

After a dismiss click, the agent **must** judge success by the *desired end-state* (the banner gone, the intended page shown), not by whether `click` resolved cleanly. If the click threw but the end-state is already achieved, treat it as success. Do not rerun startup or screenshot repeatedly because the parent node detached.

Because such controls are often the dismiss button of a frame-hosted banner, diagnosing them follows the same cross-frame rules as `Dynamic And Framed UI`.

## The REPL Call Budget

Each `js_repl` call has a default duration cap. A timeout or cancellation ends only the tool call: the cell and every live handle (`playwright`, `stealth`, `page`) remain in the kernel, and later calls wait behind the unfinished cell. Multi-step sequences (`click` page-timeout + `waitForTimeout(9000)` + networkidle) routinely exceed 30 seconds. To keep the session responsive:

- Set `timeout_ms` on every call that chains waits. A click’s default page timeout is 10s, so a single click+wait can consume 15–20s; two in one call often exceed 30s.
- **Do not put successive waits in one call.** Split long flows across separate `js_repl` calls so none trips the cap.
- Do not repeat an action after a timeout or cancellation: the original cell may still complete. Wait for the queued result or inspect the resulting UI state.
- To stop an indefinitely stuck cell, use `js_repl_reset`; it destroys every live handle, so rerun the full startup block before touching `page`.
- Prefer resuming the existing session over resetting it: the persistent profile makes the open page recoverable.

## Managed Input

Use the session controller as the default interaction surface, and drive every action from a **controller-produced locator** (from `resolveVisible` or `interactiveElements`) rather than from a raw `page.getByRole(...)` you wrote yourself:

```js
var target = await stealth.resolveVisible(page, (frame) => frame.getByRole("button", { name: "Continue", exact: true }));
await stealth.click(page, target.locator);
var email = await stealth.resolveVisible(page, (frame) => frame.getByLabel("Email"));
await stealth.fill(page, email.locator, "user@example.com");
await stealth.press(page, "Enter");
var details = await stealth.resolveVisible(page, (frame) => frame.getByRole("link", { name: "Details" }));
await stealth.hover(page, details.locator);
await stealth.check(page, (await stealth.resolveVisible(page, (frame) => frame.getByLabel("Remember me"))).locator);
await stealth.selectOption(page, (await stealth.resolveVisible(page, (frame) => frame.getByLabel("Country"))).locator, "DE");
```

`stealth.*` action methods **MUST** receive a locator produced by `resolveVisible` or `interactiveElements` (which accept a `frame => frame.getByRole(...)` callback and search every current and newly attached frame plus open shadow roots). Pass bare `page.getByRole(...)` or `page.getByLabel(...)` locators to a controller action **only** when you have already confirmed the control is in the main document; never reach for one as the default. A bare `page.getByRole("button", { name: "X" })` resolves only in the main document, so the moment a control sits in a frame or shadow root (a cookie/consent banner, a login iframe, an embedded widget), that locator silently misses it and times out. With the exact name unknown, obtain the locator from the inventory instead:

```js
var interactive = await stealth.interactiveElements(page);
await stealth.click(page, interactive[<index>].locator);
```

Available methods include `resolveVisible`, `interactiveElements`, `moveTo`, `click`, `doubleClick`, `hover`, `wheel`, `scroll`, `dragTo`, `type`, `fill`, `pressText`, `press`, `focus`, `check`, `uncheck`, `selectOption`, `tap`, `think`, `screenshot`, and `stop`.

## Mobile

Managed mobile mode is a Chromium responsive-touch cohort with a 390x844 viewport, matching screen dimensions, and device scale factor 3. It deliberately retains Chromium's native version-coherent user agent instead of claiming to be iPhone Safari.

Close desktop first when using the session profile, then use the existing runtime:

```js
await stealth.close();
var mobileStealth = await ensureMobileBrowser();
var mobileContext = mobileStealth.context;
var mobilePage = mobileStealth.pages()[0] || await mobileStealth.newPage();
console.log("Managed mobile stealth browser opened", mobileStealth.capabilities());
```

Use `mobileStealth.tap(mobilePage, locator)` for managed touch input.

The remaining sections apply to every selected mode unless stated otherwise.

## Reload

Reuse the current page across iterations:

```js
await page.reload({ waitUntil: "domcontentloaded" });
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
  type: "jpeg",
  quality: 85,
  scale: "css",
});
await opencode.emitImage({
  bytes: screenshotBytes,
  mimeType: "image/jpeg",
  filename: "playwright-current.jpg",
});
```

Use `appWindow.screenshot()` instead in Electron mode.

## Electron

Electron is always separate from Chromium stealth and uses the Electron startup block. Use ordinary Playwright APIs against `appWindow`.

Do not create scratch pages from an Electron context. Reload renderer-only changes with `appWindow.reload()` and relaunch for main-process, preload, startup, or process-ownership changes.

## Cleanup

Always close resources before `js_repl_reset`, ending the task, or quitting OpenCode:

```js
if (typeof electronApp !== "undefined") await electronApp.close().catch(() => {});
if (typeof mobileStealth !== "undefined") await mobileStealth.close().catch(() => {});
if (typeof stealth !== "undefined") await stealth.close().catch(() => {});
if (typeof stealth === "undefined" && typeof browser !== "undefined") await browser.close().catch(() => {});
console.log("Playwright session closed");
```

Wait for `Playwright session closed` before resetting the REPL. Normal remote-mode cleanup preserves the stealth session profile. `await stealth.resetProfile()` is destructive: it closes the remote session and deletes its complete dedicated identity without relaunching.

## Remote Stealth Limits

It improves persistent identity, lifecycle consistency, task-bound managed input, and identity coherence, but does not guarantee undetectability. It intentionally does not patch CDP, alter Chromium's native automation disclosure, spoof another browser, generate ambient input, rotate network identity, or manipulate challenge systems. Standard Playwright protocol/runtime signals and network, TLS, GPU, OS, profile-history, worker-realm, and long-horizon behavioral signals remain outside skill control.
