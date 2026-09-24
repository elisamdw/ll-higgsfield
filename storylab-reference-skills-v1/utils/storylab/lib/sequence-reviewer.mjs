import {existsSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {providers, textResult} from '../../lib/providers.mjs';
import {loadConfig, requestJson, saveJson, scrub} from '../../lib/runtime.mjs';
import {
  STORYLAB_ROOT, assertWithin, canonicalJson, hashFile, nextNumberedFile, readImage, readJson, sha256, writeJsonExclusive,
} from './core.mjs';
import {validateSequencePlan} from './sequence-planner.mjs';

const MODELS = readJson(join(STORYLAB_ROOT, 'config/models.json'));

export const SEQUENCE_VIOLATION_CODES = [
  'element_drift', 'identity_drift', 'wardrobe_drift', 'prop_state_drift',
  'location_drift', 'screen_direction_error', 'lighting_discontinuity',
  'action_discontinuity', 'camera_mismatch', 'duplicate_frame', 'text_or_watermark',
];

function resultItem(idField, ids) {
  return {
    type: 'object', additionalProperties: false,
    required: [idField, 'status', 'violations', 'notes'],
    properties: {
      [idField]: {type: 'string', enum: ids},
      status: {type: 'string', enum: ['pass', 'fail']},
      violations: {type: 'array', uniqueItems: true, items: {type: 'string', enum: SEQUENCE_VIOLATION_CODES}},
      notes: {type: 'string', maxLength: 500},
    },
  };
}

export function sequenceReviewSchema(plan) {
  const ids = plan.frames.map(frame => frame.frame_id);
  const transitions = ids.slice(1).map((id, index) => `${ids[index]}->${id}`);
  return {
    type: 'object', additionalProperties: false,
    required: ['summary', 'frames', 'transitions'],
    properties: {
      summary: {type: 'string', minLength: 1, maxLength: 1200},
      frames: {type: 'array', minItems: ids.length, maxItems: ids.length, items: resultItem('frame_id', ids)},
      transitions: {type: 'array', minItems: transitions.length, maxItems: transitions.length, items: resultItem('transition_id', transitions)},
    },
  };
}

function validateItems(items, ids, idField, label) {
  if (!Array.isArray(items) || items.length !== ids.length) throw new Error(`Sequence reviewer returned the wrong number of ${label}.`);
  items.forEach((item, index) => {
    if (!item || Object.keys(item).sort().join('|') !== [idField, 'status', 'violations', 'notes'].sort().join('|')) throw new Error(`Sequence reviewer returned missing or extra ${label} fields.`);
    if (item[idField] !== ids[index]) throw new Error(`Sequence reviewer returned out-of-order ${label}: ${item[idField]}.`);
    if (!['pass', 'fail'].includes(item.status) || !Array.isArray(item.violations) || item.violations.some(code => !SEQUENCE_VIOLATION_CODES.includes(code))) throw new Error(`Sequence reviewer returned invalid status or violations for ${item[idField]}.`);
    if (new Set(item.violations).size !== item.violations.length) throw new Error(`Sequence reviewer duplicated a violation for ${item[idField]}.`);
    if (item.status === 'pass' && item.violations.length) throw new Error(`Sequence reviewer marked ${item[idField]} pass with violations.`);
    if (item.status === 'fail' && !item.violations.length) throw new Error(`Sequence reviewer marked ${item[idField]} fail without a violation.`);
    if (typeof item.notes !== 'string' || item.notes.length > 500) throw new Error(`Sequence reviewer returned invalid notes for ${item[idField]}.`);
  });
}

export function validateSequenceReview(plan, review) {
  if (!review || Object.keys(review).sort().join('|') !== 'frames|summary|transitions' || typeof review.summary !== 'string' || !review.summary.trim()) throw new Error('Sequence reviewer result must contain only summary, frames, and transitions.');
  const ids = plan.frames.map(frame => frame.frame_id);
  const transitions = ids.slice(1).map((id, index) => `${ids[index]}->${id}`);
  validateItems(review.frames, ids, 'frame_id', 'frames');
  validateItems(review.transitions, transitions, 'transition_id', 'transitions');
  return review;
}

function validateProvenance(plan, provenance, root) {
  if (provenance.plan_sha256 !== plan.plan_sha256 || provenance.outputs?.length !== plan.frames.length) throw new Error('Sequence provenance does not match the complete plan.');
  for (const [index, output] of provenance.outputs.entries()) {
    if (output.frame_id !== plan.frames[index].frame_id) throw new Error('Sequence provenance frame order does not match the plan.');
    const file = assertWithin(root, resolve(root, output.image_path));
    if (!existsSync(file) || hashFile(file) !== output.image_sha256) throw new Error(`Rendered frame changed or is missing: ${output.image_path}`);
  }
}

export function buildSequenceReviewRequest(plan, provenance, root, model) {
  const content = [{
    type: 'text',
    text: `Audit this complete storyboard twice: first each frame against its requested beat and frozen Elements, then every adjacent transition for continuity. Images follow in frame order: ${provenance.outputs.map(output => output.frame_id).join(', ')}. Use only the fixed violation codes. Fail only concrete visible problems; do not suggest creative improvements.\n\nFrozen sequence:\n${canonicalJson({elements: plan.elements, style: plan.style, time_and_lighting: plan.time_and_lighting, geography: plan.geography, initial_state: plan.initial_state, frames: plan.frames})}`,
  }];
  for (const output of provenance.outputs) content.push({type: 'image_url', image_url: {url: readImage(assertWithin(root, resolve(root, output.image_path))).url}});
  return {
    provider: 'openrouter', model,
    url: providers.openrouter.base + '/chat/completions',
    body: {
      model,
      messages: [
        {role: 'system', content: 'You are a strict storyboard continuity QA reviewer. Return only the requested JSON.'},
        {role: 'user', content},
      ],
      temperature: MODELS.reviewer.temperature,
      stream: false,
      provider: {require_parameters: true},
      response_format: {type: 'json_schema', json_schema: {name: 'storylab_sequence_review', strict: true, schema: sequenceReviewSchema(plan)}},
    },
  };
}

export async function reviewSequence(planFile, options = {}, deps = {}) {
  const absolutePlan = resolve(planFile), root = dirname(absolutePlan);
  const plan = validateSequencePlan(readJson(absolutePlan));
  const provenanceFile = join(root, 'provenance.json');
  if (!existsSync(provenanceFile)) throw new Error('Render the complete sequence before review.');
  const provenance = readJson(provenanceFile);
  validateProvenance(plan, provenance, root);
  const model = options.reviewerModel || MODELS.reviewer.model;
  const request = buildSequenceReviewRequest(plan, provenance, root, model);
  if (options.dryRun) return scrub({operation: 'sequence review', network: true, root, request});
  const config = loadConfig({'env-file': options.envFile, 'project-root': options.projectRoot}, deps.env || process.env);
  if (!config.env.OPENROUTER_API_KEY) throw new Error(`Missing OPENROUTER_API_KEY; set it in ${config.file}.`);
  const reviewsDir = join(root, 'reviews');
  mkdirSync(reviewsDir, {recursive: true});
  const reviewDir = nextNumberedFile(reviewsDir, 'review', '');
  mkdirSync(reviewDir);
  saveJson(join(reviewDir, 'request.json'), request, config.env);
  const result = await requestJson(request.url, {
    method: 'POST', headers: {Authorization: `Bearer ${config.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(request.body), signal: AbortSignal.timeout(options.timeout || 600_000),
  }, deps.fetcher || fetch);
  saveJson(join(reviewDir, 'response.json'), result, config.env);
  let review;
  try { review = validateSequenceReview(plan, JSON.parse(textResult(result))); }
  catch (error) { throw new Error(`OpenRouter did not return a valid sequence review: ${error.message}`); }
  const record = {
    plan_sha256: plan.plan_sha256, provider: 'openrouter', model, review,
    review_sha256: sha256(canonicalJson(review)), created_at: new Date().toISOString(),
  };
  writeJsonExclusive(join(reviewDir, 'review.json'), record);
  return {reviewDir, record};
}
