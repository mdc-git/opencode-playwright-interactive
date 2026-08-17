// Profile persistence for the stealth runtime: behavior, persona and identity
// metadata records plus the shared user-data directory layout. Owns the
// serialized write queue and the read/migrate/quarantine policy for on-disk
// records. No browser or Playwright state lives here.

import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  BEHAVIOR_SCHEMA,
  MOBILE_DEVICE_SCALE_FACTOR,
  PERSONA_SCHEMA,
  clamp,
  uniform
} from './stealth-utils.mjs'

const DEFAULT_MAXIMUM = 16 * 1024

const defaults = {
  schema: BEHAVIOR_SCHEMA,
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
  fittsIntercept: 90,
  fittsSlope: 110,
  fittsMinDuration: 60,
  fittsMaxDuration: 900,
  typoRate: 0.02
}

const number = (value, fallback, minimum, maximum) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? clamp(parsed, minimum, maximum) : fallback
}

export const normalizeBehavior = (value) => {
  if (
    !value ||
    value.schema !== BEHAVIOR_SCHEMA ||
    typeof value.profileId !== 'string' ||
    !value.profileId
  ) {
    return undefined
  }

  const profile = { ...defaults, profileId: value.profileId }
  profile.clickPrecision = number(value.clickPrecision, profile.clickPrecision, 1, 5)
  profile.curveFactor = number(value.curveFactor, profile.curveFactor, 0.05, 0.3)
  profile.overshootChance = number(value.overshootChance, profile.overshootChance, 0, 1)
  profile.overshootMin = number(value.overshootMin, profile.overshootMin, 2, 10)
  profile.overshootMax = number(value.overshootMax, profile.overshootMax, 8, 25)
  profile.tremorCount = Math.round(number(value.tremorCount, profile.tremorCount, 2, 5))
  profile.tremorAmplitude = number(value.tremorAmplitude, profile.tremorAmplitude, 0.25, 3)
  profile.clickHoldMin = number(value.clickHoldMin, profile.clickHoldMin, 35, 100)
  profile.clickHoldMax = number(value.clickHoldMax, profile.clickHoldMax, 80, 160)
  profile.typingMean = number(value.typingMean, profile.typingMean, 50, 150)
  profile.typingSigma = number(value.typingSigma, profile.typingSigma, 0.1, 0.6)
  profile.keyHoldMin = number(value.keyHoldMin, profile.keyHoldMin, 20, 100)
  profile.keyHoldMax = number(value.keyHoldMax, profile.keyHoldMax, 60, 180)
  profile.actionGapMean = number(value.actionGapMean, profile.actionGapMean, 200, 800)
  profile.actionGapSigma = number(value.actionGapSigma, profile.actionGapSigma, 0.1, 0.6)
  profile.fittsIntercept = number(value.fittsIntercept, profile.fittsIntercept, 40, 200)
  profile.fittsSlope = number(value.fittsSlope, profile.fittsSlope, 40, 250)
  profile.fittsMinDuration = number(value.fittsMinDuration, profile.fittsMinDuration, 30, 200)
  profile.fittsMaxDuration = number(value.fittsMaxDuration, profile.fittsMaxDuration, 300, 2500)
  profile.typoRate = number(value.typoRate, profile.typoRate, 0, 0.08)
  if (profile.fittsMaxDuration < profile.fittsMinDuration) {
    profile.fittsMaxDuration = profile.fittsMinDuration + 1
  }

  if (profile.overshootMax < profile.overshootMin) {
    profile.overshootMax = profile.overshootMin + 1
  }

  if (profile.clickHoldMax < profile.clickHoldMin) {
    profile.clickHoldMax = profile.clickHoldMin + 1
  }

  if (profile.keyHoldMax < profile.keyHoldMin) {
    profile.keyHoldMax = profile.keyHoldMin + 1
  }

  return profile
}

export const createBehavior = () =>
  normalizeBehavior({
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
    fittsIntercept: uniform(80, 110),
    fittsSlope: uniform(95, 135),
    fittsMinDuration: uniform(45, 75),
    fittsMaxDuration: uniform(700, 1200),
    typoRate: uniform(0.008, 0.035)
  })

const locale = () => {
  const resolved = new Intl.DateTimeFormat().resolvedOptions()
  return {
    locale: typeof resolved.locale === 'string' && resolved.locale ? resolved.locale : 'en-US',
    timezoneId:
      typeof resolved.timeZone === 'string' && resolved.timeZone ? resolved.timeZone : 'UTC'
  }
}

export const normalizePersona = (value) => {
  if (
    !value ||
    ![1, PERSONA_SCHEMA].includes(value.schema) ||
    typeof value.personaId !== 'string' ||
    !value.personaId ||
    typeof value.locale !== 'string' ||
    typeof value.timezoneId !== 'string'
  ) {
    return undefined
  }

  return {
    schema: PERSONA_SCHEMA,
    personaId: value.personaId,
    profileKind: 'desktop',
    browserChannel: 'chromium',
    browserIdentity: 'native',
    locale: value.locale,
    timezoneId: value.timezoneId,
    viewport: null,
    screen: null,
    deviceScaleFactor: number(value.deviceScaleFactor, 1, 1, 4),
    mobileDeviceScaleFactor: number(
      value.mobileDeviceScaleFactor,
      MOBILE_DEVICE_SCALE_FACTOR,
      1,
      4
    ),
    isMobile: false,
    hasTouch: false,
    permissionsPolicy: 'default',
    colorScheme: 'no-preference',
    reducedMotion: 'no-preference',
    createdAt: value.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

export const createPersona = () => ({
  schema: PERSONA_SCHEMA,
  personaId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  profileKind: 'desktop',
  browserChannel: 'chromium',
  browserIdentity: 'native',
  ...locale(),
  viewport: null,
  screen: null,
  deviceScaleFactor: 1,
  mobileDeviceScaleFactor: MOBILE_DEVICE_SCALE_FACTOR,
  isMobile: false,
  hasTouch: false,
  permissionsPolicy: 'default',
  colorScheme: 'no-preference',
  reducedMotion: 'no-preference',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
})

export const normalizeMetadata = (value) =>
  value && [1, 2].includes(value.schema) && typeof value.profileId === 'string' && value.profileId
    ? {
        schema: 2,
        profileId: value.profileId,
        personaId: value.personaId || '',
        sessionId: typeof value.sessionId === 'string' ? value.sessionId : '',
        behaviorSchema: BEHAVIOR_SCHEMA,
        personaSchema: PERSONA_SCHEMA,
        createdAt: value.createdAt || new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        resetGeneration: Number.isSafeInteger(value.resetGeneration) ? value.resetGeneration : 0
      }
    : undefined

const resolvePaths = (baseDir, { dataDir } = {}) => {
  const root = path.resolve(dataDir || path.join(baseDir, 'stealth'))
  return {
    root,
    behaviorProfile: path.join(root, 'behavior.json'),
    persona: path.join(root, 'persona.json'),
    identityMetadata: path.join(root, 'profile.json'),
    userData: path.join(root, 'user-data')
  }
}

const quarantine = async (file, reason) => {
  const recovered = `${file}.corrupt-${Date.now().toString(36)}`
  console.warn(
    `Stealth profile record ${file} ${reason}; moving it to ${recovered} and creating a fresh one.`
  )
  await fs.rename(file, recovered).catch(() => fs.rm(file, { force: true }).catch(() => {}))
}

// Only a missing file silently yields "create a fresh record". Corrupt,
// oversized or unrecognized records are quarantined, and operational errors
// (permissions, transient I/O) propagate so continuity problems are visible
// instead of silently replacing a healthy profile.
const readRawRecord = async (file, maximum) => {
  let stat
  try {
    stat = await fs.stat(file)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined
    }

    throw error
  }

  if (stat.size > maximum) {
    await quarantine(file, `exceeds the ${maximum}-byte size limit`)
    return undefined
  }

  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      await quarantine(file, 'contains invalid JSON')
      return undefined
    }

    throw error
  }

  return parsed
}

const writeRecordImpl = async (queueRef, file, value, maximum = DEFAULT_MAXIMUM) => {
  const serialized = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(serialized) > maximum) {
    throw new Error(`Stealth record is unexpectedly large: ${file}`)
  }

  const write = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`
    try {
      const handle = await fs.open(temporary, 'w', 0o600)
      try {
        await handle.writeFile(serialized, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }

      await fs.rename(temporary, file)
    } finally {
      // Never leave an orphaned temp file behind after a failed write.
      await fs.rm(temporary, { force: true }).catch(() => {})
    }
  }

  // Chain on both the fulfilled and rejected path: one failed write must not
  // permanently poison the queue for every later write.
  const operation = queueRef.queue.catch(() => {}).then(write)
  queueRef.queue = operation.catch(() => {})
  return operation
}

const readRecordImpl = async (queueRef, file, handlers, maximum = DEFAULT_MAXIMUM) => {
  const { normalize, create } = handlers
  const raw = await readRawRecord(file, maximum)
  if (raw === undefined) {
    const value = create()
    await writeRecordImpl(queueRef, file, value, maximum)
    return value
  }

  const value = normalize(raw)
  if (!value) {
    await quarantine(file, 'has an unrecognized schema')
    const freshValue = create()
    await writeRecordImpl(queueRef, file, freshValue, maximum)
    return freshValue
  }

  if (typeof raw?.schema === 'number' && raw.schema !== value.schema) {
    // Persist schema migrations once instead of rewriting on every access.
    await writeRecordImpl(queueRef, file, value, maximum)
  }

  return value
}

export function createProfileStore(baseDir) {
  const queueRef = { queue: Promise.resolve() }
  const paths = resolvePaths.bind(null, baseDir)
  const writeRecord = (file, value, maximum) => writeRecordImpl(queueRef, file, value, maximum)
  const readRecord = (file, normalize, create, maximum) =>
    readRecordImpl(queueRef, file, { normalize, create }, maximum)
  const loadBehavior = ({ dataDir } = {}) =>
    readRecord(paths({ dataDir }).behaviorProfile, normalizeBehavior, createBehavior)
  const resetStealthProfile = async ({ dataDir } = {}) => {
    const { root } = paths({ dataDir })
    // Flush queued writes; the recovered queue always settles, so this cannot
    // hang after an earlier failed write.
    await queueRef.queue
    await fs.rm(root, { recursive: true, force: true })
  }

  return { paths, writeRecord, readRecord, loadBehavior, resetStealthProfile }
}
