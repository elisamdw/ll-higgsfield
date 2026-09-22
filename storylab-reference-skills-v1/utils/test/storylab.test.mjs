import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalJson, deriveSeed, hashFile} from '../storylab/lib/core.mjs';
import {createPlan, validateAnalysis} from '../storylab/lib/planner.mjs';
import {compilePrompt, renderPlan, validatePlan} from '../storylab/lib/renderer.mjs';
import {reviewPlan, VIOLATION_CODES} from '../storylab/lib/reviewer.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const responseJson = body => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
const analysis = {
  subject_summary: 'A courier in a cobalt rain shell.',
  locks: {
    defining_features: ['oval face', 'short black curls'],
    geometry_and_proportions: ['average height', 'narrow shoulders'],
    materials_and_texture: ['matte waterproof shell'],
    colors_and_markings: ['cobalt blue jacket', 'silver zipper'],
    clothing_and_accessories: ['black trousers', 'gray messenger bag'],
    scene_and_spatial_relationships: [],
  },
  negative_constraints: ['no hat', 'no logo'],
  continuity_risks: ['rear of bag is not specified'],
};

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'storylab-pack-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function analysisFile(dir) {
  const file = join(dir, 'analysis.json');
  writeFileSync(file, JSON.stringify(analysis));
  return file;
}

test('canonical JSON and derived view seeds are stable', () => {
  assert.equal(canonicalJson({z: 1, a: {d: 2, c: 3}}), '{"a":{"c":3,"d":2},"z":1}');
  assert.equal(deriveSeed(42, 'hero', 'front'), deriveSeed(42, 'hero', 'front'));
  assert.notEqual(deriveSeed(42, 'hero', 'front'), deriveSeed(42, 'hero', 'profile'));
  assert.equal(deriveSeed(42, 'hero', 'front'), 1308230416);
});

test('strict planner analysis rejects missing and extra fields', () => {
  assert.equal(validateAnalysis(analysis), analysis);
  assert.throws(() => validateAnalysis({...analysis, surprise: true}), /missing or extra/);
  assert.throws(() => validateAnalysis({...analysis, locks: {...analysis.locks, defining_features: [3]}}), /invalid/);
});

test('offline planning freezes a verifiable plan and render dry-run writes nothing', async t => {
  const dir = temporary(t), out = join(dir, 'pack');
  const result = await createPlan({kind: 'character', assetId: 'Hero Noa', masterSeed: 42, brief: 'Courier', references: [], out, analysisFile: analysisFile(dir)});
  assert.equal(result.plan.asset_id, 'hero-noa');
  assert.equal(result.plan.views.length, 6);
  assert.equal(validatePlan(JSON.parse(readFileSync(join(out, 'plan.json')))).plan_sha256, result.plan.plan_sha256);
  const dry = await renderPlan(join(out, 'plan.json'), {dryRun: true}, {fetcher: () => assert.fail('network in dry run')});
  assert.equal(dry.manifest.views.length, 6);
  assert.match(dry.prompts[0].prompt, /cobalt blue jacket/);
  assert.ok(!existsSync(join(out, 'render-manifest.json')));
});

test('OpenRouter planner uses strict schema and freezes its response', async t => {
  const dir = temporary(t), out = join(dir, 'pack');
  let calls = 0;
  const result = await createPlan({kind: 'prop', assetId: 'Radio', masterSeed: 7, brief: 'A field radio', references: [], out}, {
    env: {OPENROUTER_API_KEY: 'secret'},
    fetcher: async (url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(body.response_format.json_schema.strict, true);
      assert.equal(body.provider.require_parameters, true);
      return responseJson({choices: [{message: {content: JSON.stringify(analysis)}}]});
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.plan.planner_record.mode, 'openrouter');
  assert.ok(existsSync(join(out, 'planner/request.json')));
  assert.ok(!readFileSync(join(out, 'planner/request.json'), 'utf8').includes('secret'));
});

test('fal render creates six resumable views, provenance, and a local sheet without rerendering', async t => {
  const dir = temporary(t), out = join(dir, 'pack');
  await createPlan({kind: 'character', assetId: 'Noa', masterSeed: 42, brief: 'Courier', references: [], out, analysisFile: analysisFile(dir)});
  let submissions = 0, downloads = 0;
  const bodies = [];
  const fetcher = async (url, init = {}) => {
    if (url.startsWith('https://cdn.example/')) { downloads++; return new Response(png); }
    if (init.method === 'POST') {
      submissions++; bodies.push(JSON.parse(init.body));
      return responseJson({request_id: `request-${submissions}`, status_url: `https://queue.fal.run/status/${submissions}`, response_url: `https://queue.fal.run/result/${submissions}`});
    }
    if (url.includes('/status/')) return responseJson({status: 'COMPLETED'});
    if (url.includes('/result/')) return responseJson({images: [{url: `https://cdn.example/${url.split('/').at(-1)}.png`}]});
    assert.fail(`unexpected URL ${url}`);
  };
  const rendered = await renderPlan(join(out, 'plan.json'), {}, {env: {FAL_API_KEY: 'fal-secret'}, fetcher, progress: () => {}});
  assert.equal(submissions, 6);
  assert.equal(downloads, 6);
  assert.equal(bodies[0].seed, deriveSeed(42, 'noa', 'front-full'));
  assert.equal(bodies[0].image_urls, undefined);
  assert.equal(bodies[1].image_urls.length, 1);
  assert.ok(bodies[1].image_urls[0].startsWith('data:image/png;base64,'));
  assert.ok(existsSync(rendered.sheet));
  assert.equal(rendered.outputs.length, 6);
  assert.match(readFileSync(rendered.sheet, 'utf8'), /front-full/);
  const provenance = JSON.parse(readFileSync(join(out, 'provenance.json')));
  assert.equal(hashFile(join(out, provenance.outputs[0].image_path)), provenance.outputs[0].image_sha256);

  await renderPlan(join(out, 'plan.json'), {}, {env: {}, fetcher: () => assert.fail('completed pack rerendered'), progress: () => {}});
  assert.equal(submissions, 6);
});

test('OpenRouter review uses fixed violation codes and preserves a numbered audit', async t => {
  const dir = temporary(t), out = join(dir, 'pack');
  await createPlan({kind: 'character', assetId: 'Noa', masterSeed: 42, brief: 'Courier', references: [], out, analysisFile: analysisFile(dir)});
  let submission = 0;
  const falFetcher = async (url, init = {}) => {
    if (url.startsWith('https://cdn.example/')) return new Response(png);
    if (init.method === 'POST') {
      submission++;
      return responseJson({request_id: `r-${submission}`, status_url: `https://queue.fal.run/status/${submission}`, response_url: `https://queue.fal.run/result/${submission}`});
    }
    if (url.includes('/status/')) return responseJson({status: 'COMPLETED'});
    return responseJson({images: [{url: `https://cdn.example/${submission}.png`}]});
  };
  await renderPlan(join(out, 'plan.json'), {}, {env: {FAL_API_KEY: 'key'}, fetcher: falFetcher, progress: () => {}});
  const plan = JSON.parse(readFileSync(join(out, 'plan.json')));
  const audit = {summary: 'One camera mismatch.', views: plan.views.map((view, index) => ({view_id: view.id, status: index ? 'pass' : 'fail', violations: index ? [] : ['camera_mismatch'], notes: index ? '' : 'Not full body.'}))};
  const result = await reviewPlan(join(out, 'plan.json'), {}, {
    env: {OPENROUTER_API_KEY: 'router-secret'},
    fetcher: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.response_format.json_schema.strict, true);
      assert.deepEqual(body.response_format.json_schema.schema.properties.views.items.properties.violations.items.enum, VIOLATION_CODES);
      return responseJson({choices: [{message: {content: JSON.stringify(audit)}}]});
    },
  });
  assert.match(result.reviewDir, /review-001$/);
  assert.ok(existsSync(join(result.reviewDir, 'review.json')));
});

test('an interrupted fal view resumes its receipt into a new attempt without resubmission', async t => {
  const dir = temporary(t), out = join(dir, 'pack');
  await createPlan({kind: 'prop', assetId: 'radio', masterSeed: 9, brief: 'Radio', references: [], out, analysisFile: analysisFile(dir)});
  const firstAttempt = join(out, 'views/01-front/attempt-001');
  mkdirSync(firstAttempt, {recursive: true});
  writeFileSync(join(firstAttempt, 'fal-request.json'), JSON.stringify({
    kind: 'image', model: 'fal-ai/nano-banana-2', request_id: 'already-paid',
    status_url: 'https://queue.fal.run/status/already-paid', response_url: 'https://queue.fal.run/result/already-paid',
  }));
  let posts = 0;
  const fetcher = async (url, init = {}) => {
    if (url.startsWith('https://cdn.example/')) return new Response(png);
    if (init.method === 'POST') {
      posts++;
      return responseJson({request_id: `new-${posts}`, status_url: `https://queue.fal.run/status/new-${posts}`, response_url: `https://queue.fal.run/result/new-${posts}`});
    }
    if (url.includes('/status/')) return responseJson({status: 'COMPLETED'});
    return responseJson({images: [{url: `https://cdn.example/${url.split('/').at(-1)}.png`}]});
  };
  await renderPlan(join(out, 'plan.json'), {}, {env: {FAL_API_KEY: 'key'}, fetcher, progress: () => {}});
  assert.equal(posts, 5, 'only the five not-yet-submitted views should POST');
  assert.ok(existsSync(join(out, 'views/01-front/attempt-002/image-01.png')));
});

test('mutating a frozen plan is detected before rendering', async t => {
  const dir = temporary(t), out = join(dir, 'pack');
  await createPlan({kind: 'prop', assetId: 'radio', masterSeed: 1, brief: 'Radio', references: [], out, analysisFile: analysisFile(dir)});
  const planFile = join(out, 'plan.json');
  const plan = JSON.parse(readFileSync(planFile));
  plan.brief = 'Changed after approval';
  assert.throws(() => validatePlan(plan), /changed after planning/);
  assert.match(compilePrompt({...plan, brief: 'Radio'}, plan.views[0]), /Create one production prop reference image/);
});
