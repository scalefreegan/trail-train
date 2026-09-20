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
 *
 * The floor alone has a hole (r1-crew-tests.md HIGH): nothing checks an
 * UPPER bound, so a page that failed to render any content at all — a
 * crashed sub-component with no thrown error, a data-shape bug that empties
 * a card's station list, a CSS regression that hides content but keeps the
 * white background — rasterises as ~100 % light and sails past every floor
 * above. Two more checks close that:
 *
 *  - A CEILING on the cards, which measured 90–94 % above and must never be
 *    genuinely blank (~100 %) on any page.
 *  - A minimum TEXT length on the dialog's own rendered content, checked
 *    against the DOM before it is ever printed — catching the exact
 *    scenario above (an emptied station list) even when the page still
 *    happens to paginate into a plausible page count with plausible ink
 *    from borders/rules alone.
 *
 * The crew sheet does NOT get a per-page ceiling: its own later pages
 * legitimately measure 99.7–100 % (a short tail section on an otherwise-full
 * Letter page is simply mostly white), so a blanket ceiling there would
 * either false-positive on real output or have to be set so close to 100 %
 * it catches nothing. Page 1 always carries the header, emergency strip and
 * the full station table, so IT gets the ceiling instead — the page that
 * can never legitimately be near-blank — alongside the sheet-wide text
 * floor, which covers the "content emptied everywhere" case the per-page
 * ceiling alone would miss.
 */

/** Every card page must be at least this light. */
const CARD_LIGHT = 0.88
/** The crew sheet's pages are denser — table rules and the profile svg. */
const SHEET_LIGHT = 0.85
/** No card page may be at or above this — measured 90–94 %, a genuinely
    blank page prints at ~100 %. */
const CARD_LIGHT_CEILING = 0.98
/** The crew sheet's page 1 — always header + stations, never legitimately
    near-blank — measured 93.7 %. Not applied to later pages; see above. */
const SHEET_FIRST_PAGE_CEILING = 0.97
/** A card's rendered text, rounded well below every real card's ~1,100+
    characters — enough margin that trimming a field or two never trips it,
    but an emptied card (a bare title and nothing else) still would. */
const CARD_TEXT_FLOOR = 300
/** Same idea for the crew sheet, whose real text runs ~3,500 characters. */
const SHEET_TEXT_FLOOR = 800

const gs = hasGhostscript()

test.describe('printable documents', () => {
  test.skip(!gs, 'ghostscript (gs) is not installed — the print check needs it to rasterise')

  test.beforeEach(async ({ page, request }) => {
    await setActiveRace(request, MM.slug, 'train')
    await openDashboard(page)
    await openRaceTab(page)
  })

  test('the runner card prints two light 5×3in sides', async ({ page, trouble }) => {
    const dialog = await openPrintable(page, /runner card 3×5/i, `${MM.name} — runner card`)
    // Checked against the DOM before it is ever rasterised — a card emptied
    // by a data-shape bug can still paginate and print "light" (see the
    // module comment), but it cannot also carry a normal card's worth of
    // text.
    expect((await dialog.innerText()).length, 'the runner card looks empty').toBeGreaterThan(CARD_TEXT_FLOOR)
    const pages = await printPages(page, 'runner-card')

    // Two pages, one per side: RunnerCard splits the stations in half and puts
    // `runner-card-break` (break-after: page) on the first. One page here
    // means the break was lost and side 2 is running onto side 1's card.
    expect(pages, `runner card: ${describePages(pages)}`).toHaveLength(2)
    for (const p of pages) {
      expect(p.lightPct, `runner card page ${p.page} — ${describePages(pages)}`).toBeGreaterThanOrEqual(CARD_LIGHT)
      expect(p.lightPct, `runner card page ${p.page} looks blank — ${describePages(pages)}`).toBeLessThan(CARD_LIGHT_CEILING)
      // 5×3in at 150 dpi is 750×450, landscape. A Letter-sized page here
      // means the injected `@page { size: 5in 3in }` did not reach the PDF.
      expect(p.width, 'the card page is not 5in wide').toBeGreaterThan(p.height)
      expect(p.width, 'the card page is not 5in wide').toBeLessThan(900)
    }
    expect(trouble.pageErrors).toEqual([])
  })

  test('the fuel card prints light', async ({ page, trouble }) => {
    const dialog = await openPrintable(page, /fuel card 3×5/i, `${MM.name} — fuel card`)
    expect((await dialog.innerText()).length, 'the fuel card looks empty').toBeGreaterThan(CARD_TEXT_FLOOR)
    const pages = await printPages(page, 'fuel-card')

    expect(pages.length, 'the fuel card should print at least one page').toBeGreaterThan(0)
    for (const p of pages) {
      expect(p.lightPct, `fuel card page ${p.page} — ${describePages(pages)}`).toBeGreaterThanOrEqual(CARD_LIGHT)
      expect(p.lightPct, `fuel card page ${p.page} looks blank — ${describePages(pages)}`).toBeLessThan(CARD_LIGHT_CEILING)
      expect(p.width, 'the card page is not 5in wide').toBeLessThan(900)
    }
    expect(trouble.pageErrors).toEqual([])
  })

  test('the drop bag card prints light', async ({ page, trouble }) => {
    const dialog = await openPrintable(page, /drop bags 3×5/i, `${MM.name} — drop bag card`)
    expect((await dialog.innerText()).length, 'the drop bag card looks empty').toBeGreaterThan(CARD_TEXT_FLOOR)
    const pages = await printPages(page, 'drop-bag-card')

    expect(pages.length, 'the drop bag card should print at least one page').toBeGreaterThan(0)
    for (const p of pages) {
      expect(p.lightPct, `drop bag page ${p.page} — ${describePages(pages)}`).toBeGreaterThanOrEqual(CARD_LIGHT)
      expect(p.lightPct, `drop bag page ${p.page} looks blank — ${describePages(pages)}`).toBeLessThan(CARD_LIGHT_CEILING)
      expect(p.width, 'the card page is not 5in wide').toBeLessThan(900)
    }
    expect(trouble.pageErrors).toEqual([])
  })

  test('the crew sheet prints light on every page, not just the first', async ({ page, trouble }) => {
    const dialog = await openPrintable(page, /crew sheet pdf/i, `${MM.name} — crew sheet`)
    expect((await dialog.innerText()).length, 'the crew sheet looks empty').toBeGreaterThan(SHEET_TEXT_FLOOR)
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
    // Only page 1 gets a ceiling — see the module comment on why later pages
    // (legitimately 99.7–100 % light) do not.
    expect(pages[0].lightPct, `crew sheet page 1 looks blank — ${describePages(pages)}`).toBeLessThan(SHEET_FIRST_PAGE_CEILING)
    expect(trouble.pageErrors).toEqual([])
  })

  test('a genuinely blank page is caught by the ceiling, not just the floor', async ({ page }) => {
    // Proves the ceiling actually distinguishes a blank page from a real
    // one, rather than merely existing: a plain white page — the shape an
    // emptied card or a crashed sub-component with no thrown error would
    // rasterise as — passes the OLD floor-only check (it is plenty light)
    // and is exactly what CARD_LIGHT_CEILING exists to catch.
    await page.setContent('<html><body style="background:#ffffff;margin:0"><div style="width:5in;height:3in"></div></body></html>')
    const pages = await printPages(page, 'blank-proof')
    expect(pages).toHaveLength(1)
    expect(pages[0].lightPct, describePages(pages)).toBeGreaterThanOrEqual(CARD_LIGHT)
    expect(pages[0].lightPct, describePages(pages)).toBeGreaterThanOrEqual(CARD_LIGHT_CEILING)
  })
})
