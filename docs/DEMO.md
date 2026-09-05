# The two-minute demo

Organizers' rubric: state the problem, track and loop; **show the working thing before explaining it**; name each
sponsor's role; keep one reliable path, a visible reset and a fallback recording. Founders Inc: no slides, no localhost.

## Before you walk up

- Live URL open on the laptop **and** loaded (the splat LoD build takes ~30 s — never open it cold on stage).
- Phone with `ledger.html?room=<slug>` already open; a second phone/tablet is a bonus.
- Room reset to the seed (`Reset room`), robot idle, `Follow` on, `Labels` on.
- Fallback recording (`docs/fallback.mp4`) queued in a second window.
- Convex dashboard → Data → `tasks` open on the second monitor if there is one.

## Script

**0:00 — Problem (10 s).**
"No robot should touch a room it hasn't rehearsed in. Every home-robot team we talked to builds a sim per customer
site by hand, and it takes days. This is Dry Run — Physical AI track. One interaction: type a chore. One outcome: the
robot rehearses it in a twin of *this* room, and every step lands on your phone."

**0:10 — The room (10 s).**
Point at the projector. "Six phone photos of this space at 10:05, reconstructed by the World Labs World API. The grey
header line is the collider rasterized into 20 cm cells — the world isn't pixels, it's state the robot plans on."

**0:20 — The chore (35 s).**
Type `put the blue bottle in the top drawer, then close it` → Rehearse.
While it drives: "Planner turned that into seven steps. Watch the ledger." As the drawer slides: "That drawer is an
articulated fixture we tapped onto the cabinet face — a prismatic joint. World Labs lists articulated objects as an open
limitation of generated worlds; this is the affordance layer on top."
When PASS lands, hold the phone up: "Same document, same second, on the judge's phone."

**0:55 — Where it fails (25 s).**
Click **Run variants** (6). "Same chore, six layouts, random clutter — evaluation, not training, is the bottleneck."
Tiles flip; red discs appear on the floor. Read one reason aloud: "blocked by clutter at 1.2 m, 3.4 m — that's the
gap a real robot would get stuck in." Click a red tile: "Replay it in 3D" (let it start driving).

**1:20 — Sponsors, one line each (20 s).**
- "World Labs: the twin and its collider, rendered with Spark; Marble world id in the receipts."
- "Tripo: the robot — text to 3D, auto-rigged, retargeted idle and walk." (If the procedural body is on screen say so:
  "the rigged Tripo body is the swap in the manifest.")
- "Mint: Claude Code stocked the room through Mint MCP — asset pack and the SFX you heard."
- "Convex: one reactive query drives the projector, every phone and the dashboard; every step is a mutation; you can
  refresh mid-run and nothing is lost." (Refresh the tab. It comes back.)

**1:40 — Reset + ask (20 s).**
Press **Reset room**. "Build log: 10:14 world, 11:40 robot walking, 13:30 first chore, 15:20 six-layout eval.
Starter disclosed: the attic sample world from Ian's third-person template." Then the ask:
"Next: export the approved rehearsal as a task spec a real robot stack consumes. We'd like to keep building this at
Fort Mason for two weeks and apply to Blueprint II by the 14th."

## If something breaks

| Symptom | Do this |
| --- | --- |
| Wi-Fi drops / Convex badge says offline | Reload with `?local=1` — same demo, phone sync off; say so. |
| Chore fails to plan | Use an example chip; names must match the Room list. |
| Robot stuck | `Stop robot`, `Robot start` tool → click the floor, re-run. |
| Splat never appears | The collider, grid and robot still work; switch to the fallback recording for the wide shot. |
| Anything else | Fallback recording. Keep talking; the ledger on the phone still tells the story. |

## Reset controls

- **Reset room** — seed layout, ledger cleared, heat cleared (one mutation).
- **Stop robot** — abort mid-chore.
- **Esc** — back to the Select tool.
