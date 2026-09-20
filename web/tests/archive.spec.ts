import { test, expect, ARCHIVED, MM, openDashboard, raceAction, setActiveRace } from './basecamp'

/**
 * Flow 6 — "Archive with result…": picking the Strava run that IS the race.
 *
 * The fixture that makes this testable is a synthetic activity on race day —
 * see `raceDayRun` in tests/fixtures/snapshots.mjs. The 100-miler is always
 * dated today, so the dialog's picker (±3 days around the race date, race day
 * first, longest first) has exactly one obvious candidate and a log of
 * ordinary training runs around it to pick wrongly from.
 *
 * Round 2 found two bugs here that this encodes:
 *  · draft finding 7 — a row more than ±1 day from race day could be picked,
 *    and then ARCHIVE simply stayed dead with no explanation. It is now
 *    disabled, labelled "too far out", and says why in its title.
 *  · draft finding 4 — a DNS/DNF, or an official finish time typed in by hand,
 *    is a complete result with no Strava activity at all. The dialog said so;
 *    the button never agreed.
 *
 * What this spec deliberately does NOT do is press ARCHIVE RACE. Archiving the
 * 100-miler retires races/mm-like-100, releases the pointer and deletes the
 * race every other spec in this suite runs against — the same reason
 * review.spec.ts never presses ACTIVATE. The server side of the archive has
 * its own coverage in scripts/race-result.test.mjs; what is untested anywhere
 * else, and is tested here, is the dialog that decides WHAT gets sent.
 */

/* The archive action moved out of the switcher menu and onto the topline
   strip with every other per-race action (App.tsx's RaceTopline). Its
   eligibility rule did not change: it is still `archiveTarget` — the active
   race, or the archived race on screen that never got its activity linked —
   and the button still names the folder it would act on, since that is not
   always the one loaded. */
const archiveButton = /Archive with result…/

test.beforeEach(async ({ page, request }) => {
  await setActiveRace(request, MM.slug, 'train')
  await openDashboard(page)
})

async function openArchive(page: import('./basecamp').Page) {
  await raceAction(page, archiveButton).click()
  const dialog = page.getByRole('dialog', { name: 'archive with result' })
  await expect(dialog).toBeVisible()
  return dialog
}

test('the picker defaults to the race-day run and refuses everything outside ±1 day', async ({ page, trouble }) => {
  const dialog = await openArchive(page)

  // The dialog names the race and the day it is looking for.
  await expect(dialog.getByText(new RegExp(`Pick the Strava activity that is`, 'i'))).toBeVisible()

  const rows = dialog.getByRole('radio')
  await expect(rows.first()).toBeVisible()

  // Race day first, and already selected — nothing has been clicked yet, so
  // this is `defaultId` doing its job: the longest run ON race day.
  const first = rows.first()
  await expect(first).toContainText(/race day/i)
  await expect(first).toContainText(/100\.4 mi/)
  await expect(first).toBeChecked()

  // Every row the server would refuse is disabled and says why, rather than
  // being selectable into a dead ARCHIVE button.
  const tooFar = dialog.getByRole('radio').filter({ hasText: /too far out/i })
  const n = await tooFar.count()
  expect(n, 'the ±3-day picker window should include days the ±1-day server rule refuses').toBeGreaterThan(0)
  for (let i = 0; i < n; i++) {
    await expect(tooFar.nth(i)).toBeDisabled()
    await expect(tooFar.nth(i)).toHaveAttribute('title', /more than 1 day from race day/i)
  }

  // With the race-day run selected, the dialog is ready to submit.
  await expect(dialog.getByRole('button', { name: /^archive race$/i })).toBeEnabled()

  expect(trouble.pageErrors).toEqual([])
})

test('a DNS needs no activity at all, and a malformed finish time blocks the submit', async ({ page, trouble }) => {
  const dialog = await openArchive(page)
  const archive = dialog.getByRole('button', { name: /^archive race$/i })

  // "official results" is where a finish time off the posted clock goes, for
  // the race whose watch died or whose GPS never uploaded.
  await dialog.getByRole('button', { name: /official results/i }).click()
  const finish = dialog.getByLabel(/official finish/i)
  await expect(finish).toBeVisible()

  // Nonsense in the finish field is caught before anything is sent: the server
  // would take "not a time" as no time at all and archive a finish with no
  // clock on it.
  await finish.fill('not a time')
  await expect(archive).toBeDisabled()
  await finish.fill('33:16')
  await expect(archive).toBeEnabled()

  // …and a DNS is a complete result with no activity and no time.
  await finish.fill('')
  // By role, not by label: the "result" <label> wraps its own <select>, so the
  // computed label text is "result" followed by every option's text and
  // getByLabel(/^result$/) matches nothing.
  await dialog.getByRole('combobox').selectOption('dns')
  await expect(archive).toBeEnabled()

  // Never pressed — see the file header.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  expect(trouble.pageErrors).toEqual([])
})

test('an already-archived, fully-linked race offers no "Link result…" for itself — but the still-active race is still offered its own archive row', async ({ page, request, trouble }) => {
  // rimrock-50k came out of races/_fixtures already archived, with a
  // result.json beside its race.json. Browsing it must not offer to LINK a
  // result it already has.
  //
  // It also must not make the "Archive with result…" row for the race
  // actually being trained for (MM, still `status: "active"` on disk —
  // `beforeEach` never moves it, and this test's own `setActiveRace` call
  // only changes the pointer's MODE/slug, never any folder's own status)
  // disappear. `archiveTarget` used to key its first branch on
  // `useActiveRace().slug`, documented null in BOTH generic mode and this
  // one (view mode) — the exact cause `canAddTuneUp` had — so it went null,
  // and the row vanished, the instant anything but MM's own train-mode
  // screen was on screen (round 4 finding 5, same fix shape as
  // canAddTuneUp: the race's own `status === "active"`, not the
  // view-mode-null training slug).
  await setActiveRace(request, ARCHIVED.slug, 'view')
  await page.reload()
  await expect(page.getByText(/vitals — load × recovery/i)).toBeVisible()

  const result = await (await request.get(`/api/races/${ARCHIVED.slug}/result?t=1`)).json()
  expect(result.result, 'the archived fixture should carry a result.json').not.toBeNull()
  expect(result.result.finish_h).toBeGreaterThan(0)

  // MM's own button, naming MM specifically — not a "Link result…" for the
  // browsed archive, which already has what it needs.
  const button = raceAction(page, archiveButton)
  await expect(button).toBeVisible()
  await expect(button).toContainText(MM.short)
  await expect(raceAction(page, /Link result…/)).toHaveCount(0)

  expect(trouble.pageErrors).toEqual([])
})
