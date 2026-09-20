# PRD v2 — Basecamp after modular races

Status: **implemented 2026-09-19 (branch `v2`)** · author: Aaron Brooks (interview-driven, written by Claude)
Where the build differs from this document, see §10 — Changelog of deviations. §1–§9 are left as they were written on the day of the interview.
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
- Status: `RACE_STATUSES` stays `draft | active | archived` and **a B folder is never "active"** — "active" means "this is the training target", and only one folder may hold it. A tune-up is `draft` before its date and `archived` after it, and is browsed in view mode like any other non-active folder; `kind`, not a fourth status, is what gates it. The validator enforces this (a b with status "active" is a schema error), so a tune-up cannot take the block from the A race it sits inside. `weeks_out` is computed from the A race's date in the A race's own zone (`scripts/clock.mjs`), rounded to whole weeks; negative means the tune-up now falls after race day.
- Quick form: `POST /api/races` creates a B folder (slug derived), validates, optional GPX upload → course build; "run intake" stays available.
- Payload: `/api/race/active` lists `b_races[]` for the training race (slug, name, date, distance, gain, weeks_out). Facts/coach: `race.b_races[]` with the same fields; the readout prompt tells the coach to plan taper and recovery around each.
- UI: switcher groups B-races under their A-race; "Add tune-up…" is on the topline strip when the A race is loaded (2026-09-20 deviation — see PRD-modular-races §7); trajectory shows a marker per B-race; viewing a B opens a reduced planner (station table if a course exists, ETAs, goal) with crew/drop-bag/caffeine gated off by default features.

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

- `web/tests/` Playwright config + fixtures: synthetic strava/oura/google-cal/coach/state/profile/goals JSON, `races/_fixtures/mm-like-100/` (small GPX, race.json, built course, nutrition) and the crewless 50k. The dev server and scripts honour `TRAIL_PROJECT_ROOT` so a test root can be pointed at a temp copy; a launcher starts vite on a free port against it. Headless agent calls honour `TRAIL_FAKE_AGENT=<path>` (agent-run.mjs returns canned output) so intake/plan/refresh flows are testable without spend. `TRAIL_FAKE_SYNC=1`, set unconditionally by the launcher for every server the suite starts, makes the dashboard's "resync" endpoint (`/api/refresh`) skip the four real strava/streams/oura/gcal sync scripts (which read real machine-level credentials) in favor of a no-op that still emits the same SSE step events — the coach step is unaffected, staying safe via `TRAIL_FAKE_AGENT` alone, as it always did.
- Flows: generic load, switcher view/activate/generic, review save + acknowledge + activate, race-day hold, print light-pixel check, offline race-day, dialog a11y, archive, refresh diff with the fake agent, B-race quick form, crew export opens offline, the topline action strip per race state.
- `npm run test:ui`; `check:races` runs it (`--no-ui` to skip).

## 8. Cleanup

- `scripts/contracts.mjs` (single source): GOAL_PHASES, PHYSIOLOGY_FIELDS/bounds, PROVENANCE_BY, RACE_STATUSES, editable race keys, unfillable roots. Client imports via a generated `web/src/contracts.ts` (build step writes it from the .mjs) or direct type-stripped import — pick one and use it everywhere the KEEP-IN-SYNC comments are. Stale `TODO(tt-yib.5)` markers removed. `package.json` `engines.node >= 22.18`, README note.

## 9. Phases

W1: altitude model core, B-race schema/server, tracker adapters, UI fixtures + harness, cleanup contracts. W2: acclimation + calibration, B-race UI, race-day live + manual checkpoint, crew export pipeline, remaining UI flows, chat context. W3: crew export content, v2 harness/README/PRD status. Then review loop, interactive rounds, PR.

## 10. Changelog of deviations

What actually shipped, where it differs from §1–§9 above. Derived from the
merge commits on `v2` and from the code they landed; each entry says what the
PRD asked for, what was built, and why. The PRD is not rewritten in place —
the interview is a record of what was decided on 2026-09-19, and this is the
record of what survived contact with the app.

### The model

- **A tune-up is never `active` — and `kind`, not a fourth status, is what
  says so** (§3). The PRD left "is a B race activatable?" implicit. It is
  not: "active" means *this is the training target* and only one folder may
  hold it, so a tune-up is `draft` before its date and `archived` after it.
  The validator refuses `kind: "b"` with `status: "active"`, refuses a
  `parent_slug` that names no folder or names the tune-up itself, and refuses
  one that names another tune-up — B races hang off A races and do not chain.
  Without that last rule a chain of tune-ups would compute `weeks_out`
  against a race that has no block.
- **Acclimation defaults to 1 day, as a named constant** (§2). The PRD said
  "else the day before the race", which is the same number; it is now
  `DEFAULT_ACCLIMATION_DAYS` in `scripts/contracts.mjs`, so the planner
  (`useRacePlan`), the derivation (`acclimation.mjs`) and the crew export
  cannot each pick their own fallback for the athlete who has no travel event
  on the calendar.
- **A race that declares `features.altitude: false` gets no altitude term at
  all** (§2) — not a term that happens to round to zero. The PRD described
  the knob (`altitude_pct`, 0 disables) but not the feature gate; a hidden
  penalty on a race the folder says is not an altitude race is worse than
  none, and it would have been invisible in the planner's own numbers.
- **The manual checkpoint wins by OBSERVATION TIME, not by being manual**
  (§4). The PRD said the race-day page "keeps the manual override", which
  reads as "manual always wins". It does not: whichever of the two was *seen*
  later is the hold (ties to the manual entry). A tracker that catches up
  past a typed time takes over on its own, and a tracker stuck at a station
  the runner left an hour ago does not. A permanent manual override would
  have meant one mistyped time silently disabling live tracking for the rest
  of the race.
- **A bare mile is a reported position, not a timed checkpoint** (§6). The
  race-state block distinguishes "I am at mile 62" from "I left Tin Cup at
  14:20"; the first carries no observation time, and the coach is told so
  rather than being allowed to treat it as a split.
- **A bare `HH:MM` is resolved inside the race's own window** (§4, §5).
  A clock time resolved to its latest occurrence before *now* with no upper
  bound but `MAX_SPAN_DAYS` (14 days), so a crew sheet — or a race-day page —
  opened long after the fact could read a stale HH:MM as a split days off.
  `web/src/crew/checkpoint.ts`'s `resolveClockElapsed`/`applyCheckpoint` had
  this fixed from the start: the horizon is clamped to the race's own window
  (cutoff plus `RACE_WINDOW_SLACK_H`), so a crew split always lands inside
  the race regardless of when the file is opened. **This entry originally
  misattributed that clamp to `checkpointHold`** (the tracker/race-day twin,
  `scripts/checkpoint-hold.mjs` / `web/src/race/checkpointHold.ts`), which
  had no such bound of its own — round 3 review caught the gap:
  `RaceDay.tsx` calls `checkpointHold` for a *manual* hold even when the
  race is past (only tracker polling is gated on it), so reopening an old
  race's page could resolve a typed HH:MM up to 14 days off. `checkpointHold`
  now takes the race's `cutoff_h` (`opts.cutoffH`) and applies the same
  `[start, start + cutoff_h + RACE_WINDOW_SLACK_H]` clamp when it is known,
  falling back to the 14-day ceiling only when it isn't — so this deviation
  is now true of both functions, not just the crew export's.

### Trackers

- **MAProgress is a documented stub, and has no fixture** (§4). The PRD put
  MAProgress and OpenSplitTime "first with committed fixture pages". Checked
  on 2026-09-19: `app.maprogress.com` renders from a SignalR websocket *after*
  load, so its first response carries no checkpoint data — there is nothing
  static to save. The adapter is registered, claims its hostname and fails
  with a tagged `unsupported`, which is a better answer than a 404 that reads
  as "no tracker configured". OpenSplitTime is the one real adapter; UltraLive
  is still next.
- **`TRAIL_TEST_FIXTURES=1` was added, and is not in the PRD** (§4, §7).
  Proving the polling works means polling something over HTTP, and the real
  adapters claim URLs by *hostname*, so a fixture served off 127.0.0.1 matches
  none of them. Under the flag the dev server serves `scripts/fixtures/` and
  one extra adapter claims that *path*. It re-uses the real OpenSplitTime
  parser and reports `source: "fixture"`; unset, it is not in the registry at
  all.

### Crew export

- **`TRAIL_CREW_SHELL` was added** (§5). The shell is a `vite build`, and the
  test harness's project root is a temp directory with no `crew.html`, no vite
  config and no `node_modules`. The variable points the exporter at a prebuilt
  shell so a test never shells out; unset, the shell is built on demand and
  cached by mtime.
- **One knobs→options mapping, shared with the planner** (§5). The export used
  to assemble its own projection options, which is how it came to be missing
  the altitude term the planner was showing. There is now a single mapping,
  and `scripts/check-races.mjs` re-exports a fixture race on every run.
- **TrailRun activities are in the pacing fit** (§5). The exporter filtered
  `sport === "Run"` and silently dropped everything Strava labels `TrailRun` —
  57 of 148 activities in the measured snapshot, 12 of them long enough to
  clear the ≥8 mi tier the fit prefers. The crew sheet was therefore projected
  off a *different* fit from the planner it was exported out of, which is the
  one thing the export exists not to do. It now hands `fitPacing` the whole
  snapshot, exactly as `providers.tsx` does; keeping non-running sports out of
  the snapshot is `sync-strava.mjs`'s job, where the sport is known.

### Tests and cleanup

- **The print check's thresholds are measurements, not targets** (§7). The
  PRD said "print light-pixel check". The numbers are what the fixture race
  actually renders: **88 %** light for the three cards (the densest, the drop
  bag card, measures 90.4 %) and **85 %** for the crew sheet, against the
  ~20 % a card that has fallen back to the dark palette prints at. The section
  skips loudly without `ghostscript` on `PATH`.
- **`web/src/contracts.ts` is generated and committed** (§8). §8 offered a
  choice — a generated file or a direct type-stripped import. Generated won:
  `web/vite.config.ts` and the client bundle cannot import a `.mjs`, the
  `predev`/`prebuild`/`pretest` hooks regenerate it, and a node test fails if
  the committed copy has drifted. The generated file is never edited.
- **Thirteen browser flows, not eleven** (§7). The PRD's list gained a width
  sweep (`widths.spec.ts`, five widths × four views) and a chat turn
  (`chat.spec.ts`), and `/api/chat` learned the `TRAIL_FAKE_AGENT` seam so
  that last one could exist at all — it spawns `claude` inline rather than
  going through `runClaudeJson`, so the seam every other agent flow had
  stopped at its door.
- **`check:races` has ten sections, not six.** Four were added for v2: the
  altitude curve (monotone, pinned points, both twins), the tune-up folder
  rules over `races/_fixtures`, the committed tracker fixtures parsed through
  the registry with an injected fetch, and the crew export's
  self-containment.
- **Stale TODOs were rewritten, not just deleted** (§8). A `TODO` pointing at
  a merged epic is noise, but the thing it pointed at is often still missing —
  those now say what is missing, without the marker.

### Not shipped

- **UltraLive** (§4) — still next.
- Everything listed as a non-goal in §1 stayed a non-goal.
