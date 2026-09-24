import {existsSync, mkdirSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {buildRequest} from '../../lib/providers.mjs';
import {execute, loadConfig} from '../../lib/runtime.mjs';
import {
  PROMPT_COMPILER_VERSION, assertWithin, canonicalJson, deriveSeed, hashFile, readImage, readJson, sha256, writeJsonExclusive,
} from './core.mjs';
import {attemptDirectories, findImage, nextAttempt, resumableReceipt} from './attempts.mjs';
import {validateElementManifest} from './elements.mjs';
import {SEQUENCE_CONFIG, validateSequencePlan} from './sequence-planner.mjs';
import {writeSequenceSheet} from './sequence-sheet.mjs';

const SEQUENCE_PROMPT_COMPILER_VERSION = `${PROMPT_COMPILER_VERSION}-sequence-v1`;

function bullets(values) {
  return values?.length ? values.map(value => `- ${value}`).join('\n') : '- none';
}

export function compileSequencePrompt(plan, frame, index) {
  const elementLocks = plan.elements.map(element => `ELEMENT ${element.element_id}@${element.element_sha256.slice(0, 12)} (${element.element_type})
Summary: ${element.analysis.subject_summary}
Defining features:
${bullets(element.analysis.locks.defining_features)}
Geometry:
${bullets(element.analysis.locks.geometry_and_proportions)}
Materials:
${bullets(element.analysis.locks.materials_and_texture)}
Colors and markings:
${bullets(element.analysis.locks.colors_and_markings)}
Wardrobe and accessories:
${bullets(element.analysis.locks.clothing_and_accessories)}
Spatial lock:
${bullets(element.analysis.locks.scene_and_spatial_relationships)}
Never introduce:
${bullets(element.analysis.negative_constraints)}`).join('\n\n');
  const anchorInstruction = index === 0
    ? 'Use the frozen Element references as the only visual anchors.'
    : 'Use the frozen Element references as identity masters. The supplied first-frame and previous-frame anchors constrain continuity but never replace the Element masters.';
  return `Create exactly one cinematic storyboard still for an ordered connected sequence. Do not create a collage or add text.

SEQUENCE: ${plan.sequence_id}
STORY: ${plan.story || plan.summary}
GLOBAL STYLE: ${plan.style}
TIME AND LIGHTING: ${plan.time_and_lighting}
GEOGRAPHY: ${plan.geography}
ASPECT RATIO: ${plan.aspect_ratio}

${elementLocks}

FRAME: ${frame.frame_id}
BEAT: ${frame.beat}
ACTION: ${frame.action}
CAMERA FRAMING: ${frame.camera.framing}
LENS: ${frame.camera.lens}
ANGLE: ${frame.camera.angle}
MOVEMENT IMPLICATION: ${frame.camera.movement}
EMOTIONAL STATE: ${frame.emotional_state}
POSITIONS:
${bullets(frame.positions)}
PROP STATE AND OWNERSHIP:
${bullets(frame.prop_state)}
ENVIRONMENT CHANGES:
${bullets(frame.environment_changes)}
ONLY ALLOWED DELTAS FROM THE PRIOR FRAME:
${bullets(frame.allowed_delta)}

${anchorInstruction}
Preserve identity, wardrobe, props, location geometry, screen direction, and lighting except for explicitly allowed deltas. Generate one still only. No captions, labels, borders, diagrams, duplicated subjects, or watermarks.`;
}

function validateSnapshots(root, plan) {
  const masters = [];
  for (const element of plan.elements) {
    const snapshotFile = assertWithin(root, resolve(root, element.snapshot));
    const manifest = validateElementManifest(readJson(snapshotFile));
    if (manifest.element_id !== element.element_id || manifest.element_sha256 !== element.element_sha256) throw new Error(`Sequence Element snapshot mismatch: ${element.element_id}`);
    for (const reference of element.references) {
      const file = assertWithin(root, resolve(root, reference.path));
      if (!existsSync(file) || hashFile(file) !== reference.sha256) throw new Error(`Sequence master reference changed or is missing: ${reference.path}`);
      masters.push({...readImage(file), file, element_id: element.element_id, role: reference.role});
    }
  }
  if (!masters.length || masters.length > SEQUENCE_CONFIG.max_reference_images - SEQUENCE_CONFIG.reserved_anchor_images) throw new Error('Sequence has an invalid number of frozen master references.');
  return masters;
}

export function selectFrameReferences(masters, firstFrame, previousFrame, frameIndex) {
  const selected = [...masters];
  if (frameIndex > 0 && firstFrame) selected.push(readImage(firstFrame));
  if (frameIndex > 1 && previousFrame && previousFrame !== firstFrame) selected.push(readImage(previousFrame));
  if (selected.length > SEQUENCE_CONFIG.max_reference_images) throw new Error('Sequence reference selection exceeded the configured image limit.');
  return selected;
}

function falReferences(images) {
  return images.map(image => ({data: image.data, mime: image.mime, url: image.url}));
}

function renderManifest(plan) {
  return {
    contract_version: plan.contract_version,
    plan_sha256: plan.plan_sha256,
    prompt_compiler: SEQUENCE_PROMPT_COMPILER_VERSION,
    renderer: plan.renderer,
    reference_policy: plan.reference_policy,
    frames: plan.frames.map((frame, index) => ({
      index: index + 1,
      frame_id: frame.frame_id,
      seed: deriveSeed(plan.master_seed, plan.sequence_id, frame.frame_id, 0),
      prompt_sha256: sha256(compileSequencePrompt(plan, frame, index)),
    })),
  };
}

function assertExistingJson(file, expected, message) {
  if (!existsSync(file)) return false;
  if (canonicalJson(readJson(file)) !== canonicalJson(expected)) throw new Error(message);
  return true;
}

function validateExistingProvenance(root, provenance) {
  for (const output of provenance.outputs || []) {
    const file = assertWithin(root, resolve(root, output.image_path));
    if (!existsSync(file) || hashFile(file) !== output.image_sha256) throw new Error(`Rendered sequence frame changed or is missing: ${output.image_path}`);
  }
}

export async function renderSequence(planFile, options = {}, deps = {}) {
  const absolutePlan = resolve(planFile), root = dirname(absolutePlan);
  const plan = validateSequencePlan(readJson(absolutePlan));
  const masters = validateSnapshots(root, plan);
  const manifest = renderManifest(plan);
  if (options.dryRun) return {
    operation: 'sequence render', network: true, root, manifest,
    frames: plan.frames.map((frame, index) => ({frame_id: frame.frame_id, prompt: compileSequencePrompt(plan, frame, index), reference_count: masters.length + (index > 0 ? 1 : 0) + (index > 1 ? 1 : 0)})),
  };
  const manifestFile = join(root, 'render-manifest.json');
  if (!assertExistingJson(manifestFile, manifest, 'Existing render-manifest.json does not match this frozen sequence.')) writeJsonExclusive(manifestFile, manifest);
  const framesRoot = join(root, 'frames');
  mkdirSync(framesRoot, {recursive: true});
  let config;
  const falConfig = () => {
    if (!config) config = loadConfig({'env-file': options.envFile, 'project-root': options.projectRoot}, deps.env || process.env);
    if (!config.env.FAL_API_KEY) throw new Error(`Missing FAL_API_KEY; set it in ${config.file}.`);
    return config;
  };
  const outputs = [];
  let firstFrame, previousFrame;
  for (const [index, frame] of plan.frames.entries()) {
    const frameDir = join(framesRoot, `${String(index + 1).padStart(2, '0')}-${frame.frame_id}`);
    let imageFile = findImage(frameDir);
    const seed = deriveSeed(plan.master_seed, plan.sequence_id, frame.frame_id, 0);
    const prompt = compileSequencePrompt(plan, frame, index);
    if (!imageFile) {
      const references = selectFrameReferences(masters, firstFrame, previousFrame, index);
      const request = buildRequest('image', 'fal', plan.renderer.edit_endpoint, prompt, {
        aspect: plan.aspect_ratio, resolution: plan.renderer.resolution,
        format: plan.renderer.output_format, n: plan.renderer.num_images,
      }, falReferences(references), {seed, limit_generations: plan.renderer.limit_generations});
      if (attemptDirectories(frameDir).length) {
        const receipt = resumableReceipt(frameDir);
        if (!receipt) throw new Error(`Incomplete frame has no resumable fal receipt; inspect it before resubmitting: ${frameDir}`);
        (deps.progress || console.error)(`Resuming ${frame.frame_id} from fal request ${receipt.request_id}`);
        await execute('image', {provider: 'fal', model: receipt.model}, falConfig(), nextAttempt(frameDir), {receipt, timeout: options.timeout || 600_000}, deps);
      } else {
        (deps.progress || console.error)(`Rendering ${index + 1}/${plan.frames.length}: ${frame.frame_id} (seed ${seed})`);
        await execute('image', request, falConfig(), nextAttempt(frameDir), {timeout: options.timeout || 600_000}, deps);
      }
      imageFile = findImage(frameDir);
      if (!imageFile) throw new Error(`fal completed without a saved image for ${frame.frame_id}.`);
    }
    if (!firstFrame) firstFrame = imageFile;
    previousFrame = imageFile;
    outputs.push({
      frame_id: frame.frame_id, seed, prompt_sha256: sha256(prompt),
      image_path: relative(root, imageFile).split('\\').join('/'), image_sha256: hashFile(imageFile), image_file: imageFile,
    });
  }
  const publicOutputs = outputs.map(({image_file, ...output}) => output);
  const provenance = {plan_sha256: plan.plan_sha256, prompt_compiler: SEQUENCE_PROMPT_COMPILER_VERSION, outputs: publicOutputs};
  const provenanceFile = join(root, 'provenance.json');
  if (existsSync(provenanceFile)) {
    const existing = readJson(provenanceFile);
    validateExistingProvenance(root, existing);
    if (canonicalJson(existing) !== canonicalJson(provenance)) throw new Error('Existing provenance.json does not match this frozen sequence.');
  } else writeJsonExclusive(provenanceFile, provenance);
  const ledger = {
    plan_sha256: plan.plan_sha256,
    initial_state: plan.initial_state,
    frames: plan.frames.map(frame => ({
      frame_id: frame.frame_id, positions: frame.positions, prop_state: frame.prop_state,
      environment_changes: frame.environment_changes, allowed_delta: frame.allowed_delta,
    })),
  };
  const ledgerFile = join(root, 'continuity-ledger.json');
  if (!assertExistingJson(ledgerFile, ledger, 'Existing continuity-ledger.json does not match this frozen sequence.')) writeJsonExclusive(ledgerFile, ledger);
  const sheet = join(root, 'storyboard.svg');
  if (!existsSync(sheet)) writeSequenceSheet(sheet, plan, outputs);
  return {root, plan, outputs: publicOutputs, sheet, ledger: ledgerFile};
}
