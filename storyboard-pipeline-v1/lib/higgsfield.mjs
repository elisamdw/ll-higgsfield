import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildHiggsfieldArgs,
  configDigest,
  findFirstUuid,
  findImageUrls,
  findMediaUrls,
  validateRenderConfig,
} from './core.mjs'
import { loadProject, saveFrame, saveProject } from './store.mjs'

const execFileAsync = promisify(execFile)

async function runCli(args, timeout = 120_000) {
  try {
    const { stdout, stderr } = await execFileAsync('higgsfield', args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    })
    return { stdout: stdout.trim(), stderr: stderr.trim() }
  }
  catch (error) {
    const message = error.killed
      ? 'Higgsfield timed out. Check the connection and try again.'
      : String(error.stderr || error.message || 'Higgsfield command failed.').trim()
    throw new Error(message.slice(0, 1_000))
  }
}

function parseCliJson(stdout) {
  const candidates = []
  for (let index = 0; index < stdout.length; index += 1) {
    if (stdout[index] === '{' || stdout[index] === '[') candidates.push(stdout.slice(index))
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    }
    catch {
      // Try the next possible JSON boundary.
    }
  }
  return { message: stdout }
}

function storyboardFramePrompt(project, frame) {
  return [
    'Create one clean cinematic storyboard frame. No panel borders, captions, subtitles, watermarks, or typography.',
    `Project: ${project.title}.`,
    `Continuity bible: ${project.continuityBible}`,
    `Sequence position: ${frame.position} of ${project.frames.length}.`,
    `Narrative beat: ${frame.beat}`,
    `Composition: ${frame.composition}`,
    `Camera: ${frame.camera}`,
    `Shot direction: ${frame.imagePrompt}`,
    frame.position > 1
      ? 'Use the supplied first frame strictly as a continuity reference. Match recurring identities, wardrobe, props, environment design, palette, and lighting while changing only what this shot requires.'
      : 'Establish a precise visual identity that every later frame can match.',
  ].join('\n')
}

function detectedImageType(bytes, header = '') {
  const mime = header.split(';')[0].trim().toLowerCase()
  if (['image/jpeg', 'image/png', 'image/webp'].includes(mime)) return mime
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

async function downloadGeneratedImage(urls) {
  let lastError = null
  for (const url of urls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!response.ok) throw new Error(`download failed (${response.status})`)
      const declaredSize = Number(response.headers.get('content-length') || 0)
      if (declaredSize > 30 * 1024 * 1024) throw new Error('image is larger than 30 MB')
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > 30 * 1024 * 1024) throw new Error('image is larger than 30 MB')
      const mimeType = detectedImageType(bytes, response.headers.get('content-type') || '')
      if (!mimeType) throw new Error('result was not a supported image')
      return { bytes, mimeType }
    }
    catch (error) {
      lastError = error
    }
  }
  throw new Error(`Higgsfield finished the frame but its image could not be downloaded${lastError ? `: ${lastError.message}` : '.'}`)
}

export async function generateStoryboardFrame(project, frame, continuityFrame = null) {
  const model = process.env.HIGGSFIELD_STORYBOARD_MODEL || 'nano_banana_2'
  const args = [
    'generate', 'create', model,
    '--prompt', storyboardFramePrompt(project, frame),
    '--aspect_ratio', project.aspectRatio,
  ]
  if (continuityFrame) args.push('--image', continuityFrame.uploadRef || continuityFrame.localPath)
  args.push('--wait', '--wait-timeout', '15m', '--wait-interval', '4s', '--json', '--no-color')

  const { stdout } = await runCli(args, 17 * 60_000)
  const payload = parseCliJson(stdout)
  const resultUrls = findImageUrls(payload)
  if (!resultUrls.length) throw new Error(`Higgsfield returned no image URL for ${frame.title}.`)
  const image = await downloadGeneratedImage(resultUrls)
  const media = await saveFrame(project.id, frame.id, image.bytes, image.mimeType)
  const jobId = findFirstUuid(payload, ['job_id', 'jobId', 'id'])
  return {
    ...media,
    ...(jobId ? { uploadRef: jobId } : {}),
    sourceModel: model,
  }
}

export async function renderStoryboardFrames(project, onFrame = () => {}) {
  const first = project.frames[0]
  const firstMedia = await generateStoryboardFrame(project, first)
  Object.assign(first, firstMedia, { status: 'ready' })
  await onFrame(first)

  for (const frame of project.frames.slice(1)) {
    const media = await generateStoryboardFrame(project, frame, first)
    Object.assign(frame, media, { status: 'ready' })
    await onFrame(frame)
  }
  return project
}

async function uploadFrame(frame) {
  if (frame.uploadRef) return frame.uploadRef
  const { stdout } = await runCli(['upload', 'create', frame.localPath, '--json', '--no-color'], 180_000)
  const payload = parseCliJson(stdout)
  const id = findFirstUuid(payload)
  if (!id) throw new Error(`Higgsfield did not return an upload reference for ${frame.title}.`)
  frame.uploadRef = id
  return id
}

async function prepare(projectId, rawConfig) {
  let project = await loadProject(projectId)
  const config = validateRenderConfig(rawConfig, project.frames.map((frame) => frame.id))
  const byId = new Map(project.frames.map((frame) => [frame.id, frame]))
  const orderedFrames = config.order.map((id) => byId.get(id))

  const refs = []
  for (const frame of orderedFrames) refs.push(await uploadFrame(frame))
  project = await saveProject(project)
  return { project, config, refs }
}

function displayCredits(payload) {
  const visit = (value) => {
    if (!value || typeof value !== 'object') return null
    for (const key of ['credits', 'cost', 'total_credits', 'totalCredits']) {
      if (typeof value[key] === 'number') return value[key]
    }
    for (const candidate of Object.values(value)) {
      const found = visit(candidate)
      if (found !== null) return found
    }
    return null
  }
  return visit(payload)
}

export async function checkHiggsfield() {
  try {
    await runCli(['account', 'status', '--json', '--no-color'], 8_000)
    return { ok: true, authenticated: true }
  }
  catch (error) {
    return { ok: false, authenticated: false, message: error.message }
  }
}

export async function preflight(projectId, rawConfig) {
  const { project, config, refs } = await prepare(projectId, rawConfig)
  const { stdout } = await runCli(buildHiggsfieldArgs('cost', config, refs), 180_000)
  const payload = parseCliJson(stdout)
  const credits = displayCredits(payload)
  if (credits === null) {
    throw new Error('Higgsfield did not return a credit estimate. Nothing was submitted; try the cost check again.')
  }
  const digest = configDigest(projectId, config, refs)
  const preflight = {
    token: randomUUID(),
    digest,
    createdAt: new Date().toISOString(),
    credits,
    config,
    refs,
  }
  project.preflight = preflight
  await saveProject(project)
  return {
    token: preflight.token,
    credits: preflight.credits,
    model: config.model,
    duration: config.duration,
    resolution: config.resolution,
    aspectRatio: config.aspectRatio,
  }
}

export async function startGeneration(projectId, rawConfig, token, confirmed) {
  if (!confirmed) throw new Error('Generation confirmation is required.')
  const { project, config, refs } = await prepare(projectId, rawConfig)
  const digest = configDigest(projectId, config, refs)
  if (!project.preflight || project.preflight.token !== token || project.preflight.digest !== digest) {
    throw new Error('The storyboard or render settings changed. Run the cost preview again.')
  }

  const run = {
    id: `run-${randomUUID()}`,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
    resultUrls: [],
    error: null,
  }
  project.runs = [...(project.runs ?? []), run]
  delete project.preflight
  await saveProject(project)

  void executeGeneration(project.id, run.id, config, refs)
  return run
}

async function executeGeneration(projectId, runId, config, refs) {
  try {
    await updateRun(projectId, runId, { status: 'running' })
    const { stdout } = await runCli(buildHiggsfieldArgs('create', config, refs), 35 * 60_000)
    const payload = parseCliJson(stdout)
    const resultUrls = findMediaUrls(payload)
    await updateRun(projectId, runId, {
      status: 'completed',
      resultUrls,
      message: resultUrls.length ? null : 'Generation completed, but no direct video URL was returned.',
    })
  }
  catch (error) {
    await updateRun(projectId, runId, { status: 'failed', error: error.message })
  }
}

async function updateRun(projectId, runId, patch) {
  const project = await loadProject(projectId)
  const run = project.runs?.find((candidate) => candidate.id === runId)
  if (!run) return
  Object.assign(run, patch, { updatedAt: new Date().toISOString() })
  await saveProject(project)
}
