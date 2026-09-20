import fs from 'node:fs/promises'
import path from 'node:path'

import { test, expect, MM, openDashboard, openRaceTab, setActiveRace } from './basecamp'
import type { Page } from './basecamp'
import type { BrowserContext, TestInfo } from '@playwright/test'

/** "9:48p" / "12:11a+1" (fmtRaceClock's own format, day marker and all) →
    "21:48" / "00:11" — what the checkpoint form's HH:MM input wants. The day
    marker is dropped: the crew never writes the date, only the clock, and
    that is exactly what the updater's own day-resolution (bug 5) is for. */
function to24h(clock: string): string {
  const m = /^(\d{1,2}):(\d{2})(a|p)/i.exec(clock.trim())
  if (!m) throw new Error(`unparseable clock "${clock}"`)
  let hour = Number(m[1])
  const ap = m[3].toLowerCase()
  if (ap === 'p' && hour !== 12) hour += 12
  if (ap === 'a' && hour === 12) hour = 0
  return `${String(hour).padStart(2, '0')}:${m[2]}`
}

/** Export the crew page and open it exactly the way the crew will — from the
    filesystem, every network request refused — with the checkpoint form
    ready to drive. Shared by the bug 4/6 flows below and the offline-render
    flow above. */
async function exportAndOpenOffline(
  page: Page,
  context: BrowserContext,
  testInfo: TestInfo,
  label: string,
): Promise<Page> {
  await setActiveRace(page.request, MM.slug, 'train')
  await openDashboard(page)
  await openRaceTab(page)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /export crew page/i }).click(),
  ])
  await fs.mkdir(testInfo.outputDir, { recursive: true })
  const file = path.join(testInfo.outputDir, `${label}-${download.suggestedFilename()}`)
  await download.saveAs(file)

  const offline = await context.newPage()
  await offline.route('**/*', (route) => {
    const url = route.request().url()
    return /^https?:/.test(url) ? route.abort('failed') : route.continue()
  })
  await offline.goto(`file://${file}`)
  return offline
}

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

/**
 * Bug 4 — a refused checkpoint submit must leave whatever checkpoint is
 * already in force completely untouched: table, caption, clear button and
 * localStorage all keep showing the good one, and only the warning line
 * changes. The old bug threw the applied checkpoint away on ANY refusal
 * (station left on "choose a station…", an unparsable clock, "Start" picked)
 * — this drives the real form in a real browser, because the defect lived in
 * main.ts's DOM-handling, not in the pure checkpoint.ts logic.
 */
test('bug 4: a refused checkpoint submit leaves the applied checkpoint untouched', async ({ page, context, trouble }, testInfo) => {
  const offline = await exportAndOpenOffline(page, context, testInfo, 'bug4')

  // A real, successful checkpoint first — the exported plan's own ETA for
  // Slabtown, so it is guaranteed to be accepted.
  await offline.locator('#cp-station').selectOption('Slabtown')
  const slabtownEta = await offline.locator('tr[data-station="Slabtown"] .eta .exp').innerText()
  await offline.locator('#cp-clock').fill(to24h(slabtownEta))
  await offline.getByRole('button', { name: /update/i }).click()

  await expect(offline.locator('#cp-status')).toContainText('Slabtown')
  expect(await offline.locator('#cp-status').getAttribute('class')).toContain('applied')
  await expect(offline.locator('#cp-clear')).toBeEnabled()

  const tableBefore = await offline.locator('#stations tbody').innerHTML()
  const captionBefore = await offline.locator('#stations caption').innerText()
  const storageKey = 'basecamp.crew.mm-like-100.checkpoint'
  const storedBefore = await offline.evaluate((k) => localStorage.getItem(k), storageKey)
  expect(storedBefore).not.toBeNull()

  // Now refuse: blank the station and submit — the classic "cleared the
  // dropdown, forgot to re-pick it" mistake.
  await offline.locator('#cp-station').selectOption('')
  await offline.getByRole('button', { name: /update/i }).click()

  await expect(offline.locator('#cp-status')).toContainText(/pick the station/i)
  expect(await offline.locator('#cp-status').getAttribute('class')).not.toContain('applied')

  // Everything that was showing the GOOD checkpoint is exactly as it was —
  // the warning shows alone, next to a sheet that still works.
  expect(await offline.locator('#stations tbody').innerHTML()).toEqual(tableBefore)
  expect(await offline.locator('#stations caption').innerText()).toEqual(captionBefore)
  await expect(offline.locator('#cp-clear')).toBeEnabled()
  expect(await offline.evaluate((k) => localStorage.getItem(k), storageKey)).toEqual(storedBefore)

  await offline.close()
  expect(trouble.pageErrors).toEqual([])
})

/**
 * Bug 6 — a checkpoint upstream of an already-applied later one is refused,
 * naming the later station, rather than silently discarding the more recent
 * split. "clear" is the deliberate way to throw a checkpoint away.
 */
test('bug 6: an out-of-order checkpoint is refused and names the later station', async ({ page, context, trouble }, testInfo) => {
  const offline = await exportAndOpenOffline(page, context, testInfo, 'bug6')

  // Tin Cup is well downstream of Slabtown on the aid chart (mi 83.7 vs 44.6).
  await offline.locator('#cp-station').selectOption('Tin Cup')
  const tinCupEta = await offline.locator('tr[data-station="Tin Cup"] .eta .exp').innerText()
  await offline.locator('#cp-clock').fill(to24h(tinCupEta))
  await offline.getByRole('button', { name: /update/i }).click()
  await expect(offline.locator('#cp-status')).toContainText('Tin Cup')
  expect(await offline.locator('#cp-status').getAttribute('class')).toContain('applied')

  // Now try the UPSTREAM station.
  await offline.locator('#cp-station').selectOption('Slabtown')
  const slabtownEta = await offline.locator('tr[data-station="Slabtown"] .eta .exp').innerText()
  await offline.locator('#cp-clock').fill(to24h(slabtownEta))
  await offline.getByRole('button', { name: /update/i }).click()

  // Refused, naming the later (still-applied) station and pointing at clear.
  await expect(offline.locator('#cp-status')).toContainText('Tin Cup')
  await expect(offline.locator('#cp-status')).toContainText(/clear/i)
  expect(await offline.locator('#cp-status').getAttribute('class')).not.toContain('applied')

  // Tin Cup is still the checkpoint in force — its row is still "at".
  await expect(offline.locator('tr[data-station="Tin Cup"]')).toHaveClass(/\bat\b/)

  await offline.close()
  expect(trouble.pageErrors).toEqual([])
})
