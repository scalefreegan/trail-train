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
// activities are reported as `activities_pending`; a second run finishes the
// backlog. Activities with no altitude data (or 404) are cached as
// {"no_altitude":true} so they're resolved once and never re-fetched.

import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./lib.mjs";
import { loadConfig, ensureToken } from "./strava-auth.mjs";
import { smoothProfile, detectClimbs } from "./climb-lib.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const STRAVA_PATH = path.join(ROOT, "web", "public", "strava.json");
const OUT_PATH = path.join(ROOT, "web", "public", "climbs.json");
const CACHE_DIR = path.join(ROOT, ".cache", "strava-streams");

const WINDOW_DAYS = 183;
const MIN_DISTANCE_M = 3218; // ~2 mi
const MIN_ELEVATION_M = 91; // ~300 ft
const FETCH_CAP = 90; // per invocation, below Strava's ~100/15-min read limit
const FETCH_SPACING_MS = 1000;

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * Fetch one activity's distance+altitude streams.
 * @returns {"streams"|"none"|"ratelimited"|"error"} outcome; caches on streams/none.
 */
async function fetchStream(token, id) {
  const url = `https://www.strava.com/api/v3/activities/${id}/streams?keys=distance,altitude&key_by_type=true`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 429) return "ratelimited";
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
  if (!Array.isArray(distance) || !Array.isArray(altitude) || altitude.length < 2) {
    await writeCache(id, { no_altitude: true });
    return "none";
  }
  await writeCache(id, { distance, altitude });
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

  const uncached = [];
  for (const a of qualifying) {
    if ((await readCache(a.id)) === null) uncached.push(a);
  }
  console.log(`• ${uncached.length} uncached · fetching up to ${FETCH_CAP} this run`);

  for (const a of uncached) {
    if (fetched >= FETCH_CAP) {
      console.log(`• hit fetch cap (${FETCH_CAP}); remaining stay pending`);
      break;
    }
    if (!token) token = await ensureToken(cfg);
    const outcome = await fetchStream(token, a.id);
    if (outcome === "ratelimited") {
      console.log("• Strava 429 rate limit — stopping fetch, proceeding with cache");
      rateLimited = true;
      break;
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
    const { grid } = smoothProfile(raw);
    for (const c of detectClimbs(grid)) {
      climbs.push({
        activity_id: a.id,
        date: a.date,
        title: a.title,
        start_mi: +c.start_mi.toFixed(3),
        length_mi: +c.length_mi.toFixed(3),
        gain_ft: Math.round(c.gain_ft),
        avg_grade_pct: +c.avg_grade_pct.toFixed(2),
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
