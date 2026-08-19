import {
  FALLBACK_VIEWPORT,
  clamp,
  digraphFactor,
  fittsDuration,
  logNormal,
  normal,
  pathBetween,
  pointFor,
  sleep,
  uniform
} from './humanized-input-utils.mjs'

const modifierList = (modifiers) =>
  Array.isArray(modifiers) ? modifiers : modifiers ? [modifiers] : []

function sequence(items, operation) {
  let chain = Promise.resolve()
  for (const [index, item] of items.entries()) {
    chain = chain.then(() => operation(item, index))
  }

  return chain
}

async function validateTarget(target, currentPage) {
  if (typeof target.page === 'function' && target.page() !== currentPage) {
    throw new Error('The target locator belongs to a different Playwright page')
  }

  if (typeof target.isEnabled === 'function' && !(await target.isEnabled())) {
    throw new Error('The target locator is disabled')
  }
}

async function targetBox(currentPage, target) {
  if (target && typeof target.boundingBox === 'function') {
    await validateTarget(target, currentPage)
    await target.scrollIntoViewIfNeeded()
    const box = await target.boundingBox()
    if (!box || box.width <= 0 || box.height <= 0) {
      throw new Error('Stealth target is not visible')
    }

    const clickable = await findClickablePoints(currentPage, target)
    if (clickable.length === 0) {
      throw new Error('Stealth target is obscured')
    }

    return {
      ...box,
      stealthPoints: stealthPointsFor(box, clickable)
    }
  }

  if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) {
    return { x: target.x, y: target.y, width: 1, height: 1 }
  }

  throw new TypeError('Stealth target must be a Locator or { x, y }')
}

function stealthCandidatePoints() {
  const jitter = () => normal() * 0.2
  return [
    { x: 0.5, y: 0.5 },
    { x: 0.25, y: 0.5 },
    { x: 0.75, y: 0.5 },
    { x: 0.5, y: 0.25 },
    { x: 0.5, y: 0.75 },
    ...Array.from({ length: 12 }, () => ({
      x: clamp(0.5 + jitter(), 0.1, 0.9),
      y: clamp(0.5 + jitter(), 0.1, 0.9)
    }))
  ]
}

async function findClickablePoints(currentPage, target) {
  return target
    .evaluate((element, points) => {
      const rect = element.getBoundingClientRect()
      const root = element.getRootNode()
      const hitTestRoot = typeof root.elementFromPoint === 'function' ? root : element.ownerDocument
      const targetLink = element.closest?.('a[href]')
      const labels = element.labels ? [...element.labels] : []
      return points.filter((point) => {
        const offsetX = rect.width * point.x
        const offsetY = rect.height * point.y
        const top = hitTestRoot.elementFromPoint(rect.left + offsetX, rect.top + offsetY)
        if (!top) {
          return false
        }

        if (top === element || element.contains(top)) {
          return true
        }

        // Native controls are commonly covered by their associated label.
        if (labels.some((label) => top === label || label.contains(top))) {
          return true
        }

        const topLink = top.closest?.('a[href]')
        return Boolean(targetLink && topLink && targetLink.href === topLink.href)
      })
    }, stealthCandidatePoints())
    .catch(() => [])
}

function stealthPointsFor(box, clickable) {
  return clickable.map((point) => {
    const offsetX = box.width * point.x
    const offsetY = box.height * point.y
    return { x: box.x + offsetX, y: box.y + offsetY }
  })
}

function computeEasing(duration, index, total, elapsed) {
  const t = (index + 2) / total
  const twice = 2 * t
  const eased = duration * t * t * (3 - twice)
  return { slice: eased - elapsed, eased }
}

async function pageViewport(currentPage) {
  const size = currentPage.viewportSize()
  if (size) {
    return size
  }

  return currentPage
    .evaluate(
      ({ width, height }) => ({ width: innerWidth || width, height: innerHeight || height }),
      FALLBACK_VIEWPORT
    )
    .catch(() => ({ ...FALLBACK_VIEWPORT }))
}

function createMoveHelpers(profile, viewport, requirePage) {
  const moveToPoint = async (currentPage, state, point) => {
    const size = await viewport(currentPage)
    const halfWidth = size.width / 2
    const halfHeight = size.height / 2
    const from = { x: state.x ?? halfWidth, y: state.y ?? halfHeight }
    const points = pathBetween(from, point, profile)
    const distance = Math.hypot(point.x - from.x, point.y - from.y)
    const duration = fittsDuration(distance, point.targetSize || 10, profile)
    let elapsed = 0
    await sequence(points, async (next, index) => {
      requirePage(currentPage)
      await currentPage.mouse.move(next.x, next.y)
      state.x = next.x
      state.y = next.y
      if (index + 1 >= points.length) {
        return
      }

      const { slice, eased } = computeEasing(duration, index, points.length, elapsed)
      elapsed = eased
      await sleep(Math.max(4, slice * uniform(0.8, 1.2)))
    })
  }

  const moveToTarget = async (currentPage, state, target) => {
    const box = await targetBox(currentPage, target)
    await moveToPoint(currentPage, state, pointFor(box, profile))
  }

  return { moveToPoint, moveToTarget }
}

function createTypingHelpers(profile) {
  const pressKey = async (
    currentPage,
    character,
    holdMin = profile.keyHoldMin,
    holdMax = profile.keyHoldMax
  ) => {
    try {
      await currentPage.keyboard.press(character, { delay: uniform(holdMin, holdMax) })
    } catch {
      await currentPage.keyboard.insertText(character)
    }
  }

  const typeCharacter = async (currentPage, character, previous) => {
    if (/^[\p{Letter}\p{Number}\p{Punctuation}\p{Space_Separator}\p{Symbol}]$/v.test(character)) {
      await pressKey(currentPage, character)
    } else {
      await currentPage.keyboard.insertText(character)
    }

    const base =
      character === ' '
        ? logNormal(120, 0.25)
        : logNormal(profile.typingMean, profile.typingSigma) * digraphFactor(previous, character)
    await sleep(Math.max(8, base))
    return { previous: character }
  }

  return { pressKey, typeCharacter }
}

function performClickGesture({ currentPage, state, point, button, count, profile, moveToPoint }) {
  return sequence(
    Array.from({ length: count }, (_, clickIndex) => clickIndex),
    async (clickIndex) => {
      await moveToPoint(currentPage, state, point)
      const tremorCount = clamp(Math.round(uniform(2, profile.tremorCount + 1)), 2, 5)
      await sequence(
        Array.from({ length: tremorCount }, (_, index) => index),
        async () => {
          const tremorX = point.x + uniform(-profile.tremorAmplitude, profile.tremorAmplitude)
          const tremorY = point.y + uniform(-profile.tremorAmplitude, profile.tremorAmplitude)
          await currentPage.mouse.move(tremorX, tremorY)
          await sleep(uniform(15, 45))
        }
      )
      await currentPage.mouse.move(point.x, point.y)
      const clickCount = count === 2 ? clickIndex + 1 : 1
      await currentPage.mouse.down({ button: button || 'left', clickCount })
      try {
        await sleep(uniform(profile.clickHoldMin, profile.clickHoldMax))
      } finally {
        await currentPage.mouse.up({ button: button || 'left', clickCount })
      }

      if (count === 2) {
        await sleep(uniform(60, 140))
      }
    }
  )
}

function createInputHelpers(profile, requirePage, moveToPoint) {
  const { pressKey, typeCharacter } = createTypingHelpers(profile)
  const withModifiers = async (currentPage, modifiers, action) => {
    const pressed = []
    try {
      await sequence(modifierList(modifiers), async (modifier) => {
        await currentPage.keyboard.down(modifier)
        pressed.push(modifier)
      })
      return await action()
    } finally {
      await sequence(pressed.toReversed(), (modifier) =>
        currentPage.keyboard.up(modifier).catch(() => {})
      )
    }
  }

  const typeText = async (currentPage, text) => {
    if (typeof text !== 'string') {
      throw new TypeError('Stealth text input requires a string')
    }

    if (text.length === 0) {
      return
    }

    await sleep(logNormal(300, 0.3))
    let previous = ''
    await sequence([...text], async (character) => {
      const result = await typeCharacter(currentPage, character, previous)
      previous = result.previous
    })
  }

  const performClick = async (
    currentPage,
    state,
    target,
    { modifiers, button, count = 1 } = {}
  ) => {
    const box = await targetBox(currentPage, target)
    const point = pointFor(box, profile)
    await sleep(Math.min(1200, logNormal(profile.actionGapMean, profile.actionGapSigma)))
    await withModifiers(currentPage, modifiers, () =>
      performClickGesture({ currentPage, state, point, button, count, profile, moveToPoint })
    )
  }

  return { withModifiers, pressKey, typeText, performClick }
}

export { createInputHelpers, createMoveHelpers, pageViewport }
