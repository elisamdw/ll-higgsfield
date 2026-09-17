import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { Readable, Writable } from 'node:stream'

class CapturedResponse extends Writable {
  constructor() {
    super()
    this.status = null
    this.headers = {}
    this.chunks = []
  }

  writeHead(status, headers) {
    this.status = status
    this.headers = headers
    return this
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk))
    callback()
  }

  text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  json() {
    return JSON.parse(this.text())
  }
}

async function dispatch(handler, method, url, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  request.method = method
  request.url = url
  const response = new CapturedResponse()
  await handler(request, response)
  if (!response.writableFinished) await once(response, 'finish')
  return response
}

test('mock mode serves a complete reorderable storyboard locally', async (t) => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'storyboard-relay-'))
  process.env.STORYBOARD_DATA_DIR = dataDirectory
  process.env.STORYBOARD_MOCK = '1'

  const { handleRequest } = await import(`../server.mjs?test=${Date.now()}`)

  t.after(async () => {
    await rm(dataDirectory, { recursive: true, force: true })
    delete process.env.STORYBOARD_DATA_DIR
    delete process.env.STORYBOARD_MOCK
  })

  const healthResponse = await dispatch(handleRequest, 'GET', '/api/health')
  const health = healthResponse.json()
  assert.equal(healthResponse.status, 200)
  assert.equal(health.ok, true)
  assert.equal(health.mockMode, true)
  assert.equal(health.storyboardModel, 'nano_banana_2')
  assert.equal('geminiConfigured' in health, false)
  assert.ok(health.models.seedance_2_0)

  const page = await dispatch(handleRequest, 'GET', '/')
  assert.equal(page.status, 200)
  assert.match(page.text(), /Storyboard Relay/)
  assert.match(page.headers['content-security-policy'], /default-src 'self'/)

  const response = await dispatch(handleRequest, 'POST', '/api/storyboards', {
    concept: 'An astronomer discovers herself inside the planet she observes.',
    style: 'Cinematic cobalt night photography',
    shotCount: 3,
    aspectRatio: '16:9',
  })
  assert.equal(response.status, 201)
  const payload = response.json()
  assert.equal(payload.project.frames.length, 3)
  assert.ok(payload.project.frames.every((frame) => frame.status === 'ready'))
  assert.ok(payload.project.frames.every((frame) => frame.mimeType === 'image/svg+xml'))
  assert.ok(payload.project.frames.every((frame) => frame.url.endsWith('.svg')))
  assert.ok(payload.project.frames.every((frame) => !('localPath' in frame)))

  const media = await dispatch(handleRequest, 'GET', payload.project.frames[0].url)
  assert.equal(media.status, 200)
  assert.match(media.headers['content-type'], /^image\/svg\+xml/)
  assert.match(media.text(), /^<svg/)
})
