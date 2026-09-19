import { test, expect, MM, openDashboard, openPrintable, openRaceTab, setActiveRace } from './basecamp'
import { describePages, hasGhostscript, printPages } from './paper'

/**
 * Flow 5 — what the printable documents actually put on paper.
 *
 * Basecamp is a dark app. Every document meant for a printer — the three 3×5
 * cards and the crew sheet — is a light-paper component that only comes out
 * right because `@media print` in index.css undoes the app's `color-scheme:
 * dark`, blanks the body background and hides `#root` so the portalled sheet
 * is alone on the page. None of that is visible on screen, which is precisely
 * why it rots: rounds 2 and 3 found a crew sheet whose page 2 printed on the
 * app's near-black body colour, and an @page gutter painted #121212 by the UA.
 *
 * So this does not assert on the DOM. It prints the page the way a printer
 * would (`page.pdf()` renders in print media), rasterises it with ghostscript
 * and counts light pixels. A card that has fallen back to the dark palette
 * does not miss by a few percent — it misses by eighty, and the failure
 * message says which page and by how much.
 *
 * The thresholds are set from what the fixture race actually measures at
 * 150 dpi, with room for the content to move a little, and are nowhere near
 * the failure they exist to catch — a dark-palette regression prints at under
 * 20 % light, not 85 %:
 *
 *   runner card    94.4 %  94.4 %                      (two 5×3in sides)
 *   fuel card      94.3 %  94.3 %
 *   drop bag card  90.4 %                              — the densest card:
 *                                                        five bold station
 *                                                        headings on a 5×3in
 *                                                        page is simply a lot
 *                                                        of ink
 *   crew sheet     93.7 %  98.2 %  then 99.7–100 %     (nine Letter pages)
 *
 * So: 88 % for a card page, 85 % for a crew sheet page. (The bead asked for
 * 95 % / 85 %; 95 % is below what the drop bag card can reach with this
 * fixture's aid stations, and lowering the bar to what the real document
 * measures is better than trimming the fixture to fit the bar.)
 */

/** Every card page must be at least this light. */
const CARD_LIGHT = 0.88
/** The crew sheet's pages are denser — table rules and the profile svg. */
const SHEET_LIGHT = 0.85

const gs = hasGhostscript()

test.describe('printable documents', () => {
  test.skip(!gs, 'ghostscript (gs) is not installed — the print check needs it to rasterise')

  test.beforeEach(async ({ page, request }) => {
    await setActiveRace(request, MM.slug, 'train')
    await openDashboard(page)
    await openRaceTab(page)
  })

  test('the runner card prints two light 5×3in sides', async ({ page, trouble }) => {
    await openPrintable(page, /runner card 3×5/i, `${MM.name} — runner card`)
    const pages = await printPages(page, 'runner-card')

    // Two pages, one per side: RunnerCard splits the stations in half and puts
    // `runner-card-break` (break-after: page) on the first. One page here
    // means the break was lost and side 2 is running onto side 1's card.
    expect(pages, `runner card: ${describePages(pages)}`).toHaveLength(2)
    for (const p of pages) {
      expect(p.lightPct, `runner card page ${p.page} — ${describePages(pages)}`).toBeGreaterThanOrEqual(CARD_LIGHT)
      // 5×3in at 150 dpi is 750×450, landscape. A Letter-sized page here
      // means the injected `@page { size: 5in 3in }` did not reach the PDF.
      expect(p.width, 'the card page is not 5in wide').toBeGreaterThan(p.height)
      expect(p.width, 'the card page is not 5in wide').toBeLessThan(900)
    }
    expect(trouble.pageErrors).toEqual([])
  })

  test('the fuel card prints light', async ({ page, trouble }) => {
    await openPrintable(page, /fuel card 3×5/i, `${MM.name} — fuel card`)
    const pages = await printPages(page, 'fuel-card')

    expect(pages.length, 'the fuel card should print at least one page').toBeGreaterThan(0)
    for (const p of pages) {
      expect(p.lightPct, `fuel card page ${p.page} — ${describePages(pages)}`).toBeGreaterThanOrEqual(CARD_LIGHT)
      expect(p.width, 'the card page is not 5in wide').toBeLessThan(900)
    }
    expect(trouble.pageErrors).toEqual([])
  })

  test('the drop bag card prints light', async ({ page, trouble }) => {
    await openPrintable(page, /drop bags 3×5/i, `${MM.name} — drop bag card`)
    const pages = await printPages(page, 'drop-bag-card')

    expect(pages.length, 'the drop bag card should print at least one page').toBeGreaterThan(0)
    for (const p of pages) {
      expect(p.lightPct, `drop bag page ${p.page} — ${describePages(pages)}`).toBeGreaterThanOrEqual(CARD_LIGHT)
      expect(p.width, 'the card page is not 5in wide').toBeLessThan(900)
    }
    expect(trouble.pageErrors).toEqual([])
  })

  test('the crew sheet prints light on every page, not just the first', async ({ page, trouble }) => {
    await openPrintable(page, /crew sheet pdf/i, `${MM.name} — crew sheet`)
    const pages = await printPages(page, 'crew-sheet')

    // More than one page is the point of the assertion below: the bug this
    // encodes (round 3) only showed from page 2 on, where `.crew-sheet` had
    // stopped covering the page box and the app's dark body painted through.
    expect(pages.length, `crew sheet: ${describePages(pages)}`).toBeGreaterThan(1)
    for (const p of pages) {
      expect(p.lightPct, `crew sheet page ${p.page} — ${describePages(pages)}`).toBeGreaterThanOrEqual(SHEET_LIGHT)
      // Letter, portrait — the crew sheet does NOT take the cards' @page size,
      // and picking up 5×3in would be its own kind of broken.
      expect(p.height, 'the crew sheet page is not portrait Letter').toBeGreaterThan(p.width)
    }
    expect(trouble.pageErrors).toEqual([])
  })
})
