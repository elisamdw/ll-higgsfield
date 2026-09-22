import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {REPO_ROOT} from '../../lib/runtime.mjs';
import {createPlan, defaultPlanOut} from './planner.mjs';
import {renderPlan} from './renderer.mjs';
import {reviewPlan} from './reviewer.mjs';

const HELP = `Usage:
  node utils/storylab-pack.mjs plan KIND --id ID --seed N [--brief TEXT] [--ref FILE ...]
  node utils/storylab-pack.mjs render PACK/plan.json [--dry-run]
  node utils/storylab-pack.mjs review PACK/plan.json [--dry-run]

KIND is character, prop, or shot-grid. shot-grid requires exactly one --ref.

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
  throw new Error(`Unknown command: ${command}. Choose plan, render, or review.`);
}

export {HELP};

