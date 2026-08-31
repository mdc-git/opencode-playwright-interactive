import { clickablePoint, targetBox } from './humanized-input-target.mjs'
import {
  clamp,
  digraphFactor,
  logNormal,
  pointFor,
  sequence,
  sleep,
  uniform
} from './humanized-input-utils.mjs'

async function pressKey(currentPage, character, profile) {
  try {
    await currentPage.keyboard.press(character, {
      delay: uniform(profile.keyHoldMin, profile.keyHoldMax)
    })
  } catch {
    await currentPage.keyboard.insertText(character)
  }
}

async function typeCharacter(currentPage, character, previous, profile) {
  if (/^[\p{Letter}\p{Number}\p{Punctuation}\p{Space_Separator}\p{Symbol}]$/v.test(character)) {
    await pressKey(currentPage, character, profile)
  } else {
    await currentPage.keyboard.insertText(character)
  }

  const base =
    character === ' '
      ? logNormal(120, 0.25)
      : logNormal(profile.typingMean, profile.typingSigma) * digraphFactor(previous, character)
  await sleep(Math.max(8, base))
}

async function withModifiers(currentPage, modifiers, action) {
  const pressed = []
  try {
    const list = Array.isArray(modifiers) ? modifiers : modifiers ? [modifiers] : []
    await sequence(list, async (modifier) => {
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

async function typeText(currentPage, text, profile) {
  if (typeof text !== 'string') {
    throw new TypeError('Humanized text input requires a string')
  }

  if (text.length === 0) {
    return
  }

  await sleep(logNormal(300, 0.3))
  let previous = ''
  await sequence([...text], async (character) => {
    await typeCharacter(currentPage, character, previous, profile)
    previous = character
  })
}

async function performClick({ currentPage, state, target, options, profile, moveToPoint }) {
  const { modifiers, button, count = 1, timeout } = options ?? {}
  const box = await targetBox(currentPage, target, timeout)
  const point = pointFor(box, profile)
  await sleep(Math.min(1200, logNormal(profile.actionGapMean, profile.actionGapSigma)))
  await moveToPoint(currentPage, state, point)
  const clickPoint = await clickablePoint(target, point, box)
  await withModifiers(currentPage, modifiers, () =>
    performClickGesture({
      currentPage,
      state,
      point: clickPoint,
      button,
      count,
      profile,
      moveToPoint
    })
  )
}

async function performTremor(currentPage, point, profile) {
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
}

async function pressAndRelease(currentPage, button, clickCount, profile) {
  await currentPage.mouse.down({ button, clickCount })
  try {
    await sleep(uniform(profile.clickHoldMin, profile.clickHoldMax))
  } finally {
    await currentPage.mouse.up({ button, clickCount })
  }
}

function performClickGesture({ currentPage, state, point, button, count, profile, moveToPoint }) {
  return sequence(
    Array.from({ length: count }, (_, clickIndex) => clickIndex),
    async (clickIndex) => {
      await moveToPoint(currentPage, state, point)
      await performTremor(currentPage, point, profile)
      await currentPage.mouse.move(point.x, point.y)
      const clickCount = count === 2 ? clickIndex + 1 : 1
      await pressAndRelease(currentPage, button || 'left', clickCount, profile)
      if (count === 2) {
        await sleep(uniform(60, 140))
      }
    }
  )
}

function createInputHelpers(profile, moveToPoint) {
  return {
    typeText: (currentPage, text) => typeText(currentPage, text, profile),
    performClick: (currentPage, state, target, options) =>
      performClick({ currentPage, state, target, options, profile, moveToPoint })
  }
}

export { createInputHelpers }
