import { test } from './basecamp'

/**
 * Flow 10 — the B-race (tune-up) quick form. NOT YET WRITTEN, and skipped
 * rather than deleted so the gap is visible in every run's output.
 *
 * Why: the quick form arrives with bead tt-cv1b0.4, which has not merged into
 * this branch's base. `git log v2 --oneline | head` at the time of writing
 * tops out at bead 10's Playwright harness, and none of the pieces this spec
 * would drive exist yet — no web/src/race/AddTuneUp.tsx, no B-race row under a
 * parent race in App.tsx's switcher, no `b_races` group on screen. The server
 * half IS here (`POST /api/races` takes `{ name, date, distance_mi, gain_ft,
 * parent_slug }` and answers 201 with the created folder), which is what makes
 * this a UI gap rather than a feature gap.
 *
 * What it should assert when bead 04 lands, from the bead's own flow list:
 *
 *  1. The switcher offers a tune-up row under the A race (mm-like-100), and
 *     the quick form opens as a dialog — which means it also belongs in
 *     a11y.spec.ts's table, where there is a matching skipped test.
 *  2. The form takes a name, a date, a distance and a gain, and nothing else:
 *     a tune-up is not an intake, and it must not need a website or an agent
 *     turn. Submitting writes races/<slug>/ with `parent_slug` pointing at the
 *     A race, and answers without spending an agent turn (the fake-agent
 *     fixture would stay untouched).
 *  3. The new race appears in the switcher nested under its parent, in the
 *     `groups[].b_races` shape GET /api/races already returns, rather than as
 *     a sibling in the top-level list.
 *  4. Activating it does NOT retire the A race: a tune-up is trained THROUGH,
 *     and the block stays pointed at the hundred.
 *  5. The trajectory marks it, and the training view's countdown still counts
 *     down to the A race.
 *
 * Nothing about that needs a new fixture: the 100-miler is already the parent,
 * and the quick form invents its own child.
 */

test.skip('the B-race quick form creates a tune-up under its parent race', async () => {
  // intentionally empty — see the comment above
})
