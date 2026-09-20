import type { APIRequestContext } from '@playwright/test'
import { test, expect, MM, openDashboard, openRaceTab, raceAction, setActiveRace } from './basecamp'

/**
 * Round-4 interactive-review fixes, tune-up lane (ui1-altitude-tuneups.md
 * bugs 1, 2, 4, 5, 6, 10, 11, 12, 13). Each test reproduces the bug against a
 * fresh tune-up folder before checking the fix, per the fixer brief.
 */

/** Six weeks before the A race, which is always dated today (see b-race.spec.ts). */
function weeksBeforeToday(weeks: number): string {
  const d = new Date()
  d.setDate(d.getDate() - weeks * 7)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/**
 * A synthetic GPX track: `points` trkpts at 0.1 mi spacing due north, a
 * gentle elevation ramp, and no waypoints — a tune-up's only station is the
 * quick form's synthesized "Finish", which build-course.mjs resolves off the
 * track's own last point and needs no waypoint for. Mirrors the shape
 * scripts/race-build.test.mjs's makeGpx uses for its own synthetic course.
 */
function makeGpx(points: number): string {
  const LAT0 = 34.0
  const LON0 = -111.0
  const DEG_PER_TENTH_MI = 0.1 / 69.09
  const trk = Array.from({ length: points }, (_, i) => {
    const lat = LAT0 + i * DEG_PER_TENTH_MI
    const ele = 2000 + i * 0.3
    return `<trkpt lat="${lat}" lon="${LON0}"><ele>${ele.toFixed(1)}</ele></trkpt>`
  }).join('\n')
  return `<?xml version="1.0"?>\n<gpx version="1.1"><trk><name>t</name><trkseg>\n${trk}\n</trkseg></trk></gpx>`
}

/** POST /api/races directly — the same endpoint the quick form uses — so
    each test can stand up exactly the folder shape its bug needs without
    driving the dialog for setup that isn't what the test is about. */
async function createTuneUp(request: APIRequestContext, opts: {
  name: string; date: string; distanceMi: number; gainFt: number; gpxTrackPoints?: number
}) {
  let gpx: { path: string } | undefined
  if (opts.gpxTrackPoints) {
    const buf = Buffer.from(makeGpx(opts.gpxTrackPoints), 'utf8')
    const up = await request.post('/api/race-intake/upload', {
      data: buf,
      headers: { 'X-Filename': 'course.gpx' },
    })
    expect(up.ok(), await up.text()).toBeTruthy()
    gpx = { path: (await up.json()).path }
  }
  const res = await request.post('/api/races', {
    data: {
      name: opts.name,
      date: opts.date,
      distance_mi: opts.distanceMi,
      gain_ft: opts.gainFt,
      parent_slug: MM.slug,
      ...(gpx ? { gpx } : {}),
    },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  return res.json() as Promise<{ slug: string; build: { ok: boolean; unresolved?: string[]; warnings?: string[]; course?: unknown } | null }>
}

test.describe('tune-up fixes (round 4)', () => {
  test.beforeEach(async ({ request }) => {
    await setActiveRace(request, MM.slug, 'train')
  })

  test('bug 5 — "Add tune-up…" and the archive action survive view mode', async ({ page, request, trouble }) => {
    const child = await createTuneUp(request, {
      name: 'View Mode Check 25K', date: weeksBeforeToday(4), distanceMi: 15, gainFt: 900,
    })

    // Both rules used to be asked about `useActiveRace().slug`, which is
    // documented null in BOTH generic mode and view mode — so they went
    // false the instant anything but the active race's own TRAIN-mode screen
    // was on screen, even though nothing about the training target had
    // changed (round 4 finding 5). Both are asked about the folder's own
    // `status === "active"` now.
    //
    // Since the topline change these are actions on the race LOADED, so the
    // two halves get the two states that reproduce the bug:
    //
    //  · "Add tune-up…" belongs to the A race, so the A race itself is put
    //    on screen in VIEW mode (the pointer accepts it — validateActivation
    //    only gates `mode: "train"`). trainingSlug is null throughout.
    await setActiveRace(request, MM.slug, 'view')
    await openDashboard(page)
    await expect(raceAction(page, /Add tune-up…/), 'the action should survive the active race being viewed read-only')
      .toBeVisible()

    //  · `archiveTarget` is a question about the race LIST, not about what is
    //    loaded, so browsing the tune-up itself — a folder that is neither
    //    active nor archived — must still offer MM's own archive action.
    await setActiveRace(request, child.slug, 'view')
    await page.reload()
    await expect(page.getByText(/vitals — load × recovery/i)).toBeVisible()
    const archive = raceAction(page, /Archive with result…/)
    await expect(archive, 'the archive action should survive browsing a tune-up in view mode').toBeVisible()
    await expect(archive, 'it acts on the active race, and says so').toContainText(MM.short)

    expect(child.slug).toBeTruthy()
    expect(trouble.pageErrors).toEqual([])
  })

  test('bug 11 — the empty-course panel says "tune-up planner", not "race planner"', async ({ page, request }) => {
    await createTuneUp(request, { name: 'No Course Yet 10K', date: weeksBeforeToday(2), distanceMi: 6.2, gainFt: 200 })
    await setActiveRace(request, MM.slug, 'train')
    // View mode: the tune-up itself, same as the switcher would put it in.
    const listed = await (await request.get('/api/races?t=1')).json()
    const child = listed.races.find((r: { name: string }) => r.name === 'No Course Yet 10K')
    await setActiveRace(request, child.slug, 'view')

    await openDashboard(page)
    await openRaceTab(page)
    await expect(page.getByText(/^tune-up planner/i)).toBeVisible()
    await expect(page.getByText(/^race planner/i)).toHaveCount(0)
    await expect(page.getByText(/no course data yet/i)).toBeVisible()
  })

  test('bug 2 — "run course build" on a GPX-less tune-up reports why, instead of doing nothing', async ({ page, request }) => {
    await createTuneUp(request, { name: 'Dead Button Check 10K', date: weeksBeforeToday(2), distanceMi: 6.2, gainFt: 200 })
    const listed = await (await request.get('/api/races?t=1')).json()
    const child = listed.races.find((r: { name: string }) => r.name === 'Dead Button Check 10K')
    await setActiveRace(request, child.slug, 'view')

    await openDashboard(page)
    await openRaceTab(page)
    const button = page.getByRole('button', { name: /run course build/i })
    await expect(button).toBeVisible()
    await button.click()

    // Previously: the panel came back byte-identical, no error, no toast —
    // onDone() fired on an `ok: true, course: null` result and just re-404'd.
    await expect(page.getByText(/no course\.gpx/i)).toBeVisible()
    // and the button itself is still there to retry, not silently disabled
    // forever on a state the athlete can't see a reason for
    await expect(button).toBeEnabled()
  })

  test('bug 1 & 4 & 12 — a GPX far off the declared distance is flagged, the fuel print button stays gated, and cutoffs are not attributed to a manual that never existed', async ({ page, request, trouble }) => {
    // Declared 10 mi; the synthetic track is 400 * 0.1mi = 40 mi — a 4x
    // overshoot, comfortably past build-course.mjs's MISMATCH_THRESHOLD.
    const created = await createTuneUp(request, {
      name: 'Mismatch Check 10K', date: weeksBeforeToday(3), distanceMi: 10, gainFt: 500, gpxTrackPoints: 400,
    })
    expect(created.build?.ok, 'the build should still succeed — a mismatch is a warning, not a failure').toBe(true)
    expect(created.build?.warnings?.some((w) => /GPX may be truncated or the wrong file/.test(w)),
      created.build?.warnings?.join(' | ')).toBeTruthy()

    const raceDetail = await (await request.get(`/api/races/${created.slug}?t=1`)).json()
    expect(raceDetail.race.unresolved, 'the mismatch should be persisted onto race.json, not just returned in-memory')
      .toContain('course.gpx')

    await setActiveRace(request, created.slug, 'view')
    await openDashboard(page)
    await openRaceTab(page)

    // bug 1: the planner names the mismatch instead of silently presenting a
    // station row built from two different mile spaces.
    const banner = page.getByText(/course\.gpx measures/i)
    await expect(banner).toBeVisible()
    // Round-5 confirmation NEW-1: once the tune-up's finish row takes the
    // measured distance, the A-race sentence ("the station miles are still
    // the declared chart miles") is false here — the banner must say which
    // figure it is contradicting.
    await expect(banner).toContainText(/finish row uses the measured distance/i)
    await expect(banner).not.toContainText(/still the declared chart miles/i)

    // Round 4 confirm, ui1 PARTIAL #1: naming the mismatch wasn't enough —
    // the station row itself still read the pre-upload DECLARED distance
    // next to a climb/pace already derived from the real GPX. The row's own
    // distance must now come from the built course, same as the banner's
    // "measures X km" figure — both go through the app's own u.dist(mi, 1),
    // so the two rendered strings must be the literal same number: one row,
    // one number, not "the banner knows but the row still doesn't".
    const bannerText = await banner.innerText()
    const measuredKm = bannerText.match(/measures ([\d,.]+) km/i)?.[1]
    expect(measuredKm, bannerText).toBeTruthy()

    // .race-table's direct-child divs are [header, one row per station, a
    // totals footer] — a tune-up has exactly one station ("Finish", the
    // quick form's only synthesized one), so index 1 is it. (.last() would
    // grab the totals footer instead — it also renders inside .race-table,
    // and its own label text ends in "…at finish".)
    const stationRow = page.locator('.race-table > div').nth(1)
    await expect(stationRow.getByText('Finish', { exact: true })).toBeVisible()
    const rowDistance = await stationRow.locator('> span').first().innerText()
    expect(
      rowDistance,
      `the Finish row's distance (${rowDistance} km) must equal the course-measured distance the banner cites (${measuredKm} km), not the declared 10 mi`,
    ).toBe(measuredKm)

    // bug 4: no nutrition.json was ever written for this folder, so the
    // print button behind DEFAULT_NUTRITION must stay off, same as the fuel
    // column next to it.
    await expect(page.getByRole('button', { name: /fuel card 3×5/i })).toHaveCount(0)

    // bug 12: cutoff_h is null throughout (the quick form never sets one) —
    // the footer must not claim a runner manual that was never read.
    await expect(page.getByText(/no cutoffs on this course/i)).toBeVisible()
    await expect(page.getByText(/cutoffs from the runner manual/i)).toHaveCount(0)

    expect(trouble.pageErrors).toEqual([])
  })

  test('bug 10 & 13 — the disabled submit says why, and an absurd date is refused with a hint', async ({ page, trouble }) => {
    await openDashboard(page)
    await raceAction(page, /Add tune-up…/).click()
    const dialog = page.getByRole('dialog', { name: 'add tune-up' })
    await expect(dialog).toBeVisible()

    const submit = dialog.getByRole('button', { name: /^add tune-up$/i })
    await expect(submit).toBeDisabled()
    await expect(dialog.getByText(/name a race/i)).toBeVisible()

    await dialog.getByLabel('name').fill('Sanity Check 10K')
    await expect(dialog.getByText(/pick a date/i)).toBeVisible()

    // bug 13: absurdly far from the parent race — refused with a hint,
    // rather than the old "1493 weeks out" nonsense and an enabled button.
    await dialog.getByLabel('date').fill('1999-01-01')
    await expect(dialog.getByText(/nowhere near its block/i)).toBeVisible()
    await expect(dialog.getByText(/check the year/i)).toBeVisible()
    await expect(submit).toBeDisabled()

    await dialog.getByLabel('date').fill(weeksBeforeToday(3))
    await expect(dialog.getByText(/distance mi must be/i)).toBeVisible()

    await dialog.getByLabel('distance mi').fill('6.2')
    // Round 4 confirm, NEW #2: a blank gain ft used to sail straight through
    // this gate (`Number("") === 0` against a `gainNum >= 0` check) and get
    // written as `gain_ft: 0` with `provenance.gain_ft.by: "user"` — a
    // flat-course claim the athlete never typed. It must disable submit with
    // its own hint, same as every other required field on this form.
    await expect(dialog.getByText(/gain ft must be/i)).toBeVisible()
    await expect(submit).toBeDisabled()

    // 0 typed EXPLICITLY is a legitimate flat-course claim, not a blank —
    // and enables submit.
    await dialog.getByLabel('gain ft').fill('0')
    await expect(submit).toBeEnabled()

    // Gain still has its own floor — typed negative, it disables again with
    // its own reason.
    await dialog.getByLabel('gain ft').fill('-5')
    await expect(dialog.getByText(/gain ft must be/i)).toBeVisible()
    await expect(submit).toBeDisabled()
    await dialog.getByLabel('gain ft').fill('300')
    await expect(submit).toBeEnabled()

    // Blanking a previously-valid gain re-disables it — the guard holds
    // after a valid value too, not just on the field's first render.
    await dialog.getByLabel('gain ft').fill('')
    await expect(dialog.getByText(/gain ft must be/i)).toBeVisible()
    await expect(submit).toBeDisabled()

    await dialog.getByRole('button', { name: /close esc/i }).click()
    expect(trouble.pageErrors).toEqual([])
  })

  test('bug 6 — the quick form draft survives "run the full intake instead"', async ({ page, trouble }) => {
    await openDashboard(page)

    await raceAction(page, /Add tune-up…/).click()
    let dialog = page.getByRole('dialog', { name: 'add tune-up' })
    await dialog.getByLabel('name').fill('Carryover Check 50k')
    await dialog.getByLabel('date').fill(weeksBeforeToday(5))
    await dialog.getByLabel('distance mi').fill('31')
    await dialog.getByLabel('gain ft').fill('4200')

    await dialog.getByRole('button', { name: /run the full intake instead/i }).click()
    const intake = page.getByRole('dialog', { name: 'new race' })
    await expect(intake).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(intake).toBeHidden()

    // Reopen the quick form on the same parent — the typed values used to be
    // gone for good at this point (round 4 finding 6).
    await raceAction(page, /Add tune-up…/).click()
    dialog = page.getByRole('dialog', { name: 'add tune-up' })
    await expect(dialog.getByLabel('name')).toHaveValue('Carryover Check 50k')
    await expect(dialog.getByLabel('distance mi')).toHaveValue('31')
    await expect(dialog.getByLabel('gain ft')).toHaveValue('4200')

    await dialog.getByRole('button', { name: /close esc/i }).click()
    expect(trouble.pageErrors).toEqual([])
  })
})
