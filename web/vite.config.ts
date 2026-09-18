import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Cross-site request guard for the state-changing dev endpoints. These
// middlewares spawn subprocesses (the `claude` CLI, the sync scripts) and
// write files, with no auth — fine for a localhost tool, EXCEPT that a
// browser will happily send a cross-origin "simple" POST (Content-Type
// text/plain needs no preflight) from any page the user has open, so a
// hostile tab could blind-fire /api/chat or /api/refresh at us. The Basecamp
// launcher sharpens this: a fixed, README-published port that is up all day.
// So reject any request whose Origin is not this same loopback server. A
// missing Origin is allowed — that is a non-browser caller (curl, an internal
// call), which is not the CSRF threat model (a local process needs no CSRF).
// The Host is also pinned to loopback as cheap defense against DNS-rebinding.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
function crossSiteBlocked(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin
  if (origin) {
    let ok: boolean
    try { ok = LOOPBACK_HOSTS.has(new URL(origin).hostname) } catch { ok = false }
    if (!ok) {
      res.statusCode = 403
      res.end('cross-origin request refused')
      return true
    }
  }
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  if (host && !LOOPBACK_HOSTS.has(host)) {
    res.statusCode = 403
    res.end('non-loopback host refused')
    return true
  }
  return false
}

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
        if (crossSiteBlocked(req, res)) return
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

/* Known headless-CLI failures ("sign in again", "wait for the limit to
   reset") are classified in scripts/agent-run.mjs, shared with the resync
   coach and the race intake so all three say the same thing about the same
   failure. vite.config.ts cannot statically import from scripts/ (ESM JS
   outside the TS project), so it is loaded per request like the other script
   imports here. */
type FailureHint = (text: string) => string | null
const AUTH_FIX = 'open a terminal, run `claude`, type `/login` and finish the browser sign-in, then retry here.'
async function loadFailureHint(projectRoot: string): Promise<FailureHint> {
  try {
    const m = await import(path.join(projectRoot, 'scripts/agent-run.mjs')) as { failureHint: FailureHint }
    return m.failureHint
  } catch (e) {
    // Losing the classifier degrades the MESSAGE, not the answer — but it
    // would silently turn "your sign-in expired" back into "exited 1", so say
    // so in the server log rather than swallowing it.
    console.error(`[chat] scripts/agent-run.mjs failed to load — CLI failures will be reported unclassified: ${(e as Error).message}`)
    return () => null
  }
}

/* The coach's system prompt and the model it runs on live in
   scripts/coach-prompt.mjs, shared with the resync readout (scripts/coach.mjs)
   so the two cannot describe the athlete's race differently or spawn different
   models — they used to be two hand-synced copies. Same request-time import as
   facts.mjs above: vite.config.ts is in the TS project, scripts/ is plain ESM
   JS outside it. No fallback on purpose — a chat turn with no system prompt is
   not a degraded answer, it is a different agent, so the request fails loudly. */
type CoachPrompt = {
  COACH_MODEL: string
  chatSystemPrompt: (
    facts: unknown,
    profile: Record<string, unknown>,
    opts: {
      factsPath: string
      coachPath: string
      units?: 'imperial' | 'metric'
      hasPacing?: boolean
      root?: string
    },
  ) => string
}
function loadCoachPrompt(projectRoot: string): Promise<CoachPrompt> {
  return import(path.join(projectRoot, 'scripts/coach-prompt.mjs')) as Promise<CoachPrompt>
}

/* Turn budget for the headless coach.
   Measured against a two-large-snapshot question (sleep trend + weekend
   calendar) on 2026-08-23: 11 turns / 134 s to a complete answer. The old
   ceiling of 6 could not even finish paging the files, so every such question
   died as `error_max_turns` with a null result. Read truncates at 2000 lines
   and oura.json alone is ~5k, so one snapshot can cost 3 turns.
   The timeout has to move with the ceiling — at 180 s that same successful run
   used 74% of the watchdog, so raising turns alone just trades one failure
   message for the other. Headroom over the measurement is deliberate: question
   complexity varies and the retry below is a fallback, not a plan. */
const CHAT_MAX_TURNS = 16
const CHAT_TIMEOUT_MS = 300_000
/* One retry when the budget is what failed. The agent is told to answer from
   what it already read, so a blown budget degrades to a partial answer instead
   of an error the athlete can do nothing with. Only ever once. */
const MAX_TURNS_SUBTYPE = 'error_max_turns'
/* A no-tools answer is one model turn, but it still has to be generated —
   measured no-tool replies land around 20-30 s. Below this much remaining
   budget the retry would be killed mid-sentence, so we skip it and report the
   failure honestly instead of promising an answer we cannot deliver. */
const RETRY_MIN_RUNWAY_MS = 60_000
const RETRY_NUDGE = '\n\nIMPORTANT: a previous attempt at this exact question ran out of tool calls before answering. Do NOT open any files this time. Answer now, directly, from what you already know, and say plainly which data you could not consult.'

function chatApi(): Plugin {
  const projectRoot = path.resolve(__dirname, '..')
  return {
    name: 'trail-train-chat-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/chat', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
        if (crossSiteBlocked(req, res)) return

        // Read JSON body
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        let body: { messages?: Array<{ role: string; content: string }>; units?: string }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
        catch { res.statusCode = 400; res.end('bad json'); return }
        const messages = body.messages || []
        const chatUnits: 'imperial' | 'metric' = body.units === 'imperial' ? 'imperial' : 'metric'
        if (!messages.length) { res.statusCode = 400; res.end('no messages'); return }

        // Compute facts → write to temp file the agent can Read. The digest is
        // kept in memory too: the system prompt is built from the same object
        // (race paragraph, goals, history), not re-derived from the file.
        let factsPath = ''
        let facts: { pacing?: unknown }
        let coachPrompt: CoachPrompt
        try {
          facts = await import(path.join(projectRoot, 'scripts/facts.mjs'))
            .then((m: { loadFactsFromRoot: (root: string) => Promise<{ pacing: unknown }> }) => m.loadFactsFromRoot(projectRoot))
          coachPrompt = await loadCoachPrompt(projectRoot)
          factsPath = path.join(os.tmpdir(), `trail-chat-${Date.now()}.json`)
          fs.writeFileSync(factsPath, JSON.stringify(facts, null, 2))
        } catch (e) {
          res.statusCode = 500
          res.end(`facts error: ${(e as Error).message}`)
          return
        }
        const coachPath = path.join(projectRoot, 'web', 'public', 'coach.json')
        // loaded before the spawn so the close handlers below can classify
        // synchronously
        const failureHint = await loadFailureHint(projectRoot)

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
        const sysPrompt = coachPrompt.chatSystemPrompt(facts, profile, {
          factsPath,
          coachPath,
          units: chatUnits,
          hasPacing: Boolean(facts.pacing),
          root: projectRoot,
        })
        send('start', { facts_path: factsPath })

        let stdout = ''
        let stderrLast = ''
        // `proc` is reassigned by the max-turns retry below, so kills and the
        // watchdog must target whichever attempt is currently running.
        let proc: ReturnType<typeof spawn> | undefined
        let retried = false
        // start of the whole exchange, not of the current attempt — the
        // watchdog spans both, so the retry decision measures against this
        const startedAt = Date.now()
        const hb = setInterval(() => send('heartbeat', { t: Date.now() }), 4000)

        const startAttempt = (promptText: string, maxTurns: number) => {
          stdout = ''
          stderrLast = ''
          proc = spawn('claude', [
            '-p', promptText,
            '--output-format', 'json',
            '--model', coachPrompt.COACH_MODEL,
            '--max-turns', String(maxTurns),
            '--allowedTools', 'Read',
            '--append-system-prompt', sysPrompt,
          // stdin must be ignored (as in scripts/coach.mjs) — the default pipe
          // stays open forever, and the CLI stalls 3s in -p mode waiting on it,
          // then emits a "no stdin data received" warning that pollutes stderr.
          ], { cwd: projectRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })

          proc.stdout!.on('data', (d) => { stdout += d })
          proc.stderr!.on('data', (d) => {
            // Keep the last line that isn't a warning, so a fatal error (auth
            // expiry, bad flag) isn't masked by a later/earlier warning line.
            const lines = d.toString().split('\n').filter((l: string) => l.trim())
            const meaningful = lines.filter((l: string) => !/^\s*Warning:/i.test(l))
            stderrLast = meaningful.slice(-1)[0] || stderrLast || lines.slice(-1)[0] || ''
          })
          proc.on('error', onProcError)
          proc.on('close', onProcClose)
        }

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
          const pid = proc?.pid
          if (pid == null) return // never started, or already reaped
          try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ }
        }

        // Watchdog: a hung claude process would otherwise hold the SSE
        // stream (and the temp facts file) open forever. It covers the WHOLE
        // exchange rather than restarting per attempt, so the retry runs
        // inside the remaining budget instead of doubling the worst case.
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

        function onProcError(err: Error) {
          const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? '`claude` CLI not found in PATH — install Claude Code (https://claude.com/claude-code) and restart the dev server'
            : `failed to start claude: ${err.message}`
          console.error(`[chat] ${msg}`)
          send('error', { message: msg })
          send('done', { ok: false })
          cleanup()
          res.end()
        }

        /* Running out of tool calls is the one failure the athlete can do
           nothing about and we can. Returns true when a retry was started, in
           which case the caller must return immediately and leave the stream
           open — the watchdog and heartbeat keep running across attempts.

           Called from BOTH close paths. The CLI reports this failure with a
           nonzero exit on the version measured here, but the pre-existing
           comment further down records that some versions exit 0 with an
           is_error wrapper instead, so gating the retry on the exit code would
           leave the whole feature inert on those builds.

           Gated on the wrapper's own structured subtype — never on message
           text, which is the athlete's coaching prose (the PR #17 trap). */
        function maybeRetryMaxTurns(isError: boolean | null, subtype: string): boolean {
          if (retried || isError !== true || subtype !== MAX_TURNS_SUBTYPE) return false
          // The watchdog covers the whole exchange rather than restarting per
          // attempt, so a first attempt that burns most of the budget can leave
          // the retry no room to finish. Promising "answering from what was
          // read" and then killing it mid-sentence is worse than saying plainly
          // that we ran out — so only retry when the remaining budget can
          // actually carry a no-tools answer.
          const leftMs = CHAT_TIMEOUT_MS - (Date.now() - startedAt)
          if (leftMs < RETRY_MIN_RUNWAY_MS) {
            console.warn(`[chat] hit the turn limit but only ${Math.round(leftMs / 1000)}s left — not retrying`)
            return false
          }
          retried = true
          console.warn('[chat] hit the turn limit — retrying once, no-tools')
          send('notice', { message: 'took too long gathering data — answering from what was read' })
          startAttempt(prompt + RETRY_NUDGE, 3)
          return true
        }

        async function onProcClose(code: number | null) {
          if (res.writableEnded) { cleanup(); return }
          // cleanup() clears the watchdog, so it must NOT run before the
          // awaits below — a stalled fs op would otherwise hold the SSE
          // stream open forever with no timeout. finish() runs it last.
          const finish = () => { cleanup(); if (!res.writableEnded) res.end() }
          if (code !== 0) {
            // The CLI often exits nonzero with an empty stderr and the real
            // message inside the stdout JSON wrapper's `result` — surface
            // whichever detail exists instead of a bare "claude exited 1:".
            let resultText = ''
            let wrapperSubtype = ''
            // null = stdout wasn't a wrapper (unparseable, array, or no
            // boolean is_error field) — only an explicit is_error:false
            // counts as a confirmed valid reply
            let wrapperIsError: boolean | null = null
            try {
              const w = JSON.parse(stdout)
              if (w && typeof w === 'object' && !Array.isArray(w)) {
                if (typeof w.is_error === 'boolean') wrapperIsError = w.is_error
                if (typeof w.result === 'string') resultText = w.result.trim()
                if (typeof w.subtype === 'string') wrapperSubtype = w.subtype
              }
            } catch { /* stdout wasn't the JSON wrapper */ }
            console.error(`[chat] claude exited ${code}\nstderr: ${stderrLast.slice(0, 800)}\nstdout: ${stdout.slice(0, 800)}`)
            if (maybeRetryMaxTurns(wrapperIsError, wrapperSubtype)) return
            // A confirmed NON-error wrapper holds coaching prose, not an
            // error message — keep it away from the classifier ("overloaded",
            // "hit your … limit" are normal coach vocabulary) and out of the
            // surfaced detail. A confirmed error wrapper's result outranks
            // stderr noise; its subtype outranks the raw wrapper JSON.
            const hint = failureHint(wrapperIsError === false ? stderrLast : `${stderrLast}\n${stdout}`)
            const stderrTrim = stderrLast.trim()
            const detail = wrapperIsError === true
              ? (resultText || wrapperSubtype || stderrTrim)
              : wrapperIsError === false
                ? stderrTrim
                : (stderrTrim || stdout.trim())
            send('error', {
              message: hint
                // the raw subtype is CLI vocabulary, not something to hand a
                // reader — say what happened and what actually helps. `retried`
                // distinguishes "tried twice and still ran out" from "ran out
                // with too little time left to try again", which are different
                // situations and would be a lie to describe identically.
                ?? (wrapperSubtype === MAX_TURNS_SUBTYPE
                  ? (retried
                    ? 'The coach ran out of tool calls before it could answer, twice. Try a narrower question, or one that leans on the readout rather than the raw snapshots.'
                    : 'The coach ran out of tool calls before it could answer, with too little time left to try again. Try a narrower question, or one that leans on the readout rather than the raw snapshots.')
                  : detail
                    ? `claude exited ${code}: ${detail.slice(0, 800)}`
                    : wrapperIsError === false
                      ? `claude exited ${code} after producing a normal reply (likely a teardown error) — try again.`
                      : `claude exited ${code} with no error output — this is most often an expired sign-in: ${AUTH_FIX}`),
            })
            send('done', { ok: false })
            finish()
            return
          }
          try {
            const wrapper = JSON.parse(stdout)
            const text = (wrapper && typeof wrapper === 'object' && wrapper.result)
              ? wrapper.result : stdout
            // Some CLI versions exit 0 with is_error + the real message
            // (auth expiry, usage limit, …) in result — render those as an
            // error bubble, not as a coach reply. `result` can be empty on
            // some error subtypes; fall back to the subtype, never the raw
            // wrapper JSON.
            if (wrapper?.is_error) {
              // same max-turns retry as the nonzero-exit path — this branch
              // exists precisely because some CLI versions exit 0 on failure
              if (maybeRetryMaxTurns(true, typeof wrapper.subtype === 'string' ? wrapper.subtype : '')) return
              const errText = typeof wrapper.result === 'string' ? wrapper.result.trim() : ''
              const hint = failureHint(errText || stdout)
              console.error(`[chat] claude reported is_error: ${(errText || stdout).slice(0, 800)}`)
              send('error', { message: hint ?? `coach failed: ${errText.slice(0, 800) || (typeof wrapper.subtype === 'string' ? wrapper.subtype : '') || 'no detail from claude'}` })
              send('done', { ok: false })
              finish()
              return
            }
            // The agent may end its reply with one or more <<<CONTEXT_SAVE
            // ...>>> blocks (see chatSystemPrompt in scripts/coach-prompt.mjs)
            // — the only persistence path
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
        }

        startAttempt(prompt, CHAT_MAX_TURNS)
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
//     goals.json:   the whole generic-mode goals object (PRD §5.3) — it is
//                   small, wholly settings-owned, and nothing else writes it
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
  // KEEP IN SYNC with GOAL_PHASES in scripts/goals.mjs — vite.config.ts
  // can't statically import from scripts/ (its tsconfig has no allowJs), and
  // an unvalidated phase would reach the coach prompt verbatim.
  const GOAL_PHASES = ['recovery', 'return_to_run', 'base', 'build', 'peak', 'taper', 'maintain']
  // [lo, hi] ceilings, generous enough for a 100-mile build
  const BAND_BOUNDS: Record<string, number> = { dist_mi: 500, vert_ft: 200000 }
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
    goals?: Record<string, unknown>
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
    let goals
    if (body.goals !== undefined) {
      if (!isPlainObject(body.goals)) return { error: 'goals: object required' }
      const g = body.goals as Record<string, unknown>
      const strings: Record<string, number> = { event_class: 200, horizon: 200, notes: 2000 }
      const next: Record<string, unknown> = {}
      for (const [key, max] of Object.entries(strings)) {
        const v = g[key] ?? ''
        if (typeof v !== 'string' || v.length > max) return { error: `goals.${key}: string ≤ ${max} chars required` }
        next[key] = v.trim()
      }
      if (!next.event_class) return { error: 'goals.event_class: non-empty string required' }
      if (!GOAL_PHASES.includes(g.phase as string)) {
        return { error: `goals.phase must be one of ${GOAL_PHASES.join(' | ')}` }
      }
      next.phase = g.phase
      if (!isPlainObject(g.weekly_volume_band)) return { error: 'goals.weekly_volume_band: object required' }
      const band: Record<string, number[]> = {}
      for (const [key, max] of Object.entries(BAND_BOUNDS)) {
        const pair = (g.weekly_volume_band as Record<string, unknown>)[key]
        if (!Array.isArray(pair) || pair.length !== 2
          || pair.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > max)) {
          return { error: `goals.weekly_volume_band.${key}: [lo, hi] numbers in [0, ${max}] required` }
        }
        // a reversed band would silently invert the rolling window's target
        if ((pair[0] as number) > (pair[1] as number)) {
          return { error: `goals.weekly_volume_band.${key}: lo ${pair[0]} is above hi ${pair[1]}` }
        }
        band[key] = pair as number[]
      }
      next.weekly_volume_band = band
      goals = next
    }
    return { prefs, context, calendar, goals }
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
          const goalsMod = await import(path.join(projectRoot, 'scripts/goals.mjs')) as {
            loadGoals: (root: string) => Promise<{ goals: Record<string, unknown>; errors: string[] }>
            saveGoals: (root: string, g: unknown) => Promise<string>
          }
          if (req.method === 'GET') {
            const state = await stateMod.loadState(projectRoot)
            const { profile, corrupt } = readProfile()
            // bootstraps config/goals.json from the example on first open —
            // the dialog is the surface the athlete edits it through
            const { goals, errors: goalsErrors } = await goalsMod.loadGoals(projectRoot)
            json(200, {
              preferences: state.preferences ?? {},
              goals,
              goals_error: goalsErrors.length
                ? `config/goals.json: ${goalsErrors.join('; ')} — fix it here or by hand`
                : null,
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
          if (crossSiteBlocked(req, res)) return
          const chunks: Buffer[] = []
          for await (const c of req) chunks.push(c as Buffer)
          let body: Record<string, unknown>
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
          catch { json(400, { error: 'bad json' }); return }

          const { error, prefs, context, calendar, goals } = validate(body)
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
          // goals last: it is a standalone file, so a failure here leaves
          // state.json and profile.json correctly saved and says so
          let savedGoals = null
          if (goals) {
            try {
              await goalsMod.saveGoals(projectRoot, goals)
              savedGoals = goals
            } catch (e) {
              console.warn(`[settings] goals.json write failed: ${(e as Error).message}`)
              json(500, {
                error: `preferences were saved, but writing config/goals.json failed: ${(e as Error).message}`,
                preferences: saved.preferences,
                calendar: savedCalendar,
              })
              return
            }
          }
          json(200, { preferences: saved.preferences, calendar: savedCalendar, goals: savedGoals })
        } catch (e) {
          json(500, { error: (e as Error).message })
        }
      })
    },
  }
}

// Dev-only middleware: GET /api/race/active answers "which race, and what is
// in it?" for the client — the pointer (config/active-race.json) plus the
// folder it names, merged into one payload. `active: null` is generic mode,
// and it is described just as fully: the goals, the rolling 12-week block and
// the generic plan, so the client never has to re-derive a window the coach
// already computed. Read-only, but it still refuses cross-site callers: the
// reply carries local config a hostile tab has no business reading.
function raceApi(): Plugin {
  const projectRoot = path.resolve(__dirname, '..')
  return {
    name: 'trail-train-race-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/race/active', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('GET required'); return }
        if (crossSiteBlocked(req, res)) return
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        try {
          // vite.config.ts can't statically import from scripts/ (it is ESM
          // JS outside the TS project), so the loader is imported per request
          // — same as scripts/facts.mjs in the chat endpoint.
          const { activeRacePayload } = await import(path.join(projectRoot, 'scripts/race-payload.mjs')) as {
            activeRacePayload: (root: string, now?: number) => Promise<Record<string, unknown>>
          }
          res.statusCode = 200
          res.end(JSON.stringify(await activeRacePayload(projectRoot)))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: (e as Error).message }))
        }
      })
    },
  }
}

// Dev-only middleware: GET /nutrition.json. The fueling config used to be a
// static file in web/public; tt-yib.2 moved it into the race folder, so it is
// served from the active race — or, with none active, the most recent one —
// and the client's fetch keeps working unchanged.
// TODO(tt-yib.5): the client should read it from /api/race/active instead.
function nutritionFile(): Plugin {
  const projectRoot = path.resolve(__dirname, '..')
  return {
    name: 'trail-train-nutrition-file',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/nutrition.json', async (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('GET required'); return }
        if (crossSiteBlocked(req, res)) return
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        try {
          const { loadRaceOrMostRecent } = await import(path.join(projectRoot, 'scripts/race-config.mjs')) as {
            loadRaceOrMostRecent: (root: string) => Promise<{ slug: string; nutrition: unknown } | null>
          }
          const folder = await loadRaceOrMostRecent(projectRoot)
          if (!folder?.nutrition) {
            // The nutrition page falls back to its own DEFAULTS, but it should
            // say why rather than quietly showing somebody else's numbers.
            res.statusCode = 404
            res.end(JSON.stringify({ error: 'no race folder carries a nutrition.json' }))
            return
          }
          res.statusCode = 200
          res.end(JSON.stringify(folder.nutrition))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: (e as Error).message }))
        }
      })
    },
  }
}

/* ----------------------------- race intake ------------------------------ */

/* Dev-only middleware backing the "New race…" dialog (PRD §8 steps 1-4):
     POST /api/race-intake/build — { slug } → stage 2 (raceBuildApi below).
     POST /api/race-intake/upload — raw file bytes plus an `X-Filename` header,
       saved under os.tmpdir(); answers { name, path } to hand to the intake.
       Raw body rather than multipart on purpose: multipart needs a parser
       dependency, and this endpoint carries exactly one file and no fields.
     POST /api/race-intake — { site_url, extra_urls[], year, uploads[], notes,
       refresh } → SSE progress like /api/refresh, then a final `done` with the
       slug and the unresolved-field list the review dialog works from.
   The intake writes ONLY races/<slug>/: never config/active-race.json, never
   web/public. The draft is inert until a human activates it. */
const UPLOAD_MAX_BYTES = 64 * 1024 * 1024
/* What the intake can actually use. An upload endpoint that accepts anything
   is a file-drop service; this one takes race sources. */
const UPLOAD_EXTS = new Set(['.pdf', '.gpx', '.kml', '.txt', '.html', '.htm'])

/* POST /api/race-intake/build — { slug } → SSE progress, then a final `done`
   carrying scripts/race-build.mjs's result.

   Stage 2 of the intake, and the only half a human can ask for again: it
   validates the folder, matches its aid stations to the course GPX, computes
   sun and rebuilds build/course.json. Deterministic — no agent turn, so no
   cost and no `claude` CLI — but slow enough (a GPX fetch, a 6k-point profile)
   to want the same streamed progress the agent stage has.

   Registered from its OWN plugin, placed BEFORE raceIntakeApi() in the plugins
   array: connect matches middleware by path prefix in registration order, so
   /api/race-intake would otherwise swallow this path the way it would an
   upload. Nothing here touches config/active-race.json — rebuilding a folder
   says nothing about which race the athlete is training for. */
function raceBuildApi(): Plugin {
  const projectRoot = path.resolve(__dirname, '..')
  /* A slug and nothing else; a body bigger than this is not one. */
  const BODY_MAX_BYTES = 64 * 1024

  return {
    name: 'trail-train-race-build-api',
    apply: 'serve',
    configureServer(server) {
      const json = (res: ServerResponse, code: number, payload: unknown) => {
        res.statusCode = code
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(payload))
      }

      server.middlewares.use('/api/race-intake/build', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST required'); return }
        if (crossSiteBlocked(req, res)) return

        const chunks: Buffer[] = []
        let total = 0
        for await (const c of req) {
          total += (c as Buffer).byteLength
          if (total > BODY_MAX_BYTES) { json(res, 413, { error: 'request body too large' }); return }
          chunks.push(c as Buffer)
        }
        let body: { slug?: unknown }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
        catch { json(res, 400, { error: 'bad json' }); return }

        const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
        /* The slug becomes a path segment, so the kebab shape is the guard as
           much as the schema: no dots, no separators, nothing to traverse. */
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
          json(res, 400, { error: 'slug: lowercase kebab-case required' })
          return
        }
        if (!fs.existsSync(path.join(projectRoot, 'races', slug, 'race.json'))) {
          json(res, 404, { error: `no race folder "${slug}" — races/${slug}/race.json is not there` })
          return
        }

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
        /* The course build is one long quiet stretch of CPU; keep the stream
           warm the way the intake and chat endpoints do. */
        const hb = setInterval(() => send('heartbeat', { t: Date.now() }), 4000)
        /* A disconnect is not an abort: race.json and build/ are written
           atomically and a half-finished build helps nobody. Let it finish. */
        req.on('close', () => { clearInterval(hb) })

        try {
          const { buildRace } = await import(path.join(projectRoot, 'scripts/race-build.mjs')) as {
            buildRace: (opts: Record<string, unknown>) => Promise<{
              slug: string
              dir: string
              unresolved: string[]
              warnings: string[]
              matched: unknown[]
              course: unknown
              sun: unknown
            }>
          }
          const result = await buildRace({
            root: projectRoot,
            slug,
            onProgress: (e: { step: string; status: string; label?: string; message?: string; stream?: string }) => {
              if (e.status === 'log') send('log', { id: e.step, line: e.message ?? '', stream: e.stream })
              else send('step', { id: e.step, status: e.status, label: e.label })
            },
          })
          send('done', {
            ok: true,
            slug: result.slug,
            dir: path.relative(projectRoot, result.dir),
            unresolved: result.unresolved,
            warnings: result.warnings,
            matched: result.matched,
            course: result.course,
            sun: result.sun,
          })
        } catch (e) {
          const message = (e as Error).message || String(e)
          console.error(`[race-build] ${message}`)
          send('error', { message })
          send('done', { ok: false, error: message })
        } finally {
          clearInterval(hb)
          if (!res.writableEnded) res.end()
        }
      })
    },
  }
}

function raceIntakeApi(): Plugin {
  const projectRoot = path.resolve(__dirname, '..')
  /* The intake call takes absolute upload paths from the client, so pin them
     to the dirs the upload endpoint writes to (plus the repo, for a file the
     owner already keeps in the project). Without this, a POST could ask the
     server to copy any file on the disk into a race folder. */
  const safeRoots = [os.tmpdir(), '/tmp', '/private/tmp', projectRoot].map((p) => {
    try { return fs.realpathSync(p) } catch { return p }
  })
  const insideSafeRoot = (p: string): boolean => {
    let real: string
    try { real = fs.realpathSync(p) } catch { return false }
    return safeRoots.some((root) => real === root || real.startsWith(root + path.sep))
  }

  const readBody = async (req: IncomingMessage, limit: number): Promise<Buffer | null> => {
    const chunks: Buffer[] = []
    let total = 0
    for await (const c of req) {
      total += (c as Buffer).byteLength
      if (total > limit) return null
      chunks.push(c as Buffer)
    }
    return Buffer.concat(chunks)
  }

  return {
    name: 'trail-train-race-intake-api',
    apply: 'serve',
    configureServer(server) {
      const json = (res: ServerResponse, code: number, payload: unknown) => {
        res.statusCode = code
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(payload))
      }

      // Registered BEFORE /api/race-intake: connect matches by prefix in
      // registration order, so the intake handler never sees an upload.
      server.middlewares.use('/api/race-intake/upload', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST required'); return }
        if (crossSiteBlocked(req, res)) return
        const raw = String(req.headers['x-filename'] ?? '')
        // basename first, then a character whitelist: neither alone stops
        // "..%2f..%2fetc%2fpasswd" from becoming a path once decoded
        const name = path.basename(decodeURIComponent(raw)).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
        if (!name || name.startsWith('.')) { json(res, 400, { error: 'X-Filename header with a plain file name required' }); return }
        const ext = path.extname(name).toLowerCase()
        if (!UPLOAD_EXTS.has(ext)) {
          json(res, 415, { error: `${ext || 'that file type'} is not an intake source — expected one of ${[...UPLOAD_EXTS].join(', ')}` })
          return
        }
        const body = await readBody(req, UPLOAD_MAX_BYTES)
        if (body === null) { json(res, 413, { error: `upload exceeds ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB` }); return }
        if (body.byteLength === 0) { json(res, 400, { error: 'empty upload' }); return }
        try {
          // One dir per upload: two manuals named manual.pdf must not collide,
          // and the intake copies out of here rather than moving.
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'basecamp-intake-upload-'))
          const dest = path.join(dir, name)
          fs.writeFileSync(dest, body)
          json(res, 200, { name, path: dest, bytes: body.byteLength })
        } catch (e) {
          json(res, 500, { error: `could not save the upload: ${(e as Error).message}` })
        }
      })

      server.middlewares.use('/api/race-intake', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST required'); return }
        if (crossSiteBlocked(req, res)) return
        const raw = await readBody(req, 1024 * 1024)
        if (raw === null) { json(res, 413, { error: 'request body too large' }); return }
        let body: {
          site_url?: string
          extra_urls?: unknown
          year?: unknown
          uploads?: unknown
          notes?: unknown
          refresh?: unknown
          slug?: unknown
        }
        try { body = JSON.parse(raw.toString('utf8') || '{}') }
        catch { json(res, 400, { error: 'bad json' }); return }

        const siteUrl = String(body.site_url ?? '').trim()
        if (!/^https?:\/\/\S+$/i.test(siteUrl)) { json(res, 400, { error: 'site_url: an http(s) URL is required' }); return }
        const year = String(body.year ?? '').trim()
        if (!/^\d{4}$/.test(year)) { json(res, 400, { error: 'year: a 4-digit edition year is required' }); return }
        const extraUrls = Array.isArray(body.extra_urls)
          ? body.extra_urls.filter((u): u is string => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u))
          : []
        const uploads: { name: string; path: string }[] = []
        for (const u of Array.isArray(body.uploads) ? body.uploads : []) {
          const up = (u ?? {}) as { name?: unknown; path?: unknown }
          if (typeof up.path !== 'string' || !up.path) { json(res, 400, { error: 'uploads[].path: string required' }); return }
          if (!insideSafeRoot(up.path)) {
            json(res, 400, { error: `uploads[].path must be a file from /api/race-intake/upload (or inside the project): ${up.path}` })
            return
          }
          uploads.push({ name: typeof up.name === 'string' && up.name ? path.basename(up.name) : path.basename(up.path), path: up.path })
        }
        const notes = typeof body.notes === 'string' ? body.notes.slice(0, 8000) : ''
        const refresh = body.refresh === true
        // Optional: the folder to write, when the caller already knows it (a
        // re-intake of an existing race). Checked before the agent runs.
        const slugHint = typeof body.slug === 'string' && body.slug ? body.slug : null
        if (slugHint && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slugHint)) {
          json(res, 400, { error: 'slug: lowercase kebab-case required' })
          return
        }

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
        // The intake's own steps are slow and quiet (a fetch pass, a PDF
        // render, one long agent turn), so keep the stream warm the way the
        // chat endpoint does or a proxy/browser can time the request out.
        const hb = setInterval(() => send('heartbeat', { t: Date.now() }), 4000)
        /* A disconnect is NOT an abort: the agent run is already in flight and
           a half-written cache helps nobody. The run finishes and the draft
           lands in races/<slug>/, where the dialog will find it. */
        req.on('close', () => { clearInterval(hb) })

        try {
          const { runIntake } = await import(path.join(projectRoot, 'scripts/race-intake.mjs')) as {
            runIntake: (opts: Record<string, unknown>) => Promise<{
              slug: string
              dir: string
              unresolved: string[]
              warnings: string[]
              race: { aid_stations?: unknown[] }
              agent: Record<string, unknown>
            }>
          }
          const result = await runIntake({
            root: projectRoot,
            siteUrl,
            extraUrls,
            year,
            uploads,
            notes,
            refresh,
            slugHint,
            onProgress: (e: { step: string; status: string; label?: string; message?: string; stream?: string }) => {
              if (e.status === 'log') send('log', { id: e.step, line: e.message ?? '', stream: e.stream })
              else send('step', { id: e.step, status: e.status, label: e.label })
            },
          })
          send('done', {
            ok: true,
            slug: result.slug,
            dir: path.relative(projectRoot, result.dir),
            aid_stations: result.race.aid_stations?.length ?? 0,
            unresolved: result.unresolved,
            warnings: result.warnings,
            agent: result.agent,
          })
        } catch (e) {
          // runIntake rejects with a sentence meant for a human — the shared
          // classifier in scripts/agent-run.mjs has already turned an expired
          // sign-in or a spent usage limit into what to do about it.
          const message = (e as Error).message || String(e)
          console.error(`[race-intake] ${message}`)
          send('error', { message })
          send('done', { ok: false, error: message })
        } finally {
          clearInterval(hb)
          if (!res.writableEnded) res.end()
        }
      })
    },
  }
}

// Dev-only middleware: GET /course.json and GET /crew-base.json. Both used to
// be static files in web/public; tt-yib.5 made them per-race generated output
// (races/<slug>/build/, written by scripts/build-course.mjs), so they are read
// from the active race — or, with none active, the most recent one — and the
// client's fetches keep working unchanged. Same shape as nutritionFile().
function courseFiles(): Plugin {
  const projectRoot = path.resolve(__dirname, '..')
  const serve = (name: 'course.json' | 'crew-base.json') =>
    async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') { res.statusCode = 405; res.end('GET required'); return }
      if (crossSiteBlocked(req, res)) return
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      try {
        const { loadRaceOrMostRecent } = await import(path.join(projectRoot, 'scripts/race-config.mjs')) as {
          loadRaceOrMostRecent: (root: string) => Promise<{ slug: string; dir: string } | null>
        }
        const folder = await loadRaceOrMostRecent(projectRoot)
        if (!folder) {
          // Generic mode with no race folders at all: 404 is what the client's
          // `missing` path already means ("not generated yet"), not an error.
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'no race folder under races/' }))
          return
        }
        let body: string
        try {
          body = await fs.promises.readFile(path.join(folder.dir, 'build', name), 'utf8')
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          res.statusCode = 404
          res.end(JSON.stringify({
            error: `races/${folder.slug}/build/${name} has not been generated — run \`npm run course:build -- --race ${folder.slug}\``,
          }))
          return
        }
        res.statusCode = 200
        res.end(body)
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: (e as Error).message }))
      }
    }
  return {
    name: 'trail-train-course-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/course.json', serve('course.json'))
      server.middlewares.use('/crew-base.json', serve('crew-base.json'))
    },
  }
}

export default defineConfig({
  // raceBuildApi BEFORE raceIntakeApi: connect matches by path prefix in
  // registration order, and /api/race-intake would otherwise swallow
  // /api/race-intake/build.
  plugins: [react(), refreshApi(), chatApi(), settingsApi(), raceApi(), nutritionFile(), courseFiles(), raceBuildApi(), raceIntakeApi()],
  // Fixed, memorable, deliberately unusual port. The 5173 default collides
  // with every other Vite project on the machine, and a colliding neighbor
  // silently claims the port so this app hops to 5174+ — which breaks the
  // Basecamp.app launcher's health check and any bookmark. strictPort makes a
  // genuine conflict fail LOUDLY instead of hopping; if 38100 is ever taken,
  // something is actually wrong.
  server: { port: 38100, strictPort: true },
  preview: { port: 38100, strictPort: true },
})
