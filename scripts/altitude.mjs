/* ------------------------------------------------------------------ */
/*  Altitude slowdown curve — the ONE place the constants live.        */
/*                                                                    */
/*  TWIN FILE: web/src/race/altitude.ts is the byte-for-byte same      */
/*  model with types on it, and scripts/altitude.test.mjs imports      */
/*  BOTH and asserts they agree on every constant and on a grid of     */
/*  values — so a change here that is not mirrored there fails the     */
/*  suite rather than quietly giving the planner and the scripts two   */
/*  different races. Same arrangement as clock.ts / clock.mjs: the     */
/*  sync scripts and the Vite bundle share no module graph, and this   */
/*  is ~40 lines of arithmetic with no dependencies.                   */
/*                                                                    */
/*  SOURCE FOR THE NUMBERS                                            */
/*  - Threshold + per-1,000 ft cost: Fulco CS, Rock PB, Cymerman A,   */
/*    "Maximal and submaximal exercise performance at altitude",      */
/*    Aviat Space Environ Med 1998;69(8):793-801 — VO2max is          */
/*    unchanged to ~1,500 m (4,921 ft) and then falls roughly 6-8 %   */
/*    per additional 1,000 m, i.e. ~2 % per 1,000 ft. Sustained       */
/*    endurance PACE degrades somewhat LESS than VO2max does (the     */
/*    effort is run well below VO2max, and Daniels' altitude          */
/*    conversion tables put the distance-race loss under the aerobic  */
/*    one), so the pace cost used here is 1.8 % per 1,000 ft — the    */
/*    middle of the 1.5-2 % band PRD-v2 §2 asks for.                  */
/*  - Acclimatization: the same review's time course. Most of the     */
/*    adaptation is ventilatory and arrives early (about half of it   */
/*    inside 3 days, ~90 % by 2 weeks), and it is only ever PARTIAL:  */
/*    a sojourner acclimatized for weeks still does not recover       */
/*    sea-level performance at altitude. So acclimation buys back at  */
/*    most half of the penalty (ACCLIMATION_MAX_RELIEF).              */
/*                                                                    */
/*  Everything is IMPERIAL (feet) — the app's internal unit.          */
/* ------------------------------------------------------------------ */

/** No pace cost at or below this elevation, ft (≈1,500 m). */
export const ALTITUDE_THRESHOLD_FT = 5000;

/** Pace cost per 1,000 ft above the acclimated elevation, as a fraction. */
export const PACE_PENALTY_PER_1000FT = 0.018;

/** The most acclimation can ever give back, as a fraction of the raw
    penalty. Acclimatization is partial: half the cost is structural (lower
    inspired O2) and does not go away however long you stay. */
export const ACCLIMATION_MAX_RELIEF = 0.5;

/** The two published anchors of the acclimatization time course: half the
    available benefit by day 3, ~90 % of it by day 14. */
export const ACCLIMATION_HALF_DAYS = 3;
export const ACCLIMATION_NEAR_DAYS = 14;
export const ACCLIMATION_NEAR_FRACTION = 0.9;

/* A single exponential cannot pass through BOTH anchors (fix day 3 at 50 %
   and day 14 lands at 96 %; fix day 14 at 90 % and day 3 lands at 39 %), so
   the saturating curve is 1 − exp(−(d/scale)^shape) and the two parameters
   are SOLVED from the two anchors rather than typed in. Editing an anchor
   above moves the curve and nothing else has to be recomputed by hand. */
const ACCL_SHAPE =
  Math.log(Math.log(1 / (1 - ACCLIMATION_NEAR_FRACTION)) / Math.log(2)) /
  Math.log(ACCLIMATION_NEAR_DAYS / ACCLIMATION_HALF_DAYS);
const ACCL_SCALE_DAYS = ACCLIMATION_HALF_DAYS / Math.pow(Math.log(2), 1 / ACCL_SHAPE);

/**
 * How far along the acclimatization curve `days` at altitude gets you, 0..1.
 * This is the FRACTION OF THE AVAILABLE BENEFIT, not of the penalty — the
 * penalty never goes below (1 − ACCLIMATION_MAX_RELIEF) of its raw value.
 *
 * @param {number} days days already spent at (or near) the race elevation
 * @returns {number} 0 on arrival day, → 1 with a long stay
 */
export function acclimationFraction(days) {
  const d = Number.isFinite(days) && days > 0 ? days : 0;
  if (d === 0) return 0;
  return 1 - Math.exp(-Math.pow(d / ACCL_SCALE_DAYS, ACCL_SHAPE));
}

/**
 * Fractional pace penalty at an elevation — 0.054 means "6:00/mi flat pace
 * costs 6 % more here". Multiplies a pace the way tech_pct does.
 *
 * @param {{ elevationFt?: number, homeElevationFt?: number|null, acclimationDays?: number }} o
 *   elevationFt      the elevation being run at, ft
 *   homeElevationFt  the athlete's acclimated elevation, ft (null → sea level)
 *   acclimationDays  days at altitude before the effort (default 0)
 * @returns {number} penalty as a fraction of pace, ≥ 0
 */
export function altitudeSlowdown({ elevationFt, homeElevationFt, acclimationDays } = {}) {
  const ele = Number.isFinite(elevationFt) ? elevationFt : 0;
  // The athlete's own baseline raises the threshold but never lowers it:
  // living at 3,000 ft does not make 5,000 ft cost anything.
  const home = Number.isFinite(homeElevationFt) ? homeElevationFt : 0;
  const ref = Math.max(ALTITUDE_THRESHOLD_FT, home);
  const excess = Math.max(0, ele - ref);
  if (excess === 0) return 0;
  const raw = (excess / 1000) * PACE_PENALTY_PER_1000FT;
  return raw * (1 - ACCLIMATION_MAX_RELIEF * acclimationFraction(acclimationDays));
}
