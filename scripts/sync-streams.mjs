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
import { writeJsonAtomic } from "./lib.mjs";
import { loadConfig, ensureToken } from "./strava-auth.mjs";
import { smoothProfile, detectClimbs, gainBetween } from "./climb-lib.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
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
  const samples = []; // { g, mult, w }
  let runsUsed = 0;
  for (const { activity, cache } of runs) {
    const wins = gradeWindows(cache.distance, cache.altitude, cache.time);
    const flat = wins.filter((s) => Math.abs(s.g) < 2).map((s) => s.v);
    if (flat.length < 8) continue; // no flat baseline — can't normalize this run
    flat.sort((a, b) => a - b);
    const base = flat[Math.floor(flat.length / 2)];
    if (!(base > 0)) continue;
    const ageDays = activity.date ? Math.max(0, (nowMs - new Date(activity.date).getTime()) / 86400000) : 90;
    const wRun = Math.exp(-ageDays / RECENCY_TAU_DAYS);
    const wPer = wRun / wins.length; // a run's weight splits across its windows
    for (const s of wins) samples.push({ g: s.g, mult: base / s.v, w: wPer });
    runsUsed += 1;
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
    basis: `${runsUsed} runs · ${samples.length} windows (${GRADE_WINDOW_M} m) · recency-weighted, per-run flat-normalized`,
    window_m: GRADE_WINDOW_M,
    bin_pct: GRADE_BIN_PCT,
    runs_used: runsUsed,
    curve,
  };
}

async function readCache(id) {
  try {
    return JSON.parse(await fs.readFile(path.join(CACHE_DIR, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(id, data) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(path.join(CACHE_DIR, `${id}.json`), JSON.stringify(data));
}

/**
 * Fetch one activity's distance+altitude+time streams.
 * @returns {"streams"|"none"|"ratelimited"|"auth"|"error"} outcome; caches on streams/none.
 */
async function fetchStream(token, id) {
  const url = `https://www.strava.com/api/v3/activities/${id}/streams?keys=distance,altitude,time&key_by_type=true`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 429) return "ratelimited";
  if (r.status === 401 || r.status === 403) return "auth"; // revoked token / missing scope — fatal
  if (r.status === 404) {
    await writeCache(id, { no_altitude: true });
    return "none";
  }
  if (!r.ok) {
    console.warn(`  ! ${id}: HTTP ${r.status} — leaving pending`);
    return "error";
  }
  const j = await r.json();
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
    const outcome = await fetchStream(token, a.id);
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
  };
  await writeJsonAtomic(OUT_PATH, payload);

  // ── Personal pace-vs-grade curve (needs time streams) ──────────────────
  const timedRuns = [];
  let pendingTime = 0;
  for (const a of qualifying) {
    const cache = await readCache(a.id);
    if (!cache || cache.no_altitude) continue;
    if (cache.time) timedRuns.push({ activity: a, cache });
    else pendingTime += 1;
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
