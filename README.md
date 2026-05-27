# Trail Almanac

A personal, local-hosted React dashboard for ultra training. Pulls live data
from Strava and Oura, plots it against a configurable training block, and
delegates coaching to a headless Claude Code agent that has read access to
every snapshot.

Built for the [Mogollon Monster 100](https://www.aravaiparunning.com/mogollon-monster-2/)
(102.3 mi · 15,900 ft · Sept 12, 2026). All numbers, weekly targets, race
date, and aid stations are real.

## What's in it

- **§ I · The Numbers** — week/month totals, distance/elevation/time toggle,
  daily dual sparklines, and a full 20-week block-trajectory chart with
  actual vs planned cumulative + projection.
- **§ II · The Body** — Oura sleep score, readiness, HRV, RHR, last night's
  sleep stages, and recent tags.
- **§ III · The Log** — every run from Strava, clickable to the activity page,
  paginated 20 at a time.
- **§ IV · The Coach** — a deterministic facts panel (acute:chronic load,
  HRV trend, RHR drift, sleep debt, block delta) **plus** a structured
  readout from a headless `claude -p` session. Includes an interactive chat
  pane the agent answers with full data context.
- **§ V · The Plan** — 6 weeks ahead, each card driven by the agent's
  `plan_blocks` output with named local-trail key sessions.

Imperial / metric toggle (persisted), one-click resync that streams progress,
and topographic backdrop / Fraunces italic display set the aesthetic.

## Setup

```bash
cd web
npm install
npm run dev          # http://localhost:5173
```

### Athlete profile

The agent uses your name, location, and local trail names in its prompts. Copy
the example and personalize — this file is gitignored:

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

Writes `web/public/strava.json` for the dashboard to read.

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

## Data privacy

Personal Strava + Oura snapshots are gitignored. The OAuth tokens live in
`~/.config/{oura,strava-mcp}/` outside the repo. Nothing personal lands in
git.

## Tech

React 19 · Vite · TypeScript · Motion · headless `claude -p`. Fraunces +
Instrument Sans + JetBrains Mono. ~2.6k LOC `App.tsx`.
