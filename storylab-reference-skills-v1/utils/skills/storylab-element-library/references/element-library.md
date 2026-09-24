# Element Library contract

## Supported types

- `character`: appearance, proportions, hair, wardrobe, accessories, and identity continuity.
- `prop`: silhouette, construction, materials, markings, wear, and working parts.
- `location`: architecture, geography, landmarks, materials, entrances, lighting sources, and scale.

Import accepts completed character and prop packs. Register locations from one or more existing images with `element create` because a pack has no location view taxonomy in v1.

## Addressing and storage

An Element is addressed as `id@element_sha256`. The SHA-256 covers its type, canonical id, brief, continuity analysis, origin, reference roles and hashes, reference-selection policy, and planner contract. Creation time and provider response metadata do not affect identity.

```text
output/storylab/elements/
  index.json
  element-id/
    full-sha256/
      element.json
      source/
      references/
      planner/
      provenance.json
```

`index.json` can be rebuilt from version directories. `element.json` and the hashed reference files are authoritative.

## Reference selection

Connected sequences reserve two of eight reference slots for first-frame and previous-frame anchors. The planner therefore selects no more than six Element master images. It allocates one reference to every selected Element before allocating second references, using canonical roles first. This keeps every Element represented and makes truncation deterministic.

## Failure rules

- Reject missing, unsupported, empty, or over-50-MB images.
- Reject reference paths outside the immutable version directory.
- Reject changed manifest or image hashes.
- Require an explicit hash when an id has multiple versions.
- Never overwrite an existing version or silently select a newer one.
