import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {REPO_ROOT} from '../../lib/runtime.mjs';
import {createPlan, defaultPlanOut} from './planner.mjs';
import {renderPlan} from './renderer.mjs';
import {reviewPlan} from './reviewer.mjs';
import {
  createElement, defaultElementLibrary, elementSummary, importPack, inspectElement, listElements, verifyElement,
} from './elements.mjs';
import {createSequencePlan, defaultSequenceOut} from './sequence-planner.mjs';
import {renderSequence} from './sequence-renderer.mjs';
import {reviewSequence} from './sequence-reviewer.mjs';

const HELP = `Usage:
  node utils/storylab.mjs plan KIND --id ID --seed N [--brief TEXT] [--ref FILE ...]
  node utils/storylab.mjs render PACK/plan.json [--dry-run]
  node utils/storylab.mjs review PACK/plan.json [--dry-run]

  node utils/storylab.mjs element import PACK/plan.json [--id ID]
  node utils/storylab.mjs element create --type TYPE --id ID --ref FILE [--ref FILE ...]
  node utils/storylab.mjs element list
  node utils/storylab.mjs element inspect ID[@HASH]
  node utils/storylab.mjs element verify ID[@HASH]

  node utils/storylab.mjs sequence plan --id ID --seed N --frames N --story TEXT --element ID@HASH [...]
  node utils/storylab.mjs sequence plan --id ID --seed N --beats-file FILE --element ID@HASH [...]
  node utils/storylab.mjs sequence render SEQUENCE/plan.json [--dry-run]
  node utils/storylab.mjs sequence review SEQUENCE/plan.json [--dry-run]

KIND is character, prop, or shot-grid. shot-grid requires exactly one --ref.
Element TYPE is character, prop, or location. A sequence accepts 1–4 Elements and 2–8 frames.

plan options:
  --id ID                    Stable lowercase-friendly asset identifier
  --seed N                   Master uint32 seed; required and recorded
  --brief TEXT               Creator intent and nonvisual facts
  --brief-file FILE          Read the brief from a UTF-8 file
  --ref FILE                 PNG, JPEG, or WebP reference; repeatable
  --out DIRECTORY            New immutable pack directory
  --analysis-file FILE       Import preapproved strict planner JSON; no OpenRouter call
  --planner-model ID         OpenRouter model (default openai/gpt-5-mini)
  --renderer-model ID        fal text-to-image endpoint
  --renderer-edit-model ID   fal edit endpoint
  --resolution TIER          fal resolution (default 1K)

shared options:
  --env-file FILE            Credentials file (default repo-root .env)
  --project-root DIRECTORY   Owner of .env and default output
  --timeout MS               Per-operation deadline (default 600000)
  --dry-run                  Print exact operation without network calls or writes
  --help                     Show this help

The paid phases are deliberately separate: plan freezes OpenRouter JSON; render sends
that exact plan to fal one view at a time; review audits completed views with OpenRouter.
Existing packs and outputs are never overwritten.`;

function positiveTimeout(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) throw new Error('--timeout must be a positive integer within timer limits.');
  return parsed;
}

function commonOptions() {
  return {
    'env-file': {type: 'string'}, 'project-root': {type: 'string'},
    timeout: {type: 'string'}, 'dry-run': {type: 'boolean'}, help: {type: 'boolean', short: 'h'},
  };
}

function planArguments(argv) {
  const {values, positionals} = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...commonOptions(), id: {type: 'string'}, seed: {type: 'string'}, brief: {type: 'string'},
      'brief-file': {type: 'string'}, ref: {type: 'string', multiple: true}, out: {type: 'string'},
      'analysis-file': {type: 'string'}, 'planner-model': {type: 'string'},
      'renderer-model': {type: 'string'}, 'renderer-edit-model': {type: 'string'}, resolution: {type: 'string'},
    },
  });
  if (values.help) return {help: true};
  if (positionals.length !== 1) throw new Error('plan requires one KIND: character, prop, or shot-grid.');
  if (!values.id) throw new Error('plan requires --id.');
  if (values.seed === undefined) throw new Error('plan requires an explicit --seed.');
  if (values.brief && values['brief-file']) throw new Error('Choose --brief or --brief-file, not both.');
  const brief = values['brief-file'] ? readFileSync(resolve(values['brief-file']), 'utf8') : values.brief;
  const projectRoot = resolve(values['project-root'] || REPO_ROOT);
  return {
    kind: positionals[0], assetId: values.id, masterSeed: Number(values.seed), brief,
    references: values.ref || [], out: resolve(values.out || defaultPlanOut(projectRoot, positionals[0], values.id)),
    analysisFile: values['analysis-file'], plannerModel: values['planner-model'], rendererModel: values['renderer-model'],
    rendererEditModel: values['renderer-edit-model'], resolution: values.resolution,
    envFile: values['env-file'], projectRoot, timeout: positiveTimeout(values.timeout), dryRun: values['dry-run'],
  };
}

function existingPackArguments(command, argv) {
  const {values, positionals} = parseArgs({
    args: argv, allowPositionals: true,
    options: {...commonOptions(), ...(command === 'review' ? {'reviewer-model': {type: 'string'}} : {})},
  });
  if (values.help) return {help: true};
  if (positionals.length !== 1) throw new Error(`${command} requires one PACK/plan.json path.`);
  return {
    planFile: resolve(positionals[0]), envFile: values['env-file'], projectRoot: values['project-root'] && resolve(values['project-root']),
    reviewerModel: values['reviewer-model'], timeout: positiveTimeout(values.timeout), dryRun: values['dry-run'],
  };
}

function elementArguments(argv) {
  const [action, ...rest] = argv;
  if (!action) throw new Error('element requires create, import, list, inspect, or verify.');
  const projectOption = {'project-root': {type: 'string'}, library: {type: 'string'}, help: {type: 'boolean', short: 'h'}};
  if (action === 'import') {
    const {values, positionals} = parseArgs({args: rest, allowPositionals: true, options: {...projectOption, id: {type: 'string'}, 'dry-run': {type: 'boolean'}}});
    if (values.help) return {help: true};
    if (positionals.length !== 1) throw new Error('element import requires one PACK/plan.json path.');
    const projectRoot = resolve(values['project-root'] || REPO_ROOT);
    return {action, planFile: resolve(positionals[0]), id: values.id, projectRoot, library: resolve(values.library || defaultElementLibrary(projectRoot)), dryRun: values['dry-run']};
  }
  if (action === 'create') {
    const {values, positionals} = parseArgs({
      args: rest, allowPositionals: true,
      options: {
        ...commonOptions(), library: {type: 'string'}, type: {type: 'string'}, id: {type: 'string'},
        brief: {type: 'string'}, 'brief-file': {type: 'string'}, ref: {type: 'string', multiple: true},
        'analysis-file': {type: 'string'}, 'planner-model': {type: 'string'},
      },
    });
    if (values.help) return {help: true};
    if (positionals.length) throw new Error('element create accepts flags only.');
    if (!values.type || !values.id) throw new Error('element create requires --type and --id.');
    if (values.brief && values['brief-file']) throw new Error('Choose --brief or --brief-file, not both.');
    const projectRoot = resolve(values['project-root'] || REPO_ROOT);
    return {
      action, type: values.type, id: values.id,
      brief: values['brief-file'] ? readFileSync(resolve(values['brief-file']), 'utf8') : values.brief,
      references: values.ref || [], analysisFile: values['analysis-file'], plannerModel: values['planner-model'],
      projectRoot, library: resolve(values.library || defaultElementLibrary(projectRoot)), envFile: values['env-file'],
      timeout: positiveTimeout(values.timeout), dryRun: values['dry-run'],
    };
  }
  if (['list', 'inspect', 'verify'].includes(action)) {
    const {values, positionals} = parseArgs({args: rest, allowPositionals: true, options: projectOption});
    if (values.help) return {help: true};
    if (action === 'list' ? positionals.length : positionals.length !== 1) throw new Error(`element ${action} ${action === 'list' ? 'takes no positional arguments' : 'requires one ID[@HASH]'}.`);
    const projectRoot = resolve(values['project-root'] || REPO_ROOT);
    return {action, reference: positionals[0], projectRoot, library: resolve(values.library || defaultElementLibrary(projectRoot))};
  }
  throw new Error(`Unknown element command: ${action}.`);
}

function readBeats(file) {
  const value = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const beats = Array.isArray(value) ? value : value?.beats;
  if (!Array.isArray(beats) || beats.some(beat => typeof beat !== 'string' || !beat.trim())) throw new Error('--beats-file must contain a JSON string array or {"beats": [...]} object.');
  return beats;
}

function sequenceArguments(argv) {
  const [action, ...rest] = argv;
  if (!action) throw new Error('sequence requires plan, render, or review.');
  if (action === 'plan') {
    const {values, positionals} = parseArgs({
      args: rest, allowPositionals: true,
      options: {
        ...commonOptions(), id: {type: 'string'}, seed: {type: 'string'}, frames: {type: 'string'},
        story: {type: 'string'}, 'story-file': {type: 'string'}, 'beats-file': {type: 'string'},
        element: {type: 'string', multiple: true}, library: {type: 'string'}, out: {type: 'string'},
        'analysis-file': {type: 'string'}, 'planner-model': {type: 'string'},
        'renderer-model': {type: 'string'}, 'renderer-edit-model': {type: 'string'}, resolution: {type: 'string'},
        'aspect-ratio': {type: 'string'},
      },
    });
    if (values.help) return {help: true};
    if (positionals.length) throw new Error('sequence plan accepts flags only.');
    if (!values.id || values.seed === undefined) throw new Error('sequence plan requires --id and --seed.');
    if (values.story && values['story-file']) throw new Error('Choose --story or --story-file, not both.');
    if (values['beats-file'] && (values.story || values['story-file'])) throw new Error('Choose story planning or --beats-file, not both.');
    const story = values['story-file'] ? readFileSync(resolve(values['story-file']), 'utf8') : values.story;
    const beats = values['beats-file'] ? readBeats(values['beats-file']) : undefined;
    if (!beats && values.frames === undefined) throw new Error('Story planning requires --frames 2–8.');
    const projectRoot = resolve(values['project-root'] || REPO_ROOT);
    return {
      action, id: values.id, masterSeed: Number(values.seed), frameCount: values.frames,
      story, beats, elements: values.element || [],
      projectRoot, library: resolve(values.library || defaultElementLibrary(projectRoot)),
      out: resolve(values.out || defaultSequenceOut(projectRoot, values.id)), analysisFile: values['analysis-file'],
      plannerModel: values['planner-model'], rendererModel: values['renderer-model'], rendererEditModel: values['renderer-edit-model'],
      resolution: values.resolution, aspectRatio: values['aspect-ratio'], envFile: values['env-file'],
      timeout: positiveTimeout(values.timeout), dryRun: values['dry-run'],
    };
  }
  if (['render', 'review'].includes(action)) {
    const options = existingPackArguments(action, rest);
    return {...options, action};
  }
  throw new Error(`Unknown sequence command: ${action}.`);
}

export async function runStorylab(argv = process.argv.slice(2), deps = {}) {
  const [command, ...rest] = argv;
  const stdout = deps.stdout || console.log;
  if (!command || command === '--help' || command === '-h') { stdout(HELP); return; }
  if (command === 'plan') {
    const options = planArguments(rest);
    if (options.help) { stdout(HELP); return; }
    const result = await createPlan(options, deps);
    if (options.dryRun) stdout(JSON.stringify(result, null, 2));
    else stdout(`Frozen plan: ${result.out}/plan.json`);
    return result;
  }
  if (command === 'render') {
    const options = existingPackArguments(command, rest);
    if (options.help) { stdout(HELP); return; }
    const result = await renderPlan(options.planFile, options, deps);
    if (options.dryRun) stdout(JSON.stringify(result, null, 2));
    else stdout(`Contact sheet: ${result.sheet}`);
    return result;
  }
  if (command === 'review') {
    const options = existingPackArguments(command, rest);
    if (options.help) { stdout(HELP); return; }
    const result = await reviewPlan(options.planFile, options, deps);
    if (options.dryRun) stdout(JSON.stringify(result, null, 2));
    else stdout(`Review: ${result.reviewDir}/review.json`);
    return result;
  }
  if (command === 'element') {
    const options = elementArguments(rest);
    if (options.help) { stdout(HELP); return; }
    let result;
    if (options.action === 'import') result = importPack(options.planFile, options);
    else if (options.action === 'create') result = await createElement(options, deps);
    else if (options.action === 'list') result = listElements(options);
    else if (options.action === 'inspect') result = elementSummary(inspectElement(options.reference, options));
    else result = elementSummary(verifyElement(options.reference, options));
    if (options.dryRun || options.action === 'list' || ['inspect', 'verify'].includes(options.action)) stdout(JSON.stringify(result, null, 2));
    else stdout(`${result.created ? 'Registered' : 'Already registered'} Element: ${result.manifest.element_id}@${result.manifest.element_sha256}`);
    return result;
  }
  if (command === 'sequence') {
    const options = sequenceArguments(rest);
    if (options.help) { stdout(HELP); return; }
    let result;
    if (options.action === 'plan') result = await createSequencePlan(options, deps);
    else if (options.action === 'render') result = await renderSequence(options.planFile, options, deps);
    else result = await reviewSequence(options.planFile, options, deps);
    if (options.dryRun) stdout(JSON.stringify(result, null, 2));
    else if (options.action === 'plan') stdout(`Frozen sequence plan: ${result.out}/plan.json`);
    else if (options.action === 'render') stdout(`Storyboard: ${result.sheet}`);
    else stdout(`Sequence review: ${result.reviewDir}/review.json`);
    return result;
  }
  throw new Error(`Unknown command: ${command}. Choose plan, render, review, element, or sequence.`);
}

export {HELP};
