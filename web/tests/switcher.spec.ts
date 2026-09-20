import fs from 'node:fs/promises'
import path from 'node:path'
import {
  test, expect, ARCHIVED, DRAFT, MM, type Page,
  chooseRace, openDashboard, openSwitcher, setActiveRace, switcherButton, writeRawRaceFolder,
} from './basecamp'

/**
 * Flow 2 — the race switcher: generic → the MM-like 100 → back to generic.
 *
 * The switcher is the one control that changes what every other panel is
 * about, and it does it by writing config/active-race.json and re-pulsing
 * every fetch. Round 1 and round 2 both found bugs here (a row that was not
 * disabled at click time, a stale error left on screen after a later switch),
 * so this walks the full there-and-back rather than just asserting the menu
 * opens.
 */

test.beforeEach(async ({ request }) => {
  await setActiveRace(request, null)
})

const archiveRow = /Archive with result…/

test('the switcher lists every fixture race under its own group', async ({ page }) => {
  await openDashboard(page)
  const menu = await openSwitcher(page)

  await expect(menu.getByRole('menuitemradio', { name: /No race \(generic\)/ })).toBeVisible()
  await expect(menu.getByRole('menuitemradio', { name: new RegExp(MM.name) })).toBeVisible()
  await expect(menu.getByRole('menuitemradio', { name: new RegExp(DRAFT.name) })).toBeVisible()
  await expect(menu.getByRole('menuitemradio', { name: new RegExp(ARCHIVED.name) })).toBeVisible()

  // The groups themselves — an archived race showing up under "drafts" would
  // mean listRaces and the UI disagree about status.
  await expect(menu.getByText(/^active$/i)).toBeVisible()
  await expect(menu.getByText(/^drafts$/i)).toBeVisible()
  await expect(menu.getByText(/^archived$/i)).toBeVisible()

  // Generic is the one currently checked, since beforeEach parked it there.
  await expect(menu.getByRole('menuitemradio', { name: /No race \(generic\)/ })).toBeChecked()
})

test('picking the 100-miler switches the whole dashboard to it, and generic takes it back', async ({ page, request, trouble }) => {
  await openDashboard(page)

  await openSwitcher(page)
  await chooseRace(page, new RegExp(MM.name))

  // The chip is the app's own statement of what it is showing.
  await expect(switcherButton(page)).toContainText(new RegExp(MM.short, 'i'))

  // The race is on screen, by name — the one <h1> in the app is this hero.
  await expect(page.getByRole('heading', { name: MM.name })).toBeVisible()

  // …and the RACE tab has the built course behind it: the climb comparison is
  // drawn from races/<slug>/build/course.json's race_climbs, and the aid chart
  // only totals an elapsed time once the projection has real segments. Both
  // are empty-state text if /course.json 404s.
  await page.getByRole('tab', { name: /^race$/i }).click()
  await expect(page.getByText(/climb readiness — you vs/i)).toBeVisible()
  await expect(page.getByText(/total elapsed at finish/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /runner card/i })).toBeVisible()

  // …and the server agrees: the pointer really moved.
  const active = await (await request.get('/api/race/active?t=1')).json()
  expect(active.active).toBe(MM.slug)

  // Back to generic.
  await openSwitcher(page)
  await chooseRace(page, /No race \(generic\)/)
  await expect(switcherButton(page)).toContainText(/no race/i)
  await expect(page.getByText(/vitals — load × recovery/i)).toBeVisible()
  expect((await (await request.get('/api/race/active?t=2')).json()).active).toBeNull()

  expect(trouble.pageErrors).toEqual([])
})

/**
 * Round 3 resilience NEW-1 / round 4 confirm — a tune-up whose parent_slug
 * names ANOTHER tune-up (never an A race, and possibly gone entirely) used
 * to render twice: once as its own top-level orphan row, and again nested
 * under the other orphan's row with no "parent not found" warning at all
 * (groupRaces let an orphan's own entry double as a nesting target). Worse,
 * `rowsFor` always counts an orphan as exactly one row, so once a second
 * row rendered for it uncounted, every race below it in menu order got a
 * roving-focus cursor one off from where it actually rendered — the
 * switcher opened with focus on the WRONG race.
 *
 * scripts/race-config.mjs's groupRaces now only ever nests a tune-up onto a
 * genuine A race (never onto another tune-up's entry), so this reproduces
 * the exact two-folder shape confirm-ui3 used and checks both halves: no
 * duplicate row, and the cursor lands on the race actually being browsed.
 *
 * The two folders are written directly to races/ (writeRawRaceFolder) —
 * quickCreateRace refuses a tune-up whose parent is itself a tune-up, so
 * this shape can only exist via a hand-edited (or pre-v2) folder, never
 * through the app's own create path.
 */
test('a tune-up chained onto another tune-up renders once, orphaned, and does not shift the cursor', async ({ page, request, trouble }) => {
  await writeRawRaceFolder('shell2-chain-orphan-parent', {
    schema_version: 1, kind: 'b', parent_slug: 'shell2-no-such-race',
    status: 'draft', name: 'Shell2 Orphan Parent', short: 'S2OP', date: '2027-04-10',
    distance_mi: 10, gain_ft: 500,
  })
  await writeRawRaceFolder('shell2-chain-orphan-child', {
    schema_version: 1, kind: 'b', parent_slug: 'shell2-chain-orphan-parent',
    status: 'draft', name: 'Shell2 Chain Orphan Child', short: 'S2OC', date: '2027-04-20',
    distance_mi: 12, gain_ft: 600,
  })

  // Browsing a real, unrelated draft — its own row, alphabetically, sorts
  // after both shell2- folders above (drafts group, slug order) — is what
  // exposes the off-by-one: the bug shifted every row below the duplicate.
  await setActiveRace(request, DRAFT.slug, 'view')
  await openDashboard(page)
  const menu = await openSwitcher(page)

  // No duplicate: exactly one row for the chained orphan, not one at the
  // top level and one nested under the other orphan.
  await expect(menu.getByRole('menuitemradio', { name: /Shell2 Chain Orphan Child/ })).toHaveCount(1)
  await expect(menu.getByRole('menuitemradio', { name: /Shell2 Orphan Parent/ })).toHaveCount(1)

  // Both are their own top-level orphan rows with a reason, never silently
  // nested — the child's parent IS a real row, just not an A race.
  await expect(menu.getByRole('menuitemradio', { name: /Shell2 Chain Orphan Child/ }))
    .toContainText(/parent "shell2-chain-orphan-parent" is itself a tune-up/)
  await expect(menu.getByRole('menuitemradio', { name: /Shell2 Orphan Parent/ }))
    .toContainText(/parent "shell2-no-such-race" not found/)

  // The cursor: DRAFT is the race actually being browsed (currentSlug), so
  // focus must land on ITS row, not on whatever rendered one slot earlier
  // because an orphan's row count was miscounted.
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? null)
  expect(focused).toContain(DRAFT.name)
  expect(focused).not.toContain('Shell2')

  // Round 3 finding 4: every other test in this file checks the page never
  // threw — this one wrote two hand-rolled folders shaped to trip exactly
  // the double-render/off-by-one bug the header comment describes, which is
  // precisely the kind of edit most likely to surface a render exception.
  expect(trouble.pageErrors).toEqual([])
})

test('an archived race opens read-only, without moving the training pointer', async ({ page, request, trouble }) => {
  await openDashboard(page)
  await openSwitcher(page)
  await chooseRace(page, new RegExp(ARCHIVED.name))

  await expect(switcherButton(page)).toContainText(new RegExp(ARCHIVED.short, 'i'))
  await expect(switcherButton(page)).toContainText(/archived/i)

  // "view", not "train": looking at a finished race must not re-point the
  // block at it (PRD §7 — the app shows the race, it does not train for it).
  const active = await (await request.get('/api/race/active?t=1')).json()
  expect(active.mode).toBe('view')
  expect(active.active).toBeNull()
  expect(active.viewing).toBe(ARCHIVED.slug)

  expect(trouble.pageErrors).toEqual([])
})

/* ------------------------------------------------------------------ */
/*  Round 3 finding 1 — "Run course again…"'s false tick               */
/* ------------------------------------------------------------------ */

/**
 * Write races/r3rd-clean-archived-50k/ straight onto the shared temp root —
 * a real course.gpx and a race.json whose declared distance_mi/gain_ft are
 * the same pairing scripts/race-build.test.mjs's own "a GPX within normal
 * drift of race.json's distance_mi (and gain) raises nothing" test uses
 * against the identical synthetic track, so this build is known to come back
 * `ok: true` with a real course AND zero warnings — the clean half of
 * finding 1, as distinct from ARCHIVED (rimrock-50k)'s no-gpx half.
 *
 * Single "Finish" aid station on purpose: race-build.mjs's matcher only ever
 * special-cases the LAST station as the finish line (no waypoint needed,
 * never unresolved) — with just one station it is both first and last, so
 * the build cannot also raise an aid-station-matching warning and muddy the
 * "clean build" signal this test wants.
 */
const CLEAN_ARCHIVED = { slug: 'r3rd-clean-archived-50k', name: 'R3RD Clean Archived 50K' }

function syntheticCourseGpx(): string {
  const LAT0 = 34.0
  const LON0 = -111.0
  const DEG_PER_TENTH_MI = 0.1 / 69.09
  const TRACK_PTS = 300
  const trk = Array.from({ length: TRACK_PTS }, (_, i) => {
    const lat = LAT0 + i * DEG_PER_TENTH_MI
    const ele = 2000 + i * 0.4 + Math.sin(i / 20) * 3
    return `<trkpt lat="${lat}" lon="${LON0}"><ele>${ele.toFixed(1)}</ele></trkpt>`
  }).join('\n')
  return `<?xml version="1.0"?>\n<gpx version="1.1">\n<trk><name>t</name><trkseg>\n${trk}\n</trkseg></trk>\n</gpx>`
}

async function writeCleanArchivedFixture(): Promise<void> {
  const root = process.env.TRAIL_TEST_PROJECT_ROOT
  if (!root) throw new Error('writeCleanArchivedFixture: TRAIL_TEST_PROJECT_ROOT is unset — global setup did not run')
  const dir = path.join(root, 'races', CLEAN_ARCHIVED.slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'course.gpx'), syntheticCourseGpx())
  await fs.writeFile(path.join(dir, 'race.json'), JSON.stringify({
    schema_version: 1,
    slug: CLEAN_ARCHIVED.slug,
    status: 'archived',
    name: CLEAN_ARCHIVED.name,
    short: 'R3RDCA',
    edition_year: 2027,
    date: '2027-06-12',
    start_time: '06:00',
    timezone: 'America/Denver',
    distance_mi: 30,
    gain_ft: 399,
    cutoff_h: null,
    aid_stations: [
      { name: 'Finish', total_mi: 30, cutoff_h: null, crew: false, drop_bag: false },
    ],
    race_climbs: [],
    links: {},
  }, null, 2))
}

/**
 * Same shared temp root, same synthetic ~29.9 mi track as CLEAN_ARCHIVED
 * above, but declared at 100 mi — comfortably past build-course.mjs's 15%
 * MISMATCH_THRESHOLD, with no `format` set so isLegOrLapDistance's
 * out_and_back/loop excuse never applies regardless of the resulting ratio.
 * The build still answers `ok: true` (a real course, gain_ft pinned to the
 * ~399 ft the track actually measures so ONLY the distance mismatches) —
 * the second half of finding 1's fix (round 3 sweep extension): a built
 * course with `warnings` must show a ⚠ hint, never the plain tick.
 */
const MISMATCH_ARCHIVED = { slug: 'r3rd-mismatch-archived-50k', name: 'R3RD Mismatch Archived 50K' }

async function writeMismatchArchivedFixture(): Promise<void> {
  const root = process.env.TRAIL_TEST_PROJECT_ROOT
  if (!root) throw new Error('writeMismatchArchivedFixture: TRAIL_TEST_PROJECT_ROOT is unset — global setup did not run')
  const dir = path.join(root, 'races', MISMATCH_ARCHIVED.slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'course.gpx'), syntheticCourseGpx())
  await fs.writeFile(path.join(dir, 'race.json'), JSON.stringify({
    schema_version: 1,
    slug: MISMATCH_ARCHIVED.slug,
    status: 'archived',
    name: MISMATCH_ARCHIVED.name,
    short: 'R3RDMA',
    edition_year: 2027,
    date: '2027-06-12',
    start_time: '06:00',
    timezone: 'America/Denver',
    distance_mi: 100,
    gain_ft: 399,
    cutoff_h: null,
    aid_stations: [
      { name: 'Finish', total_mi: 100, cutoff_h: null, crew: false, drop_bag: false },
    ],
    race_climbs: [],
    links: {},
  }, null, 2))
}

/**
 * Find the "↳ Run course again…" row that belongs to one race, the same way
 * basecamp.ts's own (unexported) clickSubRowFor locates a Review/Refresh row
 * — by finding the race's own row first and taking the next matching sub-row
 * before the next top-level race row. Returns the locator (not a click), so
 * a test can read the row's hint text both before and after acting on it.
 */
async function runCourseAgainRowFor(page: Page, raceName: string) {
  const rows = page.getByRole('menu', { name: 'race' }).locator('button')
  const labels = await rows.allInnerTexts()
  const raceIdx = labels.findIndex((t) => t.startsWith(raceName))
  if (raceIdx < 0) throw new Error(`no switcher row for "${raceName}" in: ${JSON.stringify(labels)}`)
  const endIdx = labels.findIndex((t, i) => i > raceIdx && !t.startsWith('↳'))
  const limit = endIdx < 0 ? labels.length : endIdx
  const hitIdx = labels.findIndex((t, i) => i > raceIdx && i < limit && t.startsWith('↳ Run course again'))
  if (hitIdx < 0) throw new Error(`"${raceName}" has no "Run course again…" row in: ${JSON.stringify(labels.slice(raceIdx, limit))}`)
  return rows.nth(hitIdx)
}

/**
 * Round 3 finding 1 — the switcher's own "Run course again…" row was a
 * hand-rolled call to the build SSE endpoint that passed `() => {}` as
 * onEvent and never looked at the `done` payload, so `ok: true, course:
 * null` (no course.gpx, no reachable links.gpx to fetch one from —
 * scripts/race-build.mjs's own "stop" path) still closed out with "course
 * rebuilt ✓". ARCHIVED (rimrock-50k) is exactly that shape already — no
 * course.gpx file, and `links` carries only `site`, never `gpx` — and is
 * safe to build against here: race-build.mjs's own test ("no course.gpx and
 * no links.gpx: unresolved, not a failure") confirms this path writes
 * NOTHING to the folder, so it cannot corrupt the shared fixture for any
 * other spec.
 */
test('Run course again on a race with no course.gpx shows the reason, not a false tick', async ({ page, trouble }) => {
  await openDashboard(page)
  await openSwitcher(page)
  const row = await runCourseAgainRowFor(page, ARCHIVED.name)
  await expect(row).toContainText(/rebuild course\.json from the stored gpx/i)

  await row.click()
  // No course.gpx and no links.gpx to fetch: the build answers ok: true with
  // course: null and this exact reason (scripts/race-build.mjs's `stop`).
  await expect(page.getByText(/no course\.gpx in the folder and no http\(s\) links\.gpx/i)).toBeVisible()
  await expect(row).not.toContainText(/rebuilt ✓/i)

  expect(trouble.pageErrors).toEqual([])
})

/**
 * The other half of finding 1 — a clean build (a real course.gpx, no
 * distance/gain mismatch) must still show the tick, so the fix above cannot
 * have been "never show success."
 */
test('Run course again on a clean build still shows the tick', async ({ page, trouble }) => {
  await writeCleanArchivedFixture()
  await openDashboard(page)
  await openSwitcher(page)
  const row = await runCourseAgainRowFor(page, CLEAN_ARCHIVED.name)

  await row.click()
  await expect(row).toContainText(/course rebuilt ✓/i)

  expect(trouble.pageErrors).toEqual([])
})

/**
 * Round 5 confirm, finding 5 — `archiveTarget`'s first branch
 * (`list.find((r) => r.status === "active")`) used to have no `kind !== "b"`
 * guard, unlike `canAddTuneUp`'s identical check just above it in App.tsx —
 * even though a hand-edited or pre-migration folder can carry `kind: "b"`
 * and `status: "active"` at once (ui3-resilience.md BUG 1's repro; the
 * normal activate path now refuses to ever WRITE that state, but does not
 * repair a folder that already has it).
 *
 * Every real fixture race sorts alphabetically after "mm-like-100" (the only
 * one GET /api/races ever reports with `status: "active"`), so a
 * `writeRawRaceFolder` decoy can never actually reach `list.find` before it —
 * this would make a real end-to-end repro depend on fixture slug luck rather
 * than on the guard itself. Intercepting the SAME `/api/races` response the
 * switcher already reads and splicing a corrupted tune-up in FRONT of the
 * real list exercises the exact array `archiveTarget` iterates, without
 * touching any fixture or the shared `writeRawRaceFolder` helper.
 */
test('a corrupted tune-up wrongly marked active is skipped in favor of the real active race', async ({ page, request, trouble }) => {
  await setActiveRace(request, MM.slug, 'train')

  await page.route('**/api/races*', async (route) => {
    const response = await route.fetch()
    const data = await response.json() as { races: Array<Record<string, unknown>>; groups?: unknown }
    // A tune-up (kind "b") wrongly carrying status "active" — the exact
    // corrupted shape `validateActivation` now refuses to create, spliced in
    // BEFORE the real active race so an unguarded `list.find` would hit it
    // first. `groups` is dropped so the client derives it via `flatGroups`
    // (App.tsx) instead of this test having to hand-build the nested shape.
    const decoy = {
      slug: 'r3sh-corrupt-active-b', name: 'R3SH Corrupt Active B', short: 'R3SHB',
      status: 'active', date: '2027-05-01', visual: null, kind: 'b',
      parent_slug: MM.slug, error: null,
    }
    await route.fulfill({ response, json: { races: [decoy, ...data.races] } })
  })

  await openDashboard(page)
  const menu = await openSwitcher(page)

  // The row exists — for the real active race, not the decoy: its hint names
  // MM's own short code, never the corrupted tune-up's.
  const row = menu.getByRole('menuitem', { name: archiveRow })
  await expect(row).toBeVisible()
  await expect(row).toContainText(MM.short)
  await expect(row).not.toContainText('R3SHB')

  expect(trouble.pageErrors).toEqual([])
})

/**
 * Round 3 sweep extension (r3-sweep.md, first HIGH) — the switcher row's
 * SECOND check: `ok: true` with a real course but non-empty `warnings` (a
 * course.gpx measuring far off the declared distance) must show a ⚠ hint,
 * not the plain success tick.
 */
test('Run course again on a mismatched build shows a warning, not the tick', async ({ page, trouble }) => {
  await writeMismatchArchivedFixture()
  await openDashboard(page)
  await openSwitcher(page)
  const row = await runCourseAgainRowFor(page, MISMATCH_ARCHIVED.name)

  await row.click()
  await expect(row).toContainText(/⚠.*course\.gpx measures 29\.9 mi vs race\.json's 100 mi/i)
  await expect(row).not.toContainText(/rebuilt ✓/i)

  expect(trouble.pageErrors).toEqual([])
})

/* ------------------------------------------------------------------ */
/*  Round 3 sweep extension — the shared useRunCourseAgain hook         */
/*  (runCourseAgain.ts) dropped `warnings` too, on all three of its own */
/*  real call sites (RaceDay.tsx, RacePlanner.tsx, NutritionPlan.tsx).  */
/*  Covered here (rather than a hook unit test — the project has no     */
/*  jsdom/testing-library, so a React hook isn't node-testable) via the */
/*  RACE tab, whose planner (RacePlanner.tsx) is the same "no course    */
/*  data yet" empty state, button and all, as the other two.            */
/*                                                                       */
/*  NOTE on what this test does NOT assert, and why: App.tsx wraps the   */
/*  whole "race" tabpanel in `<div key={`race-${key}`}>` (`key` is the   */
/*  SAME refresh pulse `reload()` bumps), specifically so every reload   */
/*  starts each view's subtree clean (App.tsx's own comment: "each view  */
/*  already unmounts/remounts its own subtree via `key`"). courseBuild's */
/*  onDone() IS that same `reload()`, so the instant a build with        */
/*  warnings succeeds, the very state carrying `courseBuild.warnings`    */
/*  is unmounted — in the same render pass it was just set in, well      */
/*  before any network delay a test could hook even matters (confirmed   */
/*  by instrumenting both the hook and RacePlanner's render directly:    */
/*  the note's render and its own subtree's remount are back-to-back,    */
/*  synchronous, and unrelated to how long the resulting /course.json    */
/*  re-fetch takes). So the note this round's fix adds to RacePlanner/   */
/*  NutritionPlan/RaceDay is real and correctly wired, but — on these    */
/*  three call sites specifically, unlike the switcher's own separate    */
/*  implementation in App.tsx, which is NOT wrapped in this key — it is  */
/*  not something a human or this suite can ever actually observe on    */
/*  screen. Fixing THAT is App.tsx's tab-remount design, out of this     */
/*  lane; flagged in the round's report instead of routed around here    */
/*  with new cross-remount persistence nobody asked for. What IS true    */
/*  and testable: the athlete is not left in the dark about the mismatch */
/*  — RacePlanner's own persisted banner (raceConfig.unresolved, read    */
/*  fresh off the RELOADED race.json) says the same thing the instant    */
/*  the reload lands.                                                    */
/* ------------------------------------------------------------------ */

/**
 * A race with a mismatched course.gpx that has NEVER been built — no
 * build/course.json at all, so useCourse() 404s and the empty state ("no
 * course data yet" / "run course build") is what's on screen, the same as
 * any of the three courseBuild.run() call sites. Status draft (never
 * active — MM already holds that), kind "a": a top-level race like the
 * mismatch test above, not a tune-up, since nothing about this scenario is
 * tune-up-specific.
 *
 * Takes its own slug/name (rather than one shared constant): the RACE-tab
 * test below and the RaceDay test after it each BUILD their own copy, and a
 * shared slug would mean the second test's "never been built" premise is
 * already false by the time it runs — the first test's own build having
 * left a real build/course.json behind for the SAME folder.
 */
function writeMismatchUnbuiltFixture(slug: string, name: string): Promise<void> {
  const root = process.env.TRAIL_TEST_PROJECT_ROOT
  if (!root) throw new Error('writeMismatchUnbuiltFixture: TRAIL_TEST_PROJECT_ROOT is unset — global setup did not run')
  const dir = path.join(root, 'races', slug)
  return fs.mkdir(dir, { recursive: true }).then(async () => {
    await fs.writeFile(path.join(dir, 'course.gpx'), syntheticCourseGpx())
    await fs.writeFile(path.join(dir, 'race.json'), JSON.stringify({
      schema_version: 1,
      slug,
      status: 'draft',
      name,
      short: 'R3RDMU',
      edition_year: 2027,
      date: '2027-06-12',
      start_time: '06:00',
      timezone: 'America/Denver',
      distance_mi: 100,
      gain_ft: 399,
      cutoff_h: null,
      aid_stations: [
        { name: 'Finish', total_mi: 100, cutoff_h: null, crew: false, drop_bag: false },
      ],
      race_climbs: [],
      links: {},
    }, null, 2))
  })
}

const MISMATCH_UNBUILT_RACETAB = { slug: 'r3rd-mismatch-unbuilt-racetab-100', name: 'R3RD Mismatch Unbuilt RaceTab 100' }

test('the RACE tab\'s "run course build" on a mismatched, unbuilt race ends up showing the mismatch', async ({ page, request, trouble }) => {
  await writeMismatchUnbuiltFixture(MISMATCH_UNBUILT_RACETAB.slug, MISMATCH_UNBUILT_RACETAB.name)
  await setActiveRace(request, MISMATCH_UNBUILT_RACETAB.slug, 'view')

  await openDashboard(page)
  await page.getByRole('tab', { name: /^race$/i }).click()
  await expect(page.getByText(/no course data yet/i)).toBeVisible()

  await page.getByRole('button', { name: /run course build/i }).click()

  // See the file-header note above this block for why this checks the
  // PERSISTED mismatch banner (survives the reload) rather than
  // courseBuild.warnings' own transient note (does not).
  await expect(page.getByText(/course\.gpx measures/i)).toBeVisible()

  expect(trouble.pageErrors).toEqual([])
})

/**
 * RaceDay.tsx's OWN copy of the same empty state/button (#/race-day, PLAIN
 * URL route — not App.tsx's tabbed shell) is NOT wrapped in a `key={pulse}`
 * remount the way the RACE/FUEL tabpanels above are (RaceDayRoute mounts
 * RacePlanProvider directly, with no such key anywhere above it) — so this
 * is the one of the three real call sites where courseBuild.warnings' own
 * note has an actual chance to reach the screen, and does, once the
 * /course.json re-fetch its onDone()/reload() triggers is slowed down
 * enough to observe the render that has it.
 */
const MISMATCH_UNBUILT_RACEDAY = { slug: 'r3rd-mismatch-unbuilt-raceday-100', name: 'R3RD Mismatch Unbuilt RaceDay 100' }

test('RaceDay\'s "run course build" shows the hook\'s own warning note (this call site does not get remounted by reload)', async ({ page, request, trouble }) => {
  await writeMismatchUnbuiltFixture(MISMATCH_UNBUILT_RACEDAY.slug, MISMATCH_UNBUILT_RACEDAY.name)
  await setActiveRace(request, MISMATCH_UNBUILT_RACEDAY.slug, 'view')

  await page.goto('/#/race-day')
  await expect(page.getByText(/no course\.json for this race yet/i)).toBeVisible()

  await page.route('**/course.json*', async (route) => {
    await new Promise((r) => setTimeout(r, 800))
    await route.fallback()
  })

  await page.getByRole('button', { name: /run course build/i }).click()
  await expect(page.getByText(/⚠.*course\.gpx measures 29\.9 mi vs race\.json's 100 mi/i)).toBeVisible()

  expect(trouble.pageErrors).toEqual([])
})
