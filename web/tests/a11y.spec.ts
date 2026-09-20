import {
  test, expect, CREWLESS, DRAFT, MM,
  openDashboard, openPrintable, openRaceTab, openRefreshFor, openReviewFor, openSwitcher, setActiveRace,
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
 *   receive focus back. A dialog opened from a switcher row cannot restore
 *   focus to it — the menu unmounts when the dialog opens, and a detached
 *   node's .focus() is a no-op — so only the dialogs opened from a button
 *   that stays on screen are held to it.
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
    await openSwitcher(page)
    await openReviewFor(page, DRAFT.name)
    await assertDialogContract(page, 'review · race')
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
    await openSwitcher(page)
    await openRefreshFor(page, CREWLESS.name)
    await assertDialogContract(page, `refresh from sources · ${CREWLESS.name}`)
    expect(trouble.pageErrors).toEqual([])
  })

  test('archive with result', async ({ page, trouble }) => {
    const menu = await openSwitcher(page)
    // Opened, walked and closed with Escape — never submitted. Archiving the
    // 100-miler would retire the race every other spec runs against.
    await menu.getByRole('menuitem', { name: /Archive with result…/ }).click()
    await assertDialogContract(page, 'archive with result')
    expect(trouble.pageErrors).toEqual([])
  })

  test('the tune-up quick form', async ({ page, trouble }) => {
    const menu = await openSwitcher(page)
    // Only the race being trained for carries this row, which is why the
    // beforeEach above points at the 100-miler.
    await menu.getByRole('menuitem', { name: /Add tune-up…/ }).click()
    // Named through aria-labelledby (its header), not aria-label — the other
    // half of the contract `useDialog` offers, and the half nothing else here
    // exercises except the refresh dialog.
    await assertDialogContract(page, 'add tune-up')
    expect(trouble.pageErrors).toEqual([])
  })
})
