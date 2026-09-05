# Stocking the room with Mint (the agentic beat)

Mint is used the way its founder demos it: **an agent generates and assembles the 3D**. Claude Code talks to
Mint MCP, generates a themed asset pack plus sound effects, and writes the seed that places every item on the
collider floor. The MCP call log and the resulting `public/assets/manifest.json` diff are what you show the judges.

## 1. Connect Mint MCP to Claude Code

```bash
# redeem credits first: mint.gg/account → Redeem code → SPATIAL
claude mcp add --transport http mint https://mcp.mint.gg/mcp
# approve scopes: mint:read, mint:generate:start, mint:generate:approve  (approve is needed for review mode)
npx skills add mintdotgg/mint-threejs-skills -a claude-code -g -y
```

Add this to the project `CLAUDE.md` so the Mint Three.js skill does not fight the other sponsors:

> Marble (.spz + collider .glb) and Tripo (.glb) files under `public/assets/generated` are approved external inputs.
> Use Mint MCP for props, asset packs, animation sets and audio only.

## 2. Generate the pack (in a Claude Code session)

Prompt the agent:

> Use Mint MCP: `who_am_i`, check `get_credits_balance`, `create_project "Dry Run"`, then
> `start_asset_pack_generation` — asset pack type `general_asset_pack`, items: red mug, blue water bottle,
> green hardcover book, small potted plant, cereal box, soda can, shoebox, tray; style guide: "photoreal household
> objects, real-world scale, clean topology, ≤2k triangles each". Use automatic workflow. Loop `wait_for_many`
> (each call ≤ 60 s) until done; if the pack is `partially_succeeded`, approve the finished items and continue.
> Then `get_asset_artifact_manifests` for every item and save the JSON to `mint-assets.json`.
> Also `start_audio_generation` (sound_effect, 2 s) for: "small servo whir", "ceramic mug set down on wood",
> "wooden drawer sliding open on rails", "wooden drawer sliding shut" — save their manifests too.

Then:

```bash
node scripts/mint-sync.mjs --from mint-assets.json
```

That downloads each GLB/MP3 into `public/assets/generated/mint/` and appends `manifest.props[]` / `manifest.audio[]`.
Prop keys map to item **shapes** in the app (`mug`, `bottle`, `book`, `plant`, `box`, `can`) — an item whose shape or
tags match a prop key renders the Mint GLB instead of the procedural primitive. Audio keys `pick`, `place`, `open`,
`close`, `pass`, `fail`, `start` replace the synth cues.

## 3. Let the agent stock the room

Ask Claude Code to edit `src/app/seed.ts` so the seed uses the pack items (names, shapes, sizes from the manifest
bounds). That file is the "the agent stocked the room" diff in the demo.

## Mint REST (no MCP session at hand)

```bash
export MINT_API_KEY=...          # platform.mint.gg
node scripts/mint-sync.mjs --pack "household objects: mug, bottle, book, plant, box, can" --count 6
node scripts/mint-sync.mjs --sfx "small servo whir" --key pick --seconds 2
```

The deployed app can also generate live through Convex (`api.mint.generate`, see `convex/mint.ts`): a two-second
sound effect is a safe on-stage generation because audio has no preview/approval step.

## Notes

- Mint GLBs are Draco-compressed; the app's loader is configured with a Draco decoder.
- Credits: one standard model ≈ 800 credits, a 20-item pack can exceed a fresh balance — check `get_credits_balance`
  first and prefer 6–8 items.
- Animation sets from Mint (`list_model_animations`) arrive as separate clips; the robot body loader looks for clips
  named like `idle` / `walk` and logs every clip name on load.
