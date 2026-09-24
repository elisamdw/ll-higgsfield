import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createElement, importPack, listElements, resolveElement, verifyElement} from '../storylab/lib/elements.mjs';
import {createPlan} from '../storylab/lib/planner.mjs';
import {renderPlan} from '../storylab/lib/renderer.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const responseJson = body => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
const analysis = {
  subject_summary: 'A vaulted Renaissance laboratory with a north window.',
  locks: {
    defining_features: ['ribbed stone vault', 'central walnut workbench'],
    geometry_and_proportions: ['long rectangular room'],
    materials_and_texture: ['warm limestone', 'dark walnut'],
    colors_and_markings: ['ochre stone', 'verdigris instruments'],
    clothing_and_accessories: [],
    scene_and_spatial_relationships: ['north window behind the workbench'],
  },
  negative_constraints: ['no modern fixtures'],
  continuity_risks: ['south wall is not visible'],
};

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'storylab-elements-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function fixtures(dir) {
  const image = join(dir, 'reference.png');
  const analysisFile = join(dir, 'analysis.json');
  writeFileSync(image, png);
  writeFileSync(analysisFile, JSON.stringify(analysis));
  return {image, analysisFile};
}

test('Element creation is content-addressed, idempotent, indexed, and verifiable', async t => {
  const dir = temporary(t), library = join(dir, 'elements');
  const {image, analysisFile} = fixtures(dir);
  const options = {type: 'location', id: 'North Lab', brief: 'Renaissance laboratory', references: [image], analysisFile, library};
  const first = await createElement(options);
  const second = await createElement(options);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.manifest.element_sha256, second.manifest.element_sha256);
  assert.equal(resolveElement('north-lab', {library}).manifest.element_sha256, first.manifest.element_sha256);
  assert.equal(verifyElement(`north-lab@${first.manifest.element_sha256.slice(0, 12)}`, {library}).verified, true);
  const index = listElements({library});
  assert.equal(index.elements.length, 1);
  assert.ok(existsSync(join(library, 'index.json')));
});

test('ambiguous Element ids require a version hash and tampering is detected', async t => {
  const dir = temporary(t), library = join(dir, 'elements');
  const {image, analysisFile} = fixtures(dir);
  const first = await createElement({type: 'location', id: 'lab', brief: 'Version one', references: [image], analysisFile, library});
  await createElement({type: 'location', id: 'lab', brief: 'Version two', references: [image], analysisFile, library});
  assert.throws(() => resolveElement('lab', {library}), /has 2 versions/);
  const file = join(first.versionDir, first.manifest.references[0].path);
  writeFileSync(file, Buffer.concat([png, Buffer.from('tampered')]));
  assert.throws(() => verifyElement(`lab@${first.manifest.element_sha256}`, {library}), /hash changed/);
});

test('Element dry-run has no network calls or writes', async t => {
  const dir = temporary(t), library = join(dir, 'elements');
  const {image} = fixtures(dir);
  const result = await createElement({type: 'location', id: 'lab', references: [image], library, dryRun: true}, {fetcher: () => assert.fail('network in dry-run')});
  assert.equal(result.operation, 'element create');
  assert.equal(result.network, true);
  assert.equal(existsSync(library), false);
});

test('a completed reference pack imports without another provider call', async t => {
  const dir = temporary(t), out = join(dir, 'pack'), library = join(dir, 'elements');
  const {analysisFile} = fixtures(dir);
  await createPlan({kind: 'character', assetId: 'scientist', masterSeed: 3, brief: 'Scientist', references: [], out, analysisFile});
  let submission = 0;
  const fetcher = async (url, init = {}) => {
    if (url.startsWith('https://cdn.example/')) return new Response(png);
    if (init.method === 'POST') {
      submission++;
      return responseJson({request_id: `r-${submission}`, status_url: `https://queue.fal.run/status/${submission}`, response_url: `https://queue.fal.run/result/${submission}`});
    }
    if (url.includes('/status/')) return responseJson({status: 'COMPLETED'});
    return responseJson({images: [{url: `https://cdn.example/${submission}.png`}]});
  };
  await renderPlan(join(out, 'plan.json'), {}, {env: {FAL_API_KEY: 'key'}, fetcher, progress: () => {}});
  const first = importPack(join(out, 'plan.json'), {library});
  const second = importPack(join(out, 'plan.json'), {library});
  assert.equal(first.manifest.references.length, 6);
  assert.equal(second.created, false);
  assert.equal(readFileSync(join(first.versionDir, 'element.json'), 'utf8').includes('scientist'), true);
});
