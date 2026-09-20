import {
  test, expect, ARCHIVED, DRAFT, MM,
  chooseRace, openDashboard, openSwitcher, raceAction, raceActionLabels, raceActionNote, raceActions,
  setActiveRace, switcherButton, writeRawRaceFolder,
} from './basecamp'

/**
 * Flow 13 — the topline action strip.
 *
 * The owner's call: "i don't like the submenus in the race selection for
 * review rerun etc… keep that menu compact. instead make these a topline
 * option once the race profile is loaded." So every per-race action left the
 * switcher menu for the status strip under the command bar (App.tsx's
 * RaceTopline), about the ONE race that is loaded.
 *
 * What is worth pinning is not that the buttons exist — the flows that use
 * them (review.spec, refresh.spec, archive.spec, b-race.spec) already do
 * that — but that each race STATE offers exactly the set it should. Those
 * rules are the menu rows' own predicates, unchanged (isReviewable,
 * isRefreshable, isRerunnable, canAddTuneUp, archiveTarget); this is the
 * table that says what they add up to, state by state, so a later change to
 * any one of them cannot quietly widen or narrow what a folder can be made
 * to do.
 *
 * `archiveTarget` is the one rule the move CHANGED (owner's call, 2026-09-20):
 * as a menu footer row it was a question about the whole race list — "the race
 * being trained for, or the archived race on screen with no activity linked" —
 * which on a strip about the loaded race reads as an action belonging to a
 * folder that is not on screen. It is now the loaded race or nothing: the
 * active race (ending it), or an archived one that never got its activity
 * linked. Its two guards are unchanged: the folder's own `status` rather than
 * the view-mode-null `trainingSlug`, and `kind !== "b"`.
 */

/* The labels as the page renders them — `.chip` is text-transform:
   uppercase, so this is what the athlete actually reads. */
const REVIEW = 'REVIEW…'
const ACTIVATE = 'ACTIVATE'
const REFRESH = 'REFRESH FROM SOURCES… · PAID'
const RERUN = 'RUN COURSE AGAIN…'
const ADD_TUNE_UP = 'ADD TUNE-UP…'
const ARCHIVE = 'ARCHIVE WITH RESULT…'
const LINK_RESULT = 'LINK RESULT…'

test('a draft offers review, activate and a paid refresh — and nothing that needs a course or a block', async ({ page, request, trouble }) => {
  await setActiveRace(request, DRAFT.slug, 'view')
  await openDashboard(page)

  expect(await raceActionLabels(page)).toEqual([REVIEW, ACTIVATE, REFRESH])
  // The strip says what the race IS, in the same words the old viewing
  // banner used.
  await expect(page.getByText(/draft · not activated/i)).toBeVisible()
  // Nothing archive-shaped: a draft has never been run, and the active race
  // is not what is on screen.
  await expect(raceAction(page, /Archive with result…|Link result…/)).toHaveCount(0)

  expect(trouble.pageErrors).toEqual([])
})

test('the active race in train mode offers review, refresh, a tune-up and its own archive', async ({ page, request, trouble }) => {
  await setActiveRace(request, MM.slug, 'train')
  await openDashboard(page)

  expect(await raceActionLabels(page)).toEqual([REVIEW, REFRESH, ADD_TUNE_UP, ARCHIVE])
  // Train mode had no strip at all before the actions needed one — this line
  // is new, and it is what tells the athlete the strip is not a warning.
  await expect(page.getByText(/active · training target/i)).toBeVisible()
  // No "Activate" on a race that already is one, and no course rebuild:
  // that one is archived-only (isRerunnable).
  await expect(raceAction(page, /^Activate$/)).toHaveCount(0)
  await expect(raceAction(page, /Run course again/)).toHaveCount(0)

  expect(trouble.pageErrors).toEqual([])
})

/**
 * The active race opened READ-ONLY — reachable by pointing the pointer at it
 * in view mode, which validateActivation permits (only `mode: "train"` is
 * gated). It is the state that used to break `canAddTuneUp` and
 * `archiveTarget` alike: both asked about `useActiveRace().slug`, which is
 * null here even though the training target has not changed (round 4
 * finding 5). The offered set must be identical to train mode's.
 */
test('the active race viewed read-only offers the same actions as train mode', async ({ page, request, trouble }) => {
  await setActiveRace(request, MM.slug, 'view')
  await openDashboard(page)

  expect(await raceActionLabels(page)).toEqual([REVIEW, REFRESH, ADD_TUNE_UP, ARCHIVE])
  await expect(page.getByText(/active · viewing read-only/i)).toBeVisible()

  expect(trouble.pageErrors).toEqual([])
})

/**
 * An archived race gets a refresh and a course rebuild, never a review or a
 * tune-up — and the archive half of the strip turns into "Link result…",
 * because the archiving already happened and what is missing is the Strava
 * run behind it. rimrock-50k is exactly that shape: its committed
 * result.json carries a finish time and `strava_activity_id: null` (the same
 * state mm-like-100 was left in by the v2 migration, archived long before
 * its run was linked).
 */
test('an archived race with no activity linked offers a refresh, a rebuild and "Link result…"', async ({ page, request, trouble }) => {
  const result = await (await request.get(`/api/races/${ARCHIVED.slug}/result?t=1`)).json()
  expect(result.result?.strava_activity_id, 'the archived fixture should have no activity linked').toBeNull()

  await setActiveRace(request, ARCHIVED.slug, 'view')
  await openDashboard(page)

  expect(await raceActionLabels(page)).toEqual([REFRESH, RERUN, LINK_RESULT])
  // Its aid chart and tracker are done being edited (isReviewable is drafts
  // and the active race only), and an archived folder has no live block for
  // a tune-up to sit inside. It is also not the race that ends a block, so
  // never "Archive with result…".
  await expect(raceAction(page, /Review…/)).toHaveCount(0)
  await expect(raceAction(page, /Add tune-up…/)).toHaveCount(0)
  await expect(raceAction(page, /Archive with result…/)).toHaveCount(0)
  await expect(page.getByText(/archived · .* · read-only/i)).toBeVisible()

  expect(trouble.pageErrors).toEqual([])
})

/**
 * …and once the run IS linked there is nothing left to do to the folder at
 * all. The activity id is injected into the same `/result` response the strip
 * reads rather than written to races/_fixtures/rimrock-50k/result.json —
 * that file is committed, and other specs assert on it.
 *
 * This is also the assertion that `useRaceResult`'s `resolved` flag exists
 * for: a null result means "still asking" as much as "none linked", and
 * offering the button before the answer lands flashes it on every load.
 */
test('an archived race whose run is already linked offers no archive action at all', async ({ page, request, trouble }) => {
  await page.route(`**/api/races/${ARCHIVED.slug}/result*`, async (route) => {
    const response = await route.fetch()
    const data = await response.json() as { result: Record<string, unknown> | null }
    await route.fulfill({ response, json: { result: { ...(data.result ?? {}), strava_activity_id: 987654321 } } })
  })

  await setActiveRace(request, ARCHIVED.slug, 'view')
  await openDashboard(page)

  expect(await raceActionLabels(page)).toEqual([REFRESH, RERUN])

  expect(trouble.pageErrors).toEqual([])
})

/**
 * A tune-up nested inside its A race's block had no action rows in the menu
 * either — the render emitted its row bare, since every one of those rules
 * is about the A race. Browsing one gets the same answer on the strip: the
 * only button is the A race's own archive action, which is not about the
 * folder on screen at all.
 */
test('a tune-up offers no actions, no empty group, and copy that fits what it is', async ({ page, request, trouble }) => {
  const created = await request.post('/api/races', {
    data: {
      name: 'Topline Tune-Up 25K',
      date: (() => {
        const d = new Date()
        d.setDate(d.getDate() - 35)
        const p2 = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
      })(),
      distance_mi: 15.5, gain_ft: 1200, parent_slug: MM.slug,
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const { slug } = await created.json() as { slug: string }

  await setActiveRace(request, slug, 'view')
  await openDashboard(page)

  // Browser check BUG 3. A tune-up is never activated — `kind: "b"` is
  // refused the status by the schema and by validateActivation both — so
  // "draft · not activated" announced an activation being withheld that was
  // never on offer. And a labelled group with nothing in it is announced by
  // a screen reader as exactly that.
  await expect(page.getByText(/tune-up · viewing read-only/i)).toBeVisible()
  await expect(page.getByText(new RegExp(`is a tune-up inside ${MM.name}`, 'i'))).toBeVisible()
  await expect(page.getByText(/draft · not activated/i)).toHaveCount(0)
  await expect(raceActions(page)).toHaveCount(0)

  expect(trouble.pageErrors).toEqual([])
})

/**
 * An orphaned tune-up — its `parent_slug` names a folder that is not on disk
 * — IS a top-level row in the menu (it is not hidden), and had none of an A
 * race's action rows: no Review (nothing to activate it into), no Refresh (a
 * quick-form tune-up has no sources to re-read), no course rebuild, no
 * tune-up of its own. The strip's `actionable` guard is the same rule.
 */
test('an orphaned tune-up offers no actions either', async ({ page, request, trouble }) => {
  await writeRawRaceFolder('shell2-topline-orphan', {
    schema_version: 1, kind: 'b', parent_slug: 'shell2-topline-no-such-parent',
    status: 'draft', name: 'Shell2 Topline Orphan', short: 'S2TO', date: '2027-08-14',
    distance_mi: 13, gain_ft: 700,
  })
  await setActiveRace(request, 'shell2-topline-orphan', 'view')
  await openDashboard(page)

  // Its parent is not on disk, so there is no block to name — but it is
  // still a tune-up, and still gets no group rather than an empty one.
  await expect(page.getByText(/tune-up · viewing read-only/i)).toBeVisible()
  await expect(raceActions(page)).toHaveCount(0)

  expect(trouble.pageErrors).toEqual([])
})

/**
 * Round 5 confirm, finding 5 — `canAddTuneUp` and `archiveTarget` both guard
 * on `kind !== "b"` as well as on status, because a hand-edited or
 * pre-migration folder can carry `kind: "b"` and `status: "active"` at once
 * (ui3-resilience.md BUG 1's repro). `validateActivation` now refuses to ever
 * WRITE that state, but it does not repair a folder that already has it, and
 * GET /api/races reports the status verbatim with no read-time check.
 *
 * Intercepting `/api/races` and flipping the REAL active race's own `kind` is
 * what puts the corrupted shape in front of the strip: since the actions
 * became questions about the folder LOADED, the guards are only reachable
 * through the loaded folder's own row. (`groups` is dropped so the client
 * derives it via `flatGroups`, rather than this test hand-building the nested
 * shape.) Review and Refresh are unaffected — neither rule mentions `kind`.
 */
test('a corrupted tune-up wrongly marked active is offered no archive and no tune-up', async ({ page, request, trouble }) => {
  await setActiveRace(request, MM.slug, 'train')

  await page.route('**/api/races*', async (route) => {
    const response = await route.fetch()
    const data = await response.json() as { races: Array<Record<string, unknown>> }
    const races = data.races.map((r) => (r.slug === MM.slug ? { ...r, kind: 'b' } : r))
    await route.fulfill({ response, json: { races } })
  })

  await openDashboard(page)

  expect(await raceActionLabels(page)).toEqual([REVIEW, REFRESH])

  expect(trouble.pageErrors).toEqual([])
})

/**
 * Generic mode has no race profile loaded, so there is nothing for the strip
 * to be about — the owner's "once the course is selected".
 */
test('generic mode shows no strip at all', async ({ page, request, trouble }) => {
  await setActiveRace(request, null)
  await openDashboard(page)

  await expect(page.getByRole('group', { name: 'race actions' })).toHaveCount(0)
  // …and the menu is still the way back to a race.
  const menu = await openSwitcher(page)
  await expect(menu.getByRole('menuitemradio', { name: new RegExp(MM.name) })).toBeVisible()

  expect(trouble.pageErrors).toEqual([])
})

/**
 * "Activate" is the review screen's own activation path with no edits in
 * front of it: POST the status flip, then move the pointer. Its refusals are
 * `validateStatusTransition`'s own strings (scripts/race-edit.mjs), and the
 * strip has to SAY them — a button that silently does nothing is the bug
 * this covers.
 *
 * mm-like-100 holds `status: "active"` for the whole suite and nothing here
 * archives it, so the single-active invariant refuses this every time (and
 * the unresolved-fields gate refuses it first, until review.spec has
 * acknowledged that fixture's holes). Either way the draft stays a draft —
 * asserted against the server, not just the screen.
 */
test('Activate on a draft surfaces the server\'s refusal inline, and changes nothing', async ({ page, request, trouble }) => {
  await setActiveRace(request, DRAFT.slug, 'view')
  await openDashboard(page)

  await raceAction(page, /^Activate$/).click()
  const note = raceActionNote(page)
  await expect(note).toContainText(/already active|unresolved field/i)
  // Browser check BUG 4: the server's array is [sentence, ...field paths], and
  // joining the whole thing with " · " put a bullet straight after the colon
  // that introduces the list. Whatever the refusal is, it must not read as a
  // sentence a machine assembled.
  await expect(note).not.toContainText(': ·')
  await expect(note, 'the count and the instruction must agree')
    .not.toContainText(/1 unresolved field — fill them in/i)

  const after = await (await request.get(`/api/races/${DRAFT.slug}?t=1`)).json()
  expect(after.race.status, 'a refused activation must not promote the folder').toBe('draft')
  const active = await (await request.get('/api/race/active?t=1')).json()
  expect(active.active, 'a refused activation must not move the pointer').toBeNull()

  expect(trouble.pageErrors).toEqual([])
})

/**
 * The menu's keyboard contract, on the simplified list. Removing the action
 * rows changed `rowsFor`/`cursorForSlug` — the two functions the roving-focus
 * index is computed with — so the walk is re-pinned here: the cursor lands on
 * the race being browsed, the arrows wrap at both ends, Home/End jump, and
 * Escape puts focus back on the trigger.
 */
test('the simplified menu still keeps its keyboard contract', async ({ page, request, trouble }) => {
  await setActiveRace(request, MM.slug, 'train')
  await openDashboard(page)
  const menu = await openSwitcher(page)

  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? '')

  // The cursor lands ON the race that is loaded, once the list arrives — so
  // the first Enter is a no-op rather than a surprise.
  await expect.poll(focused, { message: 'the cursor never landed on the current race' })
    .toContain(MM.name)

  // Home / End are the two ends of the list.
  await page.keyboard.press('Home')
  expect(await focused()).toContain('No race (generic)')
  await page.keyboard.press('End')
  expect(await focused()).toContain('New race…')

  // …and the arrows wrap past both of them.
  await page.keyboard.press('ArrowDown')
  expect(await focused()).toContain('No race (generic)')
  await page.keyboard.press('ArrowUp')
  expect(await focused()).toContain('New race…')

  // The roles are unchanged: races are radios that say which one is on
  // screen, "New race…" is a plain menuitem.
  await expect(menu.getByRole('menuitemradio', { name: new RegExp(MM.name) })).toBeChecked()
  await expect(menu.getByRole('menuitemradio', { name: /No race \(generic\)/ })).not.toBeChecked()
  await expect(menu.getByRole('menuitem', { name: /New race…/ })).toBeVisible()

  // Escape closes and hands focus back to the trigger it came from.
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(switcherButton(page)).toBeFocused()

  expect(trouble.pageErrors).toEqual([])
})

/* ------------------------------------------------------------------ */
/*  What the strip REMEMBERS across a race switch                      */
/* ------------------------------------------------------------------ */

/**
 * The strip's outcome line belongs to the race it was produced for.
 *
 * `RaceTopline` lives in `<main>`, above the tabpanels — and unlike the
 * RACE/FUEL tabpanels a few lines below it, it was mounted once and never
 * remounted when the race on screen changed. It holds `useRunCourseAgain`'s
 * `done`/`warnings`/`error` and its own `activateError`, so a build outcome
 * (or a refused activation) survived a switch and rendered under a race the
 * athlete had never touched: "course rebuilt ✓", or a build-failure
 * sentence, attached to the wrong folder. Found in review; nothing covered
 * it, because every other build test opens one race and never switches.
 *
 * The fix is the `key` the tabpanels already use — and it also makes
 * `runCourseAgain.ts`'s slug-keyed `resultStore` do its job here, which is
 * the second half of this test: switching BACK brings the right note back,
 * rather than simply forgetting everything.
 *
 * rimrock-50k is the fixture with no `course.gpx` and no `links.gpx`, so its
 * build answers `ok: true, course: null` with a reason and writes nothing to
 * the folder (scripts/race-build.test.mjs's own "unresolved, not a failure"
 * case) — safe to run against the shared root.
 */
test('a build note stays with the race it was built for, across a switch and back', async ({ page, request, trouble }) => {
  await setActiveRace(request, ARCHIVED.slug, 'view')
  await openDashboard(page)

  await raceAction(page, /Run course again…/).click()
  const note = raceActionNote(page)
  await expect(note).toContainText(/no course\.gpx in the folder and no http\(s\) links\.gpx/i)

  // Switch to a different race — the active 100-miler, which has no course
  // rebuild of its own and has never been built in this page load.
  await openSwitcher(page)
  await chooseRace(page, new RegExp(MM.name))
  await expect(page.getByText(/active · training target/i)).toBeVisible()
  await expect(note, "the previous race's build note followed the switch").toHaveCount(0)

  // …and back. The note is the archived race's own again — recovered from
  // runCourseAgain.ts's resultStore, keyed by slug, which is exactly what
  // that store exists for.
  await openSwitcher(page)
  await chooseRace(page, new RegExp(ARCHIVED.name))
  await expect(raceActionNote(page)).toContainText(/no course\.gpx in the folder and no http\(s\) links\.gpx/i)

  expect(trouble.pageErrors).toEqual([])
})

/**
 * A refused activation is a note too, and leaks the same way.
 */
test('a refused activation does not follow the switch to another race', async ({ page, request, trouble }) => {
  await setActiveRace(request, DRAFT.slug, 'view')
  await openDashboard(page)

  await raceAction(page, /^Activate$/).click()
  await expect(raceActionNote(page)).toContainText(/already active|unresolved field/i)

  await openSwitcher(page)
  await chooseRace(page, new RegExp(ARCHIVED.name))
  await expect(page.getByText(/archived · .* · read-only/i)).toBeVisible()
  await expect(raceActionNote(page), "the draft's refusal followed the switch").toHaveCount(0)

  expect(trouble.pageErrors).toEqual([])
})

/**
 * A PARTIAL activation — the status flip lands, the pointer POST then fails
 * — must leave the strip agreeing with the disk.
 *
 * The strip's `activate()` is "the review screen's activate() minus its
 * pending-edits PUT", and it had dropped one more thing: the review screen
 * calls `load(...)` on a refused pointer move, re-reading the race so its own
 * state matches the server. The strip only set the error, so `useRaceGroups`
 * still said `draft` and went on offering Activate for a folder that was
 * already `active` on disk — one more click would re-POST the flip against a
 * race that had already taken it.
 *
 * Both requests are intercepted rather than let through, because the real
 * server cannot produce this state: mm-like-100 holds `status: "active"` for
 * the whole suite, so a genuine status POST on a draft is refused by the
 * single-active invariant long before any pointer move. `/api/races` is
 * rewritten to report the folder the way the disk WOULD after the flip, so
 * the re-read has something true to find and nothing is written anywhere.
 * `setActiveRace` goes through the APIRequestContext, not the page, so it is
 * untouched by these routes.
 */
test('a partial activation re-reads the race list, so Activate stops being offered', async ({ page, request, trouble }) => {
  let flipped = false

  await page.route('**/api/races*', async (route) => {
    const response = await route.fetch()
    const data = await response.json() as { races: Array<Record<string, unknown>>; groups?: Array<Record<string, unknown>> }
    if (!flipped) { await route.fulfill({ response, json: data }); return }
    const promote = (r: Record<string, unknown>) => (r.slug === DRAFT.slug ? { ...r, status: 'active' } : r)
    await route.fulfill({ response, json: { races: data.races.map(promote), groups: data.groups?.map(promote) } })
  })
  await page.route(`**/api/races/${DRAFT.slug}/status`, async (route) => {
    flipped = true
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  await page.route('**/api/race/activate', (route) => route.fulfill({
    status: 500, contentType: 'application/json',
    body: JSON.stringify({ error: 'the dev server went away mid-request' }),
  }))

  await setActiveRace(request, DRAFT.slug, 'view')
  await openDashboard(page)
  expect(await raceActionLabels(page)).toEqual([REVIEW, ACTIVATE, REFRESH])

  await raceAction(page, /^Activate$/).click()
  await expect(raceActionNote(page)).toContainText(/the folder is active but the pointer did not move/i)

  // The re-read: the strip stops offering to activate a folder that has
  // already taken the flip, and picks up the actions that status earns.
  await expect(raceAction(page, /^Activate$/)).toHaveCount(0)
  expect(await raceActionLabels(page)).toEqual([REVIEW, REFRESH, ADD_TUNE_UP, ARCHIVE])

  // …and the error survives its own reload: the strip is keyed on the loaded
  // slug, which a failed pointer move did not change.
  await expect(raceActionNote(page)).toContainText(/the folder is active but the pointer did not move/i)

  expect(trouble.pageErrors).toEqual([])
})
