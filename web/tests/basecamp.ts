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

/* ------------------------------------------------------------------ */
/*  Fixture facts the specs assert against                             */
/* ------------------------------------------------------------------ */

/** races/_fixtures/mm-like-100 — the 100-miler, always dated today. */
export const MM = { slug: 'mm-like-100', name: 'Mesa Monster 100', short: 'MM100F' }
/** races/_fixtures/unresolved-draft-50k — the draft the review dialog opens. */
export const DRAFT = { slug: 'unresolved-draft-50k', name: 'Nine Mile Flat 50K', short: 'NMF50K' }
/** races/_fixtures/rimrock-50k — archived, with a result.json. */
export const ARCHIVED = { slug: 'rimrock-50k', name: 'Rimrock Ramble 50K', short: 'RR50K' }

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
  const rows = page.getByRole('menu', { name: 'race' }).locator('button')
  const labels = await rows.allInnerTexts()
  const raceIdx = labels.findIndex((t) => t.startsWith(raceName))
  if (raceIdx < 0) throw new Error(`no switcher row for "${raceName}" in: ${JSON.stringify(labels)}`)
  const reviewIdx = labels.findIndex((t, i) => i > raceIdx && t.startsWith('↳ Review'))
  if (reviewIdx < 0) throw new Error(`"${raceName}" has no Review row — is it still a draft?`)
  await rows.nth(reviewIdx).click()
  const dialog = page.getByRole('dialog', { name: 'review · draft race' })
  await expect(dialog).toBeVisible()
  return dialog
}
