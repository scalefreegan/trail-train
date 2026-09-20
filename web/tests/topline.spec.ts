import {
  test, expect, ARCHIVED, DRAFT, MM,
  openDashboard, openSwitcher, raceAction, raceActionLabels, setActiveRace, switcherButton,
  writeRawRaceFolder,
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
 * `archiveTarget` is the one rule that is NOT a question about the folder on
 * screen: it is "the race being trained for, or the archived race on screen
 * with no activity linked". mm-like-100 is active throughout this suite, so
 * its archive action rides along on every state below and names MM's own
 * short code — deliberately, and exactly as the menu's footer row did.
 */

/* The labels as the page renders them — `.chip` is text-transform:
   uppercase, so this is what the athlete actually reads. */
const REVIEW = 'REVIEW…'
const ACTIVATE = 'ACTIVATE'
const REFRESH = 'REFRESH FROM SOURCES… · PAID'
const RERUN = 'RUN COURSE AGAIN…'
const ADD_TUNE_UP = 'ADD TUNE-UP…'
const ARCHIVE_MM = `ARCHIVE WITH RESULT… · ${MM.short}`

test('a draft offers review, activate and a paid refresh — and nothing that needs a course or a block', async ({ page, request, trouble }) => {
  await setActiveRace(request, DRAFT.slug, 'view')
  await openDashboard(page)

  expect(await raceActionLabels(page)).toEqual([REVIEW, ACTIVATE, REFRESH, ARCHIVE_MM])
  // The strip says what the race IS, in the same words the old viewing
  // banner used.
  await expect(page.getByText(/draft · not activated/i)).toBeVisible()

  expect(trouble.pageErrors).toEqual([])
})

test('the active race in train mode offers review, refresh, a tune-up and its own archive', async ({ page, request, trouble }) => {
  await setActiveRace(request, MM.slug, 'train')
  await openDashboard(page)

  expect(await raceActionLabels(page)).toEqual([REVIEW, REFRESH, ADD_TUNE_UP, ARCHIVE_MM])
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

  expect(await raceActionLabels(page)).toEqual([REVIEW, REFRESH, ADD_TUNE_UP, ARCHIVE_MM])
  await expect(page.getByText(/active · viewing read-only/i)).toBeVisible()

  expect(trouble.pageErrors).toEqual([])
})

test('an archived race offers a refresh and a course rebuild, but no review and no tune-up', async ({ page, request, trouble }) => {
  await setActiveRace(request, ARCHIVED.slug, 'view')
  await openDashboard(page)

  expect(await raceActionLabels(page)).toEqual([REFRESH, RERUN, ARCHIVE_MM])
  // Its aid chart and tracker are done being edited (isReviewable is drafts
  // and the active race only), and an archived folder has no live block for
  // a tune-up to sit inside.
  await expect(raceAction(page, /Review…/)).toHaveCount(0)
  await expect(raceAction(page, /Add tune-up…/)).toHaveCount(0)
  await expect(page.getByText(/archived · .* · read-only/i)).toBeVisible()

  expect(trouble.pageErrors).toEqual([])
})

/**
 * A tune-up nested inside its A race's block had no action rows in the menu
 * either — the render emitted its row bare, since every one of those rules
 * is about the A race. Browsing one gets the same answer on the strip: the
 * only button is the A race's own archive action, which is not about the
 * folder on screen at all.
 */
test('a tune-up offers no actions of its own', async ({ page, request, trouble }) => {
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

  expect(await raceActionLabels(page)).toEqual([ARCHIVE_MM])

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

  expect(await raceActionLabels(page)).toEqual([ARCHIVE_MM])

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
  await expect(page.getByText(/already active|unresolved field/i)).toBeVisible()

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
