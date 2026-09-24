---
name: storylab-connected-sequence
description: Plan, render, and audit a deterministic 2–8-frame connected storyboard sequence from 1–4 immutable StoryLab Elements. Use for sequential visual storytelling, connected shots, action continuity, storyboard beats, screen direction, prop state, location geography, or character continuity across still frames. Do not use for video generation, a single unconnected image, or sequences whose reusable characters, props, and locations have not been registered as Elements.
---

# StoryLab Connected Sequence

Build a frozen still-frame storyboard before considering animation. Work from the repository root.

## Establish inputs

Require:

- a stable sequence id and explicit uint32 seed;
- 1–4 verified Elements, preferably addressed with full `id@sha256` values;
- either a story plus exact frame count from 2 through 8, or a JSON file containing 2–8 manual beats.

If an Element is missing, use `$storylab-element-library` first. Do not substitute a loose image for an Element inside sequence planning.

## Plan

Preview story-based planning:

`node utils/storylab.mjs sequence plan --id ID --seed N --frames 6 --story "STORY" --element character@HASH --element location@HASH --dry-run`

Or use manual beats:

`node utils/storylab.mjs sequence plan --id ID --seed N --beats-file beats.json --element character@HASH --element location@HASH --dry-run`

Remove `--dry-run` to make one OpenRouter call and freeze the plan. Inspect `plan.json`, the Element snapshots, initial state, every frame's camera/action/positions/prop state, and allowed deltas before rendering. Never edit a frozen plan; create a new sequence directory instead.

## Render in order

Preview the exact prompts and reference counts:

`node utils/storylab.mjs sequence render output/storylab/sequences/ID/plan.json --dry-run`

Remove `--dry-run` to render sequentially. Every frame receives the frozen Element masters. Frame 1 receives no generated anchor; later frames receive frame 1, and from frame 3 onward also the immediately previous frame. Rerunning skips completed frames and resumes saved fal receipts without silently resubmitting them.

The output is still images plus a local `storyboard.svg` and `continuity-ledger.json`. This skill does not generate or assemble video.

## Review

After all frames exist, preview and run the diagnostic audit:

`node utils/storylab.mjs sequence review output/storylab/sequences/ID/plan.json --dry-run`

The reviewer audits both individual frames and adjacent transitions using fixed violation codes. It never regenerates failed frames. Retain failures and provider records; any repair must be a future explicit, versioned attempt.

Read [references/connected-sequence.md](references/connected-sequence.md) for the frame contract, reference budget, and QA codes. Read [`../../storylab/DETERMINISM.md`](../../storylab/DETERMINISM.md) when resuming or evaluating reproducibility.
