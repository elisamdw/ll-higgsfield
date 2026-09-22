---
name: storylab-prop-pack
description: Create a reproducible six-view prop or hero-object reference pack with OpenRouter construction locks, seeded fal generation, a deterministic local contact sheet, and optional visual QA. Use for prop sheets, product-like turnarounds, recurring story objects, material and label continuity, or reusable environment elements. Do not use for marketplace compliance imagery or dimensionally accurate CAD.
---

# StoryLab Prop Pack

Create a frozen construction plan before rendering. Work from the repository root.

## Gather inputs

Require a stable asset id and explicit uint32 seed. Ask for known dimensions, materials, colors, functional parts, exact markings, and which details must remain legible. Accept a written brief, 1–8 PNG/JPEG/WebP references, or both. State that generated views are visual references rather than engineering drawings.

## Run the workflow

1. Preview planning:

   `node utils/storylab-pack.mjs plan prop --id ID --seed N --brief "BRIEF" --ref FILE --dry-run`

2. Remove `--dry-run` when generation is requested. Inspect the resulting `plan.json`; create a new pack rather than editing a frozen plan.
3. Preview, then run rendering:

   `node utils/storylab-pack.mjs render output/storylab/prop-ID/plan.json --dry-run`

4. Optionally audit all six outputs:

   `node utils/storylab-pack.mjs review output/storylab/prop-ID/plan.json --dry-run`

Remove `--dry-run` only for the paid phase the user requested.

## Preserve the contract

- Lock silhouette, relative dimensions, seams, controls, materials, labels, and wear before style flourishes.
- Use the first generated front view as the anchor for later views; never daisy-chain every new view.
- Preserve all failed attempts and receipts. Never overwrite a view or silently retry.
- Do not promise readable microtext, exact measurements, functional safety, or product compliance from an image model.

Read [references/prop-pack.md](references/prop-pack.md) for input guidance. Read [`../../storylab/DETERMINISM.md`](../../storylab/DETERMINISM.md) when debugging, resuming, or evaluating reproducibility.
