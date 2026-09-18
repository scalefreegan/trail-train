# Basecamp (née Trail Almanac)

A personal, local-hosted React dashboard for ultra training. Pulls live data
from Strava and Oura, plots it against a configurable training block, and
delegates coaching to a headless Claude Code agent that has read access to
every snapshot.

A **race is a folder**, not a hard-coded assumption. Everything race-specific
— name, date, timezone, aid chart, cutoffs, climbs, crew rules, fueling —
lives in `races/<slug>/`, and `config/active-race.json` points at the one in
play. Point it somewhere else and the whole app follows: countdown, course
profile, pacing model, crew sheet, fuel plan, coach prompts.

With no active race the app runs in **generic mode**: the race panels hide and
training is driven by `config/goals.json` (event class, horizon, phase, volume
band) on a rolling block instead of a fixed countdown. Finished races are
archived in place and stay readable.

## What's in it

A single integrated ops surface — pre-dawn "basecamp" dark theme, headlamp
amber accent — instead of a sectioned scroll:

- **Command bar** — block week, race countdown, streaming resync status, and
  the imperial/metric toggle, always pinned on top.
- **Race ribbon** — countdown plus the course elevation profile with aid
  stations, compressed into one band. Hidden in generic mode.
- **Vitals** — load and recovery in one grammar: 7d distance/vert, ACR,
  block-vs-plan, readiness, HRV, RHR, sleep — each with a 30-day sparkline
  and trend delta, plus last night's sleep stages inline.
- **Trajectory** — the cumulative actual-vs-plan chart for the block with
  projection, expected/actual/delta stats embedded in the panel.
- **The road ahead** — next 14 calendar days (Google Calendar, classified)
  fused with the agent's next-6-weeks `plan_blocks` and key sessions.
- **The log** — every Strava run, clickable, paginated. A second **other**
  tab lists non-run activities (rides, hikes, strength, …) — visible to you
  and the coach agent, but never counted in vitals, trajectory, or pacing,
  which stay runs-only.
- **The coach** — a persistent sticky rail: deterministic flags
  (acute:chronic load, HRV trend, RHR drift, sleep debt, block delta), the
  structured readout from a headless `claude -p` session, and the chat —
  visible alongside everything as you scroll.

Imperial / metric toggle (persisted), one-click resync that streams
progress; set in Bricolage Grotesque, Archivo, and Spline Sans Mono.

## Setup

```bash
cd web
npm install
npm run dev          # http://localhost:38100 (fixed port, strictPort)
```

Or launch it as a Mac app — `./macos/build-app.sh` installs **Basecamp.app**
to `/Applications`: the Dock icon starts the server and opens the dashboard,
and quitting it stops the server. See `macos/README.md`.

### Pick a race (or don't)

```bash
ls races/                       # the folders you have
$EDITOR config/active-race.json # {"slug": "<folder name>"} — or {"slug": null}
```

`config/active-race.json` is gitignored: which race you are training for is a
per-machine choice, and a fresh checkout starts at `{"slug": null}` rather
than silently adopting somebody else's race.

- **Race mode** (`slug` set) — the block, countdown, course views, crew sheet
  and fuel plan all come from that folder.
- **Generic mode** (`slug: null`) — the race panels hide, and the training
  block is driven by `config/goals.json` (gitignored, like the pointer):
  ```json
  { "event_class": "100mi", "horizon_weeks": 24, "phase": "base", "volume_band": [40, 60] }
  ```
  Panel gating is live; the rolling-window block that reads `goals.json` is
  still landing, so scripts currently fall back to the most recent race
  folder when nothing is active.

A race folder holds (see `docs/PRD-modular-races.md` §5):

| file | what | committed? |
|---|---|---|
| `race.json` | name, date, timezone, distance, elevation, aid chart with cutoffs, climb windows, crew info, coach notes, sources | yes |
| `course.gpx` | the organizer's route export | yes |
| `block.json` | weekly mileage + vert targets for this build | yes |
| `nutrition.json` | fueling constants + per-station drop-bag gear | yes |
| `plan.json` | the coach agent's current 6-week plan | no |
| `result.json` | the finish, once it happens | no |
| `crew.private.json` | crew base address + emergency numbers | no |
| `build/` | generated `course.json` / `crew-base.json` | no |

Folders whose name starts with `_` are templates, never races
(`races/_fixtures/` holds the test ones).

### Build the course

The Race views read a `course.json` derived from the folder's GPX: aid
stations snapped to the track, climbs detected and matched to `race.json`'s
windows, a smoothed elevation profile, and the overview-map polyline.

```bash
cd web
npm run course:build                                # the active race
npm run course:build -- --race <slug>               # a specific folder
```

It writes `races/<slug>/build/course.json` (and `build/crew-base.json` when a
crew base is configured) — generated output, gitignored. The dev server serves
them at `/course.json` and `/crew-base.json`. With no active race and no
`--race`, the command lists the slugs it could have built rather than guessing.

Aid stations are resolved to GPX waypoints by the authored `gpx_wpt` first,
then by name, then by charted mile. A station the matcher can't place
confidently warns and falls back to a distance snap — an unseen GPX from a
race site never fails the build.

### Athlete profile

The agent uses your name, location, local trail names and the title words you
give your long runs (`long_run_name_patterns`) in its prompts and in Strava
classification. Copy the example and personalize — this file is gitignored:

```bash
cp config/profile.example.json config/profile.json
$EDITOR config/profile.json
```

The dashboard initially shows empty states. Connect each data source:

### Strava

Uses [r-huijts/strava-mcp](https://github.com/r-huijts/strava-mcp)'s OAuth
config at `~/.config/strava-mcp/config.json`. Once you've authorized the
strava-mcp client there:

```bash
npm run sync:strava
```

Writes `web/public/strava.json` (runs) and `web/public/cross-train.json`
(everything else) for the dashboard to read. Only runs feed the metrics;
non-run activities surface in the log's "other" tab and in the coach
agent's context.

### Oura

Personal Access Tokens are deprecated — Oura now requires OAuth2.

1. Register an app at <https://cloud.ouraring.com/oauth/applications>:
   - Redirect URI: `http://localhost:5174/oura-callback`
   - Scopes: `daily heartrate tag personal`
2. Save credentials to `~/.config/oura/config.json`:
   ```json
   {
     "clientId": "...",
     "clientSecret": "...",
     "redirectUri": "http://localhost:5174/oura-callback"
   }
   ```
3. Authorize once:
   ```bash
   npm run auth:oura
   ```
4. Pull data anytime:
   ```bash
   npm run sync:oura
   ```

### Google Calendar

The agent uses your calendar for schedule realism — travel days, races,
work blocks, appointments. Setup mirrors Oura's OAuth dance:

1. Enable the Calendar API for your GCP project:
   <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
2. Configure the OAuth consent screen (External, testing mode) and add
   your email under "Test users".
3. Create an OAuth 2.0 Client ID (Web application):
   - Redirect URI: `http://localhost:5174/google-callback`
   - Scope: `calendar.readonly`
4. Save the client credentials to `~/.config/google/config.json`:
   ```json
   { "clientId": "...", "clientSecret": "...", "redirectUri": "http://localhost:5174/google-callback" }
   ```
   (or export `GOOGLE_CAL_API_CLIENT_ID` / `GOOGLE_CAL_API_CLIENT_SECRET` as
   env vars, e.g. in `~/.keys` sourced by your shell — either works)
5. Authorize once (writes tokens to `~/.config/google/tokens.json`):
   ```bash
   npm run auth:google
   ```
6. Pull events anytime:
   ```bash
   npm run sync:google
   ```

Events are classified locally (race / travel / appointment / training /
work / other) and the upcoming 14 days are surfaced to the agent so it
won't propose a key session on a day you're flying.

### Claude coach (headless agent)

Uses your local Claude Code CLI (`claude -p`) via your existing subscription —
**no API key needed**. Same pattern as
[agent-trade](https://github.com/scalefreegan/agent-trade)'s `claude_wrapper.py`.

```bash
npm run coach
```

Reads `strava.json` + `oura.json`, computes deterministic facts, prompts
Claude with full data context, and writes `web/public/coach.json` (summary,
watch-outs, recommendations, and 6 weeks of `plan_blocks` with key sessions).

## Persistent agentic state

State is split in two: what is true about the **athlete** stays in
`web/public/state.json` (gitignored, v3), and what is true about a **race**
lives in that race's folder under `races/<slug>/`.

`state.json` (v3):

- **agent_notes** — running list of observations the coach has made and
  wants to remember (capped at 30, newest kept).
- **preferences** — athlete-set rules (training philosophy, weekly rest
  day, fueling target, heat threshold, coach context sections and dated
  temporary constraints). Agent reads them and may only APPEND context.

The race side is the folder table under **Setup → Pick a race**.

`state.json` is bootstrapped from defaults the first time `sync-strava` or
`coach` runs. A v2 file (race + block + plan_blocks inside state.json) is
migrated on first load: it is copied to `web/public/state.v2.backup.json`
first — the split refuses to run if that backup cannot be written — and the
race data is written into the folder, never overwriting a file already there.
After that the files are the source of truth — edit them directly to change
block targets, preferences, etc. `coach.mjs` merges agent updates atomically
(write-then-rename) so a malformed agent response can never corrupt state;
plan_blocks land in the active race's `plan.json`, or `config/generic-plan.json`
when no race is active.

## Weather

`sync-strava` calls Open-Meteo's free historical archive for each activity
(no key, hourly resolution) to get `temp_min_c / temp_max_c / temp_avg_c /
apparent_avg_c / humidity_avg` during the run window. Cached to
`~/.cache/trail-train/weather.json` so re-syncs don't re-hit the API. The
agent uses these to flag heat exposure (≥24 °C / 75 °F = "hot run") and
suggest acclimation work — which matters as much as the race's own heat
profile in `race.json`. Skip with `--no-weather` if you ever need to.

## Live resync

The masthead **resync all** button POSTs to `/api/refresh`, which runs all
three scripts sequentially and streams progress via SSE. The chat input in
§ IV / The Coach hits `/api/chat`, which spawns a fresh `claude -p` for each
turn with the full conversation history + the latest snapshots in scope.
Both endpoints are dev-only Vite middleware.

```bash
npm run sync:all     # strava + oura
npm run coach        # regenerate readout + plan
```

## Safety & backups

Anything that's *not* in git lives only on your laptop and would be lost if it
dies. Three layers of safety:

**1. Tagged clean release on the remote.** `v0.1.0-rc.1` is an annotated tag
at the first scrubbed snapshot, and `backup/<date>-clean` is an immutable
branch at the same SHA. Both live on `origin` — pull them back any time:
```bash
git fetch --tags
git checkout v0.1.0-rc.1
# or
git checkout -b restore origin/backup/2026-05-27-clean
```

**2. Local snapshot backups.** One command copies your personal data
(Strava + Oura + coach snapshots, athlete profile, OAuth credentials) to a
timestamped, mode-0700 directory outside the repo:
```bash
npm run backup           # writes ~/Documents/trail-train-backups/<YYYY-MM-DD-HHmm>/
npm run restore:list     # list available backups
npm run restore          # restore the most recent (snapshots + profile only)
node ../scripts/restore.mjs --oauth                    # also restore OAuth tokens
node ../scripts/restore.mjs --from 2026-05-26-1430     # pick a specific backup
```
Keeps the last 10 by default (`--keep N` to change), prunes older. OAuth
files are written mode 0600. Wire into `launchd` / `cron` for automatic
recurring backups.

**3. Recovery flow if everything is lost.** All personal data is reproducible
from the original sources:
```bash
git clone git@github.com:scalefreegan/trail-train.git
cd trail-train/web && npm install
cp ../config/profile.example.json ../config/profile.json   # then personalize
# restore OAuth tokens from your backup OR re-auth from scratch
npm run sync:all && npm run coach
```

## Data privacy

Personal Strava + Oura snapshots are gitignored. The OAuth tokens live in
`~/.config/{oura,strava-mcp}/` outside the repo. Nothing personal lands in
git.

## Tech

React 19 · Vite · TypeScript · Motion · headless `claude -p`. Fraunces +
Instrument Sans + JetBrains Mono. ~2.6k LOC `App.tsx`.
