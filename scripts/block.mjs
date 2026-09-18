// The training block — one definition, two readers.
//
// scripts/facts.mjs builds the coach's digest from it; the dev server's
// GET /api/race/active hands the same numbers to the web client. Generic
// mode has no race to count down to, so its block is a window that rolls
// forward with the athlete (PRD §6), and the two readers MUST agree on
// where that window starts: the client buckets weekly mileage by this
// start date, so a one-day disagreement shifts every bar by a column and
// the dashboard silently contradicts the coach.
//
// Pure functions over already-loaded JSON — no filesystem, so both callers
// and the tests can pin `now`.

import { bandMidpoint } from "./goals.mjs";
import { isoDate } from "./state.mjs";

/** Generic mode's block: the current week plus the 11 before it. */
export const ROLLING_WEEKS = 12;

/** Local Monday of the week containing `d` — ISO weeks start on Monday. */
export function mondayOf(d) {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
  return m;
}

/**
 * Weekly targets for the rolling window. The coach writes its plan into
 * config/generic-plan.json (plan_blocks, wk 1..ROLLING_WEEKS indexing this
 * same window), so a week it has planned is its own target; the rest fall
 * back to the midpoint of the goals volume band — the only number available
 * when nobody has planned that week.
 * @param {object[]} planBlocks  plan_blocks as loaded from the generic plan
 * @param {object|null} goals    config/goals.json
 */
export function rollingTargets(planBlocks, goals) {
  const midDist = bandMidpoint(goals?.weekly_volume_band?.dist_mi);
  const midElev = bandMidpoint(goals?.weekly_volume_band?.vert_ft);
  const planned = new Map();
  for (const b of planBlocks ?? []) {
    if (typeof b?.wk === "number") planned.set(b.wk, b);
  }
  return Array.from({ length: ROLLING_WEEKS }, (_, i) => {
    const b = planned.get(i + 1);
    return {
      wk: i + 1,
      target_dist: +(typeof b?.dist_mi === "number" ? b.dist_mi : midDist).toFixed(1),
      target_elev: Math.round(typeof b?.elev_ft === "number" ? b.elev_ft : midElev),
    };
  });
}

/**
 * The block generic mode trains in: the 12 ISO weeks ending with the one
 * containing `now`. Shaped like a race folder's block.json plus a `mode`
 * discriminator, so one client type covers both.
 * @param {object|null} goals       config/goals.json
 * @param {object[]} planBlocks     config/generic-plan.json's plan_blocks
 * @param {number} [now]            "now" in ms, injectable for tests
 * @returns {{mode: "rolling", start_date: string, total_weeks: number,
 *            targets: {wk: number, target_dist: number, target_elev: number}[]}}
 */
export function rollingBlock(goals, planBlocks, now = Date.now()) {
  const start = mondayOf(new Date(now));
  start.setDate(start.getDate() - 7 * (ROLLING_WEEKS - 1));
  return {
    mode: "rolling",
    start_date: isoDate(start),
    total_weeks: ROLLING_WEEKS,
    targets: rollingTargets(planBlocks, goals),
  };
}
