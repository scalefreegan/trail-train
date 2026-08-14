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
        let units = 'metric'
        try {
          const parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8') || '{}')
          if (parsed.units === 'imperial') units = 'imperial'
        } catch {
          console.warn('[refresh] unparseable request body — defaulting to metric units')
        }

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
          { id: 'strava',  label: 'syncing strava',        script: 'scripts/sync-strava.mjs',     args: [] },
          { id: 'streams', label: 'syncing climb streams', script: 'scripts/sync-streams.mjs',    args: [] },
          { id: 'oura',    label: 'syncing oura',          script: 'scripts/sync-oura.mjs',       args: [] },
          { id: 'gcal',    label: 'syncing calendar',      script: 'scripts/sync-google-cal.mjs', args: [] },
          { id: 'coach',   label: 'running coach',         script: 'scripts/coach.mjs',           args: [] },
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
            if (!r.ok && s.id !== 'oura' && s.id !== 'gcal' && s.id !== 'streams') {
              // strava and coach are required; oura, gcal and streams are optional
              // (might be unconfigured / rate-limited — streams resumes next sync)
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

// Recognize headless-CLI auth failures so the UI can say "sign in again"
// instead of surfacing a cryptic exit code. Matches the CLI's known phrasings
// (API-key auth and OAuth/subscription auth).
const AUTH_ERROR_RE = /invalid api key|please run \/login|not logged in|log ?in again|oauth token.{0,40}(expired|revoked|invalid)|authentication[_ ]?error|credentials?.{0,20}(expired|invalid|missing)|unauthorized/i
const authHint = (text: string): string | null =>
  AUTH_ERROR_RE.test(text)
    ? 'Claude Code sign-in has expired — open a terminal, run `claude`, type `/login` and finish the browser sign-in, then retry here.'
    : null

const CHAT_SYSTEM = (
  factsPath: string,
  coachPath: string,
  profile: { athlete_name?: string; location?: string; home_trails?: string[] },
  units: 'imperial' | 'metric' = 'metric',
  hasPacing = true,
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

ATHLETE CONTEXT — facts.preferences.context is athlete-authored and authoritative.
context.sections (about_me, training_preferences, calendar_conventions) are verbatim
background; calendar_conventions DEFINES the semantics of calendar markers and
classifications (childcare markers, recurring commitments, severity by day of week) —
apply it when reading the calendar. context.temporary lists dated items currently in
force; each is a HARD constraint until its expires date (expired items are already
filtered out). When asked about a session on a specific day, cross-check the day's events
against the sections and every temporary item before suggesting timing — work around a
constraint explicitly (e.g. early start before the conflicting event) or move the session.

SAVING CONTEXT — you can persist things the athlete tells you. Append at the VERY END of
your reply, after all prose:
<<<CONTEXT_SAVE
{"items":[{"text":"<dated constraint, athlete voice>","expires":"YYYY-MM-DD"}],
 "section_appends":[{"section":"about_me","text":"<durable fact, athlete voice>"}]}
CONTEXT_SAVE>>>
Routing: DATED, self-expiring facts (a trip, an injury window, a one-off schedule change)
→ items, with a realistic expires (roughly 30 days out if none is implied). DURABLE facts
(background, lasting training preferences, what a calendar pattern means) →
section_appends into exactly one of: about_me, training_preferences,
calendar_conventions. Appends ADD a new paragraph to the section — they can never edit or
remove existing text — so keep each append tight, self-contained, and in the athlete's
voice, UNDER 1000 characters (longer appends are rejected outright; split into multiple
appends instead). Omit either key when it has nothing; include the block ONLY when there is
genuinely something new — never emit an empty one, and never re-save what is already in
context. It is stripped before display and stored in the athlete's editable coach
context. Confirm in your prose exactly what you saved and where (or until when).
If the athlete asks you to interview them to build out their context/profile, ask short
focused questions a few at a time, and at the natural end of the exchange save what you
learned — durable answers via section_appends, dated ones via items.

Load philosophy: recovery signals gate the plan in BOTH directions. Only recommend extra
rest or reduced mileage when a concrete signal in the data justifies it (HRV ratio below
baseline, RHR drift ≥ +3 bpm, readiness falling, sleep debt, ACR > ~1.3) — and quote the
number. When signals are clean, hold or build the planned volume; do not counsel caution
by default. The limiter in a 100 is leg durability (quads on descents, feet, time on
feet), not aerobic fitness — so when load needs managing, prefer long very-low-intensity
time-on-feet days and race-effort simulation (hiked climbs, relaxed low-cadence shuffle,
fueling practice at race rhythm) over simply cutting volume. Taper weeks are the
exception and stay protective.

${hasPacing
  ? `When estimating how long a run will take, use facts.pacing — a model fit from ${profile.athlete_name || "the athlete"}'s own Strava runs. Pace slows steeply with vert and distance, so never assume flat-road pace on hilly terrain. Read off facts.pacing.reference (distance_mi + vert_ft → pace_min_per_mi, moving_h), interpolate for the proposed session, round up for stops, and carry ±facts.pacing.fit_error_min_per_mi as uncertainty. A hilly long run here is ~11-14 min/mi, not 9.`
  : `facts.pacing is null — no personal pacing model yet (needs at least 8 runs with distance + time data). Estimate durations conservatively from recent runs in the data, flag estimates as rough, and never assume flat-road pace on hilly terrain.`}

Use the Read tool to look up specifics. Ground every claim in the data — quote real numbers (HRV ms, RHR delta, ACR ratio, distance, vert, dates, run temps).

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
        let body: { messages?: Array<{ role: string; content: string }>; units?: string }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
        catch { res.statusCode = 400; res.end('bad json'); return }
        const messages = body.messages || []
        const chatUnits: 'imperial' | 'metric' = body.units === 'imperial' ? 'imperial' : 'metric'
        if (!messages.length) { res.statusCode = 400; res.end('no messages'); return }

        // Compute facts → write to temp file the agent can Read
        let factsPath = ''
        let hasPacing: boolean
        try {
          const facts = await import(path.join(projectRoot, 'scripts/facts.mjs'))
            .then((m: { loadFactsFromRoot: (root: string) => Promise<{ pacing: unknown }> }) => m.loadFactsFromRoot(projectRoot))
          hasPacing = Boolean(facts.pacing)
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
        const send = (event: string, data: unknown) => {
          if (res.writableEnded) return
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }

        // Build prompt from history. Last message is the latest user turn;
        // prior messages become a transcript so the agent sees the thread.
        const last = messages[messages.length - 1]
        const prior = messages.slice(0, -1)
        const transcript = prior.length
          ? `Conversation so far:\n\n${prior.map(m => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n')}\n\n---\n\n`
          : ''
        // local date (en-CA → YYYY-MM-DD), matching the expiry semantics —
        // a UTC date is tomorrow from ~17:00 MT and skews the agent's
        // reasoning about which temporary constraints are still in force
        const prompt = `${transcript}[USER]\n${last.content}\n\n[ASSISTANT]\nRespond to the latest user message. Today is ${new Date().toLocaleDateString('en-CA')}.`

        const profile = await import(path.join(projectRoot, 'scripts/facts.mjs'))
          .then((m: { loadProfile: (root: string) => Promise<Record<string, unknown>> }) => m.loadProfile(projectRoot))
          .catch((e) => {
            console.warn(`[chat] profile load failed, using empty profile: ${(e as Error).message}`)
            return {}
          })
        const sysPrompt = CHAT_SYSTEM(factsPath, coachPath, profile, chatUnits, hasPacing)
        send('start', { facts_path: factsPath })

        const proc = spawn('claude', [
          '-p', prompt,
          '--output-format', 'json',
          '--max-turns', '6',
          '--allowedTools', 'Read',
          '--append-system-prompt', sysPrompt,
        // stdin must be ignored (as in scripts/coach.mjs) — the default pipe
        // stays open forever, and the CLI stalls 3s in -p mode waiting on it,
        // then emits a "no stdin data received" warning that pollutes stderr.
        ], { cwd: projectRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })

        let stdout = ''
        let stderrLast = ''
        const hb = setInterval(() => send('heartbeat', { t: Date.now() }), 4000)

        proc.stdout.on('data', (d) => { stdout += d })
        proc.stderr.on('data', (d) => {
          // Keep the last line that isn't a warning, so a fatal error (auth
          // expiry, bad flag) isn't masked by a later/earlier warning line.
          const lines = d.toString().split('\n').filter((l: string) => l.trim())
          const meaningful = lines.filter((l: string) => !/^\s*Warning:/i.test(l))
          stderrLast = meaningful.slice(-1)[0] || stderrLast || lines.slice(-1)[0] || ''
        })

        let cleanedUp = false
        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          clearInterval(hb)
          clearTimeout(watchdog)
          try { fs.unlinkSync(factsPath) } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
              console.warn(`[chat] failed to remove ${factsPath}: ${(e as Error).message}`)
          }
        }
        // Kill the whole process group (claude spawns children); it may
        // already be dead, in which case the kill throws and that's fine.
        const killProc = () => {
          try { process.kill(-proc.pid!, 'SIGKILL') } catch { /* already exited */ }
        }

        // Watchdog: a hung claude process would otherwise hold the SSE
        // stream (and the temp facts file) open forever.
        const CHAT_TIMEOUT_MS = 180_000
        const watchdog = setTimeout(() => {
          console.warn(`[chat] claude timed out after ${CHAT_TIMEOUT_MS / 1000}s — killing`)
          send('error', { message: `coach timed out after ${CHAT_TIMEOUT_MS / 1000}s — try again` })
          send('done', { ok: false })
          killProc()
          cleanup()
          res.end()
        }, CHAT_TIMEOUT_MS)

        req.on('close', () => {
          killProc()
          cleanup()
        })

        proc.on('error', (err) => {
          const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? '`claude` CLI not found in PATH — install Claude Code (https://claude.com/claude-code) and restart the dev server'
            : `failed to start claude: ${err.message}`
          console.error(`[chat] ${msg}`)
          send('error', { message: msg })
          send('done', { ok: false })
          cleanup()
          res.end()
        })

        proc.on('close', async (code) => {
          if (res.writableEnded) { cleanup(); return }
          // cleanup() clears the watchdog, so it must NOT run before the
          // awaits below — a stalled fs op would otherwise hold the SSE
          // stream open forever with no timeout. finish() runs it last.
          const finish = () => { cleanup(); if (!res.writableEnded) res.end() }
          if (code !== 0) {
            const hint = authHint(`${stderrLast}\n${stdout}`)
            send('error', { message: hint ?? `claude exited ${code}: ${stderrLast.slice(0, 240)}` })
            send('done', { ok: false })
            finish()
            return
          }
          try {
            const wrapper = JSON.parse(stdout)
            const text = (wrapper && typeof wrapper === 'object' && wrapper.result)
              ? wrapper.result : stdout
            // Some CLI versions exit 0 with is_error + the auth message in result
            const hint = wrapper?.is_error ? authHint(String(text)) : null
            if (hint) {
              send('error', { message: hint })
              send('done', { ok: false })
              finish()
              return
            }
            // The agent may end its reply with one or more <<<CONTEXT_SAVE
            // ...>>> blocks (see CHAT_SYSTEM) — the only persistence path
            // chat has, since the CLI runs with Read-only tools. Only
            // TRAILING blocks count: they're peeled off the end one at a
            // time, so a sentinel the agent merely QUOTED mid-reply (e.g.
            // explaining the format in a code fence) is neither saved nor
            // stripped. Peeled blocks never reach localStorage, so replayed
            // transcripts can't re-trigger saves. Failures (malformed JSON,
            // all items rejected, write error) surface via meta.
            let display = String(text).trim()
            const pendingItems: unknown[] = []
            const pendingSections: unknown[] = []
            const saveErrors: string[] = []
            // peel from the LAST marker each pass — a leftmost regex match
            // would span two adjacent blocks (lazy or not) and fail to parse
            const SAVE_START = '<<<CONTEXT_SAVE'
            const SAVE_END = 'CONTEXT_SAVE>>>'
            const TRAILING_SAVE_RE = /^<<<CONTEXT_SAVE\s*([\s\S]*?)\s*CONTEXT_SAVE>>>\s*$/
            for (;;) {
              const i = display.lastIndexOf(SAVE_START)
              if (i < 0) break
              const m = display.slice(i).match(TRAILING_SAVE_RE)
              if (!m) break // not a clean trailing block (e.g. quoted mid-reply) — leave it visible
              try {
                const parsed = JSON.parse(m[1])
                const items = parsed?.items
                const sects = parsed?.section_appends
                if (Array.isArray(items)) pendingItems.unshift(...items)
                else if (items !== undefined) saveErrors.push('items was not an array')
                if (Array.isArray(sects)) pendingSections.unshift(...sects)
                else if (sects !== undefined) saveErrors.push('section_appends was not an array')
                if (items === undefined && sects === undefined) saveErrors.push('save block had neither items nor section_appends')
              } catch (e) {
                saveErrors.push(`malformed save block: ${(e as Error).message}`)
              }
              display = display.slice(0, i).trim()
            }
            // a marker INSIDE a saved text makes the parse fail mid-block and
            // can leave the unclosed head of the outer block visible — strip
            // any trailing start-marker with no end-marker after it (a quoted
            // COMPLETE example still has its end marker, so it survives)
            {
              const j = display.lastIndexOf(SAVE_START)
              if (j >= 0 && !display.slice(j).includes(SAVE_END)) {
                display = display.slice(0, j).trim()
                saveErrors.push('stripped an unclosed save block from the reply')
              }
            }
            let savedContext: { text: string; expires: string }[] = []
            let savedSections: { section: string; text: string }[] = []
            if (pendingItems.length > 0 || pendingSections.length > 0) {
              try {
                const stateMod = await import(path.join(projectRoot, 'scripts/state.mjs')) as {
                  loadState: (root: string) => Promise<{ preferences?: Record<string, unknown> }>
                  saveState: (root: string, s: unknown) => Promise<unknown>
                  appendContextItems: (s: unknown, i: unknown) => {
                    state: unknown
                    added: { text: string; expires: string }[]
                    dropped: unknown[]
                  }
                  appendSectionText: (s: unknown, a: unknown) => {
                    state: unknown
                    added: { section: string; text: string }[]
                    dropped: { reason?: string }[]
                  }
                }
                const fresh = await stateMod.loadState(projectRoot)
                const itemsRes = stateMod.appendContextItems(fresh, pendingItems)
                const sectsRes = stateMod.appendSectionText(itemsRes.state, pendingSections)
                if (itemsRes.added.length > 0 || sectsRes.added.length > 0) {
                  await stateMod.saveState(projectRoot, sectsRes.state)
                }
                savedContext = itemsRes.added.map((a) => ({ text: a.text, expires: a.expires }))
                savedSections = sectsRes.added
                const droppedCount = itemsRes.dropped.length + sectsRes.dropped.length
                if (droppedCount > 0) {
                  const reasons = sectsRes.dropped.map((d) => d.reason).filter(Boolean).join('; ')
                  saveErrors.push(`${droppedCount} save(s) failed validation and were not stored${reasons ? ` (${reasons})` : ''}`)
                }
              } catch (e) {
                saveErrors.push(`context write failed: ${(e as Error).message}`)
              }
            }
            const saveError = saveErrors.length > 0 ? saveErrors.join(' · ') : null
            if (saveError) console.warn(`[chat] context save problem: ${saveError}`)
            send('message', {
              role: 'assistant',
              content: display,
              meta: {
                num_turns: wrapper?.num_turns ?? null,
                cost_usd: wrapper?.total_cost_usd ?? null,
                duration_ms: wrapper?.duration_ms ?? null,
                saved_context: savedContext,
                saved_sections: savedSections,
                context_save_error: saveError,
              },
            })
            send('done', { ok: true })
          } catch (e) {
            send('error', { message: `parse error: ${(e as Error).message}\n${stdout.slice(0, 240)}` })
            send('done', { ok: false })
          }
          finish()
        })
      })
    },
  }
}

// Dev-only settings endpoints backing the coach settings dialog (gear icon
// in the coach rail).
//   GET /api/settings — current preferences (state.json) + calendar config
//                       (profile.json) + today's date for expiry rendering
//   PUT /api/settings — validated write of ONLY the settings-owned keys:
//     state.json:   preferences (state is re-loaded fresh before the write
//                   and nothing else is touched; context.temporary is merged
//                   by id, not replaced. A load→save TOCTOU window remains —
//                   a coach saveState landing inside it is lost — accepted
//                   for a single-user local app; scripts/coach.mjs
//                   symmetrically re-loads before its merge)
//     profile.json: childcare_markers + calendar_keywords only (race_base,
//                   calendar_ids etc. are never rewritten)
function settingsApi(): Plugin {
  const projectRoot = path.resolve(__dirname, '..')
  const profilePath = path.join(projectRoot, 'config', 'profile.json')
  // Local calendar date (en-CA formats as YYYY-MM-DD) — must match the
  // local-date expiry semantics in scripts/state.mjs, not UTC, or items
  // flip "expired" hours early in the evening.
  const localToday = () => new Date().toLocaleDateString('en-CA')
  // corrupt != missing: a profile.json that EXISTS but fails to parse must
  // never be silently replaced by example-derived content on save — that
  // would turn a stray trailing comma into unrecoverable loss of the whole
  // (gitignored) profile.
  const readProfile = (): { profile: Record<string, unknown>; corrupt: boolean } => {
    try {
      return { profile: JSON.parse(fs.readFileSync(profilePath, 'utf8')), corrupt: false }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[settings] config/profile.json exists but failed to parse: ${(e as Error).message}`)
        return { profile: {}, corrupt: true }
      }
    }
    try {
      return { profile: JSON.parse(fs.readFileSync(path.join(projectRoot, 'config', 'profile.example.json'), 'utf8')), corrupt: false }
    } catch { /* no example either */ }
    return { profile: {}, corrupt: false }
  }

  const SECTION_KEYS = ['about_me', 'calendar_conventions', 'training_preferences']
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
  // round-trip check rejects rollover dates ("2026-02-30") that Date.parse accepts
  const isValidIsoDate = (s: unknown): s is string => {
    if (typeof s !== 'string' || !ISO_DATE_RE.test(s)) return false
    const d = new Date(`${s}T12:00:00`)
    return !Number.isNaN(d.getTime()) && d.toLocaleDateString('en-CA') === s
  }
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  // Returns {error} or the validated, normalized payload. context.sections
  // carries ONLY the keys the client sent (merged over fresh state at apply
  // time — a partial PUT must never blank a section it didn't mention).
  const validate = (body: Record<string, unknown>): {
    error?: string
    prefs?: Record<string, unknown>
    context?: {
      sections: Record<string, string>
      sectionsBaseline: Record<string, string> | null
      temporary: Record<string, unknown>[]
      knownIds: string[] | null
    }
    calendar?: { childcare_markers: string[]; calendar_keywords: Record<string, string[]> }
  } => {
    const prefs: Record<string, unknown> = {}
    if (body.preferences !== undefined && !isPlainObject(body.preferences)) return { error: 'preferences: object required' }
    const p = (body.preferences ?? {}) as Record<string, unknown>
    for (const key of ['training_philosophy', 'weekly_rest_day']) {
      if (p[key] === undefined) continue
      if (typeof p[key] !== 'string' || (p[key] as string).length > 200) return { error: `preferences.${key}: string ≤ 200 chars required` }
      prefs[key] = p[key]
    }
    const numBounds: Record<string, [number, number]> = {
      nutrition_target_kcal_per_hour: [0, 1000],
      heat_threshold_c: [-10, 50],
    }
    for (const [key, [lo, hi]] of Object.entries(numBounds)) {
      if (p[key] === undefined) continue
      const n = p[key]
      if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) return { error: `preferences.${key}: number in [${lo}, ${hi}] required` }
      prefs[key] = n
    }
    let context
    if (p.context !== undefined) {
      if (!isPlainObject(p.context)) return { error: 'preferences.context: object required' }
      const ctx = p.context as { sections?: unknown; temporary?: unknown; known_ids?: unknown }
      if (ctx.sections !== undefined && !isPlainObject(ctx.sections)) return { error: 'context.sections: object required' }
      const sections: Record<string, string> = {}
      for (const [key, v] of Object.entries((ctx.sections ?? {}) as Record<string, unknown>)) {
        if (!SECTION_KEYS.includes(key)) return { error: `context.sections.${key}: unknown section` }
        if (typeof v !== 'string' || v.length > 4000) return { error: `context.sections.${key}: string ≤ 4000 chars required` }
        sections[key] = v
      }
      const rawTemp = ctx.temporary ?? []
      if (!Array.isArray(rawTemp) || rawTemp.length > 50) return { error: 'context.temporary: array of ≤ 50 items required' }
      const today = localToday()
      const temporary = []
      for (const [i, raw] of rawTemp.entries()) {
        const t = (raw ?? {}) as Record<string, unknown>
        const text = typeof t.text === 'string' ? t.text.trim() : ''
        if (!text || text.length > 2000) return { error: `context.temporary[${i}].text: non-empty string ≤ 2000 chars required` }
        if (!isValidIsoDate(t.expires)) {
          return { error: `context.temporary[${i}].expires: real YYYY-MM-DD date required` }
        }
        temporary.push({
          id: typeof t.id === 'string' && t.id ? t.id : `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          text,
          added: isValidIsoDate(t.added) ? t.added : today,
          expires: t.expires,
          source: t.source === 'agent' ? 'agent' : 'user',
        })
      }
      if (ctx.known_ids !== undefined && (!Array.isArray(ctx.known_ids) || ctx.known_ids.some((x) => typeof x !== 'string'))) {
        return { error: 'context.known_ids: string array required' }
      }
      // the section text as of the dialog's GET — lets the server detect and
      // re-apply agent appends that landed while the dialog was open
      let sectionsBaseline: Record<string, string> | null = null
      const rawBase = (ctx as { sections_baseline?: unknown }).sections_baseline
      if (rawBase !== undefined) {
        if (!isPlainObject(rawBase)) return { error: 'context.sections_baseline: object required' }
        sectionsBaseline = {}
        for (const [key, v] of Object.entries(rawBase)) {
          if (!SECTION_KEYS.includes(key)) return { error: `context.sections_baseline.${key}: unknown section` }
          if (typeof v !== 'string') return { error: `context.sections_baseline.${key}: string required` }
          sectionsBaseline[key] = v
        }
      }
      context = { sections, sectionsBaseline, temporary, knownIds: (ctx.known_ids as string[] | undefined) ?? null }
    }
    let calendar
    if (body.calendar !== undefined) {
      if (!isPlainObject(body.calendar)) return { error: 'calendar: object required' }
      const c = body.calendar as Record<string, unknown>
      const markers = c.childcare_markers ?? []
      if (!Array.isArray(markers) || markers.some((m) => typeof m !== 'string')) return { error: 'calendar.childcare_markers: string array required' }
      const normMarkers = (markers as string[]).map((m) => m.trim().toLowerCase()).filter(Boolean)
      // the calendar classifier matches markers against single WORDS of the
      // event title — a marker containing a space can never match anything
      const spaced = normMarkers.find((m) => /\s/.test(m))
      if (spaced) return { error: `calendar.childcare_markers: "${spaced}" contains a space — markers match single words in event titles` }
      const keywords: Record<string, string[]> = {}
      const rawKw = c.calendar_keywords ?? {}
      if (!isPlainObject(rawKw)) return { error: 'calendar.calendar_keywords: object of string arrays required' }
      for (const [cls, words] of Object.entries(rawKw as Record<string, unknown>)) {
        if (!Array.isArray(words) || words.some((w) => typeof w !== 'string')) return { error: `calendar.calendar_keywords.${cls}: string array required` }
        keywords[cls] = (words as string[]).map((w) => w.trim().toLowerCase()).filter(Boolean)
      }
      calendar = { childcare_markers: normMarkers, calendar_keywords: keywords }
    }
    return { prefs, context, calendar }
  }

  return {
    name: 'trail-train-settings-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/settings', async (req, res) => {
        const json = (code: number, payload: unknown) => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        }
        try {
          const stateMod = await import(path.join(projectRoot, 'scripts/state.mjs')) as {
            loadState: (root: string) => Promise<{ preferences?: Record<string, unknown> }>
            saveState: (root: string, s: unknown) => Promise<{ preferences?: Record<string, unknown> }>
          }
          if (req.method === 'GET') {
            const state = await stateMod.loadState(projectRoot)
            const { profile, corrupt } = readProfile()
            json(200, {
              preferences: state.preferences ?? {},
              calendar: {
                childcare_markers: profile.childcare_markers ?? [],
                calendar_keywords: profile.calendar_keywords ?? {},
              },
              calendar_error: corrupt
                ? 'config/profile.json exists but failed to parse — calendar edits are disabled until it is fixed by hand'
                : null,
              today: localToday(),
            })
            return
          }
          if (req.method !== 'PUT') { res.statusCode = 405; res.end('GET or PUT required'); return }
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          let body: Record<string, unknown>
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
          catch { json(400, { error: 'bad json' }); return }

          const { error, prefs, context, calendar } = validate(body)
          if (error) { json(400, { error }); return }

          // refuse the whole write BEFORE touching anything if the calendar
          // edit would be based on a corrupt profile.json
          if (calendar && readProfile().corrupt) {
            json(409, { error: 'config/profile.json exists but could not be parsed — fix it by hand first; refusing to overwrite it' })
            return
          }

          const fresh = await stateMod.loadState(projectRoot)
          const freshPrefs = (fresh.preferences ?? {}) as Record<string, unknown>
          let nextContext = freshPrefs.context
          if (context) {
            const freshCtx = (freshPrefs.context ?? {}) as { sections?: Record<string, string>; temporary?: { id: string }[] }
            // Merge, don't replace: the coach/chat may have appended items
            // while the dialog was open. The client's list wins for every id
            // it KNEW about (edits and deletions); ids it never saw are
            // preserved. known_ids is the snapshot from the dialog's GET;
            // absent (curl), fall back to the sent ids — then nothing can be
            // deleted implicitly, only via an explicit known_ids.
            const knownIds = new Set(context.knownIds ?? context.temporary.map((t) => t.id as string))
            const clientIds = new Set(context.temporary.map((t) => t.id as string))
            const preserved = (freshCtx.temporary ?? []).filter((t) => !knownIds.has(t.id) && !clientIds.has(t.id))
            // Sections: the client's text wins, but an agent append that
            // landed AFTER the dialog's GET (fresh = baseline + tail) is
            // re-applied on top so it isn't silently clobbered. Without a
            // baseline (curl), the client's text simply wins.
            const mergedSections: Record<string, string> = { ...(freshCtx.sections ?? {}) }
            for (const [key, clientText] of Object.entries(context.sections)) {
              const freshText = mergedSections[key] ?? ''
              const base = context.sectionsBaseline?.[key]
              if (typeof base === 'string' && freshText !== base && freshText.startsWith(base)) {
                mergedSections[key] = clientText + freshText.slice(base.length)
              } else {
                mergedSections[key] = clientText
              }
            }
            nextContext = {
              sections: mergedSections,
              temporary: [...context.temporary, ...preserved],
            }
          }
          fresh.preferences = { ...freshPrefs, ...prefs, ...(nextContext !== undefined ? { context: nextContext } : {}) }
          const saved = await stateMod.saveState(projectRoot, fresh)

          let savedCalendar = null
          if (calendar) {
            try {
              const { writeJsonAtomic } = await import(path.join(projectRoot, 'scripts/lib.mjs')) as {
                writeJsonAtomic: (p: string, v: unknown) => Promise<void>
              }
              // gitignored — creating it from the example content is safe
              const nextProfile = { ...readProfile().profile, ...calendar }
              await writeJsonAtomic(profilePath, nextProfile)
              savedCalendar = calendar
            } catch (e) {
              // state.json already committed — report the partial write
              // honestly instead of a blanket failure
              console.warn(`[settings] profile.json write failed: ${(e as Error).message}`)
              json(500, {
                error: `preferences were saved, but writing calendar config to config/profile.json failed: ${(e as Error).message}`,
                preferences: saved.preferences,
              })
              return
            }
          }
          json(200, { preferences: saved.preferences, calendar: savedCalendar })
        } catch (e) {
          json(500, { error: (e as Error).message })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), refreshApi(), chatApi(), settingsApi()],
})
