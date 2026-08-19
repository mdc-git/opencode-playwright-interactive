import { createInputHelpers, createMoveHelpers, pageViewport } from './stealth-input.mjs'
import { clamp, sleep, uniform } from './stealth-utils.mjs'

const DEFAULT_PROFILE = Object.freeze({
  profileId: 'humanized-input',
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
  fittsMaxDuration: 900
})

function requirePage(currentPage) {
  if (!currentPage || typeof currentPage.isClosed !== 'function' || currentPage.isClosed()) {
    throw new Error('Humanized input requires an open Playwright Page')
  }

  return currentPage
}

async function performWheelSteps(currentPage, deltaX, deltaY) {
  const magnitude = Math.max(Math.abs(deltaX), Math.abs(deltaY))
  if (magnitude === 0) {
    return
  }

  const step = async (remainingX, remainingY, impulse, steps) => {
    requirePage(currentPage)
    if (steps >= 24) {
      await currentPage.mouse.wheel(remainingX, remainingY)
      return
    }

    const share = clamp(impulse / Math.max(1, Math.hypot(remainingX, remainingY)), 0.12, 1)
    const stepX = remainingX * share
    const stepY = remainingY * share
    const restX = remainingX - stepX
    const restY = remainingY - stepY
    await currentPage.mouse.wheel(stepX, stepY)
    if (Math.max(Math.abs(restX), Math.abs(restY)) <= 0.5) {
      return
    }

    const nextImpulse = impulse * 0.78 * uniform(0.85, 1.1)
    await sleep(nextImpulse > 90 ? uniform(16, 42) : uniform(55, 110))
    await step(restX, restY, nextImpulse, steps + 1)
  }

  await step(deltaX, deltaY, clamp(magnitude * uniform(0.3, 0.5), 48, 360), 0)
}

function createActionQueue() {
  const stateByPage = new WeakMap()
  const stateFor = (currentPage) => {
    requirePage(currentPage)
    let state = stateByPage.get(currentPage)
    if (!state) {
      state = { x: undefined, y: undefined, queue: Promise.resolve() }
      stateByPage.set(currentPage, state)
    }

    return state
  }

  const queue = (currentPage, action) => {
    const state = stateFor(currentPage)
    const run = () => action(state)
    const result = state.queue.then(run)
    state.queue = result.catch(() => {})
    return result
  }

  return queue
}

function createPointerVerbs({ queue, moveToTarget, performClick }) {
  const click = (currentPage, target, options = {}, count = 1) =>
    queue(currentPage, (state) => performClick(currentPage, state, target, { ...options, count }))
  const wheel = (currentPage, deltaX, deltaY, target) =>
    queue(currentPage, async (state) => {
      if (target !== undefined) {
        await moveToTarget(currentPage, state, target)
      }

      await performWheelSteps(currentPage, deltaX, deltaY)
    })

  return {
    moveTo: (currentPage, target) =>
      queue(currentPage, (state) => moveToTarget(currentPage, state, target)),
    click: (currentPage, target, options) => click(currentPage, target, options),
    doubleClick: (currentPage, target, options) => click(currentPage, target, options, 2),
    hover: (currentPage, target) =>
      queue(currentPage, (state) => moveToTarget(currentPage, state, target)),
    wheel,
    scroll(currentPage, targetOrDelta, deltaY) {
      if (typeof targetOrDelta === 'number') {
        return wheel(currentPage, 0, targetOrDelta)
      }

      if (Number.isFinite(deltaY)) {
        return wheel(currentPage, 0, deltaY, targetOrDelta)
      }

      return queue(currentPage, async (state) => {
        await targetOrDelta.scrollIntoViewIfNeeded()
        await moveToTarget(currentPage, state, targetOrDelta)
      })
    },
    dragTo: (currentPage, source, target) =>
      queue(currentPage, async (state) => {
        await moveToTarget(currentPage, state, source)
        await source.dragTo(target)
      })
  }
}

function createKeyboardVerbs({ queue, moveToTarget, typeText, profile }) {
  return {
    type: (currentPage, target, text) =>
      queue(currentPage, async (state) => {
        await moveToTarget(currentPage, state, target)
        await target.focus()
        await typeText(currentPage, text)
      }),
    fill: (currentPage, target, text) =>
      queue(currentPage, async (state) => {
        await moveToTarget(currentPage, state, target)
        await target.focus()
        await currentPage.keyboard.press('ControlOrMeta+A')
        await currentPage.keyboard.press('Backspace')
        await typeText(currentPage, text)
      }),
    pressText: (currentPage, text) => queue(currentPage, () => typeText(currentPage, text)),
    press: (currentPage, key) =>
      queue(currentPage, () =>
        currentPage.keyboard.press(key, { delay: uniform(profile.keyHoldMin, profile.keyHoldMax) })
      ),
    focus: (currentPage, target) =>
      queue(currentPage, async (state) => {
        await moveToTarget(currentPage, state, target)
        await target.focus()
      })
  }
}

function createFormVerbs({ queue, moveToTarget, performClick }) {
  return {
    check: (currentPage, target) =>
      queue(currentPage, async (state) => {
        if (!(await target.isChecked())) {
          await performClick(currentPage, state, target)
        }
      }),
    uncheck: (currentPage, target) =>
      queue(currentPage, async (state) => {
        if (await target.isChecked()) {
          await performClick(currentPage, state, target)
        }
      }),
    selectOption: (currentPage, target, values) =>
      queue(currentPage, async (state) => {
        await moveToTarget(currentPage, state, target)
        await target.focus()
        await sleep(uniform(80, 180))
        return target.selectOption(values)
      })
  }
}

export function createHumanizedInput({ profile: profileOverrides = {} } = {}) {
  const profile = Object.freeze({ ...DEFAULT_PROFILE, ...profileOverrides })
  const queue = createActionQueue()

  const { moveToPoint, moveToTarget } = createMoveHelpers(profile, pageViewport, requirePage)
  const { typeText, performClick } = createInputHelpers(profile, requirePage, moveToPoint)
  const deps = { queue, moveToTarget, performClick, typeText, profile }

  return Object.freeze({
    profile,
    ...createPointerVerbs(deps),
    ...createKeyboardVerbs(deps),
    ...createFormVerbs(deps)
  })
}
