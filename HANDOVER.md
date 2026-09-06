# HANDOVER — Dry Run (Spatial Intelligence + Generative 3D Hackathon)

Read this first if you are an AI assistant (ChatGPT, Cursor, Claude, Codex) or a teammate picking up this repo.
It contains everything the previous session knew: the event, the judges, the product, the architecture, what is
verified, what is not, and the exact next steps. Repo root: `/Users/moorthy/Downloads/Projects/founders_inc_hack`.

> **Paste-ready prompt for a new assistant:**
> "You are continuing a hackathon project called Dry Run. Read `HANDOVER.md` fully, then `README.md`, `docs/DEMO.md`,
> `docs/SUBMISSION.md`, and `CLAUDE.md`. Do not change the architecture. Keep `npm run typecheck`,
> `npx tsc -p convex/tsconfig.json`, and `npm test` green after every change. The demo is a 2-minute live run on a
> projector with judges' phones on the ledger page. Priorities in order: (1) keep the offline demo working, (2) swap in
> real World Labs / Tripo / Mint assets via the scripts, (3) get Convex live for phones, (4) polish. Ask me before
> deleting or rewriting any file under `src/sim/`."

---

## 1. The event (ground truth)

- **Spatial Intelligence + Generative 3D Hackathon** with Mint, Tripo, World Labs, Convex and Founders, Inc.
  One day, Sept 5 2026, Founders Inc campus, Fort Mason, San Francisco. Hacking 10:00–18:00, two-minute demos 18:00–19:00.
- **Tracks:** Gaming & Interactive Worlds · **Physical AI & Simulation (ours)** · Creative 3D & VFX.
  Physical AI definition: "robotics, embodied agents, spatial reasoning, digital twins, or simulation with clearly visible state changes."
- **Prizes:** top two per track get $1k World Labs + $1k Tripo + $1k Mint credits; Convex gives a membership per track winner.
- **Organizers' rubric (from the resources page):** one track, one user interaction, one visible outcome; smallest end-to-end
  version first; short setup/loading/reset; test on the presentation device and keep a fallback recording. Demo checklist:
  state the problem, track and loop; show the working experience before explaining; name each sponsor's role; one reliable
  path, visible reset, fallback recording.
- **Submission form (Notion):** name + teammates, email used to sign up, project description, project link. Live link
  strongly preferred (Convex judges: "not localhost"; Founders Inc: "no slides, no localhost").
- **Judges / partner presenters and what they care about**
  - Ian Curtis (World Labs, "World Builder", author of the third-person-controller-splat starter): browser-native splat
    experiences, Spark 2.0, colliders, embodied movement, XR.
  - Aiko Dai (Tripo, marketing): rigged + animated Tripo characters, segmentation doing real work, game-ready meshes.
  - Tamrat Alemanu (mint.gg founder): an agent that CREATES and ASSEMBLES 3D via Mint MCP; asset packs; "everything you see is generated".
  - Mike Cann / Wayne Sutton (Convex): a live deployed URL, real-time sync across devices, agents whose tools mutate the world; refresh mid-demo and nothing is lost.
  - Stavan Patel (Founders Inc Creative Director), Mike Shin (Founders Inc COO): taste, story, a sharp founder point of view, real-world usefulness.
- **Founders Inc angle:** they list "a unique point of view" as a criterion; no decks; conversions to funding happen through
  campus time. Blueprint II applications close **Sept 14 2026**. Closing ask in the demo: "we'd like to keep building this at
  Fort Mason for two weeks and apply to Blueprint II by the 14th."
- **What has won before at these events:** real input → twin → visible state change → second device; an agent doing work in
  the world. What loses: "walk around a generated world" viewers (judges have seen ~45 of them).
- **Codes from the resources page:** Mint `SPATIAL` (mint.gg/account → Redeem); Marble subscription `WORLD-MODEL-HACK` /
  `WORLD-MODEL-HACK2`; 30K Marble credits `WORLD-MODEL-HACK3`; **API** code `WORLD-MODEL-HACK-API` at platform.worldlabs.ai.
  Venue Wi-Fi: `Founders Inc-Guest` / `fincevents!`.

## 2. The product in one paragraph

**Dry Run**: "No robot should touch a room it hasn't rehearsed in." Photos of a real room become a World Labs Marble twin
(Gaussian splat + collider). The user taps drawers/doors onto the twin (articulated fixtures: prismatic / revolute), drops
items and target zones, and types a chore in plain English. A robot plans on the collider's occupancy grid, drives,
picks, opens, places, closes; every step flips `queued → doing → done` on the projector and on every phone at the same
moment, ending in PASS or a FAIL reason. **Gauntlet** replays the chore across the room as-is plus N shuffled layouts with
clutter, paints failure heat on the floor, and replays any layout in 3D. It merges four ideas from the ideation round:
Dry Run (core), Handles (affordances), Gauntlet (evaluation), Shift (fleet/warehouse — deferred, not built).

Sponsor roles (must be pointable on screen):
- **World Labs** — the room (Marble world via World API, rendered with Spark 2.0); the collider is the simulator state.
- **Tripo** — the robot (text-to-3D → rig-check → auto-rig → retarget idle/walk) and optional props.
- **Mint** — the props/SFX generated by Claude Code through Mint MCP ("the agent stocked the room").
- **Convex** — one reactive query for entities/tasks/gauntlets/heat, a second for the 4 Hz robot pose; every step is a mutation; jobs table for sponsor generation.

## 3. Current state (verified)

Verified in the browser (offline mode, starter world) and by tests as of the last session:
- Chores: `put the red mug on the shelf`, `put the blue bottle in the top drawer, then close it` (7 steps incl. prismatic
  joint), `bring me the green book` → `put it on the table` (carry-over between chores), `put the red mug and the blue
  bottle on the shelf` (conjunction), `open the top drawer, put the mug in it and close it` (pronouns + fixture state),
  `grab the bottle`, `open the cabinet door` (revolute).
- Tools: click-to-add drawer/door/item/zone, Robot start, Select/remove, Reset (two-step button), Stop robot (releases the held item).
- Gauntlet: 6 variants headless, tiles + first-failure reason line, heat discs, replay-in-3D with clutter boxes.
- Phone ledger (`ledger.html?room=demo`): live steps, "Up next" queue, DPR-correct top-down map, Gauntlet tiles, history; iOS-sized viewport checked.
- Reload mid-chore: held item is put down, chore re-queues and resumes.
- `npm test` 16/16; `npm run typecheck` and `npx tsc -p convex/tsconfig.json` clean; `npm run build` OK (main chunk ≈5.6 MB because of three + Spark).
- A 5-lens code review with adversarial verification was run; all confirmed findings are fixed (commit `87d5f5b`).

**Not verified / not done (in priority order):**
1. **No real sponsor assets yet.** `public/assets/manifest.json` does not exist. The app runs on the starter attic world
   (from Ian Curtis's template, MIT, disclosed), a procedural robot body, and synth SFX. The scripts to generate real assets
   exist but were never executed (no API keys in this environment). Sponsor API modules were checked against the live docs
   by reviewers but **never run**.
2. **Convex never ran.** `npx convex dev` needs an interactive login. `convex/_generated/*` is hand-authored to match codegen;
   `npx convex dev` will regenerate it. The ConvexStore client path is untested live.
3. **No fallback recording.** Record one at ~16:00 from the deployed URL with a phone in frame.
4. **Docs/BUILD_LOG.md timeline is a template** — fill in real timestamps.
5. Nice-to-haves not built: Convex presence FacePile, Convex Agent component ("Butler"/"Foreman" NPC), USDZ export of
   the robot for AR Quick Look, SplatEdit carve where a fixture is mounted, Shift (warehouse fleet) mode.

## 4. Run / test / build

```bash
npm install
npm run dev                      # http://localhost:5173  (offline mode; badge "Local · offline")
open http://localhost:5173/ledger.html?room=demo   # phone view; in offline mode it syncs tabs of the same browser
npm test                         # node --import tsx --test tests/*.test.ts
npm run typecheck                # tsc for src/
npx tsc -p convex/tsconfig.json  # tsc for convex/
npm run build                    # vite build → dist/ (index.html + ledger.html)
```

URL flags: `?room=<slug>` (room name), `?local=1` (force offline even if VITE_CONVEX_URL is set), `?stage=1` (bigger HUD).
Keys: `Esc` select tool, `F` follow camera, `L` labels, `S` stage zoom.

Browser console debug handle (set in `src/main.ts`):
```js
dryrun.fastForward(20)      // advance the simulation 20 s without waiting for frames (used for smoke tests)
dryrun.store.getState()     // the room
dryrun.store.submitTask('put the red mug on the shelf', 'console')
dryrun.executor.abort()     // Stop robot
dryrun.world.grid           // occupancy grid {cols, rows, cell, floorY, cells: Uint8Array 0 free/1 blocked/2 void}
```
Note: in a hidden/background tab `requestAnimationFrame` is throttled, so the robot looks frozen; use `fastForward` there.
The splat's LoD build takes ~30 s on first load ("Decoding Marble splat…" pill); everything else works before it finishes.

## 5. Architecture and file map

```
index.html / ledger.html            two Vite entries (projector app, phone ledger)
src/main.ts                         boot: renderer → store → world → robot → room view → executor → HUD; click tools; Gauntlet; replay; reset
src/sim/types.ts                    shared domain types (Entity = Item | Fixture | Zone, Task, Step, RobotPose, Gauntlet, RoomState, AssetManifest)
src/sim/grid.ts                     occupancy grid from a sampler, inflate, A* (8-conn, no corner cutting), lineOfSight, smoothPath, findApproachCell, rng
src/sim/planner.ts                  rule-based grammar: put/place/move/bring/take…, open/close, go to, fetch/get/grab/bring me, tidy <zone>; pronouns,
                                    conjunctions, plurals, "all", ambiguity ("Which one: …?"), robot.carrying, fixture openness across clauses; stepsFromLlm()
src/sim/evaluate.ts                 headless trials: gridWithEntities, startCellFor, interactionPoint, makeVariantLayout, runTrial, runGauntlet, findBlocker, blockerReason
src/sim/executor.ts                 state machine: claims queued tasks, plans (LLM via store.plan → fallback local), navigate/pick/place/open/close,
                                    writes steps/results/pose to the store; abort() releases held item; resumeAfterReload(); sub-stepped tick()
src/world/world.ts                  Spark SplatMesh + collider GLB (ShadowMaterial), floor estimate, raycasts, grid rasterization
src/world/props.ts                  procedural items (mug/bottle/book/plant/ball/can/box/crate), drawer (prismatic) & door (revolute) views, zones, labels, heat discs; GLB props via manifest
src/robot/robot.ts                  Robot controller (path following, facing, attach/detach) + ProceduralBody (2-link IK arm, LED) + GltfBody (Tripo GLB with idle/walk clips)
src/app/room.ts                     RoomView: store → three.js reconciliation, fixture animations, highlight, pickables, `locked` set
src/app/seed.ts                     seed layout on reachable cells: red mug, blue bottle, green book, zones shelf/table, "top drawer"
src/app/sfx.ts                      WebAudio synth cues; Mint audio from manifest overrides them
src/data/store.ts                   Store interface; LocalStore (localStorage + BroadcastChannel, versioned commits); ConvexStore (anyApi, getState + getRobot subscriptions, plan())
src/ui/hud.ts / hud.css             projector HUD (tools, Gauntlet, room list, receipts, ledger, robot, QR/offline note, controls); currentTask(); stage zoom
src/ledger.ts / ui/ledger.css       phone page
convex/schema.ts                    rooms, robots, entities (data: discriminated union), tasks (steps[], result, layoutBefore), gauntlets, jobs
convex/room.ts                      ensure, getState, getRobot, setHeat, setWorld (clears room), applyWorld (internal), reset
convex/entities.ts, tasks.ts, gauntlets.ts, robot.ts, jobs.ts   mutations/queries used by ConvexStore (arg names: slug, entity, id, patch, pose, text, source, gauntlet, heat, world, entities, robot)
convex/planner.ts ('use node')      Claude planner action (ANTHROPIC_API_KEY, model claude-sonnet-5, tool_choice submit_plan); empty plan → client falls back
convex/worldlabs.ts ('use node')    generateWorld → startWorldJob → pollWorldJob (10 s) → downloadWorld → storage → room.applyWorld
convex/tripo.ts ('use node')        generateRobot → step state machine (generate → rig-check → rig → retarget) → finish (download within 5-min URL expiry)
convex/mint.ts ('use node')         generate (model | audio | asset-pack) → poll (statuses) → model GLB via /models/{id}.assets.glbUrl, audio via artifacts
convex/_generated/*                 hand-authored to match codegen; `npx convex dev` regenerates
scripts/lib.mjs                     arg parsing, manifest read/write, download into public/assets/generated
scripts/worldlabs-generate.mjs      --prompt | --images a.jpg b.jpg … | --world <id>; writes manifest.world
scripts/tripo-robot.mjs             robot (rigged, animated) or --prop "…" --key mug; writes manifest.robot / manifest.props[]
scripts/mint-sync.mjs               --from mint-assets.json (from an MCP session) | --pack | --model | --sfx; writes manifest.props[] / manifest.audio[]
tests/sim.test.ts                   A*, planner grammar, Gauntlet determinism/clutter, stepsFromLlm
docs/DEMO.md                        2-minute script, prep checklist, failure table
docs/SUBMISSION.md                  form text
docs/BUILD_LOG.md                   disclosed starters + timeline template
docs/MINT.md                        Mint MCP workflow for stocking the room
CLAUDE.md                           conventions for agents; Mint skill vs other sponsors
netlify.toml                        build = `npx convex deploy --cmd 'npm run build'`, publish = dist
.claude/launch.json                 dev server config for the Claude browser pane
```

Key data flow: **Store is the single source of truth.** The projector tab runs the Executor (the only writer of robot pose
and step transitions). The ledger page is a viewer that can submit tasks. In Convex mode `room.getState` (big) and
`room.getRobot` (small, 4 Hz) are separate queries. `RoomView.locked` prevents store re-sync from fighting an in-flight
manipulation (held item, animating fixture).

Coordinate conventions: world units; starter world scale 5, `metersPerUnit` 0.4 (so a 0.5-unit grid cell = 20 cm).
Yaw = rotation about +Y, robot forward is +Z (`atan2(dx, dz)`). Floor Y is estimated from downward raycasts on the collider.
Reach = 2.2 units, approach factor 0.9 (shared by executor and headless evaluator via `TrialConfig`).

## 6. Sponsor API contracts (as verified against live docs by the review; none executed yet)

**World Labs World API** — base `https://api.worldlabs.ai/marble/v1`, header `WLT-Api-Key`.
`POST /worlds:generate` `{ model: 'marble-1.1' | 'marble-1.1-plus' | 'marble-1.0-draft', display_name, world_prompt }` where
world_prompt is `{type:'text', text_prompt}` | `{type:'image', image_prompt:{source:'uri'|'media_asset', …}, is_pano:'auto'}` |
`{type:'multi-image', multi_image_prompt:[{content:{source:'media_asset', media_asset_id}}…], reconstruct_images:true}`.
→ `{operation_id}`; `GET /operations/{id}` → `{done, response:{world_id}, metadata:{progress}}`; `GET /worlds/{id}` →
`assets.splats.spz_urls {100k, 500k, full_res}`, `assets.mesh.collider_mesh_url`, `assets.splats.semantics_metadata
{metric_scale_factor, ground_plane_offset}`, `world_marble_url`. Uploads: `POST /media-assets:prepare_upload {file_name, kind:'image', extension:'jpg'}`
→ `{media_asset:{media_asset_id}, upload_info:{upload_url, required_headers}}` then PUT bytes. ~5 min per world, ~1,500 credits,
rate limit ~3 starts/min. Splats use the `marble_raw_opencv` frame: if the world is upside-down, rotate the SplatMesh 180° about X.
Never call from the browser; signed URLs expire — the app copies files to Convex storage / `public/assets/generated`.

**Tripo API v3** — base `https://openapi.tripo3d.ai/v3`, `Authorization: Bearer tsk_…`.
`POST /generation/text-to-model {prompt, model:'P1-20260311'|'v3.1-20260211', face_limit, texture:true, pbr:true}` → `{code:0, data:{task_id}}`;
`GET /tasks/{id}` → `data.{status:'success'|'failed'|…, progress, output.{model_url, pbr_model, rendered_image_url, riggable, rig_type}, credits_consumed, error_message}`;
`POST /animations/rig-check {input}` (free); `POST /animations/rig {input, model:'v2.5-20260210', rig_type, spec:'tripo', out_format:'glb'}`;
`POST /animations/retarget {input, animations:['preset:idle','preset:walk'] (quadruped: 'preset:quadruped:walk'), animate_in_place:true, out_format:'glb', bake_animation:true}`.
**Model URLs expire ~5 minutes after success** — download immediately. Free API signup ≈300 credits (≈3 full robot pipelines).

**Mint REST** — base `https://api.mint.gg/v1`, `Authorization: Bearer MINT_API_KEY`.
`POST /models:generate {prompt, name, generationMode:'auto'}`, `POST /asset-packs:generate {prompt, itemCount 2–25, assetPackType, styleGuide, name}`,
`POST /audio:generate {prompt, name, audioKind:'sound_effect', durationSeconds}` → operation `{id}`; `GET /operations/{id}` →
`{status: queued|running|preview_ready|billing_required|succeeded|partially_succeeded|failed|canceled, resource:{id, type: model|asset_pack|audio…}}`;
`GET /models/{id}.assets.glbUrl`; `GET /asset-packs/{id}.items[].modelId`. Mint MCP: `https://mcp.mint.gg/mcp` (OAuth; scopes
mint:read, mint:generate:start, mint:generate:approve). Mint GLBs are Draco-compressed (loader has a decoder configured).
One standard model ≈800 credits; check the balance before a big pack.

**Convex** — free plan is fine; set keys with `npx convex env set KEY value` (add `--prod` for prod). `'use node'` files may
only export actions; long polls are chains of scheduled actions (never >10 min per action).

**Anthropic (optional planner)** — `ANTHROPIC_API_KEY`; model `claude-sonnet-5`; the client rejects empty plans and falls back to the grammar.

## 7. Next steps (do these in order)

1. **Real world**: `export WORLDLABS_API_KEY=…` then
   `node scripts/worldlabs-generate.mjs --images IMG_1.jpg … IMG_6.jpg --name "Fort Mason lounge"` (same aspect ratio, 30–40 % overlap)
   and in parallel a text fallback `--prompt "small apartment kitchen, counter, table, lower cabinets with drawers, eye level"`.
   Check: robot stands on the floor (tune `metersPerUnit` / `scale` in `public/assets/manifest.json`), splat not upside-down.
   Commit `public/assets/manifest.json` and the collider; the `.spz` is git-ignored by default (`.gitignore`) — un-ignore it or host it.
2. **Real robot**: `export TRIPO_API_KEY=…` then `node scripts/tripo-robot.mjs`. On load the app logs the GLB clip names;
   if they differ from `preset:idle` / `preset:walk`, set `manifest.robot.clips`. The GltfBody has no arm; the item attaches to a
   chest anchor — acceptable, but the procedural body is more legible for "pick". Consider a prop: `--prop "ceramic coffee mug" --key mug`.
3. **Mint**: follow `docs/MINT.md` (Claude Code + Mint MCP asset pack of household items + 4 SFX), then `node scripts/mint-sync.mjs --from mint-assets.json`.
   Prop keys map to item shapes (`mug`, `bottle`, `book`, `plant`, `box`, `can`); audio keys `pick|place|open|close|pass|fail|start`.
   Show the MCP call log + manifest diff during the demo ("the agent stocked the room").
4. **Convex live**: `npx convex dev` (login, creates deployment, writes `.env.local`), `npm run dev`, confirm the badge says
   "Convex · live" and a phone on the QR sees steps flip. Then `npx convex deploy --cmd 'npm run build'`, host `dist/` on Netlify/Vercel
   with `VITE_CONVEX_URL` set, `npx convex env set … --prod` for keys. Test on venue Wi-Fi AND a phone hotspot.
5. **Rehearse** `docs/DEMO.md` three times with a stopwatch; record the fallback video; fill `docs/BUILD_LOG.md`; paste `docs/SUBMISSION.md`.

## 8. Gotchas the previous session hit

- Spark 2.0 pins `three@0.180.0`; do not bump three. `SplatMesh({url, lod:true, raycastable:false, onProgress})`.
- Items placed next to the robot block its own grid cell → `startCellFor()` frees the robot's cell (keep it).
- Form Enter didn't submit in the kiosk browser → explicit keydown handler exists; keep it.
- `let` declared after `store.subscribe(render)` caused a TDZ crash in the ledger; declarations go first.
- Convex `'use node'` files cannot define mutations; `internal.room.applyWorld` lives in `convex/room.ts`.
- Action handlers that call `internal.*` in the same module need explicit `Promise<Id<'jobs'>>` return annotations (circular types).
- The robot heartbeat must not live on the `rooms` document, or every phone re-runs the big query 4×/s (hence the `robots` table).
- Hidden tabs throttle rAF; the executor sub-steps `tick(dt)` at ≤1/50 s so motion stays frame-rate independent.
- Keep `RoomView.locked` semantics when adding manipulations; otherwise store re-sync snaps objects back mid-animation.

## 9. Ideas already considered (don't re-derive)

Ideation ran a 24-idea tournament; the chosen direction merges four Physical AI ideas. Deferred: **Shift** (warehouse fleet
re-routing with a picks/hour meter), Convex Agent NPC with tools that move the robot, SplatEdit carve where fixtures mount,
USDZ take-home export, multi-room "digital cousins" across judges' phones as sim workers. Only add these after steps 1–5 above.

## 10. Git

Branch `main`. Remote: https://github.com/vnmoorthy/dry-run (owner vnmoorthy). Live demo on GitHub Pages:
https://vnmoorthy.github.io/dry-run/ (branch `gh-pages` = `dist/` built with `VITE_BASE=/dry-run/ npm run build`; redeploy by
rebuilding and force-pushing `dist/` to `gh-pages`). `src/sim/types.ts#assetUrl()` resolves public assets against the Vite base.
`dist/`, `.env*`, `.convex`, `public/assets/generated/*.spz|*.ply` are ignored.
