# Connected Sequence contract

## Scope

Version 1 produces 2–8 ordered still frames from 1–4 immutable Elements. It supports story-derived beats or creator-supplied manual beats. It deliberately excludes video generation, interpolation, automatic repair, likeness training, and face swapping.

## Frozen plan fields

The strict OpenRouter plan records global style, time and lighting, geography, initial character/prop/environment state, and for every frame:

- beat and action;
- framing, lens, angle, and implied camera movement;
- emotional state and subject positions;
- prop state and ownership;
- environment changes;
- the only allowed delta from the prior frame.

Every selected Element is copied into the sequence as a manifest snapshot with its full content hash and selected master-image hashes.

## Eight-image reference budget

- Up to six slots: frozen Element masters, selected deterministically across all Elements.
- Frame 1: masters only.
- Frame 2: masters plus frame 1.
- Frames 3–8: masters plus frame 1 plus the previous frame.

Element masters always remain present; generated anchors supplement them and never replace them. Frames render sequentially because the next request depends on the previous output.

## Review codes

The reviewer can report only:

`element_drift`, `identity_drift`, `wardrobe_drift`, `prop_state_drift`, `location_drift`, `screen_direction_error`, `lighting_discontinuity`, `action_discontinuity`, `camera_mismatch`, `duplicate_frame`, and `text_or_watermark`.

Reviews have one result per frame and one per adjacent transition. A pass cannot contain violations; a failure must contain at least one fixed code.

## Resumption and failure

Each fal submission saves its queue receipt before polling. If a run stops after submission, rerun the command to resume that receipt into a new attempt directory. If a partial attempt has no receipt, stop for human inspection because the provider may already have accepted the job. Never overwrite outputs or auto-submit a replacement.
