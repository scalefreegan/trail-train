import { test, expect, DRAFT, MM, openDashboard, openReviewFor, openSwitcher, setActiveRace } from './basecamp'

/**
 * Flow 3 — the review screen: fill a field, acknowledge another, save.
 *
 * This is the one flow in the suite that WRITES a race.json, which is exactly
 * why it has to run against a temp project root: without TRAIL_PROJECT_ROOT it
 * would edit a real race folder in the developer's checkout.
 *
 * The gate the dialog exists for is "every field intake could not establish is
 * either filled in or consciously accepted", and rounds 1–3 found three
 * separate bugs in it (an acknowledgement that did not survive a save, a
 * revert that dropped the checkboxes, a refused save that cleared the form).
 * So this asserts the round trip through the server, not just the click.
 */

const FILLED_LOCATION = 'Invented for tests · nowhere at all'

// Serial, and in this order: both tests write to the same race.json in the
// shared project root, and the second one acknowledges every remaining field —
// so it has to be the last thing that looks at the count. Serial mode also
// stops the second from running (and rewriting the folder) once the first has
// already failed.
test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ request }) => {
  await setActiveRace(request, null)
})

test('a fill and an acknowledgement both survive save and reopen', async ({ page, request, trouble }) => {
  await openDashboard(page)
  await openSwitcher(page)
  const dialog = await openReviewFor(page, DRAFT.name)

  // The fixture's eight holes, as the dialog counts them.
  await expect(dialog.getByText(/unresolved · 8/i)).toBeVisible()
  const acknowledgements = dialog.getByLabel(/^acknowledge /)
  await expect(acknowledgements).toHaveCount(8)

  const save = dialog.getByRole('button', { name: /^save edits$/i })
  // Nothing edited yet: saving is not an available action, which is what stops
  // the dialog from writing a no-op race.json every time it is opened.
  await expect(save).toBeDisabled()

  // One field answered…
  await dialog.getByLabel('fill location').fill(FILLED_LOCATION)
  // …and one accepted as genuinely unknowable.
  await dialog.getByLabel('acknowledge links.tracking').check()

  await expect(save).toBeEnabled()
  await save.click()
  await expect(save).toBeDisabled()   // back to clean — the edits landed

  // The server's own answer, read fresh: this is the assertion that would have
  // caught an acknowledgement the client showed but never persisted.
  const review = await (await request.get(`/api/races/${DRAFT.slug}?t=1`)).json()
  expect(review.race.location).toBe(FILLED_LOCATION)
  expect(review.unresolved_acknowledged).toContain('links.tracking')
  expect(review.unresolved).not.toContain('location')

  // And the dialog agrees after a full round trip through a reload.
  await page.reload()
  await openSwitcher(page)
  const reopened = await openReviewFor(page, DRAFT.name)
  await expect(reopened.getByLabel('acknowledge links.tracking')).toBeChecked()
  await expect(reopened.getByLabel(/^acknowledge /)).toHaveCount(7)
  await expect(reopened.getByText(/unresolved · 7/i)).toBeVisible()

  expect(trouble.pageErrors).toEqual([])
})

test('acknowledging every hole clears the unresolved gate on activate', async ({ page, trouble }) => {
  await openDashboard(page)
  await openSwitcher(page)
  const dialog = await openReviewFor(page, DRAFT.name)

  const activate = dialog.getByRole('button', { name: /^activate$/i })
  const unresolvedBlocker = dialog.getByText(/\d+ unresolved fields? still to fill in or acknowledge/i)

  // Two independent gates stand between a draft and "active", and the dialog
  // surfaces them one at a time. First: the unresolved fields.
  await expect(activate).toBeDisabled()
  await expect(unresolvedBlocker).toBeVisible()

  const acknowledgements = dialog.getByLabel(/^acknowledge /)
  const n = await acknowledgements.count()
  expect(n, 'the fixture draft should still have fields to accept').toBeGreaterThan(0)
  for (let i = 0; i < n; i++) await acknowledgements.nth(i).check()

  await dialog.getByRole('button', { name: /^save edits$/i }).click()
  await expect(unresolvedBlocker).toBeHidden()

  // Second gate, now the only one left: exactly one folder may carry status
  // "active", and the fixture 100-miler already does. The button stays
  // disabled — but for the other reason, which it says out loud.
  await expect(activate).toHaveAttribute('title', /already active/i)
  await expect(activate).toBeDisabled()

  // Deliberately never clicked even when it could be: activating this draft
  // would archive the 100-miler every other spec runs against.
  expect(trouble.pageErrors).toEqual([])
})

/**
 * v2 review ui2 #2/#3 — once a race is ACTIVE, its review screen used to be
 * unreachable at all (isReviewable was drafts-only), and even when it was
 * reachable nothing in the UI could set `tracking.url` — the one field the
 * live tracker actually polls. Both are exercised here against the
 * already-active 100-miler fixture rather than by pressing ACTIVATE on a
 * fresh draft: that button is deliberately never pressed anywhere in this
 * suite (see the comment above), since it would archive mm-like-100 out from
 * under every other spec.
 *
 * The tracking fields this leaves on mm-like-100's temp race.json are
 * restored to null at the end — a later spec that opens its race-day view
 * would otherwise have this test's fake tracker URL polled against it.
 */
test('an active race offers Review, and its tracker URL/bib save as tracking.url/bib', async ({ page, request, trouble }) => {
  await setActiveRace(request, MM.slug, 'train')
  await openDashboard(page)
  await openSwitcher(page)

  // The regression itself: this used to throw (no "↳ Review…" row exists
  // for an active race at all).
  const dialog = await openReviewFor(page, MM.name)

  // No ACTIVATE for a race that already is one — the button still exists
  // (drafts and actives share this screen), it just says why it can't be
  // pressed.
  const activate = dialog.getByRole('button', { name: /^activate$/i })
  await expect(activate).toBeDisabled()
  await expect(activate).toHaveAttribute('title', /only a draft activates here/i)

  const TRACKER_URL = 'https://example.invalid/mesa-monster-100/tracker-test'
  const putBodies: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'PUT' && new URL(req.url()).pathname === `/api/races/${MM.slug}`) {
      putBodies.push(req.postData() ?? '')
    }
  })

  await dialog.getByLabel('tracker url').fill(TRACKER_URL)
  await dialog.getByLabel('tracker bib').fill('42')
  await dialog.getByRole('button', { name: /^save edits$/i }).click()
  await expect(dialog.getByRole('button', { name: /^save edits$/i })).toBeDisabled()

  expect(putBodies, 'the save did not PUT /api/races/mm-like-100').toHaveLength(1)
  const body = JSON.parse(putBodies[0]) as { tracking?: { url?: string; bib?: string } }
  expect(body.tracking?.url).toBe(TRACKER_URL)
  expect(body.tracking?.bib).toBe('42')

  // The server's own answer, read fresh — not just what left the page.
  const review = await (await request.get(`/api/races/${MM.slug}?t=1`)).json()
  expect(review.race.tracking?.url).toBe(TRACKER_URL)
  expect(review.race.tracking?.bib).toBe('42')

  // Cleanup: see the file-header comment above this test.
  await request.put(`/api/races/${MM.slug}`, { data: { tracking: { url: null, bib: null, name: null } } })

  expect(trouble.pageErrors).toEqual([])
})

/**
 * Round 3 finding 2 — `linksTrackingSeed` (RaceIntake.tsx) used to reseed
 * tracking.url from race.links.tracking (mm-like-100's fixture has one:
 * "…/mesa-monster-100/live") any time race.tracking.url read falsy, which is
 * exactly what a DELIBERATE clear leaves on disk (applyRaceEdit normalizes
 * "" to null). So a save days later that only touched the bib silently put
 * the abandoned tracker link right back — this pins the fix: once url has
 * been saved at all, even as a clear, a later bib-only save must leave it
 * alone, across a full reload (a fresh mount, not just in-session state).
 */
test('clearing the tracker url is durable — a later bib-only save does not resurrect it from the seed', async ({ page, request, trouble }) => {
  // A known starting point, independent of what the previous test left
  // behind: url is really set, not merely absent.
  await request.put(`/api/races/${MM.slug}`, {
    data: { tracking: { url: 'https://example.invalid/mesa-monster-100/prior-tracker', bib: null, name: null } },
  })

  await setActiveRace(request, MM.slug, 'train')
  await openDashboard(page)
  await openSwitcher(page)
  let dialog = await openReviewFor(page, MM.name)

  // Clear it — the athlete's deliberate call to stop tracking here.
  await dialog.getByLabel('tracker url').fill('')
  await dialog.getByRole('button', { name: /^save edits$/i }).click()
  await expect(dialog.getByRole('button', { name: /^save edits$/i })).toBeDisabled()

  let review = await (await request.get(`/api/races/${MM.slug}?t=1`)).json()
  expect(review.race.tracking?.url).toBeFalsy()

  // Full reload — a fresh mount, `trackingEdit` starts null again, exactly
  // the shape a NEW session (or just reopening the dialog) leaves behind.
  await page.reload()
  await openSwitcher(page)
  dialog = await openReviewFor(page, MM.name)

  // The seed must not be back: race.links.tracking is still the live URL
  // above, but url has already been decided (cleared), so neither the copy
  // nor the field itself should offer it.
  await expect(dialog.getByText(/seeded below from this folder's own tracking link/i)).toBeHidden()
  await expect(dialog.getByLabel('tracker url')).toHaveValue('')

  // Touch ONLY the bib.
  const putBodies: string[] = []
  page.on('request', (req) => {
    if (req.method() === 'PUT' && new URL(req.url()).pathname === `/api/races/${MM.slug}`) {
      putBodies.push(req.postData() ?? '')
    }
  })
  await dialog.getByLabel('tracker bib').fill('99')
  await dialog.getByRole('button', { name: /^save edits$/i }).click()
  await expect(dialog.getByRole('button', { name: /^save edits$/i })).toBeDisabled()

  expect(putBodies, 'the bib save did not PUT /api/races/mm-like-100').toHaveLength(1)
  const body = JSON.parse(putBodies[0]) as { tracking?: { url?: string | null; bib?: string } }
  // The regression: this used to carry `url: '…/mesa-monster-100/live'`
  // (the seed) even though the athlete only edited the bib.
  expect(body.tracking?.url).toBeUndefined()
  expect(body.tracking?.bib).toBe('99')

  review = await (await request.get(`/api/races/${MM.slug}?t=2`)).json()
  expect(review.race.tracking?.url).toBeFalsy()
  expect(review.race.tracking?.bib).toBe('99')

  // Cleanup: see the file-header comment on the test above this one.
  await request.put(`/api/races/${MM.slug}`, { data: { tracking: { url: null, bib: null, name: null } } })

  expect(trouble.pageErrors).toEqual([])
})
