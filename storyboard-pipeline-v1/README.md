# Storyboard Relay

A private local tool for turning a concept into an ordered AI-video sequence:

1. Reusable local directing templates produce a structured shot plan and continuity bible.
2. Higgsfield's Nano Banana 2 renders one storyboard image per shot, using the first frame as a continuity reference.
3. You drag the cards into the final order (or use the arrow buttons).
4. The server passes that exact sequence to Higgsfield and checks the final video's cost.
5. The final video is not generated until you approve the displayed credit estimate.
6. Higgsfield renders the sequence and the result appears in the local page.

The first ordered card becomes Higgsfield's `start_image`, the final card becomes
`end_image`, and every card between them is passed as an ordered image input.

## Run it

This project has no npm dependencies and no separate Gemini key. It only needs
Node 22+ and an authenticated Higgsfield CLI.

```sh
cd "/Users/eldw/Desktop/LL F26/storyboard-pipeline"
cp .env.example .env
```

Authenticate the Higgsfield CLI once:

```sh
higgsfield auth login
```

Then start the local interface:

```sh
npm start
```

Open <http://127.0.0.1:4177>. The server binds only to `127.0.0.1`, so it is not
exposed to other computers on the network.

## Test without spending credits

```sh
STORYBOARD_MOCK=1 npm start
```

Mock mode creates local placeholder frames so the board, ordering controls, and
responsive layout can be tested without calling Higgsfield. It does
not fake the cost or final-generation steps.

Run the automated checks with:

```sh
npm test
```

## Storage and safety

- Higgsfield credentials remain in the CLI's local credential store and are never sent to the browser.
- Storyboard plans, frames, upload references, and run state are stored under
  `data/<project-id>/` and are excluded from Git.
- Uploaded frame references are reused instead of charging or uploading again.
- The cost preflight is bound to the exact model, prompt, settings, and order.
  Changing any of them invalidates the confirmation token.
- A restrictive Content Security Policy prevents third-party scripts from
  running in the local page.

## Current video model

The final render currently uses Seedance 2.0 because it accepts explicit start
and end frames plus intermediate image references. Its model ID and limits live
in `lib/core.mjs`, so additional models can be added after their media-ordering
schemas are verified.

## Files

- `server.mjs` — local HTTP API and static server
- `public/app.js` — storyboard ordering, revision, preflight, and run UI
- `lib/storyboard.mjs` — deterministic shot templates and continuity planning
- `lib/higgsfield.mjs` — storyboard frames, upload, cost confirmation, and final render orchestration
- `lib/core.mjs` — validation and deterministic ordered CLI arguments
- `data/` — local private project state
