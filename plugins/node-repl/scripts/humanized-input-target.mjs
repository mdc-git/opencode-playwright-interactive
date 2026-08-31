async function assertTargetPage(target, currentPage) {
  if (typeof target.page === 'function' && target.page() !== currentPage) {
    throw new Error('The target locator belongs to a different Playwright page')
  }
}

async function assertTargetEnabled(target) {
  if (typeof target.isEnabled === 'function' && !(await target.isEnabled())) {
    throw new Error('The target locator is disabled')
  }
}

async function validateTarget(target, currentPage) {
  await assertTargetPage(target, currentPage)
  await assertTargetEnabled(target)
}

function isLocatorTarget(target) {
  return typeof target?.boundingBox === 'function'
}

function isCoordinateTarget(target) {
  return Number.isFinite(target?.x) && Number.isFinite(target?.y)
}

async function locatorTargetBox(currentPage, target, timeout) {
  await validateTarget(target, currentPage)
  await target.scrollIntoViewIfNeeded({ timeout })
  const box = await target.boundingBox({ timeout })
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error('Humanized input target is not visible')
  }

  return box
}

async function targetBox(currentPage, target, timeout) {
  if (isLocatorTarget(target)) {
    return locatorTargetBox(currentPage, target, timeout)
  }

  if (isCoordinateTarget(target)) {
    return { x: target.x, y: target.y, width: 1, height: 1 }
  }

  throw new TypeError('Humanized input target must be a Locator or { x, y }')
}

async function hitTestCandidates(target, candidates) {
  return target.evaluate((element, points) => {
    const root = element.getRootNode()
    const hitTestRoot = typeof root.elementFromPoint === 'function' ? root : element.ownerDocument
    const rect = element.getBoundingClientRect()
    const labels = element.labels ? [...element.labels] : []
    return points.find((candidate) => {
      const offsetX = rect.width * candidate.x
      const offsetY = rect.height * candidate.y
      const top = hitTestRoot.elementFromPoint(rect.left + offsetX, rect.top + offsetY)
      return (
        top === element ||
        element.contains(top) ||
        labels.some((label) => top === label || label.contains(top))
      )
    })
  }, candidates)
}

async function scrollToAlignment(target, alignment) {
  await target.evaluate(
    (element, block) => element.scrollIntoView({ behavior: 'instant', block, inline: 'nearest' }),
    alignment
  )
}

async function findHitPoint(target, hitTest) {
  let offset = await hitTest()
  if (offset) {
    return offset
  }

  await scrollToAlignment(target, 'start')
  offset = await hitTest()
  if (offset) {
    return offset
  }

  await scrollToAlignment(target, 'end')
  return hitTest()
}

async function clickablePoint(target, point, box) {
  const preferred = {
    x: Math.min(1, Math.max(0, (point.x - box.x) / box.width)),
    y: Math.min(1, Math.max(0, (point.y - box.y) / box.height))
  }
  const candidates = [
    preferred,
    { x: 0.5, y: 0.5 },
    { x: 0.25, y: 0.5 },
    { x: 0.75, y: 0.5 },
    { x: 0.5, y: 0.25 },
    { x: 0.5, y: 0.75 }
  ]
  const hitTest = () => hitTestCandidates(target, candidates)
  const offset = await findHitPoint(target, hitTest)
  if (!offset) {
    throw new Error('Humanized input target is obscured')
  }

  const refreshedBox = await target.boundingBox()
  if (!refreshedBox) {
    throw new Error('Humanized input target is no longer visible after hit testing')
  }

  const offsetX = refreshedBox.width * offset.x
  const offsetY = refreshedBox.height * offset.y
  return {
    x: refreshedBox.x + offsetX,
    y: refreshedBox.y + offsetY,
    targetSize: Math.max(refreshedBox.width, refreshedBox.height)
  }
}

export { clickablePoint, targetBox }
