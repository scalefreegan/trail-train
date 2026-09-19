/* ------------------------------------------------------------------ */
/*  Altitude slowdown curve — the client half of the twin.            */
/*                                                                    */
/*  TWIN FILE: scripts/altitude.mjs is the Node ESM copy of this exact */
/*  model and carries the full citation for every constant; read it    */
/*  before changing a number here. scripts/altitude.test.mjs imports   */
/*  BOTH modules and asserts they agree on every constant and on a     */
/*  grid of values, so the two cannot drift apart in silence.          */
/*                                                                    */
/*  This file imports NOTHING — same rule as nightWindow.ts and        */
/*  features.ts. That is what lets node >= 22.18 type-strip it and     */
/*  load the .ts the app actually ships, instead of a reimplementation */
/*  of it, into the test.                                             */
/*                                                                    */
/*  Short version of the sourcing: VO2max is flat to ~5,000 ft and     */
/*  then falls ~6-8 % per 1,000 m (Fulco, Rock & Cymerman 1998);       */
/*  sustained race PACE degrades a little less than VO2max does, hence */
/*  1.8 % per 1,000 ft. Acclimatization is fast at first (half the     */
/*  benefit in 3 days, ~90 % in 14) and only ever partial — it buys    */
/*  back at most half the penalty.                                     */
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

/* A single exponential cannot pass through BOTH anchors, so the saturating
   curve is 1 − exp(−(d/scale)^shape) and the two parameters are SOLVED from
   the two anchors rather than typed in. See the .mjs twin. */
const ACCL_SHAPE =
  Math.log(Math.log(1 / (1 - ACCLIMATION_NEAR_FRACTION)) / Math.log(2)) /
  Math.log(ACCLIMATION_NEAR_DAYS / ACCLIMATION_HALF_DAYS);
const ACCL_SCALE_DAYS = ACCLIMATION_HALF_DAYS / Math.pow(Math.log(2), 1 / ACCL_SHAPE);

/** What altitudeSlowdown() takes. `homeElevationFt` null means "nobody has
    told us where this athlete lives" — treated as sea level, and the views
    that show the term say so rather than passing off a guess as a setting. */
export type AltitudeInput = {
  /** the elevation being run at, ft */
  elevationFt?: number;
  /** the athlete's acclimated elevation, ft (null → sea level) */
  homeElevationFt?: number | null;
  /** days at altitude before the effort (default 0 — arrive and run) */
  acclimationDays?: number;
};

/**
 * How far along the acclimatization curve `days` at altitude gets you, 0..1.
 * This is the FRACTION OF THE AVAILABLE BENEFIT, not of the penalty — the
 * penalty never goes below (1 − ACCLIMATION_MAX_RELIEF) of its raw value.
 */
export function acclimationFraction(days?: number): number {
  const d = Number.isFinite(days) && (days as number) > 0 ? (days as number) : 0;
  if (d === 0) return 0;
  return 1 - Math.exp(-Math.pow(d / ACCL_SCALE_DAYS, ACCL_SHAPE));
}

/**
 * Fractional pace penalty at an elevation — 0.054 means "6:00/mi flat pace
 * costs 6 % more here". Multiplies a pace the way tech_pct does.
 */
export function altitudeSlowdown({ elevationFt, homeElevationFt, acclimationDays }: AltitudeInput = {}): number {
  const ele = Number.isFinite(elevationFt) ? (elevationFt as number) : 0;
  // The athlete's own baseline raises the threshold but never lowers it:
  // living at 3,000 ft does not make 5,000 ft cost anything.
  const home = Number.isFinite(homeElevationFt) ? (homeElevationFt as number) : 0;
  const ref = Math.max(ALTITUDE_THRESHOLD_FT, home);
  const excess = Math.max(0, ele - ref);
  if (excess === 0) return 0;
  const raw = (excess / 1000) * PACE_PENALTY_PER_1000FT;
  return raw * (1 - ACCLIMATION_MAX_RELIEF * acclimationFraction(acclimationDays));
}
