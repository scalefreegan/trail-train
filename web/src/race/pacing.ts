import type { Course, CourseAidStation, CourseProfilePoint } from "./types";

/* ------------------------------------------------------------------ */
/*  Personal pacing model + race-day projection.                       */
/*                                                                     */
/*  Descended from fitPacing() in scripts/facts.mjs (same model and    */
/*  normal-equations solver), but this client version is a WEIGHTED    */
/*  least squares: race projections should be anchored to the efforts  */
/*  that look like race day — long, recent, aerobic — not to short     */
/*  fast training runs. It runs client-side on useStrava().activities  */
/*  so the planner sliders recompute live without a sync round-trip.   */
/* ------------------------------------------------------------------ */

export type PacingFit = {
  /** flat-ground pace intercept, seconds per mile */
  base: number;
  /** added s/mi per (vert ft per mile) */
  kVert: number;
  /** added s/mi per mile of session distance */
  kDist: number;
  /** weighted residual std dev, s/mi — the ± band */
  residStd: number;
  /** rows in the fit */
  n: number;
  /** effective sample size after weighting, (Σw)²/Σw² */
  effN: number;
  /** human-readable description of what was fit */
  basis: string;
};

type FitInput = {
  distance_mi: number;
  elevation_ft: number;
  moving_s: number;
  date?: string;
  avg_hr?: number | null;
};

/** Recency time constant (τ) for fit weights, in days: weight = e^(−age/τ).
    75-day e-folding ⇒ true half-life ≈ 52 days (τ·ln2), not 75. */
const RECENCY_TAU_DAYS = 75;
/** Distance at (and beyond) which a run gets full distance weight. */
const FULL_WEIGHT_DIST_MI = 13;

export function fitPacing(acts: FitInput[], nowMs: number = Date.now()): PacingFit | null {
  const all = acts.filter((a) => a.distance_mi >= 2 && a.moving_s > 0 && a.elevation_ft != null);

  // Longer efforts only — raise the distance floor as far as sample size allows.
  let minDist = 8;
  let rows = all.filter((a) => a.distance_mi >= minDist);
  if (rows.length < 8) { minDist = 5; rows = all.filter((a) => a.distance_mi >= minDist); }
  if (rows.length < 8) { minDist = 2; rows = all; }
  if (rows.length < 8) return null;

  // Aerobic reference: median avg HR across the rows that have one.
  const hrs = rows.map((a) => a.avg_hr).filter((h): h is number => h != null && h > 0).sort((a, b) => a - b);
  const hrMed = hrs.length >= 5 ? hrs[Math.floor(hrs.length / 2)] : null;

  const data = rows.map((a) => {
    const ageDays = a.date ? Math.max(0, (nowMs - new Date(a.date).getTime()) / 86_400_000) : 90;
    const wRecency = Math.exp(-ageDays / RECENCY_TAU_DAYS);
    const wDist = Math.min(1, Math.max(0.15, a.distance_mi / FULL_WEIGHT_DIST_MI));
    // runs at/below the aerobic median count fully; harder efforts fade fast
    let wHr = 1;
    if (hrMed != null && a.avg_hr != null && a.avg_hr > 0) {
      const rel = a.avg_hr / hrMed;
      wHr = rel <= 1 ? 1 : Math.max(0.2, 1 - (rel - 1) * 5);
    }
    return {
      w: wRecency * wDist * wHr,
      vfpm: a.elevation_ft / a.distance_mi,
      dmi: a.distance_mi,
      y: a.moving_s / a.distance_mi,
    };
  });

  // weighted 3x3 normal equations for features [1, vfpm, dmi]
  const Sxx = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Sxy = [0, 0, 0];
  for (const { w, vfpm, dmi, y } of data) {
    const f = [1, vfpm, dmi];
    for (let i = 0; i < 3; i++) {
      Sxy[i] += w * f[i] * y;
      for (let j = 0; j < 3; j++) Sxx[i][j] += w * f[i] * f[j];
    }
  }
  // Gaussian elimination with partial pivoting on the augmented matrix
  const M = Sxx.map((row, i) => [...row, Sxy[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-9) return null; // singular — not enough spread
    const piv = M[c][c];
    M[c] = M[c].map((x) => x / piv);
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const fac = M[r][c];
      M[r] = M[r].map((x, k) => x - fac * M[c][k]);
    }
  }
  const [base, kVert, kDist] = [M[0][3], M[1][3], M[2][3]];
  const predict = (vfpm: number, dmi: number) => base + kVert * vfpm + kDist * dmi;

  const sumW = data.reduce((s, d) => s + d.w, 0);
  const sumW2 = data.reduce((s, d) => s + d.w * d.w, 0);
  const wResid2 = data.reduce((s, d) => s + d.w * (d.y - predict(d.vfpm, d.dmi)) ** 2, 0);
  const residStd = Math.sqrt(wResid2 / Math.max(1e-9, sumW));
  const effN = sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;

  return {
    base, kVert, kDist, residStd,
    n: rows.length,
    effN: Math.round(effN),
    basis: `${rows.length} runs ≥${minDist}mi · weighted long/recent/aerobic`,
  };
}

/* ------------------------------------------------------------------ */
/*  Race projection                                                    */
/* ------------------------------------------------------------------ */

export type Scenario = "best" | "avg" | "worst";

export type StationProjection = {
  station: CourseAidStation;
  seg_mi: number;
  seg_gain_ft: number;
  /** projected pace over this segment (s/mi, avg scenario, incl. fatigue) */
  seg_pace_s_per_mi: number;
  /** same, best/worst scenarios (±fit band) — the paces behind those ETA columns */
  seg_pace_best_s_per_mi: number;
  seg_pace_worst_s_per_mi: number;
  /** pace this segment must be run at to hit the goal (s/mi — the avg pace
      uniformly rescaled to the goal's moving time), or null with no goal */
  goal_pace_s_per_mi: number | null;
  /** planned stop at this station, minutes (0 at the finish) */
  stop_min: number;
  /** cumulative elapsed hours at ARRIVAL (includes dwell at prior stations) */
  eta_h: Record<Scenario, number>;
  goal_eta_h: number | null;
  /** cutoff_h − avg arrival; null when no cutoff posted */
  cutoff_margin_h: number | null;
  cutoff_margin_worst_h: number | null;
};

/** One point of a pace-vs-grade multiplier curve (F(0) = 1). */
export type GradeCurvePoint = { g: number; mult: number };
/** Personal curve payload from /pace-grade.json (fitted by sync-streams). */
export type PaceGradeCurve = { basis?: string; curve: GradeCurvePoint[] } | null;

export type ProjectOptions = {
  /** pace degradation per 10 miles, compounding — e.g. 5 → ×1.05 every 10 mi */
  fatiguePctPer10mi: number;
  /** personal pace-vs-grade curve; null/absent → kVert-anchored fallback */
  gradeCurve?: PaceGradeCurve;
  /** race-pace calibration, % added to ALL projected paces — corrects for the
      fit being trained on runs that are stronger efforts than race-sustainable
      pace. e.g. 6 → every pace ×1.06 */
  calibrationPct?: number;
  /** deliberate first-half restraint, % slower than model pace through mile
      RESTRAINT_FULL_MI (tapering to 0 by RESTRAINT_END_MI). Restrained miles
      also age the athlete less: they count (1 − payoff·restraint) miles on the
      fatigue clock, so holding back early buys a flatter late-race fade. */
  restraintPct?: number;
  /** target finish in hours, or null to skip the goal overlay */
  goalH: number | null;
  /** fresh stop minutes at a regular aid station (scales up late-race) */
  aidStopMin?: number;
  /** fresh stop minutes where crew / drop bags are (scales up late-race) */
  crewStopMin?: number;
  /** per-station stop overrides by station name, minutes — taken literally
      (no fatigue scaling) and winning over the defaults */
  stopOverridesMin?: Record<string, number>;
};

export type RaceProjection = {
  stations: StationProjection[];
  finish_h: Record<Scenario, number>;
  /** total time stopped at stations, hours (same in every scenario) */
  stopped_h: number;
  goal_h: number | null;
  /** course-mile → elapsed hours at profile resolution (avg unless given) */
  elapsedAtMile: (mi: number, scenario?: Scenario) => number;
  /** inverse of elapsedAtMile — used to place time-based bands (night) on the mile axis */
  mileAtElapsed: (h: number, scenario?: Scenario) => number;
  /** grade/terrain-adjusted pace (s/mi, avg scenario, all multipliers) at a course mile */
  paceAtMile: (mi: number) => number;
  /** which grade-response curve drove the projection (for the model footer) */
  grade_basis: string;
};

/* ------------------- grade-response curve ------------------- */

/** 1% grade sustained for a mile = 52.8 ft of gain. */
const FT_PER_MI_PER_PCT = 52.8;

/** Standard downhill shape (GAP-like): gentle downs help, ~-8% is the
    optimum, steep technical descents cost more than flat. Used when no
    personal curve covers a grade. */
const DOWNHILL_FALLBACK: [number, number][] = [
  [-30, 1.6], [-25, 1.38], [-20, 1.2], [-15, 1.05], [-12, 0.97],
  [-10, 0.93], [-8, 0.91], [-6, 0.92], [-4, 0.94], [-2, 0.97], [0, 1],
];

function interpPairs(table: [number, number][], g: number): number {
  if (g <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (g <= table[i][0]) {
      const [g0, m0] = table[i - 1];
      const [g1, m1] = table[i];
      return m0 + ((g - g0) / (g1 - g0)) * (m1 - m0);
    }
  }
  return table[table.length - 1][1];
}

/**
 * Build the grade → pace-multiplier function.
 * - Personal curve (fitted from the athlete's own streams) when available;
 *   outside its data range it extends with the fallback SHAPE scaled for
 *   continuity at the edge.
 * - Fallback: uphill is the linear kVert cost from the pacing fit expressed
 *   per-grade (exactly the OLS model, so no-curve behavior stays anchored to
 *   the athlete's aggregate climb cost); downhill is the standard shape.
 */
function makeGradeFn(fit: PacingFit, personal: PaceGradeCurve | undefined): { f: (g: number) => number; basis: string } {
  const pFlat = fit.base + fit.kDist * D_REF;
  const fb = (g: number) =>
    g >= 0 ? 1 + (fit.kVert * FT_PER_MI_PER_PCT * g) / pFlat : interpPairs(DOWNHILL_FALLBACK, g);
  const pts = personal?.curve && personal.curve.length >= 6
    ? [...personal.curve].sort((a, b) => a.g - b.g)
    : null;
  if (!pts) return { f: fb, basis: "kVert-anchored standard curve (no personal fit yet)" };
  const table: [number, number][] = pts.map((p) => [p.g, p.mult]);
  const gMin = table[0][0];
  const gMax = table[table.length - 1][0];
  const f = (g: number) => {
    if (g < gMin) return interpPairs(table, gMin) * (fb(g) / fb(gMin));
    if (g > gMax) return interpPairs(table, gMax) * (fb(g) / fb(gMax));
    return interpPairs(table, g);
  };
  return { f, basis: personal?.basis ? `personal grade curve — ${personal.basis}` : "personal grade curve" };
}

/** Segment gain from the course profile with a ±10 ft hysteresis accumulator
    (fallback for stations whose official seg_gain_ft is not published). */
function gainBetween(profile: CourseProfilePoint[], fromMi: number, toMi: number): number {
  let gain = 0;
  let anchor: number | null = null;
  for (const p of profile) {
    if (p.mi < fromMi || p.mi > toMi) continue;
    if (anchor == null) { anchor = p.ele_ft; continue; }
    const d = p.ele_ft - anchor;
    if (d > 10) { gain += d; anchor = p.ele_ft; }
    else if (d < -10) { anchor = p.ele_ft; }
  }
  return gain;
}

/** Reference distance (mi) at which the fitted fitness pace is evaluated — the
    athlete's long-run regime. See projectRace's note on why kDist isn't
    extrapolated to total_mi. */
const D_REF = 20;

/** First-half restraint window: full hold-back through mile 50, tapering
    linearly to zero by mile 60 (no pace cliff at an aid station boundary). */
const RESTRAINT_FULL_MI = 50;
const RESTRAINT_END_MI = 60;

/** How strongly restraint pays down the fatigue clock: each restrained mile
    counts (1 − PAYOFF·restraint) fatigue-miles. At 8% restraint each early
    mile ages you ~16% less — banking energy, not time. */
const RESTRAINT_FATIGUE_PAYOFF = 2;

/** Restraint weight at a course mile: 1 through the full window, linear taper
    to 0 across the taper zone. */
function restraintWeight(mi: number): number {
  if (mi <= RESTRAINT_FULL_MI) return 1;
  if (mi >= RESTRAINT_END_MI) return 0;
  return (RESTRAINT_END_MI - mi) / (RESTRAINT_END_MI - RESTRAINT_FULL_MI);
}

/** Integral of restraintWeight from 0 to mi (closed form for the piecewise
    linear shape) — used to compute cumulative fatigue-miles. */
function restraintWeightIntegral(mi: number): number {
  const full = Math.min(mi, RESTRAINT_FULL_MI);
  let s = full;
  if (mi > RESTRAINT_FULL_MI) {
    const m1 = Math.min(mi, RESTRAINT_END_MI);
    s += ((restraintWeight(RESTRAINT_FULL_MI) + restraintWeight(m1)) / 2) * (m1 - RESTRAINT_FULL_MI);
  }
  return s;
}

/**
 * Project best/avg/worst arrival times at every aid station.
 *
 * Modeling notes:
 * - Times are INTEGRATED over the course profile (~0.06 mi steps): each step
 *   is priced by the grade-response curve at that point's grade (personal
 *   curve from streams when fitted, else the kVert-anchored fallback), plus
 *   fatigue/restraint at that mile and the segment's technicality factor.
 *   Station splits are the integrals between station boundaries — reported
 *   split paces are true terrain-weighted averages.
 * - kDist was fitted on training runs ≤ ~26 mi. Linearly extrapolating it to
 *   mile 100 double-counts fatigue and explodes, so the fitness pace is
 *   evaluated at a fixed reference distance (D_REF = 20 mi, the athlete's
 *   long-run regime) and ALL ultra-distance slowdown comes from the explicit
 *   fatigue multiplier. Don't "fix" this back to kDist·total_mi.
 * - Fatigue COMPOUNDS: mult(mi) = (1 + f)^(fatigueMiles(mi)/10). Ultra fade is
 *   nonlinear — mild through 50, heavy after 80 (at 5%: ×1.28 @50mi, ×1.63
 *   @100mi). With restraint, fatigue-miles accrue slower than course miles
 *   through the restraint window (see RESTRAINT_FATIGUE_PAYOFF), so the late
 *   fade flattens — that's the modeled payoff of going out easy.
 * - calibrationPct multiplies every pace: the fit comes from training runs
 *   that are stronger efforts than race-sustainable pace, so raw fit paces
 *   read optimistic for a 100.
 * - restraintPct slows miles 0–50 on purpose (tapering to 0 by 60): banking
 *   energy for a relatively stronger second 50.
 * - Station stops scale with the same fatigue curve (you linger longer at
 *   mile 80 than mile 20), capped at 2× the fresh stop.
 */
export function projectRace(course: Course, fit: PacingFit, opts: ProjectOptions): RaceProjection {
  const f = opts.fatiguePctPer10mi / 100;
  const cal = 1 + (opts.calibrationPct ?? 0) / 100;
  const r = (opts.restraintPct ?? 0) / 100;
  const aidStopS = (opts.aidStopMin ?? 5) * 60;
  const crewStopS = (opts.crewStopMin ?? 10) * 60;
  const stations = course.aid_stations;
  const fatigueMiles = (mi: number) => mi - RESTRAINT_FATIGUE_PAYOFF * r * restraintWeightIntegral(mi);
  const mult = (mi: number) => Math.pow(1 + f, fatigueMiles(mi) / 10);
  const effort = (mi: number) => 1 + r * restraintWeight(mi);

  const segs = stations.map((st, i) => {
    const prev = i === 0 ? null : stations[i - 1];
    const prevMi = prev ? prev.total_mi : 0; // official chart miles — pace/time math
    const seg_mi = Math.max(0, st.total_mi - prevMi);
    // Gain fallback slices the profile, which is indexed in MEASURED gpx miles,
    // so bound it in gpx_mi (not official total_mi) to avoid a space mismatch.
    const seg_gain_ft = st.seg_gain_ft
      ?? gainBetween(course.profile, prev ? prev.gpx_mi : 0, st.gpx_mi);
    return { st, prevMi, seg_mi, seg_gain_ft };
  });

  // ── full-course integration over the profile ─────────────────────────
  // Moving time accumulates point-by-point (~0.06 mi steps): each step is
  // priced by the athlete's grade-response curve at THAT point's grade, plus
  // fatigue/restraint at that mile and the segment's technicality factor —
  // no more "average gain rate over a 10-mile split".
  const { f: rawGradeF, basis: rawBasis } = makeGradeFn(fit, opts.gradeCurve);
  const pFlat = fit.base + fit.kDist * D_REF;
  const paceShift: Record<Scenario, number> = { best: -fit.residStd, avg: 0, worst: fit.residStd };

  // Anchor the curve's AGGREGATE to the fitted climb cost. The personal
  // curve is normalized within-run (a hilly run's own flat baseline is
  // already slowed by that day's altitude/tech/fatigue), so its raw
  // multipliers understate cost relative to fresh flat pace — used raw it
  // projected an implausibly fast race. Scaling the excess (F−1) so the
  // course-average multiplier equals what kVert charges for the course's
  // average gain rate keeps the OLS fit as the source of truth for HOW MUCH
  // climbing costs, while the grade curve decides WHERE the time goes.
  let gradeF = rawGradeF;
  let grade_basis = rawBasis;
  {
    const pp = course.profile;
    let sumF = 0, dist = 0, gain = 0;
    for (let k = 1; k < pp.length; k++) {
      const step = Math.max(0, pp[k].mi - pp[k - 1].mi);
      sumF += rawGradeF(pp[k - 1].grade_pct) * step;
      dist += step;
      const dEle = pp[k].ele_ft - pp[k - 1].ele_ft;
      if (dEle > 0) gain += dEle;
    }
    const meanF = dist > 0 ? sumF / dist : 1;
    const olsMult = 1 + (fit.kVert * (dist > 0 ? gain / dist : 0)) / pFlat;
    if (meanF > 1.02 && olsMult > 1.02) {
      const lambda = Math.min(4, Math.max(0.5, (olsMult - 1) / (meanF - 1)));
      if (Math.abs(lambda - 1) > 0.05) {
        gradeF = (g: number) => 1 + lambda * (rawGradeF(g) - 1);
        grade_basis = `${rawBasis} · excess ×${lambda.toFixed(2)} to match fitted climb cost`;
      }
    }
  }

  // technicality per gpx-space segment (segment INTO each station)
  const techSegs = segs.map(({ st }, i) => ({
    x0: i === 0 ? 0 : segs[i - 1].st.gpx_mi,
    x1: st.gpx_mi,
    factor: 1 + ((st.tech_pct ?? 0) / 100),
  }));
  const techAt = (mi: number) => techSegs.find((t) => mi >= t.x0 && mi < t.x1)?.factor
    ?? techSegs[techSegs.length - 1]?.factor ?? 1;

  const pts = course.profile;
  const nPts = pts.length;
  const cum: Record<Scenario, Float64Array> = {
    best: new Float64Array(nPts), avg: new Float64Array(nPts), worst: new Float64Array(nPts),
  };
  const pacePoint = new Float64Array(nPts); // avg-scenario pace used from pt k → k+1 (s/mi)
  for (let k = 1; k < nPts; k++) {
    const step = Math.max(0, pts[k].mi - pts[k - 1].mi);
    const midMi = (pts[k].mi + pts[k - 1].mi) / 2;
    const gF = gradeF(pts[k - 1].grade_pct);
    // fatigue/restraint/technicality scale the floored fresh grade pace
    const lateMult = mult(midMi) * effort(midMi) * techAt(midMi);
    for (const sc of ["best", "avg", "worst"] as Scenario[]) {
      const freshGradePace = Math.max(300, (pFlat + paceShift[sc]) * cal * gF);
      cum[sc][k] = cum[sc][k - 1] + step * freshGradePace * lateMult;
    }
    pacePoint[k - 1] = step > 0 ? (cum.avg[k] - cum.avg[k - 1]) / step : pacePoint[Math.max(0, k - 2)];
  }
  if (nPts > 1) pacePoint[nPts - 1] = pacePoint[nPts - 2];

  // cumulative moving seconds at an arbitrary course mile (binary search + lerp)
  const cumAt = (sc: Scenario, mi: number) => {
    const arr = cum[sc];
    if (mi <= pts[0].mi) return 0;
    if (mi >= pts[nPts - 1].mi) return arr[nPts - 1];
    let lo = 0, hi = nPts - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].mi <= mi) lo = mid; else hi = mid;
    }
    const span = pts[hi].mi - pts[lo].mi;
    const t = span > 0 ? (mi - pts[lo].mi) / span : 1;
    return arr[lo] + t * (arr[hi] - arr[lo]);
  };

  // moving time per segment per scenario (before stops) — integrated
  const segTimes = segs.map(({ st }, i) => {
    const x0 = i === 0 ? 0 : segs[i - 1].st.gpx_mi;
    const out = {} as Record<Scenario, number>;
    for (const sc of ["best", "avg", "worst"] as Scenario[]) {
      out[sc] = Math.max(0, cumAt(sc, st.gpx_mi) - cumAt(sc, x0));
    }
    return out;
  });

  // Stop time applies at every intermediate station once you've arrived —
  // a station's own arrival excludes its stop, later stations include it.
  // Crew zones count too (meeting your crew takes real minutes).
  const overrides = opts.stopOverridesMin ?? {};
  const stopAt = (st: CourseAidStation, isLast: boolean) => {
    if (isLast) return 0; // no dwell at the finish — checked before any override
    const o = overrides[st.name];
    if (o != null && Number.isFinite(o)) return Math.max(0, o) * 60;
    const fresh = st.crew || st.drop_bag ? crewStopS : aidStopS;
    return fresh * Math.min(2, mult(st.total_mi));
  };

  const arrive: Record<Scenario, number[]> = { best: [], avg: [], worst: [] };
  const depart: Record<Scenario, number[]> = { best: [], avg: [], worst: [] };
  for (const sc of ["best", "avg", "worst"] as Scenario[]) {
    let t = 0;
    segs.forEach(({ st }, i) => {
      t += segTimes[i][sc];
      arrive[sc].push(t);
      t += stopAt(st, i === segs.length - 1);
      depart[sc].push(t);
    });
  }

  // goal overlay: scale avg *moving* time to hit goalH, stops held constant
  const totalStopS = segs.reduce((s, { st }, i) => s + stopAt(st, i === segs.length - 1), 0);
  const avgMovingTotalS = segTimes.reduce((s, t) => s + t.avg, 0);
  let goalArrive: number[] | null = null;
  let goalScale: number | null = null;
  if (opts.goalH != null && avgMovingTotalS > 0) {
    const goalMovingS = Math.max(0, opts.goalH * 3600 - totalStopS);
    goalScale = goalMovingS / avgMovingTotalS;
    const scale = goalScale;
    let moving = 0, stopped = 0;
    goalArrive = segs.map(({ st }, i) => {
      moving += segTimes[i].avg * scale;
      const at = moving + stopped;
      stopped += stopAt(st, i === segs.length - 1);
      return at;
    });
  }

  const projections: StationProjection[] = segs.map(({ st, seg_mi, seg_gain_ft }, i) => {
    const avgH = arrive.avg[i] / 3600;
    const worstH = arrive.worst[i] / 3600;
    return {
      station: st,
      seg_mi,
      seg_gain_ft,
      seg_pace_s_per_mi: seg_mi > 0 ? segTimes[i].avg / seg_mi : 0,
      seg_pace_best_s_per_mi: seg_mi > 0 ? segTimes[i].best / seg_mi : 0,
      seg_pace_worst_s_per_mi: seg_mi > 0 ? segTimes[i].worst / seg_mi : 0,
      goal_pace_s_per_mi: goalScale != null && seg_mi > 0 ? (segTimes[i].avg * goalScale) / seg_mi : null,
      stop_min: Math.round(stopAt(st, i === segs.length - 1) / 60),
      eta_h: { best: arrive.best[i] / 3600, avg: avgH, worst: worstH },
      goal_eta_h: goalArrive ? goalArrive[i] / 3600 : null,
      cutoff_margin_h: st.cutoff_h != null ? st.cutoff_h - avgH : null,
      cutoff_margin_worst_h: st.cutoff_h != null ? st.cutoff_h - worstH : null,
    };
  });

  const last = segs.length - 1;
  const finish_h: Record<Scenario, number> = {
    best: arrive.best[last] / 3600,
    avg: arrive.avg[last] / 3600,
    worst: arrive.worst[last] / 3600,
  };

  // mile ↔ elapsed maps at PROFILE resolution (dwell = vertical step at the
  // station mile) — a climb at the end of a long split now shows up in the
  // hover ETA instead of being smeared linearly across the split.
  // Miles here are MEASURED gpx_mi — the chart's axis space and the profile's
  // space, so callers (hover ETAs, night bands) share one axis; official
  // total_mi drives only the display column.
  const stationStops = segs.map(({ st }, i) => ({
    mi: st.gpx_mi,
    stopS: stopAt(st, i === segs.length - 1),
  }));
  const dwellBefore = (mi: number) => {
    let s = 0;
    for (const st of stationStops) {
      if (st.mi < mi) s += st.stopS;
      else break;
    }
    return s;
  };

  const elapsedAtMile = (mi: number, sc: Scenario = "avg") =>
    (cumAt(sc, Math.max(0, mi)) + dwellBefore(mi)) / 3600;

  const mileAtElapsed = (h: number, sc: Scenario = "avg") => {
    const target = h * 3600;
    if (target <= 0) return 0;
    // walk stations: within each dwell window the runner sits at the station
    let dwell = 0;
    let prevMi = 0;
    for (const st of stationStops) {
      const arriveS = cumAt(sc, st.mi) + dwell;
      if (target <= arriveS) {
        // moving somewhere in (prevMi, st.mi] — binary search the cum array
        const movingTarget = target - dwell;
        let lo = 0, hi = nPts - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (cum[sc][mid] <= movingTarget) lo = mid; else hi = mid;
        }
        const span = cum[sc][hi] - cum[sc][lo];
        const t = span > 0 ? (movingTarget - cum[sc][lo]) / span : 1;
        return Math.max(prevMi, Math.min(st.mi, pts[lo].mi + t * (pts[hi].mi - pts[lo].mi)));
      }
      if (target <= arriveS + st.stopS) return st.mi; // sitting at this station
      dwell += st.stopS;
      prevMi = st.mi;
    }
    return pts[nPts - 1].mi;
  };

  const paceAtMile = (mi: number) => {
    if (nPts < 2) return 0;
    if (mi <= pts[0].mi) return pacePoint[0];
    if (mi >= pts[nPts - 1].mi) return pacePoint[nPts - 1];
    let lo = 0, hi = nPts - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].mi <= mi) lo = mid; else hi = mid;
    }
    return pacePoint[lo];
  };

  return {
    stations: projections, finish_h, stopped_h: totalStopS / 3600, goal_h: opts.goalH,
    elapsedAtMile, mileAtElapsed, paceAtMile, grade_basis,
  };
}

/* ------------------------------------------------------------------ */
/*  Clock helpers                                                      */
/* ------------------------------------------------------------------ */

/** "18:35" → 18.583 */
export function clockToH(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h + (m || 0) / 60;
}

/** Elapsed hours → Date on the race clock. */
export function elapsedToDate(raceStart: Date, elapsedH: number): Date {
  return new Date(raceStart.getTime() + elapsedH * 3600_000);
}

/** Format an elapsed race hour as a clock time, with +1/+2 day marker. */
export function fmtRaceClock(raceStart: Date, elapsedH: number): string {
  const d = elapsedToDate(raceStart, elapsedH);
  const days = Math.floor((d.getTime() - new Date(raceStart).setHours(0, 0, 0, 0)) / 86_400_000);
  const hh = d.getHours();
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ampm = hh >= 12 ? "p" : "a";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${mm}${ampm}${days > 0 ? `+${days}` : ""}`;
}

/** Format elapsed hours as "31h 24m". */
export function fmtElapsed(h: number): string {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${hh}h ${String(mm).padStart(2, "0")}m`;
}

/**
 * Night windows in elapsed race hours: darkness = clock time past sunset or
 * before sunrise. Returns [startH, endH] intervals clipped to [0, horizonH].
 */
export function nightIntervals(
  startClock: string, sunset: string, sunrise: string, horizonH: number,
): Array<[number, number]> {
  const start = clockToH(startClock);
  const set = clockToH(sunset);
  const rise = clockToH(sunrise);
  const out: Array<[number, number]> = [];
  // first sunset after the race start, then repeat every 24h
  let s = set - start;
  if (s < 0) s += 24;
  for (; s < horizonH; s += 24) {
    const e = s + (24 - set + rise); // sunset → next sunrise
    out.push([Math.max(0, s), Math.min(horizonH, e)]);
  }
  // race could also start pre-dawn (6:00 start vs 6:15 sunrise → 15 min of dark)
  if (start < rise) out.unshift([0, Math.min(horizonH, rise - start)]);
  return out;
}
