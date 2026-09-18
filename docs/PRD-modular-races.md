# PRD — Basecamp as a modular, race-pluggable training app

Status: implemented 2026-09-18 (branch modular-races) · author: Aaron Brooks (interview-driven, written by Claude)
Scope owner: Aaron · Validation case: San Juan Softie 100, August 2027

## 1. Summary

Basecamp was built for one race. The Mogollon Monster 100 (MM100) is asserted in four
independent places (state defaults, facts fallback, client defaults, the course config),
the coach prompts carry the race as literal prose, the block is a fixed 20 weeks ending
at "RACE", and there is no null-race path anywhere in the UI.

This PRD turns the race into a plug-in. A race is a folder of config that an agentic
intake generates from the organizer's site, runner manual, and GPX. Exactly one race is
active at a time; with none active the app runs in a **generic mode** driven by an
athlete goals file. Completed races are archived with results and stay selectable
read-only. Athlete-level state (preferences, agent notes, physiology) follows the athlete
across races; block targets and plan blocks belong to the race (or to the generic goals).

## 2. Decisions from the intake interview (2026-09-18)

| Topic | Decision |
|---|---|
| Config unit | Folder per race under `races/<slug>/`; an active-race pointer selects one |
| Generic mode | Driven by `config/goals.json` (event class, horizon, phase, volume band); race panels hide |
| State split | Block targets + plan_blocks per race (or per goals); agent_notes, preferences, temporary context global |
| Intake surface | In-app dialog from day one, streaming progress like resync; headless `claude -p` |
| Intake output | Course + aid + cutoffs; block targets; nutrition + drop-bag plan; links + visual choices |
| Review gate | Draft → review (editable summary) → Activate. Active race untouched until then |
| Completed races | Archive with results (Strava activity link + per-station splits); read-only; coach can cite |
| Multi-race | One A-race. Tune-ups stay classified calendar events |
| Event breadth | Trail ultras 50k–100mi. Aid stations are the spine; crew/drop-bag/pacer/night/heat are optional flags |
| Generic block | Rolling 12-week window with coach-set targets; no race marker; race block replaces it on activation |
| Coach context | `coach_notes` prose in race.json (intake-written, editable) + structured aid/cutoff data in the prompt |
| Timezone | IANA timezone per race; race-local clock for countdown, night bands, race-week protocol, crew ETAs |
| Next race | San Juan Softie 100, Aug 2027 (sanjuansoftie.com) |
| Intake tools | WebFetch + WebSearch + Read of uploaded PDFs/GPX |
| Visuals | Accent + name/short, hero image, panel selection, full theme override via presets + agent suggestion |
| MM100 | Archive as `races/mogollon-monster-100-2026/` with the 33.27 h result |
| Results | Strava activity + splits from track crossings, manual override from official results |
| Theme source | Named Basecamp-family presets; intake suggests one; per-token override in review |
| Altitude | Structured elevation range + altitude flag → coach guidance and a projection caveat. No pacing-math change in v1 |
| Race switcher | Command-bar menu on the race short code |
| Re-intake | Merge preserving hand edits; per-field provenance; diff shown before accept |
| Deliverable | This PRD + beads (`tt-` issues) in four phases |
| Extra scope | Phone-friendly race-day mode (ETAs, next station) |

## 3. Goals and non-goals

Goals
- Any trail ultra from 50k to 100mi can be added by pointing the intake at its sources.
- The app is useful with no race active (the current post-MM100 recovery period is the first user of this).
- Switching the active race changes every race-dependent surface at once, with no leftover state from the previous race.
- MM100 is preserved as the reference config and as history the coach can cite.

Non-goals (v1)
- Road, loop, or timed formats. Multiple simultaneously active races. Multi-athlete sharing.
- Altitude-adjusted pacing math. Scraping official results.
- Replacing the existing pacing, nutrition, caffeine, or climb models. They are reused, parameterized by the race folder.

## 4. Concepts

**Race folder** `races/<slug>/` — everything that defines one edition of one race.
Slug is `<race-name>-<year>` (e.g. `san-juan-softie-100-2027`). Personal data inside it
(crew base address, phone numbers) is gitignored by filename pattern (`*.private.json`).

**Race status** `draft | active | archived`. At most one `active`. A draft is never read by
the training views. Archived races are read-only in the UI; their files are still editable.

**Active pointer** `config/active-race.json` → `{ "slug": "..." | null }`. `null` means
generic mode. Written only by the switcher and the Activate action.

**Generic mode** — no active race. Driven by `config/goals.json`. Race view, nutrition view,
race ribbon, countdown chips, and "RACE" markers are absent. Trajectory shows a rolling
window. The coach coaches toward the goals prose.

**Athlete-level state** — `config/profile.json` (identity, calendar semantics, physiology),
`web/public/state.json` (agent_notes, preferences, temporary context). Never inside a race folder.

## 5. File schema

### 5.1 `races/<slug>/race.json`

```jsonc
{
  "schema_version": 1,
  "slug": "san-juan-softie-100-2027",
  "status": "draft",                      // draft | active | archived
  "name": "San Juan Softie 100",
  "short": "SJS100",
  "edition_year": 2027,
  "date": "2027-08-13",                   // race-local calendar date (Friday)
  "start_time": "06:00",
  "timezone": "America/Denver",           // IANA
  "location": "Durango Nordic Center · Durango, CO",
  "format": "point_to_point",             // point_to_point | out_and_back | loop
  "distance_mi": 104, "gain_ft": 19000,
  "elevation": { "min_ft": 8770, "max_ft": 12438, "avg_ft": 10282, "altitude_significant": true },
  "cutoff_h": 38,
  "features": {                           // drive which panels/cards exist
    "crew": true, "drop_bags": true, "pacers": true,
    "night": true, "heat": false, "altitude": true, "water_crossings": true
  },
  "sun": { "sunset": "20:12", "sunrise": "06:18" },   // race-local, computed from date+coords
  "aid_stations": [ /* same shape as today's race-course.json entries, plus: */
    { "name": "Cross Mountain", "gpx_wpt": "...", "seg_mi": 0, "total_mi": 45.8,
      "seg_gain_ft": 0, "tech_pct": 0, "cutoff_h": null, "cutoff_clock": null,
      "crew": true, "crew_only": false, "drop_bag": true, "pacers": true, "water_only": false,
      "menu": "full" /* full | basic | backcountry */, "lat": 0, "lon": 0, "notes": "" }
  ],
  "race_climbs": [ { "id": "...", "label": "...", "approx_mi": [0, 0] } ],   // any count, not fixed at 6
  "crew_info": { "rules": [], "cell_strategy": "", "station_notes": {}, "start_notes": "",
                 "driving": {} },        // emergency numbers → crew.private.json
  "coach_notes": {                        // prose the coach receives verbatim
    "terrain": "", "climate": "", "altitude": "", "key_demands": "", "race_week": ""
  },
  "links": { "site": "", "manual": "", "gpx": "", "tracking": "", "results": "", "map": "" },
  "visual": { "theme_preset": "alpine", "accent": "#...", "hero": "hero.jpg",
              "panels": { "climb_comparison": true, "crew_sheet": true, "model_check": true } },
  "provenance": {                         // per field path: who last set it
                                          // by: user | agent | computed (scripts/race-sun.mjs)
                                          //   | matcher (scripts/race-build.mjs picked a station's
                                          //     gpx_wpt out of the GPX; carries confidence + method)
    "aid_stations": { "by": "agent", "at": "...", "source": "manual-2026.pdf p11" },
    "aid_stations[3].gpx_wpt": { "by": "matcher", "at": "...", "confidence": 0.95, "method": "fuzzy" },
    "date": { "by": "user", "at": "..." }
  },
  "sources": [ { "kind": "url|pdf|gpx", "ref": "...", "fetched_at": "..." } ]
}
```

`cutoff_h` remains elapsed hours from start; `cutoff_clock` is the posted clock time and is
authoritative when both exist (the MM100 manual contradicted itself; keep both and derive).

### 5.2 Other files in the folder

| File | Purpose | Notes |
|---|---|---|
| `course.gpx` | Route with aid waypoints | `build-course.mjs` takes the folder, not a fixed filename |
| `block.json` | `{ start_date, total_weeks, targets[] }` | Intake-generated; user-editable; today's `state.block` |
| `plan.json` | `{ plan_blocks[] }` | Agent-managed; today's `state.plan_blocks` |
| `nutrition.json` | Today's shape | `drop_bag_gear` keyed by this race's station names; `caffeine.body_kg` moves to profile |
| `result.json` | Present only when archived | See §10 |
| `crew.private.json` | Crew base address, lat/lon, emergency numbers | gitignored |
| `hero.*` | Optional hero image | |
| `sources/` | Cached fetched pages/PDFs used by intake | gitignored, for re-intake diffs |
| `build/` | Generated `course.json`, `crew-base.json` | gitignored; served for the active race |

### 5.3 `config/goals.json` (generic mode)

```jsonc
{
  "event_class": "100 mi mountain race",
  "horizon": "next A-race ~Aug 2027",
  "phase": "return_to_run",              // recovery | return_to_run | base | build | peak | taper | maintain
  "weekly_volume_band": { "dist_mi": [0, 25], "vert_ft": [0, 3000] },
  "notes": "Left lateral shin/ankle injury post-MM100; no running until reassessed 2026-09-23."
}
```

The coach may propose edits to `weekly_volume_band` and `phase`; the user accepts in settings.

### 5.4 `config/profile.json` additions

`physiology: { body_kg, long_run_ref_mi }` (today's `caffeine.body_kg` 79.4 and pacing `D_REF` 20),
`long_run_name_patterns: []` (today's hard-coded regex in sync-strava). `race_base` is removed
in favor of the race folder's `crew.private.json`.

### 5.5 `web/public/state.json` after the split

Keeps `version`, `last_updated`, `agent_notes`, `preferences`. `race`, `block`, `plan_blocks`
move out. Version bump to 3 with a migration that writes them into the MM100 folder.

## 6. Generic mode

- Command bar: no short code, no countdown chips; the menu shows "no race" and the list.
- Training view: Vitals, Trajectory (rolling 12-week window, targets from goals band, coach may set weekly targets in `plan.json` under `config/generic-plan.json`), Road ahead, Log. No race ribbon.
- Race and nutrition view chips are hidden.
- Coach prompt: goals prose replaces the race sentence; "Be specific about the next 14 days toward `<event_class>`".
- Flags and vitals unchanged.

## 7. UI

**Race switcher** (command bar, on the short code): active race, drafts, archived, "No race"
(generic), and "New race…". Switching writes the pointer and triggers a full snapshot reload.

**Config-driven panels.** `features` and `visual.panels` gate: crew sheet and crew column,
drop-bag card, pacer flags, night bands, heat bands, climb comparison, model check. A crewless
50k renders a race view with only the planner, runner card, and fuel card.

**Race-week protocol** prose derives weekday names from `date` + `timezone` (Softie starts on a
Friday; MM100 was a Saturday).

**Trajectory**: x-axis from `block.total_weeks`; the terminal marker is labelled with `short`.

**Theme**: presets under `web/src/themes/` (basecamp-default, desert, alpine, forest, night).
`visual.theme_preset` selects; `visual.overrides` may set individual tokens. Accent and hero per race.

**Race-day mode**: a phone-width route (`/race-day`) showing now-time, next station, ETA band,
cutoff margin, what to pick up (from the fuel plan), and crew ETA. Reads the same projection.
Printable cards remain.

**Title and health check**: `index.html` title becomes "Basecamp"; the Mac app health check
matches that instead of the race name. Footer string and the port rationale are de-raced.

## 8. Intake (agentic)

**Entry**: "New race…" in the switcher, or "Refresh from sources" on an existing race.

**Dialog inputs**: race site URL (required), optional extra URLs, PDF uploads (runner manual,
aid chart), GPX upload or URL, edition year, optional theme preset choice, "what matters to
me" free text.

**Pipeline** (dev-server endpoint `/api/race-intake`, SSE progress like `/api/refresh`):
1. Fetch and cache sources into `sources/`. Follow links to the manual, GPX, results, tracking.
2. Run headless `claude -p` with `WebFetch, WebSearch, Read` allowed and a strict JSON output
   contract for `race.json` minus generated fields. PDFs whose charts are images (the Softie aid
   chart is one) are rendered to page images and passed as images; the agent transcribes the chart.
3. Validate the JSON (schema, aid miles monotonic, cutoffs monotonic, waypoint names present in the GPX).
4. `build-course.mjs <folder>` snaps stations to the track and computes climbs, sun times, profile.
5. Second agent pass, given course metrics and current Strava fitness: `block.json` targets working
   back from `date`, `nutrition.json` (per-station drop-bag gear, heat window from climate),
   `coach_notes`, theme suggestion, links.
6. Write the folder with `status: draft` and full provenance.

**Review dialog**: aid table (editable), profile preview, block targets table, nutrition summary,
theme preview, unresolved-fields list. "Activate" sets status, writes the pointer, archives nothing.

**Re-intake**: agent output is merged field-by-field; fields with `provenance.by == "user"` are
kept; every changed field is shown as a diff before accept. Nothing is written until accepted.

## 9. Coach

- Both prompts (`coach.mjs`, `vite.config.ts` chat) build the race paragraph from `race.json`:
  name, distance, gain, date, location, timezone, features, elevation range, `coach_notes`.
- The facts payload gains `race.aid_stations` (name, mile, cutoff, access flags) and
  `race.features`; the agent is told the course structure, which it never was.
- Altitude: when `altitude_significant`, the prompt carries an acclimation/arrival-timing demand
  and the planner shows a caveat on projected times.
- `plan_blocks[].wk` indexes the active race's block; in generic mode it indexes the rolling window.
- Archived races appear in facts as `history[]` (name, date, result, key notes) so the coach can cite them.
- The "KEEP IN SYNC" duplication between the two prompts is replaced by a shared module in `scripts/`
  imported by both.

## 10. Results (archived races)

`result.json`: `{ status: "finished|dnf|dns", strava_activity_id, finish_h, official_time,
placement, splits: [{ station, elapsed_h, source: "track|official|manual" }], notes }`.
Archive action links a Strava activity (picker from the log), derives splits from the GPS track
crossing each station's snapped coordinates, and lets the user overwrite from official results.
Race view of an archived race shows projected vs actual per station.

## 11. Migration

1. Create `races/mogollon-monster-100-2026/` from `config/race-course.json`,
   `config/mogollon-monster-100.gpx`, `web/public/nutrition.json`, `state.block`, `state.plan_blocks`,
   plus `coach_notes` extracted from the prompt literals. Status `archived`; `result.json` with 33.27 h.
2. Delete the duplicated constants in `facts.mjs`, `data.ts`, `state.mjs`; the client and scripts
   read the active folder (or goals) and have no race fallback.
3. Reconcile the 13-station `state.race.aid_stations` list with the 15-station course list; one list.
4. Move `body_kg`, `D_REF`, the long-run regex, and the calendar-conventions default out of code
   into profile / preferences.
5. Bump state to v3; migration is idempotent and backs up the prior file.
6. `npm run backup` and `restore` include `races/` private files and `config/goals.json`.

## 12. Validation case: San Juan Softie 100, August 2027

Known from the site and the 2026 manual: ~104 mi, ~19,000 ft, 8,770–12,438 ft (avg 10,282),
6:00 AM Friday start at the Durango Nordic Center, 38 h cutoff (8:00 PM Saturday), 11 aid
stations, first crew access at Cross Mountain (mi 45.8), pacers from there, one pacer at a time,
drop bags due 5:30 AM, aid menus rated full/basic/backcountry, monsoon lightning risk,
remote 4wd access, GPX via Gaia, results on OpenSplitTime, tracking via MAProgress.
The 2026 aid station chart is an image in the PDF. The 2027 manual will differ; re-intake must
merge cleanly. Registration for 2027 opens later.

Acceptance for the pipeline: intake from `sanjuansoftie.com` + the 2026 manual + GPX produces a
draft whose aid table matches the chart, whose block ends the week of 2027-08-13, and whose
review dialog flags the image-chart transcription for human check. Separately, re-deriving MM100
through intake and diffing against the archived folder is the regression test.

## 13. Phases

**Phase 1 — schema, migration, generic mode.** Race folder schema and loader; active pointer;
state v3 split; MM100 archived; goals.json; generic-mode rendering; all race literals removed
from code and prompts; timezone-aware clocks. Exit: app runs with no active race and with MM100
selected read-only; no Mogollon string outside `races/`.

**Phase 2 — switcher and config-driven views.** Command-bar menu; feature/panel gating;
per-race pacing knobs (localStorage keyed by slug); race-week weekday derivation; coach prompt
assembly from config incl. altitude and course structure; history in facts.

**Phase 3 — intake.** Endpoint, agent contract, PDF image handling, validation, course build per
folder, review dialog, draft/activate, re-intake merge with provenance. Exit: Softie 2027 draft
produced end-to-end.

**Phase 4 — visuals, results, race-day mode.** Theme presets and overrides, hero, results capture
with track splits, archived race view, phone race-day route, backup coverage.

## 14. Risks and open questions

- Intake accuracy on image-only aid charts; mitigated by the review gate and unresolved-field list.
- GPX waypoint names rarely match manual station names; the validator must offer a mapping UI.
- Sun times need coordinates + date + timezone; compute, don't transcribe.
- Theme overrides can drift the Basecamp identity; presets are the guardrail.
- Open: should generic-mode weekly targets be coach-proposed or user-set? Default: coach proposes, user accepts.
- Open: keep `config/race-course.json` as a legacy path during Phase 1, or hard-cut? Default: hard-cut after migration.

## 15. Changelog of deviations

What the build did differently from §§4–12 above, and why. The sections above
are left as written; this is the amendment list.

**Schema**

- `provenance.by` gained a fourth value: `user | agent | computed | matcher`.
  §5.1 had three. `matcher` is `scripts/race-build.mjs` choosing a station's
  `gpx_wpt` out of the GPX, and it carries `confidence` and `method` — a
  machine's guess at a waypoint is not the same claim as a computed sun time,
  and re-intake has to treat them differently.
- Drafts carry `unresolved[]` (every field the agent could not establish, made
  complete by `collectUnresolved`, not just what the agent admitted to) and
  `unresolved_acknowledged`, the boolean the review dialog's Activate gate
  reads (tt-yib.14).
- `nutrition.json` lost `caffeine.body_kg`; body mass is
  `config/profile.json` → `physiology.body_kg`, so a race folder is shareable.
  §5.4's `physiology` block ships with **impersonal defaults** and announces
  each substitution once per process, so the app runs for someone who has not
  filled in a profile.
- `sun` is computed, never transcribed (`scripts/race-sun.mjs`, a NOAA solar
  calculation from the GPX start point + date + IANA zone). It replaced the
  hand-entered MM100 pair, whose sunrise was a 2025 value: 06:15 → **06:05**.

**Pointer and modes**

- `config/active-race.json` is `{ slug, mode }`, not `{ slug }`. `mode` is
  `train` (this race coaches) or `view` (this race is being browsed). §4 had
  one pointer with one meaning, which could not express "look at the archived
  race without it taking the block back".
- Generic mode is therefore "no race is the **training target**": a pointer on
  a draft, on an archived folder, or in `view` mode is generic mode too, not
  just `slug: null`.
- The rolling 12-week generic block (§6) is one definition in
  `scripts/block.mjs`, imported by both `facts.mjs` and the `/api/race/active`
  payload, rather than being computed twice.

**Visuals and serving**

- `visual` gained `overrides` (per-token, over the preset) and derives
  `--lamp-deep` / `--lamp-glow` from `accent`, so one hex is enough. The
  readability floors are enforced on write, in one module the intake preview,
  the theme hook and the validator all import.
- The hero image is served by an explicit endpoint,
  `GET /api/races/:slug/asset/:name`, serving only the file `visual.hero`
  names — §7 implied a static path, which would have exposed the folder.
- The LAN opt-in for race-day mode is the environment variable
  `TRAIL_ALLOWED_ORIGINS`, not a config key: an allowlist that ships in a
  committed file is one a checkout can widen by accident.

**Migration**

- §11.3's 13-station `state.race.aid_stations` and the 15-station course list
  reconciled to **15** (the 13 aid stations plus the two crew-only zones that
  the course list carried and the state list had dropped), and the official
  distance to **102.6 mi** from the manual's aid chart, over state.json's
  102.3 from the race site.
- `scripts/lib.mjs` `note()` went silent under `node --test`: script progress
  on a test child's stdout interleaved with the runner's IPC stream and
  corrupted its framing about one run in ten, as an assertion-free failure in
  an unrelated file.

**Validation (§12)**

- "Re-deriving MM100 through intake and diffing against the archived folder"
  is **infeasible and was dropped**: MM100 was migrated by hand from
  `config/race-course.json` and a GPX, it has no `sources/`, and there is no
  cached site or manual to re-intake from. A re-intake would also be an agent
  run, which is not something a regression harness can assert on.
- It is replaced by a deterministic equivalent — `npm run check:races`
  section 3 — which strips every `gpx_wpt` and the sun from a temp-dir copy of
  the archived folder and puts it back through stage 2: 15/15 waypoints
  recovered from names alone, snapped miles monotone, sun within 5 minutes of
  the committed pair, and no `user`- or `agent`-stamped field rewritten.
- The Softie 2027 assertions are encoded against the produced **draft**
  (`check:races` section 4), which is uncommitted, so that section SKIPs in a
  fresh checkout. `--live` re-fetches and hashes the sources the draft cites
  rather than re-running the agent.
