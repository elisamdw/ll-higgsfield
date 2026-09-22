---
name: storylab-shot-grid
description: Reframe one source image into a reproducible nine-shot cinematic coverage grid with OpenRouter scene locks, seeded fal edits, deterministic local layout, and optional continuity QA. Use for shot exploration, camera-angle sheets, storyboard coverage, or connected visual sequences that must preserve cast, props, blocking, lighting, and screen direction. Do not use to invent a new scene without a source frame.
---

# StoryLab Shot Grid

Derive every shot independently from one source frame. Never daisy-chain generated shots.

## Gather inputs

Require exactly one PNG/JPEG/WebP source image, a stable asset id, and an explicit uint32 seed. Use the brief to specify the story moment, principal subject, eyelines, or screen-direction constraints that the source does not make unambiguous.

## Run the workflow

1. Preview planning:

   `node utils/storylab-pack.mjs plan shot-grid --id ID --seed N --brief "BRIEF" --ref SOURCE --dry-run`

2. Remove `--dry-run` when generation is requested. Inspect `plan.json`; if geography or continuity locks are wrong, create a new pack.
3. Preview and then run the nine fal edits:

   `node utils/storylab-pack.mjs render output/storylab/shot-grid-ID/plan.json --dry-run`

4. Optionally audit the completed grid:

   `node utils/storylab-pack.mjs review output/storylab/shot-grid-ID/plan.json --dry-run`

The local contact sheet is a presentation artifact. Individual view images remain the canonical outputs.

## Preserve the contract

- Hold scene content, character identity, wardrobe, props, blocking, lighting, time, reflections, eyelines, and screen direction constant.
- Change camera framing, focal length, and elevation only as each fixed shot requests.
- Preserve all request records and failed attempts. Never auto-repair or overwrite a shot.
- Treat generated coverage as previsualization, not proof that the camera geometry is physically exact.

Read [references/shot-grid.md](references/shot-grid.md) for the fixed taxonomy. Read [`../../storylab/DETERMINISM.md`](../../storylab/DETERMINISM.md) when debugging, resuming, or evaluating reproducibility.
