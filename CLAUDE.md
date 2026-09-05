# Dry Run — notes for coding agents

- Stack: Vite + TypeScript, three 0.180 (pinned — Spark 2.0 breaks on newer three), @sparkjsdev/spark 2.0, Convex.
- `npm run typecheck`, `npx tsc -p convex/tsconfig.json`, `npm test` must stay green.
- The store (`src/data/store.ts`) is the only way state changes; never mutate `RoomState` objects in place.
- Sponsor assets: Marble `.spz` + collider `.glb` (World Labs) and Tripo `.glb` files under `public/assets/generated`
  are **approved external inputs**. Use Mint MCP for props, asset packs, animation sets and audio only
  (`docs/MINT.md`); never replace the World Labs or Tripo pipeline with Mint.
- Keys are server-side only (Convex env / shell env for `scripts/`). Never put a key in `src/` or `public/`.
- Debug in the browser console: `dryrun.fastForward(20)` advances the simulation 20 s without waiting for frames;
  `dryrun.world.grid` is the occupancy grid; `dryrun.store.getState()` is the room.
- Demo rules of thumb: one reliable path, visible Reset, fallback recording. Don't add features on the day that
  touch the executor without running `npm test` and a full chore in the browser.
