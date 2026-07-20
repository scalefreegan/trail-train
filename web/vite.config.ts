import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// Dev-only middleware: POST /api/refresh runs the three sync scripts in
// sequence and streams progress lines back as Server-Sent Events.
// The dashboard's resync button hits this endpoint.
function refreshApi(): Plugin {
  const projectRoot = path.resolve(__dirname, '..')
  return {
    name: 'trail-train-refresh-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/refresh', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST required')
          return
        }
        // Optional JSON body: { units: "imperial" | "metric" } — forwarded to
        // the coach step so the readout speaks the dashboard's unit system.
        const bodyChunks: Buffer[] = []
        for await (const c of req) bodyChunks.push(c as Buffer)
        let units = 'imperial'
        try {
          const parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8') || '{}')
          if (parsed.units === 'metric') units = 'metric'
        } catch {}

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        const send = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }

        const steps = [
          { id: 'strava', label: 'syncing strava',  script: 'scripts/sync-strava.mjs',     args: [] },
          { id: 'oura',   label: 'syncing oura',    script: 'scripts/sync-oura.mjs',       args: [] },
          { id: 'gcal',   label: 'syncing calendar', script: 'scripts/sync-google-cal.mjs', args: [] },
          { id: 'coach',  label: 'running coach',   script: 'scripts/coach.mjs',           args: [] },
        ] as const

        let aborted = false
        req.on('close', () => { aborted = true })

        const runStep = (s: typeof steps[number]) =>
          new Promise<{ ok: boolean; code: number | null; stderr: string }>((resolve) => {
            send('step', { id: s.id, status: 'start', label: s.label })
            const proc = spawn('node', [path.join(projectRoot, s.script), ...s.args], {
              cwd: projectRoot,
              env: { ...process.env, TRAIL_UNITS: units },
            })
            let stderrBuf = ''
            proc.stdout.on('data', (d) => {
              for (const line of d.toString().split('\n')) {
                if (line.trim()) send('log', { id: s.id, line: line.trim() })
              }
            })
            proc.stderr.on('data', (d) => {
              const t = d.toString()
              stderrBuf += t
              for (const line of t.split('\n')) {
                if (line.trim()) send('log', { id: s.id, line: line.trim(), stream: 'err' })
              }
            })
            proc.on('close', (code) => {
              send('step', { id: s.id, status: code === 0 ? 'done' : 'error', code })
              resolve({ ok: code === 0, code, stderr: stderrBuf })
            })
            proc.on('error', (err) => {
              send('log', { id: s.id, line: `spawn error: ${err.message}`, stream: 'err' })
              resolve({ ok: false, code: null, stderr: err.message })
            })
          })

        try {
          for (const s of steps) {
            if (aborted) break
            const r = await runStep(s)
            if (!r.ok && s.id !== 'oura' && s.id !== 'gcal') {
              // strava and coach are required; oura and gcal are optional (might be unconfigured)
              send('done', { ok: false, failed_at: s.id })
              res.end()
              return
            }
          }
          send('done', { ok: true, at: new Date().toISOString() })
        } catch (e) {
          send('done', { ok: false, error: String((e as Error)?.message || e) })
        }
        res.end()
      })
    },
  }
}

const CHAT_SYSTEM = (
  factsPath: string,
  coachPath: string,
  profile: { athlete_name?: string; location?: string; home_trails?: string[] },
  units: 'imperial' | 'metric' = 'imperial',
) => `You are the coach inside Trail Almanac for ${profile.athlete_name || "the athlete"} — an ultrarunner training for the Mogollon Monster 100 (102.3 mi, 15,900 ft, Sept 12, 2026, Pine, AZ). They live in ${profile.location || "their home mountains"}.${profile.home_trails?.length ? ` Local training trails: ${profile.home_trails.join(", ")}.` : ""}

You have full read access to:
  - ${factsPath}      (deterministic facts: block week, ACR, HRV trend, RHR drift, sleep, heat exposure, recent runs w/ temps, plan_blocks, agent_notes from prior sessions)
  - ${coachPath}      (most recent structured agent readout)
  - web/public/state.json   (persistent state — race meta, block targets, plan_blocks, agent_notes, preferences)
  - web/public/strava.json  (raw Strava snapshot — distance/elev/HR/dates/titles/start_latlng/weather, with strava_url)
  - web/public/oura.json    (Oura snapshot — sleep, readiness, HRV, RHR, tags)
  - web/public/google-cal.json  (Google Calendar — past 7 + next 30 days of events, classified by training relevance)

Use the calendar for schedule realism — if the athlete asks about a specific day's session,
check that day's events first. Flag conflicts (travel, races, work blocks).

Treat preferences.personal_constraints (visible in facts.preferences) as HARD constraints.
When asked about a session on a specific day, cross-check the day's events against every
constraint before suggesting timing. If a constraint applies, either work around it (e.g.
early morning before the conflicting event) or move the session to a different day.

Load philosophy: recovery signals gate the plan in BOTH directions. Only recommend extra
rest or reduced mileage when a concrete signal in the data justifies it (HRV ratio below
baseline, RHR drift ≥ +3 bpm, readiness falling, sleep debt, ACR > ~1.3) — and quote the
number. When signals are clean, hold or build the planned volume; do not counsel caution
by default. The limiter in a 100 is leg durability (quads on descents, feet, time on
feet), not aerobic fitness — so when load needs managing, prefer long very-low-intensity
time-on-feet days and race-effort simulation (hiked climbs, relaxed low-cadence shuffle,
fueling practice at race rhythm) over simply cutting volume. Taper weeks are the
exception and stay protective.

When estimating how long a run will take, use facts.pacing — a model fit from ${profile.athlete_name || "the athlete"}'s own Strava runs. Pace slows steeply with vert and distance, so never assume flat-road pace on hilly terrain. Read off facts.pacing.reference (distance_mi + vert_ft → pace_min_per_mi, moving_h), interpolate for the proposed session, round up for stops, and carry ±facts.pacing.fit_error_min_per_mi as uncertainty. A hilly long run here is ~11-14 min/mi, not 9.

Use the Read tool to look up specifics. Ground every claim in the data — quote real numbers (HRV ms, RHR delta, ACR ratio, miles, vert, dates, run temps in °F).

Response rules:
  - Be concise. 1-3 short paragraphs unless the user explicitly asks for more depth.
  - Plain text. No markdown headers, no bullet bloat. Inline bullets ok where natural.
  - ${units === 'metric'
      ? 'Metric units (kilometers, meters); Celsius for temperatures'
      : 'Imperial units (miles, feet); Fahrenheit for temperatures'} — this is the unit system the athlete has selected in the dashboard. Source snapshots may store other units; convert when quoting numbers. 24h time.
  - No emojis. No filler. Direct, specific, useful.
  - When unsure or data missing, say so. Don't fabricate.
  - Address the athlete in second person.
  - Defer to the established plan_blocks and agent_notes from prior sessions — don't propose a re-plan unless the user explicitly asks.`;

function chatApi(): Plugin {
  const projectRoot = path.resolve(__dirname, '..')
  return {
    name: 'trail-train-chat-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/chat', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }

        // Read JSON body
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        let body: { messages?: Array<{ role: string; content: string }> }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
        catch { res.statusCode = 400; res.end('bad json'); return }
        const messages = body.messages || []
        const chatUnits: 'imperial' | 'metric' = (body as any).units === 'metric' ? 'metric' : 'imperial'
        if (!messages.length) { res.statusCode = 400; res.end('no messages'); return }

        // Compute facts → write to temp file the agent can Read
        let factsPath = ''
        try {
          const facts = await import(path.join(projectRoot, 'scripts/facts.mjs'))
            .then((m: any) => m.loadFactsFromRoot(projectRoot))
          factsPath = path.join(os.tmpdir(), `trail-chat-${Date.now()}.json`)
          fs.writeFileSync(factsPath, JSON.stringify(facts, null, 2))
        } catch (e) {
          res.statusCode = 500
          res.end(`facts error: ${(e as Error).message}`)
          return
        }
        const coachPath = path.join(projectRoot, 'web', 'public', 'coach.json')

        // SSE start
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        const send = (event: string, data: unknown) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

        // Build prompt from history. Last message is the latest user turn;
        // prior messages become a transcript so the agent sees the thread.
        const last = messages[messages.length - 1]
        const prior = messages.slice(0, -1)
        const transcript = prior.length
          ? `Conversation so far:\n\n${prior.map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n')}\n\n---\n\n`
          : ''
        const prompt = `${transcript}[USER]\n${last.content}\n\n[ASSISTANT]\nRespond to the latest user message. Today is ${new Date().toISOString().slice(0, 10)}.`

        const profile = await import(path.join(projectRoot, 'scripts/facts.mjs'))
          .then((m: any) => m.loadProfile(projectRoot))
          .catch(() => ({}))
        const sysPrompt = CHAT_SYSTEM(factsPath, coachPath, profile, chatUnits)
        send('start', { facts_path: factsPath })

        const proc = spawn('claude', [
          '-p', prompt,
          '--output-format', 'json',
          '--max-turns', '6',
          '--allowedTools', 'Read',
          '--append-system-prompt', sysPrompt,
        ], { cwd: projectRoot, detached: true })

        let stdout = ''
        let stderrLast = ''
        const hb = setInterval(() => send('heartbeat', { t: Date.now() }), 4000)

        proc.stdout.on('data', (d) => { stdout += d })
        proc.stderr.on('data', (d) => {
          const s = d.toString()
          stderrLast = s.split('\n').filter(Boolean).slice(-1)[0] || stderrLast
        })

        let cleanedUp = false
        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          clearInterval(hb)
          try { fs.unlinkSync(factsPath) } catch {}
        }

        req.on('close', () => {
          try { process.kill(-proc.pid!, 'SIGKILL') } catch {}
          cleanup()
        })

        proc.on('close', (code) => {
          cleanup()
          if (code !== 0) {
            send('error', { message: `claude exited ${code}: ${stderrLast.slice(0, 240)}` })
            send('done', { ok: false })
            res.end()
            return
          }
          try {
            const wrapper = JSON.parse(stdout)
            const text = (wrapper && typeof wrapper === 'object' && wrapper.result)
              ? wrapper.result : stdout
            send('message', {
              role: 'assistant',
              content: text.trim(),
              meta: {
                num_turns: wrapper?.num_turns ?? null,
                cost_usd: wrapper?.total_cost_usd ?? null,
                duration_ms: wrapper?.duration_ms ?? null,
              },
            })
            send('done', { ok: true })
          } catch (e) {
            send('error', { message: `parse error: ${(e as Error).message}\n${stdout.slice(0, 240)}` })
            send('done', { ok: false })
          }
          res.end()
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), refreshApi(), chatApi()],
})
