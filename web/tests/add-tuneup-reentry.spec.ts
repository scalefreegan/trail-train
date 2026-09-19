import { test, expect, MM, openDashboard, openSwitcher, setActiveRace } from './basecamp'

/**
 * Flow 10 addendum — AddTuneUp.submit()'s re-entrancy guard.
 *
 * r1-client.md MINOR: submit() gated only on the state-derived `canSubmit`
 * and the button's `disabled` prop, which React does not repaint until the
 * next render commits. A burst of clicks landing in the same tick (a
 * double-tap, a key repeat) could all pass the check and all POST before any
 * of them saw `busy: true` — the exact shape App.tsx's RaceSwitcher.choose()
 * carries a `busyRef` for. AddTuneUp.submit() now has the same guard.
 *
 * The POST is intercepted rather than hitting the real server: the point is
 * to count requests, not to write a race folder, and a browser's own
 * `.click()` never naturally double-dispatches a single user gesture — this
 * needs the same synchronous multi-dispatch (via `element.click()` called
 * three times in one page.evaluate, so all three fire before Playwright
 * yields back and before React's state update repaints `disabled`) that
 * originally surfaced the RaceSwitcher bug.
 */

test('three synchronous clicks on "add tune-up" produce exactly one POST', async ({ page, request, trouble }) => {
  await setActiveRace(request, MM.slug, 'train')
  await openDashboard(page)

  let posts = 0
  await page.route('**/api/races', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    posts++
    // A little latency widens the re-entrancy window — the guard has to
    // hold across it, not just prevent an instantaneous double-fire.
    await new Promise((r) => setTimeout(r, 250))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ slug: 'reentry-tuneup-fake', build: null }),
    })
  })

  const menu = await openSwitcher(page)
  await menu.getByRole('menuitem', { name: /Add tune-up…/ }).click()

  const dialog = page.getByRole('dialog', { name: 'add tune-up' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('name').fill('Reentry Guard 10K')
  const d = new Date()
  d.setDate(d.getDate() - 14)
  const p2 = (n: number) => String(n).padStart(2, '0')
  await dialog.getByLabel('date').fill(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`)
  await dialog.getByLabel('distance mi').fill('6.2')
  await dialog.getByLabel('gain ft').fill('400')

  const submit = dialog.getByRole('button', { name: /^add tune-up$/i })
  await expect(submit).toBeEnabled()

  // Three synchronous native clicks, all in one page-side script: this is
  // what a same-tick burst looks like from the DOM's point of view, and it
  // is the only way React's post-click `disabled` re-render cannot help.
  await submit.evaluate((el: HTMLElement) => {
    el.click()
    el.click()
    el.click()
  })

  await expect(dialog).toBeHidden({ timeout: 5000 })
  expect(posts, 'a synchronous triple-click should still produce exactly one POST').toBe(1)
  expect(trouble.pageErrors).toEqual([])
})
