import { test, expect, openDashboard, setActiveRace, switcherButton } from './basecamp'

/**
 * Flow 1 — generic load.
 *
 * No race active: the dashboard the athlete sees between races. Every panel
 * has to be on screen, built from the synthetic snapshots, with nothing in the
 * console. This is the flow that catches the class of bug the interactive
 * rounds kept finding first — a panel that throws on data it did not expect
 * and takes the page down with it (the <Trajectory> crash of round 1), or a
 * snapshot the dev server quietly 404s.
 */

test.beforeEach(async ({ request }) => {
  await setActiveRace(request, null)
})

test('the generic dashboard renders every panel with a clean console', async ({ page, trouble }) => {
  await openDashboard(page)

  await expect(page).toHaveTitle('Basecamp')

  // The four panels, by their section tags. Deliberately NOT getByRole
  // ('heading'): the titles are rendered by a <SectionTag> span, and the only
  // <h1> in the app is the race hero, which generic mode does not have.
  await expect(page.getByText(/vitals — load × recovery/i)).toBeVisible()
  await expect(page.getByText(/trajectory — last \d+ weeks/i)).toBeVisible()
  await expect(page.getByText(/the road ahead — \d+ days/i)).toBeVisible()
  await expect(page.getByText(/^the log$/i)).toBeVisible()

  // The panels are populated, not just present: each of these numbers only
  // appears once its snapshot has been read and reduced.
  await expect(page.getByText(/ring · \d+ nights · strava · \d+ runs/i)).toBeVisible()
  await expect(page.getByText(/7d distance/i)).toBeVisible()
  await expect(page.getByText(/resting hr/i)).toBeVisible()

  // Generic mode, stated by the switcher chip itself.
  await expect(switcherButton(page)).toContainText(/no race/i)
  await expect(switcherButton(page)).toContainText(/generic/i)

  expect(trouble.all(), 'the generic dashboard must load without complaint').toEqual([])
})

test('the generic dashboard fits a phone without a horizontal scroll', async ({ page, trouble }) => {
  // 320 is the narrowest screen the app claims to support; the round-1 and
  // round-2 sweeps found real overflow at exactly this width.
  await page.setViewportSize({ width: 320, height: 800 })
  await openDashboard(page)

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth, `page is ${scrollWidth - clientWidth}px wider than the viewport`).toBeLessThanOrEqual(clientWidth)

  expect(trouble.pageErrors).toEqual([])
})
