import fs from 'node:fs/promises'
import path from 'node:path'

import { test, expect, MM, openDashboard, openRaceTab, setActiveRace } from './basecamp'

/**
 * Flow 11 — "export crew page", and the only thing that actually matters about
 * it: the file works with no network at all.
 *
 * The crew page is AirDropped to somebody who will open it in a trailhead
 * parking lot with one bar of signal, hours after the laptop that made it went
 * home. So it is built as a second Vite entry inlined to a single file — no
 * script tags, no stylesheet links, no fonts, no `/course.json` fetch. That
 * promise is impossible to check by reading the HTML (an inlined bundle is one
 * enormous line) and trivial to check by opening the file with every network
 * request aborted and seeing whether the ETAs are on screen.
 *
 * The export also has to agree with the planner it was taken from — the knobs
 * on screen go in the POST body, because a crew sheet whose ETAs disagree with
 * the plan the athlete just looked at is worse than no crew sheet, since both
 * look authoritative. That is asserted through the UI here: the button is
 * pressed, and the file that comes back is the one that gets opened.
 */

test('the exported crew page opens with the network gone', async ({ page, context, trouble }, testInfo) => {
  await setActiveRace(page.request, MM.slug, 'train')
  await openDashboard(page)
  await openRaceTab(page)

  // The real button, not a hand-rolled POST: this is the path that decides
  // which knobs the server renders against.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /export crew page/i }).click(),
  ])

  // Named after the race-local date, which is what makes a second export a
  // second file rather than a silent overwrite.
  expect(download.suggestedFilename()).toMatch(/^crew-\d{4}-\d{2}-\d{2}\.html$/)

  const file = path.join(testInfo.outputDir, download.suggestedFilename())
  await fs.mkdir(testInfo.outputDir, { recursive: true })
  await download.saveAs(file)
  const html = await fs.readFile(file, 'utf8')

  // One file, self-contained: no external script, stylesheet, font or image.
  // (A data: URI is inline, which is the whole point, so it does not count.)
  const externalRefs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((ref) => !ref.startsWith('data:') && !ref.startsWith('#'))
    .filter((ref) => /^(https?:)?\/\//.test(ref) || ref.startsWith('/'))
  expect(externalRefs, 'the crew page references files it will not have offline').toEqual([])

  // Now open it the way the crew will: from the filesystem, with every network
  // request refused. Anything the page still tries to fetch shows up in
  // `attempted` and fails the test by name rather than as a blank page.
  const attempted: string[] = []
  const offline = await context.newPage()
  await offline.route('**/*', (route) => {
    const url = route.request().url()
    if (/^https?:/.test(url)) {
      attempted.push(url)
      return route.abort('failed')
    }
    return route.continue()
  })
  const crashes: string[] = []
  offline.on('pageerror', (e) => crashes.push(e.message))

  await offline.goto(`file://${file}`)

  // The sheet is really rendered — not an empty shell waiting on a fetch.
  await expect(offline.getByText(new RegExp(MM.name, 'i')).first()).toBeVisible()
  const text = await offline.locator('body').innerText()
  for (const station of ['Slabtown', 'Tin Cup', 'Bitterroot Bowl']) {
    expect(text, `the crew page is missing ${station}`).toContain(station)
  }
  // An ETA, in the crew page's own clock format — the numbers the crew drives
  // to, and the thing that would be blank if it needed the course at run time.
  expect(text, 'the crew page has no ETAs on it').toMatch(/\d{1,2}:\d{2}[ap]/)

  expect(attempted, 'the crew page tried to reach the network').toEqual([])
  expect(crashes, 'the crew page threw with no network').toEqual([])
  await offline.close()

  expect(trouble.pageErrors).toEqual([])
})
