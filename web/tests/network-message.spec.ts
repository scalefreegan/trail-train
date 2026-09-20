import { test, expect } from './basecamp'

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
