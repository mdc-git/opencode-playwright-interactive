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

**Mandatory web launch rule:** Every Chromium web session must use `ensureWebBrowser()` and the managed persistent stealth context defined below. Never call `chromium.launch()`, `browser.newPage()` or create a separate non-stealth web context. Do not present or consider a non-stealth Chromium launch as an alternative. Electron remains a separate, unchanged workflow.

Web browsers use one persistent Chromium profile and one persistent behavioral identity under `~/.local/share/opencode/playwright-interactive/stealth/`. This preserves browser state and behavioral parameters across REPL and browser restarts. The user-data directory is exclusive, so close the current web context before switching desktop or mobile modes.

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
4. Launch the managed Chromium web context with `ensureWebBrowser()`, or launch Electron using its unchanged workflow, and retain its handles.
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
var path;
var webProfileDir;
var mobileProfileDir;
var stealth;
var mobileStealth;
var human;
var mobileHuman;

try {
  ({ chromium, _electron: electronLauncher } = await import("playwright"));
  path = await import("node:path");
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
  browser = undefined;
  context = undefined;
  page = undefined;
  mobileContext = undefined;
  mobilePage = undefined;
  stealth = undefined;
  mobileStealth = undefined;
  human = undefined;
  mobileHuman = undefined;
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

## Default Stealth Web Session

Run this cell once after the Playwright import. The standard Chromium workflow uses it by default for every web session. It keeps one persistent Chromium profile and one stable behavioral identity across REPL and browser restarts, then registers every page and popup created by that context. No extra tool, package or runtime file is required.

```js
var stealthSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
var stealthWriteQueue = Promise.resolve();
var stealthStates = new WeakMap();
var stealthActors = new WeakMap();
var stealthUniform = (minimum, maximum) => minimum + Math.random() * (maximum - minimum);
var stealthNormal = () => {
  let first = 0;
  let second = 0;
  while (!first) first = Math.random();
  while (!second) second = Math.random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};
var stealthLogNormal = (mean, sigma) => Math.max(1, Math.exp(Math.log(Math.max(1, mean)) + sigma * stealthNormal()));
var stealthClamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
var stealthDefaults = {
  schema: 1,
  clickPrecision: 2.5,
  curveFactor: 0.15,
  overshootChance: 0.55,
  overshootMin: 5,
  overshootMax: 15,
  tremorCount: 3,
  tremorAmplitude: 1.5,
  clickHoldMin: 50,
  clickHoldMax: 120,
  typingMean: 90,
  typingSigma: 0.3,
  keyHoldMin: 40,
  keyHoldMax: 110,
  actionGapMean: 400,
  actionGapSigma: 0.35,
  idleThreshold: 3000,
  idleInterval: 2000,
  idleDrift: 12,
};
var stealthNumber = (value, fallback, minimum, maximum) => {
  const number = Number(value);
  return Number.isFinite(number) ? stealthClamp(number, minimum, maximum) : fallback;
};
var normalizeStealthProfile = (value) => {
  if (!value || value.schema !== 1 || typeof value.profileId !== "string" || !value.profileId) return undefined;
  const profile = { ...stealthDefaults, profileId: value.profileId };
  profile.clickPrecision = stealthNumber(value.clickPrecision, profile.clickPrecision, 1, 5);
  profile.curveFactor = stealthNumber(value.curveFactor, profile.curveFactor, 0.05, 0.3);
  profile.overshootChance = stealthNumber(value.overshootChance, profile.overshootChance, 0, 1);
  profile.overshootMin = stealthNumber(value.overshootMin, profile.overshootMin, 2, 10);
  profile.overshootMax = stealthNumber(value.overshootMax, profile.overshootMax, 8, 25);
  profile.tremorCount = Math.round(stealthNumber(value.tremorCount, profile.tremorCount, 2, 5));
  profile.tremorAmplitude = stealthNumber(value.tremorAmplitude, profile.tremorAmplitude, 0.25, 3);
  profile.clickHoldMin = stealthNumber(value.clickHoldMin, profile.clickHoldMin, 35, 100);
  profile.clickHoldMax = stealthNumber(value.clickHoldMax, profile.clickHoldMax, 80, 160);
  profile.typingMean = stealthNumber(value.typingMean, profile.typingMean, 50, 150);
  profile.typingSigma = stealthNumber(value.typingSigma, profile.typingSigma, 0.1, 0.6);
  profile.keyHoldMin = stealthNumber(value.keyHoldMin, profile.keyHoldMin, 20, 100);
  profile.keyHoldMax = stealthNumber(value.keyHoldMax, profile.keyHoldMax, 60, 180);
  profile.actionGapMean = stealthNumber(value.actionGapMean, profile.actionGapMean, 200, 800);
  profile.actionGapSigma = stealthNumber(value.actionGapSigma, profile.actionGapSigma, 0.1, 0.6);
  profile.idleThreshold = stealthNumber(value.idleThreshold, profile.idleThreshold, 2500, 8000);
  profile.idleInterval = stealthNumber(value.idleInterval, profile.idleInterval, 1000, 4000);
  profile.idleDrift = stealthNumber(value.idleDrift, profile.idleDrift, 4, 24);
  if (profile.overshootMax < profile.overshootMin) profile.overshootMax = profile.overshootMin + 1;
  if (profile.clickHoldMax < profile.clickHoldMin) profile.clickHoldMax = profile.clickHoldMin + 1;
  if (profile.keyHoldMax < profile.keyHoldMin) profile.keyHoldMax = profile.keyHoldMin + 1;
  return profile;
};
var createStealthProfile = () => normalizeStealthProfile({
  ...stealthDefaults,
  profileId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  clickPrecision: stealthUniform(2, 3),
  curveFactor: stealthUniform(0.12, 0.18),
  overshootChance: stealthUniform(0.4, 0.7),
  overshootMax: stealthUniform(12, 18),
  tremorCount: Math.round(stealthUniform(2, 5)),
  typingMean: stealthUniform(75, 105),
  typingSigma: stealthUniform(0.25, 0.35),
  actionGapMean: stealthUniform(340, 460),
  actionGapSigma: stealthUniform(0.3, 0.4),
  idleInterval: stealthUniform(1700, 2300),
});
var stealthPaths = async ({ dataDir } = {}) => {
  const root = dataDir || path.join(opencode.homeDir || opencode.tmpDir, ".local", "share", "opencode", "playwright-interactive", "stealth");
  return { root, profile: path.join(root, "behavior.json"), userData: path.join(root, "user-data") };
};
var saveStealthProfile = async (file, profile) => {
  const fs = await import("node:fs/promises");
  const serialized = JSON.stringify(profile, null, 2);
  if (serialized.length > 16 * 1024) throw new Error("Stealth behavioral profile is unexpectedly large");
  stealthWriteQueue = stealthWriteQueue.then(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`;
    const handle = await fs.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  });
  return stealthWriteQueue;
};
var loadStealthProfile = async ({ dataDir } = {}) => {
  const fs = await import("node:fs/promises");
  const { profile } = await stealthPaths({ dataDir });
  let loaded;
  try {
    const stat = await fs.stat(profile);
    if (stat.size <= 16 * 1024) loaded = normalizeStealthProfile(JSON.parse(await fs.readFile(profile, "utf8")));
  } catch {}
  const value = loaded || createStealthProfile();
  await saveStealthProfile(profile, value);
  return value;
};
var resetStealthProfile = async ({ dataDir } = {}) => {
  const fs = await import("node:fs/promises");
  const { profile } = await stealthPaths({ dataDir });
  await stealthWriteQueue.catch(() => {});
  await fs.rm(profile, { force: true });
};
var stealthTargetBox = async (page, target) => {
  if (typeof target === "object" && target && typeof target.boundingBox === "function") {
    if (typeof target.isEnabled === "function" && !(await target.isEnabled())) throw new Error("Stealth target is disabled");
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) throw new Error("Stealth target is not visible");
    const unobscured = await target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return !top || top === element || element.contains(top);
    }).catch(() => true);
    if (!unobscured) throw new Error("Stealth target is obscured");
    return box;
  }
  if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) return { x: target.x, y: target.y, width: 1, height: 1 };
  throw new TypeError("Stealth target must be a Locator or { x, y }");
};
var stealthViewport = async (page) => {
  const viewport = page.viewportSize();
  if (viewport) return viewport;
  return page.evaluate(() => ({ width: window.innerWidth || 960, height: window.innerHeight || 540 })).catch(() => ({ width: 960, height: 540 }));
};
var stealthPoint = (box, profile) => ({
  x: box.width <= 1 ? box.x : stealthClamp(box.x + box.width / 2 + stealthNormal() * profile.clickPrecision, box.x + 1, box.x + Math.max(1, box.width - 1)),
  y: box.height <= 1 ? box.y : stealthClamp(box.y + box.height / 2 + stealthNormal() * profile.clickPrecision, box.y + 1, box.y + Math.max(1, box.height - 1)),
});
var stealthPath = (from, to, profile) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const perpendicular = { x: -dy / distance, y: dx / distance };
  const bend = Math.min(80, distance * profile.curveFactor) * (Math.random() < 0.5 ? -1 : 1);
  const first = { x: from.x + dx * 0.3 + perpendicular.x * bend, y: from.y + dy * 0.3 + perpendicular.y * bend };
  const second = { x: from.x + dx * 0.7 - perpendicular.x * bend * 0.7, y: from.y + dy * 0.7 - perpendicular.y * bend * 0.7 };
  const steps = Math.max(5, Math.min(30, Math.round(distance / 15)));
  const points = [];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const inverse = 1 - t;
    points.push({
      x: inverse ** 3 * from.x + 3 * inverse ** 2 * t * first.x + 3 * inverse * t ** 2 * second.x + t ** 3 * to.x,
      y: inverse ** 3 * from.y + 3 * inverse ** 2 * t * first.y + 3 * inverse * t ** 2 * second.y + t ** 3 * to.y,
    });
  }
  if (distance > 40 && Math.random() < profile.overshootChance) {
    const amount = stealthUniform(profile.overshootMin, profile.overshootMax);
    points.splice(-1, 0, { x: to.x + dx / distance * amount, y: to.y + dy / distance * amount });
  }
  return points;
};
var stealthActorForPage = (page, profile, config = {}) => {
  let state = stealthStates.get(page);
  if (state && !state.stopped) return stealthActors.get(page);
  state = { x: undefined, y: undefined, busy: false, lastActivity: Date.now(), timer: undefined, stopped: false };
  stealthStates.set(page, state);
  let scheduleDrift;
  const markActivity = () => {
    state.lastActivity = Date.now();
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    scheduleDrift();
  };
  const waitForActionGap = async () => await stealthSleep(Math.min(config.maxActionGap || 1200, stealthLogNormal(profile.actionGapMean, profile.actionGapSigma)));
  const movePoints = async (points, duration) => {
    const perPoint = Math.max(5, duration / Math.max(1, points.length));
    for (const point of points) {
      if (state.stopped || page.isClosed()) return;
      await page.mouse.move(point.x, point.y);
      state.x = point.x;
      state.y = point.y;
      await stealthSleep(stealthUniform(perPoint * 0.75, perPoint * 1.25));
    }
  };
  const moveToPoint = async (point) => {
    const viewport = await stealthViewport(page);
    const from = { x: state.x ?? viewport.width / 2, y: state.y ?? viewport.height / 2 };
    await movePoints(stealthPath(from, point, profile), stealthClamp(Math.hypot(point.x - from.x, point.y - from.y) * 0.5 + 80, 80, 350));
  };
  scheduleDrift = () => {
    if (state.stopped || state.timer) return;
    const delay = Math.max(250, state.lastActivity + profile.idleThreshold - Date.now());
    state.timer = setTimeout(async () => {
      state.timer = undefined;
      if (state.stopped || page.isClosed()) return;
      if (state.busy) {
        state.lastActivity = Date.now();
        return scheduleDrift();
      }
      if (Date.now() - state.lastActivity < profile.idleThreshold) return scheduleDrift();
      const viewport = await stealthViewport(page);
      const from = { x: state.x ?? viewport.width / 2, y: state.y ?? viewport.height / 2 };
      const next = {
        x: stealthClamp(from.x + stealthUniform(-profile.idleDrift, profile.idleDrift), 20, Math.max(20, viewport.width - 20)),
        y: stealthClamp(from.y + stealthUniform(-profile.idleDrift, profile.idleDrift), 20, Math.max(20, viewport.height - 20)),
      };
      state.busy = true;
      try { await page.mouse.move(next.x, next.y); state.x = next.x; state.y = next.y; } catch {}
      state.busy = false;
      state.lastActivity = Date.now() - profile.idleThreshold + profile.idleInterval;
      scheduleDrift();
    }, delay);
    if (typeof state.timer.unref === "function") state.timer.unref();
  };
  const actor = {
    async moveTo(target) {
      await waitForActionGap();
      const box = await stealthTargetBox(page, target);
      state.busy = true;
      try { await moveToPoint(stealthPoint(box, profile)); } finally { state.busy = false; markActivity(); }
    },
    async click(target) {
      await waitForActionGap();
      const box = await stealthTargetBox(page, target);
      const point = stealthPoint(box, profile);
      state.busy = true;
      try {
        await moveToPoint(point);
        const tremors = stealthClamp(Math.round(stealthUniform(2, profile.tremorCount + 1)), 2, 5);
        for (let index = 0; index < tremors; index += 1) {
          await page.mouse.move(point.x + stealthUniform(-profile.tremorAmplitude, profile.tremorAmplitude), point.y + stealthUniform(-profile.tremorAmplitude, profile.tremorAmplitude));
          await stealthSleep(stealthUniform(15, 45));
        }
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        try { await stealthSleep(stealthUniform(profile.clickHoldMin, profile.clickHoldMax)); } finally { await page.mouse.up(); }
        state.x = point.x;
        state.y = point.y;
      } finally { state.busy = false; markActivity(); }
    },
    async type(target, text) {
      await this.click(target);
      await this.pressText(text);
    },
    async pressText(text) {
      if (typeof text !== "string") throw new TypeError("Stealth pressText requires a string");
      state.busy = true;
      try {
        for (const character of text) {
          if (/^[\p{Letter}\p{Number}\p{P}\p{S}\p{Zs}]$/u.test(character)) {
            try { await page.keyboard.press(character, { delay: stealthUniform(profile.keyHoldMin, profile.keyHoldMax) }); } catch { await page.keyboard.insertText(character); }
          } else await page.keyboard.insertText(character);
          await stealthSleep(stealthLogNormal(character === " " ? 120 : profile.typingMean, character === " " ? 0.25 : profile.typingSigma));
        }
      } finally { state.busy = false; markActivity(); }
    },
    async press(key) {
      state.busy = true;
      try { await page.keyboard.press(key, { delay: stealthUniform(profile.keyHoldMin, profile.keyHoldMax) }); } finally { state.busy = false; markActivity(); }
    },
    async think(milliseconds) {
      state.busy = true;
      try { await stealthSleep(milliseconds); } finally { state.busy = false; markActivity(); }
    },
    stop() {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
    },
  };
  page.once("close", actor.stop);
  stealthActors.set(page, actor);
  scheduleDrift();
  return actor;
};
var launchStealthChromium = async ({ chromium, headless = HEADLESS, dataDir, launchOptions = {}, contextOptions = {}, behavior = {} } = {}) => {
  if (!chromium?.launchPersistentContext) throw new TypeError("launchStealthChromium requires the shared Playwright chromium object");
  const paths = await stealthPaths({ dataDir });
  const profile = await loadStealthProfile({ dataDir: paths.root });
  const args = [...(launchOptions.args || [])];
  if (!args.includes("--disable-blink-features=AutomationControlled")) args.push("--disable-blink-features=AutomationControlled");
  let persistentContext;
  try {
    persistentContext = await chromium.launchPersistentContext(paths.userData, { ...launchOptions, ...contextOptions, headless: launchOptions.headless ?? headless, args });
  } catch (error) {
    throw new Error(`Could not open the persistent stealth profile at ${paths.userData}. Close any other session using it before retrying. ${error}`);
  }
  const register = (currentPage) => stealthActorForPage(currentPage, profile, behavior);
  for (const currentPage of persistentContext.pages()) register(currentPage);
  persistentContext.on("page", register);
  return {
    context: persistentContext,
    profile,
    dataDir: paths.root,
    pages: () => persistentContext.pages(),
    newPage: () => persistentContext.newPage(),
    forPage: (currentPage) => register(currentPage),
    close: async () => { persistentContext.off("page", register); for (const currentPage of persistentContext.pages()) stealthActors.get(currentPage)?.stop(); await persistentContext.close(); },
  };
};

var ensureWebBrowser = async function () {
  if (context && !context.browser()?.isConnected()) resetWebHandles();
  if (!context) {
    stealth = undefined;
    stealth ??= await launchStealthChromium({ chromium, headless: HEADLESS, dataDir: webProfileDir, contextOptions: { viewport: null } });
    context = stealth.context;
    browser = context.browser();
  }
  return context;
};
var ensureMobileBrowser = async function () {
  if (mobileContext && !mobileContext.browser()?.isConnected()) {
    mobileContext = undefined;
    mobilePage = undefined;
    mobileStealth = undefined;
  }
  if (!mobileContext) {
    mobileStealth = undefined;
    mobileStealth ??= await launchStealthChromium({ chromium, headless: HEADLESS, dataDir: mobileProfileDir, contextOptions: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });
    mobileContext = mobileStealth.context;
  }
  return mobileContext;
};
```

The default desktop bootstrap uses the persistent context and managed actor:

```js
var TARGET_URL = "http://127.0.0.1:3000";

if (page?.isClosed()) page = undefined;
await ensureWebBrowser();
page ??= context.pages()[0] || await context.newPage();
human = stealth.forPage(page);
page.setDefaultTimeout(10000);
page.setDefaultNavigationTimeout(30000);
await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
console.log("Loaded:", await page.title(), "profile:", stealth.profile.profileId);
```

`ensureWebBrowser()` is the only supported Chromium web launch path in this skill. It provides the persistent profile, page actor registration and idle coordinator automatically.

If a handle is stale, set it to `undefined` and rerun the focused setup cell. Keep cells short. Use `timeout_ms` above 30000 only for operations that genuinely need it; the maximum is 300000. Timeout or cancellation kills the kernel and invalidates every handle.

## Web Sessions

Desktop web sessions use a native, user-resizable window by default. Create a separate explicit-viewport context only when deterministic screenshot dimensions are required.

Desktop:

```js
var TARGET_URL = "http://127.0.0.1:3000";

if (page?.isClosed()) page = undefined;
await ensureWebBrowser();
page ??= context.pages()[0] || await context.newPage();
human = stealth.forPage(page);
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
await ensureMobileBrowser();
mobilePage ??= mobileContext.pages()[0] || await mobileContext.newPage();
mobileHuman = mobileStealth.forPage(mobilePage);
mobilePage.setDefaultTimeout(10000);
mobilePage.setDefaultNavigationTimeout(30000);
await mobilePage.goto(MOBILE_TARGET_URL, { waitUntil: "domcontentloaded" });
console.log("Loaded mobile:", await mobilePage.title());
```

Native-window pass:

```js
await page?.close().catch(() => {});
await stealth?.close().catch(() => {});
browser = undefined;
page = undefined;
context = undefined;
stealth = undefined;

await ensureWebBrowser();
page = context.pages()[0] || await context.newPage();
human = stealth.forPage(page);
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

The default desktop and mobile web sessions use persistent Chromium contexts. Leave `webProfileDir` and `mobileProfileDir` unset to use the shared installation profile and behavioral identity. Only one of those contexts can use the shared profile at a time because Chromium locks its user-data directory. Close the first session before switching modes. Set a deliberate separate data directory only when isolated browser identities are required.

Use `human = stealth.forPage(page)` or `mobileHuman = mobileStealth.forPage(mobilePage)` for managed pointer and keyboard behavior. Direct locator actions remain available for ordinary QA but bypass the behavioral actor.

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
if (mobileStealth) await mobileStealth.close().catch(() => {});
if (stealth) await stealth.close().catch(() => {});

browser = undefined;
context = undefined;
page = undefined;
mobileContext = undefined;
mobilePage = undefined;
mobileStealth = undefined;
mobileHuman = undefined;
stealth = undefined;
human = undefined;
electronApp = undefined;
appWindow = undefined;
console.log("Playwright session closed");
```

Wait for `Playwright session closed` before invoking `js_repl_reset` or exiting. The shared Chromium profile remains on disk intentionally, while the active context and its idle timers are closed.

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
