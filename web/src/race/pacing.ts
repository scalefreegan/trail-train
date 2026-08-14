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
  /** planned stop at this station, minutes (0 at the finish) */
  stop_min: number;
  /** cumulative elapsed hours at ARRIVAL (includes dwell at prior stations) */
  eta_h: Record<Scenario, number>;
  goal_eta_h: number | null;
  /** cutoff_h − avg arrival; null when no cutoff posted */
  cutoff_margin_h: number | null;
  cutoff_margin_worst_h: number | null;
};

export type ProjectOptions = {
  /** pace degradation per 10 miles, compounding — e.g. 5 → ×1.05 every 10 mi */
  fatiguePctPer10mi: number;
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
  /** piecewise-linear course-mile → elapsed hours (avg scenario unless given) */
  elapsedAtMile: (mi: number, scenario?: Scenario) => number;
  /** inverse of elapsedAtMile — used to place time-based bands (night) on the mile axis */
  mileAtElapsed: (h: number, scenario?: Scenario) => number;
};

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

  // moving time per segment per scenario (before stops)
  const paceShift: Record<Scenario, number> = { best: -fit.residStd, avg: 0, worst: fit.residStd };
  const segTimes = segs.map(({ seg_mi, seg_gain_ft, prevMi }) => {
    const vfpm = seg_mi > 0 ? seg_gain_ft / seg_mi : 0;
    const midMi = prevMi + seg_mi / 2;
    const m = mult(midMi) * effort(midMi);
    const out = {} as Record<Scenario, number>;
    for (const sc of ["best", "avg", "worst"] as Scenario[]) {
      const pace = Math.max(300, (fit.base + paceShift[sc] + fit.kVert * vfpm + fit.kDist * D_REF) * cal);
      out[sc] = seg_mi * pace * m; // seconds
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
  if (opts.goalH != null && avgMovingTotalS > 0) {
    const goalMovingS = Math.max(0, opts.goalH * 3600 - totalStopS);
    const scale = goalMovingS / avgMovingTotalS;
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

  // piecewise-linear mile ↔ elapsed maps (dwell = vertical step at the station mile).
  // Miles here are MEASURED gpx_mi — the chart's axis space and the profile's
  // space, so callers (hover ETAs, night bands) share one axis; official
  // total_mi drives only the display column and the pace/time math above.
  const boundaries = (sc: Scenario) => {
    const mis = [0, ...segs.map(({ st }) => st.gpx_mi)];
    const arr = [0, ...arrive[sc].map((s) => s / 3600)];
    const dep = [0, ...depart[sc].map((s) => s / 3600)];
    return { mis, arr, dep };
  };

  const elapsedAtMile = (mi: number, sc: Scenario = "avg") => {
    const { mis, arr, dep } = boundaries(sc);
    if (mi <= 0) return 0;
    for (let i = 1; i < mis.length; i++) {
      if (mi <= mis[i]) {
        const span = mis[i] - mis[i - 1];
        const frac = span > 0 ? (mi - mis[i - 1]) / span : 1;
        return dep[i - 1] + frac * (arr[i] - dep[i - 1]);
      }
    }
    return arr[arr.length - 1];
  };

  const mileAtElapsed = (h: number, sc: Scenario = "avg") => {
    const { mis, arr, dep } = boundaries(sc);
    if (h <= 0) return 0;
    for (let i = 1; i < mis.length; i++) {
      if (h <= arr[i]) {
        if (h <= dep[i - 1]) return mis[i - 1]; // sitting at the prior station
        const span = arr[i] - dep[i - 1];
        const frac = span > 0 ? (h - dep[i - 1]) / span : 1;
        return mis[i - 1] + frac * (mis[i] - mis[i - 1]);
      }
    }
    return mis[mis.length - 1];
  };

  return { stations: projections, finish_h, stopped_h: totalStopS / 3600, goal_h: opts.goalH, elapsedAtMile, mileAtElapsed };
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
