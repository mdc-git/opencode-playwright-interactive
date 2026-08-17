import path from 'node:path'
import {
  IDENTITY_ARGUMENTS,
  IDENTITY_CONTEXT_OPTIONS,
  IDENTITY_HEADERS,
  MOBILE_VIEWPORT,
  STEALTH_ARGUMENTS,
  clamp,
  pointFor,
  settleWithin,
  sleep,
  uniform
} from './stealth-utils.mjs'
import {
  buildInteractiveEntry,
  matchSemanticQuery,
  parseAriaSnapshotYaml
} from './stealth-aria.mjs'
import {
  createInputHelpers,
  createMoveHelpers,
  createPageState,
  pageViewport,
  targetBox
} from './stealth-input.mjs'
import {
  createPersona,
  createProfileStore,
  normalizeMetadata,
  normalizePersona
} from './stealth-profile-store.mjs'

let installedRuntime

function assertCoherentLaunchOptions(launchOptions, contextOptions) {
  const suppliedOptions = [launchOptions, contextOptions]
  const conflictingOptions = IDENTITY_CONTEXT_OPTIONS.filter((key) =>
    suppliedOptions.some((options) => Object.hasOwn(options, key))
  )
  if (conflictingOptions.length > 0) {
    throw new Error(
      `Identity-critical launch and context options are managed by the runtime: ${conflictingOptions.join(', ')}`
    )
  }

  const conflictingArguments = (launchOptions.args || []).filter((argument) =>
    IDENTITY_ARGUMENTS.some((prefix) => argument === prefix || argument.startsWith(`${prefix}=`))
  )
  if (conflictingArguments.length > 0) {
    throw new Error(
      `Identity-critical browser arguments are managed by the runtime: ${conflictingArguments.join(', ')}`
    )
  }

  const conflictingHeaders = suppliedOptions
    .flatMap((options) => Object.keys(options.extraHTTPHeaders || {}))
    .filter((header) => IDENTITY_HEADERS.includes(header.toLowerCase()))
  if (conflictingHeaders.length > 0) {
    throw new Error(
      `Identity-critical HTTP headers are managed by the browser: ${[...new Set(conflictingHeaders)].join(', ')}`
    )
  }
}

function validateOpencode(opencode) {
  if ((!opencode?.homeDir && !opencode?.tmpDir) || !opencode?.sessionId) {
    return false
  }

  return typeof opencode.bindBrowser === 'function'
}

function validateInstallOptions({ chromium, browserEngine, opencode }) {
  if (!chromium?.launchPersistentContext) {
    throw new TypeError(
      'The shared Playwright launcher (chromium or a camoufox firefox shim) is required'
    )
  }

  if (browserEngine !== 'chromium' && browserEngine !== 'camoufox') {
    throw new TypeError('browserEngine must be "chromium" or "camoufox"')
  }

  if (!validateOpencode(opencode)) {
    throw new TypeError('The session-aware js_repl opencode runtime object is required')
  }
}

export async function installStealthRuntime({
  chromium,
  browserEngine = 'chromium',
  opencode,
  headless = false,
  webProfileDir,
  mobileProfileDir
} = {}) {
  if (installedRuntime) {
    return installedRuntime
  }

  validateInstallOptions({ chromium, browserEngine, opencode })
  installedRuntime = Object.freeze(
    createRuntime({ chromium, browserEngine, opencode, headless, webProfileDir, mobileProfileDir })
  )
  return installedRuntime
}

async function matchFrameLocators(currentPage, locatorForFrame, semanticQueries, deadline) {
  const frameMatches = await Promise.all(
    currentPage.frames().map(async (frame) => {
      let locator
      try {
        const queryFrame = new Proxy(frame, {
          get(targetElement, property) {
            if (property === 'getByRole') {
              return (role, options = {}) => {
                semanticQueries.push({ frame, role, options })
                return targetElement.getByRole(role, options)
              }
            }

            const value = Reflect.get(targetElement, property, targetElement)
            return typeof value === 'function' ? value.bind(targetElement) : value
          }
        })
        locator = locatorForFrame(queryFrame)
      } catch {
        return []
      }

      const probeTimeout = Math.min(1000, Math.max(1, deadline - Date.now()))
      const count = (await settleWithin(locator?.count?.(), probeTimeout, 0)) || 0
      const visibility = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          settleWithin(locator.nth(index).isVisible(), probeTimeout, false)
        )
      )
      return visibility.flatMap((visible, index) =>
        visible ? [{ frame, locator: locator.nth(index) }] : []
      )
    })
  )
  return frameMatches.flat()
}

function createSemanticResolution(interactiveElements) {
  const resolveEntryFrame = async (currentPage, entry) => {
    try {
      const handle = await entry.locator.elementHandle({ timeout: 0 })
      if (handle) {
        const frame = handle.ownerFrame()
        if (frame) {
          return frame
        }
      }
    } catch {
      /*
      Fall through to the main frame as a best-effort attribution
      */
    }

    return currentPage.mainFrame()
  }

  const findSemanticMatch = async (currentPage, semanticQueries, nextSemanticProbeAt) => {
    if (semanticQueries.length === 0 || Date.now() < nextSemanticProbeAt) {
      return null
    }

    const supportedOptions = new Set(['name', 'exact', 'disabled', 'checked', 'selected'])
    const queries = semanticQueries.filter(({ options }) =>
      Object.keys(options).every((key) => supportedOptions.has(key))
    )
    if (queries.length === 0) {
      return null
    }

    const inventory = await interactiveElements(currentPage)
    const matches = inventory.filter((entry) =>
      queries.some(({ role, options }) => matchSemanticQuery(entry, role, options))
    )
    if (matches.length === 1) {
      const frame = await resolveEntryFrame(currentPage, matches[0])
      return Object.freeze({ frame, locator: matches[0].locator, semanticFallback: true })
    }

    if (matches.length > 1) {
      throw new Error(`Target is ambiguous across ${matches.length} normalized semantic matches`)
    }

    return null
  }

  return { resolveEntryFrame, findSemanticMatch }
}

async function iterateVisibleResolution(currentPage, locatorForFrame, semanticState, semantic) {
  const { findSemanticMatch } = semantic
  const semanticQueries = []
  const matches = await matchFrameLocators(
    currentPage,
    locatorForFrame,
    semanticQueries,
    semanticState.deadline
  )
  if (matches.length === 1) {
    return Object.freeze(matches[0])
  }

  if (matches.length > 1) {
    throw new Error(`Target is ambiguous across ${matches.length} visible frame matches`)
  }

  const semanticMatch = await findSemanticMatch(
    currentPage,
    semanticQueries,
    semanticState.nextProbeAt
  )
  if (semanticMatch) {
    return semanticMatch
  }

  if (semanticQueries.length > 0) {
    semanticState.nextProbeAt = Date.now() + 500
  }

  await sleep(100)
  return null
}

function createVisibleResolution(requirePage, semantic) {
  const { resolveEntryFrame } = semantic
  const attemptProbe = async (currentPage, locatorForFrame, semanticState) => {
    const result = await iterateVisibleResolution(
      currentPage,
      locatorForFrame,
      semanticState,
      semantic
    )
    if (result || Date.now() >= semanticState.deadline) {
      return result
    }

    const next = await attemptProbe(currentPage, locatorForFrame, semanticState)
    return next
  }

  const resolveVisible = async (currentPage, locatorForFrame, { timeout = 5000 } = {}) => {
    requirePage(currentPage)
    if (typeof locatorForFrame !== 'function') {
      throw new TypeError('resolveVisible requires a locator factory')
    }

    const deadline = Date.now() + clamp(Number(timeout) || 0, 0, 30_000)
    const result = await attemptProbe(
      currentPage,
      locatorForFrame,
      Object.freeze({
        deadline,
        nextProbeAt: 0
      })
    )
    if (result) {
      return result
    }

    throw new Error(
      `Visible target did not appear in any frame within ${Math.max(0, Number(timeout) || 0)}ms. Frames: ${currentPage
        .frames()
        .map((frame) => frame.url())
        .join(', ')}`
    )
  }

  return { resolveVisible, resolveEntryFrame }
}

function createResolutionHelpers(requirePage, interactiveElements) {
  return createVisibleResolution(requirePage, createSemanticResolution(interactiveElements))
}

function createInteractiveElements(requirePage) {
  return async (currentPage, { limit = Infinity } = {}) => {
    const state = requirePage(currentPage)
    const readinessDelay = state.inventoryReadyAt - Date.now()
    if (readinessDelay > 0) {
      await sleep(readinessDelay)
    }

    const yaml = await currentPage.ariaSnapshot({ mode: 'ai' }).catch(() => '')
    let parsedNodes = []
    try {
      parsedNodes = parseAriaSnapshotYaml(yaml)
    } catch {
      /*
      An unparseable snapshot degrades to an empty inventory
      */
    }

    const entries = []
    let index = 0
    const bound = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Infinity
    for (const parsed of parsedNodes) {
      if (index >= bound) {
        break
      }

      const entry = buildInteractiveEntry(parsed, currentPage, index)
      if (entry) {
        entries.push(entry)
        index += 1
      }
    }

    return Object.freeze(entries)
  }
}

function resolveExistingController(controllerRegistry, runtimeSessionId, paths, profileKind) {
  const existing = controllerRegistry.get(paths.root)
  if (existing?.state() === 'externally-closed') {
    throw new Error(
      `The browser bound to OpenCode session ${runtimeSessionId} was closed outside the controller. This controller cannot relaunch or adopt another session's browser.`
    )
  }

  if (existing && existing.state() === 'closing') {
    return { existing, wait: true }
  }

  if (existing && existing.state() === 'open') {
    if (existing.capabilities().profileKind !== profileKind) {
      throw new Error(
        `The shared stealth profile is already open in ${existing.capabilities().profileKind} mode. Close it before switching to ${profileKind} mode.`
      )
    }

    return { existing }
  }

  return {}
}

async function settleController(resolveController, paths, profileKind) {
  const resolved = resolveController(paths, profileKind)
  if (resolved.existing && !resolved.wait) {
    return resolved.existing
  }

  if (!resolved.wait) {
    return undefined
  }

  await resolved.existing.close().catch(() => {})
  const recheck = resolveController(paths, profileKind)
  if (recheck.existing && !recheck.wait) {
    return recheck.existing
  }

  return undefined
}

async function readRecordForLaunch({
  paths,
  runtimeSessionId,
  profile,
  persona,
  readRecord,
  writeRecord
}) {
  const metadata = await readRecord(paths.identityMetadata, normalizeMetadata, () => ({
    schema: 2,
    profileId: profile.profileId,
    personaId: persona.personaId,
    sessionId: runtimeSessionId,
    behaviorSchema: profile.schema,
    personaSchema: persona.schema,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    resetGeneration: 0
  }))
  if (metadata.sessionId && metadata.sessionId !== runtimeSessionId) {
    throw new Error(
      `Stealth profile ${paths.root} is bound to a different OpenCode session and cannot be adopted`
    )
  }

  metadata.profileId = profile.profileId
  metadata.personaId = persona.personaId
  metadata.sessionId = runtimeSessionId
  await writeRecord(paths.identityMetadata, metadata)
  return metadata
}

function mergeLaunchOptions(launchOptions, contextOptions, { persona, isMobile, args, headless }) {
  return {
    ...launchOptions,
    ...contextOptions,
    headless: launchOptions.headless ?? headless,
    args,
    locale: persona.locale,
    timezoneId: persona.timezoneId,
    viewport: isMobile ? { ...MOBILE_VIEWPORT } : null,
    ...(isMobile && { screen: { ...MOBILE_VIEWPORT } }),
    isMobile,
    hasTouch: isMobile,
    ...(isMobile && { deviceScaleFactor: persona.mobileDeviceScaleFactor })
  }
}

function buildLaunchedIdentity({ persistentContext, persona, browserEngine, options, isMobile }) {
  return Object.freeze({
    browserEngine,
    browserVersion: persistentContext.browser()?.version?.() || 'unknown',
    browserIdentity: 'native',
    userAgentOverride: false,
    automationControlledOverride: true,
    locale: persona.locale,
    timezoneId: persona.timezoneId,
    emulation: isMobile ? 'responsive-touch' : 'desktop',
    viewport: options.viewport ? Object.freeze({ ...options.viewport }) : null,
    screen: options.screen ? Object.freeze({ ...options.screen }) : null,
    deviceScaleFactor: isMobile ? persona.mobileDeviceScaleFactor : null
  })
}

async function prepareAndLaunch(deps, launch) {
  const { paths, profileKind, launchChromium, launchHeadless, launchOptions, contextOptions } =
    launch
  const profile = await deps.loadBehavior({ dataDir: paths.root })
  const persona = await deps.readRecord(paths.persona, normalizePersona, createPersona)
  const metadata = await readRecordForLaunch({
    paths,
    runtimeSessionId: deps.runtimeSessionId,
    profile,
    persona,
    readRecord: deps.readRecord,
    writeRecord: deps.writeRecord
  })
  const isMobile = profileKind === 'mobile'
  const suppliedArgs = launchOptions.args || []
  const args =
    deps.browserEngine === 'camoufox' ? [...suppliedArgs] : [...STEALTH_ARGUMENTS, ...suppliedArgs]
  const options = mergeLaunchOptions(launchOptions, contextOptions, {
    persona,
    isMobile,
    args,
    headless: launchHeadless
  })
  let persistentContext
  try {
    persistentContext = await launchChromium.launchPersistentContext(paths.userData, options)
  } catch (error) {
    throw new Error(
      `Could not open the persistent stealth profile at ${paths.userData}. Close any other session using it before retrying. ${error}`,
      { cause: error }
    )
  }

  const browserBinding = deps.opencode.bindBrowser({
    browser: persistentContext.browser(),
    context: persistentContext,
    browserId: profile.profileId,
    profileKind
  })
  const identity = buildLaunchedIdentity({
    persistentContext,
    persona,
    browserEngine: deps.browserEngine,
    options,
    isMobile
  })
  return {
    profile,
    persona,
    metadata,
    persistentContext,
    browserBinding,
    identity,
    binding: browserBinding.binding,
    mobile: isMobile
  }
}

async function createControllerImpl(
  deps,
  {
    chromium: suppliedChromium,
    headless: suppliedHeadless,
    dataDir,
    launchOptions = {},
    contextOptions = {},
    profileKind = 'desktop'
  } = {}
) {
  const launchChromium = suppliedChromium || deps.chromium
  if (!launchChromium?.launchPersistentContext) {
    throw new TypeError(
      'createStealthController requires a Playwright-compatible launcher (chromium or camoufox firefox shim)'
    )
  }

  const launchHeadless = suppliedHeadless ?? deps.headless
  assertCoherentLaunchOptions(launchOptions, contextOptions)
  const paths = deps.paths({ dataDir })
  const existing = await settleController(deps.resolveExistingController, paths, profileKind)
  if (existing) {
    return existing
  }

  const ctx = await prepareAndLaunch(deps, {
    paths,
    profileKind,
    launchChromium,
    launchHeadless,
    launchOptions,
    contextOptions
  })
  const session = buildStealthSession({
    paths,
    profileKind,
    controllerRegistry: deps.controllerRegistry,
    resetStealthProfile: deps.resetStealthProfile,
    ...ctx
  })
  deps.controllerRegistry.set(paths.root, session)
  ctx.metadata.lastUsedAt = new Date().toISOString()
  await deps.writeRecord(paths.identityMetadata, ctx.metadata)
  return session
}

function createLaunchDeps({
  chromium,
  headless,
  browserEngine,
  opencode,
  controllerRegistry,
  runtimeSessionId,
  store
}) {
  return Object.freeze({
    chromium,
    headless,
    browserEngine,
    opencode,
    runtimeSessionId,
    controllerRegistry,
    resolveExistingController: (paths, profileKind) =>
      resolveExistingController(controllerRegistry, runtimeSessionId, paths, profileKind),
    paths: store.paths,
    writeRecord: store.writeRecord,
    readRecord: store.readRecord,
    loadBehavior: store.loadBehavior,
    resetStealthProfile: store.resetStealthProfile
  })
}

function createStopPage({ stateByPage, livePages }) {
  return (state, { unregister = false } = {}) => {
    if (!state || state.stopped) {
      return
    }

    state.stopped = true
    for (const remove of state.removers) {
      remove()
    }

    state.removers.length = 0
    if (unregister && state.page) {
      livePages.delete(state.page)
      stateByPage.delete(state.page)
    }
  }
}

function createQueueAction({ requirePage, telemetry }) {
  return (currentPage, name, action) => {
    const state = requirePage(currentPage)
    const run = async () => {
      requirePage(currentPage)
      telemetry.managedActions += 1
      state.busy = true
      state.action = name
      try {
        return await action(state)
      } catch (error) {
        telemetry.failedActions += 1
        throw error
      } finally {
        state.busy = false
        state.action = undefined
      }
    }

    const result = state.queue.catch(() => {}).then(run)
    state.queue = result.catch(() => {})
    return result
  }
}

function createSessionGuards({ box, binding, profileKind, browserBinding, stateByPage }) {
  const closedBrowserError = () =>
    new Error(
      `Managed ${profileKind} browser ${binding.browserId} bound to OpenCode session ${binding.sessionId} is closed. This controller cannot relaunch or adopt another session's browser. Stop interacting and report that this session's browser was closed.`
    )
  const requireOpenBrowser = () => {
    if (box.status !== 'open' || box.isContextClosed) {
      throw closedBrowserError()
    }
  }

  const requirePage = (currentPage) => {
    requireOpenBrowser()
    browserBinding.assertPage(currentPage)
    const state = stateByPage.get(currentPage)
    if (!state || state.stopped || currentPage.isClosed()) {
      throw new Error(
        'The target Page is closed or is not managed by this stealth session. Select a current managed page or create one with stealth.newPage().'
      )
    }

    return state
  }

  return { requireOpenBrowser, requirePage }
}

function pageEventHandlers({ currentPage, state, livePages, telemetry, stopPage, registerPopup }) {
  const onClose = () => {
    livePages.delete(currentPage)
    stopPage(state)
  }

  const onPopup = (popup) => {
    telemetry.popups += 1
    registerPopup(popup)
  }

  const onFrameNavigated = (frame) => {
    if (frame !== currentPage.mainFrame()) {
      return
    }

    telemetry.mainFrameNavigations += 1
    state.inventoryReadyAt = Date.now() + 1800
  }

  const onResponse = (response) => {
    try {
      if (
        response.request().resourceType() === 'document' &&
        response.frame() === currentPage.mainFrame()
      ) {
        const documentStatus = response.status()
        state.lastDocumentStatus = documentStatus
        telemetry.lastDocumentStatus = documentStatus
      }
    } catch {}
  }

  return { onClose, onPopup, onFrameNavigated, onResponse }
}

function createPageRegistrar({
  persistentContext,
  profile,
  stateByPage,
  livePages,
  telemetry,
  box,
  stopPage
}) {
  const pageSequence = 0
  const registerPage = (currentPage) => {
    if (
      !currentPage ||
      box.status !== 'open' ||
      currentPage.isClosed() ||
      stateByPage.has(currentPage)
    ) {
      return
    }

    if (currentPage.context() !== persistentContext) {
      throw new Error('Cannot register a Page from another BrowserContext')
    }

    const state = createPageState(profile, pageSequence)
    state.page = currentPage
    stateByPage.set(currentPage, state)
    livePages.add(currentPage)
    const handlers = pageEventHandlers({
      currentPage,
      state,
      livePages,
      telemetry,
      stopPage,
      registerPopup: registerPage
    })
    currentPage.on('close', handlers.onClose)
    currentPage.on('popup', handlers.onPopup)
    currentPage.on('framenavigated', handlers.onFrameNavigated)
    currentPage.on('response', handlers.onResponse)
    state.removers.push(
      () => currentPage.off('close', handlers.onClose),
      () => currentPage.off('popup', handlers.onPopup),
      () => currentPage.off('framenavigated', handlers.onFrameNavigated),
      () => currentPage.off('response', handlers.onResponse)
    )
  }

  return registerPage
}

async function performWheelSteps(currentPage, deltaX, deltaY) {
  const magnitude = Math.max(Math.abs(deltaX), Math.abs(deltaY))
  if (!(magnitude > 0)) {
    return
  }

  const decay = uniform(0.6, 0.78)
  async function stepWheel({ remainingX, remainingY, impulse, steps }) {
    if (Math.max(Math.abs(remainingX), Math.abs(remainingY)) <= 0.5) {
      return
    }

    if (steps >= 120 || impulse < 1) {
      await currentPage.mouse.wheel(remainingX, remainingY)
      return
    }

    const leftMagnitude = Math.max(Math.abs(remainingX), Math.abs(remainingY))
    const step = Math.min(impulse, leftMagnitude)
    const share = step / leftMagnitude
    const stepX = remainingX * share
    const stepY = remainingY * share
    const restX = remainingX - stepX
    const restY = remainingY - stepY
    await currentPage.mouse.wheel(stepX, stepY)
    if (Math.max(Math.abs(restX), Math.abs(restY)) <= 0.5) {
      return
    }

    const nextImpulse = impulse * decay * uniform(0.85, 1.1)
    await sleep(nextImpulse > 90 ? uniform(16, 42) : uniform(55, 110))
    await stepWheel({
      remainingX: restX,
      remainingY: restY,
      impulse: nextImpulse,
      steps: steps + 1
    })
  }

  await stepWheel({
    remainingX: deltaX,
    remainingY: deltaY,
    impulse: clamp(magnitude * uniform(0.3, 0.5), 48, 360),
    steps: 0
  })
}

function createSessionActions({ queueAction, performClick, browserBinding, moveToTarget }) {
  const clickAction = (currentPage, target, options = {}, count = 1) =>
    queueAction(currentPage, count === 2 ? 'doubleClick' : 'click', (state) =>
      performClick(currentPage, state, target, { browserBinding, ...options, count })
    )
  const wheel = (currentPage, deltaX, deltaY, target) =>
    queueAction(currentPage, 'wheel', async (state) => {
      if (target !== undefined) {
        await moveToTarget(currentPage, state, target, browserBinding)
      }

      await performWheelSteps(currentPage, deltaX, deltaY)
    })
  return { clickAction, wheel }
}

function createSessionCloser({
  box,
  removers,
  livePages,
  stateByPage,
  stopPage,
  persistentContext,
  controllerRegistry,
  paths,
  profileKind,
  sessionRef
}) {
  return async () => {
    if (box.closePromise) {
      return box.closePromise
    }

    box.closePromise = (async () => {
      box.status = 'closing'
      for (const remove of removers) {
        remove()
      }

      removers.length = 0
      for (const currentPage of livePages) {
        stopPage(stateByPage.get(currentPage))
      }

      livePages.clear()
      let closeError
      if (!box.isContextClosed) {
        try {
          await persistentContext.close()
        } catch (error) {
          closeError = error
        }
      }

      box.status = 'closed'
      if (controllerRegistry.get(paths.root) === sessionRef()) {
        controllerRegistry.delete(paths.root)
      }

      if (closeError) {
        throw new Error(
          `Could not close the managed ${profileKind} browser cleanly: ${closeError instanceof Error ? closeError.message : String(closeError)}`
        )
      }
    })()
    return box.closePromise
  }
}

function buildCapabilities({
  state,
  binding,
  profileKind,
  profile,
  persona,
  mobile,
  browserEngine,
  dataDir,
  identity
}) {
  return Object.freeze({
    state,
    binding,
    profileKind,
    persistentIdentity: true,
    behaviorSchema: profile.schema,
    personaSchema: persona.schema,
    managedInput: true,
    ambientInput: false,
    automaticPagesAndPopups: true,
    frameLifecycle: true,
    crossFrameTargetResolution: true,
    semanticInteractiveInventory: true,
    postNavigationInventoryGraceMs: 1800,
    documentInitScript: false,
    dedicatedWorkers: 'unmanaged',
    serviceWorkers: 'unmanaged',
    mobile,
    touch: mobile,
    locale: persona.locale,
    timezoneId: persona.timezoneId,
    deviceScaleFactor: identity.deviceScaleFactor,
    userAgent: undefined,
    identity,
    sharedProfileRequiresSequentialModes: !dataDir,
    artifacts: Object.freeze({
      bindings: false,
      cdp: false,
      runtimeCdpPatch:
        browserEngine === 'camoufox'
          ? 'none — Camoufox Juggler protocol sandboxing'
          : 'standard Chromium CDP (no driver patch)',
      automationControlledFlag: false,
      standardPlaywrightProtocol: true,
      privatePlaywrightApis: false,
      tracing: false,
      har: false,
      video: false
    })
  })
}

function buildPageState(state, binding) {
  return Object.freeze({
    registered: true,
    binding,
    pageId: state.pageId,
    busy: state.busy,
    action: state.action,
    stopped: state.stopped,
    lastDocumentStatus: state.lastDocumentStatus
  })
}

function isLivePage(currentPage, stateByPage) {
  const state = stateByPage.get(currentPage)
  return Boolean(state && !state.stopped)
}

function createSessionCore(deps) {
  const d = deps
  return {
    get context() {
      d.requireOpenBrowser()
      return d.persistentContext
    },
    profile: Object.freeze({ ...d.profile }),
    persona: Object.freeze({ ...d.persona }),
    identity: d.identity,
    binding: d.binding,
    dataDir: d.paths.root,
    pages() {
      d.requireOpenBrowser()
      return d.persistentContext
        .pages()
        .filter((currentPage) => isLivePage(currentPage, d.stateByPage))
    },
    async newPage() {
      d.requireOpenBrowser()
      const currentPage = await d.persistentContext.newPage()
      d.registerPage(currentPage)
      return currentPage
    },
    pageState(currentPage) {
      return buildPageState(d.requirePage(currentPage), d.binding)
    },
    managed(currentPage) {
      d.requirePage(currentPage)
      return true
    },
    telemetry: () => Object.freeze({ ...d.telemetry }),
    capabilities: () =>
      buildCapabilities({
        state: d.box.status,
        binding: d.binding,
        profileKind: d.profileKind,
        profile: d.profile,
        persona: d.persona,
        mobile: d.mobile,
        browserEngine: d.browserEngine,
        dataDir: d.dataDir,
        identity: d.identity
      }),
    resolveVisible: d.resolveVisible,
    interactiveElements: d.interactiveElements,
    stop: (currentPage) => d.stopPage(d.requirePage(currentPage), { unregister: true }),
    state: () => d.box.status
  }
}

const createTapVerb =
  ({ queueAction, browserBinding, moveToPoint, mobile, profile }) =>
  (currentPage, target) => {
    if (!mobile) {
      throw new Error('Stealth tap requires an active mobile/touch session')
    }

    return queueAction(currentPage, 'tap', async (state) => {
      const tapBox = await targetBox(currentPage, target, browserBinding)
      const point = pointFor(tapBox, profile)
      await sleep(uniform(120, 300))
      await moveToPoint(currentPage, state, point)
      await currentPage.touchscreen.tap(point.x, point.y)
    })
  }

function createSessionPointerVerbs(deps) {
  const { queueAction, clickAction, wheel, browserBinding, moveToTarget } = deps
  return {
    moveTo: (currentPage, target) =>
      queueAction(currentPage, 'moveTo', (state) =>
        moveToTarget(currentPage, state, target, browserBinding)
      ),
    click: (currentPage, target, options) => clickAction(currentPage, target, options),
    doubleClick: (currentPage, target, options) => clickAction(currentPage, target, options, 2),
    hover: (currentPage, target) =>
      queueAction(currentPage, 'hover', (state) =>
        moveToTarget(currentPage, state, target, browserBinding)
      ),
    wheel,
    scroll(currentPage, targetOrDelta, deltaY) {
      if (typeof targetOrDelta === 'number') {
        return wheel(currentPage, 0, targetOrDelta)
      }

      if (Number.isFinite(deltaY)) {
        return wheel(currentPage, 0, deltaY, targetOrDelta)
      }

      return queueAction(currentPage, 'scroll', async (state) => {
        if (!targetOrDelta || typeof targetOrDelta.scrollIntoViewIfNeeded !== 'function') {
          throw new TypeError('Stealth scroll requires a Locator or numeric delta')
        }

        browserBinding.assertLocator(currentPage, targetOrDelta)
        await targetOrDelta.scrollIntoViewIfNeeded()
        await moveToTarget(currentPage, state, targetOrDelta, browserBinding)
      })
    },
    dragTo: (currentPage, source, target) =>
      queueAction(currentPage, 'dragTo', async (state) => {
        browserBinding.assertLocator(currentPage, target)
        await moveToTarget(currentPage, state, source, browserBinding)
        if (typeof source.dragTo !== 'function') {
          throw new TypeError('Stealth dragTo requires Locator targets')
        }

        await source.dragTo(target)
      }),
    tap: createTapVerb(deps),
    think: (currentPage, milliseconds) =>
      queueAction(currentPage, 'think', () => sleep(clamp(Number(milliseconds) || 0, 0, 300_000))),
    screenshot: (currentPage, options) =>
      queueAction(currentPage, 'screenshot', () => currentPage.screenshot(options))
  }
}

const createFillVerb =
  ({ queueAction, typeText, browserBinding, moveToTarget }) =>
  (currentPage, target, text) =>
    queueAction(currentPage, 'fill', async (state) => {
      if (typeof target.focus !== 'function') {
        throw new TypeError('Stealth fill requires a Locator target')
      }

      browserBinding.assertLocator(currentPage, target)
      if (typeof target.isEditable === 'function' && !(await target.isEditable())) {
        throw new Error('Stealth fill target is not editable')
      }

      await moveToTarget(currentPage, state, target, browserBinding)
      await target.focus()
      await currentPage.keyboard.press('Control+A')
      await currentPage.keyboard.press('Backspace')
      await typeText(currentPage, text)
    })

function createSessionKeyboardVerbs(deps) {
  const { queueAction, typeText, browserBinding, moveToTarget, performClick, profile } = deps
  const type = (currentPage, target, text) =>
    queueAction(currentPage, 'type', async (state) => {
      await moveToTarget(currentPage, state, target, browserBinding)
      await target.focus()
      await typeText(currentPage, text)
    })
  return {
    type,
    fill: createFillVerb(deps),
    pressText: (currentPage, text) =>
      queueAction(currentPage, 'pressText', () => typeText(currentPage, text)),
    press: (currentPage, key) =>
      queueAction(currentPage, 'press', async () =>
        currentPage.keyboard.press(key, { delay: uniform(profile.keyHoldMin, profile.keyHoldMax) })
      ),
    focus: (currentPage, target) =>
      queueAction(currentPage, 'focus', async (state) => {
        await moveToTarget(currentPage, state, target, browserBinding)
        await target.focus()
      }),
    check: (currentPage, target) =>
      queueAction(currentPage, 'check', async (state) => {
        browserBinding.assertLocator(currentPage, target)
        if (!(await target.isChecked())) {
          await performClick(currentPage, state, target, { browserBinding })
        }
      }),
    uncheck: (currentPage, target) =>
      queueAction(currentPage, 'uncheck', async (state) => {
        browserBinding.assertLocator(currentPage, target)
        if (await target.isChecked()) {
          await performClick(currentPage, state, target, { browserBinding })
        }
      }),
    selectOption: (currentPage, target, values) =>
      queueAction(currentPage, 'selectOption', async (state) => {
        await moveToTarget(currentPage, state, target, browserBinding)
        await target.focus()
        await sleep(uniform(80, 180))
        await target.selectOption(values)
      })
  }
}

function createSessionSurface(deps) {
  const { box, paths, resetStealthProfile } = deps
  const { clickAction, wheel } = createSessionActions(deps)
  const sessionBox = {}
  const close = createSessionCloser({ ...deps, sessionRef: () => sessionBox.session })
  const session = {
    ...createSessionCore(deps),
    ...createSessionPointerVerbs({ ...deps, clickAction, wheel }),
    ...createSessionKeyboardVerbs(deps),
    close,
    async resetProfile() {
      await sessionBox.session.close()
      await resetStealthProfile({ dataDir: paths.root })
      box.status = 'reset'
    }
  }
  sessionBox.session = session
  return session
}

function buildSessionTelemetry() {
  return {
    startedAt: new Date().toISOString(),
    managedActions: 0,
    failedActions: 0,
    mainFrameNavigations: 0,
    popups: 0,
    lastDocumentStatus: undefined
  }
}

function createRemovableListener(removers) {
  return (surface, event, listener) => {
    surface.on(event, listener)
    removers.push(() => surface.off(event, listener))
  }
}

function bindStealthSessionListeners({
  persistentContext,
  registerPage,
  stopPage,
  livePages,
  box,
  stateByPage,
  addListener
}) {
  for (const currentPage of persistentContext.pages()) {
    registerPage(currentPage)
  }

  addListener(persistentContext, 'page', registerPage)
  addListener(persistentContext, 'close', () => {
    box.isContextClosed = true
    if (box.status === 'open') {
      box.status = 'externally-closed'
    }

    for (const currentPage of livePages) {
      stopPage(stateByPage.get(currentPage))
    }

    livePages.clear()
  })
}

function createStealthSessionState(deps, persistentContext, profile) {
  const box = { status: 'open', closePromise: undefined, isContextClosed: false }
  const stateByPage = new WeakMap()
  const livePages = new Set()
  const telemetry = buildSessionTelemetry()
  const removers = []
  const addListener = createRemovableListener(removers)
  const { requireOpenBrowser, requirePage } = createSessionGuards({
    box,
    binding: deps.binding,
    profileKind: deps.profileKind,
    browserBinding: deps.browserBinding,
    stateByPage
  })
  const stopPage = createStopPage({ stateByPage, livePages })
  const queueAction = createQueueAction({ requirePage, telemetry })
  const { moveToPoint, moveToTarget } = createMoveHelpers(profile, pageViewport, requirePage)
  const { typeText, performClick } = createInputHelpers(profile, requirePage, moveToPoint)
  const interactiveElements = createInteractiveElements(requirePage)
  const { resolveVisible } = createResolutionHelpers(requirePage, interactiveElements)
  const registerPage = createPageRegistrar({
    persistentContext,
    profile,
    stateByPage,
    livePages,
    telemetry,
    box,
    stopPage
  })
  bindStealthSessionListeners({
    persistentContext,
    registerPage,
    stopPage,
    livePages,
    box,
    stateByPage,
    addListener
  })
  return {
    box,
    stateByPage,
    livePages,
    telemetry,
    removers,
    requireOpenBrowser,
    requirePage,
    stopPage,
    queueAction,
    moveToPoint,
    moveToTarget,
    typeText,
    performClick,
    resolveVisible,
    interactiveElements,
    registerPage
  }
}

function buildStealthSession(deps) {
  const { persistentContext, profile } = deps
  return createSessionSurface({
    ...deps,
    ...createStealthSessionState(deps, persistentContext, profile)
  })
}

async function launchSessionController({
  kind,
  options,
  sessions,
  assignSession,
  controllerLaunches,
  baseDir,
  runtimeSessionId,
  createStealthController,
  launchDeps
}) {
  const current = sessions[kind]()
  if (current && current.state() === 'open') {
    return current
  }

  if (current && current.state() === 'externally-closed') {
    throw new Error(
      `The ${kind} browser bound to OpenCode session ${runtimeSessionId} was closed outside the controller. Refusing to relaunch or adopt another browser.`
    )
  }

  const root = path.resolve(options.dataDir || path.join(baseDir, 'stealth'))
  if (!controllerLaunches.has(root)) {
    controllerLaunches.set(
      root,
      createStealthController({ ...launchDeps, ...options }).finally(() =>
        controllerLaunches.delete(root)
      )
    )
  }

  const session = await controllerLaunches.get(root)
  if (session.capabilities().profileKind !== options.profileKind) {
    throw new Error(
      `The shared stealth profile is open in ${session.capabilities().profileKind} mode. Close it before switching to ${options.profileKind} mode.`
    )
  }

  assignSession(session)
  return session
}

function createRuntime(deps) {
  const { chromium, browserEngine, opencode, headless, webProfileDir, mobileProfileDir } = deps
  let webSession
  let mobileSession
  const sessions = { desktop: () => webSession, mobile: () => mobileSession }
  const runtimeSessionId = opencode.sessionId
  const controllerRegistry = new Map()
  const controllerLaunches = new Map()
  const baseDir = opencode.tmpDir || opencode.homeDir
  const store = createProfileStore(baseDir)
  const launchDeps = createLaunchDeps({
    chromium,
    headless,
    browserEngine,
    opencode,
    controllerRegistry,
    runtimeSessionId,
    store
  })
  const createStealthController = (options) => createControllerImpl(launchDeps, options)
  const ensureController = (kind, options) => {
    const assignSession = (session) => {
      if (kind === 'mobile') {
        mobileSession = session
      } else {
        webSession = session
      }
    }

    return launchSessionController({
      kind,
      options,
      sessions,
      assignSession,
      controllerLaunches,
      baseDir,
      runtimeSessionId,
      createStealthController,
      launchDeps
    })
  }

  return {
    ensureWebBrowser: () =>
      ensureController('desktop', { dataDir: webProfileDir, profileKind: 'desktop' }),
    ensureMobileBrowser: () =>
      ensureController('mobile', {
        dataDir: mobileProfileDir || webProfileDir,
        profileKind: 'mobile'
      }),
    createStealthController,
    resetStealthProfile: store.resetStealthProfile
  }
}
