import { createHash } from 'node:crypto'

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4']

export const MODEL_PROFILES = {
  seedance_2_0: {
    label: 'Seedance 2.0',
    minDuration: 4,
    maxDuration: 15,
    defaultDuration: 5,
    resolutions: ['480p', '720p', '1080p', '4k'],
    defaultResolution: '720p',
    supportsAudio: false,
    intermediateMediaFlag: '--image',
  },
}

const clampString = (value, max) => String(value ?? '').trim().slice(0, max)

const STEP_KEY_PATTERN = /^[a-z][a-z0-9-]{1,40}$/

export function validateStoryboardRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object.')
  }

  const concept = clampString(value.concept, 4_000)
  const style = clampString(value.style, 1_000)
  const aspectRatio = String(value.aspectRatio ?? '16:9')

  let steps = null
  if (Array.isArray(value.steps)) {
    steps = value.steps.map((entry) => String(entry).trim().toLowerCase())
    if (steps.some((entry) => !STEP_KEY_PATTERN.test(entry))) {
      throw new Error('Step keys must be lowercase identifiers.')
    }
    if (new Set(steps).size !== steps.length) throw new Error('Step selection must be unique.')
  }

  const shotCount = steps?.length ?? Number(value.shotCount)
  if (!Number.isInteger(shotCount) || shotCount < 2 || shotCount > 8) {
    throw new Error('Shot count must be an integer between 2 and 8.')
  }
  if (concept.length < 10) throw new Error('Concept must be at least 10 characters.')
  if (!ASPECT_RATIOS.includes(aspectRatio)) throw new Error('Unsupported aspect ratio.')

  return {
    concept,
    style: style || 'Cinematic concept art, coherent characters and production design',
    shotCount,
    aspectRatio,
    steps,
  }
}

const FRAME_EDIT_LIMITS = {
  title: 100,
  beat: 500,
  composition: 800,
  camera: 400,
  transition: 300,
  imagePrompt: 2_000,
}

export function validateFrameEdit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be an object.')
  }
  const updates = {}
  for (const [key, max] of Object.entries(FRAME_EDIT_LIMITS)) {
    if (!(key in value)) continue
    const clamped = clampString(value[key], max)
    if (!clamped) throw new Error(`Field "${key}" must not be empty.`)
    updates[key] = clamped
  }
  if (!Object.keys(updates).length) throw new Error('No editable fields provided.')
  return updates
}

export function normalizeStoryboardPlan(plan, input) {
  const shots = Array.isArray(plan?.shots) ? plan.shots : []
  if (shots.length !== input.shotCount) {
    throw new Error(`The storyboard planner produced ${shots.length} shots; expected ${input.shotCount}.`)
  }

  return {
    title: clampString(plan.title, 120) || 'Untitled storyboard',
    continuityBible: clampString(plan.continuityBible, 2_000),
    motionPrompt: clampString(plan.motionPrompt, 2_000),
    shots: shots.map((shot, index) => ({
      id: `frame-${String(index + 1).padStart(2, '0')}`,
      position: index + 1,
      title: clampString(shot?.title, 100) || `Shot ${index + 1}`,
      beat: clampString(shot?.beat, 500),
      composition: clampString(shot?.composition, 800),
      camera: clampString(shot?.camera, 400),
      transition: clampString(shot?.transition, 300),
      imagePrompt: clampString(shot?.imagePrompt, 2_000),
    })),
  }
}

export function validateRenderConfig(value, frameIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Render configuration must be an object.')
  }

  const model = String(value.model ?? '')
  const profile = MODEL_PROFILES[model]
  if (!profile) throw new Error('Unsupported Higgsfield model.')

  const order = Array.isArray(value.order) ? value.order.map(String) : []
  const known = new Set(frameIds)
  if (order.length !== frameIds.length || new Set(order).size !== frameIds.length) {
    throw new Error('Frame order must contain every frame exactly once.')
  }
  if (order.some((id) => !known.has(id))) throw new Error('Frame order contains an unknown frame.')

  const duration = Number(value.duration)
  if (!Number.isInteger(duration) || duration < profile.minDuration || duration > profile.maxDuration) {
    throw new Error(`${profile.label} duration must be ${profile.minDuration}-${profile.maxDuration} seconds.`)
  }

  const aspectRatio = String(value.aspectRatio ?? '16:9')
  if (!ASPECT_RATIOS.includes(aspectRatio)) throw new Error('Unsupported aspect ratio.')

  const resolution = String(value.resolution ?? profile.defaultResolution)
  if (!profile.resolutions.includes(resolution)) throw new Error('Unsupported resolution for this model.')

  const prompt = clampString(value.prompt, 4_000)
  if (prompt.length < 8) throw new Error('Motion prompt must be at least 8 characters.')

  return {
    model,
    order,
    duration,
    aspectRatio,
    resolution,
    prompt,
    generateAudio: profile.supportsAudio && value.generateAudio !== false,
  }
}

export function buildHiggsfieldArgs(operation, config, orderedRefs) {
  if (!['cost', 'create'].includes(operation)) throw new Error('Invalid Higgsfield operation.')
  if (!Array.isArray(orderedRefs) || orderedRefs.length < 2) {
    throw new Error('At least two ordered frame references are required.')
  }
  const profile = MODEL_PROFILES[config.model]
  if (!profile) throw new Error('Unsupported Higgsfield model.')

  const args = ['generate', operation, config.model]
  args.push('--prompt', config.prompt)
  args.push('--duration', String(config.duration))
  args.push('--aspect_ratio', config.aspectRatio)
  args.push('--resolution', config.resolution)
  if (config.generateAudio && profile.generateAudioParam) args.push(profile.generateAudioParam, 'true')

  args.push('--start-image', orderedRefs[0])
  for (const ref of orderedRefs.slice(1, -1)) args.push(profile.intermediateMediaFlag || '--image', ref)
  args.push('--end-image', orderedRefs.at(-1))

  if (operation === 'create') {
    args.push('--wait', '--wait-timeout', '30m', '--wait-interval', '5s')
  }
  args.push('--json', '--no-color')
  return args
}

export function configDigest(projectId, config, orderedRefs) {
  return createHash('sha256')
    .update(JSON.stringify({ projectId, config, orderedRefs }))
    .digest('hex')
}

export function findFirstUuid(value, preferredKeys = ['media_id', 'upload_id', 'id']) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!value || typeof value !== 'object') return null

  for (const key of preferredKeys) {
    const candidate = value[key]
    if (typeof candidate === 'string' && uuidPattern.test(candidate)) return candidate
  }
  for (const candidate of Object.values(value)) {
    if (typeof candidate === 'string' && uuidPattern.test(candidate)) return candidate
    if (candidate && typeof candidate === 'object') {
      const nested = findFirstUuid(candidate, preferredKeys)
      if (nested) return nested
    }
  }
  return null
}

export function findMediaUrls(value) {
  const urls = new Set()
  const visit = (item, key = '') => {
    if (typeof item === 'string' && /^https:\/\//i.test(item) && /\.(mp4|mov|webm)(\?|$)/i.test(item)) {
      urls.add(item)
      return
    }
    if (typeof item === 'string' && /^https:\/\//i.test(item) && /video|output|result|raw/i.test(key)) {
      urls.add(item)
      return
    }
    if (Array.isArray(item)) return item.forEach((candidate) => visit(candidate, key))
    if (item && typeof item === 'object') {
      for (const [childKey, candidate] of Object.entries(item)) visit(candidate, childKey)
    }
  }
  visit(value)
  return [...urls]
}

export function findImageUrls(value) {
  const urls = new Set()
  const visit = (item, key = '') => {
    if (typeof item === 'string' && /^https:\/\//i.test(item) && /\.(png|jpe?g|webp)(\?|$)/i.test(item)) {
      urls.add(item)
      return
    }
    if (typeof item === 'string' && /^https:\/\//i.test(item) && /image|output|result|raw|media|url/i.test(key)) {
      urls.add(item)
      return
    }
    if (Array.isArray(item)) return item.forEach((candidate) => visit(candidate, key))
    if (item && typeof item === 'object') {
      for (const [childKey, candidate] of Object.entries(item)) visit(candidate, childKey)
    }
  }
  visit(value)
  return [...urls]
}
