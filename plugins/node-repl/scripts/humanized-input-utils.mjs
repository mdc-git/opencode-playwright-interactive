// Pure helpers for humanized input: no browser, profile or session state.
// Behavior math (pointer paths, timing, typing latency) lives here so the
// stateful runtime can stay focused on lifecycle and Playwright orchestration.

export const PERSONA_SCHEMA = 2
export const MOBILE_VIEWPORT = Object.freeze({ width: 390, height: 844 })
export const MOBILE_DEVICE_SCALE_FACTOR = 3
// Used only when neither the page's viewportSize() nor an in-page evaluation
// can produce dimensions (for example during an early navigation).
export const FALLBACK_VIEWPORT = Object.freeze({ width: 960, height: 540 })
export const IDENTITY_CONTEXT_OPTIONS = Object.freeze([
  'userAgent',
  'locale',
  'timezoneId',
  'isMobile',
  'hasTouch',
  'deviceScaleFactor',
  'viewport',
  'screen'
])
export const IDENTITY_ARGUMENTS = Object.freeze([
  '--disable-blink-features=AutomationControlled',
  '--force-device-scale-factor',
  '--lang',
  '--user-agent'
])
export const IDENTITY_HEADERS = Object.freeze([
  'accept-language',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'user-agent'
])
export const STEALTH_ARGUMENTS = Object.freeze([
  '--disable-blink-features=AutomationControlled',
  '--disable-features=AutomationControlled,IsolateOrigins,site-per-process',
  '--no-first-run',
  '--no-default-browser-check'
])
export const STRUCTURAL_ROLES = Object.freeze([
  'search',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'region',
  'form',
  'heading',
  'list',
  'listitem',
  'presentation',
  'none'
])
export const BEHAVIOR_SCHEMA = 2

export const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
export const settleWithin = (promise, milliseconds, fallback) =>
  Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    sleep(milliseconds).then(() => fallback)
  ])
export const uniform = (minimum, maximum) => {
  const spread = maximum - minimum
  const offset = Math.random() * spread
  return minimum + offset
}

export const normal = () => {
  let first = 0
  let second = 0
  while (!first) {
    first = Math.random()
  }

  while (!second) {
    second = Math.random()
  }

  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second)
}

export const logNormal = (mean, sigma) => {
  const logMean = Math.log(Math.max(1, mean))
  const deviation = sigma * normal()
  return Math.max(1, Math.exp(logMean + deviation))
}

export const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value))

// Fitts's law: expected movement time for a pointer travelling distance D to a
// target of width W, in milliseconds. Humans plan travel time from D and W.
export const fittsDuration = (distance, targetSize, profile) => {
  const safeTargetSize = Math.max(1, targetSize)
  const ratio = distance / safeTargetSize
  const steps = Math.log2(ratio + 1)
  const slopeTime = profile.fittsSlope * steps
  const duration = profile.fittsIntercept + slopeTime
  return clamp(duration, profile.fittsMinDuration, profile.fittsMaxDuration)
}

// Common digraphs are stored as units and typed quickly; rare combinations
// carry a planning cost. Returns a latency multiplier for a character pair.
const BIGRAM_EASE =
  /^(?:th|he|in|er|an|re|on|at|en|nd|ti|es|or|te|of|ed|is|it|al|ar|st|to|nt|ng|se|ha|as|ou|io|le|ve|co|me|de|hi|ri|ro|ic|ne|ea|ra|ce|li|ch|ll|be|ma|si|om|ur)$/v
export const digraphFactor = (previous, current) => {
  if (!previous) {
    return 1.35
  }

  const pair = `${previous}${current}`.toLowerCase()
  if (BIGRAM_EASE.test(pair)) {
    return 0.82
  }

  if (previous === current) {
    return 0.92
  }

  if (/^\s$/v.test(previous) || /^\s$/v.test(current)) {
    return 1.08
  }

  if (/[\p{Punctuation}\p{Symbol}]/v.test(current) || /[A-Z]/v.test(current)) {
    return 1.22
  }

  return 1
}

export const pathBetween = (from, to, profile) => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy) || 1
  const perpendicular = { x: -dy / distance, y: dx / distance }
  const bend = Math.min(80, distance * profile.curveFactor) * (Math.random() < 0.5 ? -1 : 1)
  const firstTravel = { x: dx * 0.3, y: dy * 0.3 }
  const firstSway = { x: perpendicular.x * bend, y: perpendicular.y * bend }
  const first = {
    x: from.x + firstTravel.x + firstSway.x,
    y: from.y + firstTravel.y + firstSway.y
  }
  const secondTravel = { x: dx * 0.7, y: dy * 0.7 }
  const secondSway = { x: perpendicular.x * bend * 0.7, y: perpendicular.y * bend * 0.7 }
  const second = {
    x: from.x + secondTravel.x - secondSway.x,
    y: from.y + secondTravel.y - secondSway.y
  }
  const steps = Math.max(5, Math.min(30, Math.round(distance / 15)))
  const points = []
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps
    const inverse = 1 - t
    const inverseSquared = inverse ** 2
    const inverseCubed = inverse ** 3
    const tSquared = t ** 2
    const tCubed = t ** 3
    const term1x = inverseCubed * from.x
    const term2x = 3 * inverseSquared * t * first.x
    const term3x = 3 * inverse * tSquared * second.x
    const term4x = tCubed * to.x
    const term1y = inverseCubed * from.y
    const term2y = 3 * inverseSquared * t * first.y
    const term3y = 3 * inverse * tSquared * second.y
    const term4y = tCubed * to.y
    points.push({ x: term1x + term2x + term3x + term4x, y: term1y + term2y + term3y + term4y })
  }

  if (distance > 40 && Math.random() < profile.overshootChance) {
    const amount = uniform(profile.overshootMin, profile.overshootMax)
    const overshootRatioX = dx / distance
    const overshootRatioY = dy / distance
    const offsetX = overshootRatioX * amount
    const offsetY = overshootRatioY * amount
    const overshoot = { x: to.x + offsetX, y: to.y + offsetY }
    const landing = points.pop()
    points.push(overshoot, landing)
  }

  return points
}

const clickCoordinate = (size, origin, precision) => {
  const half = size / 2
  const jitter = normal() * precision
  const center = origin + half + jitter
  const low = origin + 1
  const high = origin + Math.max(1, size - 1)
  return clamp(center, low, high)
}

export const pointFor = (box, profile) => {
  const targetSize = Math.max(box.width, box.height)
  return {
    x: box.width <= 1 ? box.x : clickCoordinate(box.width, box.x, profile.clickPrecision),
    y: box.height <= 1 ? box.y : clickCoordinate(box.height, box.y, profile.clickPrecision),
    targetSize
  }
}
