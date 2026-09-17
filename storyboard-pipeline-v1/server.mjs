import { createReadStream, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MODEL_PROFILES, validateFrameEdit, validateStoryboardRequest } from './lib/core.mjs'
import { SHOT_LIBRARY, createTemplatePlan, makeMockFrame } from './lib/storyboard.mjs'
import {
  checkHiggsfield,
  generateStoryboardFrame,
  preflight,
  renderStoryboardFrames,
  startGeneration,
} from './lib/higgsfield.mjs'
import {
  createProject,
  findRun,
  listProjects,
  loadProject,
  mediaStat,
  saveProject,
} from './lib/store.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(ROOT, 'public')
const MAX_BODY_BYTES = 1_000_000

async function loadDotEnv() {
  const file = path.join(ROOT, '.env')
  if (!existsSync(file)) return
  const content = await readFile(file, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' https: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, securityHeaders())
  response.end(JSON.stringify(body))
}

function publicError(error) {
  const message = String(error?.message || 'Unexpected error.').slice(0, 1_000)
  const status = error instanceof SyntaxError
    ? 400
    : /too large/i.test(message)
    ? 413
    : /not found/i.test(message)
      ? 404
      : /invalid|must|required|unsupported|changed/i.test(message)
        ? 400
        : 500
  return { status, body: { ok: false, error: message } }
}

function publicProject(project) {
  const { preflight: _preflight, ...safeProject } = project
  return {
    ...safeProject,
    frames: (project.frames ?? []).map(({ localPath: _localPath, uploadRef: _uploadRef, ...frame }) => frame),
  }
}

async function readJson(request) {
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function staticContentType(file) {
  const extension = path.extname(file).toLowerCase()
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  }[extension] || 'application/octet-stream'
}

async function serveStatic(response, relativePath) {
  const target = path.resolve(PUBLIC_DIR, relativePath)
  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    sendJson(response, 403, { ok: false, error: 'Forbidden.' })
    return
  }
  try {
    const content = await readFile(target)
    response.writeHead(200, {
      ...securityHeaders(staticContentType(target)),
      'cache-control': target.endsWith('.html') ? 'no-store' : 'public, max-age=300',
    })
    response.end(content)
  }
  catch {
    sendJson(response, 404, { ok: false, error: 'Not found.' })
  }
}

async function createStoryboard(body) {
  const input = validateStoryboardRequest(body)
  const mock = process.env.STORYBOARD_MOCK === '1'
  const plan = createTemplatePlan(input)
  let project = await createProject({
    ...input,
    ...plan,
    mode: mock ? 'mock' : 'real',
    frames: plan.shots.map((shot) => ({ ...shot, status: 'pending' })),
  })

  if (mock) {
    for (const frame of project.frames) {
      Object.assign(frame, await makeMockFrame(project, frame), { status: 'ready' })
    }
    project = await saveProject(project)
  }
  else {
    project = await renderStoryboardFrames(project, async () => {
      project = await saveProject(project)
    })
    project = await saveProject(project)
  }
  return project
}

async function editFrame(projectId, frameId, body) {
  const updates = validateFrameEdit(body)
  const project = await loadProject(projectId)
  const frame = project.frames.find((candidate) => candidate.id === frameId)
  if (!frame) throw new Error('Frame not found.')
  Object.assign(frame, updates)
  return saveProject(project)
}

async function regenerateFrame(projectId, frameId, body) {
  let project = await loadProject(projectId)
  const frame = project.frames.find((candidate) => candidate.id === frameId)
  if (!frame) throw new Error('Frame not found.')
  const note = String(body.note ?? '').trim().slice(0, 800)
  if (note) frame.imagePrompt = `${frame.imagePrompt}\nRevision request: ${note}`
  frame.status = 'generating'
  delete frame.uploadRef
  project = await saveProject(project)

  const continuity = frame.position === 1 ? null : project.frames[0]
  const media = process.env.STORYBOARD_MOCK === '1'
    ? await makeMockFrame(project, frame)
    : await generateStoryboardFrame(project, frame, continuity)
  Object.assign(frame, media, { status: 'ready' })
  return saveProject(project)
}

export async function handleRequest(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1')
  const pathname = decodeURIComponent(url.pathname)

  try {
    if (request.method === 'GET' && pathname === '/api/health') {
      sendJson(response, 200, {
        ok: true,
        higgsfieldInstalled: existsSync('/opt/homebrew/bin/higgsfield') || existsSync('/usr/local/bin/higgsfield'),
        mockMode: process.env.STORYBOARD_MOCK === '1',
        storyboardModel: process.env.HIGGSFIELD_STORYBOARD_MODEL || 'nano_banana_2',
        models: MODEL_PROFILES,
        steps: SHOT_LIBRARY.map(({ key, title, beat }) => ({ key, title, beat })),
      })
      return
    }

    if (request.method === 'POST' && pathname === '/api/health/higgsfield') {
      sendJson(response, 200, await checkHiggsfield())
      return
    }

    if (request.method === 'GET' && pathname === '/api/history') {
      sendJson(response, 200, { ok: true, projects: await listProjects() })
      return
    }

    if (request.method === 'POST' && pathname === '/api/storyboards') {
      const project = await createStoryboard(await readJson(request))
      sendJson(response, 201, { ok: true, project: publicProject(project) })
      return
    }

    const projectMatch = pathname.match(/^\/api\/storyboards\/([a-z0-9-]+)$/)
    if (request.method === 'GET' && projectMatch) {
      sendJson(response, 200, { ok: true, project: publicProject(await loadProject(projectMatch[1])) })
      return
    }

    const regenerateMatch = pathname.match(/^\/api\/storyboards\/([a-z0-9-]+)\/frames\/(frame-[a-z0-9-]+)\/regenerate$/)
    if (request.method === 'POST' && regenerateMatch) {
      const project = await regenerateFrame(regenerateMatch[1], regenerateMatch[2], await readJson(request))
      sendJson(response, 200, { ok: true, project: publicProject(project) })
      return
    }

    const editMatch = pathname.match(/^\/api\/storyboards\/([a-z0-9-]+)\/frames\/(frame-[a-z0-9-]+)$/)
    if (request.method === 'PATCH' && editMatch) {
      const project = await editFrame(editMatch[1], editMatch[2], await readJson(request))
      sendJson(response, 200, { ok: true, project: publicProject(project) })
      return
    }

    const preflightMatch = pathname.match(/^\/api\/storyboards\/([a-z0-9-]+)\/preflight$/)
    if (request.method === 'POST' && preflightMatch) {
      const result = await preflight(preflightMatch[1], await readJson(request))
      sendJson(response, 200, { ok: true, preflight: result })
      return
    }

    const generateMatch = pathname.match(/^\/api\/storyboards\/([a-z0-9-]+)\/generate$/)
    if (request.method === 'POST' && generateMatch) {
      const body = await readJson(request)
      const run = await startGeneration(generateMatch[1], body.config, body.token, body.confirmed === true)
      sendJson(response, 202, { ok: true, run })
      return
    }

    const runMatch = pathname.match(/^\/api\/runs\/(run-[a-f0-9-]+)$/)
    if (request.method === 'GET' && runMatch) {
      const result = await findRun(runMatch[1])
      if (!result) throw new Error('Run not found.')
      sendJson(response, 200, { ok: true, run: result.run })
      return
    }

    const mediaMatch = pathname.match(/^\/media\/([a-z0-9-]+)\/(frames\/[a-z0-9.-]+)$/)
    if (request.method === 'GET' && mediaMatch) {
      const { target, stats } = await mediaStat(mediaMatch[1], mediaMatch[2])
      response.writeHead(200, {
        ...securityHeaders(staticContentType(target)),
        'content-length': stats.size,
        'cache-control': 'private, max-age=60',
      })
      createReadStream(target).pipe(response)
      return
    }

    if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      await serveStatic(response, 'index.html')
      return
    }
    if (request.method === 'GET' && /^\/(app\.js|styles\.css)$/.test(pathname)) {
      await serveStatic(response, pathname.slice(1))
      return
    }

    sendJson(response, 404, { ok: false, error: 'Not found.' })
  }
  catch (error) {
    const { status, body } = publicError(error)
    sendJson(response, status, body)
  }
}

export async function createAppServer() {
  await loadDotEnv()
  return createServer(handleRequest)
}

const launchedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (launchedDirectly) {
  const server = await createAppServer()
  const port = Number(process.env.PORT || 4177)
  server.listen(port, '127.0.0.1', () => {
    console.log(`Storyboard pipeline ready at http://127.0.0.1:${port}`)
  })
}
