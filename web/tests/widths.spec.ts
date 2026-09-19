import { test, expect, MM, openDashboard, setActiveRace, type Page } from './basecamp'

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
      await page.getByRole('button', { name: /^training$/i }).click()
      await expect(page.getByText(/vitals — load × recovery/i)).toBeVisible()
    },
  },
  {
    name: 'race',
    open: async (page) => {
      await page.getByRole('button', { name: /^race$/i }).click()
      await expect(page.getByText(/climb readiness — you vs/i)).toBeVisible()
    },
  },
  {
    name: 'fuel',
    open: async (page) => {
      // The tab is labelled "fuel"; the view behind it is the nutrition plan
      // (App.tsx's VIEW_LABEL maps "nutrition" → "fuel").
      await page.getByRole('button', { name: /^fuel$/i }).click()
      await expect(page.getByText(/fuel/i).first()).toBeVisible()
    },
  },
  {
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
  test.beforeEach(async ({ page, request }) => {
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

        // Leaving race-day mode is a route change, so the tabs are only back
        // once the dashboard has rendered again.
        if (view.name === 'race-day') {
          await page.goto('/')
          await expect(page.getByText(/vitals — load × recovery/i)).toBeVisible()
        }
      }

      expect(trouble.pageErrors).toEqual([])
    })
  }
})
