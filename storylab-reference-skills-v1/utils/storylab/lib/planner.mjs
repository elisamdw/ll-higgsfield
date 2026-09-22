import {mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {providers, textResult} from '../../lib/providers.mjs';
import {loadConfig, requestJson, saveJson, scrub} from '../../lib/runtime.mjs';
import {
  STORYLAB_ROOT, canonicalJson, ensureDirectoryExclusive, readImage, readJson,
  sha256, slug, stageReferences, writeJsonExclusive,
} from './core.mjs';

const MODELS = readJson(join(STORYLAB_ROOT, 'config/models.json'));
const VIEW_SETS = readJson(join(STORYLAB_ROOT, 'config/views.json'));
const KINDS = new Set(Object.keys(VIEW_SETS));

const stringArray = {type: 'array', items: {type: 'string', minLength: 1, maxLength: 240}, maxItems: 12};

export const analysisSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['subject_summary', 'locks', 'negative_constraints', 'continuity_risks'],
  properties: {
    subject_summary: {type: 'string', minLength: 1, maxLength: 1200},
    locks: {
      type: 'object', additionalProperties: false,
      required: ['defining_features', 'geometry_and_proportions', 'materials_and_texture', 'colors_and_markings', 'clothing_and_accessories', 'scene_and_spatial_relationships'],
      properties: {
        defining_features: stringArray,
        geometry_and_proportions: stringArray,
        materials_and_texture: stringArray,
        colors_and_markings: stringArray,
        clothing_and_accessories: stringArray,
        scene_and_spatial_relationships: stringArray,
      },
    },
    negative_constraints: stringArray,
    continuity_risks: stringArray,
  },
};

function assertStringArray(value, path) {
  if (!Array.isArray(value) || value.length > 12 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 240)) {
    throw new Error(`Planner result has an invalid ${path}; expected at most 12 nonempty strings.`);
  }
}

export function validateAnalysis(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Planner result must be a JSON object.');
  const expected = ['continuity_risks', 'locks', 'negative_constraints', 'subject_summary'];
  if (Object.keys(value).sort().join('|') !== expected.join('|')) throw new Error('Planner result has missing or extra top-level fields.');
  if (typeof value.subject_summary !== 'string' || !value.subject_summary.trim() || value.subject_summary.length > 1200) throw new Error('Planner result has an invalid subject_summary.');
  const lockKeys = ['clothing_and_accessories', 'colors_and_markings', 'defining_features', 'geometry_and_proportions', 'materials_and_texture', 'scene_and_spatial_relationships'];
  if (!value.locks || Object.keys(value.locks).sort().join('|') !== lockKeys.join('|')) throw new Error('Planner result has missing or extra lock fields.');
  for (const key of lockKeys) assertStringArray(value.locks[key], `locks.${key}`);
  assertStringArray(value.negative_constraints, 'negative_constraints');
  assertStringArray(value.continuity_risks, 'continuity_risks');
  return value;
}

function plannerPrompt({kind, assetId, brief, referenceCount}) {
  const focus = {
    character: 'identity, facial structure, body proportions, hair, wardrobe, accessories, and age',
    prop: 'silhouette, dimensions, construction, materials, labels, markings, wear, and functional parts',
    'shot-grid': 'characters, props, environment, blocking, screen direction, eyelines, lighting, time of day, and spatial geography',
  }[kind];
  return `Build a production continuity lock for a ${kind} reference pack.

Asset id: ${assetId}
Creator brief: ${brief || '(no additional brief; infer only visible facts from the reference image)'}
Reference images supplied: ${referenceCount}

Describe observable or explicitly requested facts, not aesthetic filler. Concentrate on ${focus}. Keep each lock atomic and usable in an image-generation prompt. Put uncertainties in continuity_risks instead of inventing facts. Negative constraints must identify changes that later views must not introduce. Empty arrays are allowed when a category is irrelevant.`;
}

export function buildPlannerRequest({kind, assetId, brief, refs, model = MODELS.planner.model}) {
  const content = [{type: 'text', text: plannerPrompt({kind, assetId, brief, referenceCount: refs.length})}];
  for (const ref of refs) content.push({type: 'image_url', image_url: {url: ref.url}});
  return {
    provider: 'openrouter', model,
    url: providers.openrouter.base + '/chat/completions',
    body: {
      model,
      messages: [
        {role: 'system', content: 'You are a visual continuity supervisor. Return only the requested strict JSON.'},
        {role: 'user', content},
      ],
      temperature: MODELS.planner.temperature,
      stream: false,
      provider: {require_parameters: true},
      response_format: {type: 'json_schema', json_schema: {name: 'storylab_continuity_lock', strict: true, schema: analysisSchema}},
    },
  };
}

function stableSpec({kind, assetId, brief, masterSeed, model, renderer, references, analysis}) {
  const viewSet = VIEW_SETS[kind];
  return {
    contract_version: MODELS.contract_version,
    kind,
    asset_id: assetId,
    brief,
    master_seed: masterSeed,
    references,
    analysis,
    planner: {provider: 'openrouter', model, strict_schema: 'storylab_continuity_lock'},
    renderer,
    aspect_ratio: viewSet.aspect_ratio,
    sheet_columns: viewSet.sheet_columns,
    views: viewSet.views,
  };
}

export async function createPlan(options, deps = {}) {
  const kind = options.kind;
  if (!KINDS.has(kind)) throw new Error(`Unknown pack kind: ${kind}. Choose character, prop, or shot-grid.`);
  const assetId = slug(options.assetId);
  const brief = String(options.brief || '').trim();
  const referenceFiles = options.references || [];
  if (!brief && !referenceFiles.length) throw new Error('Supply --brief, --brief-file, or at least one --ref image.');
  if (kind === 'shot-grid' && referenceFiles.length !== 1) throw new Error('shot-grid requires exactly one --ref source image.');
  const masterSeed = Number(options.masterSeed);
  if (!Number.isSafeInteger(masterSeed) || masterSeed < 0 || masterSeed > 0xffffffff) throw new Error('--seed must be an integer from 0 through 4294967295.');
  const model = options.plannerModel || MODELS.planner.model;
  const renderer = {
    ...MODELS.renderer,
    ...(options.rendererModel ? {text_endpoint: options.rendererModel} : {}),
    ...(options.rendererEditModel ? {edit_endpoint: options.rendererEditModel} : {}),
    ...(options.resolution ? {resolution: options.resolution} : {}),
  };
  const sourceRefs = referenceFiles.map(readImage);
  const plannerRequest = buildPlannerRequest({kind, assetId, brief, refs: sourceRefs, model});
  if (options.dryRun) {
    return scrub({operation: 'plan', network: !options.analysisFile, out: resolve(options.out), request: plannerRequest, input_hashes: sourceRefs.map(ref => ref.hash)});
  }

  let openrouterConfig;
  if (!options.analysisFile) {
    openrouterConfig = loadConfig({'env-file': options.envFile, 'project-root': options.projectRoot}, deps.env || process.env);
    if (!openrouterConfig.env.OPENROUTER_API_KEY) throw new Error(`Missing OPENROUTER_API_KEY; set it in ${openrouterConfig.file} or use --analysis-file with approved strict JSON.`);
  }

  const out = resolve(options.out);
  ensureDirectoryExclusive(out);
  const references = stageReferences(referenceFiles, out);
  const plannerDir = join(out, 'planner');
  mkdirSync(plannerDir);
  let analysis, plannerRecord;
  if (options.analysisFile) {
    analysis = validateAnalysis(readJson(resolve(options.analysisFile)));
    writeJsonExclusive(join(plannerDir, 'imported-analysis.json'), analysis);
    plannerRecord = {mode: 'imported', source_sha256: sha256(canonicalJson(analysis))};
  } else {
    const config = openrouterConfig;
    const key = config.env.OPENROUTER_API_KEY;
    saveJson(join(plannerDir, 'request.json'), {...plannerRequest, reference_hashes: references.map(ref => ref.sha256)}, config.env);
    const result = await requestJson(plannerRequest.url, {
      method: 'POST',
      headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(plannerRequest.body),
      signal: AbortSignal.timeout(options.timeout || 600_000),
    }, deps.fetcher || fetch);
    saveJson(join(plannerDir, 'response.json'), result, config.env);
    const text = textResult(result);
    try { analysis = validateAnalysis(JSON.parse(text)); }
    catch (error) { throw new Error(`OpenRouter did not return valid continuity JSON: ${error.message}`); }
    plannerRecord = {mode: 'openrouter', response_sha256: sha256(canonicalJson(result))};
  }
  const spec = stableSpec({kind, assetId, brief, masterSeed, model, renderer, references, analysis});
  const plan = {...spec, plan_sha256: sha256(canonicalJson(spec)), created_at: new Date().toISOString(), planner_record: plannerRecord};
  writeJsonExclusive(join(out, 'plan.json'), plan);
  return {out, plan};
}

export function defaultPlanOut(projectRoot, kind, assetId) {
  return join(resolve(projectRoot), 'output', 'storylab', `${kind}-${slug(assetId)}`);
}
