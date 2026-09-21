import {
  test, expect, ARCHIVED, MM,
  chooseRace, openDashboard, openSwitcher, setActiveRace, switcherButton, type Page,
} from './basecamp'

/**
 * Flow 8 — race day with the laptop gone, and the archive you were reading
 * last night staying out of it.
 *
 * Race-day mode is read on a phone, on a ridge, over a LAN link to a laptop
 * that may be asleep or out of range. The bundle survives in the browser's
 * HTTP cache; the two fetches the plan is actually built from do not. So
 * offlineCache.ts keeps the last good `/api/race/active` and `/course.json`
 * in localStorage and data.ts hands them back when a fetch fails, stamped as
 * offline rather than passed off as fresh.
 *
 * The bug this encodes (round 2, resilience finding 1) is what happens when
 * that cache is not namespaced. The athlete trains for one race and, the night
 * before, browses an archived one in the switcher. Both loads wrote the same
 * "race-active" slot, so the archive was the last one in — and an offline
 * reload at mile 60 handed back the race they were LOOKING at instead of the
 * one they were running.
 *
 * Two keys keep that from happening, and both are asserted here:
 *  · `bc.cache.race-active.<slug>` — one slot per race, not one shared slot
 *  · `bc.cache.race-active.last-train-slug` — written only by a train-mode
 *    payload, so browsing in view mode can never become the fallback's answer
 *
 * Offline is simulated by aborting the DATA endpoints, not everything: the
 * HTML and the JS bundle still have to load, because this cache is explicitly
 * not a service worker (see offlineCache.ts's LIMITATION note) and a first
 * load with the laptop unreachable is out of scope by design.
 */

/** The endpoints a sleeping laptop takes with it.
 *
 * /strava.json and /pace-grade.json were missing here until v2 review ui2
 * #1: the projection needs a Strava pace fit as much as it needs
 * course.json, but this list never knocked either of them out, so this
 * whole file kept passing while offline race-day rendered no plan at all —
 * only the "offline" banner, never a NEXT · STATION card. See the assertion
 * added right after the offline reload below, which is the one that would
 * have caught it.
 */
const DATA_ENDPOINTS = [
  '/api/race/active', '/course.json', '/crew-base.json', '/nutrition.json',
  '/strava.json', '/pace-grade.json',
]

/** Stations that belong to the 100-miler and to no other fixture race —
    "Lantern Draw", "Quartz Bench" and "Pinyon Gate" are in both charts, so
    they would prove nothing. */
const MM_ONLY_STATIONS = ['Slabtown', 'Tin Cup', 'Bitterroot Bowl']

async function goOffline(page: Page) {
  await page.route('**/*', (route) => {
    const { pathname } = new URL(route.request().url())
    return DATA_ENDPOINTS.includes(pathname) ? route.abort('failed') : route.continue()
  })
}

test.describe('race day offline', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
  })

  test('a browsed archive does not become the plan on an offline reload', async ({ page, request, trouble }) => {
    // 1. Train for the 100-miler, and open race day — that is what fills the
    //    cache: a train-mode /api/race/active payload plus its course.
    await setActiveRace(request, MM.slug, 'train')
    await openDashboard(page)
    await page.goto('/#/race-day')
    await expect(page.getByText(new RegExp(`${MM.short} · race day`, 'i'))).toBeVisible()
    await expect(page.getByText(/^next · station \d+$/i)).toBeVisible()

    // 2. …then browse the archived race, exactly as an athlete does the night
    //    before. This is a "view" pointer: it does NOT move what is being
    //    trained for, and it must not move what the offline cache answers.
    await setActiveRace(request, ARCHIVED.slug, 'view')
    await page.goto('/')
    // `/#/race-day` → `/` differs only in its hash, so this is a hash change
    // in the SAME document: the dashboard remounts and paints from the
    // payload already in memory (the 100-miler's) while the refetch that
    // notices the moved pointer is still in flight. Waiting for the vitals
    // panel therefore proves nothing about WHICH race is loaded — it was
    // winning the race against that refetch by luck, and any change to what
    // else the dashboard fetches on mount tips it (the topline strip's own
    // GET /api/races did exactly that, and this test caught it).
    //
    // Wait for the app to say it is showing the archived race instead. The
    // command-bar chip is the app's own statement of what is loaded, and it
    // cannot read RR50K until the view-mode payload has landed — which is
    // the precondition the cache assertions below actually depend on.
    await expect(switcherButton(page)).toContainText(new RegExp(ARCHIVED.short, 'i'))

    // The bookkeeping the fix turns on, read straight out of localStorage.
    const keys = await page.evaluate(() => ({
      lastTrain: localStorage.getItem('bc.cache.race-active.last-train-slug'),
      lastCached: localStorage.getItem('bc.cache.race-active.last-cached-slug'),
      slots: Object.keys(localStorage).filter((k) => k.startsWith('bc.cache.race-active.')).sort(),
    }))
    expect(keys.lastTrain, 'browsing an archive overwrote the training target').toBe(MM.slug)
    expect(keys.lastCached, 'the browsed race should still be the last thing cached').toBe(ARCHIVED.slug)
    expect(keys.slots, 'the two races must occupy two slots, not one shared one').toContain(
      `bc.cache.race-active.${MM.slug}`,
    )

    // 3. The laptop goes to sleep, and the phone is reloaded on the ridge.
    //    goto() to a URL that differs only in its hash is a hash change, not a
    //    document load, so the already-fetched state would survive it and this
    //    would test nothing — reload() is what makes the app start over with
    //    the data endpoints gone.
    await goOffline(page)
    await page.goto('/#/race-day')
    await page.reload()

    // The race being RUN comes back, stamped as cached…
    await expect(page.getByText(/offline — showing the last plan this phone loaded/i)).toBeVisible()
    await expect(page.getByText(new RegExp(`${MM.short} · race day`, 'i'))).toBeVisible()

    // …and it actually IS a plan, not just the banner claiming one: the
    // projection needs a cached Strava pace fit (and course.json) to render
    // a next station at all. This is the assertion that would have failed
    // while /strava.json and /pace-grade.json bypassed the offline cache.
    await expect(page.getByText(/^next · station \d+$/i)).toBeVisible()

    // …with its own aid chart, not the archive's.
    const body = await page.locator('body').innerText()
    for (const station of MM_ONLY_STATIONS) {
      expect(body, `the cached plan lost ${station} — this is not the 100-miler's chart`).toContain(station)
    }
    expect(body, 'the browsed archive leaked into race day').not.toContain(ARCHIVED.short)
    expect(body, 'the browsed archive leaked into race day').not.toContain('Rimrock')

    expect(trouble.pageErrors).toEqual([])
  })

  test('a hold set offline still reads back after another offline reload', async ({ page, request, trouble }) => {
    // The position hold lives in localStorage per slug, which is the only
    // reason it can work at all with the server gone. This is the flow at its
    // most literal: the runner is out of range for the rest of the race.
    await setActiveRace(request, MM.slug, 'train')
    await openDashboard(page)
    await page.goto('/#/race-day')
    await expect(page.getByText(/where am i/i)).toBeVisible()
    await page.evaluate((slug) => localStorage.removeItem(`race.${slug}.raceday_mi`), MM.slug)

    await goOffline(page)
    await page.reload()
    await expect(page.getByText(/offline — showing the last plan this phone loaded/i)).toBeVisible()

    const select = page.getByLabel('just left a station')
    const value = await select.locator('option', { hasText: /^Slabtown/ }).getAttribute('value')
    await select.selectOption(value!)
    await page.getByRole('button', { name: /^set$/i }).click()
    await expect(page.getByText(/held at/i)).toBeVisible()

    await page.reload()
    await expect(page.getByText(/held at/i)).toBeVisible()
    await expect(page.getByText(/offline — showing the last plan this phone loaded/i)).toBeVisible()

    expect(trouble.pageErrors).toEqual([])
  })
})

/**
 * Two `/api/race/active` responses in flight at once, landing out of order.
 *
 * A refresh pulse replaces the module-level in-flight request in data.ts but
 * does not cancel the fetch already running — so the older one still resolves
 * and its `.then` still runs. The writes it makes (`cachePut`,
 * `setLastCachedSlug`, `setLastTrainSlug`, `pruneActiveRaceCache`) are
 * last-writer-wins against localStorage, and unlike each hook's own `stale`
 * flag there is nobody to notice they are stale. The consequence is not
 * cosmetic: `last-cached-slug` is what the offline fallback reads on the
 * ridge, so the phone could come back showing the race it was switched away
 * from.
 *
 * Forced here by delaying only the responses that name the 100-miler, then
 * switching to the archived race while that one is still in flight. Without
 * the sequence guard in `requestActiveRace`, MM's late response overwrites
 * the archived race's bookkeeping and this reads "mm-like-100".
 */
test('a late /api/race/active response for the previous race does not overwrite the current one', async ({ page, request, trouble }) => {
  await setActiveRace(request, null)
  await openDashboard(page)

  await page.route('**/api/race/active*', async (route) => {
    const response = await route.fetch()
    const data = await response.json() as { mode?: string; active?: string | null; viewing?: string | null }
    const slug = data.mode === 'view' ? data.viewing : data.active
    // Only the 100-miler is slow, so the ARCHIVED response below overtakes it.
    if (slug === MM.slug) await new Promise((r) => setTimeout(r, 1500))
    await route.fulfill({ response, json: data })
  })

  // Pulse 1: point at the 100-miler. choose() POSTs the pointer and bumps the
  // refresh key, so a (slow) /api/race/active goes out and stays in flight.
  await openSwitcher(page)
  await chooseRace(page, new RegExp(MM.name))

  // Pulse 2, while that one is still running: the archived race, which comes
  // back immediately.
  await openSwitcher(page)
  await chooseRace(page, new RegExp(ARCHIVED.name))
  await expect(switcherButton(page)).toContainText(new RegExp(ARCHIVED.short, 'i'))

  // Long enough for the 100-miler's response to have landed too, second.
  await page.waitForTimeout(2000)

  const lastCached = await page.evaluate(() =>
    localStorage.getItem('bc.cache.race-active.last-cached-slug'))
  expect(lastCached, "a stale response rewrote what the phone thinks it last loaded")
    .toBe(ARCHIVED.slug)

  expect(trouble.pageErrors).toEqual([])
})

