import {
  test, expect, ARCHIVED, DRAFT, MM,
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
test('a tune-up chained onto another tune-up renders once, orphaned, and does not shift the cursor', async ({ page, request }) => {
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
