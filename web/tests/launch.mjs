// The Playwright suite's project root: a throwaway copy of Basecamp's data
// side, and a vite dev server pointed at it.
//
// The app under test is the REAL one — web/src, web/vite.config.ts and
// scripts/*.mjs are the checkout's, not copies. Only the DATA moves: config/,
// races/ and web/public/*.json are rebuilt from web/tests/fixtures/ and
// races/_fixtures/ inside a temp directory, and TRAIL_PROJECT_ROOT points the
// dev server (and every script it imports at request time) at that directory
// instead of the checkout. Without it a UI test would read the developer's own
// gitignored Strava/Oura/calendar snapshots — and the save, acknowledge and
// activate flows would WRITE into their real race folders.
//
// Temp root layout, and why each piece is what it is:
//
//   <tmp>/config/           real files   — the pointer, profile and goals the
//                                          save/activate flows rewrite
//   <tmp>/races/<slug>/     real files   — fixture race folders, course built
//   <tmp>/web/public/       real files   — the snapshots vite serves statically
//   <tmp>/scripts           SYMLINK      — to the checkout's scripts/, so the
//                                          dev server's request-time
//                                          `import(<root>/scripts/x.mjs)` runs
//                                          the code under test rather than a
//                                          stale copy. Node resolves the link
//                                          to its real path, so those modules'
//                                          own relative imports (they reach
//                                          into ../web/src/*.ts) keep working;
//                                          they find the temp root through
//                                          TRAIL_PROJECT_ROOT, not through
//                                          their file location.
//   <tmp>/web/src           SYMLINK      — belt and braces for the same thing,
//                                          in case a resolver ever preserves
//                                          symlinks instead of realpath-ing.

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSnapshots, buildGenericPlan } from './fixtures/snapshots.mjs'

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url))
export const WEB_DIR = path.resolve(TESTS_DIR, '..')
export const REPO_ROOT = path.resolve(WEB_DIR, '..')
const FIXTURES = path.join(TESTS_DIR, 'fixtures')

/** The fixture race folders, and what the launcher does to each one. */
export const FIXTURE_RACES = [
  {
    // The 100-miler every race-facing flow runs against: a full aid chart, a
    // built course, night/crew/pacer features, and — see `dateOffsetDays` —
    // always dated today, so race-day mode and the countdown are meaningful
    // whenever the suite happens to run.
    slug: 'mm-like-100',
    dateOffsetDays: 0,
    startedHoursAgo: 6,
    buildCourse: true,
  },
  {
    // The archived race with a result: the switcher's "archived" group, the
    // read-only race ribbon, and the finish-time readouts.
    slug: 'rimrock-50k',
    dateOffsetDays: -154,
    buildCourse: false,
  },
  {
    // A second draft — the one the review dialog opens on. Its holes are the
    // point: `location`, `elevation.min_ft`, `elevation.avg_ft` and
    // `links.tracking` are null and listed in its `unresolved`, which is what
    // puts the fill/acknowledge rows on screen for the review spec to drive.
    slug: 'unresolved-draft-50k',
    dateOffsetDays: 61,
    buildCourse: false,
  },
  {
    // The crewless draft, carried for its own sake: a race with
    // features.crew false, no drop bags and no night, so the panels that key
    // off those stay exercised. Shared with scripts/features.test.mjs and
    // scripts/coach-prompt.test.mjs, which read it straight out of the repo —
    // so nothing here may edit the committed copy, only the temp-root copy.
    //
    // It is also the one the refresh spec re-reads: `siteFixture` points its
    // (committed-as-empty) links.site at a page this server serves, so a
    // refresh fetches 127.0.0.1 instead of the internet. Nothing else in the
    // suite asserts on this folder, which is what makes it safe for the one
    // flow that ACCEPTS a rewrite of a race.json.
    slug: 'crewless-50k',
    dateOffsetDays: 96,
    buildCourse: false,
    siteFixture: 'dry-wash-50k.html',
  },
]

/** The race the pointer is parked on for the race-facing specs. */
export const ACTIVE_SLUG = 'mm-like-100'
/** The draft the review spec opens — the one with unresolved fields. */
export const DRAFT_SLUG = 'unresolved-draft-50k'
/** The other draft: crewless, no drop bags, no night. */
export const CREWLESS_SLUG = 'crewless-50k'
/** The archived race with a result.json. */
export const ARCHIVED_SLUG = 'rimrock-50k'
/** The race the refresh spec re-reads — see FIXTURE_RACES' `siteFixture`. */
export const REFRESH_SLUG = 'crewless-50k'
/** The canned stage-1 agent reply TRAIL_FAKE_AGENT points at. */
export const FAKE_AGENT_FILE = path.join(FIXTURES, 'agent', 'refresh-stage1.json')

const p2 = (n) => String(n).padStart(2, '0')
const localDate = (offsetDays, now = new Date()) => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/**
 * `date` + `start_time` for a race that started `hoursAgo` hours ago, read on
 * the RACE's wall clock rather than the machine's.
 *
 * Race-day mode is the one view whose whole content is a function of "how far
 * into the race is it right now": before the gun it counts down, after the
 * cutoff it says the race day has passed, and only in between does it project
 * stations and accept a position hold. Pinning the fixture to six hours in
 * means the race-day spec exercises the live view whatever time of day — and
 * whatever timezone — the suite happens to run in.
 */
function startedHoursAgo(hours, timeZone, now = new Date()) {
  const at = new Date(now.getTime() - hours * 3600_000)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at)
  const get = (t) => parts.find((x) => x.type === t).value
  // en-CA renders midnight as "24" in some ICU versions; normalise it.
  const hh = get('hour') === '24' ? '00' : get('hour')
  return { date: `${get('year')}-${get('month')}-${get('day')}`, start_time: `${hh}:${get('minute')}` }
}

/** Monday of the ISO week containing `iso`, as YYYY-MM-DD. */
function mondayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7))
  return `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`
}

/**
 * Build a fresh project root under the OS temp dir and return its path.
 *
 * Every race.json's `date` is rewritten relative to the moment this runs. The
 * committed fixtures carry real calendar dates so they validate on their own
 * (and so `validateRaceJson` has something to check), but a committed date is
 * a countdown that expires: leaving them alone would mean the race-day spec
 * quietly stops testing race day the first time the fixture's year goes by.
 *
 * @param {{now?: Date}} [opts]
 * @returns {Promise<string>} the absolute temp root
 */
export async function makeProjectRoot({ now = new Date(), siteBase = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trail-train-ui-'))

  /* config/ — the pointer starts in generic mode; the switcher spec is what
     moves it. profile/goals are what generic mode's block is computed from. */
  await fs.mkdir(path.join(root, 'config'), { recursive: true })
  for (const name of ['active-race.json', 'profile.json', 'goals.json']) {
    await fs.copyFile(path.join(FIXTURES, 'config', name), path.join(root, 'config', name))
  }
  await writeJson(path.join(root, 'config', 'generic-plan.json'), buildGenericPlan(now))

  /* web/public/ — the two committed assets the page really needs (the favicon
     and the icon sprite every chip in the UI draws from), then the synthetic
     snapshots on top. vite's publicDir follows TRAIL_PROJECT_ROOT, so this is
     what /strava.json and friends resolve to. */
  const publicDir = path.join(root, 'web', 'public')
  await fs.mkdir(publicDir, { recursive: true })
  for (const name of ['favicon.svg', 'icons.svg']) {
    await fs.copyFile(path.join(WEB_DIR, 'public', name), path.join(publicDir, name))
  }
  for (const [name, body] of Object.entries(buildSnapshots(now))) {
    await writeJson(path.join(publicDir, name), body)
  }

  /* fixture-site/ — the synthetic race website the refresh flow re-reads.
     scripts/race-intake.mjs fetches links.site for real, over the network, so
     the alternative is a suite that depends on DNS and on somebody else's
     server. Serving it from this same vite means the fetch is a loopback
     request to a page committed beside the spec that asserts on it. */
  const siteDir = path.join(publicDir, 'fixture-site')
  await fs.mkdir(siteDir, { recursive: true })
  for (const name of await fs.readdir(path.join(FIXTURES, 'site'))) {
    await fs.copyFile(path.join(FIXTURES, 'site', name), path.join(siteDir, name))
  }

  /* races/ — one folder per fixture, dates re-anchored, courses built. */
  for (const fx of FIXTURE_RACES) {
    const src = path.join(REPO_ROOT, 'races', '_fixtures', fx.slug)
    const dst = path.join(root, 'races', fx.slug)
    await fs.cp(src, dst, { recursive: true })
    const racePath = path.join(dst, 'race.json')
    const race = JSON.parse(await fs.readFile(racePath, 'utf8'))
    race.date = localDate(fx.dateOffsetDays, now)
    // Only now is the base URL known (global setup picks the port before it
    // builds the root), so this is where a fixture race learns where its own
    // "official site" lives.
    if (fx.siteFixture && siteBase) {
      race.links = { ...(race.links ?? {}), site: `${siteBase}/fixture-site/${fx.siteFixture}` }
    }
    if (fx.startedHoursAgo != null) {
      Object.assign(race, startedHoursAgo(fx.startedHoursAgo, race.timezone, now))
    }
    await writeJson(racePath, race)

    // block.json's start_date is the Monday of week 1, and its last week is
    // race week — so it has to move with the date above or the countdown, the
    // weekly buckets and "block week N of M" all disagree with each other.
    const blockPath = path.join(dst, 'block.json')
    const block = await readJsonIfPresent(blockPath)
    if (block) {
      const weeksBack = (block.total_weeks ?? 1) - 1
      const raceMonday = mondayOf(race.date)
      const [y, m, d] = raceMonday.split('-').map(Number)
      const start = new Date(y, m - 1, d - weeksBack * 7)
      block.start_date = `${start.getFullYear()}-${p2(start.getMonth() + 1)}-${p2(start.getDate())}`
      await writeJson(blockPath, block)
    }
  }

  /* The checkout's own code, reachable at the paths the dev server joins onto
     the project root. Symlinks, not copies — see the header. */
  await fs.symlink(path.join(REPO_ROOT, 'scripts'), path.join(root, 'scripts'), 'dir')
  await fs.symlink(path.join(WEB_DIR, 'src'), path.join(root, 'web', 'src'), 'dir')

  /* build/course.json is generated, never committed: building it here means
     the fixture can never drift from what scripts/build-course.mjs currently
     produces, and it costs ~40 ms. Without it the race view renders its "no
     course data" fallback and /course.json answers 404. */
  const { buildCourse } = await import(path.join(REPO_ROOT, 'scripts/build-course.mjs'))
  for (const fx of FIXTURE_RACES) {
    if (!fx.buildCourse) continue
    await buildCourse(root, fx.slug, { log: () => {}, warn: () => {} })
  }

  return root
}

async function readJsonIfPresent(p) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) }
  catch (e) { if (e.code === 'ENOENT') return null; throw e }
}

async function writeJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify(data, null, 2) + '\n')
}

/** An ephemeral port the OS just told us is free. Racy in principle; in
    practice the window between close and vite's listen is microseconds, and
    vite's strictPort would fail loudly rather than silently hop. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Start `vite` on a free port against `root`, and resolve once it answers.
 *
 * Never port 38100: that is the developer's own dev server, pinned and
 * strictPort'd, and a test run must not be able to take it or be confused by
 * it. The suite's own port is picked per run.
 *
 * @param {{root: string, fakeAgentFile?: string, port?: number}} opts
 * @returns {Promise<{baseURL: string, port: number, stop: () => Promise<void>, log: () => string}>}
 */
export async function startServer({ root, fakeAgentFile, port: given }) {
  const port = given ?? (await freePort())
  const baseURL = `http://127.0.0.1:${port}`
  const proc = spawn(
    process.execPath,
    [path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--host', '127.0.0.1', '--strictPort'],
    {
      cwd: WEB_DIR,
      env: {
        ...process.env,
        TRAIL_PROJECT_ROOT: root,
        ...(fakeAgentFile ? { TRAIL_FAKE_AGENT: fakeAgentFile } : {}),
        // The dev API's own console.warn about a stale sign-in etc. is noise
        // here, and a real `claude` spawn must never happen from a test.
        TRAIL_COACH_MODEL: 'fixture-model',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  )
  let log = ''
  proc.stdout.on('data', (d) => { log += d })
  proc.stderr.on('data', (d) => { log += d })

  const exited = new Promise((_, reject) => {
    proc.on('exit', (code) => reject(new Error(`vite exited ${code} before it was ready:\n${log}`)))
  })
  await Promise.race([waitForHttp(`${baseURL}/`, 30_000), exited])

  const stop = async () => {
    proc.removeAllListeners('exit')
    try { process.kill(-proc.pid, 'SIGTERM') } catch { /* already gone */ }
    await new Promise((resolve) => {
      if (proc.exitCode != null || proc.signalCode != null) return resolve()
      proc.once('exit', resolve)
      setTimeout(() => { try { process.kill(-proc.pid, 'SIGKILL') } catch { /* gone */ } resolve() }, 3000).unref()
    })
  }
  return { baseURL, port, stop, log: () => log }
}

/** Poll until the server answers anything at all, or the deadline passes. */
async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.status < 500) return
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`${url} never became ready: ${lastErr?.message ?? 'timed out'}`)
}
