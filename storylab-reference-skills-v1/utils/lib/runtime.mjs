import {readFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {providers, imageResults, textResult} from './providers.mjs';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export function loadConfig(o = {}, environment = process.env, owner = REPO_ROOT) {
  const explicit = o['env-file'] || environment.AI_LAB_ENV_FILE;
  const root = resolve(o['project-root'] || environment.AI_LAB_CONTEXT_REPO_ROOT || owner);
  const file = explicit ? resolve(explicit) : join(root, '.env');
  if (explicit && !existsSync(file)) throw new Error(`Environment file not found: ${file}`);
  const local = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return {file, root, env: {...local, ...environment}};
}

export function scrub(value, env = {}) {
  const keys = Object.values(providers).map(p => env[p.key]).filter(Boolean);
  const visit = (v, field = '') => {
    if (typeof v === 'string') {
      if (v.startsWith('data:') || ['b64_json', 'data'].includes(field) && v.length > 100) return '[image bytes omitted]';
      return keys.reduce((text, key) => text.split(key).join('[REDACTED]'), v);
    }
    if (Array.isArray(v)) return v.map(x => visit(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(authorization|api[-_]?key|x-api-key|FAL_API_KEY)$/i.test(k) ? '[REDACTED]' : visit(x, k)]));
    return v;
  };
  return visit(value);
}

export function saveJson(file, value, env = {}) { writeFileSync(file, JSON.stringify(scrub(value, env), null, 2) + '\n', {flag: 'wx', mode: 0o600}); }

export async function requestJson(url, init, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, {...init, redirect: 'error'}); }
  catch { throw new Error('Network request failed or timed out; no generation was automatically resubmitted.'); }
  if (!response.ok) throw new Error(`API HTTP ${response.status}. Check the selected provider, model, credentials, and request parameters. No automatic resubmission.`);
  let result;
  try { result = await response.json(); } catch { throw new Error('API response was not JSON.'); }
  if (result.error) throw new Error('Provider reported an error in its response. No automatic resubmission.');
  return result;
}

function queueUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://queue.fal.run' || url.username || url.password) throw new Error('Invalid fal queue receipt URL.');
  return url.href;
}

export async function falResult(receipt, headers, deps = {}) {
  const {fetcher = fetch, signal, sleep = ms => new Promise(done => setTimeout(done, ms))} = deps;
  const statusUrl = queueUrl(receipt.status_url), resultUrl = queueUrl(receipt.response_url);
  for (;;) {
    signal?.throwIfAborted();
    const status = await requestJson(statusUrl, {headers, signal}, fetcher);
    if (status.status === 'COMPLETED') return requestJson(resultUrl, {headers, signal}, fetcher);
    if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status.status)) throw new Error('Unexpected fal queue state; resume from the saved receipt after checking it.');
    await sleep(1500);
  }
}

function imageFormat(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  const beginning = bytes.subarray(0, 512).toString().trim();
  if (beginning.startsWith('<svg') || beginning.startsWith('<?xml') && beginning.includes('<svg')) return 'svg';
  throw new Error('Returned image format is not PNG, JPEG, WebP, or SVG. The response record was retained.');
}

export async function saveResult(kind, result, out, env, deps = {}) {
  saveJson(join(out, 'response.json'), result, env);
  const text = textResult(result);
  if (text) writeFileSync(join(out, 'text.md'), text + '\n', {flag: 'wx', mode: 0o600});
  if (kind === 'text') {
    if (!text.trim()) throw new Error('Provider returned no usable text; inspect response.json for refusal, filtering, or token exhaustion.');
    return {text, images: []};
  }
  const images = imageResults(result), saved = [];
  if (!images.length) throw new Error('Provider returned no images; inspect response.json for filtering, a text-only reply, or model incompatibility.');
  for (const [i, image] of images.entries()) {
    let bytes;
    if (image.b64_json) bytes = Buffer.from(image.b64_json, 'base64');
    else if (image.url?.startsWith('data:')) bytes = Buffer.from(image.url.slice(image.url.indexOf(',') + 1), 'base64');
    else if (image.url) {
      const url = new URL(image.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Image downloads require an HTTPS URL without credentials.');
      // Never attach provider credentials to CDN downloads.
      const download = await (deps.fetcher || fetch)(url.href, {redirect: 'error', signal: deps.signal});
      if (!download.ok) throw new Error(`Image download failed (HTTP ${download.status}); response.json retains its URL.`);
      bytes = Buffer.from(await download.arrayBuffer());
    } else throw new Error('An image result contained no bytes or URL.');
    const file = join(out, `image-${String(i + 1).padStart(2, '0')}.${imageFormat(bytes)}`);
    writeFileSync(file, bytes, {flag: 'wx', mode: 0o600}); saved.push(file);
  }
  return {text, images: saved};
}

export async function execute(kind, request, config, out, o = {}, deps = {}) {
  const p = providers[request.provider], key = config.env[p.key];
  if (!key) throw new Error(`Missing ${p.key}; set it in ${config.file} or the process environment.`);
  // Reserve a new run directory before any billable request; never overwrite a run.
  mkdirSync(resolve(out, '..'), {recursive: true});
  mkdirSync(out, {mode: 0o700});
  const headers = {[p.header]: (p.prefix || '') + key, 'Content-Type': 'application/json'};
  const signal = AbortSignal.timeout(o.timeout || 600_000);
  const record = {kind, created: new Date().toISOString(), ...request, references: o.references || []};
  saveJson(join(out, 'request.json'), record, config.env);
  const fetcher = deps.fetcher || fetch;
  let result;
  if (o.receipt) {
    saveJson(join(out, 'fal-request.json'), o.receipt, config.env);
    result = await falResult(o.receipt, headers, {...deps, signal});
  } else {
    result = await requestJson(request.url, {method: 'POST', headers, body: JSON.stringify(request.body), signal}, fetcher);
    if (request.provider === 'fal') {
      const receipt = {...result, kind, model: request.model};
      saveJson(join(out, 'fal-request.json'), receipt, config.env);
      (deps.progress || console.error)(`fal request ${receipt.request_id}; receipt: ${join(out, 'fal-request.json')}`);
      result = await falResult(receipt, headers, {...deps, signal});
    }
  }
  return saveResult(kind, result, out, config.env, {...deps, signal});
}
