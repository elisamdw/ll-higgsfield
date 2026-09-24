import {copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {basename, dirname, extname, join, relative, resolve} from 'node:path';
import {providers, textResult} from '../../lib/providers.mjs';
import {loadConfig, requestJson, scrub} from '../../lib/runtime.mjs';
import {
  assertWithin, canonicalJson, hashFile, readImage, readJson, sha256, slug, writeJsonExclusive,
} from './core.mjs';
import {analysisSchema, buildPlannerRequest, validateAnalysis} from './planner.mjs';
import {validatePlan} from './renderer.mjs';

export const ELEMENT_TYPES = ['character', 'prop', 'location'];
const TYPE_SET = new Set(ELEMENT_TYPES);
const PRIMARY_ROLES = {
  character: ['front-full', 'profile-left'],
  prop: ['front', 'three-quarter-left'],
  location: ['source-01', 'source-02'],
};

export function defaultElementLibrary(projectRoot) {
  return join(resolve(projectRoot), 'output', 'storylab', 'elements');
}

function elementStableSpec(manifest) {
  const {element_sha256, created_at, planner_record, ...spec} = manifest;
  return spec;
}

export function validateElementManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !TYPE_SET.has(manifest.element_type)) throw new Error('Invalid Element manifest.');
  if (!manifest.element_id || !Array.isArray(manifest.references) || !manifest.references.length) throw new Error('Element manifest must have an id and at least one reference.');
  if (manifest.element_id !== slug(manifest.element_id)) throw new Error('Element manifest has a noncanonical id.');
  validateAnalysis(manifest.analysis);
  for (const reference of manifest.references) {
    if (!reference || typeof reference.path !== 'string' || !/^references\/[a-zA-Z0-9._-]+$/.test(reference.path)) throw new Error('Element manifest contains an unsafe reference path.');
    if (typeof reference.role !== 'string' || !reference.role || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error('Element manifest contains an invalid reference record.');
  }
  const actual = sha256(canonicalJson(elementStableSpec(manifest)));
  if (actual !== manifest.element_sha256) throw new Error('element.json was changed after registration; create a new immutable Element version.');
  return manifest;
}

function extensionFor(image) {
  const ext = extname(image.absolute).toLowerCase();
  return ext === '.jpeg' ? '.jpg' : ext;
}

function referenceDescriptors(files, roles) {
  if (!files.length || files.length > 8) throw new Error('An Element requires 1–8 PNG, JPEG, or WebP references.');
  return files.map((file, index) => {
    const image = readImage(file);
    const name = `ref-${String(index + 1).padStart(2, '0')}${extensionFor(image)}`;
    return {
      source: image.absolute,
      target: `references/${name}`,
      sourceTarget: `source/${name}`,
      role: roles[index] || `source-${String(index + 1).padStart(2, '0')}`,
      sha256: image.hash,
      mime: image.mime,
      original_name: basename(image.absolute),
    };
  });
}

function publicReferences(descriptors) {
  return descriptors.map(({target, role, sha256: hash, mime}) => ({path: target, role, sha256: hash, mime}));
}

function sourceRecords(descriptors) {
  return descriptors.map(({sourceTarget: path, sha256: hash, mime, original_name}) => ({path, sha256: hash, mime, original_name}));
}

function writeElementVersion(library, baseManifest, descriptors, plannerFiles = []) {
  const stable = elementStableSpec(baseManifest);
  const hash = sha256(canonicalJson(stable));
  const versionDir = join(library, baseManifest.element_id, hash);
  const manifestFile = join(versionDir, 'element.json');
  if (existsSync(versionDir)) {
    const resolved = verifyElement(`${baseManifest.element_id}@${hash}`, {library});
    return {...resolved, created: false};
  }
  mkdirSync(join(versionDir, 'source'), {recursive: true, mode: 0o700});
  mkdirSync(join(versionDir, 'references'), {recursive: true, mode: 0o700});
  for (const descriptor of descriptors) {
    copyFileSync(descriptor.source, join(versionDir, descriptor.target));
    copyFileSync(descriptor.source, join(versionDir, descriptor.sourceTarget));
  }
  for (const {source, value, path} of plannerFiles) {
    const target = join(versionDir, path);
    mkdirSync(dirname(target), {recursive: true});
    if (source) copyFileSync(source, target);
    else writeJsonExclusive(target, value);
  }
  const manifest = {...baseManifest, element_sha256: hash, created_at: new Date().toISOString()};
  writeJsonExclusive(manifestFile, manifest);
  const provenance = {
    element_sha256: hash,
    origin: manifest.origin,
    sources: sourceRecords(descriptors),
    references: manifest.references,
  };
  writeJsonExclusive(join(versionDir, 'provenance.json'), provenance);
  rebuildElementIndex(library);
  return {library, versionDir, manifestFile, manifest, created: true};
}

function listVersionEntries(library) {
  if (!existsSync(library)) return [];
  const entries = [];
  for (const idEntry of readdirSync(library, {withFileTypes: true}).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const idDir = join(library, idEntry.name);
    for (const hashEntry of readdirSync(idDir, {withFileTypes: true}).filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(idDir, hashEntry.name, 'element.json');
      if (!existsSync(file)) continue;
      const manifest = validateElementManifest(readJson(file));
      entries.push({
        element_id: manifest.element_id,
        element_type: manifest.element_type,
        element_sha256: manifest.element_sha256,
        reference_count: manifest.references.length,
        brief: manifest.brief,
      });
    }
  }
  return entries;
}

export function rebuildElementIndex(library) {
  mkdirSync(library, {recursive: true});
  const index = {contract_version: 1, elements: listVersionEntries(library)};
  const target = join(library, 'index.json');
  const temporary = join(library, `.index-${process.pid}-${Date.now()}.json`);
  writeFileSync(temporary, JSON.stringify(index, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  renameSync(temporary, target);
  return index;
}

export function listElements(options) {
  const library = resolve(options.library);
  return {library, ...rebuildElementIndex(library)};
}

function versionDirectories(library, id) {
  const root = join(library, id);
  if (!existsSync(root)) return [];
  return readdirSync(root, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map(entry => entry.name).sort();
}

export function resolveElement(reference, options) {
  const library = resolve(options.library);
  const [rawId, rawHash, extra] = String(reference).split('@');
  if (extra !== undefined) throw new Error(`Invalid Element reference: ${reference}`);
  const id = slug(rawId);
  const versions = versionDirectories(library, id);
  if (!versions.length) throw new Error(`Element not found: ${id}`);
  let hash;
  if (rawHash) {
    if (!/^[a-f0-9]{8,64}$/.test(rawHash)) throw new Error('Element hash must be 8–64 lowercase hexadecimal characters.');
    const matches = versions.filter(candidate => candidate.startsWith(rawHash));
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous Element hash prefix: ${reference}` : `Element version not found: ${reference}`);
    [hash] = matches;
  } else {
    if (versions.length !== 1) throw new Error(`Element ${id} has ${versions.length} versions; specify ${id}@HASH.`);
    [hash] = versions;
  }
  const versionDir = assertWithin(library, join(library, id, hash));
  const manifestFile = join(versionDir, 'element.json');
  const manifest = validateElementManifest(readJson(manifestFile));
  if (manifest.element_id !== id || manifest.element_sha256 !== hash) throw new Error(`Element path and manifest disagree: ${reference}`);
  return {library, versionDir, manifestFile, manifest};
}

export function verifyElement(reference, options) {
  const resolved = resolveElement(reference, options);
  for (const item of resolved.manifest.references) {
    const file = assertWithin(resolved.versionDir, resolve(resolved.versionDir, item.path));
    if (!existsSync(file)) throw new Error(`Element reference is missing: ${item.path}`);
    if (hashFile(file) !== item.sha256) throw new Error(`Element reference hash changed: ${item.path}`);
  }
  return {...resolved, verified: true};
}

export function inspectElement(reference, options) {
  return verifyElement(reference, options);
}

export function importPack(planFile, options) {
  const absolutePlan = resolve(planFile);
  const packRoot = dirname(absolutePlan);
  const plan = validatePlan(readJson(absolutePlan));
  if (!['character', 'prop'].includes(plan.kind)) throw new Error('Only completed character and prop packs can be imported as Elements. Register locations from references with element create.');
  const provenanceFile = join(packRoot, 'provenance.json');
  if (!existsSync(provenanceFile)) throw new Error('Render the pack before importing it as an Element.');
  const provenance = readJson(provenanceFile);
  if (provenance.plan_sha256 !== plan.plan_sha256 || !Array.isArray(provenance.outputs) || !provenance.outputs.length) throw new Error('Pack provenance does not match its frozen plan.');
  const selected = provenance.outputs.map(output => {
    const file = assertWithin(packRoot, resolve(packRoot, output.image_path));
    if (!existsSync(file) || hashFile(file) !== output.image_sha256) throw new Error(`Pack output changed or is missing: ${output.image_path}`);
    return {file, role: output.view_id};
  });
  const descriptors = referenceDescriptors(selected.map(item => item.file), selected.map(item => item.role));
  const manifest = {
    contract_version: 1,
    element_type: plan.kind,
    element_id: slug(options.id || plan.asset_id),
    brief: plan.brief || plan.analysis.subject_summary,
    analysis: plan.analysis,
    origin: {mode: 'storylab-pack', kind: plan.kind, plan_sha256: plan.plan_sha256},
    references: publicReferences(descriptors),
    reference_policy: {primary_roles: PRIMARY_ROLES[plan.kind]},
  };
  if (options.dryRun) return scrub({operation: 'element import', network: false, library: resolve(options.library), element_sha256: sha256(canonicalJson(manifest)), manifest});
  return writeElementVersion(resolve(options.library), manifest, descriptors);
}

function elementPrompt({type, id, brief, referenceCount}) {
  const focus = {
    character: 'identity, facial structure, body proportions, hair, wardrobe, accessories, and apparent age',
    prop: 'silhouette, dimensions, construction, materials, markings, wear, and functional parts',
    location: 'architecture, layout, landmarks, materials, color, geography, entrances, windows, lighting sources, and scale',
  }[type];
  return `Build an immutable visual continuity lock for a reusable ${type} Element.

Element id: ${id}
Creator brief: ${brief || '(infer only visible facts from the supplied references)'}
Reference images supplied: ${referenceCount}

Describe only observable or explicitly requested facts. Concentrate on ${focus}. Keep each lock atomic. Put uncertainty in continuity_risks instead of inventing facts. Negative constraints must name visual changes later shots must not introduce. Empty lock arrays are allowed when irrelevant.`;
}

export function buildElementPlannerRequest({type, id, brief, refs, model}) {
  if (type !== 'location') return buildPlannerRequest({kind: type, assetId: id, brief, refs, model});
  const content = [{type: 'text', text: elementPrompt({type, id, brief, referenceCount: refs.length})}];
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
      temperature: 0,
      stream: false,
      provider: {require_parameters: true},
      response_format: {type: 'json_schema', json_schema: {name: 'storylab_element_lock', strict: true, schema: analysisSchema}},
    },
  };
}

export async function createElement(options, deps = {}) {
  if (!TYPE_SET.has(options.type)) throw new Error(`Unknown Element type: ${options.type}. Choose ${ELEMENT_TYPES.join(', ')}.`);
  const id = slug(options.id);
  const brief = String(options.brief || '').trim();
  const files = options.references || [];
  const refs = files.map(readImage);
  if (!refs.length) throw new Error('element create requires at least one --ref image.');
  if (refs.length > 8) throw new Error('element create accepts at most 8 reference images.');
  const model = options.plannerModel || 'openai/gpt-5-mini';
  const request = buildElementPlannerRequest({type: options.type, id, brief, refs, model});
  if (options.dryRun) return scrub({operation: 'element create', network: !options.analysisFile, library: resolve(options.library), request, input_hashes: refs.map(ref => ref.hash)});

  let analysis, plannerRecord, plannerFiles = [];
  if (options.analysisFile) {
    analysis = validateAnalysis(readJson(resolve(options.analysisFile)));
    plannerRecord = {mode: 'imported', source_sha256: sha256(canonicalJson(analysis))};
    plannerFiles = [{source: resolve(options.analysisFile), path: 'planner/imported-analysis.json'}];
  } else {
    const config = loadConfig({'env-file': options.envFile, 'project-root': options.projectRoot}, deps.env || process.env);
    if (!config.env.OPENROUTER_API_KEY) throw new Error(`Missing OPENROUTER_API_KEY; set it in ${config.file} or use --analysis-file.`);
    const result = await requestJson(request.url, {
      method: 'POST',
      headers: {Authorization: `Bearer ${config.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(options.timeout || 600_000),
    }, deps.fetcher || fetch);
    let raw;
    try { raw = JSON.parse(textResult(result)); analysis = validateAnalysis(raw); }
    catch (error) { throw new Error(`OpenRouter did not return valid Element continuity JSON: ${error.message}`); }
    plannerFiles = [
      {value: scrub(request, config.env), path: 'planner/request.json'},
      {value: scrub(result, config.env), path: 'planner/response.json'},
    ];
    plannerRecord = {mode: 'openrouter', response_sha256: sha256(canonicalJson(result))};
  }
  const roles = files.map((_, index) => `source-${String(index + 1).padStart(2, '0')}`);
  const descriptors = referenceDescriptors(files, roles);
  const manifest = {
    contract_version: 1,
    element_type: options.type,
    element_id: id,
    brief,
    analysis,
    origin: {mode: 'references'},
    references: publicReferences(descriptors),
    reference_policy: {primary_roles: PRIMARY_ROLES[options.type]},
    planner: {provider: 'openrouter', model, strict_schema: 'storylab_element_lock'},
    planner_record: plannerRecord,
  };
  return writeElementVersion(resolve(options.library), manifest, descriptors, plannerFiles);
}

export function elementSummary(result) {
  const manifest = result.manifest;
  return {
    reference: `${manifest.element_id}@${manifest.element_sha256}`,
    type: manifest.element_type,
    brief: manifest.brief,
    references: manifest.references,
    path: relative(process.cwd(), result.manifestFile),
    verified: result.verified,
  };
}
