import { test, expect, DRAFT, openDashboard, openReviewFor, openSwitcher, setActiveRace } from './basecamp'

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
