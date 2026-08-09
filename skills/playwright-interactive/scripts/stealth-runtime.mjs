import fs from "node:fs/promises";
import path from "node:path";

const PERSONA_SCHEMA = 2;
const MOBILE_VIEWPORT = Object.freeze({ width: 390, height: 844 });
const MOBILE_DEVICE_SCALE_FACTOR = 3;
const IDENTITY_CONTEXT_OPTIONS = Object.freeze([
  "userAgent",
  "locale",
  "timezoneId",
  "isMobile",
  "hasTouch",
  "deviceScaleFactor",
  "viewport",
  "screen",
]);
const IDENTITY_ARGUMENTS = Object.freeze([
  "--disable-blink-features=AutomationControlled",
  "--force-device-scale-factor",
  "--lang",
  "--user-agent",
]);
const IDENTITY_HEADERS = Object.freeze([
  "accept-language",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "user-agent",
]);
let installedRuntime;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const uniform = (minimum, maximum) => minimum + Math.random() * (maximum - minimum);
const normal = () => {
  let first = 0;
  let second = 0;
  while (!first) first = Math.random();
  while (!second) second = Math.random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};
const logNormal = (mean, sigma) => Math.max(1, Math.exp(Math.log(Math.max(1, mean)) + sigma * normal()));
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export async function installStealthRuntime({
  chromium,
  opencode,
  headless = false,
  webProfileDir,
  mobileProfileDir,
} = {}) {
  if (installedRuntime) return installedRuntime;
  if (!chromium?.launchPersistentContext) throw new TypeError("The shared Playwright chromium object is required");
  if (!opencode?.homeDir && !opencode?.tmpDir) throw new TypeError("The js_repl opencode runtime object is required");

  const runtime = createRuntime({ chromium, opencode, headless, webProfileDir, mobileProfileDir });
  installedRuntime = Object.freeze(runtime);
  return installedRuntime;
}

function createRuntime({ chromium, opencode, headless, webProfileDir, mobileProfileDir }) {
  let writeQueue = Promise.resolve();
  let webSession;
  let mobileSession;
  const controllerRegistry = new Map();
  const controllerLaunches = new Map();

  const defaults = {
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
  };

  const number = (value, fallback, minimum, maximum) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? clamp(parsed, minimum, maximum) : fallback;
  };

  const normalizeBehavior = (value) => {
    if (!value || value.schema !== 1 || typeof value.profileId !== "string" || !value.profileId) return undefined;
    const profile = { ...defaults, profileId: value.profileId };
    profile.clickPrecision = number(value.clickPrecision, profile.clickPrecision, 1, 5);
    profile.curveFactor = number(value.curveFactor, profile.curveFactor, 0.05, 0.3);
    profile.overshootChance = number(value.overshootChance, profile.overshootChance, 0, 1);
    profile.overshootMin = number(value.overshootMin, profile.overshootMin, 2, 10);
    profile.overshootMax = number(value.overshootMax, profile.overshootMax, 8, 25);
    profile.tremorCount = Math.round(number(value.tremorCount, profile.tremorCount, 2, 5));
    profile.tremorAmplitude = number(value.tremorAmplitude, profile.tremorAmplitude, 0.25, 3);
    profile.clickHoldMin = number(value.clickHoldMin, profile.clickHoldMin, 35, 100);
    profile.clickHoldMax = number(value.clickHoldMax, profile.clickHoldMax, 80, 160);
    profile.typingMean = number(value.typingMean, profile.typingMean, 50, 150);
    profile.typingSigma = number(value.typingSigma, profile.typingSigma, 0.1, 0.6);
    profile.keyHoldMin = number(value.keyHoldMin, profile.keyHoldMin, 20, 100);
    profile.keyHoldMax = number(value.keyHoldMax, profile.keyHoldMax, 60, 180);
    profile.actionGapMean = number(value.actionGapMean, profile.actionGapMean, 200, 800);
    profile.actionGapSigma = number(value.actionGapSigma, profile.actionGapSigma, 0.1, 0.6);
    if (profile.overshootMax < profile.overshootMin) profile.overshootMax = profile.overshootMin + 1;
    if (profile.clickHoldMax < profile.clickHoldMin) profile.clickHoldMax = profile.clickHoldMin + 1;
    if (profile.keyHoldMax < profile.keyHoldMin) profile.keyHoldMax = profile.keyHoldMin + 1;
    return profile;
  };

  const createBehavior = () => normalizeBehavior({
    ...defaults,
    profileId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    clickPrecision: uniform(2, 3),
    curveFactor: uniform(0.12, 0.18),
    overshootChance: uniform(0.4, 0.7),
    overshootMax: uniform(12, 18),
    tremorCount: Math.round(uniform(2, 5)),
    typingMean: uniform(75, 105),
    typingSigma: uniform(0.25, 0.35),
    actionGapMean: uniform(340, 460),
    actionGapSigma: uniform(0.3, 0.4),
  });

  const stealthPaths = ({ dataDir } = {}) => {
    const root = path.resolve(dataDir || path.join(opencode.tmpDir || opencode.homeDir, "stealth"));
    return {
      root,
      behaviorProfile: path.join(root, "behavior.json"),
      persona: path.join(root, "persona.json"),
      identityMetadata: path.join(root, "profile.json"),
      userData: path.join(root, "user-data"),
    };
  };

  const writeRecord = async (file, value, maximum = 16 * 1024) => {
    const serialized = JSON.stringify(value, null, 2);
    if (serialized.length > maximum) throw new Error(`Stealth record is unexpectedly large: ${file}`);
    writeQueue = writeQueue.then(async () => {
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
    return writeQueue;
  };

  const readRecord = async (file, normalize, create, maximum = 16 * 1024) => {
    let value;
    try {
      const stat = await fs.stat(file);
      if (stat.size <= maximum) value = normalize(JSON.parse(await fs.readFile(file, "utf8")));
    } catch {}
    value = value || create();
    await writeRecord(file, value, maximum);
    return value;
  };

  const loadBehavior = async ({ dataDir } = {}) => {
    const { behaviorProfile } = stealthPaths({ dataDir });
    let value;
    try {
      const stat = await fs.stat(behaviorProfile);
      if (stat.size <= 16 * 1024) value = normalizeBehavior(JSON.parse(await fs.readFile(behaviorProfile, "utf8")));
    } catch {}
    value = value || createBehavior();
    await writeRecord(behaviorProfile, value);
    return value;
  };

  const resetStealthProfile = async ({ dataDir } = {}) => {
    const { root } = stealthPaths({ dataDir });
    await writeQueue.catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  };

  const locale = () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    return {
      locale: typeof resolved.locale === "string" && resolved.locale ? resolved.locale : "en-US",
      timezoneId: typeof resolved.timeZone === "string" && resolved.timeZone ? resolved.timeZone : "UTC",
    };
  };

  const normalizePersona = (value) => {
    if (!value || ![1, PERSONA_SCHEMA].includes(value.schema) || typeof value.personaId !== "string" || !value.personaId || typeof value.locale !== "string" || typeof value.timezoneId !== "string") return undefined;
    return {
      schema: PERSONA_SCHEMA,
      personaId: value.personaId,
      profileKind: "desktop",
      browserChannel: "chromium",
      browserIdentity: "native",
      locale: value.locale,
      timezoneId: value.timezoneId,
      viewport: null,
      screen: null,
      deviceScaleFactor: number(value.deviceScaleFactor, 1, 1, 4),
      mobileDeviceScaleFactor: number(value.mobileDeviceScaleFactor, MOBILE_DEVICE_SCALE_FACTOR, 1, 4),
      isMobile: false,
      hasTouch: false,
      permissionsPolicy: "default",
      colorScheme: "no-preference",
      reducedMotion: "no-preference",
      createdAt: value.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  };

  const createPersona = () => ({
    schema: PERSONA_SCHEMA,
    personaId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    profileKind: "desktop",
    browserChannel: "chromium",
    browserIdentity: "native",
    ...locale(),
    viewport: null,
    screen: null,
    deviceScaleFactor: 1,
    mobileDeviceScaleFactor: MOBILE_DEVICE_SCALE_FACTOR,
    isMobile: false,
    hasTouch: false,
    permissionsPolicy: "default",
    colorScheme: "no-preference",
    reducedMotion: "no-preference",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const normalizeMetadata = (value) => value && value.schema === 1 && typeof value.profileId === "string" && value.profileId
    ? { schema: 1, profileId: value.profileId, personaId: value.personaId || "", behaviorSchema: 1, personaSchema: PERSONA_SCHEMA, createdAt: value.createdAt || new Date().toISOString(), lastUsedAt: new Date().toISOString(), resetGeneration: Number.isInteger(value.resetGeneration) ? value.resetGeneration : 0 }
    : undefined;

  const assertCoherentLaunchOptions = (launchOptions, contextOptions) => {
    const suppliedOptions = [launchOptions, contextOptions];
    const conflictingOptions = IDENTITY_CONTEXT_OPTIONS.filter((key) => suppliedOptions.some((options) => Object.prototype.hasOwnProperty.call(options, key)));
    if (conflictingOptions.length) throw new Error(`Identity-critical launch and context options are managed by the runtime: ${conflictingOptions.join(", ")}`);
    const conflictingArguments = (launchOptions.args || []).filter((argument) => IDENTITY_ARGUMENTS.some((prefix) => argument === prefix || argument.startsWith(`${prefix}=`)));
    if (conflictingArguments.length) throw new Error(`Identity-critical Chromium arguments are managed by the runtime: ${conflictingArguments.join(", ")}`);
    const conflictingHeaders = suppliedOptions
      .flatMap((options) => Object.keys(options.extraHTTPHeaders || {}))
      .filter((header) => IDENTITY_HEADERS.includes(header.toLowerCase()));
    if (conflictingHeaders.length) throw new Error(`Identity-critical HTTP headers are managed by Chromium: ${[...new Set(conflictingHeaders)].join(", ")}`);
  };

  const targetBox = async (currentPage, target, trialOptions) => {
    if (target && typeof target.boundingBox === "function") {
      if (trialOptions && typeof target.click === "function") await target.click({ ...trialOptions, trial: true });
      if (typeof target.isEnabled === "function" && !(await target.isEnabled())) throw new Error("Stealth target is disabled");
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) throw new Error("Stealth target is not visible");
      const candidates = [
        { x: 0.5, y: 0.5 }, { x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 },
        { x: 0.5, y: 0.25 }, { x: 0.5, y: 0.75 },
        ...Array.from({ length: 12 }, () => ({ x: clamp(0.5 + normal() * 0.2, 0.1, 0.9), y: clamp(0.5 + normal() * 0.2, 0.1, 0.9) })),
      ];
      const clickable = await target.evaluate((element, points) => {
        const rect = element.getBoundingClientRect();
        const root = element.getRootNode();
        const hitTestRoot = typeof root.elementFromPoint === "function" ? root : element.ownerDocument;
        const targetLink = element.closest?.("a[href]");
        return points.filter((point) => {
          const top = hitTestRoot.elementFromPoint(rect.left + rect.width * point.x, rect.top + rect.height * point.y);
          if (!top) return false;
          if (top === element || element.contains(top)) return true;
          const topLink = top.closest?.("a[href]");
          return Boolean(targetLink && topLink && targetLink.href === topLink.href);
        });
      }, candidates).catch(() => []);
      if (!clickable.length) throw new Error("Stealth target is obscured");
      return { ...box, stealthPoints: clickable.map((point) => ({ x: box.x + box.width * point.x, y: box.y + box.height * point.y })) };
    }
    if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) return { x: target.x, y: target.y, width: 1, height: 1 };
    throw new TypeError("Stealth target must be a Locator or { x, y }");
  };

  const pointFor = (box, profile) => box.stealthPoints?.length
    ? box.stealthPoints[Math.floor(Math.random() * box.stealthPoints.length)]
    : { x: box.width <= 1 ? box.x : clamp(box.x + box.width / 2 + normal() * profile.clickPrecision, box.x + 1, box.x + Math.max(1, box.width - 1)), y: box.height <= 1 ? box.y : clamp(box.y + box.height / 2 + normal() * profile.clickPrecision, box.y + 1, box.y + Math.max(1, box.height - 1)) };

  const pathBetween = (from, to, profile) => {
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
      points.push({ x: inverse ** 3 * from.x + 3 * inverse ** 2 * t * first.x + 3 * inverse * t ** 2 * second.x + t ** 3 * to.x, y: inverse ** 3 * from.y + 3 * inverse ** 2 * t * first.y + 3 * inverse * t ** 2 * second.y + t ** 3 * to.y });
    }
    if (distance > 40 && Math.random() < profile.overshootChance) {
      const amount = uniform(profile.overshootMin, profile.overshootMax);
      points.splice(-1, 0, { x: to.x + dx / distance * amount, y: to.y + dy / distance * amount });
    }
    return points;
  };

  const modifierList = (modifiers) => Array.isArray(modifiers) ? modifiers : modifiers ? [modifiers] : [];

  const createStealthController = async ({ chromium: suppliedChromium, headless: suppliedHeadless, dataDir, launchOptions = {}, contextOptions = {}, profileKind = "desktop" } = {}) => {
    const launchChromium = suppliedChromium || chromium;
    const launchHeadless = suppliedHeadless ?? headless;
    if (!launchChromium?.launchPersistentContext) throw new TypeError("createStealthController requires the shared Playwright chromium object");
    assertCoherentLaunchOptions(launchOptions, contextOptions);
    const paths = stealthPaths({ dataDir });
    const existing = controllerRegistry.get(paths.root);
    if (existing && existing.state() === "open") {
      if (existing.capabilities().profileKind !== profileKind) throw new Error(`The shared stealth profile is already open in ${existing.capabilities().profileKind} mode. Close it before switching to ${profileKind} mode.`);
      return existing;
    }
    const profile = await loadBehavior({ dataDir: paths.root });
    const persona = await readRecord(paths.persona, normalizePersona, createPersona);
    const metadata = await readRecord(paths.identityMetadata, normalizeMetadata, () => ({ schema: 1, profileId: profile.profileId, personaId: persona.personaId, behaviorSchema: 1, personaSchema: PERSONA_SCHEMA, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), resetGeneration: 0 }));
    metadata.profileId = profile.profileId;
    metadata.personaId = persona.personaId;
    await writeRecord(paths.identityMetadata, metadata);
    const mobile = profileKind === "mobile";
    const args = [...(launchOptions.args || [])];
    const emulatedViewport = mobile ? { ...MOBILE_VIEWPORT } : null;
    const options = {
      ...launchOptions,
      ...contextOptions,
      headless: launchOptions.headless ?? launchHeadless,
      args,
      locale: persona.locale,
      timezoneId: persona.timezoneId,
      viewport: emulatedViewport,
      ...(mobile ? { screen: { ...MOBILE_VIEWPORT } } : {}),
      isMobile: mobile,
      hasTouch: mobile,
      ...(mobile ? { deviceScaleFactor: persona.mobileDeviceScaleFactor } : {}),
    };
    let persistentContext;
    try {
      persistentContext = await launchChromium.launchPersistentContext(paths.userData, options);
    } catch (error) {
      throw new Error(`Could not open the persistent stealth profile at ${paths.userData}. Close any other session using it before retrying. ${error}`);
    }
    const browserVersion = persistentContext.browser()?.version?.() || "unknown";
    const identity = Object.freeze({
      browserEngine: "chromium",
      browserVersion,
      browserIdentity: "native",
      userAgentOverride: false,
      automationControlledOverride: false,
      locale: persona.locale,
      timezoneId: persona.timezoneId,
      emulation: mobile ? "responsive-touch" : "desktop",
      viewport: options.viewport ? Object.freeze({ ...options.viewport }) : null,
      screen: options.screen ? Object.freeze({ ...options.screen }) : null,
      deviceScaleFactor: mobile ? persona.mobileDeviceScaleFactor : null,
    });

    const stateByPage = new WeakMap();
    const livePages = new Set();
    const liveWorkers = new Set();
    const liveServiceWorkers = new Set();
    let status = "open";
    let closePromise;
    let contextClosed = false;
    let lastManagedOrigin;
    const telemetry = {
      startedAt: new Date().toISOString(),
      managedActions: 0,
      failedActions: 0,
      mainFrameNavigations: 0,
      popups: 0,
      lastDocumentStatus: undefined,
    };
    const removers = [];
    const addListener = (surface, event, listener) => { surface.on(event, listener); removers.push(() => surface.off(event, listener)); };
    const rememberOrigin = (currentPage) => {
      try {
        const url = new URL(currentPage.url());
        if (url.protocol === "http:" || url.protocol === "https:") lastManagedOrigin = url.origin;
      } catch {}
    };
    const closedBrowserError = () => new Error(`Managed ${profileKind} browser is closed. Recover with ${mobile ? "mobileStealth = await ensureMobileBrowser()" : "stealth = await ensureWebBrowser()"}, then replace the page with ${mobile ? "mobilePage = mobileStealth.pages()[0] || await mobileStealth.newPage()" : "page = stealth.pages()[0] || await stealth.newPage()"}.${lastManagedOrigin ? ` The last managed origin was ${lastManagedOrigin}; navigate only to that origin and resume with real UI interaction.` : " The replacement page is blank; navigate only to the requested site origin and resume with real UI interaction."} Do not inspect or act on the previous controller or page.`);
    const requireOpenBrowser = () => {
      if (status !== "open" || contextClosed) throw closedBrowserError();
    };
    const requirePage = (currentPage) => {
      requireOpenBrowser();
      if (!currentPage || typeof currentPage.isClosed !== "function") throw new Error("The target Page is not managed by this stealth session");
      const state = stateByPage.get(currentPage);
      if (!state || state.stopped || currentPage.isClosed()) throw new Error("The target Page is closed or is not managed by this stealth session. Select a current managed page or create one with stealth.newPage().");
      return state;
    };
    const viewport = async (currentPage) => currentPage.viewportSize() || await currentPage.evaluate(() => ({ width: innerWidth || 960, height: innerHeight || 540 })).catch(() => ({ width: 960, height: 540 }));
    const stopPage = (state) => {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
      for (const remove of state.removers.splice(0)) remove();
      state.frames.clear();
      for (const worker of state.workers) liveWorkers.delete(worker);
      state.workers.clear();
    };
    const markActivity = (state) => { state.lastActivity = Date.now(); if (state.timer) clearTimeout(state.timer); state.timer = undefined; };
    const queueAction = (currentPage, name, action) => {
      const state = requirePage(currentPage);
      const run = async () => {
        requirePage(currentPage);
        telemetry.managedActions += 1;
        state.busy = true;
        state.action = name;
        try { return await action(state); }
        catch (error) { telemetry.failedActions += 1; throw error; }
        finally { state.busy = false; state.action = undefined; markActivity(state); }
      };
      const result = state.queue.then(run, run);
      state.queue = result.catch(() => {});
      return result;
    };
    const moveToPoint = async (currentPage, state, point) => {
      const size = await viewport(currentPage);
      const from = { x: state.x ?? size.width / 2, y: state.y ?? size.height / 2 };
      const points = pathBetween(from, point, profile);
      const perPoint = Math.max(5, clamp(Math.hypot(point.x - from.x, point.y - from.y) * 0.5 + 80, 80, 350) / points.length);
      for (const next of points) { requirePage(currentPage); await currentPage.mouse.move(next.x, next.y); state.x = next.x; state.y = next.y; await sleep(uniform(perPoint * 0.75, perPoint * 1.25)); }
    };
    const withModifiers = async (currentPage, modifiers, action) => {
      const pressed = [];
      try { for (const modifier of modifierList(modifiers)) { await currentPage.keyboard.down(modifier); pressed.push(modifier); } return await action(); }
      finally { for (const modifier of pressed.reverse()) await currentPage.keyboard.up(modifier).catch(() => {}); }
    };
    const typeText = async (currentPage, text) => {
      if (typeof text !== "string") throw new TypeError("Stealth text input requires a string");
      for (const character of text) {
        if (/^[\p{Letter}\p{Number}\p{P}\p{S}\p{Zs}]$/u.test(character)) {
          try { await currentPage.keyboard.press(character, { delay: uniform(profile.keyHoldMin, profile.keyHoldMax) }); } catch { await currentPage.keyboard.insertText(character); }
        } else await currentPage.keyboard.insertText(character);
        await sleep(logNormal(character === " " ? 120 : profile.typingMean, character === " " ? 0.25 : profile.typingSigma));
      }
    };
    const performClick = async (currentPage, state, target, options = {}, count = 1) => {
      const box = await targetBox(currentPage, target, { button: options.button, modifiers: options.modifiers });
      const point = pointFor(box, profile);
      await sleep(Math.min(1200, logNormal(profile.actionGapMean, profile.actionGapSigma)));
      await withModifiers(currentPage, options.modifiers, async () => {
        for (let clickIndex = 0; clickIndex < count; clickIndex += 1) {
          await moveToPoint(currentPage, state, point);
          const tremorCount = clamp(Math.round(uniform(2, profile.tremorCount + 1)), 2, 5);
          for (let index = 0; index < tremorCount; index += 1) { await currentPage.mouse.move(point.x + uniform(-profile.tremorAmplitude, profile.tremorAmplitude), point.y + uniform(-profile.tremorAmplitude, profile.tremorAmplitude)); await sleep(uniform(15, 45)); }
          await currentPage.mouse.move(point.x, point.y);
          const button = options.button || "left";
          const clickCount = count === 2 ? clickIndex + 1 : 1;
          await currentPage.mouse.down({ button, clickCount });
          try { await sleep(uniform(profile.clickHoldMin, profile.clickHoldMax)); } finally { await currentPage.mouse.up({ button, clickCount }); }
          if (count === 2) await sleep(uniform(60, 140));
        }
      });
    };
    const clickAction = (currentPage, target, options = {}, count = 1) => queueAction(currentPage, count === 2 ? "doubleClick" : "click", (state) => performClick(currentPage, state, target, options, count));
    const registerPage = (currentPage) => {
      if (status !== "open" || !currentPage || currentPage.isClosed() || stateByPage.has(currentPage)) return;
      if (currentPage.context() !== persistentContext) throw new Error("Cannot register a Page from another BrowserContext");
      const state = { x: undefined, y: undefined, busy: false, action: undefined, lastActivity: Date.now(), inventoryReadyAt: Date.now() + 1800, lastDocumentStatus: undefined, timer: undefined, stopped: false, queue: Promise.resolve(), frames: new Set(), workers: new Set(), removers: [] };
      stateByPage.set(currentPage, state);
      livePages.add(currentPage);
      rememberOrigin(currentPage);
      const registerFrame = (frame) => { if (frame !== currentPage.mainFrame()) state.frames.add(frame); };
      const registerWorker = (worker) => { state.workers.add(worker); liveWorkers.add(worker); };
      const onClose = () => { livePages.delete(currentPage); stopPage(state); };
      const onPopup = (popup) => { telemetry.popups += 1; registerPage(popup); };
      const onFrameAttached = registerFrame;
      const onFrameNavigated = (frame) => { registerFrame(frame); if (frame === currentPage.mainFrame()) { telemetry.mainFrameNavigations += 1; state.inventoryReadyAt = Date.now() + 1800; rememberOrigin(currentPage); } };
      const onResponse = (response) => {
        try {
          if (response.request().resourceType() === "document" && response.frame() === currentPage.mainFrame()) state.lastDocumentStatus = telemetry.lastDocumentStatus = response.status();
        } catch {}
      };
      const onFrameDetached = (frame) => state.frames.delete(frame);
      const onWorker = registerWorker;
      currentPage.on("close", onClose);
      currentPage.on("popup", onPopup);
      currentPage.on("frameattached", onFrameAttached);
      currentPage.on("framenavigated", onFrameNavigated);
      currentPage.on("framedetached", onFrameDetached);
      currentPage.on("worker", onWorker);
      currentPage.on("response", onResponse);
      state.removers.push(
        () => currentPage.off("close", onClose),
        () => currentPage.off("popup", onPopup),
        () => currentPage.off("frameattached", onFrameAttached),
        () => currentPage.off("framenavigated", onFrameNavigated),
        () => currentPage.off("framedetached", onFrameDetached),
        () => currentPage.off("worker", onWorker),
        () => currentPage.off("response", onResponse),
      );
      for (const frame of currentPage.frames()) registerFrame(frame);
      for (const worker of currentPage.workers()) registerWorker(worker);
    };
    for (const currentPage of persistentContext.pages()) registerPage(currentPage);
    addListener(persistentContext, "page", registerPage);
    if (typeof persistentContext.serviceWorkers === "function") for (const worker of persistentContext.serviceWorkers()) liveServiceWorkers.add(worker);
    const onServiceWorker = (worker) => liveServiceWorkers.add(worker);
    try { addListener(persistentContext, "serviceworker", onServiceWorker); } catch {}
    const onContextClose = () => {
      contextClosed = true;
      if (status === "open") status = "closed";
      for (const currentPage of livePages) stopPage(stateByPage.get(currentPage));
      livePages.clear();
      liveWorkers.clear();
      liveServiceWorkers.clear();
    };
    addListener(persistentContext, "close", onContextClose);
    const resolveVisible = async (currentPage, locatorForFrame, { timeout = 5000 } = {}) => {
      requirePage(currentPage);
      if (typeof locatorForFrame !== "function") throw new TypeError("resolveVisible requires a locator factory");
      const deadline = Date.now() + clamp(Number(timeout) || 0, 0, 30000);
      do {
        const matches = [];
        for (const frame of currentPage.frames()) {
          let locator;
          try { locator = locatorForFrame(frame); } catch { continue; }
          const count = await locator?.count?.().catch(() => 0) || 0;
          for (let index = 0; index < count; index += 1) if (await locator.nth(index).isVisible().catch(() => false)) matches.push({ frame, locator: locator.nth(index) });
        }
        if (matches.length === 1) return Object.freeze(matches[0]);
        if (matches.length > 1) throw new Error(`Target is ambiguous across ${matches.length} visible frame matches`);
        await sleep(100);
      } while (Date.now() < deadline);
      throw new Error(`Visible target did not appear in any frame within ${Math.max(0, Number(timeout) || 0)}ms. Frames: ${currentPage.frames().map((frame) => frame.url()).join(", ")}`);
    };
    const interactiveElements = async (currentPage, { includeHidden = false } = {}) => {
      const state = requirePage(currentPage);
      const readinessDelay = state.inventoryReadyAt - Date.now();
      if (readinessDelay > 0) await sleep(readinessDelay);
      const selector = "button, a[href], input:not([type=hidden]), select, textarea, summary, [role], [contenteditable=true], [tabindex]:not([tabindex='-1'])";
      const frames = currentPage.frames().filter((frame) => frame === currentPage.mainFrame() || !["", "about:blank"].includes(frame.url()));
      const groups = await Promise.all(frames.map(async (frame, frameIndex) => {
        const candidates = frame.locator(selector);
        const details = await candidates.evaluateAll((elements, options) => elements.map((element, index) => {
          const rect = element.getBoundingClientRect();
          let visible = rect.width > 0 && rect.height > 0 && !element.hidden;
          if (visible && typeof element.checkVisibility === "function") visible = element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
          if (!options.includeHidden && !visible) return undefined;
          const tag = element.tagName.toLowerCase();
          const type = element.getAttribute("type")?.toLowerCase();
          const labels = element.labels ? [...element.labels].map((label) => label.textContent?.trim()).filter(Boolean).join(" ") : "";
          const name = element.getAttribute("aria-label")?.trim() || labels || element.getAttribute("alt")?.trim() || (element.textContent || "").trim() || element.getAttribute("placeholder")?.trim() || element.getAttribute("title")?.trim() || "";
          let role = element.getAttribute("role")?.trim() || "";
          if (!role) {
            if (tag === "button" || tag === "summary" || ["button", "submit", "reset", "image"].includes(type)) role = "button";
            else if (tag === "a" && element.hasAttribute("href")) role = "link";
            else if (tag === "input" && type === "checkbox") role = "checkbox";
            else if (tag === "input" && type === "radio") role = "radio";
            else if (tag === "select") role = element.multiple || element.size > 1 ? "listbox" : "combobox";
            else if (tag === "textarea" || tag === "input" || element.isContentEditable) role = "textbox";
          }
          return { index, visible, tag, type: type || "", role, name: name.slice(0, 240), disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"), checked: "checked" in element ? Boolean(element.checked) : element.getAttribute("aria-checked"), selected: "selected" in element ? Boolean(element.selected) : element.getAttribute("aria-selected"), href: element.href || "" };
        }).filter(Boolean), { includeHidden }).catch(() => []);
        return { frame, frameIndex, candidates, details, index: 0 };
      }));
      const entries = [];
      while (groups.some((group) => group.index < group.details.length)) for (const group of groups) if (group.index < group.details.length) { const details = group.details[group.index++]; entries.push(Object.freeze({ frame: group.frame, frameIndex: group.frameIndex, locator: group.candidates.nth(details.index), frameUrl: group.frame.url(), ...details })); }
      return Object.freeze(entries);
    };
    const moveToTarget = async (currentPage, state, target, trialOptions) => { const box = await targetBox(currentPage, target, trialOptions); await moveToPoint(currentPage, state, pointFor(box, profile)); };
    const wheelSteps = async (currentPage, deltaX, deltaY) => {
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 180));
      for (let index = 0; index < steps; index += 1) { await currentPage.mouse.wheel(deltaX / steps, deltaY / steps); if (index + 1 < steps) await sleep(uniform(30, 80)); }
    };
    const wheel = (currentPage, deltaX, deltaY, target) => queueAction(currentPage, "wheel", async (state) => {
      if (target !== undefined) await moveToTarget(currentPage, state, target);
      await wheelSteps(currentPage, deltaX, deltaY);
    });
    const session = {
      get context() { requireOpenBrowser(); return persistentContext; },
      profile: Object.freeze({ ...profile }),
      persona: Object.freeze({ ...persona }),
      identity,
      dataDir: paths.root,
      pages: () => { requireOpenBrowser(); return persistentContext.pages().filter((currentPage) => stateByPage.has(currentPage)); },
      newPage: async () => { requireOpenBrowser(); const currentPage = await persistentContext.newPage(); registerPage(currentPage); return currentPage; },
      pageState: (currentPage) => { const state = requirePage(currentPage); return Object.freeze({ registered: true, busy: state.busy, action: state.action, timerActive: Boolean(state.timer), stopped: state.stopped, lastDocumentStatus: state.lastDocumentStatus }); },
      managed: (currentPage) => { requirePage(currentPage); return true; },
      telemetry: () => Object.freeze({ ...telemetry }),
      capabilities: () => Object.freeze({ state: status, profileKind, lastManagedOrigin, persistentIdentity: true, behaviorSchema: profile.schema, personaSchema: persona.schema, managedInput: true, ambientInput: false, automaticPagesAndPopups: true, frameLifecycle: true, crossFrameTargetResolution: true, semanticInteractiveInventory: true, postNavigationInventoryGraceMs: 1800, documentInitScript: false, dedicatedWorkers: "observed-only", serviceWorkers: "observed-only", mobile, touch: mobile, locale: persona.locale, timezoneId: persona.timezoneId, deviceScaleFactor: identity.deviceScaleFactor, userAgent: undefined, identity, sharedProfileRequiresSequentialModes: !dataDir, artifacts: Object.freeze({ bindings: false, cdp: false, runtimeCdpPatch: false, standardPlaywrightProtocol: true, privatePlaywrightApis: false, tracing: false, har: false, video: false }) }),
      resolveVisible,
      interactiveElements,
      moveTo: (currentPage, target) => queueAction(currentPage, "moveTo", (state) => moveToTarget(currentPage, state, target)),
      click: (currentPage, target, options) => clickAction(currentPage, target, options),
      doubleClick: (currentPage, target, options) => clickAction(currentPage, target, options, 2),
      hover: (currentPage, target) => queueAction(currentPage, "hover", (state) => moveToTarget(currentPage, state, target)),
      wheel,
      scroll: (currentPage, targetOrDelta, deltaY) => typeof targetOrDelta === "number"
        ? wheel(currentPage, 0, targetOrDelta)
        : Number.isFinite(deltaY)
          ? wheel(currentPage, 0, deltaY, targetOrDelta)
          : queueAction(currentPage, "scroll", async (state) => { if (!targetOrDelta || typeof targetOrDelta.scrollIntoViewIfNeeded !== "function") throw new TypeError("Stealth scroll requires a Locator or numeric delta"); await targetOrDelta.scrollIntoViewIfNeeded(); await moveToTarget(currentPage, state, targetOrDelta); }),
      dragTo: (currentPage, source, target) => queueAction(currentPage, "dragTo", async (state) => { await moveToTarget(currentPage, state, source, { button: "left" }); if (typeof source.dragTo !== "function") throw new TypeError("Stealth dragTo requires Locator targets"); await source.dragTo(target); }),
      type: (currentPage, target, text) => queueAction(currentPage, "type", async (state) => { await moveToTarget(currentPage, state, target); await target.focus(); await typeText(currentPage, text); }),
      fill: (currentPage, target, text) => queueAction(currentPage, "fill", async (state) => { if (typeof target.focus !== "function") throw new TypeError("Stealth fill requires a Locator target"); if (typeof target.isEditable === "function" && !(await target.isEditable())) throw new Error("Stealth fill target is not editable"); await moveToTarget(currentPage, state, target); await target.focus(); await currentPage.keyboard.press("Control+A"); await currentPage.keyboard.press("Backspace"); await typeText(currentPage, text); }),
      pressText: (currentPage, text) => queueAction(currentPage, "pressText", () => typeText(currentPage, text)),
      press: (currentPage, key) => queueAction(currentPage, "press", async () => currentPage.keyboard.press(key, { delay: uniform(profile.keyHoldMin, profile.keyHoldMax) })),
      focus: (currentPage, target) => queueAction(currentPage, "focus", async (state) => { await moveToTarget(currentPage, state, target); await target.focus(); }),
      check: (currentPage, target) => queueAction(currentPage, "check", async (state) => { if (!(await target.isChecked())) await performClick(currentPage, state, target); }),
      uncheck: (currentPage, target) => queueAction(currentPage, "uncheck", async (state) => { if (await target.isChecked()) await performClick(currentPage, state, target); }),
      selectOption: (currentPage, target, values) => queueAction(currentPage, "selectOption", async (state) => { await moveToTarget(currentPage, state, target, { button: "left" }); await target.focus(); await sleep(uniform(80, 180)); await target.selectOption(values); }),
      tap: (currentPage, target) => { if (!mobile) throw new Error("Stealth tap requires an active mobile/touch session"); return queueAction(currentPage, "tap", async (state) => { const box = await targetBox(currentPage, target); const point = pointFor(box, profile); await sleep(uniform(120, 300)); await moveToPoint(currentPage, state, point); await currentPage.touchscreen.tap(point.x, point.y); }); },
      think: (currentPage, milliseconds) => queueAction(currentPage, "think", () => sleep(clamp(Number(milliseconds) || 0, 0, 300000))),
      screenshot: (currentPage, options) => queueAction(currentPage, "screenshot", async (state) => { state.paused = true; try { return await currentPage.screenshot(options); } finally { state.paused = false; } }),
      stop: (currentPage) => stopPage(requirePage(currentPage)),
      state: () => status,
      close: async () => {
        if (closePromise) return closePromise;
        closePromise = (async () => { status = "closing"; for (const remove of removers.splice(0)) remove(); for (const currentPage of livePages) stopPage(stateByPage.get(currentPage)); livePages.clear(); liveWorkers.clear(); liveServiceWorkers.clear(); if (!contextClosed) await persistentContext.close().catch(() => {}); status = "closed"; if (controllerRegistry.get(paths.root) === session) controllerRegistry.delete(paths.root); })();
        return closePromise;
      },
      resetProfile: async () => { await session.close(); await resetStealthProfile({ dataDir: paths.root }); status = "reset"; },
    };
    controllerRegistry.set(paths.root, session);
    metadata.lastUsedAt = new Date().toISOString();
    await writeRecord(paths.identityMetadata, metadata);
    return session;
  };

  const ensureController = async (kind, options) => {
    const current = kind === "mobile" ? mobileSession : webSession;
    if (current && current.state() === "open") return current;
    const root = path.resolve(options.dataDir || path.join(opencode.tmpDir || opencode.homeDir, "stealth"));
    const key = `${kind}:${root}`;
    if (!controllerLaunches.has(key)) controllerLaunches.set(key, createStealthController(options).finally(() => controllerLaunches.delete(key)));
    const session = await controllerLaunches.get(key);
    if (kind === "mobile") mobileSession = session;
    else webSession = session;
    return session;
  };

  return {
    ensureWebBrowser: () => ensureController("desktop", { dataDir: webProfileDir, profileKind: "desktop" }),
    ensureMobileBrowser: () => ensureController("mobile", { dataDir: mobileProfileDir || webProfileDir, profileKind: "mobile" }),
    createStealthController,
    launchStealthChromium: createStealthController,
    resetStealthProfile,
    stealthControllerRegistry: controllerRegistry,
  };
}
