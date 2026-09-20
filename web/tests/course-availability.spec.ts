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
 * useCourse() (web/src/race/useRaceData.ts) recognizes this ahead of time via
 * courseAvailability.ts's isKnownCourseless — race.kind === "b" with no
 * {kind:"gpx"} entry in race.sources, a signal already on the active-race
 * payload, not a new probe — and never issues the fetch at all. The empty
 * state ("no course data yet") still renders, from the same `missing` flag,
 * just without the network round trip that used to produce the console
 * noise.
 *
 * /nutrition.json is the same bug's other half (useNutrition, in
 * nutrition.ts): a quick-form tune-up never gets a nutrition.json either —
 * PRD-v2 §3's reduced planner hides fuel entirely for one — so it 404'd on
 * every view too. useNutrition() now checks the same isKnownCourseless
 * signal and skips that fetch as well.
 *
 * The tune-up is created here rather than as a committed fixture: nothing
 * under races/_fixtures/ is a "b" race yet, and POSTing with no `gpx` field
 * is the exact request AddTuneUp.tsx's quick form sends for this case.
 */
test('viewing a course-less tune-up makes no /course.json or /nutrition.json request, and logs no console errors', async ({ page, request, trouble }) => {
  const created = await request.post('/api/races', {
    data: {
      name: 'No Course Yet 10K',
      date: new Date().toISOString().slice(0, 10),
      distance_mi: 6.2,
      gain_ft: 400,
      parent_slug: MM.slug,
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const { slug } = await created.json()

  // Every request the page makes from here on — the exact fetches this bug
  // is about not making, not just their console-visible side effects.
  const requestedPaths: string[] = []
  page.on('request', (r) => { requestedPaths.push(new URL(r.url()).pathname) })

  await setActiveRace(request, slug, 'view')
  await openDashboard(page)
  // training/race/fuel is a role="tablist" of role="tab" buttons (round 3,
  // resilience finding 12), not plain buttons.
  await page.getByRole('tab', { name: /^race$/i }).click()

  // The empty state still renders — from the derived `missing` flag now,
  // not from a 404 response — proving the fix doesn't just hide a real
  // absence, it renders the same honest "nothing here" it always did.
  await expect(page.getByText(/no course data yet/i)).toBeVisible()

  // The direct proof: neither fetch this bug is about ever happens at all,
  // not just that its console-visible side effect is hidden.
  expect(requestedPaths, 'no /course.json request should have been made at all').not.toContain('/course.json')
  expect(requestedPaths, 'no /nutrition.json request should have been made at all').not.toContain('/nutrition.json')
  expect(trouble.httpErrors, 'no 4xx/5xx naming course.json or nutrition.json').toEqual(
    trouble.httpErrors.filter((e) => !e.includes('/course.json') && !e.includes('/nutrition.json')),
  )
  expect(trouble.pageErrors).toEqual([])
})
