---
name: storylab-element-library
description: Register, version, inspect, and verify reusable character, prop, and location Elements for deterministic StoryLab workflows. Use when a user wants an element library, reusable visual assets, a frozen character or object reference, a location lock, or wants to import a completed StoryLab character/prop pack before building connected sequences. Do not use to train a likeness model, silently replace an existing version, or generate a one-off image with no reuse requirement.
---

# StoryLab Element Library

Treat an Element as an immutable, content-addressed visual contract. Work from the repository root.

## Choose the registration path

- Import a completed StoryLab character or prop pack when it already has verified rendered views:

  `node utils/storylab.mjs element import PACK/plan.json --dry-run`

- Register 1–8 existing character, prop, or location references and have OpenRouter produce the strict continuity lock:

  `node utils/storylab.mjs element create --type location --id ID --brief "BRIEF" --ref FILE --dry-run`

For a real person's likeness, confirm the user has permission. Registration does not train a model or create an identity embedding.

## Register and verify

1. Run the chosen command with `--dry-run`. Dry-run performs no network call and writes nothing.
2. Remove `--dry-run` when the request is approved. `element import` is local-only. `element create` makes one OpenRouter analysis call unless `--analysis-file` is supplied.
3. Report the full returned address, `id@sha256`. Use that immutable address in sequence plans.
4. Inspect or verify before reuse:

   `node utils/storylab.mjs element inspect ID@HASH`

   `node utils/storylab.mjs element verify ID@HASH`

5. List the derived catalog with:

   `node utils/storylab.mjs element list`

An unversioned id resolves only when exactly one version exists. If two versions share an id, require `id@HASH`; never guess which one the user intended.

## Preserve the contract

- Do not edit `element.json`, copied references, or provenance. Register a new version when a lock or image changes.
- Repeating the identical registration is idempotent and returns the existing version.
- `index.json` is derived; do not treat it as the source of truth.
- Stop on a hash mismatch. Do not repair or replace a tampered image automatically.
- Keep generated `output/storylab/elements/` media local unless the user explicitly requests otherwise.

Read [references/element-library.md](references/element-library.md) for storage, selection, and versioning details. Read [`../../storylab/DETERMINISM.md`](../../storylab/DETERMINISM.md) when evaluating reproducibility or investigating a mismatch.
