import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test'

/**
 * The suite's `test`: the real one plus the two things every Basecamp flow
 * needs — the run-time baseURL, and a running tally of everything the page
 * complained about.
 */

export type ConsoleTrouble = {
  /** Uncaught exceptions. Always a failure: React white-screens on these. */
  pageErrors: string[]
  /** console.error / console.warn text. */
  consoleErrors: string[]
  /** Responses the page got back with a 4xx/5xx, as "404 /course.json". */
  httpErrors: string[]
  /** Everything above, flattened — what an assertion usually wants. */
  all(): string[]
}

export const test = base.extend<{ trouble: ConsoleTrouble }>({
  // Global setup picks a free port at run time, so the config's own baseURL is
  // a placeholder — see tests/setup/global-setup.ts.
  baseURL: async ({}, use) => {
    const url = process.env.TRAIL_TEST_BASE_URL
    if (!url) throw new Error('TRAIL_TEST_BASE_URL is unset — global setup did not run')
    await use(url)
  },

  // Auto-used: a spec that forgets to look at it still gets the listeners
  // attached, so a failure screenshot is taken with the errors already
  // recorded rather than after the page has moved on.
  trouble: [async ({ page }, use) => {
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    const httpErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`)
    })
    page.on('response', (r) => {
      if (r.status() >= 400) {
        // strip the cache-buster so N reloads are one line, not N
        httpErrors.push(`${r.status()} ${new URL(r.url()).pathname}`)
      }
    })
    await use({
      pageErrors,
      consoleErrors,
      httpErrors,
      all: () => [...new Set([...pageErrors, ...consoleErrors, ...httpErrors])],
    })
  }, { auto: true }],
})

export { expect }
export type { Page }

/* ------------------------------------------------------------------ */
/*  Fixture facts the specs assert against                             */
/* ------------------------------------------------------------------ */

/** races/_fixtures/mm-like-100 — the 100-miler, always dated today. */
export const MM = { slug: 'mm-like-100', name: 'Mesa Monster 100', short: 'MM100F' }
/** races/_fixtures/unresolved-draft-50k — the draft the review dialog opens. */
export const DRAFT = { slug: 'unresolved-draft-50k', name: 'Nine Mile Flat 50K', short: 'NMF50K' }
/** races/_fixtures/rimrock-50k — archived, with a result.json. */
export const ARCHIVED = { slug: 'rimrock-50k', name: 'Rimrock Ramble 50K', short: 'RR50K' }
/** races/_fixtures/crewless-50k — the crewless draft the refresh spec re-reads.
    It is the one folder the suite is allowed to REWRITE (refresh + accept), so
    nothing else may assert on its contents. */
export const CREWLESS = { slug: 'crewless-50k', name: 'Dry Wash 50K', short: 'DW50K' }

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Park the active-race pointer where a spec needs it, before the page loads.
 *
 * Specs share one project root (one server, one temp directory), so each one
 * states the pointer it wants rather than inheriting whatever the last spec
 * left. Goes through the same endpoint the switcher uses, so the file is
 * written by the code under test.
 *
 * @param mode "train" for the active race, "view" for a read-only draft or
 *   archived folder — the same rule App.tsx's `modeFor(status)` applies.
 */
export async function setActiveRace(
  request: APIRequestContext,
  slug: string | null,
  mode: 'train' | 'view' = 'train',
): Promise<void> {
  const res = await request.post('/api/race/activate', { data: { slug, mode } })
  if (!res.ok()) throw new Error(`activate ${slug}: HTTP ${res.status()} ${await res.text()}`)
}

/** Load the dashboard and wait until it has actually painted its panels. */
export async function openDashboard(page: Page): Promise<void> {
  await page.goto('/')
  // The vitals panel is the first thing that needs BOTH /api/race/active and
  // /strava.json, so it standing on screen means the fetch chain has settled —
  // a far better signal than a fixed sleep or `networkidle` (the dashboard
  // polls, so networkidle can simply never arrive).
  await expect(page.getByText(/vitals — load × recovery/i)).toBeVisible()
}

/** The race switcher's trigger — the only `aria-haspopup="menu"` on the page. */
export const switcherButton = (page: Page) => page.locator('button[aria-haspopup="menu"]')

/** Open the race switcher and wait for its menu. */
export async function openSwitcher(page: Page) {
  const menu = page.getByRole('menu', { name: 'race' })
  await switcherButton(page).click()
  await expect(menu).toBeVisible()
  return menu
}

/**
 * Pick a race (or "No race (generic)") out of the open switcher.
 *
 * `getByRole('button')` finds nothing here: the rows are `<button>` elements
 * with an explicit `role="menuitemradio"`, and an explicit role replaces the
 * implicit one. The sub-rows under each race ("↳ Review…", "↳ Refresh from
 * sources…") are plain `menuitem`s, which is what keeps this from matching
 * them.
 *
 * Then waits for the menu to leave the DOM — AnimatePresence unmounts it
 * asynchronously, and a second click landing while it is still there hits a
 * row that is on its way out.
 */
export async function chooseRace(page: Page, name: string | RegExp) {
  const menu = page.getByRole('menu', { name: 'race' })
  await menu.getByRole('menuitemradio', { name }).first().click()
  await expect(menu).toBeHidden()
}

/**
 * Click the "↳ Review…" row that belongs to one race.
 *
 * Every draft has its own Review row and they are indistinguishable by
 * accessible name, so this finds the race's row first and takes the next
 * Review row after it in menu order — which is exactly how they are rendered
 * (App.tsx emits race, Review…, Refresh… as siblings of one Fragment).
 */
export async function openReviewFor(page: Page, raceName: string) {
  await clickSubRowFor(page, raceName, '↳ Review')
  const dialog = page.getByRole('dialog', { name: 'review · draft race' })
  await expect(dialog).toBeVisible()
  return dialog
}

/**
 * Click the "↳ Refresh from sources…" row under one race, and wait for the
 * dialog it opens.
 *
 * Unlike Review, this row is offered for ANY parseable race (App.tsx's
 * `isRefreshable` is just `!r.error`) — draft, active or archived — so the
 * race has to be named to get the right one.
 */
export async function openRefreshFor(page: Page, raceName: string) {
  await clickSubRowFor(page, raceName, '↳ Refresh')
  const dialog = page.getByRole('dialog', { name: `refresh from sources · ${raceName}` })
  await expect(dialog).toBeVisible()
  return dialog
}

/**
 * Click the sub-row whose label starts with `prefix` under `raceName`.
 *
 * Every draft has its own "↳ Review…" row and every race its own "↳ Refresh
 * from sources…" row, all indistinguishable by accessible name, so this finds
 * the race's row first and takes the next matching sub-row after it in menu
 * order — which is exactly how they are rendered (App.tsx emits race, Review…,
 * Refresh…, Run course again… as siblings of one Fragment).
 */
async function clickSubRowFor(page: Page, raceName: string, prefix: string) {
  const rows = page.getByRole('menu', { name: 'race' }).locator('button')
  const labels = await rows.allInnerTexts()
  const raceIdx = labels.findIndex((t) => t.startsWith(raceName))
  if (raceIdx < 0) throw new Error(`no switcher row for "${raceName}" in: ${JSON.stringify(labels)}`)
  // The next race row ends this race's block — without that bound, a race
  // missing the sub-row would silently click the NEXT race's one.
  const endIdx = labels.findIndex((t, i) => i > raceIdx && !t.startsWith('↳'))
  const limit = endIdx < 0 ? labels.length : endIdx
  const hitIdx = labels.findIndex((t, i) => i > raceIdx && i < limit && t.startsWith(prefix))
  if (hitIdx < 0) throw new Error(`"${raceName}" has no "${prefix}…" row in: ${JSON.stringify(labels.slice(raceIdx, limit))}`)
  await rows.nth(hitIdx).click()
}

/**
 * Put the race view on screen for the active race.
 *
 * The planner (and every printable document's button) only exists under the
 * "race" tab, which itself only exists when a race is active — `viewsFor` in
 * App.tsx gives a generic dashboard the "training" tab alone.
 */
export async function openRaceTab(page: Page) {
  // training/race/fuel are a tablist (round 3, resilience finding 12), not
  // three plain buttons — role="tab", not the button element's implicit role.
  await page.getByRole('tab', { name: /^race$/i }).click()
  await expect(page.getByText(/climb readiness — you vs/i)).toBeVisible()
}

/**
 * Open one of the planner's printable documents and return its dialog.
 *
 * Each is a portalled `role="dialog"` named after the race — see
 * `useDialog({ label })` in race/dialogChrome.ts — and each sets a body class
 * (`card-printing` / `crew-printing`) that the print stylesheet keys off, so
 * only one may be open at a time. The caller closes it before opening the
 * next.
 */
export async function openPrintable(page: Page, button: RegExp, dialogName: string) {
  await page.getByRole('button', { name: button }).click()
  const dialog = page.getByRole('dialog', { name: dialogName })
  await expect(dialog).toBeVisible()
  return dialog
}
