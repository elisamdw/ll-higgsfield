import {existsSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {readJson} from './core.mjs';

const IMAGE_PATTERN = /^image-\d+\.(png|jpg|webp)$/;

export function attemptDirectories(itemDir) {
  if (!existsSync(itemDir)) return [];
  return readdirSync(itemDir, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))
    .map(entry => join(itemDir, entry.name))
    .sort();
}

export function findImage(itemDir) {
  for (const dir of attemptDirectories(itemDir)) {
    const name = readdirSync(dir).sort().find(file => IMAGE_PATTERN.test(file));
    if (name) return join(dir, name);
  }
  return undefined;
}

export function resumableReceipt(itemDir) {
  for (const dir of attemptDirectories(itemDir).reverse()) {
    const file = join(dir, 'fal-request.json');
    if (existsSync(file)) return readJson(file);
  }
  return undefined;
}

export function nextAttempt(itemDir) {
  return join(itemDir, `attempt-${String(attemptDirectories(itemDir).length + 1).padStart(3, '0')}`);
}
