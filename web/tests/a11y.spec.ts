import fs from 'node:fs/promises'
import path from 'node:path'

import {
  test, expect, CREWLESS, DRAFT, MM,
  openDashboard, openPrintable, openRaceTab, openRefreshFor, openReviewFor, openSwitcher,
  raceAction, setActiveRace,
  type Page,
} from './basecamp'

/**
 * Flow 7 — every dialog in the app, held to the same four promises.
 *
 * Round 1 found that NONE of them kept any of these: no `role="dialog"`, focus
 * left on `<body>` behind the overlay, Tab walking straight out into the page
 * underneath, and Escape doing nothing. Round 2 fixed five of six with the
 * shared `useDialog` hook (web/src/race/dialogChrome.ts) and explicitly left
 * the review dialog out because another fix was in flight; round 3 brought it
 * in. A regression here is one `{...dialogProps}` that stopped being spread,
 * which is exactly the kind of thing a refactor does silently.
 *
 * So the check is uniform and applies to every dialog, rather than each spec
 * asserting whatever its own dialog happens to do:
 *
 *   1. role="dialog" and aria-modal="true"
 *   2. a non-empty accessible name (aria-label, or aria-labelledby a heading)
 *   3. focus moves INTO the dialog when it opens
 *   4. Tab and Shift+Tab cycle inside it and never escape
 *   5. Escape closes it, and focus goes back to whatever opened it
 *
 * All nine dialogs are covered: the three printable cards, the crew sheet,
 * coach settings, the review and new-race screens, refresh from sources,
 * archive with result, and the tune-up quick form.
 */

/** dialogChrome.ts's own FOCUSABLE selector. Kept identical on purpose: a
    trap that disagrees with the hook about what is focusable is not a trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

type FocusReport = { tag: string; label: string; inDialog: boolean }

/** Where focus is, and whether it is inside the open dialog. */
async function focusNow(page: Page): Promise<FocusReport | null> {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    if (!a) return null
    const d = document.querySelector('[role="dialog"]')
    return {
      tag: a.tagName,
      label: (a.getAttribute('aria-label') || a.innerText || (a as HTMLInputElement).value || '').trim().slice(0, 60),
      inDialog: d ? d.contains(a) : false,
    }
  })
}

/** Put focus on the dialog's first or last focusable control. */
async function focusEdge(page: Page, edge: 'first' | 'last', focusable: string) {
  await page.evaluate(
    ([which, sel]) => {
      const d = document.querySelector('[role="dialog"]')!
      const nodes = [...d.querySelectorAll<HTMLElement>(sel)].filter((n) => n.offsetParent !== null)
      ;(which === 'first' ? nodes[0] : nodes[nodes.length - 1]).focus()
    },
    [edge, focusable] as const,
  )
}

/**
 * The whole contract, against whichever dialog is currently open.
 *
 * @param name the accessible name the dialog is expected to carry
 * @param restoresFocus whether the element that opened it still exists to
 *   receive focus back. A dialog opened from a switcher ROW cannot restore
 *   focus to it — the menu unmounts when the dialog opens, and a detached
 *   node's .focus() is a no-op. Since the per-race actions moved onto the
 *   topline strip (App.tsx's RaceTopline), that is only "New race…": every
 *   other dialog is now opened from a button that stays on screen behind the
 *   overlay, and is held to focus restoration.
 */
async function assertDialogContract(page: Page, name: string, { restoresFocus = false } = {}) {
  const dialog = page.getByRole('dialog', { name })
  await expect(dialog, `no dialog named "${name}" is open`).toBeVisible()

  // 1 + 2 — the attributes a screen reader needs to announce it as a modal.
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  const accessibleName = await dialog.evaluate((d) => {
    const byId = d.getAttribute('aria-labelledby')
    return d.getAttribute('aria-label') ?? (byId ? document.getElementById(byId)?.innerText ?? '' : '')
  })
  expect(accessibleName.trim(), `the dialog's accessible name is empty`).not.toBe('')

  // 3 — focus moved in. A dialog that leaves focus on <body> is one the
  // keyboard never reaches and the screen reader never enters.
  const onOpen = await focusNow(page)
  expect(onOpen?.inDialog, `focus stayed outside "${name}" on open (on ${onOpen?.tag} "${onOpen?.label}")`).toBe(true)

  const count = await dialog.evaluate((d, sel) => d.querySelectorAll(sel).length, FOCUSABLE)
  expect(count, `"${name}" has no focusable controls at all`).toBeGreaterThan(0)

  // 4 — Tab from the last control wraps to the first, Shift+Tab from the
  // first wraps to the last, and a long walk never leaves.
  await focusEdge(page, 'last', FOCUSABLE)
  await page.keyboard.press('Tab')
  expect((await focusNow(page))?.inDialog, `Tab from the last control escaped "${name}"`).toBe(true)

  await focusEdge(page, 'first', FOCUSABLE)
  await page.keyboard.press('Shift+Tab')
  expect((await focusNow(page))?.inDialog, `Shift+Tab from the first control escaped "${name}"`).toBe(true)

  await focusEdge(page, 'first', FOCUSABLE)
  const escaped: string[] = []
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab')
    const where = await focusNow(page)
    if (where && !where.inDialog) escaped.push(`${where.tag} "${where.label}"`)
  }
  expect(escaped, `Tab walked out of "${name}" ${escaped.length}/15 times`).toEqual([])

  // 5 — Escape closes, and the opener gets focus back. `useDialog` captures
  // whatever had focus when the dialog mounted and refocuses it on unmount, so
  // a keyboard user lands back on the control they pressed — not on <body>,
  // which is where a Tab would then restart from the top of the page.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  if (restoresFocus) {
    const after = await focusNow(page)
    expect(after?.tag, `Escape left focus on ${after?.tag} instead of the button that opened "${name}"`).toBe('BUTTON')
    expect(after?.inDialog, 'focus came back to something still inside the closed dialog').toBe(false)
  }
}

test.describe('dialog accessibility', () => {
  test.beforeEach(async ({ page, request }) => {
    await setActiveRace(request, MM.slug, 'train')
    await openDashboard(page)
  })

  test('the printable cards and the crew sheet', async ({ page, trouble }) => {
    await openRaceTab(page)
    const docs: [RegExp, string][] = [
      [/runner card 3×5/i, `${MM.name} — runner card`],
      [/fuel card 3×5/i, `${MM.name} — fuel card`],
      [/drop bags 3×5/i, `${MM.name} — drop bag card`],
      [/crew sheet pdf/i, `${MM.name} — crew sheet`],
    ]
    for (const [button, name] of docs) {
      await openPrintable(page, button, name)
      // These are opened from a chip that stays on screen behind the overlay,
      // so this is the group that can be held to focus restoration.
      await assertDialogContract(page, name, { restoresFocus: true })
    }
    expect(trouble.pageErrors).toEqual([])
  })

  test('coach settings', async ({ page, trouble }) => {
    await page.getByRole('button', { name: /settings/i }).click()
    await assertDialogContract(page, 'coach settings', { restoresFocus: true })
    expect(trouble.pageErrors).toEqual([])
  })

  test('the review dialog — the one that was left out of round 2', async ({ page, trouble }) => {
    await openReviewFor(page, DRAFT.name)
    // Opened from the topline strip's own button, which stays on screen —
    // so this one is held to focus restoration now too.
    await assertDialogContract(page, 'review · race', { restoresFocus: true })
    expect(trouble.pageErrors).toEqual([])
  })

  test('the new race dialog', async ({ page, trouble }) => {
    const menu = await openSwitcher(page)
    // Not anchored: a switcher row's accessible name is its label AND its
    // hint line ("build a race folder from its website"), both inside the
    // same <button>.
    await menu.getByRole('menuitem', { name: /New race…/ }).click()
    await assertDialogContract(page, 'new race')
    expect(trouble.pageErrors).toEqual([])
  })

  test('refresh from sources', async ({ page, trouble }) => {
    await openRefreshFor(page, CREWLESS.name)
    await assertDialogContract(page, `refresh from sources · ${CREWLESS.name}`, { restoresFocus: true })
    expect(trouble.pageErrors).toEqual([])
  })

  test('archive with result', async ({ page, trouble }) => {
    // Opened, walked and closed with Escape — never submitted. Archiving the
    // 100-miler would retire the race every other spec runs against.
    await raceAction(page, /Archive with result…/).click()
    await assertDialogContract(page, 'archive with result', { restoresFocus: true })
    expect(trouble.pageErrors).toEqual([])
  })

  test('the tune-up quick form', async ({ page, trouble }) => {
    // Only the race being trained for carries this action, which is why the
    // beforeEach above points at the 100-miler.
    await raceAction(page, /Add tune-up…/).click()
    // Named through aria-labelledby (its header), not aria-label — the other
    // half of the contract `useDialog` offers, and the half nothing else here
    // exercises except the refresh dialog.
    await assertDialogContract(page, 'add tune-up', { restoresFocus: true })
    expect(trouble.pageErrors).toEqual([])
  })
})

/**
 * Round 4 confirm, PARTIAL #12 — the TRAINING/RACE/FUEL nav got
 * `role="tablist"`/`role="tab"` (round 3, resilience finding 12) but none of
 * the keyboard contract that role promises: both tabs carried `tabindex=0`,
 * ArrowLeft/Right/Home/End moved nothing, and there was no `aria-controls`/
 * `role="tabpanel"` pair. A screen reader announces "tab list, tab 1 of 3"
 * and a keyboard user reaches for the arrow keys — this is what they should
 * find now: roving tabindex, arrow keys that wrap and activate (this app's
 * choice of automatic activation — Home/End too), and aria-controls naming
 * a real, currently-rendered tabpanel.
 */
test.describe('view tablist', () => {
  test.beforeEach(async ({ request }) => {
    // A race active throughout: "race" and "fuel" only exist with one.
    await setActiveRace(request, MM.slug, 'train')
  })

  test('roving tabindex, arrow/Home/End move focus and activate, aria-controls names a live tabpanel', async ({ page, trouble }) => {
    await openDashboard(page)

    const training = page.getByRole('tab', { name: /^training$/i })
    const race = page.getByRole('tab', { name: /^race$/i })
    const fuel = page.getByRole('tab', { name: /^fuel$/i })
    await expect(page.getByRole('tablist', { name: 'view' }).getByRole('tab')).toHaveCount(3)

    // Only the selected tab sits in the page's Tab order — the other two are
    // reachable by arrow key, not by Tab, per the roving-tabindex pattern.
    await expect(training).toHaveAttribute('tabindex', '0')
    await expect(race).toHaveAttribute('tabindex', '-1')
    await expect(fuel).toHaveAttribute('tabindex', '-1')

    await training.focus()
    await page.keyboard.press('ArrowRight')
    await expect(race).toBeFocused()
    await expect(race).toHaveAttribute('aria-selected', 'true')
    await expect(training).toHaveAttribute('tabindex', '-1')
    await expect(race).toHaveAttribute('tabindex', '0')
    // Moving focus also activates (this app's chosen, consistent model) —
    // the view actually switched, not just the visual selection.
    await expect(page.getByText(/climb readiness — you vs/i)).toBeVisible()

    await page.keyboard.press('ArrowRight')
    await expect(fuel).toBeFocused()
    await expect(fuel).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText(/^nutrition plan$/i).first()).toBeVisible()

    // Wraps forward past the last tab…
    await page.keyboard.press('ArrowRight')
    await expect(training).toBeFocused()
    await expect(training).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText(/vitals — load × recovery/i)).toBeVisible()

    // …and backward past the first.
    await page.keyboard.press('ArrowLeft')
    await expect(fuel).toBeFocused()
    await expect(fuel).toHaveAttribute('aria-selected', 'true')

    // Home / End jump straight to the ends.
    await page.keyboard.press('Home')
    await expect(training).toBeFocused()
    await expect(training).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('End')
    await expect(fuel).toBeFocused()
    await expect(fuel).toHaveAttribute('aria-selected', 'true')

    // aria-controls names a role="tabpanel" that actually exists right now
    // and is labelled by the tab that's currently selected — not a promise
    // pointing at nothing.
    const controlsId = await fuel.getAttribute('aria-controls')
    expect(controlsId, 'the selected tab has no aria-controls').toBeTruthy()
    const panel = page.locator(`#${controlsId}`)
    await expect(panel).toHaveAttribute('role', 'tabpanel')
    const fuelTabId = await fuel.getAttribute('id')
    await expect(panel).toHaveAttribute('aria-labelledby', fuelTabId ?? '')

    // Round 5 confirm, finding 2 — AppBody renders exactly one tabpanel at a
    // time (the active view's), so the other two, non-selected tabs must NOT
    // carry an aria-controls naming an id that is not in the DOM. Checked
    // here with fuel selected: training/race are the non-selected ones.
    expect(await training.getAttribute('aria-controls'), 'a non-selected tab must not point at a nonexistent tabpanel').toBeNull()
    expect(await race.getAttribute('aria-controls'), 'a non-selected tab must not point at a nonexistent tabpanel').toBeNull()

    // Enter/Space on a Tab-reached tab still work — these stay native
    // <button>s, so this was already true and must stay true.
    await page.keyboard.press('Home')
    await expect(training).toBeFocused()
    await race.focus()
    await page.keyboard.press('Enter')
    await expect(race).toHaveAttribute('aria-selected', 'true')

    expect(trouble.pageErrors).toEqual([])
  })

  /**
   * Round 5 confirm, finding 3 — `views` can shrink out from under the
   * currently focused tab (FUEL disappears the instant the active race
   * becomes a tune-up with no nutrition.json, `fuelViewHidden`) with no view
   * change initiated by the user themselves — a background refresh landing
   * mid-poll is exactly this case. React unmounts that tab's <button>, and
   * per standard DOM behavior a focused element being removed silently drops
   * focus to <body> with no recovery. `/api/race/active` is intercepted so a
   * "resync" (a real user action, but one that does not itself touch DOM
   * focus — `HTMLElement.click()` fires the click handler without moving
   * focus the way a real pointer click would) is what flips fuel off, so the
   * only thing that ever touches the FUEL tab's focus is the shrink itself.
   *
   * `/api/refresh` is intercepted and aborted rather than let through: it is
   * the dashboard's real "resync everything" endpoint, which spawns the
   * genuine sync-strava.mjs/sync-oura.mjs/sync-google-cal.mjs/coach.mjs
   * scripts against real external services and real machine-level
   * credentials (`~/.config/strava-mcp/config.json`) — TRAIL_FAKE_AGENT only
   * short-circuits the coach step's own CLI spawn, not the sync scripts.
   * RefreshProvider's `refresh()` bumps its `key` (which is all `views`
   * actually needs re-fetched) in a `finally`, which runs whether the fetch
   * resolved or was aborted, so aborting it gets the exact same client-side
   * effect with no real network call ever leaving the browser.
   */
  test('focus moves to the selected tab, not <body>, when the focused tab disappears out from under it', async ({ page, trouble }) => {
    let corrupt = false
    await page.route('**/api/race/active*', async (route) => {
      const response = await route.fetch()
      const data = await response.json()
      if (corrupt && data?.race) {
        data.race = { ...data.race, kind: 'b' }
        data.nutrition = null
      }
      await route.fulfill({ response, json: data })
    })
    await page.route('**/api/refresh', (route) => route.abort('failed'))

    await openDashboard(page)
    const fuel = page.getByRole('tab', { name: /^fuel$/i })
    await fuel.click()
    await expect(fuel).toBeFocused()
    await expect(fuel).toHaveAttribute('aria-selected', 'true')

    // Flip the served payload, then trigger the SAME refresh pulse a
    // background poll would — via a programmatic click, which (unlike a
    // real pointer click) does not itself move DOM focus off the fuel tab.
    corrupt = true
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /resync|syncing/i.test(b.textContent ?? ''))
      btn?.click()
    })

    await expect(fuel).toHaveCount(0)
    // The tablist fell back to training (the first view still offered) —
    // and focus followed it there instead of the tab vanishing into <body>.
    const training = page.getByRole('tab', { name: /^training$/i })
    await expect(training).toHaveAttribute('aria-selected', 'true')
    await expect(training).toBeFocused()
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false)

    expect(trouble.pageErrors).toEqual([])
  })

  /**
   * Round 6 confirm, finding 2 — the finding-3 fix above tracked "the last
   * tab that was EVER focused," not "the tab CURRENTLY focused": `onFocus`
   * set `focusedTabRef` but nothing ever cleared it, so once a tab was
   * focused even once, the recovery effect would keep firing for it forever
   * — including long after the user tabbed away to something else entirely.
   * A keyboard user who focuses FUEL, then deliberately Tabs off the
   * tablist into unrelated chrome (here, the "coach" rail-toggle button),
   * must not have focus yanked back to the tablist when a later,
   * unconnected event (the same corrupt-payload + resync pulse the test
   * above uses) shrinks `views` out from under the tab they left behind.
   */
  test('tabbing away from a tab first means a later shrink does not steal focus back', async ({ page, trouble }) => {
    let corrupt = false
    await page.route('**/api/race/active*', async (route) => {
      const response = await route.fetch()
      const data = await response.json()
      if (corrupt && data?.race) {
        data.race = { ...data.race, kind: 'b' }
        data.nutrition = null
      }
      await route.fulfill({ response, json: data })
    })
    await page.route('**/api/refresh', (route) => route.abort('failed'))

    await openDashboard(page)
    const fuel = page.getByRole('tab', { name: /^fuel$/i })
    await fuel.click()
    await expect(fuel).toBeFocused()

    // A real, deliberate keyboard move OFF the tablist entirely — not the
    // roving-tabindex ArrowRight/Left the other test in this file drives.
    await page.keyboard.press('Tab')
    const coachRail = page.getByRole('button', { name: 'coach', exact: true })
    await expect(coachRail).toBeFocused()

    // Same trigger as the test above: flips the payload, then fires the
    // refresh pulse via a programmatic click (no DOM focus side effect of
    // its own) so the only thing that could move focus is the shrink.
    corrupt = true
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /resync|syncing/i.test(b.textContent ?? ''))
      btn?.click()
    })

    await expect(fuel).toHaveCount(0)
    // Focus is exactly where the user left it — not on the now-selected
    // training tab, and not dropped to <body> either.
    await expect(coachRail).toBeFocused()
    const training = page.getByRole('tab', { name: /^training$/i })
    await expect(training).toHaveAttribute('aria-selected', 'true')
    await expect(training).not.toBeFocused()

    expect(trouble.pageErrors).toEqual([])
  })
})

/**
 * Round 5 follow-up (harness) — the finding-3 exposure above must be
 * structurally impossible, not just avoided by every test remembering to
 * intercept `/api/refresh`. `web/tests/launch.mjs` now sets
 * `TRAIL_FAKE_SYNC=1` unconditionally for every server this suite starts
 * (with a fail-loud assertion if it somehow didn't get set), and
 * `vite.config.ts`'s refresh route reads it the same way it already reads
 * `TRAIL_FAKE_AGENT` for the coach step: the four sync steps become a no-op
 * that still emits the same SSE `step` start/done events, while `coach`
 * keeps running for real (staying safe via its own, pre-existing
 * `TRAIL_FAKE_AGENT` check inside `scripts/agent-run.mjs`).
 *
 * This is the one test in the suite that deliberately does NOT intercept
 * `/api/refresh` — that is the point: it hits the real endpoint, for real,
 * and checks both halves of the guarantee — the SSE stream shows the fake
 * path (never a real script's own output), and the sync scripts' actual
 * output file is byte-for-byte untouched.
 */
test('the real resync endpoint never spawns real syncs under the test harness', async ({ page, trouble }) => {
  await openDashboard(page)

  const root = process.env.TRAIL_TEST_PROJECT_ROOT
  if (!root) throw new Error('TRAIL_TEST_PROJECT_ROOT is unset — global setup did not run')
  const stravaPath = path.join(root, 'web', 'public', 'strava.json')
  const before = await fs.readFile(stravaPath, 'utf8')

  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/refresh') && r.request().method() === 'POST'),
    page.getByRole('button', { name: /resync/i }).click(),
  ])
  const body = await resp.text()

  // Every faked step's own SSE log line says so, in the same event shape a
  // real script's stdout line would have used — never left silently blank.
  for (const id of ['strava', 'streams', 'oura', 'gcal']) {
    expect(body, `step "${id}" did not report TRAIL_FAKE_SYNC on the SSE stream`).toMatch(
      new RegExp(`"id":"${id}"[^}]*"line":"\\[refresh\\] TRAIL_FAKE_SYNC`),
    )
  }
  // coach is NOT faked here — it ran (safely, via its own TRAIL_FAKE_AGENT
  // seam) rather than being silently dropped from the step sequence.
  expect(body).toContain('"id":"coach"')

  await expect(page.getByRole('button', { name: /resync/i })).not.toHaveText(/syncing/i)

  const after = await fs.readFile(stravaPath, 'utf8')
  expect(after, 'a real sync script touched its output file — TRAIL_FAKE_SYNC did not hold').toEqual(before)

  expect(trouble.pageErrors).toEqual([])
})
