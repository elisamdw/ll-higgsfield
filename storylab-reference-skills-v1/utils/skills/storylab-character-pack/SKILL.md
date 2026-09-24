---
name: storylab-character-pack
description: Create a reproducible six-view character reference pack with OpenRouter continuity planning, seeded fal generation, a deterministic local contact sheet, and optional visual QA. Use for character sheets, reusable cast references, turnaround-like views, facial continuity, wardrobe locks, or identity-consistent story assets. Do not use to train a likeness model or to generate an untracked one-off portrait.
---

# StoryLab Character Pack

Create a frozen plan before rendering. Work from the repository root.

## Gather inputs

Require a stable asset id and explicit uint32 seed. Accept a written brief, 1–8 PNG/JPEG/WebP references, or both. For a real person's likeness, confirm the user has permission to use it. More varied reference photos improve observable coverage but this workflow does not train a model.

## Run the workflow

1. Preview planning without writes or network calls:

   `node utils/storylab.mjs plan character --id ID --seed N --brief "BRIEF" --ref FILE --dry-run`

2. Remove `--dry-run` when generation is requested. This makes one paid OpenRouter call and creates a new immutable pack. Never edit `plan.json` in place; create a new pack when the lock is wrong.
3. Inspect the frozen plan, then preview rendering:

   `node utils/storylab.mjs render output/storylab/character-ID/plan.json --dry-run`

4. Render with the same command without `--dry-run`. This makes one fal request per missing view and produces `contact-sheet.svg`. Rerun the command to skip completed views and resume saved queue receipts.
5. When continuity QA is useful, preview and then run:

   `node utils/storylab.mjs review output/storylab/character-ID/plan.json --dry-run`

The review is diagnostic. Do not silently regenerate failed views.

## Preserve the contract

- Treat the front full-body image as the generated anchor for later views.
- Preserve original references, all attempt directories, receipts, and responses.
- Do not claim pixel-level repeatability from hosted models. The workflow guarantees frozen inputs, prompts, seeds, and provenance.
- Do not use a generated character reference as proof of a real person's identity or attributes.

Read [references/character-pack.md](references/character-pack.md) for input guidance. Read [`../../storylab/DETERMINISM.md`](../../storylab/DETERMINISM.md) when debugging, resuming, or evaluating reproducibility.
