import {existsSync, mkdirSync, readdirSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {buildRequest} from '../../lib/providers.mjs';
import {execute, loadConfig} from '../../lib/runtime.mjs';
import {
  PROMPT_COMPILER_VERSION, assertWithin, canonicalJson, deriveSeed, hashFile, loadStagedReferences,
  readImage, readJson, sha256, writeJsonExclusive,
} from './core.mjs';
import {writeContactSheet} from './sheet.mjs';

const IMAGE_PATTERN = /^image-\d+\.(png|jpg|webp)$/;

function stablePlanSpec(plan) {
  const {plan_sha256, created_at, planner_record, ...spec} = plan;
  return spec;
}

export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.views) || !plan.views.length) throw new Error('Invalid StoryLab plan.');
  const actual = sha256(canonicalJson(stablePlanSpec(plan)));
  if (actual !== plan.plan_sha256) throw new Error('plan.json was changed after planning; create a new plan instead of silently mutating a frozen one.');
  return plan;
}

function bulletLines(values) {
  return values.length ? values.map(value => `- ${value}`).join('\n') : '- none specified';
}

export function compilePrompt(plan, view) {
  const locks = plan.analysis.locks;
  const mode = plan.kind === 'shot-grid'
    ? 'Reframe the exact referenced scene into one cinematic shot.'
    : `Create one production ${plan.kind} reference image, not a collage or multi-panel sheet.`;
  const background = plan.kind === 'shot-grid'
    ? 'Keep the same location, time, lighting logic, blocking, screen direction, and story moment.'
    : 'Use a plain neutral studio background, soft even reference lighting, and no cast shadow that hides the silhouette.';
  return `${mode}

ASSET: ${plan.asset_id}
CANONICAL BRIEF: ${plan.brief || plan.analysis.subject_summary}
SUBJECT SUMMARY: ${plan.analysis.subject_summary}

VIEW: ${view.label}
CAMERA: ${view.camera}
DIRECTION: ${view.direction}
OUTPUT FRAME: ${plan.aspect_ratio}

DEFINING FEATURES — LOCK EXACTLY:
${bulletLines(locks.defining_features)}

GEOMETRY AND PROPORTIONS — LOCK EXACTLY:
${bulletLines(locks.geometry_and_proportions)}

MATERIALS AND TEXTURE — LOCK EXACTLY:
${bulletLines(locks.materials_and_texture)}

COLORS AND MARKINGS — LOCK EXACTLY:
${bulletLines(locks.colors_and_markings)}

CLOTHING AND ACCESSORIES — LOCK EXACTLY:
${bulletLines(locks.clothing_and_accessories)}

SCENE AND SPATIAL RELATIONSHIPS — LOCK EXACTLY:
${bulletLines(locks.scene_and_spatial_relationships)}

DO NOT INTRODUCE:
${bulletLines(plan.analysis.negative_constraints)}

${background}
Generate exactly one view. Do not add captions, labels, diagrams, borders, extra subjects, duplicate parts, or watermarks. Change only what the requested camera/view makes necessary.`;
}

function renderManifest(plan) {
  return {
    contract_version: plan.contract_version,
    plan_sha256: plan.plan_sha256,
    prompt_compiler: PROMPT_COMPILER_VERSION,
    renderer: plan.renderer,
    reference_policy: plan.kind === 'shot-grid' ? 'original-source-only' : 'original-sources-plus-first-render-anchor',
    views: plan.views.map((view, index) => ({
      index: index + 1,
      id: view.id,
      seed: deriveSeed(plan.master_seed, plan.asset_id, view.id, 0),
      prompt_sha256: sha256(compilePrompt(plan, view)),
    })),
  };
}

function attemptDirectories(viewDir) {
  if (!existsSync(viewDir)) return [];
  return readdirSync(viewDir, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && /^attempt-\d+$/.test(entry.name))
    .map(entry => join(viewDir, entry.name)).sort();
}

function findImage(viewDir) {
  for (const dir of attemptDirectories(viewDir)) {
    const name = readdirSync(dir).sort().find(file => IMAGE_PATTERN.test(file));
    if (name) return join(dir, name);
  }
  return undefined;
}

function resumableReceipt(viewDir) {
  const attempts = attemptDirectories(viewDir).reverse();
  for (const dir of attempts) {
    const file = join(dir, 'fal-request.json');
    if (existsSync(file)) return readJson(file);
  }
  return undefined;
}

function nextAttempt(viewDir) {
  return join(viewDir, `attempt-${String(attemptDirectories(viewDir).length + 1).padStart(3, '0')}`);
}

function falReferences(images) {
  return images.map(image => ({data: image.data, mime: image.mime, url: image.url}));
}

function assertExistingManifest(file, expected) {
  if (!existsSync(file)) return false;
  const actual = readJson(file);
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error('Existing render-manifest.json does not match this plan or renderer configuration.');
  return true;
}

function validateExistingProvenance(root, provenance) {
  for (const output of provenance.outputs || []) {
    const file = assertWithin(root, resolve(root, output.image_path));
    if (!existsSync(file) || hashFile(file) !== output.image_sha256) throw new Error(`Rendered output changed or is missing: ${output.image_path}`);
  }
}

export async function renderPlan(planFile, options = {}, deps = {}) {
  const absolutePlan = resolve(planFile);
  const root = dirname(absolutePlan);
  const plan = validatePlan(readJson(absolutePlan));
  const manifest = renderManifest(plan);
  if (options.dryRun) return {operation: 'render', network: true, root, manifest, prompts: plan.views.map(view => ({id: view.id, prompt: compilePrompt(plan, view)}))};

  let config;
  const falConfig = () => {
    if (!config) config = loadConfig({'env-file': options.envFile, 'project-root': options.projectRoot}, deps.env || process.env);
    if (!config.env.FAL_API_KEY) throw new Error(`Missing FAL_API_KEY; set it in ${config.file}.`);
    return config;
  };
  const manifestFile = join(root, 'render-manifest.json');
  if (!assertExistingManifest(manifestFile, manifest)) writeJsonExclusive(manifestFile, manifest);
  const viewsRoot = join(root, 'views');
  mkdirSync(viewsRoot, {recursive: true});
  const sourceReferences = loadStagedReferences(absolutePlan, plan);
  const outputs = [];
  let anchor;

  for (const [index, view] of plan.views.entries()) {
    const viewDir = join(viewsRoot, `${String(index + 1).padStart(2, '0')}-${view.id}`);
    let imageFile = findImage(viewDir);
    const seed = deriveSeed(plan.master_seed, plan.asset_id, view.id, 0);
    const prompt = compilePrompt(plan, view);
    if (!imageFile) {
      const references = plan.kind === 'shot-grid'
        ? sourceReferences
        : [...sourceReferences, ...(index > 0 && anchor ? [readImage(anchor)] : [])];
      const endpoint = references.length ? plan.renderer.edit_endpoint : plan.renderer.text_endpoint;
      const request = buildRequest('image', 'fal', endpoint, prompt, {
        aspect: plan.aspect_ratio,
        resolution: plan.renderer.resolution,
        format: plan.renderer.output_format,
        n: plan.renderer.num_images,
      }, falReferences(references), {seed, limit_generations: plan.renderer.limit_generations});
      const attempts = attemptDirectories(viewDir);
      if (attempts.length) {
        const receipt = resumableReceipt(viewDir);
        if (!receipt) throw new Error(`Incomplete view has no resumable fal receipt; inspect it before deciding whether to resubmit: ${viewDir}`);
        (deps.progress || console.error)(`Resuming ${view.id} from fal request ${receipt.request_id}`);
        await execute('image', {provider: 'fal', model: receipt.model}, falConfig(), nextAttempt(viewDir), {receipt, timeout: options.timeout || 600_000}, deps);
      } else {
        (deps.progress || console.error)(`Rendering ${index + 1}/${plan.views.length}: ${view.id} (seed ${seed})`);
        await execute('image', request, falConfig(), nextAttempt(viewDir), {timeout: options.timeout || 600_000}, deps);
      }
      imageFile = findImage(viewDir);
      if (!imageFile) throw new Error(`fal completed without a saved image for ${view.id}.`);
    }
    if (index === 0) anchor = imageFile;
    outputs.push({
      view_id: view.id,
      label: view.label,
      seed,
      prompt_sha256: sha256(prompt),
      image_path: relative(root, imageFile).split('\\').join('/'),
      image_sha256: hashFile(imageFile),
      image_file: imageFile,
    });
  }

  const provenanceFile = join(root, 'provenance.json');
  const publicOutputs = outputs.map(({image_file, ...output}) => output);
  const provenance = {plan_sha256: plan.plan_sha256, prompt_compiler: PROMPT_COMPILER_VERSION, outputs: publicOutputs};
  if (existsSync(provenanceFile)) {
    const existing = readJson(provenanceFile);
    validateExistingProvenance(root, existing);
    if (canonicalJson(existing) !== canonicalJson(provenance)) throw new Error('Existing provenance.json does not match the frozen plan and rendered files.');
  } else writeJsonExclusive(provenanceFile, provenance);
  const sheetFile = join(root, 'contact-sheet.svg');
  if (!existsSync(sheetFile)) writeContactSheet(sheetFile, plan, outputs);
  return {root, plan, outputs: publicOutputs, sheet: sheetFile};
}
