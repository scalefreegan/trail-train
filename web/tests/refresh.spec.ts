import { test, expect, CREWLESS, openDashboard, openRefreshFor, openSwitcher, setActiveRace } from './basecamp'

/**
 * Flow 9 — "Refresh from sources", end to end, with no agent and no internet.
 *
 * Two environment contracts make this testable at all (README, "Running the
 * browser tests"):
 *
 *  · TRAIL_FAKE_AGENT — global setup points scripts/agent-run.mjs at
 *    tests/fixtures/agent/refresh-stage1.json, so the intake's agent turn
 *    resolves with a canned draft instead of spawning `claude`. Everything
 *    after the agent — validateAgentDraft, buildRaceJson, the course build,
 *    the deterministic merge and diff.json — is the real code.
 *  · TRAIL_PROJECT_ROOT — the folder a refresh writes its shadow into, and
 *    (on Accept) rewrites, is a temp copy. This is the only flow in the suite
 *    that accepts a rewrite of a race.json, which is why it runs against
 *    crewless-50k: nothing else asserts on that folder.
 *
 * The site is loopback too. scripts/race-intake.mjs really fetches
 * `links.site`, so the launcher points this fixture race at a page served by
 * the very vite under test (web/tests/fixtures/site/dry-wash-50k.html) rather
 * than at a public URL — a suite that needed DNS to pass would be a suite that
 * fails on a plane.
 *
 * The promise being tested is the one the whole design exists for: a refresh
 * writes NOTHING to the live folder until Accept. So the race on disk is read
 * back mid-flow, with the diff on screen, and has to be unchanged.
 */

/** races/_fixtures/crewless-50k says 9; the fixture site says 9:30. */
const CUTOFF_BEFORE = 9
const CUTOFF_AFTER = 9.5

test.describe.configure({ mode: 'serial' })

test('a refresh shows a diff, writes nothing until Accept, then writes exactly that', async ({ page, request, trouble }) => {
  await setActiveRace(request, null)

  // The race as it stands, straight from the server.
  const before = await (await request.get(`/api/races/${CREWLESS.slug}?t=1`)).json()
  expect(before.race.cutoff_h, 'the fixture drifted — this spec assumes the committed cutoff').toBe(CUTOFF_BEFORE)

  await openDashboard(page)
  await openSwitcher(page)
  const dialog = await openRefreshFor(page, CREWLESS.name)

  // The ready screen, before anything has run.
  await expect(dialog.getByRole('button', { name: /^refresh$/i })).toBeEnabled()
  await dialog.getByRole('button', { name: /^refresh$/i }).click()

  // The diff screen. This sentence is the app's own promise, and it is the
  // thing the assertion three lines down actually verifies.
  await expect(dialog.getByText(/nothing has been written to the race yet/i)).toBeVisible()
  await expect(dialog.getByText(/race\.json · \d+ changes?/i)).toBeVisible()

  // The two cutoffs the fixture site moved, by their row labels: a bare field
  // path for a top-level field, "<station> · <field>" for one inside the aid
  // chart (RaceRefresh's `rowLabel`).
  await expect(dialog.getByText('cutoff_h', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Broken Fence · cutoff_h')).toBeVisible()

  // …and the live folder is still untouched while all of that is on screen.
  const mid = await (await request.get(`/api/races/${CREWLESS.slug}?t=2`)).json()
  expect(mid.race.cutoff_h, 'the refresh wrote to the live race before Accept').toBe(CUTOFF_BEFORE)

  await dialog.getByRole('button', { name: /^accept$/i }).click()
  await expect(dialog).toBeHidden()

  // Now, and only now, the race on disk says what the sources said.
  const after = await (await request.get(`/api/races/${CREWLESS.slug}?t=3`)).json()
  expect(after.race.cutoff_h).toBe(CUTOFF_AFTER)
  expect(after.race.aid_stations.find((s: { name: string }) => s.name === 'Broken Fence').cutoff_h).toBeCloseTo(5.333, 3)
  // The folder is still the folder it was: a refresh may not re-slug a race,
  // whatever the new sources call it.
  expect(after.race.slug).toBe(CREWLESS.slug)
  expect(after.race.status, 'a refresh must not promote or retire a race').toBe('draft')

  expect(trouble.pageErrors).toEqual([])
})

test('a second refresh finds nothing to do, and Reject leaves the race alone', async ({ page, request, trouble }) => {
  await setActiveRace(request, null)
  await openDashboard(page)
  await openSwitcher(page)
  const dialog = await openRefreshFor(page, CREWLESS.name)

  await dialog.getByRole('button', { name: /^refresh$/i }).click()

  // The same sources against the race they were just applied to: the only
  // rows left are the ones a re-fetch always rewrites (the sources cache's own
  // timestamps), so "accept" may or may not be offered — but the cutoff the
  // first test applied must not appear again as a change.
  await expect(dialog.getByText(/nothing has been written to the race yet|^no change$/i)).toBeVisible()
  await expect(dialog.getByText('Broken Fence · cutoff_h')).toBeHidden()

  await dialog.getByRole('button', { name: /^reject$/i }).click()
  await expect(dialog).toBeHidden()

  const after = await (await request.get(`/api/races/${CREWLESS.slug}?t=4`)).json()
  expect(after.race.cutoff_h, 'Reject must leave the accepted value alone').toBe(CUTOFF_AFTER)

  expect(trouble.pageErrors).toEqual([])
})
