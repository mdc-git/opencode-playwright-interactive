---
name: playwright-interactive
description: Persistent stealth Playwright browser and Electron QA through js_repl. Use when opening, debugging, testing, or visually inspecting local web apps, responsive interfaces, or Electron applications. Chromium must always start through the one managed stealth startup snippet in this skill.
license: Apache-2.0
compatibility: OpenCode with .opencode/tools/js_repl.ts and Node.js 22.22 or newer
metadata:
  source: openai/skills playwright-interactive
  adapted-for: opencode
---

# Playwright Interactive

Use persistent `js_repl` browser handles for iterative browser and Electron QA.

## Required Chromium Startup

The words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, and **SHALL NOT** in this section are interpreted as described in RFC 2119.

For every request to open or use Chromium, the agent **MUST** perform exactly these two tool calls first:

1. Call `js_repl_playwright_setup`.
2. Send the complete JavaScript block below directly to `js_repl` as one call.

There are no other Chromium initialization steps. The agent **MUST NOT** read, grep, extract, copy, reconstruct, evaluate, or inspect `SKILL.md`, `scripts/stealth-runtime.mjs`, `references/stealth-runtime-source.txt`, or saved tool output before startup. The agent **MUST NOT** use `eval`, `new Function`, `vm`, a subagent, a wrapper, a factory, or a replacement launcher. The agent **MUST NOT** call `chromium.launch()`, call `chromium.launchPersistentContext()` directly, create a non-managed context, or define another `ensureWebBrowser`.

This is the complete and only desktop startup code:

```js
var playwright = await import("playwright");
var chromium = playwright.chromium;
var electronLauncher = playwright._electron;
var path = await import("node:path");
var { pathToFileURL } = await import("node:url");
var HEADLESS = false;
var webProfileDir;
var mobileProfileDir;
var stealthRuntimePath = path.join(
  opencode.homeDir,
  ".config",
  "opencode",
  "skills",
  "playwright-interactive",
  "scripts",
  "stealth-runtime.mjs",
);
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
  stealthCapabilities.automaticPagesAndPopups !== true
) {
  await stealth.close().catch(() => {});
  throw new Error("Managed stealth capability verification failed");
}
console.log("Managed stealth browser opened", stealthCapabilities);
```

The agent **MUST NOT** split, shorten, rewrite, or precede this block with exploratory `js_repl` calls. `Managed stealth browser opened` is the only successful startup result. If setup or this block fails, the agent **MUST** stop and report the exact error without opening another browser or attempting an alternative.

Set `HEADLESS = true` only when the environment has no graphical display. Do not change any other startup line.

## Chromium Rules

- Every Chromium page **MUST** belong to the controller returned by `ensureWebBrowser()` or `ensureMobileBrowser()`.
- Use `stealth.newPage()` rather than `browser.newPage()`.
- Use controller methods with an explicit `Page` for behavior-sensitive input.
- Direct locator, mouse, keyboard, touchscreen, and DOM mutation calls are ordinary unmanaged Playwright and do not receive behavioral shaping.
- The persistent profile is exclusive. Close desktop before starting mobile when both use the default profile.
- Never use a personal Chrome profile.

## Navigate

Start and verify the application server before navigating. Prefer `127.0.0.1` over `localhost`.

```js
var TARGET_URL = "http://127.0.0.1:3000";
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(30000);
await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
console.log("Loaded:", await page.title());
```

Do not navigate during startup merely to prove that the browser opened. The startup capability result is sufficient.

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
});
await opencode.emitImage({
  bytes: stuckScreenshot,
  mimeType: "image/png",
  filename: "playwright-stuck-state.png",
});
```

The agent **MUST** visually inspect the emitted image before choosing the next action. It **MUST NOT** continue cycling through selectors, code inspection, or speculative scripts without this visual checkpoint. For mobile, use `mobileStealth.screenshot(mobilePage, ...)` with the same options. If the relevant content may be below the fold, a full-page screenshot **MAY** follow the initial viewport screenshot.

## Managed Input

Use the session controller as the default interaction surface:

```js
await stealth.click(page, page.getByRole("button", { name: "Continue" }));
await stealth.fill(page, page.getByLabel("Email"), "user@example.com");
await stealth.press(page, "Enter");
await stealth.hover(page, page.getByRole("link", { name: "Details" }));
await stealth.check(page, page.getByLabel("Remember me"));
await stealth.selectOption(page, page.getByLabel("Country"), "DE");
```

Available methods include `moveTo`, `click`, `doubleClick`, `hover`, `wheel`, `scroll`, `dragTo`, `type`, `fill`, `pressText`, `press`, `focus`, `check`, `uncheck`, `selectOption`, `tap`, `think`, `screenshot`, and `stop`.

## Mobile

Close desktop first when using the shared profile, then use the existing runtime:

```js
await stealth.close();
var mobileStealth = await ensureMobileBrowser();
var mobileContext = mobileStealth.context;
var mobilePage = mobileStealth.pages()[0] || await mobileStealth.newPage();
console.log("Managed mobile stealth browser opened", mobileStealth.capabilities());
```

Use `mobileStealth.tap(mobilePage, locator)` for managed touch input.

## Reload

Reuse the current controller and pages across iterations:

```js
for (var currentPage of stealth.pages()) {
  await currentPage.reload({ waitUntil: "domcontentloaded" });
}
```

Do not rerun startup after ordinary application changes. Rerun it only after `js_repl_reset`, kernel termination, or a new OpenCode session.

## Functional QA

- Inventory the user requirements, visible controls, state transitions, and claims after Chromium startup.
- Exercise every relevant control with managed input.
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
var screenshotBytes = await stealth.screenshot(page, {
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

## Electron

Electron remains separate from Chromium stealth. Set `ELECTRON_ENTRY` to `.` when `package.json.main` is correct, or use a direct main-process path.

```js
var ELECTRON_ENTRY = ".";
var electronApp = await electronLauncher.launch({ args: [ELECTRON_ENTRY] });
var appWindow = await electronApp.firstWindow();
appWindow.setDefaultTimeout(10000);
console.log("Loaded Electron window:", await appWindow.title());
```

Do not create scratch pages from an Electron context. Reload renderer-only changes with `appWindow.reload()` and relaunch for main-process, preload, startup, or process-ownership changes.

## Cleanup

Always close resources before `js_repl_reset`, ending the task, or quitting OpenCode:

```js
if (electronApp) await electronApp.close().catch(() => {});
if (mobileStealth) await mobileStealth.close().catch(() => {});
if (stealth) await stealth.close().catch(() => {});
console.log("Playwright session closed");
```

Wait for `Playwright session closed` before resetting the REPL. Normal cleanup preserves the dedicated persistent profile. `await stealth.resetProfile()` is destructive: it closes the session and deletes the complete dedicated identity without relaunching.

## Limits

This workflow is for authorized testing of sites the user controls. It improves persistent identity, lifecycle consistency, and managed input behavior, but does not guarantee undetectability. Standard Playwright protocol/runtime signals and network, TLS, GPU, OS, profile-history, worker-realm, and long-horizon behavioral signals remain outside skill control.
