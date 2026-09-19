# PRD v2 — Basecamp after modular races

Status: draft · 2026-09-19 · author: Aaron Brooks (interview-driven, written by Claude)
Builds on: docs/PRD-modular-races.md (v1, merged as PR #23 → main `a9eb643`). Next A-race: San Juan Softie 100, Aug 2027 (draft folder local).

## 1. Scope (from the 2026-09-19 interview)

| Item | Decision |
|---|---|
| Altitude pacing | Per-segment slowdown from course elevation above a threshold, scaled by acclimation; acclimation from profile home elevation + arrival date derived from the calendar's travel events (manual override on the planner); calibrated by a back-test against the athlete's own high-altitude runs when any exist; a per-slug slider like fatigue/restraint |
| Tune-up races | Lightweight B-race folders linked to the A-race block by date: quick form (name, date, distance, gain, optional GPX), intake optional; trajectory marker; coach plans taper/recovery around them; reduced planner (pacing + ETAs, no crew/drop-bag/caffeine cards) |
| Live race day | Tracker adapters (MAProgress and OpenSplitTime first, UltraLive next) with fixture tests; polled on demand from the race-day page; manual "passed station X at HH:MM" fallback re-projects locally |
| Crew access | Static self-contained crew export (HTML): ETAs/cutoffs/directions/emergency/rules, inline SVG map + profile, per-crew-stop pickups, embedded manual checkpoint updater; no Tailscale/cloud |
| Coach chat | Chat system prompt gains the projection (per-station ETAs, goal, knobs), fuel/caffeine summary, block_stale/unresolved/activation state, and the last checkpoint on race day; token cost checked against the turn budget |
| Frontend tests | Playwright suite on committed synthetic fixtures (fake snapshots + fixture races), `npm run test:ui`, run by `check:races` (skippable) |
| Cleanup | One shared contracts module for the KEEP-IN-SYNC tables (goal phases, physiology fields, provenance vocabulary, statuses, editable keys); stale TODOs removed; Node type stripping kept and documented (Node ≥ 22.18, `engines`) |
| Delivery | Same pipeline as v1: PRD → beads → Opus worktree waves → Sonnet review→fix→verify → Opus interactive rounds → PR |

Non-goals: Tailscale/live crew page, Strava beacon, phone-GPS positioning, road/loop formats beyond what v1 has, altitude physiology beyond a slowdown curve.

## 2. Altitude model

- `scripts/altitude.mjs` (pure) + `web/src/race/altitude.ts` twin: `altitudeSlowdown({elevationFt, homeElevationFt, acclimationDays})` → fractional pace penalty. Baseline curve: 0 below 5,000 ft; then a published per-1,000-ft penalty (≈1.5–2 % per 1,000 ft above the athlete's acclimated elevation), reduced by acclimation days on a saturating curve (≈50 % of the benefit by day 3, ≈90 % by day 14). Constants live in one place with the source cited.
- `projectRace` gains an altitude term per segment from the course profile's mean elevation between stations, scaled by a per-slug `altitude_pct` knob (default 100 = model as-is; 0 disables). Segment penalty multiplies the segment pace like `tech_pct` does.
- Acclimation inputs: `profile.physiology.home_elevation_ft` (settings), `arrival_at_altitude` derived from the calendar sync's travel events (the last travel event before race day whose destination or title matches the race location, else the day before the race) with a manual override on the planner; both shown on the planner with their source.
- Calibration: `calibration.ts` back-test adds an altitude bias: activities whose mean elevation (from cached streams) is ≥ 2,000 ft above home compare predicted vs actual; when ≥ 5 such runs exist the suggested `altitude_pct` is reported; otherwise the model default with "uncalibrated" shown.
- Model check shows the altitude term instead of the v1 caveat.

## 3. Tune-up (B) races

- `race.json` gains `kind: "a" | "b"` (default a) and, for b, `parent_slug` (the A-race whose block it sits in). B folders hold race.json and optionally course.gpx/build; no nutrition/plan/result required (result allowed).
- Quick form: `POST /api/races` creates a B folder (slug derived), validates, optional GPX upload → course build; "run intake" stays available.
- Payload: `/api/race/active` lists `b_races[]` for the training race (slug, name, date, distance, gain, weeks_out). Facts/coach: `race.b_races[]` with the same fields; the readout prompt tells the coach to plan taper and recovery around each.
- UI: switcher groups B-races under their A-race with "Add tune-up…"; trajectory shows a marker per B-race; viewing a B opens a reduced planner (station table if a course exists, ETAs, goal) with crew/drop-bag/caffeine gated off by default features.

## 4. Live race day

- `scripts/trackers/index.mjs` registry: `detect(url)` → adapter; adapters export `fetchLastCheckpoint({url, bib, name}, fetch)` → `{station, clock, elapsed_h, source, at}` or null. MAProgress and OpenSplitTime first with committed fixture pages; UltraLive next. Fixtures make tests network-free.
- `race.json.tracking: {url, bib, name}` (intake fills url; the review screen edits bib/name).
- `GET /api/races/:slug/tracker` polls the adapter with a cache TTL (60 s), cross-site guarded; never polls unless a client asks.
- Race-day page: polls while open (backoff on failure), sets the hold from the last checkpoint labelled "tracker · HH:MM", keeps the manual override; manual checkpoint entry "passed <station> at HH:MM" via a pure helper `checkpointHold()` shared with the crew export.

## 5. Static crew export

- A second Vite entry (`web/crew.html`, `web/src/crew/`) bundling the pure projection code (pacing, nightWindow, clock, checkpointHold) into one self-contained HTML with the race data embedded (course, projection inputs at the current knobs, fuel plan per crew stop, crew_info, map track + profile as inline SVG). No external URLs; opens from a file on a phone, offline.
- `scripts/crew-export.mjs --race <slug>` and `POST /api/races/:slug/crew-export` write `races/<slug>/build/crew-<date>.html`; a button in the race view downloads it.
- Content: per-station best/expected/worst ETAs at the goal, cutoffs, crew flags, drive times/directions, emergency contacts and rules, pickups per crew stop, a checkpoint updater that re-projects locally, print stylesheet.

## 6. Coach chat context

- `chatSystemPrompt` gains a compact race-state block the client sends with each turn: projection summary (goal, per-station expected ETA), knob values, fuel/caffeine summary, block_stale/unresolved/activation, last checkpoint if any. Server caps its size; measured token cost added to the existing turn-budget check.

## 7. Frontend test suite

- `web/tests/` Playwright config + fixtures: synthetic strava/oura/google-cal/coach/state/profile/goals JSON, `races/_fixtures/mm-like-100/` (small GPX, race.json, built course, nutrition) and the crewless 50k. The dev server and scripts honour `TRAIL_PROJECT_ROOT` so a test root can be pointed at a temp copy; a launcher starts vite on a free port against it. Headless agent calls honour `TRAIL_FAKE_AGENT=<path>` (agent-run.mjs returns canned output) so intake/plan/refresh flows are testable without spend.
- Flows: generic load, switcher view/activate/generic, review save + acknowledge + activate, race-day hold, print light-pixel check, offline race-day, dialog a11y, archive, refresh diff with the fake agent, B-race quick form, crew export opens offline.
- `npm run test:ui`; `check:races` runs it (`--no-ui` to skip).

## 8. Cleanup

- `scripts/contracts.mjs` (single source): GOAL_PHASES, PHYSIOLOGY_FIELDS/bounds, PROVENANCE_BY, RACE_STATUSES, editable race keys, unfillable roots. Client imports via a generated `web/src/contracts.ts` (build step writes it from the .mjs) or direct type-stripped import — pick one and use it everywhere the KEEP-IN-SYNC comments are. Stale `TODO(tt-yib.5)` markers removed. `package.json` `engines.node >= 22.18`, README note.

## 9. Phases

W1: altitude model core, B-race schema/server, tracker adapters, UI fixtures + harness, cleanup contracts. W2: acclimation + calibration, B-race UI, race-day live + manual checkpoint, crew export pipeline, remaining UI flows, chat context. W3: crew export content, v2 harness/README/PRD status. Then review loop, interactive rounds, PR.
