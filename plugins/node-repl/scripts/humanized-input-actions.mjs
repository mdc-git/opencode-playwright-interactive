import {
  FALLBACK_VIEWPORT,
  fittsDuration,
  pathBetween,
  pointFor,
  sequence,
  sleep,
  uniform
} from './humanized-input-utils.mjs'
import { targetBox } from './humanized-input-target.mjs'

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

export { createMoveHelpers, pageViewport }
