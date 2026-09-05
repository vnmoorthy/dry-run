# Dry Run

**No robot should touch a room it hasn't rehearsed in.**

Dry Run turns photos of a real room into a generative twin, lets you tap the drawers and doors that matter, then has a robot rehearse a plain-English chore inside that twin — every pick, place and drawer-open is a state change that a second screen sees at the same moment. Then it runs the same chore across N shuffled layouts and paints where the robot got stuck on the floor.

Track: **Physical AI & Simulation** — Spatial Intelligence + Generative 3D Hackathon (Founders, Inc., Fort Mason, Sept 5 2026).

| Sponsor | Role in the loop |
| --- | --- |
| **World Labs** | The room. A Marble world (`.spz` Gaussian splat) rendered with **Spark 2.0**; its **collider mesh** is rasterized into the occupancy grid the robot plans on. `scripts/worldlabs-generate.mjs` / `convex/worldlabs.ts` call the **World API** (`worlds:generate` → `operations` → `worlds/{id}`) from text or 4–8 phone photos. |
| **Tripo** | The robot. `scripts/tripo-robot.mjs` / `convex/tripo.ts`: text-to-model (P1, game-ready) → **rig-check** → **auto-rig** → **retarget** `preset:idle` + `preset:walk` → one animated GLB. Props via `--prop`. Falls back to a procedural mobile manipulator when no key is present. |
| **Mint** | The stuff in the room. Claude Code + **Mint MCP** generates the household **asset pack** and SFX (`docs/MINT.md`); `scripts/mint-sync.mjs` pulls the artifacts into `public/assets`. `convex/mint.ts` gives the live app a server-side generation path (`audio:generate`, `models:generate`). |
| **Convex** | The truth. Entities, robot pose, tasks (with per-step status), gauntlets and failure heat are one reactive query; the projector, every phone and the dashboard update together. Sponsor generation jobs live in a `jobs` table with `queued → generating → downloading → ready`. Optional Claude planner runs as a Convex action. |

## Run it

```bash
npm install
npm run dev            # http://localhost:5173  (offline mode: state in localStorage + BroadcastChannel)
```

Open `ledger.html?room=demo` in a second tab: it is the phone view. In offline mode it syncs across tabs of the same browser; go live to sync real phones:

```bash
npx convex dev         # creates a deployment, writes .env.local with VITE_CONVEX_URL, regenerates convex/_generated
npm run dev            # now the badge says "Convex · live" and the QR works on any phone
```

Deploy (live URL for the submission):

```bash
npx convex deploy --cmd 'npm run build'   # then host dist/ on Vercel/Netlify with VITE_CONVEX_URL set
npx convex env set WORLDLABS_API_KEY ... --prod
npx convex env set TRIPO_API_KEY ...      --prod
npx convex env set MINT_API_KEY ...       --prod
npx convex env set ANTHROPIC_API_KEY ...  --prod   # optional LLM planner (claude-sonnet-5)
```

## The loop

1. **Twin.** The world loads (starter attic, or your Marble world from `public/assets/manifest.json`). The collider is raycast on a 0.5-unit grid → free / blocked cells, floor height, drivable area (shown in the header).
2. **Handles.** Click a wall or cabinet face with **+ Drawer** / **+ Door** to mount an articulated fixture (prismatic slide / revolute hinge). **+ Item** and **+ Zone** drop objects and targets on any flat surface. Everything is a row in the store.
3. **Chore.** Type `put the blue bottle in the top drawer, then close it`. The planner (rule-based, or Claude via Convex) emits `navigate → pick → navigate → open → place → navigate → close`. The executor drives the robot: A* on the grid, string-pulled path, two-link arm reach, attach/detach, joint animation. Each step flips `queued → doing → done` in the ledger with a note (`arrived · 0.31 m from top drawer`).
4. **Verdict.** PASS with distance and time, or FAIL with the reason (`blocked by clutter at (1.2 m, 3.4 m)`, `top drawer is closed`, `no standing room within 0.9 m of shelf`).
5. **Gauntlet.** *Run variants* replays the last chore headlessly across N layouts (items shuffled to reachable cells + random clutter). Tiles flip green/red with reasons; failure points become red discs on the floor; click a tile to replay that layout in 3D.

## Layout

```
src/
  sim/        types · grid (rasterize, A*, smoothing) · planner (grammar) · evaluate (Gauntlet) · executor (state machine)
  world/      world (Spark splat + collider + grid) · props (items, drawers, doors, zones, labels)
  robot/      procedural mobile manipulator + Tripo GLB body with idle/walk clips
  data/       store: LocalStore | ConvexStore behind one interface
  app/        room view (store → three.js), seed, sfx
  ui/         projector HUD, phone ledger
convex/       schema, room/entities/tasks/gauntlets mutations, jobs, planner (Claude), worldlabs, tripo, mint actions
scripts/      pre-generation: worldlabs-generate.mjs · tripo-robot.mjs · mint-sync.mjs → public/assets/manifest.json
tests/        node --test: A*, planner grammar, Gauntlet determinism
```

`npm test` runs the simulation tests; `npm run typecheck` covers the app, `npx tsc -p convex/tsconfig.json` the backend.

## Bring your own room, robot and props

```bash
export WORLDLABS_API_KEY=...   # redeem WORLD-MODEL-HACK-API at platform.worldlabs.ai
node scripts/worldlabs-generate.mjs --images IMG_1.jpg IMG_2.jpg IMG_3.jpg IMG_4.jpg --name "Fort Mason lounge"
#   (same aspect ratio, 30–40 % overlap; or --prompt "..." ; --model marble-1.0-draft for 20-second iterations)

export TRIPO_API_KEY=tsk_...
node scripts/tripo-robot.mjs                                    # rigged + animated robot.glb
node scripts/tripo-robot.mjs --prop "ceramic coffee mug" --key mug

# Mint: see docs/MINT.md (Claude Code + Mint MCP asset pack), then
node scripts/mint-sync.mjs --from mint-assets.json
```

The app reads `public/assets/manifest.json` on load; the **Receipts** panel prints each asset's provider, model and ids so every sponsor's contribution is pointable on screen.

## Honest scope

- The twin is a **kinematic** rehearsal (paths, reach, articulation state), not a physics simulation. It answers "can the robot do this chore in this room, and where does it fail?" — the pre-flight, not the policy.
- Splats are static; items, fixtures and the robot are meshes over the splat with the Marble collider as ground truth (the same pattern as World Labs' own ICARE / Robot Roommates demos).
- Starters disclosed: the attic world + collider ship with [icurtis1/third-person-controller-splat](https://github.com/icurtis1/third-person-controller-splat) (MIT); the character-controller code was not reused — Dry Run's robot plans on a grid instead.

## Docs

- `docs/DEMO.md` — the two-minute script, reset and fallback plan
- `docs/MINT.md` — the Mint MCP workflow for stocking the room
- `docs/BUILD_LOG.md` — timestamped build log for the submission
