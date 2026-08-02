---
name: playwright-interactive
description: Persistent Playwright browser and Electron QA through js_repl. Use when debugging, testing, or visually inspecting local web apps, responsive interfaces, or Electron applications.
license: Apache-2.0
compatibility: OpenCode with .opencode/tools/js_repl.ts and Node.js 22.22 or newer
metadata:
  source: openai/skills playwright-interactive
  adapted-for: opencode
---

# Playwright Interactive

Use a persistent `js_repl` Playwright session to debug local web or Electron apps. Keep browser and page handles alive across iterations, and run functional and visual QA without restarting the runtime unless process ownership or startup code changed.

## Preconditions

- The `js_repl` and `js_repl_reset` tools must be available. If they are missing, stop and tell the user to copy this distribution's `tools/` directory to `.opencode/tools/` and fully restart OpenCode.
- Run setup and OpenCode from the application workspace being tested. The REPL resolves packages from its current workspace.
- `js_repl` uses the normal OpenCode `js_repl` permission. It is not an OS sandbox; approved JavaScript and imported dependencies run with the current user's filesystem and network privileges.
- On its first use on a machine, `js_repl` installs its pinned Meriyah parser in the shared OpenCode cache. This does not create files in the application workspace.
- Treat `js_repl_reset` as recovery, not routine cleanup. A reset destroys all Playwright handles and can leave browser descendants alive if explicit cleanup was skipped.
- Use `js_repl` with `{ code, timeout_ms? }`. Send plain JavaScript in `code`, not markdown fences or a second JSON wrapper.

## One-Time Shared Setup

Run `js_repl_playwright_setup` before the first Playwright task on a machine. It installs the pinned Playwright library and Chromium once in the shared OpenCode cache, then every `js_repl` session resolves it automatically. Do not initialize a `package.json` or install Playwright in the application workspace.

The setup requires network access and downloads a platform-specific Chromium binary. If it is unavailable, report the setup failure rather than falling back to modifying the target workspace. Electron remains a project dependency because it launches the application under test.

After setup, verify the import through `js_repl`, because that is the runtime that must resolve it.

## Core Workflow

1. Write a concise QA inventory before testing.
2. Start or confirm the app's dev server and verify its port.
3. Run the bootstrap cell once.
4. Launch the correct browser or Electron runtime and retain its handles.
5. After each code change, reload renderer-only changes or relaunch process-owning changes.
6. Run functional QA using normal user input.
7. Run a separate visual QA pass and emit screenshots for review.
8. Verify viewport fit numerically and visually.
9. Explicitly close Playwright resources only when the task is finished.

Build the QA inventory from:

- The user's requirements.
- User-visible behavior actually implemented.
- Claims intended for the final response.
- Every meaningful visible control, state transition, and mode.
- At least two exploratory or off-happy-path scenarios.

Map each claim or control-state pair to a functional check, the state requiring visual review, and expected evidence. Update the inventory when exploration reveals new behavior.

## Bootstrap

Use `var` for shared handles because later cells reuse them.

```js
var chromium;
var electronLauncher;
var browser;
var context;
var page;
var mobileContext;
var mobilePage;
var electronApp;
var appWindow;
var HEADLESS = false;

try {
  ({ chromium, _electron: electronLauncher } = await import("playwright"));
  console.log("Playwright loaded");
} catch (error) {
  throw new Error(
    `Could not load the shared Playwright runtime. Run js_repl_playwright_setup first. Original error: ${error}`
  );
}
```

Set `HEADLESS = true` when the environment has no graphical display. Headless mode still supports visual QA through screenshots, but it does not validate host window-manager behavior.

Shared helpers:

```js
var resetWebHandles = function () {
  context = undefined;
  page = undefined;
  mobileContext = undefined;
  mobilePage = undefined;
};

var ensureWebBrowser = async function () {
  if (browser && !browser.isConnected()) {
    browser = undefined;
    resetWebHandles();
  }
  browser ??= await chromium.launch({ headless: HEADLESS });
  return browser;
};

var reloadWebContexts = async function () {
  for (const currentContext of [context, mobileContext]) {
    if (!currentContext) continue;
    for (const currentPage of currentContext.pages()) {
      await currentPage.reload({ waitUntil: "domcontentloaded" });
    }
  }
  console.log("Reloaded existing web tabs");
};
```

If a handle is stale, set it to `undefined` and rerun the focused setup cell. Keep cells short. Use `timeout_ms` above 30000 only for operations that genuinely need it; the maximum is 300000. Timeout or cancellation kills the kernel and invalidates every handle.

## Web Sessions

Use explicit viewports for deterministic iteration and screenshots. Treat native-window behavior as a separate headed validation pass.

Desktop:

```js
var TARGET_URL = "http://127.0.0.1:3000";

if (page?.isClosed()) page = undefined;
await ensureWebBrowser();
context ??= await browser.newContext({ viewport: { width: 1600, height: 900 } });
page ??= await context.newPage();
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(30000);
await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
console.log("Loaded:", await page.title());
```

Mobile:

```js
var MOBILE_TARGET_URL = typeof TARGET_URL === "string"
  ? TARGET_URL
  : "http://127.0.0.1:3000";

if (mobilePage?.isClosed()) mobilePage = undefined;
await ensureWebBrowser();
mobileContext ??= await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
mobilePage ??= await mobileContext.newPage();
mobilePage.setDefaultTimeout(10000);
mobilePage.setDefaultNavigationTimeout(30000);
await mobilePage.goto(MOBILE_TARGET_URL, { waitUntil: "domcontentloaded" });
console.log("Loaded mobile:", await mobilePage.title());
```

Native-window pass:

```js
await page?.close().catch(() => {});
await context?.close().catch(() => {});
page = undefined;
context = undefined;

await ensureWebBrowser();
context = await browser.newContext({ viewport: null });
page = await context.newPage();
await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
console.log("Loaded native window:", await page.title());
```

Switching between explicit and native-window modes requires a new context. Do not reuse a viewport-emulated context for native-window validation.

## Electron Session

Set `ELECTRON_ENTRY` to `.` when `package.json.main` is correct, or use a direct main-process path.

```js
var ELECTRON_ENTRY = ".";

if (appWindow?.isClosed()) appWindow = undefined;
if (!appWindow && electronApp) {
  await electronApp.close().catch(() => {});
  electronApp = undefined;
}

electronApp ??= await electronLauncher.launch({ args: [ELECTRON_ENTRY] });
appWindow ??= await electronApp.firstWindow();
appWindow.setDefaultTimeout(10000);
console.log("Loaded Electron window:", await appWindow.title());
```

Pass an explicit `cwd` to `electronLauncher.launch` when the REPL workspace is not the Electron app directory.

Reload rules:

- Web renderer change: `await reloadWebContexts()`.
- Electron renderer-only change: `await appWindow.reload({ waitUntil: "domcontentloaded" })`.
- Electron main-process, preload, startup, or process-ownership change: close and relaunch Electron.

```js
await electronApp.close().catch(() => {});
electronApp = undefined;
appWindow = undefined;
electronApp = await electronLauncher.launch({ args: [ELECTRON_ENTRY] });
appWindow = await electronApp.firstWindow();
console.log("Relaunched Electron window:", await appWindow.title());
```

Do not use `appWindow.context().newPage()` or `electronApp.context().newPage()` as a scratch page. Electron contexts do not reliably support it.

## Functional QA

- Exercise every obvious visible control at least once.
- Use real user input for signoff: click, keyboard, mouse, touch, drag, and Playwright input APIs.
- Verify at least one end-to-end critical flow and its visible result.
- For toggles and reversible controls, verify initial, changed, and restored states.
- Use `evaluate` for inspection or staging only; it does not count as signoff input.
- After scripted checks, explore with normal input for 30-90 seconds.
- Add newly discovered controls, states, and claims to the QA inventory.
- For animation or realtime behavior, test with realistic interaction timing.

## Visual QA

Treat visual QA separately from functional correctness.

- Inspect the initial viewport before scrolling.
- Review every required region and user-visible claim in the state where it matters.
- Capture at least one meaningful post-interaction state for interactive work.
- Inspect in-transition states when motion is part of the result.
- Test the densest realistic state, not only empty/loading states.
- Test the defined minimum viewport, or a smaller realistic viewport when none is defined.
- Look for clipping, overflow, distortion, imbalance, inconsistent spacing, alignment, unreadable text, weak contrast, broken layering, and awkward motion.
- Treat a technically present but visually imperceptible affordance as a defect.
- Prefer viewport screenshots. Use full-page screenshots as secondary evidence.
- If screenshot evidence and numeric checks disagree, investigate; visible clipping is a failure.

## Image Attachment Helpers

`opencode.emitImage` attaches images to the `js_repl` result. Await every call. Supported formats are PNG, JPEG, WebP, and GIF, up to 5 MiB each and four images per cell.

```js
var emitJpeg = async function (bytes, filename = "playwright-qa.jpg") {
  await opencode.emitImage({ bytes, mimeType: "image/jpeg", filename });
};

var emitWebJpeg = async function (surface, options = {}, filename = "playwright-web.jpg") {
  await emitJpeg(await surface.screenshot({
    type: "jpeg",
    quality: 85,
    scale: "css",
    ...options,
  }), filename);
};

var clickCssPoint = async function ({ surface, x, y, clip }) {
  await surface.mouse.click(clip ? clip.x + x : x, clip ? clip.y + y : y);
};

var tapCssPoint = async function ({ page, x, y, clip }) {
  await page.touchscreen.tap(clip ? clip.x + x : x, clip ? clip.y + y : y);
};
```

Default captures:

```js
await emitWebJpeg(page, {}, "desktop-current.jpg");
await emitWebJpeg(mobilePage, {}, "mobile-current.jpg");
```

Coordinates from a full screenshot map directly to Playwright CSS pixels. For clipped or element screenshots, add the clip or bounding-box origin when clicking.

`scale: "css"` may still return device-pixel output in native-window Chromium on high-DPI displays. Normalize inside the existing page when CSS-coordinate alignment matters:

```js
var emitWebScreenshotCssScaled = async function ({ page, clip, quality = 0.85, filename = "web-css.jpg" } = {}) {
  var NodeBuffer = (await import("node:buffer")).Buffer;
  const target = clip
    ? { width: clip.width, height: clip.height }
    : await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const screenshotBuffer = await page.screenshot({ type: "png", ...(clip ? { clip } : {}) });
  const bytes = await page.evaluate(async ({ imageBase64, target, quality }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${imageBase64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(image, 0, 0, target.width, target.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return new Uint8Array(await blob.arrayBuffer());
  }, {
    imageBase64: NodeBuffer.from(screenshotBuffer).toString("base64"),
    target,
    quality,
  });
  await emitJpeg(bytes, filename);
};
```

Electron screenshots must be normalized in the main process:

```js
var emitElectronScreenshotCssScaled = async function ({ electronApp, clip, quality = 85, filename = "electron-css.jpg" } = {}) {
  const bytes = await electronApp.evaluate(async ({ BrowserWindow }, { clip, quality }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const image = clip ? await win.capturePage(clip) : await win.capturePage();
    const target = clip
      ? { width: clip.width, height: clip.height }
      : (() => {
          const [width, height] = win.getContentSize();
          return { width, height };
        })();
    return image.resize({ width: target.width, height: target.height, quality: "best" }).toJPEG(quality);
  }, { clip, quality });
  await emitJpeg(bytes, filename);
};
```

Use raw screenshots only for DPI, Retina, pixel-accuracy, or other fidelity-sensitive debugging:

```js
await opencode.emitImage({
  bytes: await page.screenshot({ type: "png" }),
  mimeType: "image/png",
  filename: "raw-fidelity.png",
});
```

Emit one focused screenshot per cell when possible. Multiple images are useful for direct comparison, but focused evidence is easier to interpret and remains within payload limits.

## Viewport Fit

Screenshots are primary evidence; numeric checks support them.

```js
console.log(await page.evaluate(() => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  clientWidth: document.documentElement.clientWidth,
  clientHeight: document.documentElement.clientHeight,
  scrollWidth: document.documentElement.scrollWidth,
  scrollHeight: document.documentElement.scrollHeight,
  canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  canScrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
})));
```

Use `appWindow` instead of `page` for Electron. Also inspect `getBoundingClientRect()` for every required visible region; document dimensions do not reveal clipping inside fixed shells or hidden-overflow containers. For native windows and Electron, inspect the as-launched size before resizing.

## Dev Server

Use the project's normal start command. Keep it in a user terminal or a managed long-running background process with a known PID and log path. Do not assume a one-shot shell invocation remains alive. Before `page.goto`, verify the port is listening and the app responds. Prefer `127.0.0.1` over `localhost`.

If an Electron renderer depends on Vite, Next, or another dev server, start and verify that server before launching Electron from `js_repl`.

## Cleanup

Run cleanup before reset, before ending the task, and before quitting OpenCode. This is especially important because force-killing the REPL kernel may not terminate every browser descendant.

```js
if (electronApp) await electronApp.close().catch(() => {});
if (mobileContext) await mobileContext.close().catch(() => {});
if (context) await context.close().catch(() => {});
if (browser) await browser.close().catch(() => {});

browser = undefined;
context = undefined;
page = undefined;
mobileContext = undefined;
mobilePage = undefined;
electronApp = undefined;
appWindow = undefined;
console.log("Playwright session closed");
```

Wait for `Playwright session closed` before invoking `js_repl_reset` or exiting.

## Signoff

- Functional checks passed with normal user input.
- Coverage is explicit against the QA inventory, including exclusions.
- Visual QA covered all relevant regions, modes, and claim-bearing states.
- Each visual claim has reviewed screenshot evidence.
- Intended and minimum viewport-fit checks passed.
- Native/Electron as-launched window behavior was checked when applicable.
- Functional correctness, viewport fit, and visual quality each passed independently.
- A 30-90 second exploratory pass was completed and summarized.
- Main defect classes checked and not found are stated briefly.
- Cleanup ran, or the response explicitly says the session remains alive for continued work.

## Common Failures

- `Cannot find module 'playwright'`: run `js_repl_playwright_setup`, then retry the import through `js_repl`.
- Browser executable missing: rerun `js_repl_playwright_setup` with `{ force: true }`.
- `ERR_CONNECTION_REFUSED`: verify the dev server, port, and logs; prefer `127.0.0.1`.
- Headed launch fails: confirm a graphical display exists or set `HEADLESS = true`.
- Electron launch hangs or exits: verify local Electron, entry path, explicit `cwd`, and renderer server readiness.
- `Identifier has already been declared`: reuse shared bindings, choose a new name, use `var`, or wrap temporary declarations in `{ ... }`.
- Electron `Target.createTarget` errors: do not create scratch pages from the Electron context.
- `js_repl` timeout/reset: rerun bootstrap and recreate all handles using shorter cells.
- Image exceeds limits: capture a focused region or JPEG at quality 85 instead of a large PNG/full page.
