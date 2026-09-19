import { test, expect, ARCHIVED, DRAFT, MM, chooseRace, openDashboard, openSwitcher, setActiveRace, switcherButton } from './basecamp'

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
  await page.getByRole('button', { name: /^race$/i }).click()
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
