import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = process.env.STORYBOARD_DATA_DIR
  ? path.resolve(process.env.STORYBOARD_DATA_DIR)
  : path.join(ROOT, 'data')
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,80}$/

const safeId = (value) => {
  const id = String(value ?? '')
  if (!ID_PATTERN.test(id)) throw new Error('Invalid project identifier.')
  return id
}

const projectDirectory = (projectId) => path.join(DATA_DIR, safeId(projectId))
const projectFile = (projectId) => path.join(projectDirectory(projectId), 'storyboard.json')

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

export async function createProject(seed) {
  const id = `${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`
  const project = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    frames: [],
    runs: [],
    ...seed,
  }
  await mkdir(path.join(projectDirectory(id), 'frames'), { recursive: true })
  await writeJsonAtomic(projectFile(id), project)
  return project
}

export async function loadProject(projectId) {
  const content = await readFile(projectFile(projectId), 'utf8')
  return JSON.parse(content)
}

export async function saveProject(project) {
  const next = { ...project, updatedAt: new Date().toISOString() }
  await writeJsonAtomic(projectFile(project.id), next)
  return next
}

export async function saveFrame(projectId, frameId, bytes, mimeType = 'image/png') {
  safeId(projectId)
  if (!/^frame-[a-z0-9-]+$/.test(frameId)) throw new Error('Invalid frame identifier.')
  const extensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
  }
  const extension = extensions[mimeType]
  if (!extension) throw new Error(`Unsupported frame media type: ${mimeType}.`)
  const filename = `${frameId}.${extension}`
  const file = path.join(projectDirectory(projectId), 'frames', filename)
  await writeFile(file, bytes, { mode: 0o600 })
  return {
    filename,
    localPath: file,
    url: `/media/${projectId}/frames/${filename}`,
    mimeType,
  }
}

export function resolveMediaPath(projectId, relativePath) {
  const base = projectDirectory(projectId)
  const target = path.resolve(base, relativePath)
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error('Invalid media path.')
  return target
}

export async function listProjects() {
  await mkdir(DATA_DIR, { recursive: true })
  const entries = await readdir(DATA_DIR, { withFileTypes: true })
  const projects = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
    try {
      const project = await loadProject(entry.name)
      projects.push({
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        frameCount: project.frames?.length ?? 0,
        latestRun: project.runs?.at(-1) ?? null,
      })
    }
    catch {
      // Ignore incomplete directories; they are never exposed as projects.
    }
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30)
}

export async function findRun(runId) {
  const projects = await listProjects()
  for (const summary of projects) {
    const project = await loadProject(summary.id)
    const run = project.runs?.find((candidate) => candidate.id === runId)
    if (run) return { project, run }
  }
  return null
}

export async function mediaStat(projectId, relativePath) {
  const target = resolveMediaPath(projectId, relativePath)
  return { target, stats: await stat(target) }
}
