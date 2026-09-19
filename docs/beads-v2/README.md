# v2 beads — what each one was, and where it landed

The thirteen work items PRD-v2 was cut into (`00.md` is the epic; `01.md`
through `13.md` are the beads, and `create-beads.sh` is what registered them).
Each was built in its own worktree and merged onto `v2` as a single commit
carrying its bead id, so `git show <sha>` is the whole of that bead.

Waves: **w1** 01 · 03 · 05 · 10 · 12 → **w2** 02 · 04 · 06 · 07 · 09 · 11 →
**w3** 08 · 13.

| bead | what | merge |
|---|---|---|
| [01](01.md) | the altitude slowdown curve, its per-slug knob, the planner slider and the model check | `16bd46e` |
| [02](02.md) | acclimation from the calendar's travel events, the home-elevation setting, the calibration back-test | `dc8635c` |
| [03](03.md) | B-race schema (`kind`, `parent_slug`, `weeks_out`), `POST /api/races`, `b_races[]` in the payload, facts and prompt | `9875399` |
| [04](04.md) | B-race UI: grouped switcher, the quick-form dialog, trajectory markers, the reduced planner | `5c11bae` |
| [05](05.md) | the tracker registry, the OpenSplitTime adapter, the MAProgress stub, `GET /api/races/:slug/tracker` | `17dcfc2` |
| [06](06.md) | `checkpointHold()`, the race-day live hold, the timed manual checkpoint, the review screen's tracking fields | `b66fdbe` |
| [07](07.md) | the crew export *pipeline*: a second Vite entry inlined to one file, the script, the endpoint, the button | `95cba2c` |
| [08](08.md) | the crew export *content*: station table, pickups, rules, SVG map and profile, the local checkpoint updater, print | `1d058ec` |
| [09](09.md) | the `race_state` block the client sends with every chat turn, validated and token-measured | `d892296` |
| [10](10.md) | the Playwright harness: synthetic fixtures, `TRAIL_PROJECT_ROOT`, `TRAIL_FAKE_AGENT`, the first flows | `6d4efae` |
| [11](11.md) | the remaining browser flows, and `check:races`' `ui` section | `e0dfc96` |
| [12](12.md) | `scripts/contracts.mjs`, the generated `web/src/contracts.ts`, `engines.node`, the stale TODOs | `7c53a02` |
| [13](13.md) | the v2 harness sections, the README, this PRD status — and `/api/chat` under `TRAIL_FAKE_AGENT` | this branch |

Where the shipped app differs from what PRD-v2 asked for, the reasons are in
**[docs/PRD-v2.md §10 — Changelog of deviations](../PRD-v2.md)**, derived from
these merges and from the code they landed.
