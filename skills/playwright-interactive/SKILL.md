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

Use a persistent headed `js_repl` session. Keep the visible browser open between
turns unless the user asks to close it.

## Workflow

1. Run Playwright setup.
2. Choose exactly one mode: Electron, local web, or remote web.
3. Run that mode's startup block before any other browser call.
4. Navigate through the requested site's visible flow.
5. Inspect the result with DOM reads and screenshots.
6. Exercise the relevant flow and verify the visible outcome.

If the target is ambiguous, ask for its URL or application type before startup.

## Code Mode

`execute` only orchestrates `js_repl`. Put all Node.js, Playwright, and browser
code inside the `code` string:

```js
return await tools.js_repl_playwright_setup();
```

```js
return await tools.js_repl({
  code: `// Node.js and Playwright code goes here`,
  timeout_ms: 30000,
});
```

Do not put imports or Playwright calls directly in `execute`. Escape or avoid
backticks inside the nested code string.

## Choose A Mode

- **Electron:** use Electron only.
- **Local web:** use standard Chromium for a dev server or local URL. Do not use the stealth runtime.
- **Remote web:** use the managed stealth runtime. Do not launch Chromium directly or create an unmanaged context.

All modes are headed. Never set or pass a headless option.

## Electron Startup

```js
var playwright = await import("playwright");
var electronApp = await playwright._electron.launch({ args: ["."] });
var appWindow = await electronApp.firstWindow();
appWindow.setDefaultTimeout(10000);
({ status: "Loaded Electron window", title: await appWindow.title() });
```

Use `appWindow` with ordinary Playwright APIs. Use the correct Electron entry
point instead of `"."` when the package does not define the main entry.

## Local Web Startup

```js
var playwright = await import("playwright");
var browser = await playwright.chromium.launch();
var context = await browser.newContext();
var page = await context.newPage();
var localBrowserSession = opencode.bindBrowser({ browser, context, profileKind: "local" });
var assertLocalPage = localBrowserSession.assertPage;
({ status: "Standard Chromium opened" });
```

Call `assertLocalPage(page)` before interactions and after page or browser
lifecycle changes. If this browser closes, stop instead of adopting another
browser.

## Remote Web Startup

Use the managed runtime and its fresh managed page. Do not inspect or recreate
the runtime before startup.

```js
var playwright = await import("playwright");
var path = await import("node:path");
var fs = await import("node:fs/promises");
var { pathToFileURL } = await import("node:url");
var runtimeCandidates = [
  path.join(opencode.cwd, ".opencode", "skills", "playwright-interactive", "scripts", "stealth-runtime.mjs"),
  path.join(opencode.homeDir, ".config", "opencode", "skills", "playwright-interactive", "scripts", "stealth-runtime.mjs"),
];
var runtimePath;
for (var candidate of runtimeCandidates) {
  try { await fs.access(candidate); runtimePath = candidate; break; } catch {}
}
if (!runtimePath) throw new Error("Could not locate the playwright-interactive stealth runtime");
var { installStealthRuntime } = await import(pathToFileURL(runtimePath).href);
var runtime = await installStealthRuntime({ chromium: playwright.chromium, opencode });
var ensureWebBrowser = runtime.ensureWebBrowser;
var ensureMobileBrowser = runtime.ensureMobileBrowser;
var stealth = await ensureWebBrowser();
var context = stealth.context;
var browser = context.browser();
var page = await stealth.newPage();
({ status: "Managed stealth browser opened" });
```

The managed runtime uses the native Chromium identity and the maintained
`rebrowser-playwright` driver. Do not replace this startup with direct
Chromium launch or a personal browser profile.

## Navigate

Set timeouts, then navigate to the requested origin or user-provided URL:

```js
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(30000);
await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
({ url: page.url(), title: await page.title() });
```

Use visible controls to reach application states. Do not invent routes, query
strings, fragments, form endpoints, or deep links.

On a remote first visit, wait briefly, inspect the complete interactive UI, and
capture a screenshot. Dismiss only clearly benign consent banners or modal
overlays, then verify they are gone.

## Inspect And Interact

Before interacting, check whether the current DOM already contains the answer.
Use read-only `evaluate` or locator inspection when it does.

For local web and Electron, use ordinary Playwright APIs. For remote web:

- Resolve visible controls with `stealth.resolveVisible()` across frames and shadow roots.
- If the target is unknown, inspect `stealth.interactiveElements(page)` once and use its returned locator.
- Pass controller-produced locators to `stealth.click`, `stealth.fill`, `stealth.press`, `stealth.scroll`, and other managed actions.
- Use `stealth.pages()` after clicks that may open a tab or popup and update `page` when needed.
- Use `stealth.scroll()` rather than raw wheel or scripted scroll position changes.

Example:

```js
var target = await stealth.resolveVisible(
  page,
  (frame) => frame.getByRole("button", { name: "Continue", exact: true }),
);
await stealth.click(page, target.locator);
```

Do not treat structural containers such as `main`, `region`, `heading`, or
`navigation` as controls. Find the nested actionable element.

## When Stuck

After one failed, ambiguous, or unexpected action:

1. List managed pages and URLs if navigation may have occurred.
2. Capture and inspect a screenshot.
3. Inspect the current UI once more and choose a target from evidence.

Do not cycle through guessed selectors or repeat the same action unchanged.

A dismiss button may remove itself and cause a timeout after succeeding. Verify
the intended end state before retrying.

## Timeouts And Recovery

- Use a longer `timeout_ms` for managed typing or navigation.
- Do not repeat an action after a timeout; the original cell may still finish.
- Run one short diagnostic call before further action.
- If the diagnostic call also blocks, reset the REPL and rerun setup plus the complete startup block.
- If the user closes the browser, stop and report it. Relaunch only after the user explicitly requests a new browser.

## QA

- Inspect the initial and relevant post-action screenshots.
- Verify the critical flow and its visible result.
- Check responsive layouts at the requested or minimum viewport.
- Test changed and restored states for toggles or reversible controls.
- Use `evaluate` only for inspection, not as test input.

## Mobile

Use managed mobile only when requested. Close desktop first, then create the
mobile session with `ensureMobileBrowser()`. Use `mobileStealth.tap()` for
touch actions. Local mobile QA uses a normal Chromium context with viewport and
touch options.

## Persistence And Close

Reuse the current page across ordinary iterations. Reload instead of rerunning
startup after application changes. Keep sessions open when finished.

Close only when the user asks, when switching desktop/mobile, or when a blocked
kernel requires reset. Close only resources owned by this session:

```js
if (typeof electronApp !== "undefined") await electronApp.close().catch(() => {});
if (typeof mobileStealth !== "undefined") await mobileStealth.close().catch(() => {});
if (typeof stealth !== "undefined") await stealth.close().catch(() => {});
if (typeof stealth === "undefined" && typeof browser !== "undefined") await browser.close().catch(() => {});
"Playwright session closed";
```
