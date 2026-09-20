import { test, expect, MM, openDashboard, setActiveRace } from './basecamp'

/**
 * v2 review ui1 #14 — a tune-up the quick form creates without a GPX has no
 * upload path afterward (AddTuneUp.tsx only takes a file at creation time),
 * so /course.json 404s for the rest of that folder's life. Chrome logs a
 * failed-resource message to the console for any non-2xx fetch response on
 * its own, regardless of how gracefully the JS handles it — the existing
 * `!r.ok`/404 branches in useCourse() were already graceful, and it logged
 * anyway, drowning real signal on every view.
 *
 * useCourse() (web/src/race/useRaceData.ts) now recognizes this ahead of
 * time via courseAvailability.ts's isKnownCourseless — race.kind === "b"
 * with no {kind:"gpx"} entry in race.sources, a signal already on the
 * active-race payload, not a new probe — and never issues the fetch at
 * all. The empty state ("no course data yet") still renders, from the same
 * `missing` flag, just without the network round trip that used to produce
 * the console noise.
 *
 * The tune-up is created here rather than as a committed fixture: nothing
 * under races/_fixtures/ is a "b" race yet, and POSTing with no `gpx` field
 * is the exact request AddTuneUp.tsx's quick form sends for this case.
 */
test('viewing a course-less tune-up makes no /course.json request and logs no console errors', async ({ page, request, trouble }) => {
  const created = await request.post('/api/races', {
    data: {
      name: 'Courseless Probe 10K',
      date: new Date().toISOString().slice(0, 10),
      distance_mi: 6.2,
      gain_ft: 400,
      parent_slug: MM.slug,
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const { slug } = await created.json()

  // Every request the page makes from here on — the exact fetch this bug is
  // about not making, not just its console-visible side effect.
  const requestedPaths: string[] = []
  page.on('request', (r) => { requestedPaths.push(new URL(r.url()).pathname) })

  await setActiveRace(request, slug, 'view')
  await openDashboard(page)
  await page.getByRole('tab', { name: /^race$/i }).click()

  // The empty state still renders — from the derived `missing` flag now,
  // not from a 404 response — proving the fix doesn't just hide a real
  // absence, it renders the same honest "nothing here" it always did.
  await expect(page.getByText(/no course data yet/i)).toBeVisible()

  // The direct proof: the fetch this bug is about never happens at all, not
  // just that its console-visible side effect is hidden.
  expect(requestedPaths, 'no /course.json request should have been made at all').not.toContain('/course.json')
  expect(trouble.httpErrors, 'no 4xx/5xx naming course.json').toEqual(
    trouble.httpErrors.filter((e) => !e.includes('/course.json')),
  )

  // Not a blanket "no console output": /nutrition.json is the exact same
  // bug's other half (useNutrition, in nutrition.ts — a different lane's
  // file, per the assignment) and still 404s today, so Chrome still logs its
  // own generic "Failed to load resource" line for it, with no filename in
  // the text to distinguish it from course.json's (checked by hand: as of
  // this fix, httpErrors is exactly `['404 /nutrition.json']` and
  // consoleErrors exactly one matching "Failed to load resource… 404"
  // line). Asserted tolerantly rather than as an exact list, so this test
  // doesn't need editing the day nutrition.ts's owner applies the same fix:
  // every httpError still standing must be /nutrition.json's, never
  // course.json's or anything unexpected.
  for (const e of trouble.httpErrors) {
    expect(e, `unexpected http error: ${e}`).toBe('404 /nutrition.json')
  }
  expect(trouble.pageErrors).toEqual([])
})
