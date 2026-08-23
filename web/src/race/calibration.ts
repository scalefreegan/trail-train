import type { PacingFit, PaceGradeCurve } from "./pacing";
import type { Course } from "./types";

/* ------------------------------------------------------------------ */
/*  Projection confidence — does the pacing model actually predict THIS */
/*  athlete, and are its inputs still current?                        */
/*                                                                    */
/*  projectRace turns a fit into a race time; nothing until now asked  */
/*  whether that fit is any good. The fit is unbiased across its own   */
/*  training set by construction (it is least squares), so a headline  */
/*  residual says nothing useful. Bias lives in the SUBGROUPS: if the  */
/*  model is optimistic on long days and pessimistic on short ones,    */
/*  the overall residual still averages to zero while every number the */
/*  race planner prints is wrong in the same direction.               */
/*                                                                    */
/*  So: back-test per band, report signed error, and derive the        */
/*  calibration knob from the bands that resemble race day instead of  */
/*  leaving it a hand-set guess. Suggest only — never auto-apply.     */
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
  /** Median signed error in the band around D_REF, the distance at which
      projectRace evaluates fitness pace. This is the bias that actually
      propagates into the race time — a model can be unbiased overall and
      still be wrong exactly where the projection reads it. */
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
/** Window around pacing.ts's D_REF (20 mi) — the distance regime the race
    projection reads its fitness pace from. Wide enough to hold a useful
    number of long runs, narrow enough that it is still that regime. */
const ANCHOR_LO_MI = 16;
const ANCHOR_HI_MI = 30;
const MIN_ANCHOR = 4;
/** Below this the measured bias is inside the noise of a handful of runs and
    is not worth moving a deliberate margin for. */
const BIAS_WORTH_ACTING_ON = 3;

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
    .filter((a) => a.distance_mi >= MIN_BACKTEST_MI && a.moving_s > 0 && a.elevation_ft != null)
    .map((a) => {
      const vfpm = a.elevation_ft / a.distance_mi;
      // the fit's own prediction for this run — same three terms projectRace
      // is built on, evaluated at the run's real distance rather than D_REF
      const predicted = fit.base + fit.kVert * vfpm + fit.kDist * a.distance_mi;
      const actual = a.moving_s / a.distance_mi;
      return {
        date: (a.date ?? "").slice(0, 10),
        title: a.title ?? "untitled",
        category: a.type ?? "run",
        distance_mi: a.distance_mi,
        vert_ft_per_mi: vfpm,
        predicted_s_per_mi: predicted,
        actual_s_per_mi: actual,
        err_pct: predicted > 0 ? ((actual - predicted) / predicted) * 100 : 0,
      };
    })
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

  // The band the projection actually reads from. projectRace evaluates the
  // fitted fitness pace at D_REF and lets the fatigue multiplier carry
  // everything past it, so error HERE is what scales into the race time —
  // error at 10 mi does not.
  const anchorRuns = rows.filter((r) => r.distance_mi >= ANCHOR_LO_MI && r.distance_mi <= ANCHOR_HI_MI);
  const anchor_bias_pct = anchorRuns.length >= MIN_ANCHOR ? median(anchorRuns.map((r) => r.err_pct)) : null;

  // Only suggest when there is a real bias to fold in. Calibration is a
  // judgement margin, not a residual — quietly nudging it by a fraction of a
  // percent every resync would turn the athlete's deliberate hedge into noise.
  const biasForSuggestion = anchor_bias_pct ?? long_bias_pct;
  const suggested_calibration_pct = biasForSuggestion != null && Math.abs(biasForSuggestion) >= BIAS_WORTH_ACTING_ON
    ? Math.round(currentCalibrationPct + biasForSuggestion)
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

  flags.push(
    extrapolation.factor > 3
      ? { id: "extrapolation", severity: "warn", label: `race is ${extrapolation.factor.toFixed(1)}× your longest run`, detail: `Everything past ${longest_mi.toFixed(0)} mi is the fatigue multiplier alone — no run in the data covers it.` }
      : extrapolation.factor > 1.8
      ? { id: "extrapolation", severity: "watch", label: `race is ${extrapolation.factor.toFixed(1)}× your longest run (${longest_mi.toFixed(0)} mi)`, detail: "Beyond that distance the projection rests on the fatigue curve rather than on anything you have run." }
      : { id: "extrapolation", severity: "ok", label: `longest run ${longest_mi.toFixed(0)} mi covers ${(100 / extrapolation.factor).toFixed(0)}% of the race`, detail: "" },
  );

  if (anchor_bias_pct != null && Math.abs(anchor_bias_pct) >= BIAS_WORTH_ACTING_ON) {
    flags.push({
      id: "bias",
      severity: Math.abs(anchor_bias_pct) >= 6 ? "warn" : "watch",
      label: `${Math.abs(anchor_bias_pct).toFixed(1)}% ${anchor_bias_pct > 0 ? "optimistic" : "pessimistic"} at the anchor distance`,
      detail: anchor_bias_pct > 0
        ? `On ${ANCHOR_LO_MI}–${ANCHOR_HI_MI} mi runs you finish slower than the fit predicts, and that is the band the race projection reads its pace from — so before calibration the projected time runs fast.`
        : `On ${ANCHOR_LO_MI}–${ANCHOR_HI_MI} mi runs you finish faster than the fit predicts, and that is the band the race projection reads its pace from — so before calibration the projected time runs slow.`,
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
