# StoryLab generation contract

This workflow reproduces decisions and provenance. It cannot guarantee that a hosted model will return identical bytes months later when a provider changes weights, inference code, or routing behind the same endpoint.

## Frozen inputs

- Source images are copied into the pack and recorded by SHA-256.
- OpenRouter must return one strict-schema continuity analysis. `plan.json` freezes that analysis, view taxonomy, provider/model identifiers, renderer parameters, and master seed.
- A plan hash covers every stable planning field. Rendering stops if those fields change.
- Prompts come from a versioned local compiler. Each compiled prompt is hashed.
- One uint32 fal seed is derived as the first 32 bits of SHA-256 over `master_seed`, `asset_id`, `view_id`, and attempt `0`.

## No hidden retries

Each view makes one fal submission. The fal queue receipt is saved before polling. If polling or download is interrupted, the next run resumes that request into a new attempt directory. A partial request without a saved receipt is not resubmitted automatically because the service may already have accepted it.

The OpenRouter review reports fixed violation codes but never repairs an image automatically. A future repair workflow should preserve the original, use an incremented explicit attempt, and compile prompt changes from a versioned violation-to-delta table.

## Reference policy

- Character and prop packs use original references for the first canonical view. Later views use the originals plus the first generated view as an anchor.
- Brief-only packs generate the first canonical view from text, then use it as the anchor.
- Shot grids always derive independently from the original scene. They never daisy-chain generated shots.
- The contact sheet is deterministic local SVG composition; the generative model never lays out or labels the sheet.

## Pack contents

```text
pack/
  plan.json
  planner/request.json
  planner/response.json
  source/ref-01.png
  render-manifest.json
  views/01-front/attempt-001/
    request.json
    fal-request.json
    response.json
    image-01.png
  provenance.json
  contact-sheet.svg
  reviews/review-001/
    request.json
    response.json
    review.json
```

Planner files differ slightly when `--analysis-file` is used. Secrets and embedded image bytes are redacted from saved request records.
