// Shared elevation smoothing + climb detection. Used by:
//   - scripts/build-course.mjs  (race GPX → course.json race_climbs)
//   - scripts/sync-streams.mjs  (Strava altitude streams → climbs.json)
//
// Both pipelines feed raw (mi, ele_ft) samples through smoothProfile() to get a
// clean 0.02 mi grid + total gain, then run detectClimbs() over that grid so the
// race climbs and the training climbs are measured by the *same* ruler.
//
// Why smooth at all: raw GPS/barometric elevation is noisy (±a few ft per sample),
// and naively summing every up-tick inflates total gain by 30–50%. We resample to a
// uniform grid, apply a centered moving average (~0.18 mi), then accumulate gain
// with a ±10 ft hysteresis band so only real climbs count. The moving average
// spans ~0.14 mi (7 samples at 0.02 mi) — wide enough to drop sample noise, tight
// enough to preserve real gain on steep switchbacks.
//
// Edge cases handled:
//   - <2 usable samples → empty grid / no climbs (never throws).
//   - Non-monotonic distance (GPS jitter, brief backtracks) → backward/duplicate
//     samples are dropped before resampling, so interpolation stays well-defined.
//   - Out-and-back sections (e.g. the Horton spur) keep advancing cumulative
//     distance, so they resample fine — disambiguation is the caller's job (snap
//     each waypoint within a mile window), not this library's.
//   - Flat activities → gain 0, zero climbs. A single monotonic climb → one climb.
//   - max_grade is read off the same 0.1 mi rolling-window grade as the profile, so
//     a lone noisy sample can't spike it.
//
// No dependencies (plain ESM), consistent with the other scripts/ helpers.

const FT_PER_MI = 5280;

/**
 * Great-circle distance between two lat/lon points, in miles.
 */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.7613; // Earth radius, miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Drop backward / duplicate samples so cumulative distance is strictly
 * increasing — a precondition for linear interpolation.
 * @param {{mi:number, ele_ft:number}[]} raw
 */
function monotonic(raw) {
  const out = [];
  for (const p of raw) {
    if (!Number.isFinite(p.mi) || !Number.isFinite(p.ele_ft)) continue;
    if (out.length && p.mi <= out[out.length - 1].mi) continue;
    out.push({ mi: p.mi, ele_ft: p.ele_ft });
  }
  return out;
}

/**
 * Resample onto a uniform `step`-mile grid by linear interpolation.
 * @param {{mi:number, ele_ft:number}[]} pts  strictly increasing in mi
 */
function resample(pts, step) {
  const startMi = pts[0].mi;
  const endMi = pts[pts.length - 1].mi;
  const grid = [];
  let j = 0;
  const count = Math.floor((endMi - startMi) / step);
  for (let k = 0; k <= count; k++) {
    const mi = startMi + k * step;
    while (j < pts.length - 2 && pts[j + 1].mi < mi) j++;
    const a = pts[j];
    const b = pts[j + 1];
    const t = b.mi === a.mi ? 0 : (mi - a.mi) / (b.mi - a.mi);
    grid.push({ mi, ele_ft: a.ele_ft + t * (b.ele_ft - a.ele_ft) });
  }
  return grid;
}

/** Centered moving average over `window` samples (odd). */
function movingAverage(grid, window) {
  const half = (window - 1) >> 1;
  return grid.map((p, i) => {
    let sum = 0;
    let n = 0;
    for (let k = -half; k <= half; k++) {
      const idx = i + k;
      if (idx >= 0 && idx < grid.length) {
        sum += grid[idx].ele_ft;
        n++;
      }
    }
    return { mi: p.mi, ele_ft: sum / n };
  });
}

/**
 * Total ascent via a ±`thresh` ft hysteresis accumulator: only reverse the
 * "climbing" state once elevation moves `thresh` ft past the current extreme,
 * so sub-threshold noise never contributes.
 */
function gainHysteresis(grid, thresh) {
  let gain = 0;
  let anchor = grid[0].ele_ft;
  let climbing = false;
  for (let i = 1; i < grid.length; i++) {
    const e = grid[i].ele_ft;
    if (climbing) {
      if (e > anchor) {
        gain += e - anchor;
        anchor = e;
      } else if (e < anchor - thresh) {
        climbing = false;
        anchor = e;
      }
    } else if (e > anchor + thresh) {
      climbing = true;
      gain += e - anchor;
      anchor = e;
    } else if (e < anchor) {
      anchor = e;
    }
  }
  return gain;
}

/** Attach a rolling grade (% over ~`spanMi` mi, centered) to each grid point. */
function attachGrades(grid, step, spanMi) {
  const h = Math.max(1, Math.round(spanMi / 2 / step));
  return grid.map((p, i) => {
    const lo = Math.max(0, i - h);
    const hi = Math.min(grid.length - 1, i + h);
    const run = (grid[hi].mi - grid[lo].mi) * FT_PER_MI;
    const grade = run > 0 ? ((grid[hi].ele_ft - grid[lo].ele_ft) / run) * 100 : 0;
    return { mi: p.mi, ele_ft: p.ele_ft, grade_pct: grade };
  });
}

/**
 * Smooth a raw elevation profile and report total gain.
 *
 * Gain accounting vs display smoothing are deliberately different rulers:
 * the moving-averaged grid is for *display and grade/climb-shape detection*,
 * but averaging clips real switchback relief (~9–15% of ascent on this
 * course), so gain_ft is accumulated on the resampled, UN-averaged series —
 * the hysteresis dead-band alone handles sample noise there.
 *
 * @param {{mi:number, ele_ft:number}[]} raw  cumulative-mile samples (any spacing)
 * @param {object} [opts]
 * @param {number} [opts.step=0.02]         grid spacing, miles
 * @param {number} [opts.window=7]          moving-average width (~0.14 mi at 0.02)
 * @param {number} [opts.hysteresisFt=10]   gain accumulator dead-band, ft
 * @param {number} [opts.gradeSpanMi=0.1]   grade measurement span, miles
 * @returns {{grid:{mi:number,ele_ft:number,grade_pct:number}[], rawGrid:{mi:number,ele_ft:number}[], gain_ft:number, step:number}}
 */
export function smoothProfile(raw, opts = {}) {
  const { step = 0.02, window = 7, hysteresisFt = 10, gradeSpanMi = 0.1 } = opts;
  const pts = monotonic(raw || []);
  if (pts.length < 2) return { grid: [], rawGrid: [], gain_ft: 0, step };
  const resampled = resample(pts, step);
  const smoothed = movingAverage(resampled, window);
  const gain = gainHysteresis(resampled, hysteresisFt);
  const grid = attachGrades(smoothed, step, gradeSpanMi);
  return { grid, rawGrid: resampled, gain_ft: gain, step };
}

/**
 * Ascent within [loMi, hiMi] on a (raw or smoothed) grid, via the same
 * hysteresis accumulator — used to report climb gain off the un-averaged
 * series so switchback relief isn't clipped by display smoothing.
 */
export function gainBetween(grid, loMi, hiMi, hysteresisFt = 10) {
  const slice = grid.filter((p) => p.mi >= loMi && p.mi <= hiMi);
  if (slice.length < 2) return 0;
  return gainHysteresis(slice, hysteresisFt);
}

/**
 * Detect sustained climbs on a smoothed grid (from smoothProfile).
 *
 * State machine: walk the grid tracking the running valley (start) and peak of the
 * current ascent. Close the climb *at the peak* once elevation either drops more
 * than max(70 ft, 15% of the climb's gain) below that peak, or descends for more
 * than 0.25 mi continuously — whichever comes first. After closing, the low point
 * that follows becomes the next climb's start. Adjacent climbs whose intervening
 * dip is < 70 ft and < 0.3 mi apart are merged (a brief saddle isn't two climbs).
 * Finally keep only climbs with gain ≥ minGainFt and avg grade ≥ minAvgGradePct.
 *
 * @param {{mi:number, ele_ft:number, grade_pct?:number}[]} grid
 * @param {object} [opts]
 * @param {number} [opts.minGainFt=300]        minimum total ascent to count
 * @param {number} [opts.minAvgGradePct=3]     minimum average grade to count
 * @param {number} [opts.closeDropFt=70]       absolute drop-from-peak floor
 * @param {number} [opts.closeDropFrac=0.15]   drop-from-peak as fraction of gain
 * @param {number} [opts.contDescentMi=0.25]   continuous descent that closes a climb
 * @param {number} [opts.mergeDipFt=70]        merge if saddle dip below this
 * @param {number} [opts.mergeGapMi=0.3]       merge if peak→next-start gap below this
 * @param {number} [opts.gradeSpanMi=0.1]      rolling window for max_grade
 * @returns {{start_mi,end_mi,length_mi,gain_ft,avg_grade_pct,max_grade_pct,startIdx,peakIdx}[]}
 */
export function detectClimbs(grid, opts = {}) {
  const {
    minGainFt = 300,
    minAvgGradePct = 3,
    closeDropFt = 70,
    closeDropFrac = 0.15,
    contDescentMi = 0.25,
    mergeDipFt = 70,
    mergeGapMi = 0.3,
    gradeSpanMi = 0.1,
  } = opts;
  const n = grid.length;
  if (n < 2) return [];

  const candidates = [];
  let startIdx = 0;
  let peakIdx = 0;
  let inClimb = false;
  let descentStartMi = null;

  const closeAtPeak = () => {
    if (peakIdx > startIdx) candidates.push({ startIdx, peakIdx });
  };

  for (let i = 1; i < n; i++) {
    const e = grid[i].ele_ft;
    if (!inClimb) {
      if (e > grid[startIdx].ele_ft) {
        inClimb = true;
        peakIdx = i;
        descentStartMi = null;
      } else if (e < grid[startIdx].ele_ft) {
        startIdx = i; // track the running low as the next potential start
        peakIdx = i;
      }
    } else if (e >= grid[peakIdx].ele_ft) {
      peakIdx = i;
      descentStartMi = null; // a new high resets the descent run
    } else {
      if (descentStartMi === null) descentStartMi = grid[i].mi;
      const gain = grid[peakIdx].ele_ft - grid[startIdx].ele_ft;
      const dropFromPeak = grid[peakIdx].ele_ft - e;
      const dropThresh = Math.max(closeDropFt, closeDropFrac * gain);
      const contDescent = grid[i].mi - descentStartMi;
      if (dropFromPeak > dropThresh || contDescent > contDescentMi) {
        closeAtPeak();
        inClimb = false;
        startIdx = i; // resume searching for the next valley from here
        peakIdx = i;
      }
    }
  }
  if (inClimb) closeAtPeak();

  // Merge adjacent climbs separated by only a shallow, short saddle.
  let merged = true;
  while (merged) {
    merged = false;
    for (let k = 0; k < candidates.length - 1; k++) {
      const a = candidates[k];
      const b = candidates[k + 1];
      const gapMi = grid[b.startIdx].mi - grid[a.peakIdx].mi;
      const dipFt = grid[a.peakIdx].ele_ft - grid[b.startIdx].ele_ft;
      if (gapMi < mergeGapMi && dipFt < mergeDipFt) {
        candidates[k] = { startIdx: a.startIdx, peakIdx: b.peakIdx };
        candidates.splice(k + 1, 1);
        merged = true;
        break;
      }
    }
  }

  const hasGrade = grid[0].grade_pct !== undefined;
  const step = n > 1 ? grid[1].mi - grid[0].mi : gradeSpanMi;
  const h = Math.max(1, Math.round(gradeSpanMi / 2 / step));

  const gradeAt = (i) => {
    if (hasGrade) return grid[i].grade_pct;
    const lo = Math.max(0, i - h);
    const hi = Math.min(n - 1, i + h);
    const run = (grid[hi].mi - grid[lo].mi) * FT_PER_MI;
    return run > 0 ? ((grid[hi].ele_ft - grid[lo].ele_ft) / run) * 100 : 0;
  };

  const out = [];
  for (const { startIdx: s, peakIdx: p } of candidates) {
    const start_mi = grid[s].mi;
    const end_mi = grid[p].mi;
    const length_mi = end_mi - start_mi;
    const gain_ft = grid[p].ele_ft - grid[s].ele_ft;
    if (length_mi <= 0) continue;
    const avg_grade_pct = (gain_ft / (length_mi * FT_PER_MI)) * 100;
    if (gain_ft < minGainFt || avg_grade_pct < minAvgGradePct) continue;
    let max_grade_pct = 0;
    for (let i = s; i <= p; i++) max_grade_pct = Math.max(max_grade_pct, gradeAt(i));
    out.push({
      start_mi,
      end_mi,
      length_mi,
      gain_ft,
      avg_grade_pct,
      max_grade_pct,
      startIdx: s,
      peakIdx: p,
    });
  }
  return out;
}
