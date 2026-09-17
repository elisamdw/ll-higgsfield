import test from 'node:test'
import assert from 'node:assert/strict'
import { createTemplatePlan } from '../lib/storyboard.mjs'

test('local templates create a complete deterministic directing plan', () => {
  const input = {
    concept: 'A rooftop observer discovers a recursive figure inside a luminous planet.',
    style: 'Cinematic cobalt night photography',
    shotCount: 5,
    aspectRatio: '16:9',
  }
  const first = createTemplatePlan(input)
  const second = createTemplatePlan(input)

  assert.deepEqual(first, second)
  assert.equal(first.shots.length, 5)
  assert.equal(first.shots[0].title, 'Establish')
  assert.equal(first.shots.at(-1).title, 'Echo')
  assert.match(first.continuityBible, /Preserve the same recurring people/)
  assert.match(first.motionPrompt, /submitted frame order exactly/)
  assert.ok(first.shots.every((shot) => shot.imagePrompt.includes(input.concept)))
})
