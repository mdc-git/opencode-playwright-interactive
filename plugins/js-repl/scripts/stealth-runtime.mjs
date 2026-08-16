import path from "node:path";
import {
  FALLBACK_VIEWPORT,
  IDENTITY_ARGUMENTS,
  IDENTITY_CONTEXT_OPTIONS,
  IDENTITY_HEADERS,
  KEY_NEIGHBORHOOD,
  MOBILE_VIEWPORT,
  STEALTH_ARGUMENTS,
  STRUCTURAL_ROLES,
  clamp,
  digraphFactor,
  fittsDuration,
  logNormal,
  normal,
  pathBetween,
  pointFor,
  settleWithin,
  sleep,
  uniform,
} from "./stealth-utils.mjs";
import {
  createPersona,
  createProfileStore,
  normalizeMetadata,
  normalizePersona,
} from "./stealth-profile-store.mjs";

let installedRuntime;

const modifierList = (modifiers) => Array.isArray(modifiers) ? modifiers : modifiers ? [modifiers] : [];

export async function installStealthRuntime({
  chromium,
  browserEngine = "chromium",
  opencode,
  headless = false,
  webProfileDir,
  mobileProfileDir,
} = {}) {
  if (installedRuntime) return installedRuntime;
  if (!chromium?.launchPersistentContext) throw new TypeError("The shared Playwright launcher (chromium or a camoufox firefox shim) is required");
  if (browserEngine !== "chromium" && browserEngine !== "camoufox") throw new TypeError("browserEngine must be \"chromium\" or \"camoufox\"");
  if ((!opencode?.homeDir && !opencode?.tmpDir) || !opencode?.sessionId || typeof opencode.bindBrowser !== "function") throw new TypeError("The session-aware js_repl opencode runtime object is required");

  const runtime = createRuntime({ chromium, browserEngine, opencode, headless, webProfileDir, mobileProfileDir });
  installedRuntime = Object.freeze(runtime);
  return installedRuntime;
}

function createRuntime({ chromium, browserEngine, opencode, headless, webProfileDir, mobileProfileDir }) {
  let webSession;
  let mobileSession;
  const runtimeSessionId = opencode.sessionId;
  const controllerRegistry = new Map();
  const controllerLaunches = new Map();
  const baseDir = opencode.tmpDir || opencode.homeDir;

  // Persistence lives behind one store with a single serialized write queue.
  const {
    paths: stealthPaths,
    writeRecord,
    readRecord,
    loadBehavior,
    resetStealthProfile,
  } = createProfileStore(baseDir);

  const assertCoherentLaunchOptions = (launchOptions, contextOptions) => {
    const suppliedOptions = [launchOptions, contextOptions];
    const conflictingOptions = IDENTITY_CONTEXT_OPTIONS.filter((key) => suppliedOptions.some((options) => Object.prototype.hasOwnProperty.call(options, key)));
    if (conflictingOptions.length) throw new Error(`Identity-critical launch and context options are managed by the runtime: ${conflictingOptions.join(", ")}`);
    const conflictingArguments = (launchOptions.args || []).filter((argument) => IDENTITY_ARGUMENTS.some((prefix) => argument === prefix || argument.startsWith(`${prefix}=`)));
    if (conflictingArguments.length) throw new Error(`Identity-critical browser arguments are managed by the runtime: ${conflictingArguments.join(", ")}`);
    const conflictingHeaders = suppliedOptions
      .flatMap((options) => Object.keys(options.extraHTTPHeaders || {}))
      .filter((header) => IDENTITY_HEADERS.includes(header.toLowerCase()));
    if (conflictingHeaders.length) throw new Error(`Identity-critical HTTP headers are managed by the browser: ${[...new Set(conflictingHeaders)].join(", ")}`);
  };

  const targetBox = async (currentPage, target, browserBinding) => {
    if (target && typeof target.boundingBox === "function") {
      browserBinding.assertLocator(currentPage, target);
      const semantics = await target.evaluate((element) => ({
        role: element.getAttribute("role")?.toLowerCase() || "",
        tag: element.tagName.toLowerCase(),
        nativeControl: element.matches("button, a[href], input:not([type=hidden]), select, textarea, summary, [contenteditable=true]"),
      }));
      if (!semantics.nativeControl && (STRUCTURAL_ROLES.includes(semantics.role) || ["search", "main", "nav", "header", "footer"].includes(semantics.tag))) {
        throw new Error(`Stealth target is a non-interactive ${semantics.role || semantics.tag} container; locate its nested control`);
      }
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

  const createStealthController = async ({ chromium: suppliedChromium, headless: suppliedHeadless, dataDir, launchOptions = {}, contextOptions = {}, profileKind = "desktop" } = {}) => {
    const launchChromium = suppliedChromium || chromium;
    const launchHeadless = suppliedHeadless ?? headless;
    if (!launchChromium?.launchPersistentContext) throw new TypeError("createStealthController requires a Playwright-compatible launcher (chromium or camoufox firefox shim)");
    assertCoherentLaunchOptions(launchOptions, contextOptions);
    const paths = stealthPaths({ dataDir });
    let existing = controllerRegistry.get(paths.root);
    if (existing?.state() === "externally-closed") throw new Error(`The browser bound to OpenCode session ${runtimeSessionId} was closed outside the controller. This controller cannot relaunch or adopt another session's browser.`);
    if (existing && existing.state() === "closing") {
      // A close is in flight for this profile. Wait for it instead of racing a
      // fresh launch against a user-data directory Chromium still owns.
      await existing.close().catch(() => {});
      existing = controllerRegistry.get(paths.root);
      if (existing?.state() === "externally-closed") throw new Error(`The browser bound to OpenCode session ${runtimeSessionId} was closed outside the controller. This controller cannot relaunch or adopt another session's browser.`);
    }
    if (existing && existing.state() === "open") {
      if (existing.capabilities().profileKind !== profileKind) throw new Error(`The shared stealth profile is already open in ${existing.capabilities().profileKind} mode. Close it before switching to ${profileKind} mode.`);
      return existing;
    }
    const profile = await loadBehavior({ dataDir: paths.root });
    const persona = await readRecord(paths.persona, normalizePersona, createPersona);
    const metadata = await readRecord(paths.identityMetadata, normalizeMetadata, () => ({ schema: 2, profileId: profile.profileId, personaId: persona.personaId, sessionId: runtimeSessionId, behaviorSchema: profile.schema, personaSchema: persona.schema, createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), resetGeneration: 0 }));
    if (metadata.sessionId && metadata.sessionId !== runtimeSessionId) throw new Error(`Stealth profile ${paths.root} is bound to a different OpenCode session and cannot be adopted`);
    metadata.profileId = profile.profileId;
    metadata.personaId = persona.personaId;
    metadata.sessionId = runtimeSessionId;
    await writeRecord(paths.identityMetadata, metadata);
    const mobile = profileKind === "mobile";
    // Camoufox provides its stealth and identity natively (C++ level patches
    // in the Firefox fork); injecting Chromium stealth flags would leak or
    // break launch, so they apply only to the Chromium engine.
    const args = browserEngine === "camoufox"
      ? [...(launchOptions.args || [])]
      : [...STEALTH_ARGUMENTS, ...(launchOptions.args || [])];
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
    const browserBinding = opencode.bindBrowser({ browser: persistentContext.browser(), context: persistentContext, browserId: profile.profileId, profileKind });
    const identity = Object.freeze({
      browserEngine,
      browserVersion,
      browserIdentity: "native",
      userAgentOverride: false,
      automationControlledOverride: true,
      locale: persona.locale,
      timezoneId: persona.timezoneId,
      emulation: mobile ? "responsive-touch" : "desktop",
      viewport: options.viewport ? Object.freeze({ ...options.viewport }) : null,
      screen: options.screen ? Object.freeze({ ...options.screen }) : null,
      deviceScaleFactor: mobile ? persona.mobileDeviceScaleFactor : null,
    });
    const binding = browserBinding.binding;

    const stateByPage = new WeakMap();
    const livePages = new Set();
    let status = "open";
    let pageSequence = 0;
    let closePromise;
    let contextClosed = false;
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
    const closedBrowserError = () => new Error(`Managed ${profileKind} browser ${binding.browserId} bound to OpenCode session ${binding.sessionId} is closed. This controller cannot relaunch or adopt another session's browser. Stop interacting and report that this session's browser was closed.`);
    const requireOpenBrowser = () => {
      if (status !== "open" || contextClosed) throw closedBrowserError();
    };
    const requirePage = (currentPage) => {
      requireOpenBrowser();
      browserBinding.assertPage(currentPage);
      const state = stateByPage.get(currentPage);
      if (!state || state.stopped || currentPage.isClosed()) throw new Error("The target Page is closed or is not managed by this stealth session. Select a current managed page or create one with stealth.newPage().");
      return state;
    };
    const viewport = async (currentPage) => currentPage.viewportSize() || await currentPage.evaluate(({ width, height }) => ({ width: innerWidth || width, height: innerHeight || height }), FALLBACK_VIEWPORT).catch(() => ({ ...FALLBACK_VIEWPORT }));
    const stopPage = (state, { unregister = false } = {}) => {
      if (!state || state.stopped) return;
      state.stopped = true;
      for (const remove of state.removers.splice(0)) remove();
      if (unregister && state.page) {
        // A stopped page must not stay discoverable through pages() while
        // rejecting every operation.
        livePages.delete(state.page);
        stateByPage.delete(state.page);
      }
    };
    const queueAction = (currentPage, name, action) => {
      const state = requirePage(currentPage);
      const run = async () => {
        requirePage(currentPage);
        telemetry.managedActions += 1;
        state.busy = true;
        state.action = name;
        try { return await action(state); }
        catch (error) { telemetry.failedActions += 1; throw error; }
        finally { state.busy = false; state.action = undefined; }
      };
      const result = state.queue.then(run, run);
      state.queue = result.catch(() => {});
      return result;
    };
    // Move along the Bezier path with a human velocity profile: slow launch,
    // fast mid-flight, decelerating approach. Total travel time follows
    // Fitts's law rather than a constant rate per pixel.
    const moveToPoint = async (currentPage, state, point) => {
      const size = await viewport(currentPage);
      const from = { x: state.x ?? size.width / 2, y: state.y ?? size.height / 2 };
      const points = pathBetween(from, point, profile);
      const distance = Math.hypot(point.x - from.x, point.y - from.y);
      const duration = fittsDuration(distance, point.targetSize || 10, profile);
      let elapsed = 0;
      for (let index = 0; index < points.length; index += 1) {
        const next = points[index];
        requirePage(currentPage);
        await currentPage.mouse.move(next.x, next.y);
        state.x = next.x;
        state.y = next.y;
        if (index + 1 >= points.length) break;
        const t = (index + 2) / points.length;
        const eased = duration * t * t * (3 - 2 * t);
        const slice = eased - elapsed;
        elapsed = eased;
        await sleep(Math.max(4, slice * uniform(0.8, 1.2)));
      }
    };
    const withModifiers = async (currentPage, modifiers, action) => {
      const pressed = [];
      try { for (const modifier of modifierList(modifiers)) { await currentPage.keyboard.down(modifier); pressed.push(modifier); } return await action(); }
      finally { for (const modifier of pressed.reverse()) await currentPage.keyboard.up(modifier).catch(() => {}); }
    };
    const pressKey = async (currentPage, character, holdMin = profile.keyHoldMin, holdMax = profile.keyHoldMax) => {
      try { await currentPage.keyboard.press(character, { delay: uniform(holdMin, holdMax) }); } catch { await currentPage.keyboard.insertText(character); }
    };
    const typeText = async (currentPage, text) => {
      if (typeof text !== "string") throw new TypeError("Stealth text input requires a string");
      if (!text.length) return;
      // Humans plan before the first keystroke of a burst.
      await sleep(logNormal(300, 0.3));
      let previous = "";
      for (const character of text) {
        // Substitution typo using an adjacent QWERTY key, followed by the
        // human latency to notice, backspace, and retype.
        const typoNeighbor = typeof character === "string" && /^[a-z]$/i.test(character) && Math.random() < profile.typoRate
          ? KEY_NEIGHBORHOOD[character.toLowerCase()]
          : undefined;
        if (typoNeighbor) {
          await pressKey(currentPage, typoNeighbor[Math.floor(Math.random() * typoNeighbor.length)]);
          await sleep(logNormal(profile.typingMean, profile.typingSigma));
          await sleep(logNormal(280, 0.3));
          await currentPage.keyboard.press("Backspace", { delay: uniform(profile.keyHoldMin, profile.keyHoldMax) });
          await sleep(logNormal(240, 0.3));
          previous = "";
        }
        if (/^[\p{Letter}\p{Number}\p{P}\p{S}\p{Zs}]$/u.test(character)) await pressKey(currentPage, character);
        else await currentPage.keyboard.insertText(character);
        const base = character === " "
          ? logNormal(120, 0.25)
          : logNormal(profile.typingMean, profile.typingSigma) * digraphFactor(previous, character);
        await sleep(Math.max(8, base));
        previous = character;
      }
    };
    const performClick = async (currentPage, state, target, options = {}, count = 1) => {
      const box = await targetBox(currentPage, target, browserBinding);
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
      const state = { page: currentPage, pageId: `${profile.profileId}:${++pageSequence}`, x: undefined, y: undefined, busy: false, action: undefined, inventoryReadyAt: Date.now() + 1800, lastDocumentStatus: undefined, stopped: false, queue: Promise.resolve(), removers: [] };
      stateByPage.set(currentPage, state);
      livePages.add(currentPage);
      const onClose = () => { livePages.delete(currentPage); stopPage(state); };
      const onPopup = (popup) => { telemetry.popups += 1; registerPage(popup); };
      const onFrameNavigated = (frame) => { if (frame === currentPage.mainFrame()) { telemetry.mainFrameNavigations += 1; state.inventoryReadyAt = Date.now() + 1800; } };
      const onResponse = (response) => {
        try {
          if (response.request().resourceType() === "document" && response.frame() === currentPage.mainFrame()) state.lastDocumentStatus = telemetry.lastDocumentStatus = response.status();
        } catch {}
      };
      currentPage.on("close", onClose);
      currentPage.on("popup", onPopup);
      currentPage.on("framenavigated", onFrameNavigated);
      currentPage.on("response", onResponse);
      state.removers.push(
        () => currentPage.off("close", onClose),
        () => currentPage.off("popup", onPopup),
        () => currentPage.off("framenavigated", onFrameNavigated),
        () => currentPage.off("response", onResponse),
      );
    };
    for (const currentPage of persistentContext.pages()) registerPage(currentPage);
    addListener(persistentContext, "page", registerPage);
    const onContextClose = () => {
      contextClosed = true;
      if (status === "open") status = "externally-closed";
      for (const currentPage of livePages) stopPage(stateByPage.get(currentPage));
      livePages.clear();
    };
    addListener(persistentContext, "close", onContextClose);
    const resolveEntryFrame = async (currentPage, entry) => {
      try {
        const handle = await entry.locator.elementHandle({ timeout: 0 });
        if (handle) {
          const frame = handle.ownerFrame();
          if (frame) return frame;
        }
      } catch { /* fall through to the main frame as a best-effort attribution */ }
      return currentPage.mainFrame();
    };
    const resolveVisible = async (currentPage, locatorForFrame, { timeout = 5000 } = {}) => {
      requirePage(currentPage);
      if (typeof locatorForFrame !== "function") throw new TypeError("resolveVisible requires a locator factory");
      const deadline = Date.now() + clamp(Number(timeout) || 0, 0, 30000);
      let nextSemanticProbeAt = 0;
      do {
        const semanticQueries = [];
        const frameMatches = await Promise.all(currentPage.frames().map(async (frame) => {
          let locator;
          try {
            const queryFrame = new Proxy(frame, {
              get(target, property) {
                if (property === "getByRole") return (role, options = {}) => {
                  semanticQueries.push({ frame, role, options });
                  return target.getByRole(role, options);
                };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            locator = locatorForFrame(queryFrame);
          } catch { return []; }
          const probeTimeout = Math.min(1000, Math.max(1, deadline - Date.now()));
          const count = await settleWithin(locator?.count?.(), probeTimeout, 0) || 0;
          const visibility = await Promise.all(Array.from({ length: count }, (_, index) => settleWithin(locator.nth(index).isVisible(), probeTimeout, false)));
          return visibility.flatMap((visible, index) => visible ? [{ frame, locator: locator.nth(index) }] : []);
        }));
        const matches = frameMatches.flat();
        if (matches.length === 1) return Object.freeze(matches[0]);
        if (matches.length > 1) throw new Error(`Target is ambiguous across ${matches.length} visible frame matches`);
        if (semanticQueries.length && Date.now() >= nextSemanticProbeAt) {
          nextSemanticProbeAt = Date.now() + 500;
          const supportedOptions = new Set(["name", "exact", "disabled", "checked", "selected"]);
          const queries = semanticQueries.filter(({ options }) => Object.keys(options).every((key) => supportedOptions.has(key)));
          if (queries.length) {
            const inventory = await interactiveElements(currentPage);
            const semanticMatches = inventory.filter((entry) => queries.some(({ role, options }) => {
              if (entry.role !== role) return false;
              if (options.disabled !== undefined && entry.disabled !== options.disabled) return false;
              if (options.checked !== undefined && entry.checked !== options.checked) return false;
              if (options.selected !== undefined && entry.selected !== options.selected) return false;
              if (options.name === undefined) return true;
              if (options.name instanceof RegExp) {
                options.name.lastIndex = 0;
                return options.name.test(entry.name || "");
              }
              const expected = String(options.name);
              return options.exact ? entry.name === expected : (entry.name || "").toLocaleLowerCase().includes(expected.toLocaleLowerCase());
            }));
            if (semanticMatches.length === 1) {
              const frame = await resolveEntryFrame(currentPage, semanticMatches[0]);
              return Object.freeze({ frame, locator: semanticMatches[0].locator, semanticFallback: true });
            }
            if (semanticMatches.length > 1) throw new Error(`Target is ambiguous across ${semanticMatches.length} normalized semantic matches`);
          }
        }
        await sleep(100);
      } while (Date.now() < deadline);
      throw new Error(`Visible target did not appear in any frame within ${Math.max(0, Number(timeout) || 0)}ms. Frames: ${currentPage.frames().map((frame) => frame.url()).join(", ")}`);
    };
    const INTERACTIVE_ROLES = new Set([
      "button", "link", "checkbox", "radio", "switch", "textbox", "searchbox",
      "combobox", "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio",
      "tab", "treeitem", "slider", "spinbutton", "scrollbar",
    ]);
    // The browser-computed accessibility snapshot (mode "ai") carries measured roles,
    // real accessible names, ARIA states, and stable per-frame refs (aria-ref=eN in the
    // main frame, aria-ref=f<frameSeq>eN elsewhere). Refs resolve into live locators that
    // jump to the right realm, including frames that attach after the snapshot. Plain
    // landmarks and containers only stay in the inventory when the browser also reports
    // a pointer cursor for them, so structurally-role'd native controls stay actionable.
    const parseAriaSnapshotYaml = (yaml) => {
      const nodes = [];
      const stack = [];
      const unquote = (value) => {
        if (!value.startsWith('"') || !value.endsWith('"')) return value;
        let out = "";
        for (let i = 1; i < value.length - 1; i++) {
          const char = value[i];
          if (char !== "\\") { out += char; continue; }
          const next = value[++i];
          if (next === "\\" || next === '"') out += next;
          else if (next === "b") out += "\b";
          else if (next === "f") out += "\f";
          else if (next === "n") out += "\n";
          else if (next === "r") out += "\r";
          else if (next === "t") out += "\t";
          else if (next === "x") out += String.fromCharCode(parseInt(value.slice(i + 1, i + 3), 16)), i += 2;
          else throw new TypeError("Unexpected escape in aria snapshot value: \\" + next);
        }
        return out;
      };
      for (const rawLine of yaml.split(/\r?\n/)) {
        const trimmed = rawLine.trim();
        if (!trimmed || !trimmed.startsWith("- ")) continue;
        const depth = (rawLine.length - rawLine.trimStart().length) / 2;
        const body = trimmed.slice(2);
        if (body.startsWith("/") || body.startsWith("text:")) {
          const parent = stack[stack.length - 1];
          if (!parent) continue;
          const separator = body.indexOf(":");
          if (separator > 0) {
            const kind = body.slice(0, separator);
            const value = unquote(body.slice(separator + 1).trim());
            if (kind === "/url") parent.url = value;
            else if (kind === "/placeholder") parent.placeholder = value;
            else parent.text = (parent.text ? parent.text + " " : "") + value;
          }
          continue;
        }
        while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
        const keyMatch = body.match(/(\S+)(?:\s+("(?:[^"\\]|\\.)*"))?((?:\s+\[[^\]]*\])*)(?::([\s\S]*))?$/);
        if (!keyMatch) throw new TypeError("Unrecognized aria snapshot line: " + rawLine);
        const node = { depth, role: keyMatch[1], name: keyMatch[2] ? JSON.parse(keyMatch[2]) : "" };
        const attrs = keyMatch[3] || "";
        for (const attr of attrs.matchAll(/\[([\w-]+)(?:=([^\]]*))?\]/g)) {
          const name = attr[1];
          const value = attr[2];
          if (name === "ref") node.ref = value;
          else if (value === undefined) node[name] = true;
          else if (name === "level") node.level = Number(value);
          else if (value === "mixed") node[name] = "mixed";
          else if (value === "true") node[name] = true;
          else if (value === "false") node[name] = false;
          else node[name] = value;
        }
        if (keyMatch[4] !== undefined) node.text = unquote(keyMatch[4].trim());
        stack.push(node);
        nodes.push(node);
      }
      return nodes;
    };
    const interactiveElements = async (currentPage, { limit = Infinity } = {}) => {
      const state = requirePage(currentPage);
      const readinessDelay = state.inventoryReadyAt - Date.now();
      if (readinessDelay > 0) await sleep(readinessDelay);
      const yaml = await currentPage.ariaSnapshot({ mode: "ai" }).catch(() => "");
      const parsedNodes = [];
      try { parsedNodes.push(...parseAriaSnapshotYaml(yaml)); } catch { /* an unparseable snapshot degrades to an empty inventory */ }
      const entries = [];
      let index = 0;
      const bound = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity;
      for (const parsed of parsedNodes) {
        if (!INTERACTIVE_ROLES.has(parsed.role) && parsed.cursor !== "pointer") continue;
        if (index >= bound) break;
        let locator;
        if (parsed.ref) locator = currentPage.locator("aria-ref=" + parsed.ref);
        else if (parsed.name) {
          const options = { name: parsed.name, exact: true };
          if (parsed.checked !== undefined) options.checked = parsed.checked;
          if (parsed.selected !== undefined) options.selected = parsed.selected;
          if (parsed.disabled !== undefined) options.disabled = parsed.disabled;
          locator = currentPage.getByRole(parsed.role, options).first();
        }
        if (!locator) continue;
        entries.push(Object.freeze({
          index: index++,
          role: parsed.role,
          name: parsed.name || parsed.text || parsed.placeholder || "",
          disabled: parsed.disabled,
          checked: parsed.checked,
          selected: parsed.selected,
          expanded: parsed.expanded,
          pressed: parsed.pressed,
          invalid: parsed.invalid,
          level: parsed.level,
          url: parsed.url || "",
          placeholder: parsed.placeholder || "",
          locator,
        }));
      }
      return Object.freeze(entries);
    };
    const moveToTarget = async (currentPage, state, target) => { const box = await targetBox(currentPage, target, browserBinding); await moveToPoint(currentPage, state, pointFor(box, profile)); };
    // Momentum scrolling: one flick launches with an impulse that decays,
    // mirroring how wheel/trackpad events arrive in bursts under hardware
    // smoothing. Frame-dense early ticks, sparse settling ticks at the tail.
    const wheelSteps = async (currentPage, deltaX, deltaY) => {
      const magnitude = Math.max(Math.abs(deltaX), Math.abs(deltaY));
      if (!(magnitude > 0)) return;
      let remainingX = deltaX;
      let remainingY = deltaY;
      let impulse = clamp(magnitude * uniform(0.3, 0.5), 48, 360);
      const decay = uniform(0.6, 0.78);
      let steps = 0;
      while (Math.max(Math.abs(remainingX), Math.abs(remainingY)) > 0) {
        if (++steps > 120 || impulse < 1) {
          await currentPage.mouse.wheel(remainingX, remainingY);
          break;
        }
        const leftMagnitude = Math.max(Math.abs(remainingX), Math.abs(remainingY));
        const step = Math.min(impulse, leftMagnitude);
        const share = step / leftMagnitude;
        const stepX = remainingX * share;
        const stepY = remainingY * share;
        remainingX -= stepX;
        remainingY -= stepY;
        await currentPage.mouse.wheel(stepX, stepY);
        if (Math.max(Math.abs(remainingX), Math.abs(remainingY)) <= 0.5) break;
        impulse *= decay * uniform(0.85, 1.1);
        await sleep(impulse > 90 ? uniform(16, 42) : uniform(55, 110));
      }
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
      binding,
      dataDir: paths.root,
      pages: () => { requireOpenBrowser(); return persistentContext.pages().filter((currentPage) => { const state = stateByPage.get(currentPage); return state && !state.stopped; }); },
      newPage: async () => { requireOpenBrowser(); const currentPage = await persistentContext.newPage(); registerPage(currentPage); return currentPage; },
      pageState: (currentPage) => { const state = requirePage(currentPage); return Object.freeze({ registered: true, binding, pageId: state.pageId, busy: state.busy, action: state.action, stopped: state.stopped, lastDocumentStatus: state.lastDocumentStatus }); },
      managed: (currentPage) => { requirePage(currentPage); return true; },
      telemetry: () => Object.freeze({ ...telemetry }),
      capabilities: () => Object.freeze({ state: status, binding, profileKind, persistentIdentity: true, behaviorSchema: profile.schema, personaSchema: persona.schema, managedInput: true, ambientInput: false, automaticPagesAndPopups: true, frameLifecycle: true, crossFrameTargetResolution: true, semanticInteractiveInventory: true, postNavigationInventoryGraceMs: 1800, documentInitScript: false, dedicatedWorkers: "unmanaged", serviceWorkers: "unmanaged", mobile, touch: mobile, locale: persona.locale, timezoneId: persona.timezoneId, deviceScaleFactor: identity.deviceScaleFactor, userAgent: undefined, identity, sharedProfileRequiresSequentialModes: !dataDir, artifacts: Object.freeze({ bindings: false, cdp: false, runtimeCdpPatch: browserEngine === "camoufox" ? "none — Camoufox Juggler protocol sandboxing" : "standard Chromium CDP (no driver patch)", automationControlledFlag: false, standardPlaywrightProtocol: true, privatePlaywrightApis: false, tracing: false, har: false, video: false }) }),
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
          : queueAction(currentPage, "scroll", async (state) => { if (!targetOrDelta || typeof targetOrDelta.scrollIntoViewIfNeeded !== "function") throw new TypeError("Stealth scroll requires a Locator or numeric delta"); browserBinding.assertLocator(currentPage, targetOrDelta); await targetOrDelta.scrollIntoViewIfNeeded(); await moveToTarget(currentPage, state, targetOrDelta); }),
      dragTo: (currentPage, source, target) => queueAction(currentPage, "dragTo", async (state) => { browserBinding.assertLocator(currentPage, target); await moveToTarget(currentPage, state, source); if (typeof source.dragTo !== "function") throw new TypeError("Stealth dragTo requires Locator targets"); await source.dragTo(target); }),
      type: (currentPage, target, text) => queueAction(currentPage, "type", async (state) => { await moveToTarget(currentPage, state, target); await target.focus(); await typeText(currentPage, text); }),
      fill: (currentPage, target, text) => queueAction(currentPage, "fill", async (state) => { if (typeof target.focus !== "function") throw new TypeError("Stealth fill requires a Locator target"); browserBinding.assertLocator(currentPage, target); if (typeof target.isEditable === "function" && !(await target.isEditable())) throw new Error("Stealth fill target is not editable"); await moveToTarget(currentPage, state, target); await target.focus(); await currentPage.keyboard.press("Control+A"); await currentPage.keyboard.press("Backspace"); await typeText(currentPage, text); }),
      pressText: (currentPage, text) => queueAction(currentPage, "pressText", () => typeText(currentPage, text)),
      press: (currentPage, key) => queueAction(currentPage, "press", async () => currentPage.keyboard.press(key, { delay: uniform(profile.keyHoldMin, profile.keyHoldMax) })),
      focus: (currentPage, target) => queueAction(currentPage, "focus", async (state) => { await moveToTarget(currentPage, state, target); await target.focus(); }),
      check: (currentPage, target) => queueAction(currentPage, "check", async (state) => { browserBinding.assertLocator(currentPage, target); if (!(await target.isChecked())) await performClick(currentPage, state, target); }),
      uncheck: (currentPage, target) => queueAction(currentPage, "uncheck", async (state) => { browserBinding.assertLocator(currentPage, target); if (await target.isChecked()) await performClick(currentPage, state, target); }),
      selectOption: (currentPage, target, values) => queueAction(currentPage, "selectOption", async (state) => { await moveToTarget(currentPage, state, target); await target.focus(); await sleep(uniform(80, 180)); await target.selectOption(values); }),
      tap: (currentPage, target) => { if (!mobile) throw new Error("Stealth tap requires an active mobile/touch session"); return queueAction(currentPage, "tap", async (state) => { const box = await targetBox(currentPage, target, browserBinding); const point = pointFor(box, profile); await sleep(uniform(120, 300)); await moveToPoint(currentPage, state, point); await currentPage.touchscreen.tap(point.x, point.y); }); },
      think: (currentPage, milliseconds) => queueAction(currentPage, "think", () => sleep(clamp(Number(milliseconds) || 0, 0, 300000))),
      screenshot: (currentPage, options) => queueAction(currentPage, "screenshot", () => currentPage.screenshot(options)),
      stop: (currentPage) => stopPage(requirePage(currentPage), { unregister: true }),
      state: () => status,
      close: async () => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          status = "closing";
          for (const remove of removers.splice(0)) remove();
          for (const currentPage of livePages) stopPage(stateByPage.get(currentPage));
          livePages.clear();
          let closeError;
          if (!contextClosed) {
            try {
              await persistentContext.close();
            } catch (error) {
              closeError = error;
            }
          }
          status = "closed";
          if (controllerRegistry.get(paths.root) === session) controllerRegistry.delete(paths.root);
          // Surface shutdown failures instead of reporting a clean close while
          // Chromium lingers; resetProfile must never delete an in-use profile.
          if (closeError) {
            throw new Error(`Could not close the managed ${profileKind} browser cleanly: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
          }
        })();
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
    if (current && current.state() === "externally-closed") throw new Error(`The ${kind} browser bound to OpenCode session ${runtimeSessionId} was closed outside the controller. Refusing to relaunch or adopt another browser.`);
    const root = path.resolve(options.dataDir || path.join(baseDir, "stealth"));
    // Serialize launches per profile root, not per mode: desktop and mobile
    // share the same user-data directory and must never launch it at once.
    if (!controllerLaunches.has(root)) controllerLaunches.set(root, createStealthController(options).finally(() => controllerLaunches.delete(root)));
    const session = await controllerLaunches.get(root);
    if (session.capabilities().profileKind !== options.profileKind) {
      throw new Error(`The shared stealth profile is open in ${session.capabilities().profileKind} mode. Close it before switching to ${options.profileKind} mode.`);
    }
    if (kind === "mobile") mobileSession = session;
    else webSession = session;
    return session;
  };

  return {
    ensureWebBrowser: () => ensureController("desktop", { dataDir: webProfileDir, profileKind: "desktop" }),
    ensureMobileBrowser: () => ensureController("mobile", { dataDir: mobileProfileDir || webProfileDir, profileKind: "mobile" }),
    createStealthController,
    resetStealthProfile,
  };
}
