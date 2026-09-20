import { fitPacing, type PacingFit, type PaceGradeCurve } from "./pacing";
import { altitudeSlowdown } from "./altitude";
import type { Course } from "./types";

/* ------------------------------------------------------------------ */
/*  Projection confidence — does the pacing model actually predict THIS */
/*  athlete, and are its inputs still current?                        */
/*                                                                    */
/*  projectRace turns a fit into a race time; nothing until now asked  */
/*  whether that fit is any good. In-sample residuals cannot answer    */
/*  that: the fit is weighted least squares, and runs at or beyond the */
/*  full-weight distance are exactly the points it is pulled hardest   */
/*  to match — testing on them flatters the model most precisely in    */
/*  the band we care most about. So every prediction here is           */
/*  LEAVE-ONE-OUT: the run being tested is excluded, the fit is        */
/*  re-solved on everything else, and THAT fit predicts it. 50-odd     */
/*  3x3 refits is microseconds; honesty is cheap here.                 */
/*                                                                    */
/*  Bias is then read per band (a fit can be clean overall and wrong   */
/*  in the one regime the projection reads from), and the calibration  */
/*  knob gets a data-grounded suggestion. Suggest only — never         */
/*  auto-apply.                                                        */
/* ------------------------------------------------------------------ */

export type BackTestRun = {
  date: string;
  title: string;
  /** the athlete's own workout label: long / vert / easy / run */
  category: string;
  distance_mi: number;
  vert_ft_per_mi: number;
  /** seconds per mile the fit predicts for this run's distance and vert */
  predicted_s_per_mi: number;
  actual_s_per_mi: number;
  /** (actual − predicted) / predicted, as a percentage.
      POSITIVE means the athlete ran SLOWER than the model expected. */
  err_pct: number;
};

export type Band = {
  label: string;
  n: number;
  median_err_pct: number;
  mean_err_pct: number;
};

export type Flag = {
  id: string;
  severity: "ok" | "watch" | "warn";
  label: string;
  detail: string;
};

/* ------------------------------------------------------------------ */
/*  Altitude back-test (PRD-v2 §2).                                    */
/*                                                                    */
/*  The rest of this file asks "does the pacing fit predict this       */
/*  athlete". This part asks a narrower question the fit cannot answer */
/*  about itself: when this athlete runs HIGH, are they slower by the  */
/*  amount scripts/altitude.mjs's published curve says they should be? */
/*                                                                    */
/*  The baseline is deliberately NOT the ordinary leave-one-out fit    */
/*  above. That fit is trained on every run including the high ones,   */
/*  so it has already absorbed some average altitude cost into its     */
/*  coefficients and would under-report the penalty it is being used   */
/*  to measure. Instead the baseline is a fit over the LOW runs only — */
/*  "what this athlete does near home" — and the high runs are         */
/*  predicted out of sample from it. Each high run is out of sample by */
/*  construction, so no leave-one-out pass is needed.                  */
/*                                                                    */
/*  What this CANNOT separate: altitude from the terrain that comes    */
/*  with it. High runs are usually also rockier, colder and further    */
/*  from the car. The grade term absorbs the vert, nothing absorbs the */
/*  rest, so the observed excess is an upper bound on the altitude     */
/*  cost. The suggestion is a suggestion; the label says so.           */
/* ------------------------------------------------------------------ */

/** How far above home a run has to average before it is "at altitude".
    2,000 ft: far enough that the curve is charging something real at a
    5,000 ft threshold, close enough that a Front Range athlete has some. */
export const HIGH_ALTITUDE_MARGIN_FT = 2000;

/** Minimum high runs before a scale suggestion is worth making. Same
    reasoning as MIN_COHORT: below this one cold, rocky day sets the knob. */
export const MIN_ALTITUDE_COHORT = 5;

/** The altitude_pct knob's range on the planner — a suggestion outside it
    would be unsettable, so it is clamped and reported as clamped. */
export const ALTITUDE_PCT_MAX = 150;

export type AltitudeRun = {
  date: string;
  title: string;
  distance_mi: number;
  mean_ele_ft: number;
  /** out-of-sample prediction from the LOW-altitude fit, s/mi */
  predicted_s_per_mi: number;
  actual_s_per_mi: number;
  /** (actual − predicted)/predicted as a %: how much slower than the
      near-home baseline this run actually was */
  err_pct: number;
  /** what altitudeSlowdown() charges at this run's mean elevation, at 100 %
      of the curve and with no acclimation (a day trip from home) */
  modeled_pct: number;
};

export type AltitudeCalibration = {
  /** what happened, so the UI never has to infer it from null-ness:
      `no-home`      the athlete has not set home elevation — "2,000 ft above
                     home" has no meaning yet
      `no-elevations` climbs.json carries no per-activity mean elevations
                     (sync:streams has not run since this shipped)
      `uncalibrated` fewer than MIN_ALTITUDE_COHORT high runs
      `calibrated`   a suggestion was computed */
  status: "no-home" | "no-elevations" | "uncalibrated" | "calibrated";
  /** high-altitude runs found */
  n: number;
  min_n: number;
  /** mean elevation a run has to beat to count, ft (null without a home) */
  threshold_ft: number | null;
  home_ft: number | null;
  runs: AltitudeRun[];
  /** median observed excess over the near-home baseline, % */
  observed_pct: number | null;
  /** median penalty the published curve charges these same runs, % */
  modeled_pct: number | null;
  /** observed/modeled as a percentage — the altitude_pct the data asks for.
      null whenever the gate is not met or the curve charges nothing. */
  suggested_altitude_pct: number | null;
  /** true when the raw suggestion was outside the knob's range */
  suggestion_clamped: boolean;
  /** one honest line, ready to print */
  label: string;
};

export type Calibration = {
  runs: BackTestRun[];
  by_distance: Band[];
  by_vert: Band[];
  /** the long-effort cohort — the closest thing in training to race day */
  long_cohort: BackTestRun[];
  /** median signed error over the long cohort, or null when too few */
  long_bias_pct: number | null;
  /** Median signed LEAVE-ONE-OUT error in the symmetric band around dRefMi,
      the single point at which projectRace evaluates fitness pace (the fit
      uses every qualifying run — this band is the diagnostic proxy for bias
      near that point, not the set of runs the pace is "read from"). Error
      here scales into the race time; error at 10 mi does not. */
  anchor_bias_pct: number | null;
  anchor_n: number;
  /** the reference distance this fit is read at (fit.dRefMi) and the band
      around it the bias above was measured over — both derived per athlete
      now that the reference comes from the profile, so UI copy reads them
      off the result instead of importing a constant that may not apply. */
  d_ref_mi: number;
  anchor_lo_mi: number;
  anchor_hi_mi: number;
  /** Calibration is NOT a bias correction — it is a deliberate race-day
      conservatism margin the athlete sets. So a suggestion is only made when
      the measured bias is big enough to be worth folding in; below that the
      honest answer is "the fit is accurate, the margin is your call". */
  suggested_calibration_pct: number | null;
  extrapolation: { longest_mi: number; race_mi: number; factor: number };
  /** the altitude back-test — always present, `status` says whether it could
      say anything. Never null: "we could not check this" is a result the
      model check has to show, not an absence it can skip. */
  altitude: AltitudeCalibration;
  flags: Flag[];
};

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

const band = (label: string, rows: BackTestRun[]): Band => ({
  label,
  n: rows.length,
  median_err_pct: median(rows.map((r) => r.err_pct)),
  mean_err_pct: mean(rows.map((r) => r.err_pct)),
});

/** Minimum long efforts before a bias estimate is worth acting on. Below
    this a single unusually good or bad day sets the whole recommendation. */
const MIN_COHORT = 5;
/** Runs shorter than this say nothing about a hundred-miler. Matches the
    floor fitPacing prefers for its own weighted fit. */
const MIN_BACKTEST_MI = 8;
/** Half-width of the symmetric window around the fit's reference distance —
    the point the projection evaluates its fitness pace at. Symmetric on
    purpose: a band reaching far above the reference sweeps in tapered race
    efforts (30k-50k events), which run faster than training and drag the bias
    estimate optimistic. Derived from `fit.dRefMi` at call time so the band
    follows the athlete's own long-run regime. */
export const ANCHOR_HALF_WIDTH_MI = 5;
const MIN_ANCHOR = 4;
/** Below this the measured bias is inside the noise of a handful of runs and
    is not worth moving a deliberate margin for. */
export const BIAS_WORTH_ACTING_ON = 3;

export type CalibrationActivity = {
  /** Strava activity id — the join key into the per-activity mean
      elevations. Absent on an activity the elevation map cannot describe. */
  id?: string | number;
  date?: string;
  title?: string;
  type?: string;
  distance_mi: number;
  elevation_ft: number;
  moving_s: number;
};

export type CalibrationInput = {
  fit: PacingFit | null;
  course: Course | null;
  activities: CalibrationActivity[];
  gradeCurve: PaceGradeCurve;
  /** the calibration currently applied in the planner, percent */
  currentCalibrationPct: number;
  /** now, injectable so the result is deterministic in tests */
  nowMs?: number;
  /** mean elevation per activity id, ft — climbs.json's
      `activity_elevations`, written by scripts/sync-streams.mjs from the
      cached altitude streams. Absent/empty = the back-test reports
      "no-elevations" rather than guessing. */
  meanElevationFtById?: Record<string, number>;
  /** the athlete's acclimated elevation, ft (profile physiology). null =
      not set, and the back-test says so instead of assuming sea level and
      calling every run in the mountains "at altitude". */
  homeElevationFt?: number | null;
  /** the altitude_pct currently applied in the planner, for the "you are at
      X, the data asks for Y" comparison */
  currentAltitudePct?: number;
};

/**
 * The altitude back-test on its own — exported because it is the piece with
 * a testable numeric claim (bias direction, and the >= 5 gate), and because
 * calibrate() needs a fit and a course it does not.
 */
export function calibrateAltitude(input: {
  activities: CalibrationActivity[];
  meanElevationFtById?: Record<string, number>;
  homeElevationFt?: number | null;
  dRefMi: number;
  nowMs?: number;
  currentAltitudePct?: number;
}): AltitudeCalibration {
  const { activities, dRefMi } = input;
  const eleById = input.meanElevationFtById ?? {};
  const home = Number.isFinite(input.homeElevationFt) ? (input.homeElevationFt as number) : null;
  const nowMs = input.nowMs ?? Date.now();
  const empty = {
    n: 0,
    min_n: MIN_ALTITUDE_COHORT,
    runs: [] as AltitudeRun[],
    observed_pct: null,
    modeled_pct: null,
    suggested_altitude_pct: null,
    suggestion_clamped: false,
  };

  if (home == null) {
    return {
      ...empty, status: "no-home", threshold_ft: null, home_ft: null,
      label: "uncalibrated — set your home elevation in the coach settings and this back-test can run.",
    };
  }
  const threshold = home + HIGH_ALTITUDE_MARGIN_FT;

  // Only runs the back-test could place. An activity with no mean elevation
  // is not "low" — it is unknown, and putting it in the baseline would let a
  // 12,000 ft run define what near-home looks like.
  const placed = activities
    .map((a) => ({ a, ele: a.id != null ? eleById[String(a.id)] : undefined }))
    .filter((r): r is { a: CalibrationActivity; ele: number } =>
      Number.isFinite(r.ele) && r.a.distance_mi >= MIN_BACKTEST_MI && r.a.moving_s > 0);

  if (!placed.length) {
    return {
      ...empty, status: "no-elevations", threshold_ft: threshold, home_ft: home,
      label: "uncalibrated — no per-activity elevations yet; run `npm run sync:streams`.",
    };
  }

  const low = placed.filter((r) => r.ele <= threshold);
  const high = placed.filter((r) => r.ele > threshold);

  const baseline = fitPacing(low.map((r) => r.a), nowMs, dRefMi);
  if (!baseline) {
    return {
      ...empty, status: "uncalibrated", n: high.length, threshold_ft: threshold, home_ft: home,
      // The threshold itself is printed once, in the athlete's chosen unit,
      // by the eyebrow line above (ModelCheck.tsx) — this sentence used to
      // repeat it hard-coded in feet, so a metric athlete read the same
      // number twice in two different units one line apart (round-4 finding
      // 9). "your near-home line" points at that eyebrow instead.
      label:
        `uncalibrated — not enough runs below your near-home line to build a baseline ` +
        `to compare the ${high.length} high one${high.length === 1 ? "" : "s"} against.`,
    };
  }

  const runs: AltitudeRun[] = high
    .map(({ a, ele }) => {
      const vfpm = a.elevation_ft / a.distance_mi;
      const predicted = baseline.base + baseline.kVert * vfpm + baseline.kDist * a.distance_mi;
      const actual = a.moving_s / a.distance_mi;
      return {
        date: (a.date ?? "").slice(0, 10),
        title: a.title ?? "untitled",
        distance_mi: a.distance_mi,
        mean_ele_ft: ele,
        predicted_s_per_mi: predicted,
        actual_s_per_mi: actual,
        err_pct: predicted > 0 ? ((actual - predicted) / predicted) * 100 : NaN,
        // the curve as published, at the knob's 100 % and with no
        // acclimation: a training run is a day trip from home
        modeled_pct: altitudeSlowdown({ elevationFt: ele, homeElevationFt: home, acclimationDays: 0 }) * 100,
      };
    })
    .filter((r) => Number.isFinite(r.err_pct))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const observed_pct = runs.length ? median(runs.map((r) => r.err_pct)) : null;
  const modeled_pct = runs.length ? median(runs.map((r) => r.modeled_pct)) : null;

  if (runs.length < MIN_ALTITUDE_COHORT) {
    return {
      ...empty,
      status: "uncalibrated",
      n: runs.length,
      threshold_ft: threshold,
      home_ft: home,
      runs,
      observed_pct,
      modeled_pct,
      label:
        `uncalibrated (${runs.length} high-altitude run${runs.length === 1 ? "" : "s"}, need ${MIN_ALTITUDE_COHORT}) — ` +
        `nothing above your near-home line in enough quantity to check the curve against you.`,
    };
  }

  // The curve charging nothing means every "high" run sat under the
  // threshold the curve itself uses — there is no penalty to scale.
  if (!(modeled_pct != null && modeled_pct > 0)) {
    return {
      ...empty, status: "uncalibrated", n: runs.length, threshold_ft: threshold, home_ft: home,
      runs, observed_pct, modeled_pct,
      label: `uncalibrated — the curve charges nothing at these elevations, so there is no scale to fit.`,
    };
  }

  const rawSuggestion = ((observed_pct as number) / modeled_pct) * 100;
  const clamped = Math.max(0, Math.min(ALTITUDE_PCT_MAX, rawSuggestion));
  const suggestion = Math.round(clamped / 5) * 5;
  const current = input.currentAltitudePct;

  return {
    status: "calibrated",
    n: runs.length,
    min_n: MIN_ALTITUDE_COHORT,
    threshold_ft: threshold,
    home_ft: home,
    runs,
    observed_pct,
    modeled_pct,
    suggested_altitude_pct: suggestion,
    suggestion_clamped: Math.abs(clamped - rawSuggestion) > 0.5,
    label:
      `${runs.length} runs above your near-home line ran ` +
      `${Math.abs(observed_pct as number).toFixed(1)}% ` +
      `${(observed_pct as number) >= 0 ? "slower" : "faster"} than your near-home baseline; the curve charges ` +
      `${modeled_pct.toFixed(1)}% there — altitude ${suggestion}%` +
      (current != null ? ` (you are at ${Math.round(current)}%)` : "") +
      ".",
  };
}

export function calibrate(input: CalibrationInput): Calibration | null {
  const { fit, course, activities, gradeCurve, currentCalibrationPct } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (!fit || !course) return null;
  // The reference distance travels on the fit (profile physiology), so the
  // diagnostic band travels with it.
  const dRef = fit.dRefMi;
  const anchorLo = dRef - ANCHOR_HALF_WIDTH_MI;
  const anchorHi = dRef + ANCHOR_HALF_WIDTH_MI;

  const rows: BackTestRun[] = activities
    .map((a, idx) => ({ a, idx }))
    .filter(({ a }) => a.distance_mi >= MIN_BACKTEST_MI && a.moving_s > 0 && a.elevation_ft != null)
    .map(({ a, idx }) => {
      const vfpm = a.elevation_ft / a.distance_mi;
      // LEAVE-ONE-OUT: refit without this run, then predict it. Predicting a
      // run with a fit that was trained on it flatters the model exactly in
      // the full-weight band this panel treats as its headline. The three
      // coefficients are the fitted model; this does NOT reproduce the full
      // projection pipeline (grade curve, dRefMi anchoring, fatigue) — it
      // validates the coefficients the pipeline is built on, no more.
      //
      // When the refit is impossible (a history so thin that removing one run
      // drops fitPacing below its floor), the row is NOT back-tested — a
      // silent in-sample substitute would make the panel's "every run is
      // held out" claim false exactly for the sparse histories where honesty
      // matters most. Untestable is reported as untested, not as tested.
      const looFit = fitPacing(activities.filter((_, j) => j !== idx), nowMs, dRef);
      if (!looFit) return null;
      const predicted = looFit.base + looFit.kVert * vfpm + looFit.kDist * a.distance_mi;
      const actual = a.moving_s / a.distance_mi;
      return {
        date: (a.date ?? "").slice(0, 10),
        title: a.title ?? "untitled",
        category: a.type ?? "run",
        distance_mi: a.distance_mi,
        vert_ft_per_mi: vfpm,
        predicted_s_per_mi: predicted,
        actual_s_per_mi: actual,
        err_pct: predicted > 0 ? ((actual - predicted) / predicted) * 100 : NaN,
      };
    })
    // drops both the rows whose LOO refit was impossible (null) and any
    // degenerate non-positive prediction — reporting either as a clean 0%
    // would mask exactly the failure it represents
    .filter((r): r is BackTestRun => r != null && Number.isFinite(r.err_pct))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const inRange = (r: BackTestRun, lo: number, hi: number) => r.distance_mi >= lo && r.distance_mi < hi;
  const by_distance = [
    band("8–12 mi", rows.filter((r) => inRange(r, 8, 12))),
    band("12–16 mi", rows.filter((r) => inRange(r, 12, 16))),
    band("16–20 mi", rows.filter((r) => inRange(r, 16, 20))),
    band("20 mi +", rows.filter((r) => r.distance_mi >= 20)),
  ].filter((b) => b.n > 0);

  const inVert = (r: BackTestRun, lo: number, hi: number) => r.vert_ft_per_mi >= lo && r.vert_ft_per_mi < hi;
  const by_vert = [
    band("< 50 ft/mi", rows.filter((r) => r.vert_ft_per_mi < 50)),
    band("50–150", rows.filter((r) => inVert(r, 50, 150))),
    band("150–300", rows.filter((r) => inVert(r, 150, 300))),
    band("300 + ft/mi", rows.filter((r) => r.vert_ft_per_mi >= 300)),
  ].filter((b) => b.n > 0);

  // The long cohort is the athlete's OWN label, not a classifier we invented.
  // Falling back to a distance cut only when the label is unused keeps this
  // working on a Strava history that never set workout types.
  const labelled = rows.filter((r) => r.category === "long");
  const long_cohort = labelled.length >= MIN_COHORT ? labelled : rows.filter((r) => r.distance_mi >= 16);

  // Median, not mean: a tapered race day and a heat-wrecked training run are
  // both real, and both are outliers that a mean would let set policy.
  const long_bias_pct = long_cohort.length >= MIN_COHORT ? median(long_cohort.map((r) => r.err_pct)) : null;

  // Diagnostic band around the reference distance. projectRace evaluates the fitted fitness
  // pace at that single point and lets the fatigue multiplier carry
  // everything past it, so held-out error NEAR that point is what scales
  // into the race time — error at 10 mi does not.
  const anchorRuns = rows.filter((r) => r.distance_mi >= anchorLo && r.distance_mi <= anchorHi);
  const anchor_bias_pct = anchorRuns.length >= MIN_ANCHOR ? median(anchorRuns.map((r) => r.err_pct)) : null;

  // Only suggest when there is a real bias to fold in. Calibration is a
  // judgement margin, not a residual — quietly nudging it by a fraction of a
  // percent every resync would turn the athlete's deliberate hedge into noise.
  const biasForSuggestion = anchor_bias_pct ?? long_bias_pct;
  // Calibration multiplies pace by (1 + pct/100), so stacking a bias
  // correction on top composes MULTIPLICATIVELY — the cross term is sub-
  // rounding at single digits but flips whole points once both are large.
  const suggested_calibration_pct = biasForSuggestion != null && Math.abs(biasForSuggestion) >= BIAS_WORTH_ACTING_ON
    ? Math.round(((1 + currentCalibrationPct / 100) * (1 + biasForSuggestion / 100) - 1) * 100)
    : null;

  const longest_mi = rows.reduce((m, r) => Math.max(m, r.distance_mi), 0);
  const race_mi = course.official_distance_mi ?? course.distance_mi;
  const extrapolation = {
    longest_mi,
    race_mi,
    factor: longest_mi > 0 ? race_mi / longest_mi : Infinity,
  };

  const flags: Flag[] = [];
  const dayMs = 86_400_000;

  const newest = rows[0]?.date ? new Date(rows[0].date).getTime() : null;
  const fitAgeDays = newest ? Math.floor((nowMs - newest) / dayMs) : null;
  flags.push(
    fitAgeDays == null
      ? { id: "fit-age", severity: "warn", label: "no dated runs in the fit", detail: "The projection cannot be aged." }
      : fitAgeDays > 14
      ? { id: "fit-age", severity: "warn", label: `newest run in the fit is ${fitAgeDays} days old`, detail: "The projection is describing older fitness than you currently have. Resync." }
      : { id: "fit-age", severity: "ok", label: `fit current — newest run ${fitAgeDays}d ago`, detail: "" },
  );

  flags.push(
    fit.effN < 10
      ? { id: "sample", severity: "warn", label: `thin sample — effective n ${fit.effN.toFixed(0)}`, detail: "Weighted sample size is small enough that one unusual run moves the whole projection." }
      : { id: "sample", severity: "ok", label: `effective sample n ${fit.effN.toFixed(0)} of ${fit.n}`, detail: "" },
  );

  // "the fatigue curve alone" is only literally true past max(longest, dRef):
  // below dRef the OLS distance term still applies, whatever the athlete has
  // run — so the detail names both boundaries instead of conflating them.
  const uncovered = `No run in the data covers the remaining ${Math.max(0, race_mi - longest_mi).toFixed(0)} mi; past the ${Math.max(longest_mi, dRef).toFixed(0)} mi mark the projected slowdown comes from the fatigue curve (plus any restraint you have set), not from anything you have run.`;
  flags.push(
    longest_mi <= 0
      ? { id: "extrapolation", severity: "warn", label: `no runs of ${MIN_BACKTEST_MI} mi or more to back-test`, detail: "Nothing in the history is long enough to check the projection against. Every number above is extrapolation." }
      : extrapolation.factor > 3
      ? { id: "extrapolation", severity: "warn", label: `race is ${extrapolation.factor.toFixed(1)}× your longest run (${longest_mi.toFixed(0)} mi)`, detail: uncovered }
      : extrapolation.factor > 1.8
      ? { id: "extrapolation", severity: "watch", label: `race is ${extrapolation.factor.toFixed(1)}× your longest run (${longest_mi.toFixed(0)} mi)`, detail: uncovered }
      : { id: "extrapolation", severity: "ok", label: `longest run ${longest_mi.toFixed(0)} mi covers ${(100 / extrapolation.factor).toFixed(0)}% of the race`, detail: "" },
  );

  if (anchor_bias_pct != null && Math.abs(anchor_bias_pct) >= BIAS_WORTH_ACTING_ON) {
    flags.push({
      id: "bias",
      severity: Math.abs(anchor_bias_pct) >= 6 ? "warn" : "watch",
      label: `${Math.abs(anchor_bias_pct).toFixed(1)}% ${anchor_bias_pct > 0 ? "optimistic" : "pessimistic"} at the anchor distance`,
      detail: anchor_bias_pct > 0
        ? `On held-out ${anchorLo.toFixed(0)}–${anchorHi.toFixed(0)} mi runs you finish slower than the refit model predicts. The projection evaluates its fitness pace at the ${dRef.toFixed(0)} mi reference inside this band, so before calibration the projected time runs fast.`
        : `On held-out ${anchorLo.toFixed(0)}–${anchorHi.toFixed(0)} mi runs you finish faster than the refit model predicts. The projection evaluates its fitness pace at the ${dRef.toFixed(0)} mi reference inside this band, so before calibration the projected time runs slow.`,
    });
  } else if (anchor_bias_pct != null) {
    flags.push({ id: "bias", severity: "ok", label: `anchor-band bias ${anchor_bias_pct >= 0 ? "+" : ""}${anchor_bias_pct.toFixed(1)}%`, detail: "" });
  }

  if (gradeCurve?.fitted_at) {
    const ageDays = Math.floor((nowMs - new Date(gradeCurve.fitted_at).getTime()) / dayMs);
    flags.push(
      ageDays > 30
        ? { id: "grade-curve", severity: "watch", label: `grade curve fitted ${ageDays}d ago`, detail: "Re-run the stream sync so climbing cost reflects recent terrain." }
        : { id: "grade-curve", severity: "ok", label: `grade curve fitted ${ageDays}d ago`, detail: "" },
    );
  } else {
    flags.push({ id: "grade-curve", severity: "watch", label: "no personal grade curve", detail: "Climb cost falls back to a generic model; run the stream sync to fit your own." });
  }

  const altitude = calibrateAltitude({
    activities,
    meanElevationFtById: input.meanElevationFtById,
    homeElevationFt: input.homeElevationFt,
    dRefMi: dRef,
    nowMs,
    currentAltitudePct: input.currentAltitudePct,
  });

  return {
    runs: rows,
    by_distance,
    by_vert,
    long_cohort,
    long_bias_pct,
    anchor_bias_pct,
    anchor_n: anchorRuns.length,
    d_ref_mi: dRef,
    anchor_lo_mi: anchorLo,
    anchor_hi_mi: anchorHi,
    suggested_calibration_pct,
    extrapolation,
    altitude,
    flags,
  };
}
