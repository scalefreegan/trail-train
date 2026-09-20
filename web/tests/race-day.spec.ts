import { test, expect, MM, setActiveRace } from './basecamp'

/**
 * Flow 4 — race-day mode's position hold, at `#/race-day` on a phone.
 *
 * The launcher dates the fixture 100-miler so it started six hours ago in its
 * own timezone (see launch.mjs `startedHoursAgo`), which is the only state in
 * which this view does its job: before the gun it counts down and after the
 * cutoff it says race day has passed, and neither projects a next station.
 *
 * The hold is the bug-prone half. `resolveHold` has its own unit test
 * (scripts/race-day-hold.test.mjs); what this covers is the wiring around it,
 * which is exactly where round 1 found "held at 0.0 km" — SET submitting the
 * empty mile field instead of the station the runner had just picked.
 */

test.beforeEach(async ({ page, request }) => {
  await setActiveRace(request, MM.slug, 'train')
  // A previous run's hold is remembered per slug in localStorage, so start
  // every test from "auto" rather than from whatever the last one left.
  await page.goto('/')
  await page.evaluate((slug) => localStorage.removeItem(`race.${slug}.raceday_mi`), MM.slug)
  await page.goto('/#/race-day')
})

/** The station <select>'s option VALUE is the station's total_mi as a string,
    never its name — picking by label would be picking by a formatted number. */
const stationSelect = (page: import('@playwright/test').Page) =>
  page.getByLabel('just left a station')

test('race-day mode shows the live race with a next station', async ({ page, trouble }) => {
  await expect(page.getByText(new RegExp(`${MM.short} · race day`, 'i'))).toBeVisible()
  await expect(page.getByText(/elapsed \d+h \d+m · cutoff/i)).toBeVisible()
  await expect(page.getByText(/^next · station \d+$/i)).toBeVisible()
  await expect(page.getByText(/where am i/i)).toBeVisible()

  // It is a phone view: nothing may push the page sideways.
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth)

  expect(trouble.all()).toEqual([])
})

test('picking a station stages it, SET commits it, AUTO hands it back to the clock', async ({ page, trouble }) => {
  const select = stationSelect(page)
  await expect(select).toBeVisible()

  const before = await page.locator('body').innerText()
  expect(before, 'no hold until one is set').not.toMatch(/held at/i)
  await expect(page.getByText(/auto — position and .to go. come from the projection/i)).toBeVisible()

  // "Slabtown", the halfway station — by VALUE, which is its total_mi.
  const option = select.locator('option', { hasText: /^Slabtown/ })
  const value = await option.getAttribute('value')
  const label = (await option.textContent())!.trim()
  await select.selectOption(value!)

  // Staged, not committed: this is the distinction the round-1 bug collapsed.
  await expect(page.getByText(/picked — press SET to hold here/i)).toBeVisible()
  expect(await page.locator('body').innerText(), 'a pick alone must not move the hold').not.toMatch(/held at/i)

  await page.getByRole('button', { name: /^set$/i }).click()

  // The hold reads back at the station's own distance — the "held at 0.0 km"
  // regression is a failure of exactly this assertion.
  const heldAt = label.split('·').pop()!.trim()          // e.g. "71.8 km"
  await expect(page.getByText(new RegExp(`held at\\s*${heldAt.replace('.', '\\.')}`, 'i'))).toBeVisible()

  // …and the station being run TOWARD is now the one after it.
  await expect(page.getByText(/^next · station \d+$/i)).toBeVisible()
  await expect(page.getByText(/ETAs below are still the planned ones/i)).toBeVisible()

  // AUTO gives the projection back.
  await page.getByRole('button', { name: /^auto$/i }).click()
  await expect(page.getByText(/auto — position and .to go. come from the projection/i)).toBeVisible()
  expect(await page.locator('body').innerText()).not.toMatch(/held at/i)

  // SET with nothing staged is a no-op, not a hold at mile zero.
  await page.getByRole('button', { name: /^set$/i }).click()
  expect(await page.locator('body').innerText()).not.toMatch(/held at/i)

  expect(trouble.pageErrors).toEqual([])
})

test('an unparsable WHERE AM I entry names the unit the toggle is actually showing', async ({ page, trouble }) => {
  // v2 review confirm-ui1 NEW #3: a bare number in the free-mile box reads
  // in whatever unit the toggle currently shows (default here is metric —
  // UnitsProvider falls back to "metric" with nothing in localStorage), but
  // the unparsable-entry copy used to hardcode "try a mile number" even in
  // KM·M mode, telling the runner the wrong thing about the box she's
  // staring at.
  const miInput = page.getByPlaceholder(/^mile \(/i)
  await expect(miInput).toHaveAttribute('placeholder', 'mile (km)')

  await miInput.fill('banana')
  await page.getByRole('button', { name: /^set$/i }).click()
  await expect(page.getByText(/can't read "banana"/i)).toBeVisible()
  await expect(page.getByText(/try a bare km number/i)).toBeVisible()
  await expect(page.getByText(/try a bare mi number/i)).toHaveCount(0)

  // Toggle to imperial (the switch lives on the dashboard, not race-day) and
  // repeat: the same box, the same copy, now naming "mi" instead.
  await page.evaluate(() => localStorage.setItem('units', 'imperial'))
  await page.reload()
  const miInputImperial = page.getByPlaceholder(/^mile \(/i)
  await expect(miInputImperial).toHaveAttribute('placeholder', 'mile (mi)')
  await miInputImperial.fill('banana')
  await page.getByRole('button', { name: /^set$/i }).click()
  await expect(page.getByText(/can't read "banana"/i)).toBeVisible()
  await expect(page.getByText(/try a bare mi number/i)).toBeVisible()
  await expect(page.getByText(/try a bare km number/i)).toHaveCount(0)

  expect(trouble.pageErrors).toEqual([])
})

test('the hold survives a reload, and ← dashboard leaves race-day mode', async ({ page }) => {
  const select = stationSelect(page)
  const value = await select.locator('option', { hasText: /^Tin Cup/ }).getAttribute('value')
  await select.selectOption(value!)
  await page.getByRole('button', { name: /^set$/i }).click()
  await expect(page.getByText(/held at/i)).toBeVisible()

  // A phone that sleeps mid-climb has to come back knowing where it was.
  await page.reload()
  await expect(page.getByText(/held at/i)).toBeVisible()

  await page.getByRole('button', { name: /dashboard/i }).click()
  await expect(page).toHaveURL(/#?$/)
  expect(new URL(page.url()).hash).toBe('')
  await expect(page.getByText(/vitals — load × recovery/i)).toBeVisible()
})
