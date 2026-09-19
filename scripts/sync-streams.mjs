#!/usr/bin/env node
// Fetches + caches Strava distance/altitude streams for recent qualifying runs,
// detects their sustained climbs, and writes web/public/climbs.json — the data
// behind the Race view's "are my training climbs like the race's?" comparison.
//
// Usage:  node scripts/sync-streams.mjs
//
// Why a separate sync: strava.json holds only per-activity summaries. Steepness ×
// length of an individual climb needs the elevation *stream*, which is a second API
// call per activity. Streams never change once recorded, so we cache them forever
// under .cache/strava-streams/{id}.json (gitignored) and only ever fetch each once.
//
// Rate-limit strategy (Strava allows ~100 reads / 15 min): fetch sequentially ~1 s
// apart, hard-cap 90 requests per invocation, and on the first HTTP 429 stop
// fetching entirely and proceed with whatever is already cached. Uncached
// activities are reported as `activities_pending`; subsequent runs finish the
// backlog. Activities with no altitude data (or 404) are cached as
// {"no_altitude":true} so they're resolved once and never re-fetched.
//
// Failure handling: an HTTP 401/403 means the Strava token is revoked or lacks
// the activity:read scope — no amount of retrying fixes that, so it's fatal
// (exit non-zero, naming auth as the cause). Transient server errors (5xx etc.)
// are tolerated up to 5 consecutive before we stop and proceed with cache, like
// the 429 path.

import fs from "node:fs/promises";
import path from "node:path";
import { projectRoot, writeJsonAtomic } from "./lib.mjs";
import { loadConfig, ensureToken } from "./strava-auth.mjs";
import { smoothProfile, detectClimbs, gainBetween } from "./climb-lib.mjs";

const ROOT = projectRoot();
const STRAVA_PATH = path.join(ROOT, "web", "public", "strava.json");
const OUT_PATH = path.join(ROOT, "web", "public", "climbs.json");
const PACE_GRADE_PATH = path.join(ROOT, "web", "public", "pace-grade.json");
const CACHE_DIR = path.join(ROOT, ".cache", "strava-streams");

const WINDOW_DAYS = 183;
const MIN_DISTANCE_M = 3218; // ~2 mi
const MIN_ELEVATION_M = 91; // ~300 ft
const FETCH_CAP = 90; // per invocation, below Strava's ~100/15-min read limit
const FETCH_SPACING_MS = 1000;

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- personal pace-vs-grade curve ---------------- */

// The race projection wants "how much slower is a mile at grade g than a flat
// mile, for THIS athlete" — fitted from real (grade, speed) windows across the
// same runs the pacing model uses. Windows ~60 m damp GPS/baro noise; each
// run is normalized by its own flat-speed median so easy days and hard days
// pool cleanly; runs are recency-weighted like the pace fit (τ = 75 d) and
// weight is split across a run's windows so one long run can't dominate.

const GRADE_WINDOW_M = 60;
const GRADE_BIN_PCT = 2;
const GRADE_RANGE_PCT = 30;
const GRADE_MIN_BIN_N = 25;
const RECENCY_TAU_DAYS = 75; // matches web/src/race/pacing.ts fitPacing

/**
 * Distance-weighted mean elevation of a run, ft — the same ruler
 * web/src/race/pacing.ts's meanEleBetween() prices a race segment with, so
 * the altitude back-test compares like with like. Distance-weighted, not a
 * plain average of the samples: streams are sampled in TIME, so a plain mean
 * overweights the slow (climbing) parts and reads high by a few hundred feet
 * on a steep run — which is exactly the bias the back-test is trying to
 * measure.
 *
 * @param {number[]} distance metres, cumulative
 * @param {number[]} altitude metres
 * @returns {number|null} ft, or null when the stream covers no distance
 */
function meanElevationFt(distance, altitude) {
  const n = Math.min(distance?.length ?? 0, altitude?.length ?? 0);
  if (n < 2) return null;
  let num = 0, den = 0;
  for (let i = 1; i < n; i++) {
    const w = distance[i] - distance[i - 1];
    if (!(w > 0)) continue;
    num += ((altitude[i] + altitude[i - 1]) / 2) * w;
    den += w;
  }
  if (!(den > 0)) return null;
  return (num / den) / M_PER_FT;
}

function movingAvg(arr, w) {
  const half = Math.floor(w / 2);
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) { s += arr[j]; n++; }
    out[i] = s / n;
  }
  return out;
}

function weightedMedian(items) {
  // items: [{ v, w }]
  const sorted = [...items].sort((a, b) => a.v - b.v);
  const total = sorted.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const x of sorted) {
    acc += x.w;
    if (acc >= total / 2) return x.v;
  }
  return sorted[sorted.length - 1]?.v ?? null;
}

/** (grade %, speed m/s) windows from one activity's streams. */
function gradeWindows(distance, altitude, time) {
  const n = Math.min(distance.length, altitude.length, time.length);
  const alt = movingAvg(altitude, 5);
  const out = [];
  let i = 0;
  while (i < n - 1) {
    let j = i + 1;
    while (j < n && distance[j] - distance[i] < GRADE_WINDOW_M) j++;
    if (j >= n) break;
    const dd = distance[j] - distance[i];
    const dt = time[j] - time[i];
    if (dd >= GRADE_WINDOW_M && dt > 0) {
      const v = dd / dt;
      const g = ((alt[j] - alt[i]) / dd) * 100;
      // sane moving windows only: 0.35–6 m/s spans steep hiking to fast
      // descending; anything outside is a pause, a drive, or garbage baro
      if (v >= 0.35 && v <= 6 && Math.abs(g) <= 35) out.push({ g, v });
    }
    i = j;
  }
  return out;
}

/**
 * Fit the pooled multiplier curve. Returns null when too little data (e.g.
 * time streams not fetched yet).
 */
function fitGradeCurve(runs, nowMs) {
  // First pass: per-run windows + flat baselines. Runs with enough flat
  // tread normalize against their own median flat speed.
  const prepared = [];
  const baselineSamples = []; // { v, w } — pooled flat speeds for the fallback
  for (const { activity, cache } of runs) {
    const wins = gradeWindows(cache.distance, cache.altitude, cache.time);
    if (wins.length === 0) continue;
    const flat = wins.filter((s) => Math.abs(s.g) < 2).map((s) => s.v).sort((a, b) => a - b);
    const ownBase = flat.length >= 8 ? flat[Math.floor(flat.length / 2)] : null;
    const ageDays = activity.date ? Math.max(0, (nowMs - new Date(activity.date).getTime()) / 86400000) : 90;
    const wRun = Math.exp(-ageDays / RECENCY_TAU_DAYS);
    if (ownBase != null && ownBase > 0) baselineSamples.push({ v: ownBase, w: wRun });
    prepared.push({ wins, ownBase, wRun });
  }
  // Recency-weighted median of the per-run flat baselines — lets steep
  // vert-repeat sessions (too steep to contain flat tread) still inform the
  // steep bins instead of being excluded, which biased the steep end of the
  // curve toward runs that also contain flat trail.
  const pooledBase = baselineSamples.length >= 5
    ? weightedMedian(baselineSamples.map((b) => ({ v: b.v, w: b.w })))
    : null;

  const samples = []; // { g, mult, w }
  let runsUsed = 0;
  let runsPooledBase = 0;
  for (const { wins, ownBase, wRun } of prepared) {
    const base = ownBase ?? pooledBase;
    if (!(base > 0)) continue;
    const wPer = wRun / wins.length; // a run's weight splits across its windows
    // pooled-baseline runs contribute only clearly-steep windows: their flat
    // behavior is unknown, steep response is what they add
    const usable = ownBase != null ? wins : wins.filter((s) => Math.abs(s.g) >= 8);
    if (usable.length === 0) continue;
    for (const s of usable) samples.push({ g: s.g, mult: base / s.v, w: wPer });
    runsUsed += 1;
    if (ownBase == null) runsPooledBase += 1;
  }
  if (runsUsed < 5 || samples.length < 500) return null;

  // bin → weighted median → light 3-bin smoothing → normalize F(0)=1
  const bins = [];
  for (let lo = -GRADE_RANGE_PCT; lo < GRADE_RANGE_PCT; lo += GRADE_BIN_PCT) {
    const inBin = samples.filter((s) => s.g >= lo && s.g < lo + GRADE_BIN_PCT);
    if (inBin.length < GRADE_MIN_BIN_N) continue;
    const med = weightedMedian(inBin.map((s) => ({ v: s.mult, w: s.w })));
    bins.push({ g: lo + GRADE_BIN_PCT / 2, mult: med, n: inBin.length, w: inBin.reduce((s, x) => s + x.w, 0) });
  }
  if (bins.length < 6) return null;
  // the F(0)=1 normalization (and the client's flat-pace anchor) is
  // meaningless without near-zero data — refuse to publish a curve that
  // doesn't cover flat ground
  if (!bins.some((b) => Math.abs(b.g) <= 3)) return null;
  const smoothed = bins.map((b, i) => {
    const win = [bins[i - 1], b, bins[i + 1]].filter(Boolean);
    const tw = win.reduce((s, x) => s + x.w, 0);
    return { ...b, mult: win.reduce((s, x) => s + x.mult * x.w, 0) / tw };
  });
  // interpolated multiplier at exactly 0% — normalize so F(0) = 1
  const at0 = (() => {
    let below = null, above = null;
    for (const b of smoothed) {
      if (b.g <= 0 && (!below || b.g > below.g)) below = b;
      if (b.g >= 0 && (!above || b.g < above.g)) above = b;
    }
    if (below && above && below !== above) {
      const t = (0 - below.g) / (above.g - below.g);
      return below.mult + t * (above.mult - below.mult);
    }
    return (below ?? above)?.mult ?? 1;
  })();
  const curve = smoothed.map((b) => ({
    g: b.g,
    mult: +Math.min(6, Math.max(0.6, b.mult / at0)).toFixed(4),
    n: b.n,
  }));
  return {
    fitted_at: new Date().toISOString(),
    basis: `${runsUsed} runs · ${samples.length} windows (${GRADE_WINDOW_M} m) · recency-weighted (τ ${RECENCY_TAU_DAYS}d), flat-normalized${runsPooledBase ? ` (${runsPooledBase} steep runs on pooled baseline)` : ""}`,
    window_m: GRADE_WINDOW_M,
    bin_pct: GRADE_BIN_PCT,
    runs_used: runsUsed,
    curve,
  };
}

// Cache entries are keyed by a NAME, not an id, because one activity can have
// two of them: the sweep's distance/altitude/time (`<id>`) and the archive
// flow's latlng/time (`<id>.latlng`). Both are immutable once recorded.
async function readCache(name) {
  try {
    return JSON.parse(await fs.readFile(path.join(CACHE_DIR, `${name}.json`), "utf8"));
  } catch (e) {
    // ENOENT = never cached (silent). Anything else — torn JSON, permission
    // problem — self-heals via refetch but should be visible: it spends
    // rate-cap quota and could recur forever.
    if (e.code !== "ENOENT") {
      console.warn(`  ! cache ${name}: ${e.code ?? e.message} — will refetch`);
    }
    return null;
  }
}

async function writeCache(name, data) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  // write-then-rename: a kill mid-write must not leave a torn cache file
  const p = path.join(CACHE_DIR, `${name}.json`);
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, p);
}

/**
 * The HTTP call itself, for any key set. Transport only — no cache, no shape
 * opinion — so the sweep below and the one-off archive fetch classify the same
 * outcomes from the same request.
 * @returns {Promise<{outcome: "ok"|"ratelimited"|"auth"|"missing"|"error", data?: object, status?: number}>}
 */
async function streamsRequest(token, id, keys) {
  const url = `https://www.strava.com/api/v3/activities/${id}/streams?keys=${keys}&key_by_type=true`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 429) return { outcome: "ratelimited" };
  if (r.status === 401 || r.status === 403) return { outcome: "auth" }; // revoked token / missing scope
  if (r.status === 404) return { outcome: "missing" };
  if (!r.ok) return { outcome: "error", status: r.status };
  return { outcome: "ok", data: await r.json() };
}

/**
 * ONE activity's latlng+time streams, cached forever under
 * .cache/strava-streams/<id>.latlng.json. This is the archive flow's fetch
 * (scripts/race-result.mjs derives aid-station splits from it): a single
 * deliberate activity on demand, never the sweep — so every non-ok outcome
 * throws instead of degrading to "proceed with cache".
 * @param {string|number} id Strava activity id
 * @returns {Promise<{latlng: [number, number][], time: number[]}>}
 */
export async function fetchActivityStreams(id) {
  const name = `${id}.latlng`;
  const cached = await readCache(name);
  if (cached?.latlng && cached?.time) return cached;

  const token = await ensureToken(await loadConfig());
  const { outcome, data, status } = await streamsRequest(token, id, "latlng,time");
  if (outcome === "auth") {
    throw new Error(
      `Strava auth failed (HTTP 401/403) fetching activity ${id} — token revoked or missing the activity:read scope`,
    );
  }
  if (outcome === "ratelimited") throw new Error(`Strava rate limit (HTTP 429) fetching activity ${id} — retry in 15 min`);
  if (outcome === "missing") throw new Error(`Strava activity ${id} not found (HTTP 404)`);
  if (outcome === "error") throw new Error(`Strava activity ${id}: HTTP ${status}`);

  const latlng = data?.latlng?.data;
  const time = data?.time?.data;
  if (!Array.isArray(latlng) || !Array.isArray(time) || latlng.length !== time.length || latlng.length < 2) {
    // No GPS track (treadmill, manual entry, privacy-trimmed to nothing) —
    // not cached, because the caller's only move is to pick another activity.
    throw new Error(`Strava activity ${id} has no usable latlng+time stream`);
  }
  const streams = { latlng, time };
  await writeCache(name, streams);
  return streams;
}

/**
 * Fetch one activity's distance+altitude+time streams.
 * @returns {"streams"|"none"|"ratelimited"|"auth"|"error"} outcome; caches on streams/none.
 */
async function fetchStream(token, id) {
  const { outcome, data: j, status } = await streamsRequest(token, id, "distance,altitude,time");
  if (outcome === "ratelimited") return "ratelimited";
  if (outcome === "auth") return "auth"; // revoked token / missing scope — fatal
  if (outcome === "missing") {
    await writeCache(id, { no_altitude: true });
    return "none";
  }
  if (outcome === "error") {
    console.warn(`  ! ${id}: HTTP ${status} — leaving pending`);
    return "error";
  }
  const distance = j?.distance?.data;
  const altitude = j?.altitude?.data;
  const time = j?.time?.data;
  if (!Array.isArray(distance) || !Array.isArray(altitude) || altitude.length < 2) {
    await writeCache(id, { no_altitude: true });
    return "none";
  }
  // time may legitimately be absent on some uploads — cache what we have;
  // such activities feed the climb scatter but not the pace-grade fit
  await writeCache(id, Array.isArray(time) && time.length === distance.length
    ? { distance, altitude, time }
    : { distance, altitude, no_time: true });
  return "streams";
}

async function main() {
  const strava = JSON.parse(await fs.readFile(STRAVA_PATH, "utf8"));
  const now = Date.now();
  const cutoff = now - WINDOW_DAYS * 86400 * 1000;

  const qualifying = strava.activities.filter(
    (a) =>
      new Date(a.date).getTime() >= cutoff &&
      a.distance_m >= MIN_DISTANCE_M &&
      a.elevation_m >= MIN_ELEVATION_M
  );
  console.log(
    `• ${qualifying.length} qualifying runs (≤${WINDOW_DAYS}d, ≥${MIN_DISTANCE_M} m, ≥${MIN_ELEVATION_M} m gain) ` +
      `of ${strava.activities.length} total`
  );

  // ── Fetch pass: only activities without a cache entry ───────────────────
  const cfg = await loadConfig();
  let token = null;
  let fetched = 0;
  let rateLimited = false;

  // fetchable = never cached, OR cached before the time stream existed
  // (pre-time caches upgrade in place; no_altitude / no_time stay settled)
  const uncached = [];
  for (const a of qualifying) {
    const c = await readCache(a.id);
    if (c === null || (!c.no_altitude && !c.no_time && !c.time)) uncached.push(a);
  }
  console.log(`• ${uncached.length} to fetch (new or missing time stream) · fetching up to ${FETCH_CAP} this run`);

  let consecutiveErrors = 0;
  for (const a of uncached) {
    if (fetched >= FETCH_CAP) {
      console.log(`• hit fetch cap (${FETCH_CAP}); remaining stay pending`);
      break;
    }
    if (!token) token = await ensureToken(cfg);
    // a THROWN fetch error (ECONNRESET, DNS blip, malformed body) joins the
    // consecutive-error budget like an HTTP 5xx instead of aborting the whole
    // step before any artifact is written
    const outcome = await fetchStream(token, a.id).catch((e) => {
      console.warn(`  ! ${a.id}: ${e.message} — leaving pending`);
      return "error";
    });
    if (outcome === "auth") {
      // Revoked token or missing activity:read scope — retrying can't fix this.
      // Fail hard so the /api/refresh step surfaces as error, not "done".
      console.error(
        "✗ Strava auth failed (HTTP 401/403) — token revoked or missing the " +
          "activity:read scope. Re-authorize Strava; no more streams will sync until then."
      );
      process.exit(1);
    }
    if (outcome === "ratelimited") {
      console.log("• Strava 429 rate limit — stopping fetch, proceeding with cache");
      rateLimited = true;
      break;
    }
    if (outcome === "error") {
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) {
        console.log("• 5 consecutive server errors — stopping fetch, proceeding with cache");
        break;
      }
    } else {
      consecutiveErrors = 0;
    }
    fetched += 1;
    if (outcome === "streams") console.log(`  ✓ ${a.id} ${a.title || ""}`.trim());
    else if (outcome === "none") console.log(`  ∅ ${a.id} no altitude`);
    await sleep(FETCH_SPACING_MS);
  }

  // ── Detection pass: every qualifying activity with a cached altitude stream ─
  const climbs = [];
  // Per-activity mean elevation, for the altitude back-test in
  // web/src/race/calibration.ts (PRD-v2 §2). The streams live in a gitignored
  // cache the browser cannot read, so the ONE number the back-test needs out
  // of each of them rides along in climbs.json — which the race view already
  // fetches — rather than becoming a second endpoint.
  const activityElevations = [];
  let scanned = 0;
  let pending = 0;
  let noAltitude = 0;

  for (const a of qualifying) {
    const cache = await readCache(a.id);
    if (cache === null) {
      pending += 1;
      continue;
    }
    if (cache.no_altitude) {
      noAltitude += 1;
      continue;
    }
    scanned += 1;
    const { distance, altitude } = cache;
    const n = Math.min(distance.length, altitude.length);
    const raw = [];
    for (let i = 0; i < n; i++) {
      raw.push({ mi: distance[i] / M_PER_MI, ele_ft: altitude[i] / M_PER_FT });
    }
    const meanEleFt = meanElevationFt(distance, altitude);
    if (meanEleFt != null) {
      activityElevations.push({
        activity_id: a.id,
        date: a.date,
        mean_ele_ft: Math.round(meanEleFt),
      });
    }
    const { grid, rawGrid } = smoothProfile(raw);
    for (const c of detectClimbs(grid)) {
      // Gain off the un-averaged series — same ruler as the race climbs in
      // build-course.mjs, so the scatter compares like with like.
      const gain = gainBetween(rawGrid, c.start_mi, c.end_mi);
      climbs.push({
        activity_id: a.id,
        date: a.date,
        title: a.title,
        start_mi: +c.start_mi.toFixed(3),
        length_mi: +c.length_mi.toFixed(3),
        gain_ft: Math.round(gain),
        avg_grade_pct: +((gain / (c.length_mi * 5280)) * 100).toFixed(2),
        max_grade_pct: +c.max_grade_pct.toFixed(2),
        strava_url: a.strava_url,
      });
    }
  }

  climbs.sort((x, y) => y.date.localeCompare(x.date));

  const payload = {
    fetched_at: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    activities_scanned: scanned,
    activities_pending: pending,
    climbs,
    activity_elevations: activityElevations.sort((x, y) => y.date.localeCompare(x.date)),
  };
  await writeJsonAtomic(OUT_PATH, payload);

  // ── Personal pace-vs-grade curve (needs time streams) ──────────────────
  const timedRuns = [];
  let pendingTime = 0;
  for (const a of qualifying) {
    const cache = await readCache(a.id);
    if (!cache || cache.no_altitude) continue;
    // strict shape check — a truthy-but-invalid time would be counted as a
    // timed run while contributing zero windows, overstating the fit's inputs
    if (Array.isArray(cache.time) && Array.isArray(cache.distance) && Array.isArray(cache.altitude)) {
      timedRuns.push({ activity: a, cache });
    } else if (!cache.no_time) {
      pendingTime += 1;
    }
  }
  const gradeFit = fitGradeCurve(timedRuns, now);
  if (gradeFit) {
    gradeFit.runs_pending_time = pendingTime;
    await writeJsonAtomic(PACE_GRADE_PATH, gradeFit);
    console.log(
      `✓ wrote pace-grade.json (${gradeFit.basis}` +
        `${pendingTime ? ` · ${pendingTime} runs still awaiting time streams` : ""})`
    );
  } else {
    console.log(
      `• pace-grade curve not fitted yet — ${timedRuns.length} runs with time streams, ` +
        `${pendingTime} pending refetch (race page falls back to the kVert-anchored curve)`
    );
  }

  console.log("");
  console.log(
    `✓ wrote climbs.json → ${OUT_PATH}\n` +
      `  fetched ${fetched} this run${rateLimited ? " (rate-limited)" : ""} · ` +
      `scanned ${scanned} · no-altitude ${noAltitude} · pending ${pending}\n` +
      `  ${climbs.length} climbs detected across ${scanned} activities`
  );
}

// Only as a command. scripts/race-result.mjs imports fetchActivityStreams from
// here, and an import must never kick off the whole sweep.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
