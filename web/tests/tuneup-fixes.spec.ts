import type { APIRequestContext } from '@playwright/test'
import { test, expect, MM, openDashboard, openSwitcher, openRaceTab, setActiveRace } from './basecamp'

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

  test('bug 5 — "Add tune-up…" stays offered while browsing a different folder in view mode', async ({ page, request, trouble }) => {
    const child = await createTuneUp(request, {
      name: 'View Mode Check 25K', date: weeksBeforeToday(4), distanceMi: 15, gainFt: 900,
    })
    await openDashboard(page)

    // Browse the tune-up itself — canAddTuneUp used to compare the row
    // against useActiveRace().slug, which is null in BOTH generic mode and
    // this one (view mode), so the row vanished the instant anything but the
    // active race's own train-mode screen was on-screen.
    let menu = await openSwitcher(page)
    await menu.getByRole('menuitemradio', { name: /View Mode Check 25K/ }).click()
    await expect(menu).toBeHidden()

    menu = await openSwitcher(page)
    await expect(menu.getByRole('menuitem', { name: /Add tune-up…/ }), 'the row should survive browsing a tune-up in view mode')
      .toBeVisible()
    // Same root cause, same fix, in `archiveTarget` — it also went null the
    // instant anything but the active race's own screen was on-screen.
    await expect(menu.getByRole('menuitem', { name: /Archive with result…/ }), 'the archive row should survive browsing a tune-up in view mode too')
      .toBeVisible()

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
    await expect(page.getByText(/course\.gpx measures/i)).toBeVisible()

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
    const menu = await openSwitcher(page)
    await menu.getByRole('menuitem', { name: /Add tune-up…/ }).click()
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

    let menu = await openSwitcher(page)
    await menu.getByRole('menuitem', { name: /Add tune-up…/ }).click()
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
    menu = await openSwitcher(page)
    await menu.getByRole('menuitem', { name: /Add tune-up…/ }).click()
    dialog = page.getByRole('dialog', { name: 'add tune-up' })
    await expect(dialog.getByLabel('name')).toHaveValue('Carryover Check 50k')
    await expect(dialog.getByLabel('distance mi')).toHaveValue('31')
    await expect(dialog.getByLabel('gain ft')).toHaveValue('4200')

    await dialog.getByRole('button', { name: /close esc/i }).click()
    expect(trouble.pageErrors).toEqual([])
  })
})
