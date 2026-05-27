// Historical weather lookup via Open-Meteo's archive API (free, no key).
// For each activity we want the temperatures, humidity, and apparent temp
// during the run window. Cached on disk per (lat-rounded, lng-rounded, date)
// so re-syncs don't re-hit the API.
//
// Open-Meteo archive returns hourly data from 1940 → ~7 days lag. Plenty
// for the 20-week training block. Default rate limits are generous for
// personal use (~10k requests/day).

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const CACHE_PATH = path.join(os.homedir(), ".cache", "trail-train", "weather.json");
const HOT_THRESHOLD_C = 24;   // ≥ 75°F = "heat exposure"

let _cache = null;
async function loadCache() {
  if (_cache !== null) return _cache;
  try { _cache = JSON.parse(await fs.readFile(CACHE_PATH, "utf8")); }
  catch { _cache = {}; }
  return _cache;
}
async function saveCache() {
  if (_cache === null) return;
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(_cache, null, 2));
}

function cacheKey(lat, lng, dateUtc) {
  return `${lat.toFixed(2)}|${lng.toFixed(2)}|${dateUtc}`;
}

/**
 * Fetch hourly weather for the activity window. Returns:
 *   { temp_min_c, temp_max_c, temp_avg_c, apparent_avg_c, humidity_avg, source }
 * or null if lat/lng missing, API failed, or no overlap with the window.
 *
 * @param {{lat:number, lng:number, startIso:string, durationS:number}} args
 */
export async function fetchWeather({ lat, lng, startIso, durationS }) {
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;   // hidden Strava activities

  const cache = await loadCache();
  const startMs = new Date(startIso).getTime();
  const endMs = startMs + (durationS || 3600) * 1000;
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const endDate   = new Date(endMs).toISOString().slice(0, 10);
  const key = cacheKey(lat, lng, startDate + "_" + endDate + "_" + Math.round((endMs - startMs) / 60));

  if (cache[key]) return cache[key];

  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.searchParams.set("latitude",  lat.toFixed(4));
  url.searchParams.set("longitude", lng.toFixed(4));
  url.searchParams.set("start_date", startDate);
  url.searchParams.set("end_date",   endDate);
  url.searchParams.set("hourly", "temperature_2m,relative_humidity_2m,apparent_temperature");
  url.searchParams.set("timezone", "UTC");

  let json;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    json = await r.json();
  } catch (e) {
    console.warn(`  · weather fetch failed for ${lat},${lng} ${startDate}: ${e.message}`);
    return null;
  }

  const times = json?.hourly?.time ?? [];
  const temps = json?.hourly?.temperature_2m ?? [];
  const hums  = json?.hourly?.relative_humidity_2m ?? [];
  const apps  = json?.hourly?.apparent_temperature ?? [];
  if (times.length === 0) return null;

  // Match each hourly bucket to the activity window. Open-Meteo timestamps
  // are "YYYY-MM-DDTHH:00" in the requested timezone (UTC here).
  const tempsIn = [], humsIn = [], appsIn = [];
  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i] + "Z").getTime();   // explicit UTC
    // include hour buckets that overlap the window (±30min slack to capture
    // start/end hours)
    if (t >= startMs - 30 * 60_000 && t <= endMs + 30 * 60_000) {
      if (typeof temps[i] === "number") tempsIn.push(temps[i]);
      if (typeof hums[i]  === "number") humsIn.push(hums[i]);
      if (typeof apps[i]  === "number") appsIn.push(apps[i]);
    }
  }
  if (tempsIn.length === 0) return null;

  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const result = {
    temp_min_c:      +Math.min(...tempsIn).toFixed(1),
    temp_max_c:      +Math.max(...tempsIn).toFixed(1),
    temp_avg_c:      +mean(tempsIn).toFixed(1),
    apparent_avg_c:  appsIn.length ? +mean(appsIn).toFixed(1) : null,
    humidity_avg:    humsIn.length ? +mean(humsIn).toFixed(0) : null,
    samples:         tempsIn.length,
    source:          "open-meteo-archive",
  };
  cache[key] = result;
  return result;
}

export async function flushWeatherCache() { await saveCache(); }
export const WEATHER_HOT_THRESHOLD_C = HOT_THRESHOLD_C;
