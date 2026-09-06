# Submission (paste into the Notion form)

**Name + teammates:** _fill in_

**Email signed up with:** _fill in_

**Track:** Physical AI & Simulation

**Project link:** _live URL_ (phone ledger: `<live URL>/ledger.html?room=demo`) · repo: _GitHub URL_ · fallback video: _link_

## Project description

**Dry Run — rehearse a robot's chore in a twin of the real room before it touches anything.**

Photograph a room, tap the drawers and doors that matter, type a chore in plain English. A robot rehearses it inside a
World Labs Marble twin of that exact room: it plans on the Marble collider, drives, picks, opens a prismatic drawer,
places, closes — and every step flips `queued → doing → done` on the projector and on every judge's phone at the same
moment. Then *Gauntlet* replays the chore across the room as-is plus five shuffled layouts with random clutter and paints where
the robot got stuck on the floor: for home robots, evaluation per customer room is the bottleneck, and today it takes days of
hand-built sim per site.

**One interaction:** type a chore. **One visible outcome:** the robot does it (or fails with a reason) and the ledger
on your phone agrees with the projector.

**Sponsor roles**
- **World Labs** — the twin: Marble world (World API, text or 4–8 phone photos) rendered with Spark 2.0; the collider
  mesh is rasterized into the occupancy grid the robot plans on. World id in the Receipts panel.
- **Tripo** — the robot: text-to-3D (P1) → rig-check → auto-rig → retargeted idle/walk; props via image/text-to-3D.
- **Mint** — the room was stocked by Claude Code through Mint MCP (asset pack + SFX); `scripts/mint-sync.mjs`.
- **Convex** — one reactive query drives every screen; entities, robot pose, tasks with per-step status, gauntlets,
  heat and sponsor generation jobs are tables; refresh mid-run and the room comes back with the chore re-queued. Optional Claude planner as an action.

**What's new work vs. starters:** everything in `src/`, `convex/`, `scripts/`, `tests/`. The starter attic world
(`attic.spz`, `collider.glb`) ships with Ian Curtis's third-person-controller-splat template and is the fallback room.

**Build log:** see `docs/BUILD_LOG.md`.

**Point of view:** the simulator is now a phone camera; the bottleneck is what the robot decides to do in *your* room.
Rehearsal, not training, is the product. Next: export the approved rehearsal as a task spec a real robot stack consumes.
