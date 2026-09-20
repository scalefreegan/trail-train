import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

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
 * implicit one. "New race…" — the only row left that is not a race — is a
 * plain `menuitem`, which is what keeps this from matching it.
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

/* ------------------------------------------------------------------ */
/*  The topline action strip                                           */
/* ------------------------------------------------------------------ */

/**
 * The per-race actions, as of the topline change.
 *
 * They used to be "↳ …" rows inside the switcher menu, one set per race
 * folder; they are now real buttons on the status strip under the command
 * bar, about the ONE race that is loaded (App.tsx's RaceTopline). So every
 * helper below loads the race first and then acts on it, where it used to
 * find the race's row and take the next sub-row after it.
 */
export const raceActions = (page: Page) => page.getByRole('group', { name: 'race actions' })

/** One action button on the strip, by (partial) label. */
export const raceAction = (page: Page, name: string | RegExp) =>
  raceActions(page).getByRole('button', { name })

/**
 * The strip's outcome line — the course build's reason / ⚠ / ✓, or a refused
 * activation.
 *
 * It is a `role="status"` live region (App.tsx's RaceTopline), and it is the
 * only element that renders this text: the action buttons never relabel
 * themselves to carry it. Pointing at it matters — the first version of the
 * "no false tick" assertion was aimed at the button group, where the tick
 * could never have appeared, so it could never fail.
 */
export const raceActionNote = (page: Page) => page.getByRole('status')

/**
 * Every action label the strip is currently offering, in render order.
 *
 * As RENDERED: the buttons wear the app's `.chip` class, which is
 * `text-transform: uppercase`, and `innerText` reports the transformed text.
 * So the expectations read "REVIEW…", not "Review…" — the athlete's own view
 * of the strip, and the thing that would change if the styling ever stopped
 * shouting.
 */
export async function raceActionLabels(page: Page): Promise<string[]> {
  // Waits for the strip itself rather than for any one button: a state with
  // no actions at all (a tune-up, an orphan) is a legitimate answer here.
  await expect(page.getByText(/^(active|draft|archived) · /i).first()).toBeVisible()
  return (await raceActions(page).getByRole('button').allInnerTexts()).map((t) => t.trim())
}

/**
 * Put one race on screen, through the switcher, whatever is loaded now.
 *
 * Tolerates the menu already being open — several specs call `openSwitcher`
 * themselves before reaching for an action, and clicking the trigger again
 * would close it.
 */
export async function loadRace(page: Page, name: string | RegExp) {
  const menu = page.getByRole('menu', { name: 'race' })
  if (!(await menu.isVisible())) await openSwitcher(page)
  await chooseRace(page, name)
}

/**
 * Load one race and open its review screen from the strip.
 *
 * Both drafts and the active race carry the button (App.tsx's
 * `isReviewable`), and it is the only way back into a folder's aid chart,
 * profile and unresolved fields once the intake dialog has been closed.
 */
export async function openReviewFor(page: Page, raceName: string) {
  await loadRace(page, new RegExp(raceName))
  await raceAction(page, /Review…/).click()
  const dialog = page.getByRole('dialog', { name: 'review · race' })
  await expect(dialog).toBeVisible()
  return dialog
}

/**
 * Load one race and open its "Refresh from sources… · paid" dialog.
 *
 * Offered for ANY parseable race (App.tsx's `isRefreshable` is just
 * `!r.error`) — draft, active or archived.
 */
export async function openRefreshFor(page: Page, raceName: string) {
  await loadRace(page, new RegExp(raceName))
  await raceAction(page, /Refresh from sources/).click()
  const dialog = page.getByRole('dialog', { name: `refresh from sources · ${raceName}` })
  await expect(dialog).toBeVisible()
  return dialog
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

/**
 * Write a raw races/<slug>/race.json straight onto the shared per-run
 * project root, bypassing POST /api/races entirely.
 *
 * Some shapes cannot come from the app or its API at all — quickCreateRace
 * refuses a tune-up whose parent is itself a tune-up (round 3 resilience
 * NEW-1's "a B chained onto another B") — so the only way to put that shape
 * in front of the switcher is to write the folder directly, the same way
 * confirm-ui3's browser session reproduced it. `listRaces` (scripts/
 * race-config.mjs) reads race.json raw with no schema validation, so this
 * only needs the fields the switcher/groupRaces actually read.
 *
 * Every slug this writes MUST start with `shell2-` (enforced here) — one
 * server and one project root serve the whole suite (see global-setup.ts),
 * so a collision with another spec's fixture would corrupt its run, not
 * just this one. Nothing removes the folder afterward: the temp root is
 * discarded whole in global teardown, and every other spec's own listing
 * assertions name specific races rather than asserting an exhaustive count.
 */
export async function writeRawRaceFolder(slug: string, race: Record<string, unknown>): Promise<void> {
  if (!slug.startsWith('shell2-')) throw new Error(`writeRawRaceFolder: "${slug}" must start with "shell2-"`)
  const root = process.env.TRAIL_TEST_PROJECT_ROOT
  if (!root) throw new Error('writeRawRaceFolder: TRAIL_TEST_PROJECT_ROOT is unset — global setup did not run')
  const dir = path.join(root, 'races', slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'race.json'), JSON.stringify({ slug, ...race }, null, 2))
}
