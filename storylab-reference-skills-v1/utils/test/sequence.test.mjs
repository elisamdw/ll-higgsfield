import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createElement} from '../storylab/lib/elements.mjs';
import {deriveSeed} from '../storylab/lib/core.mjs';
import {createSequencePlan, validateSequenceAnalysis, validateSequencePlan} from '../storylab/lib/sequence-planner.mjs';
import {renderSequence} from '../storylab/lib/sequence-renderer.mjs';
import {reviewSequence, SEQUENCE_VIOLATION_CODES} from '../storylab/lib/sequence-reviewer.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const responseJson = body => new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
const elementAnalysis = {
  subject_summary: 'A long-haired thirty-year-old Renaissance natural philosopher.',
  locks: {
    defining_features: ['shoulder-length dark brown hair', 'straight nose'],
    geometry_and_proportions: ['slender build'],
    materials_and_texture: ['linen shirt', 'wool robe'],
    colors_and_markings: ['umber robe'],
    clothing_and_accessories: ['cream linen shirt', 'leather belt'],
    scene_and_spatial_relationships: [],
  },
  negative_constraints: ['no modern objects', 'no hat'],
  continuity_risks: ['rear robe fastening is unseen'],
};

function sequenceAnalysis(count) {
  return {
    summary: 'The scientist crosses the laboratory and examines a brass instrument.',
    style: 'Naturalistic Renaissance chamber drama, restrained earth palette.',
    time_and_lighting: 'Late afternoon; north-window key remains constant.',
    geography: 'Workbench center, window north, door west; screen direction remains left-to-right.',
    initial_state: {
      characters: ['scientist stands at the west door'],
      props: ['brass instrument rests on the central workbench'],
      environment: ['room is undisturbed'],
    },
    frames: Array.from({length: count}, (_, index) => ({
      frame_id: `frame-${String(index + 1).padStart(2, '0')}`,
      beat: ['He enters the laboratory.', 'He reaches the workbench.', 'He studies the instrument.'][index] || `Beat ${index + 1}`,
      action: ['walking east', 'extending right hand', 'holding instrument at eye level'][index] || 'continues the action',
      camera: {framing: 'medium wide', lens: '50mm equivalent', angle: 'eye level from the south wall', movement: 'locked camera'},
      emotional_state: 'focused curiosity',
      positions: [`scientist advances to position ${index + 1}`],
      prop_state: [index < 2 ? 'instrument remains on workbench' : 'instrument is held in his right hand'],
      environment_changes: [],
      allowed_delta: [`advance action to beat ${index + 1}`],
    })),
  };
}

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'storylab-sequence-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

async function setupElements(dir) {
  const library = join(dir, 'elements');
  const image = join(dir, 'reference.png');
  const analysisFile = join(dir, 'element-analysis.json');
  writeFileSync(image, png);
  writeFileSync(analysisFile, JSON.stringify(elementAnalysis));
  const character = await createElement({type: 'character', id: 'scientist', brief: 'Renaissance scientist', references: [image], analysisFile, library});
  const location = await createElement({type: 'location', id: 'lab', brief: 'Renaissance laboratory', references: [image], analysisFile, library});
  return {
    library,
    refs: [
      `scientist@${character.manifest.element_sha256}`,
      `lab@${location.manifest.element_sha256}`,
    ],
  };
}

async function setupSequence(t, count = 3) {
  const dir = temporary(t);
  const {library, refs} = await setupElements(dir);
  const analysisFile = join(dir, 'sequence-analysis.json');
  writeFileSync(analysisFile, JSON.stringify(sequenceAnalysis(count)));
  const out = join(dir, 'sequence');
  const result = await createSequencePlan({
    id: 'laboratory-discovery', masterSeed: 8128, frameCount: count,
    story: 'A scientist enters his laboratory and examines a brass instrument.',
    elements: refs, library, out, analysisFile,
  });
  return {dir, library, refs, out, result};
}

test('sequence planning enforces 2–8 exact frames, freezes Element hashes, and dry-run writes nothing', async t => {
  const dir = temporary(t);
  const {library, refs} = await setupElements(dir);
  const analysisFile = join(dir, 'sequence-analysis.json');
  writeFileSync(analysisFile, JSON.stringify(sequenceAnalysis(3)));
  const out = join(dir, 'sequence');
  const dry = await createSequencePlan({
    id: 'lab-scene', masterSeed: 10, frameCount: 3, story: 'Three connected beats.',
    elements: refs, library, out, analysisFile, dryRun: true,
  }, {fetcher: () => assert.fail('network in dry-run')});
  assert.equal(dry.operation, 'sequence plan');
  assert.equal(existsSync(out), false);
  assert.throws(() => validateSequenceAnalysis(sequenceAnalysis(1), 2), /exactly 2 frames/);
  await assert.rejects(() => createSequencePlan({id: 'too-long', masterSeed: 10, frameCount: 9, story: 'Too long.', elements: refs, library, out, analysisFile}), /2–8/);
  const made = await createSequencePlan({id: 'lab-scene', masterSeed: 10, frameCount: 3, story: 'Three connected beats.', elements: refs, library, out, analysisFile});
  assert.equal(made.plan.frames.length, 3);
  assert.equal(made.plan.elements.length, 2);
  assert.equal(made.plan.reference_policy.master_images.length, 2);
  assert.equal(validateSequencePlan(JSON.parse(readFileSync(join(out, 'plan.json')))).plan_sha256, made.plan.plan_sha256);
  const mutated = JSON.parse(readFileSync(join(out, 'plan.json')));
  mutated.style = 'changed';
  assert.throws(() => validateSequencePlan(mutated), /changed after planning/);
});

test('sequential render applies master, first-frame, and previous-frame anchors deterministically', async t => {
  const {out} = await setupSequence(t, 3);
  let submissions = 0;
  const bodies = [];
  const fetcher = async (url, init = {}) => {
    if (url.startsWith('https://cdn.example/')) return new Response(png);
    if (init.method === 'POST') {
      submissions++;
      bodies.push(JSON.parse(init.body));
      return responseJson({request_id: `r-${submissions}`, status_url: `https://queue.fal.run/status/${submissions}`, response_url: `https://queue.fal.run/result/${submissions}`});
    }
    if (url.includes('/status/')) return responseJson({status: 'COMPLETED'});
    return responseJson({images: [{url: `https://cdn.example/${url.split('/').at(-1)}.png`}]});
  };
  const rendered = await renderSequence(join(out, 'plan.json'), {}, {env: {FAL_API_KEY: 'key'}, fetcher, progress: () => {}});
  assert.equal(submissions, 3);
  assert.deepEqual(bodies.map(body => body.image_urls.length), [2, 3, 4]);
  assert.equal(bodies[0].seed, deriveSeed(8128, 'laboratory-discovery', 'frame-01'));
  assert.ok(existsSync(rendered.sheet));
  assert.ok(existsSync(join(out, 'continuity-ledger.json')));
  assert.match(readFileSync(rendered.sheet, 'utf8'), /frame-03/);
  await renderSequence(join(out, 'plan.json'), {}, {env: {}, fetcher: () => assert.fail('completed sequence rerendered'), progress: () => {}});
  assert.equal(submissions, 3);
});

test('an interrupted sequence frame resumes its receipt without another POST', async t => {
  const {out} = await setupSequence(t, 2);
  const firstAttempt = join(out, 'frames/01-frame-01/attempt-001');
  mkdirSync(firstAttempt, {recursive: true});
  writeFileSync(join(firstAttempt, 'fal-request.json'), JSON.stringify({
    kind: 'image', model: 'fal-ai/nano-banana-2/edit', request_id: 'already-paid',
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
  await renderSequence(join(out, 'plan.json'), {}, {env: {FAL_API_KEY: 'key'}, fetcher, progress: () => {}});
  assert.equal(posts, 1);
  assert.ok(existsSync(join(out, 'frames/01-frame-01/attempt-002/image-01.png')));
});

test('sequence review audits frames and transitions with fixed codes', async t => {
  const {out} = await setupSequence(t, 3);
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
  await renderSequence(join(out, 'plan.json'), {}, {env: {FAL_API_KEY: 'key'}, fetcher: falFetcher, progress: () => {}});
  const audit = {
    summary: 'One transition reverses screen direction.',
    frames: ['frame-01', 'frame-02', 'frame-03'].map(frame_id => ({frame_id, status: 'pass', violations: [], notes: ''})),
    transitions: [
      {transition_id: 'frame-01->frame-02', status: 'fail', violations: ['screen_direction_error'], notes: 'Travel direction reverses.'},
      {transition_id: 'frame-02->frame-03', status: 'pass', violations: [], notes: ''},
    ],
  };
  const reviewed = await reviewSequence(join(out, 'plan.json'), {}, {
    env: {OPENROUTER_API_KEY: 'router-key'},
    fetcher: async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.response_format.json_schema.strict, true);
      assert.deepEqual(body.response_format.json_schema.schema.properties.frames.items.properties.violations.items.enum, SEQUENCE_VIOLATION_CODES);
      return responseJson({choices: [{message: {content: JSON.stringify(audit)}}]});
    },
  });
  assert.match(reviewed.reviewDir, /review-001$/);
  assert.ok(existsSync(join(reviewed.reviewDir, 'review.json')));
});
