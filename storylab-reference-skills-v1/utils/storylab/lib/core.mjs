import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const STORYLAB_ROOT = fileURLToPath(new URL('../', import.meta.url));
export const UTILS_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PROMPT_COMPILER_VERSION = 'storylab-prompt-v1';

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function hashFile(file) {
  return sha256(readFileSync(file));
}

export function deriveSeed(masterSeed, assetId, viewId, attempt = 0) {
  const digest = sha256(`${masterSeed}\0${assetId}\0${viewId}\0${attempt}`);
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
}

export function slug(value) {
  const result = String(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!result) throw new Error('The asset id must contain a letter or number.');
  return result;
}

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJsonExclusive(file, value, mode = 0o600) {
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx', mode});
}

export function ensureDirectoryExclusive(dir) {
  mkdirSync(dirname(dir), {recursive: true});
  mkdirSync(dir, {mode: 0o700});
}

const IMAGE_MIMES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'};

export function readImage(file) {
  const absolute = resolve(file);
  const mime = IMAGE_MIMES[extname(absolute).toLowerCase()];
  if (!mime) throw new Error(`Reference images must be PNG, JPEG, or WebP: ${file}`);
  const data = readFileSync(absolute);
  if (!data.length || data.length > 50 * 1024 * 1024) throw new Error(`Reference images must be nonempty and at most 50 MB: ${file}`);
  return {absolute, mime, data, hash: sha256(data), url: `data:${mime};base64,${data.toString('base64')}`};
}

export function stageReferences(files, out) {
  if (files.length > 8) throw new Error('At most 8 source references are accepted so the generated anchor can remain within model reference limits.');
  const source = join(out, 'source');
  mkdirSync(source);
  return files.map((file, index) => {
    const image = readImage(file);
    const extension = extname(image.absolute).toLowerCase() === '.jpeg' ? '.jpg' : extname(image.absolute).toLowerCase();
    const name = `ref-${String(index + 1).padStart(2, '0')}${extension}`;
    const target = join(source, name);
    copyFileSync(image.absolute, target, 0);
    return {path: `source/${name}`, sha256: image.hash, mime: image.mime, original_name: basename(image.absolute)};
  });
}

export function loadStagedReferences(planFile, plan) {
  const root = dirname(resolve(planFile));
  return plan.references.map(reference => {
    const absolute = resolve(root, reference.path);
    if (!absolute.startsWith(root + '/') || !existsSync(absolute)) throw new Error(`Missing staged reference: ${reference.path}`);
    const image = readImage(absolute);
    if (image.hash !== reference.sha256) throw new Error(`Reference hash changed: ${reference.path}`);
    return image;
  });
}

export function nextNumberedFile(dir, stem, extension = '.json') {
  for (let i = 1; i <= 999; i++) {
    const file = join(dir, `${stem}-${String(i).padStart(3, '0')}${extension}`);
    if (!existsSync(file)) return file;
  }
  throw new Error(`Too many ${stem} files in ${dir}.`);
}

export function assertWithin(root, target) {
  const a = resolve(root), b = resolve(target);
  if (b !== a && !b.startsWith(a + '/')) throw new Error(`Path escapes pack directory: ${target}`);
  return b;
}

