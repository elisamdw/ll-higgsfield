import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHiggsfieldArgs,
  findImageUrls,
  findMediaUrls,
  validateRenderConfig,
} from '../lib/core.mjs'

const frameIds = ['frame-01', 'frame-02', 'frame-03', 'frame-04']

function config(overrides = {}) {
  return {
    model: 'seedance_2_0',
    order: frameIds,
    duration: 8,
    aspectRatio: '16:9',
    resolution: '720p',
    prompt: 'Move through each frame with restrained camera motion.',
    generateAudio: true,
    ...overrides,
  }
}

test('render configuration requires every frame exactly once', () => {
  assert.throws(
    () => validateRenderConfig(config({ order: ['frame-01', 'frame-02', 'frame-02', 'frame-04'] }), frameIds),
    /exactly once/,
  )
  assert.throws(
    () => validateRenderConfig(config({ order: ['frame-01', 'frame-02', 'frame-03', 'frame-99'] }), frameIds),
    /unknown frame/,
  )
})

test('ordered cards map to start, reference, reference, end in the CLI call', () => {
  const validated = validateRenderConfig(config({ order: ['frame-03', 'frame-01', 'frame-04', 'frame-02'] }), frameIds)
  const args = buildHiggsfieldArgs('create', validated, ['upload-3', 'upload-1', 'upload-4', 'upload-2'])

  assert.deepEqual(args.slice(args.indexOf('--start-image'), args.indexOf('--end-image') + 2), [
    '--start-image', 'upload-3',
    '--image', 'upload-1',
    '--image', 'upload-4',
    '--end-image', 'upload-2',
  ])
  assert.ok(args.includes('--wait'))
  assert.ok(args.includes('--json'))
})

test('cost calls use the same media ordering without submitting a generation', () => {
  const validated = validateRenderConfig(config(), frameIds)
  const args = buildHiggsfieldArgs('cost', validated, ['one', 'two', 'three', 'four'])

  assert.equal(args[1], 'cost')
  assert.equal(args.includes('--wait'), false)
  assert.deepEqual(args.slice(args.indexOf('--start-image'), args.indexOf('--end-image') + 2), [
    '--start-image', 'one',
    '--image', 'two',
    '--image', 'three',
    '--end-image', 'four',
  ])
})

test('video URLs are extracted from common Higgsfield result shapes', () => {
  assert.deepEqual(findMediaUrls({ result: { rawUrl: 'https://cdn.example.test/signed-output?id=1' } }), [
    'https://cdn.example.test/signed-output?id=1',
  ])
  assert.deepEqual(findMediaUrls({ media: ['https://cdn.example.test/final.mp4?token=x'] }), [
    'https://cdn.example.test/final.mp4?token=x',
  ])
})

test('image URLs are extracted from signed and extension-based result shapes', () => {
  assert.deepEqual(findImageUrls({ output: { rawUrl: 'https://cdn.example.test/render?id=1' } }), [
    'https://cdn.example.test/render?id=1',
  ])
  assert.deepEqual(findImageUrls({ files: ['https://cdn.example.test/frame.webp?token=x'] }), [
    'https://cdn.example.test/frame.webp?token=x',
  ])
})
