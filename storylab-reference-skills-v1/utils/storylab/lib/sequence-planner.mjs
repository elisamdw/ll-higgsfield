import {copyFileSync, existsSync, mkdirSync} from 'node:fs';
import {extname, join, resolve} from 'node:path';
import {providers, textResult} from '../../lib/providers.mjs';
import {loadConfig, requestJson, saveJson, scrub} from '../../lib/runtime.mjs';
import {
  STORYLAB_ROOT, canonicalJson, ensureDirectoryExclusive, readImage, readJson, sha256, slug, writeJsonExclusive,
} from './core.mjs';
import {verifyElement} from './elements.mjs';

const MODELS = readJson(join(STORYLAB_ROOT, 'config/models.json'));
export const SEQUENCE_CONFIG = readJson(join(STORYLAB_ROOT, 'config/sequence.json'));
const MAX_MASTERS = SEQUENCE_CONFIG.max_reference_images - SEQUENCE_CONFIG.reserved_anchor_images;
const str = (maxLength = 1200) => ({type: 'string', minLength: 1, maxLength});
const stringArray = {type: 'array', items: str(300), maxItems: 16};

function frameIds(count) {
  return Array.from({length: count}, (_, index) => `frame-${String(index + 1).padStart(2, '0')}`);
}

export function sequenceSchema(count) {
  const ids = frameIds(count);
  return {
    type: 'object', additionalProperties: false,
    required: ['summary', 'style', 'time_and_lighting', 'geography', 'initial_state', 'frames'],
    properties: {
      summary: str(), style: str(), time_and_lighting: str(), geography: str(),
      initial_state: {
        type: 'object', additionalProperties: false,
        required: ['characters', 'props', 'environment'],
        properties: {characters: stringArray, props: stringArray, environment: stringArray},
      },
      frames: {
        type: 'array', minItems: count, maxItems: count,
        items: {
          type: 'object', additionalProperties: false,
          required: ['frame_id', 'beat', 'action', 'camera', 'emotional_state', 'positions', 'prop_state', 'environment_changes', 'allowed_delta'],
          properties: {
            frame_id: {type: 'string', enum: ids},
            beat: str(), action: str(),
            camera: {
              type: 'object', additionalProperties: false,
              required: ['framing', 'lens', 'angle', 'movement'],
              properties: {framing: str(240), lens: str(120), angle: str(240), movement: str(240)},
            },
            emotional_state: str(300), positions: stringArray, prop_state: stringArray,
            environment_changes: stringArray, allowed_delta: stringArray,
          },
        },
      },
    },
  };
}

function exactKeys(value, expected, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) {
    throw new Error(`Sequence planner result has missing or extra ${label} fields.`);
  }
}

function validStringArray(value) {
  return Array.isArray(value) && value.length <= 16 && value.every(item => typeof item === 'string' && item.trim() && item.length <= 300);
}

export function validateSequenceAnalysis(value, count) {
  exactKeys(value, ['summary', 'style', 'time_and_lighting', 'geography', 'initial_state', 'frames'], 'top-level');
  for (const key of ['summary', 'style', 'time_and_lighting', 'geography']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 1200) throw new Error(`Sequence planner result has invalid ${key}.`);
  }
  exactKeys(value.initial_state, ['characters', 'props', 'environment'], 'initial_state');
  for (const key of ['characters', 'props', 'environment']) if (!validStringArray(value.initial_state[key])) throw new Error(`Sequence planner result has invalid initial_state.${key}.`);
  if (!Array.isArray(value.frames) || value.frames.length !== count) throw new Error(`Sequence planner result must contain exactly ${count} frames.`);
  const ids = frameIds(count);
  const frameKeys = ['frame_id', 'beat', 'action', 'camera', 'emotional_state', 'positions', 'prop_state', 'environment_changes', 'allowed_delta'];
  value.frames.forEach((frame, index) => {
    exactKeys(frame, frameKeys, `frame ${index + 1}`);
    if (frame.frame_id !== ids[index]) throw new Error(`Sequence frames must be ordered ${ids.join(', ')}.`);
    for (const key of ['beat', 'action', 'emotional_state']) if (typeof frame[key] !== 'string' || !frame[key].trim() || frame[key].length > 1200) throw new Error(`Sequence frame ${frame.frame_id} has invalid ${key}.`);
    exactKeys(frame.camera, ['framing', 'lens', 'angle', 'movement'], `${frame.frame_id}.camera`);
    for (const key of ['framing', 'lens', 'angle', 'movement']) if (typeof frame.camera[key] !== 'string' || !frame.camera[key].trim() || frame.camera[key].length > 240) throw new Error(`Sequence frame ${frame.frame_id} has invalid camera.${key}.`);
    for (const key of ['positions', 'prop_state', 'environment_changes', 'allowed_delta']) if (!validStringArray(frame[key])) throw new Error(`Sequence frame ${frame.frame_id} has invalid ${key}.`);
  });
  return value;
}

function orderedElementReferences(resolved) {
  const desired = resolved.manifest.reference_policy?.primary_roles || [];
  return [...resolved.manifest.references].sort((a, b) => {
    const ai = desired.indexOf(a.role), bi = desired.indexOf(b.role);
    const ar = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
    const br = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
    return ar - br || a.path.localeCompare(b.path);
  });
}

export function selectMasterReferences(resolvedElements, limit = MAX_MASTERS) {
  if (resolvedElements.length > limit) throw new Error(`The selected Elements require more than ${limit} master reference slots.`);
  const ordered = resolvedElements.map(orderedElementReferences);
  const selected = [];
  for (let depth = 0; selected.length < limit; depth++) {
    let found = false;
    for (let index = 0; index < ordered.length && selected.length < limit; index++) {
      if (ordered[index][depth]) {
        selected.push({elementIndex: index, reference: ordered[index][depth]});
        found = true;
      }
    }
    if (!found) break;
  }
  return selected;
}

function plannerPrompt({id, story, beats, count, elements}) {
  const elementText = elements.map(item => {
    const lock = item.manifest.analysis;
    return `- ${item.manifest.element_id}@${item.manifest.element_sha256} (${item.manifest.element_type}): ${item.manifest.brief || lock.subject_summary}\n  Lock: ${lock.subject_summary}\n  Never introduce: ${(lock.negative_constraints || []).join('; ') || 'nothing specified'}`;
  }).join('\n');
  const beatText = beats ? beats.map((beat, index) => `${index + 1}. ${beat}`).join('\n') : '(derive the beats from the story)';
  return `Design an ordered ${count}-frame connected visual sequence.

Sequence id: ${id}
Story: ${story || '(use the supplied manual beats)'}
Manual beats:
${beatText}

Frozen Elements:
${elementText}

Every frame is a single still image, not a panel or collage. Preserve Element identity, wardrobe, construction, location geography, screen direction, lighting logic, and prop ownership except where allowed_delta explicitly permits a change. State the minimum visual delta from the prior frame. Make camera choices concrete. Do not add captions, borders, labels, or watermarks.`;
}

export function buildSequencePlannerRequest({id, story, beats, count, elements, refs, model}) {
  const content = [{type: 'text', text: plannerPrompt({id, story, beats, count, elements})}];
  for (const ref of refs) content.push({type: 'image_url', image_url: {url: ref.url}});
  return {
    provider: 'openrouter', model,
    url: providers.openrouter.base + '/chat/completions',
    body: {
      model,
      messages: [
        {role: 'system', content: 'You are a film continuity supervisor and storyboard planner. Return only the requested strict JSON.'},
        {role: 'user', content},
      ],
      temperature: MODELS.planner.temperature,
      stream: false,
      provider: {require_parameters: true},
      response_format: {type: 'json_schema', json_schema: {name: 'storylab_connected_sequence', strict: true, schema: sequenceSchema(count)}},
    },
  };
}

function stablePlan(plan) {
  const {plan_sha256, created_at, planner_record, ...spec} = plan;
  return spec;
}

export function validateSequencePlan(plan) {
  if (!plan || plan.kind !== 'connected-sequence' || !Array.isArray(plan.frames)) throw new Error('Invalid connected-sequence plan.');
  if (plan.frames.length < SEQUENCE_CONFIG.min_frames || plan.frames.length > SEQUENCE_CONFIG.max_frames) throw new Error('Connected sequence must contain 2–8 frames.');
  if (!Number.isSafeInteger(plan.master_seed) || plan.master_seed < 0 || plan.master_seed > 0xffffffff) throw new Error('Connected sequence has an invalid master seed.');
  if (!Array.isArray(plan.elements) || !plan.elements.length || plan.elements.length > SEQUENCE_CONFIG.max_elements) throw new Error('Connected sequence must freeze 1–4 Elements.');
  if (new Set(plan.elements.map(element => element.element_sha256)).size !== plan.elements.length) throw new Error('Connected sequence contains a duplicate Element version.');
  const masters = plan.elements.flatMap(element => {
    if (!element || !/^[a-f0-9]{64}$/.test(element.element_sha256) || !Array.isArray(element.references) || !element.references.length) throw new Error('Connected sequence contains an invalid Element snapshot.');
    if (!/^elements\/[a-z0-9-]+-[a-f0-9]{12}\/element\.json$/.test(element.snapshot)) throw new Error('Connected sequence contains an unsafe Element snapshot path.');
    return element.references.map(reference => {
      if (!/^elements\/[a-z0-9-]+-[a-f0-9]{12}\/references\/[a-zA-Z0-9._-]+$/.test(reference.path) || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error('Connected sequence contains an unsafe or invalid master reference.');
      return reference.path;
    });
  });
  if (masters.length > SEQUENCE_CONFIG.max_reference_images - SEQUENCE_CONFIG.reserved_anchor_images) throw new Error('Connected sequence exceeds the frozen master-reference budget.');
  if (!plan.reference_policy || canonicalJson(plan.reference_policy.master_images) !== canonicalJson(masters) || plan.reference_policy.maximum_images !== SEQUENCE_CONFIG.max_reference_images) throw new Error('Connected sequence has an invalid reference policy.');
  validateSequenceAnalysis({
    summary: plan.summary, style: plan.style, time_and_lighting: plan.time_and_lighting,
    geography: plan.geography, initial_state: plan.initial_state, frames: plan.frames,
  }, plan.frames.length);
  const actual = sha256(canonicalJson(stablePlan(plan)));
  if (actual !== plan.plan_sha256) throw new Error('Sequence plan.json was changed after planning; create a new plan instead of mutating it.');
  return plan;
}

function snapshotElements(out, elements, selected) {
  return elements.map((resolved, index) => {
    const folder = `${resolved.manifest.element_id}-${resolved.manifest.element_sha256.slice(0, 12)}`;
    const root = join(out, 'elements', folder);
    mkdirSync(join(root, 'references'), {recursive: true, mode: 0o700});
    writeJsonExclusive(join(root, 'element.json'), resolved.manifest);
    const references = selected.filter(item => item.elementIndex === index).map(({reference}) => {
      const source = resolve(resolved.versionDir, reference.path);
      return {reference, source};
    });
    return {resolved, folder, root, references};
  }).map(item => {
    const references = item.references.map(({reference, source}, refIndex) => {
      const name = `ref-${String(refIndex + 1).padStart(2, '0')}${extname(source)}`;
      const target = join(item.root, 'references', name);
      copyFileSync(source, target);
      return {
        role: reference.role,
        path: `elements/${item.folder}/references/${name}`,
        sha256: reference.sha256,
        mime: reference.mime,
      };
    });
    const manifest = item.resolved.manifest;
    return {
      element_id: manifest.element_id,
      element_type: manifest.element_type,
      element_sha256: manifest.element_sha256,
      snapshot: `elements/${item.folder}/element.json`,
      brief: manifest.brief,
      analysis: manifest.analysis,
      references,
    };
  });
}

export function defaultSequenceOut(projectRoot, id) {
  return join(resolve(projectRoot), 'output', 'storylab', 'sequences', slug(id));
}

export async function createSequencePlan(options, deps = {}) {
  const id = slug(options.id);
  const seed = Number(options.masterSeed);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('--seed must be an integer from 0 through 4294967295.');
  const elementRefs = options.elements || [];
  if (!elementRefs.length || elementRefs.length > SEQUENCE_CONFIG.max_elements) throw new Error('Select 1–4 Elements with repeated --element ID@HASH.');
  if (new Set(elementRefs).size !== elementRefs.length) throw new Error('Do not select the same Element twice.');
  const elements = elementRefs.map(reference => verifyElement(reference, {library: options.library}));
  const beats = options.beats || undefined;
  const count = beats ? beats.length : Number(options.frameCount);
  if (!Number.isSafeInteger(count) || count < SEQUENCE_CONFIG.min_frames || count > SEQUENCE_CONFIG.max_frames) throw new Error('--frames or manual beats must define exactly 2–8 frames.');
  if (beats && options.frameCount !== undefined && Number(options.frameCount) !== beats.length) throw new Error('--frames must match the number of manual beats.');
  const story = String(options.story || '').trim();
  if (!story && !beats) throw new Error('Supply --story, --story-file, or --beats-file.');
  const selected = selectMasterReferences(elements);
  const sourceRefs = selected.map(({elementIndex, reference}) => readImage(resolve(elements[elementIndex].versionDir, reference.path)));
  const model = options.plannerModel || MODELS.planner.model;
  const request = buildSequencePlannerRequest({id, story, beats, count, elements, refs: sourceRefs, model});
  const out = resolve(options.out);
  if (options.dryRun) return scrub({
    operation: 'sequence plan', network: !options.analysisFile, out, request,
    elements: elements.map(item => `${item.manifest.element_id}@${item.manifest.element_sha256}`),
    master_reference_hashes: sourceRefs.map(ref => ref.hash),
  });
  if (existsSync(out)) throw new Error(`Refusing to overwrite an existing sequence directory: ${out}`);

  let analysis, plannerRecord, config, result;
  if (options.analysisFile) {
    analysis = validateSequenceAnalysis(readJson(resolve(options.analysisFile)), count);
    plannerRecord = {mode: 'imported', source_sha256: sha256(canonicalJson(analysis))};
  } else {
    config = loadConfig({'env-file': options.envFile, 'project-root': options.projectRoot}, deps.env || process.env);
    if (!config.env.OPENROUTER_API_KEY) throw new Error(`Missing OPENROUTER_API_KEY; set it in ${config.file} or use --analysis-file.`);
    result = await requestJson(request.url, {
      method: 'POST',
      headers: {Authorization: `Bearer ${config.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(request.body), signal: AbortSignal.timeout(options.timeout || 600_000),
    }, deps.fetcher || fetch);
    try { analysis = validateSequenceAnalysis(JSON.parse(textResult(result)), count); }
    catch (error) { throw new Error(`OpenRouter did not return valid sequence JSON: ${error.message}`); }
    plannerRecord = {mode: 'openrouter', response_sha256: sha256(canonicalJson(result))};
  }

  ensureDirectoryExclusive(out);
  const frozenElements = snapshotElements(out, elements, selected);
  const plannerDir = join(out, 'planner');
  mkdirSync(plannerDir);
  if (options.analysisFile) writeJsonExclusive(join(plannerDir, 'imported-analysis.json'), analysis);
  else {
    saveJson(join(plannerDir, 'request.json'), request, config.env);
    saveJson(join(plannerDir, 'response.json'), result, config.env);
  }
  const spec = {
    contract_version: SEQUENCE_CONFIG.contract_version,
    kind: 'connected-sequence', sequence_id: id, master_seed: seed,
    story, planning_mode: beats ? 'manual-beats' : 'story', manual_beats: beats || [],
    elements: frozenElements,
    summary: analysis.summary, style: analysis.style, time_and_lighting: analysis.time_and_lighting,
    geography: analysis.geography, initial_state: analysis.initial_state, frames: analysis.frames,
    planner: {provider: 'openrouter', model, strict_schema: 'storylab_connected_sequence'},
    renderer: {
      ...MODELS.renderer,
      ...(options.rendererModel ? {text_endpoint: options.rendererModel} : {}),
      ...(options.rendererEditModel ? {edit_endpoint: options.rendererEditModel} : {}),
      ...(options.resolution ? {resolution: options.resolution} : {}),
    },
    aspect_ratio: options.aspectRatio || SEQUENCE_CONFIG.default_aspect_ratio,
    reference_policy: {
      maximum_images: SEQUENCE_CONFIG.max_reference_images,
      master_images: frozenElements.flatMap(element => element.references.map(reference => reference.path)),
      anchors: ['first-frame', 'previous-frame'],
    },
  };
  const plan = {...spec, plan_sha256: sha256(canonicalJson(spec)), created_at: new Date().toISOString(), planner_record: plannerRecord};
  writeJsonExclusive(join(out, 'plan.json'), plan);
  return {out, plan};
}
