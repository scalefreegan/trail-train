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

/** Recency half-life for fit weights, in days. */
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
  /** target finish in hours, or null to skip the goal overlay */
  goalH: number | null;
  /** fresh stop minutes at a regular aid station (scales up late-race) */
  aidStopMin?: number;
  /** fresh stop minutes where crew / drop bags are (scales up late-race) */
  crewStopMin?: number;
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

/**
 * Project best/avg/worst arrival times at every aid station.
 *
 * Modeling notes:
 * - kDist was fitted on training runs ≤ ~26 mi. Linearly extrapolating it to
 *   mile 100 double-counts fatigue and explodes, so the fitness pace is
 *   evaluated at a fixed reference distance (D_REF = 20 mi, the athlete's
 *   long-run regime) and ALL ultra-distance slowdown comes from the explicit
 *   fatigue multiplier. Don't "fix" this back to kDist·total_mi.
 * - Fatigue COMPOUNDS: mult(mi) = (1 + f)^(mi/10). Ultra fade is nonlinear —
 *   mild through 50, heavy after 80 (at 5%: ×1.28 @50mi, ×1.63 @100mi).
 * - Station stops scale with the same curve (you linger longer at mile 80
 *   than mile 20), capped at 2× the fresh stop.
 */
const D_REF = 20;

export function projectRace(course: Course, fit: PacingFit, opts: ProjectOptions): RaceProjection {
  const f = opts.fatiguePctPer10mi / 100;
  const aidStopS = (opts.aidStopMin ?? 5) * 60;
  const crewStopS = (opts.crewStopMin ?? 10) * 60;
  const stations = course.aid_stations;
  const mult = (mi: number) => Math.pow(1 + f, mi / 10);

  const segs = stations.map((st, i) => {
    const prevMi = i === 0 ? 0 : stations[i - 1].total_mi;
    const seg_mi = Math.max(0, st.total_mi - prevMi);
    const seg_gain_ft = st.seg_gain_ft ?? gainBetween(course.profile, prevMi, st.total_mi);
    return { st, prevMi, seg_mi, seg_gain_ft };
  });

  // moving time per segment per scenario (before stops)
  const paceShift: Record<Scenario, number> = { best: -fit.residStd, avg: 0, worst: fit.residStd };
  const segTimes = segs.map(({ seg_mi, seg_gain_ft, prevMi }) => {
    const vfpm = seg_mi > 0 ? seg_gain_ft / seg_mi : 0;
    const midMi = prevMi + seg_mi / 2;
    const m = mult(midMi);
    const out = {} as Record<Scenario, number>;
    for (const sc of ["best", "avg", "worst"] as Scenario[]) {
      const pace = Math.max(300, fit.base + paceShift[sc] + fit.kVert * vfpm + fit.kDist * D_REF);
      out[sc] = seg_mi * pace * m; // seconds
    }
    return out;
  });

  // Stop time applies at every intermediate station once you've arrived —
  // a station's own arrival excludes its stop, later stations include it.
  // Crew zones count too (meeting your crew takes real minutes).
  const stopAt = (st: CourseAidStation, isLast: boolean) => {
    if (isLast) return 0;
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

  // piecewise-linear mile ↔ elapsed maps (dwell = vertical step at the station mile)
  const boundaries = (sc: Scenario) => {
    const mis = [0, ...segs.map(({ st }) => st.total_mi)];
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
