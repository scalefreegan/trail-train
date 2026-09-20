import { test, expect, MM, openDashboard, openSwitcher, setActiveRace, type Page } from './basecamp'

/**
 * Flow 12 — no horizontal scroll, at every width the app claims to support.
 *
 * Sideways scroll is the single most common bug the interactive rounds found,
 * and it is invisible to every other kind of test: the DOM is correct, the
 * console is clean, and one `white-space: nowrap` caption, one wide table or
 * one `min-width` on a grid child pushes the document past the viewport. On a
 * phone that means the athlete's thumb drags the whole page sideways every
 * time they try to scroll down.
 *
 * `document.documentElement.scrollWidth <= clientWidth` is the assertion —
 * scrollWidth is how wide the content actually is, clientWidth the viewport
 * minus any classic scrollbar, so the two being equal is "nothing sticks out".
 * The failure message reports the overflow in pixels and, because the usual
 * cause is one element, the widest offending element as well.
 */

/** 320 the narrowest supported phone, 390 an iPhone, 768 an iPad portrait,
    1024 the breakpoint the rail collapses at, 1280 the one it returns at. */
const WIDTHS = [320, 390, 768, 1024, 1280]

type ViewCheck = { name: string; open: (page: Page) => Promise<void> }

/** Every top-level surface a width can break, and how to get to it. */
const VIEWS: ViewCheck[] = [
  {
    name: 'training',
    open: async (page) => {
      await page.getByRole('tab', { name: /^training$/i }).click()
      await expect(page.getByText(/vitals — load × recovery/i)).toBeVisible()
    },
  },
  {
    name: 'race',
    open: async (page) => {
      await page.getByRole('tab', { name: /^race$/i }).click()
      await expect(page.getByText(/climb readiness — you vs/i)).toBeVisible()
    },
  },
  {
    name: 'fuel',
    open: async (page) => {
      // The tab is labelled "fuel"; the view behind it is the nutrition plan
      // (App.tsx's VIEW_LABEL maps "nutrition" → "fuel").
      await page.getByRole('tab', { name: /^fuel$/i }).click()
      await expect(page.getByText(/^nutrition plan$/i).first()).toBeVisible()
    },
  },
  {
    // Last on purpose: race-day mode is a route, not a tab, and coming back
    // from `/#/race-day` to `/` is a same-document navigation that Playwright
    // may treat as a no-op — leaving the next view's assertion waiting on a
    // dashboard that never re-rendered. Ending the sweep here needs no return
    // trip at all.
    name: 'race-day',
    open: async (page) => {
      await page.goto('/#/race-day')
      await expect(page.getByText(new RegExp(`${MM.short} · race day`, 'i'))).toBeVisible()
    },
  },
]

/**
 * The page's overflow, and the widest thing sticking out of it.
 *
 * Reporting the element is what turns a failure from "something is 40px too
 * wide" into a fix: the offender is almost always a single nowrap caption or
 * a table, and its tag + class names say which.
 */
async function overflow(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement
    const over = doc.scrollWidth - doc.clientWidth
    if (over <= 0) return { over, culprit: null as string | null }
    let worst: { right: number; desc: string } | null = null
    for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.right <= doc.clientWidth) continue
      if (!worst || r.right > worst.right) {
        const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''
        worst = { right: r.right, desc: `<${el.tagName.toLowerCase()}${cls}> right=${Math.round(r.right)}` }
      }
    }
    return { over, culprit: worst?.desc ?? null }
  })
}

test.describe('no horizontal scroll', () => {
  test.beforeEach(async ({ request }) => {
    // A race is active throughout: the "race" and "fuel" tabs only exist with
    // one, and race-day mode needs the 100-miler's live clock.
    await setActiveRace(request, MM.slug, 'train')
  })

  for (const width of WIDTHS) {
    test(`the app fits ${width}px in every view`, async ({ page, trouble }) => {
      await page.setViewportSize({ width, height: 900 })
      await openDashboard(page)

      for (const view of VIEWS) {
        await view.open(page)
        // A re-layout after the tab swap can lag a frame; poll rather than
        // sample once, so this reports settled geometry and not a transient.
        await expect
          .poll(async () => (await overflow(page)).over, {
            message: `${view.name} at ${width}px kept overflowing`,
            timeout: 3_000,
          })
          .toBeLessThanOrEqual(0)

        const { over, culprit } = await overflow(page)
        expect(over, `${view.name} at ${width}px is ${over}px too wide — widest offender: ${culprit ?? 'none found'}`).toBeLessThanOrEqual(0)
      }

      expect(trouble.pageErrors).toEqual([])
    })
  }

  // The menu is its own overflow risk: it is a fixed-width panel anchored
  // under a chip that already starts ~130px in, so on a 320px phone it used to
  // hang off the right edge and drag the whole document sideways the moment it
  // opened (round 2, resilience finding 3) — with the page itself measuring
  // clean both before and after.
  for (const width of [320, 390]) {
    test(`the race switcher's menu stays inside ${width}px`, async ({ page, trouble }) => {
      await page.setViewportSize({ width, height: 800 })
      await openDashboard(page)
      await openSwitcher(page)

      const { over, culprit } = await overflow(page)
      expect(over, `the open switcher at ${width}px is ${over}px too wide — widest offender: ${culprit ?? 'none found'}`).toBeLessThanOrEqual(0)

      const box = await page.getByRole('menu', { name: 'race' }).boundingBox()
      expect(box, 'the switcher menu has no box').not.toBeNull()
      expect(box!.x, 'the menu hangs off the left edge').toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width, 'the menu hangs off the right edge').toBeLessThanOrEqual(width)

      expect(trouble.pageErrors).toEqual([])
    })
  }
})
