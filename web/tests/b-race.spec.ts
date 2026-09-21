import { test, expect, MM, openDashboard, openSwitcher, raceAction, setActiveRace } from './basecamp'

/**
 * Flow 10 — the tune-up quick form (PRD-v2 §3).
 *
 * A B race is a date on the trajectory and a distance to pace, not a folder
 * anybody needs read off a race website. So the form is five typed fields and
 * a POST to /api/races — no intake, no website, and above all no agent turn.
 * That last part is the claim worth testing from the browser: the form's own
 * hint says "free, no agent turn", and the only way to know it is true is to
 * watch what the page asks the server for.
 *
 * It is also the one spec that adds a race folder to the shared project root.
 * Everything downstream of it sees the tune-up — which is the point, since the
 * switcher grouping is half of what is being asserted — and nothing else in
 * the suite asserts on a race count.
 */

/** Six weeks before the A race, which is always dated today. */
function weeksBeforeToday(weeks: number): string {
  const d = new Date()
  d.setDate(d.getDate() - weeks * 7)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

const TUNE_UP = { name: 'Dust Devil 25K', distanceMi: '15.6', gainFt: '2100', weeksOut: 6 }

test('the quick form adds a tune-up inside the A race\'s block, with no agent turn', async ({ page, request, trouble }) => {
  await setActiveRace(request, MM.slug, 'train')
  await openDashboard(page)

  // Every request the page makes from here on, so "no agent turn" can be
  // asserted rather than assumed. The intake and refresh endpoints are the
  // ones that spend; /api/races is the free one.
  const posts: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST') posts.push(new URL(r.url()).pathname)
  })

  // Only the race being TRAINED for is offered this action — `canAddTuneUp`
  // in App.tsx. A draft or an archive has no live block for a tune-up to sit
  // in. It is on the topline strip now (RaceTopline), about the race loaded,
  // rather than an indented row inside that race's menu block.
  await raceAction(page, /Add tune-up…/).click()

  const dialog = page.getByRole('dialog', { name: 'add tune-up' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(new RegExp(`A tune-up inside ${MM.name}`, 'i'))).toBeVisible()

  await dialog.getByLabel('name').fill(TUNE_UP.name)
  await dialog.getByLabel('date').fill(weeksBeforeToday(TUNE_UP.weeksOut))
  await dialog.getByLabel('distance mi').fill(TUNE_UP.distanceMi)
  await dialog.getByLabel('gain ft').fill(TUNE_UP.gainFt)

  // The form says where the date lands in the block before anything is
  // written — the same week count the trajectory marker and the coach use.
  await expect(dialog.getByText(new RegExp(`${TUNE_UP.weeksOut} weeks out from ${MM.name}`, 'i'))).toBeVisible()

  // Left blank, the zone is the parent's — stated on screen, not silently.
  await expect(dialog.getByText(/it inherits America\/Denver from mm-like-100/i)).toBeVisible()

  const submit = dialog.getByRole('button', { name: /^add tune-up$/i })
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(dialog).toBeHidden()

  // One POST, to the free endpoint. Nothing touched /api/race-intake.
  expect(posts, 'the quick form should POST /api/races and nothing else').toEqual(['/api/races'])

  // The server's own answer: a "b" race, pointed at its parent.
  const listed = await (await request.get('/api/races?t=1')).json()
  const parent = listed.groups.find((g: { slug: string }) => g.slug === MM.slug)
  expect(parent, 'the A race should still head its own group').toBeTruthy()
  const child = parent.b_races.find((b: { name: string }) => b.name === TUNE_UP.name)
  expect(child, `${TUNE_UP.name} is not grouped under ${MM.slug}`).toBeTruthy()

  const created = await (await request.get(`/api/races/${child.slug}?t=1`)).json()
  expect(created.race.kind).toBe('b')
  expect(created.race.parent_slug).toBe(MM.slug)
  expect(created.race.timezone, 'the zone should be inherited, not invented').toBe('America/Denver')
  // A tune-up's crew, drop-bag, pacer and night flags default OFF: a 25K in
  // the middle of a block is not a hundred with a crew plan.
  expect(created.race.features?.crew ?? false).toBe(false)

  // Adding it must not move what is being trained for — a tune-up is trained
  // THROUGH, and the block stays pointed at the hundred.
  const active = await (await request.get('/api/race/active?t=1')).json()
  expect(active.active).toBe(MM.slug)

  // The block's own view of it: the week count the coach prompt and the
  // trajectory marker both read, derived server-side from the two dates
  // rather than taken from the form's advisory hint.
  const inBlock = active.b_races.find((b: { name: string }) => b.name === TUNE_UP.name)
  expect(inBlock, `${TUNE_UP.name} is missing from the active race's b_races`).toBeTruthy()
  expect(inBlock.weeks_out).toBe(TUNE_UP.weeksOut)
  expect(inBlock.distance_mi).toBeCloseTo(Number(TUNE_UP.distanceMi), 2)

  // …and it shows up in the switcher, indented under its parent rather than
  // as a sibling of it.
  const reopened = await openSwitcher(page)
  await expect(reopened.getByRole('menuitemradio', { name: new RegExp(TUNE_UP.name) })).toBeVisible()

  expect(trouble.pageErrors).toEqual([])
})
