import {existsSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {providers, textResult} from '../../lib/providers.mjs';
import {loadConfig, requestJson, saveJson, scrub} from '../../lib/runtime.mjs';
import {STORYLAB_ROOT, assertWithin, canonicalJson, hashFile, nextNumberedFile, readImage, readJson, sha256, writeJsonExclusive} from './core.mjs';
import {validatePlan} from './renderer.mjs';

const MODELS = readJson(join(STORYLAB_ROOT, 'config/models.json'));

export const VIOLATION_CODES = [
  'identity_drift', 'geometry_drift', 'material_drift', 'color_drift',
  'wardrobe_drift', 'missing_detail', 'extra_detail', 'camera_mismatch',
  'composition_mismatch', 'spatial_continuity', 'text_or_watermark',
];

function reviewSchema(plan) {
  return {
    type: 'object', additionalProperties: false,
    required: ['summary', 'views'],
    properties: {
      summary: {type: 'string', minLength: 1, maxLength: 1200},
      views: {
        type: 'array', minItems: plan.views.length, maxItems: plan.views.length,
        items: {
          type: 'object', additionalProperties: false,
          required: ['view_id', 'status', 'violations', 'notes'],
          properties: {
            view_id: {type: 'string', enum: plan.views.map(view => view.id)},
            status: {type: 'string', enum: ['pass', 'fail']},
            violations: {type: 'array', uniqueItems: true, items: {type: 'string', enum: VIOLATION_CODES}},
            notes: {type: 'string', maxLength: 500},
          },
        },
      },
    },
  };
}

function validateReview(plan, review) {
  if (!review || typeof review.summary !== 'string' || !Array.isArray(review.views)) throw new Error('Reviewer result must contain summary and views.');
  if (review.views.length !== plan.views.length) throw new Error('Reviewer returned the wrong number of views.');
  const expected = new Set(plan.views.map(view => view.id));
  for (const item of review.views) {
    if (!item || Object.keys(item).sort().join('|') !== 'notes|status|view_id|violations') throw new Error('Reviewer returned missing or extra view fields.');
    if (!expected.delete(item.view_id)) throw new Error(`Reviewer returned an unknown or duplicate view_id: ${item.view_id}`);
    if (!['pass', 'fail'].includes(item.status) || !Array.isArray(item.violations) || item.violations.some(code => !VIOLATION_CODES.includes(code))) throw new Error(`Reviewer returned invalid status or violations for ${item.view_id}.`);
    if (item.status === 'pass' && item.violations.length) throw new Error(`Reviewer marked ${item.view_id} pass but supplied violations.`);
    if (item.status === 'fail' && !item.violations.length) throw new Error(`Reviewer marked ${item.view_id} fail without a violation code.`);
    if (typeof item.notes !== 'string' || item.notes.length > 500) throw new Error(`Reviewer returned invalid notes for ${item.view_id}.`);
  }
  if (expected.size) throw new Error('Reviewer omitted one or more planned views.');
  return review;
}

export function buildReviewRequest(plan, provenance, root, model) {
  const content = [{type: 'text', text: `Audit these generated ${plan.kind} views against the frozen continuity lock and their requested cameras. Images follow in the same order as the listed view ids: ${provenance.outputs.map(output => output.view_id).join(', ')}. Fail only concrete visible violations. Do not propose creative improvements.\n\nFrozen plan:\n${canonicalJson({brief: plan.brief, analysis: plan.analysis, views: plan.views})}`}];
  for (const output of provenance.outputs) content.push({type: 'image_url', image_url: {url: readImage(assertWithin(root, resolve(root, output.image_path))).url}});
  return {
    provider: 'openrouter', model,
    url: providers.openrouter.base + '/chat/completions',
    body: {
      model,
      messages: [
        {role: 'system', content: 'You are a strict visual continuity QA reviewer. Return only the requested JSON.'},
        {role: 'user', content},
      ],
      temperature: MODELS.reviewer.temperature,
      stream: false,
      provider: {require_parameters: true},
      response_format: {type: 'json_schema', json_schema: {name: 'storylab_continuity_review', strict: true, schema: reviewSchema(plan)}},
    },
  };
}

function validateProvenance(plan, provenance, root) {
  if (provenance.plan_sha256 !== plan.plan_sha256 || provenance.outputs?.length !== plan.views.length) throw new Error('provenance.json does not match the complete plan.');
  for (const output of provenance.outputs) {
    const file = assertWithin(root, resolve(root, output.image_path));
    if (!existsSync(file) || hashFile(file) !== output.image_sha256) throw new Error(`Rendered output changed or is missing: ${output.image_path}`);
  }
}

export async function reviewPlan(planFile, options = {}, deps = {}) {
  const absolutePlan = resolve(planFile), root = dirname(absolutePlan);
  const plan = validatePlan(readJson(absolutePlan));
  const provenanceFile = join(root, 'provenance.json');
  if (!existsSync(provenanceFile)) throw new Error('Render the complete plan before running review.');
  const provenance = readJson(provenanceFile);
  validateProvenance(plan, provenance, root);
  const model = options.reviewerModel || MODELS.reviewer.model;
  const request = buildReviewRequest(plan, provenance, root, model);
  if (options.dryRun) return scrub({operation: 'review', network: true, root, request});

  const config = loadConfig({'env-file': options.envFile, 'project-root': options.projectRoot}, deps.env || process.env);
  const key = config.env.OPENROUTER_API_KEY;
  if (!key) throw new Error(`Missing OPENROUTER_API_KEY; set it in ${config.file}.`);
  const reviewsDir = join(root, 'reviews');
  mkdirSync(reviewsDir, {recursive: true});
  const marker = nextNumberedFile(reviewsDir, 'review', '');
  const reviewDir = marker;
  mkdirSync(reviewDir);
  saveJson(join(reviewDir, 'request.json'), request, config.env);
  const result = await requestJson(request.url, {
    method: 'POST', headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
    body: JSON.stringify(request.body), signal: AbortSignal.timeout(options.timeout || 600_000),
  }, deps.fetcher || fetch);
  saveJson(join(reviewDir, 'response.json'), result, config.env);
  let review;
  try { review = validateReview(plan, JSON.parse(textResult(result))); }
  catch (error) { throw new Error(`OpenRouter did not return a valid continuity review: ${error.message}`); }
  const record = {plan_sha256: plan.plan_sha256, provider: 'openrouter', model, review, review_sha256: sha256(canonicalJson(review)), created_at: new Date().toISOString()};
  writeJsonExclusive(join(reviewDir, 'review.json'), record);
  return {reviewDir, record};
}
