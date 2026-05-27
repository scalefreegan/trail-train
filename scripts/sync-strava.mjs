#!/usr/bin/env node
// Pulls Strava activities for a date range and writes web/public/strava.json
// for the TrailTrain dashboard. Refreshes the access token if expired.
//
// Usage:  node scripts/sync-strava.mjs [--start 2026-01-06] [--end 2026-05-27]
//
// Token store: ~/.config/strava-mcp/config.json (shared with strava-mcp)

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fetchWeather, flushWeatherCache } from "./weather.mjs";
import { loadState } from "./state.mjs";

const CONFIG_PATH = path.join(os.homedir(), ".config", "strava-mcp", "config.json");
const OUT_PATH = path.join(process.cwd(), "web", "public", "strava.json");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const START = arg("start", "2026-01-06");
const END   = arg("end",   new Date().toISOString().slice(0, 10));
const SKIP_WEATHER = process.argv.includes("--no-weather");

async function loadConfig() {
  return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
}
async function saveConfig(cfg) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

async function ensureToken(cfg) {
  if (cfg.expiresAt && cfg.expiresAt * 1000 > Date.now() + 60_000) return cfg.accessToken;
  console.log("• refreshing strava token…");
  const r = await fetch("https://www.strava.com/api/v3/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
    }),
  });
  if (!r.ok) throw new Error(`token refresh failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  cfg.accessToken = data.access_token;
  cfg.refreshToken = data.refresh_token;
  cfg.expiresAt = data.expires_at;
  await saveConfig(cfg);
  return cfg.accessToken;
}

async function fetchActivities(token, startIso, endIso) {
  const after  = Math.floor(new Date(startIso + "T00:00:00Z").getTime() / 1000);
  const before = Math.floor(new Date(endIso   + "T23:59:59Z").getTime() / 1000);
  const out = [];
  let page = 1;
  while (true) {
    const url = `https://www.strava.com/api/v3/athlete/activities?after=${after}&before=${before}&per_page=200&page=${page}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`activities fetch failed: ${r.status} ${await r.text()}`);
    const batch = await r.json();
    out.push(...batch);
    if (batch.length < 200) break;
    page += 1;
  }
  return out;
}

function classify(a) {
  const km = a.distance / 1000;
  const name = (a.name || "").toLowerCase();
  if (km >= 25 || /race|50k|50 ?mi|100|jmtr|crest|cedro/.test(name)) return "long";
  if (km < 5)  return "easy";
  const grade = a.total_elevation_gain / Math.max(1, km * 1000);
  if (grade > 0.045) return "vert";
  if (/interval|tempo|workout|repeats|bound|stride/.test(name)) return "workout";
  return "run";
}

function estRpe(a) {
  // crude heuristic: long distance OR high elevation grade OR high HR pushes RPE up
  const km = a.distance / 1000;
  const grade = a.total_elevation_gain / Math.max(1, km * 1000);
  const hr = a.average_heartrate || 0;
  let r = 1;
  if (km > 8)  r = 2;
  if (km > 15) r = 3;
  if (km > 30) r = 4;
  if (grade > 0.05) r += 1;
  if (hr > 155) r += 1;
  return Math.max(1, Math.min(5, r));
}

async function main() {
  // Touch state.json so it gets bootstrapped on first sync (dashboard can
  // read it even before the first coach run).
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  await loadState(ROOT);

  const cfg = await loadConfig();
  const token = await ensureToken(cfg);
  console.log(`• fetching activities ${START} → ${END}…`);
  const raw = await fetchActivities(token, START, END);
  const runs = raw.filter((a) => a.type === "Run" || a.sport_type === "TrailRun");

  const activities = runs.map((a) => {
    const startLatLng = Array.isArray(a.start_latlng) && a.start_latlng.length === 2 ? a.start_latlng : null;
    const startLocal = a.start_date_local || a.start_date;
    return {
      id: String(a.id),
      date: startLocal,
      start_utc: a.start_date,
      start_time_local: startLocal ? startLocal.slice(11, 16) : null, // "HH:MM"
      utc_offset_s: a.utc_offset ?? null,
      timezone: a.timezone ?? null,
      start_latlng: startLatLng,
      title: a.name,
      sport: a.sport_type || a.type,
      type: classify(a),
      distance_m: a.distance,
      elevation_m: a.total_elevation_gain,
      moving_s: a.moving_time,
      elapsed_s: a.elapsed_time,
      avg_hr: a.average_heartrate ?? null,
      max_hr: a.max_heartrate ?? null,
      avg_pace_s_per_km: a.distance > 0 ? a.moving_time / (a.distance / 1000) : null,
      rpe: estRpe(a),
      strava_url: `https://www.strava.com/activities/${a.id}`,
      weather: null,   // populated below
    };
  }).sort((x, y) => y.date.localeCompare(x.date));

  // Weather (Open-Meteo) — sequential to be nice to the free tier. Cached.
  if (!SKIP_WEATHER) {
    console.log(`• fetching weather for ${activities.length} activities…`);
    let wHit = 0, wMiss = 0;
    for (const a of activities) {
      if (!a.start_latlng || !a.start_utc) { wMiss += 1; continue; }
      try {
        const w = await fetchWeather({
          lat: a.start_latlng[0],
          lng: a.start_latlng[1],
          startIso: a.start_utc,
          durationS: a.elapsed_s || a.moving_s || 3600,
        });
        if (w) { a.weather = w; wHit += 1; }
        else   { wMiss += 1; }
      } catch (e) {
        wMiss += 1;
      }
    }
    await flushWeatherCache();
    console.log(`  weather: ${wHit} resolved · ${wMiss} skipped`);
  }

  const totals = activities.reduce(
    (s, a) => ({
      distance_km: s.distance_km + a.distance_m / 1000,
      elevation_m: s.elevation_m + a.elevation_m,
      moving_s:    s.moving_s    + a.moving_s,
      count:       s.count + 1,
    }),
    { distance_km: 0, elevation_m: 0, moving_s: 0, count: 0 }
  );

  const payload = {
    fetched_at: new Date().toISOString(),
    window: { start: START, end: END },
    totals,
    activities,
  };
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`✓ wrote ${activities.length} activities → ${OUT_PATH}`);
  console.log(`  total: ${totals.distance_km.toFixed(1)} km · ${Math.round(totals.elevation_m).toLocaleString()} m vert · ${(totals.moving_s / 3600).toFixed(1)} h`);
}

main().catch((e) => { console.error(e); process.exit(1); });
