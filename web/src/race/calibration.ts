import { D_REF, fitPacing, type PacingFit, type PaceGradeCurve } from "./pacing";
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

export type Calibration = {
  runs: BackTestRun[];
  by_distance: Band[];
  by_vert: Band[];
  /** the long-effort cohort — the closest thing in training to race day */
  long_cohort: BackTestRun[];
  /** median signed error over the long cohort, or null when too few */
  long_bias_pct: number | null;
  /** Median signed LEAVE-ONE-OUT error in the symmetric band around D_REF,
      the single point at which projectRace evaluates fitness pace (the fit
      uses every qualifying run — this band is the diagnostic proxy for bias
      near that point, not the set of runs the pace is "read from"). Error
      here scales into the race time; error at 10 mi does not. */
  anchor_bias_pct: number | null;
  anchor_n: number;
  /** Calibration is NOT a bias correction — it is a deliberate race-day
      conservatism margin the athlete sets. So a suggestion is only made when
      the measured bias is big enough to be worth folding in; below that the
      honest answer is "the fit is accurate, the margin is your call". */
  suggested_calibration_pct: number | null;
  extrapolation: { longest_mi: number; race_mi: number; factor: number };
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
/** Symmetric window around pacing.ts's D_REF — the point the projection
    evaluates its fitness pace at. Symmetric on purpose: a band reaching
    far above D_REF sweeps in tapered race efforts (30k-50k events), which
    run faster than training and drag the bias estimate optimistic. Derived
    from the exported constant so the two cannot drift apart. */
export const ANCHOR_LO_MI = D_REF - 5;
export const ANCHOR_HI_MI = D_REF + 5;
const MIN_ANCHOR = 4;
/** Below this the measured bias is inside the noise of a handful of runs and
    is not worth moving a deliberate margin for. */
export const BIAS_WORTH_ACTING_ON = 3;

export type CalibrationInput = {
  fit: PacingFit | null;
  course: Course | null;
  activities: Array<{
    date?: string;
    title?: string;
    type?: string;
    distance_mi: number;
    elevation_ft: number;
    moving_s: number;
  }>;
  gradeCurve: PaceGradeCurve;
  /** the calibration currently applied in the planner, percent */
  currentCalibrationPct: number;
  /** now, injectable so the result is deterministic in tests */
  nowMs?: number;
};

export function calibrate(input: CalibrationInput): Calibration | null {
  const { fit, course, activities, gradeCurve, currentCalibrationPct } = input;
  const nowMs = input.nowMs ?? Date.now();
  if (!fit || !course) return null;

  const rows: BackTestRun[] = activities
    .map((a, idx) => ({ a, idx }))
    .filter(({ a }) => a.distance_mi >= MIN_BACKTEST_MI && a.moving_s > 0 && a.elevation_ft != null)
    .map(({ a, idx }) => {
      const vfpm = a.elevation_ft / a.distance_mi;
      // LEAVE-ONE-OUT: refit without this run, then predict it. Predicting a
      // run with a fit that was trained on it flatters the model exactly in
      // the full-weight band this panel treats as its headline. The three
      // coefficients are the fitted model; this does NOT reproduce the full
      // projection pipeline (grade curve, D_REF anchoring, fatigue) — it
      // validates the coefficients the pipeline is built on, no more.
      //
      // When the refit is impossible (a history so thin that removing one run
      // drops fitPacing below its floor), the row is NOT back-tested — a
      // silent in-sample substitute would make the panel's "every run is
      // held out" claim false exactly for the sparse histories where honesty
      // matters most. Untestable is reported as untested, not as tested.
      const looFit = fitPacing(activities.filter((_, j) => j !== idx), nowMs);
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

  // Diagnostic band around D_REF. projectRace evaluates the fitted fitness
  // pace at that single point and lets the fatigue multiplier carry
  // everything past it, so held-out error NEAR that point is what scales
  // into the race time — error at 10 mi does not.
  const anchorRuns = rows.filter((r) => r.distance_mi >= ANCHOR_LO_MI && r.distance_mi <= ANCHOR_HI_MI);
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

  // "the fatigue curve alone" is only literally true past max(longest, D_REF):
  // below D_REF the OLS distance term still applies, whatever the athlete has
  // run — so the detail names both boundaries instead of conflating them.
  const uncovered = `No run in the data covers the remaining ${Math.max(0, race_mi - longest_mi).toFixed(0)} mi; past the ${Math.max(longest_mi, D_REF).toFixed(0)} mi mark the projected slowdown comes from the fatigue curve (plus any restraint you have set), not from anything you have run.`;
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
        ? `On held-out ${ANCHOR_LO_MI}–${ANCHOR_HI_MI} mi runs you finish slower than the refit model predicts. The projection evaluates its fitness pace at the ${D_REF} mi reference inside this band, so before calibration the projected time runs fast.`
        : `On held-out ${ANCHOR_LO_MI}–${ANCHOR_HI_MI} mi runs you finish faster than the refit model predicts. The projection evaluates its fitness pace at the ${D_REF} mi reference inside this band, so before calibration the projected time runs slow.`,
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

  return {
    runs: rows,
    by_distance,
    by_vert,
    long_cohort,
    long_bias_pct,
    anchor_bias_pct,
    anchor_n: anchorRuns.length,
    suggested_calibration_pct,
    extrapolation,
    flags,
  };
}
