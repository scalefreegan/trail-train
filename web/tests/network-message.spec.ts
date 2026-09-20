import { test, expect, MM, openDashboard, openRaceTab, setActiveRace } from './basecamp'

/**
 * ui3-resilience BUG 6 — data.ts's own instance.
 *
 * requestActiveRace's `.catch()` used to throw the caught error away and
 * always report "active race config corrupt or unreadable", even when the
 * real cause was the dev server being unreachable (fetch() itself rejecting
 * with a TypeError, not a bad JSON parse). The fix is `netMessage()`
 * (web/src/race/dialogChrome.ts, shared with friendlyFetchError), which
 * tells the two apart from the error alone.
 *
 * RaceDayRoute is the one place `useActiveRace().error` reaches the screen
 * verbatim (`{error && <Notice tone="warn">{error}</Notice>}` when there is
 * no active race at all) — reached here with NO prior successful load (a
 * fresh context has no offline cache to fall back to), so this exercises the
 * true "kind: error" path rather than the friendlier cached/offline one.
 *
 * The useRaceData.ts and nutrition.ts instances of this same bug belong to
 * other lanes and are not covered here.
 */
test('a network-unreachable /api/race/active reports "server unreachable", not "corrupt or unreadable"', async ({ page, trouble }) => {
  await page.route('**/api/race/active*', (route) => route.abort('failed'))
  await page.goto('/#/race-day')

  await expect(page.getByText(/server unreachable — is basecamp running\?/i)).toBeVisible()
  await expect(page.getByText(/corrupt or unreadable/i)).toHaveCount(0)

  expect(trouble.pageErrors).toEqual([])
})

/**
 * ui3-resilience BUG 6, residual half (confirm-ui2/ui3): useClimbs and
 * usePhysiology (useRaceData.ts) still funneled a dead server into
 * "climbs.json corrupt or unreadable" / "athlete profile unreadable —
 * planning against 75 kg defaults" via a bare `.catch(() => …)` that threw
 * the actual error away, exactly the bug course.json/crew-base.json/
 * pace-grade.json were already fixed for in the same file. Both now go
 * through loadFailureMessage(e, …), same as those three.
 *
 * (useRaceResult's identical `.catch(() => …)` for result.json was fixed
 * the same way, but no component ever renders that hook's `error` — see
 * useRaceData.ts — so there is nothing to assert on screen for it; the
 * fix there is a code-level match to the other three, not a UI behavior.)
 */
test('a dead server reading climbs.json / api/settings reports "server unreachable", not "corrupt/unreadable"', async ({ page, request, trouble }) => {
  await setActiveRace(request, MM.slug, 'train')
  await page.route('**/climbs.json*', (route) => route.abort('failed'))
  await page.route('**/api/settings*', (route) => route.abort('failed'))
  await openDashboard(page)
  await openRaceTab(page)

  await expect(page.getByText(/server unreachable — is basecamp running\?/i).first()).toBeVisible()
  await expect(page.getByText(/climbs\.json corrupt or unreadable/i)).toHaveCount(0)
  await expect(page.getByText(/athlete profile unreadable/i)).toHaveCount(0)
  await expect(page.getByText(/result\.json corrupt or unreadable/i)).toHaveCount(0)

  expect(trouble.pageErrors).toEqual([])
})
