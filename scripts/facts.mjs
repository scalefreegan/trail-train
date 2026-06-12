// Shared training-block facts computation. Used by:
//   - scripts/coach.mjs (one-shot readout generator)
//   - web/vite.config.ts /api/chat endpoint (interactive chat with the agent)
//
// Reads strava.json + oura.json from web/public/ and emits the deterministic
// facts the agent should be grounded in.

import fs from "node:fs/promises";
import path from "node:path";
import { loadState } from "./state.mjs";

// Heat exposure threshold (Celsius) — mirrors weather.mjs WEATHER_HOT_THRESHOLD_C.
const HOT_THRESHOLD_C = 24;

/**
 * Load athlete profile (name, location, home trails). Falls back to the
 * generic example file if a personal profile.json doesn't exist yet.
 */
export async function loadProfile(projectRoot) {
  const tryPaths = [
    path.join(projectRoot, "config", "profile.json"),
    path.join(projectRoot, "config", "profile.example.json"),
  ];
  for (const p of tryPaths) {
    try { return JSON.parse(await fs.readFile(p, "utf8")); } catch {}
  }
  return { athlete_name: "the athlete", location: "their home mountains", home_trails: [] };
}

export const RACE = {
  name: "Mogollon Monster 100",
  date: "2026-09-12",
  distance_mi: 102.3,
  elevation_ft: 15900,
  max_elev_ft: 7912,
  cutoff_h: 38,
  location: "Mogollon Rim · Pine, AZ (90 min NE of Phoenix)",
  notes: "Climbs the rim 6×. Technical sections on Highline / Donahue / Myrtle / Promontory.",
};

export const BLOCK_START = "2026-04-27";
export const TOTAL_WEEKS = 20;

export const BLOCK_TARGETS = [
  { wk: 1,  target_dist: 38, target_elev: 5800 },
  { wk: 2,  target_dist: 46, target_elev: 7400 },
  { wk: 3,  target_dist: 52, target_elev: 8900 },
  { wk: 4,  target_dist: 36, target_elev: 5400 },
  { wk: 5,  target_dist: 54, target_elev: 9500 },
  { wk: 6,  target_dist: 60, target_elev: 10800 },
  { wk: 7,  target_dist: 55, target_elev: 9800 },
  { wk: 8,  target_dist: 62, target_elev: 11200 },
  { wk: 9,  target_dist: 38, target_elev: 5800 },
  { wk: 10, target_dist: 70, target_elev: 13400 },
  { wk: 11, target_dist: 78, target_elev: 14600 },
  { wk: 12, target_dist: 72, target_elev: 13200 },
  { wk: 13, target_dist: 42, target_elev: 6100 },
  { wk: 14, target_dist: 68, target_elev: 12400 },
  { wk: 15, target_dist: 58, target_elev: 9400 },
  { wk: 16, target_dist: 52, target_elev: 8200 },
  { wk: 17, target_dist: 42, target_elev: 6200 },
  { wk: 18, target_dist: 30, target_elev: 4200 },
  { wk: 19, target_dist: 18, target_elev: 2400 },
  { wk: 20, target_dist: 102.3, target_elev: 15900 },
];

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

const within = (iso, days, now = Date.now()) =>
  now - new Date(iso).getTime() < days * 86400 * 1000;
const sumNum = (arr) => arr.reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
const avgNum = (arr) => {
  const vs = arr.filter((v) => typeof v === "number");
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
};
const weekIndexFor = (date, blockStart) => {
  const d = new Date(date).getTime();
  const s = new Date(blockStart + "T00:00:00").getTime();
  return Math.floor((d - s) / 86400000 / 7) + 1;
};

const C_TO_F = (c) => c * 9 / 5 + 32;

/**
 * @param {object} strava   — parsed strava.json
 * @param {object|null} oura — parsed oura.json
 * @param {object} state    — loaded state.json (provides block targets, race meta)
 */
export function computeFacts(strava, oura, state) {
  const now = Date.now();
  const race = state?.race ?? RACE;
  const blockStart  = state?.block?.start_date ?? BLOCK_START;
  const totalWeeks  = state?.block?.total_weeks ?? TOTAL_WEEKS;
  const blockTargets = state?.block?.targets ?? BLOCK_TARGETS;
  const heatThresholdC = state?.preferences?.heat_threshold_c ?? 24;

  const acts = (strava?.activities ?? []).map((a) => ({
    ...a,
    distance_mi: a.distance_m / M_PER_MI,
    elevation_ft: a.elevation_m / M_PER_FT,
  }));

  const d7  = acts.filter((a) => within(a.date, 7, now));
  const d28 = acts.filter((a) => within(a.date, 28, now));
  const d7_dist = sumNum(d7.map((a) => a.distance_mi));
  const d28_dist = sumNum(d28.map((a) => a.distance_mi));
  const d7_elev = sumNum(d7.map((a) => a.elevation_ft));
  const d28_elev = sumNum(d28.map((a) => a.elevation_ft));

  // Heat exposure aggregates
  const tempsWithWeather7  = d7.map((a) => a.weather?.temp_avg_c).filter((v) => typeof v === "number");
  const tempsWithWeather28 = d28.map((a) => a.weather?.temp_avg_c).filter((v) => typeof v === "number");
  const heat_avg_c_d7  = avgNum(tempsWithWeather7);
  const heat_avg_c_d28 = avgNum(tempsWithWeather28);
  const hotRunsD28 = d28.filter((a) => (a.weather?.temp_max_c ?? -Infinity) >= heatThresholdC);
  const heat_max_c_d28 = d28
    .map((a) => a.weather?.temp_max_c)
    .filter((v) => typeof v === "number")
    .reduce((m, v) => Math.max(m, v), -Infinity);

  const ouraDays = oura?.days ?? [];
  const o7  = ouraDays.filter((d) => within(d.day, 7, now));
  const o28 = ouraDays.filter((d) => within(d.day, 28, now));
  const hrv_d7  = avgNum(o7.map((d) => d.avg_hrv));
  const hrv_d28 = avgNum(o28.map((d) => d.avg_hrv));
  const rhr_d7  = avgNum(o7.map((d) => d.lowest_hr));
  const rhr_d28 = avgNum(o28.map((d) => d.lowest_hr));
  const readiness_d7 = avgNum(o7.map((d) => d.readiness_score));
  const sleep_total_s = sumNum(o7.map((d) => d.total_sleep_s));
  const sleep_d7_h = sleep_total_s / 3600;
  const recent_tags = ouraDays
    .filter((d) => within(d.day, 7, now))
    .flatMap((d) => (d.tags ?? []).map((t) => ({
      day: d.day,
      label: (t.tags?.[0]) || t.tag_type_code || "tag",
      comment: t.comment,
    })));

  const weekly = Array.from({ length: totalWeeks }, (_, i) => ({
    wk: i + 1, dist_mi: 0, elev_ft: 0, sessions: 0,
  }));
  for (const a of acts) {
    const w = weekIndexFor(a.date, blockStart);
    if (w >= 1 && w <= totalWeeks) {
      weekly[w - 1].dist_mi += a.distance_mi;
      weekly[w - 1].elev_ft += a.elevation_ft;
      weekly[w - 1].sessions += 1;
    }
  }
  const currentWeek = Math.max(1, Math.min(totalWeeks, weekIndexFor(new Date().toISOString(), blockStart)));
  const block_dist_actual = sumNum(weekly.slice(0, currentWeek).map((w) => w.dist_mi));
  const block_elev_actual = sumNum(weekly.slice(0, currentWeek).map((w) => w.elev_ft));
  const block_dist_expected = sumNum(blockTargets.slice(0, currentWeek).map((w) => w.target_dist));
  const block_elev_expected = sumNum(blockTargets.slice(0, currentWeek).map((w) => w.target_elev));

  const longest = d7.reduce((m, a) => (!m || a.distance_mi > m.distance_mi ? a : m), null);
  const daysUntilRace = Math.ceil((new Date(race.date).getTime() - now) / 86400000);

  return {
    today: new Date().toISOString().slice(0, 10),
    race: { ...race, days_until: daysUntilRace },
    block: {
      current_week: currentWeek,
      total_weeks: totalWeeks,
      block_start: blockStart,
      dist_actual_mi: +block_dist_actual.toFixed(1),
      dist_expected_mi: +block_dist_expected.toFixed(1),
      dist_delta_pct: +(((block_dist_actual - block_dist_expected) / Math.max(1, block_dist_expected)) * 100).toFixed(1),
      elev_actual_ft: Math.round(block_elev_actual),
      elev_expected_ft: Math.round(block_elev_expected),
      elev_delta_pct: +(((block_elev_actual - block_elev_expected) / Math.max(1, block_elev_expected)) * 100).toFixed(1),
      weekly_actual: weekly.map((w) => ({ wk: w.wk, dist_mi: +w.dist_mi.toFixed(1), elev_ft: Math.round(w.elev_ft), sessions: w.sessions })),
      weekly_target: blockTargets,
    },
    load: {
      d7_dist_mi: +d7_dist.toFixed(1),
      d28_dist_mi: +d28_dist.toFixed(1),
      d7_elev_ft: Math.round(d7_elev),
      d28_elev_ft: Math.round(d28_elev),
      acr_dist: d28_dist > 0 ? +(d7_dist / (d28_dist / 4)).toFixed(2) : 1,
      acr_elev: d28_elev > 0 ? +(d7_elev / (d28_elev / 4)).toFixed(2) : 1,
      sessions_d7: d7.length,
      longest_d7: longest ? {
        title: longest.title,
        date: longest.date.slice(0, 10),
        distance_mi: +longest.distance_mi.toFixed(1),
        elevation_ft: Math.round(longest.elevation_ft),
        moving_h: +(longest.moving_s / 3600).toFixed(2),
      } : null,
      heat_threshold_c: heatThresholdC,
      heat_threshold_f: +C_TO_F(heatThresholdC).toFixed(0),
      heat_avg_c_d7:    heat_avg_c_d7  != null ? +heat_avg_c_d7.toFixed(1)  : null,
      heat_avg_f_d7:    heat_avg_c_d7  != null ? +C_TO_F(heat_avg_c_d7).toFixed(0) : null,
      heat_avg_c_d28:   heat_avg_c_d28 != null ? +heat_avg_c_d28.toFixed(1) : null,
      heat_max_c_d28:   Number.isFinite(heat_max_c_d28) ? +heat_max_c_d28.toFixed(1) : null,
      heat_max_f_d28:   Number.isFinite(heat_max_c_d28) ? +C_TO_F(heat_max_c_d28).toFixed(0) : null,
      hot_runs_d28:     hotRunsD28.length,
      hot_runs_d28_details: hotRunsD28.slice(0, 5).map((a) => ({
        date: a.date.slice(0, 10),
        title: a.title,
        temp_max_c: a.weather.temp_max_c,
        temp_max_f: +C_TO_F(a.weather.temp_max_c).toFixed(0),
      })),
    },
    recovery: oura ? {
      hrv_d7:  hrv_d7  != null ? +hrv_d7.toFixed(1)  : null,
      hrv_d28: hrv_d28 != null ? +hrv_d28.toFixed(1) : null,
      hrv_ratio: hrv_d7 != null && hrv_d28 != null ? +(hrv_d7 / hrv_d28).toFixed(3) : null,
      rhr_d7:  rhr_d7  != null ? +rhr_d7.toFixed(1)  : null,
      rhr_d28: rhr_d28 != null ? +rhr_d28.toFixed(1) : null,
      rhr_drift_bpm: rhr_d7 != null && rhr_d28 != null ? +(rhr_d7 - rhr_d28).toFixed(1) : null,
      readiness_d7: readiness_d7 != null ? +readiness_d7.toFixed(0) : null,
      sleep_d7_h: +sleep_d7_h.toFixed(1),
      sleep_debt_h: +(56 - sleep_d7_h).toFixed(1),
      recent_tags,
    } : null,
    recent_runs: acts.slice(0, 14).map((a) => ({
      date: a.date.slice(0, 10),
      start_time_local: a.start_time_local || null,
      title: a.title,
      type: a.type,
      distance_mi: +a.distance_mi.toFixed(1),
      elevation_ft: Math.round(a.elevation_ft),
      moving_h: +(a.moving_s / 3600).toFixed(2),
      avg_hr: a.avg_hr,
      temp_avg_f: a.weather?.temp_avg_c != null ? +C_TO_F(a.weather.temp_avg_c).toFixed(0) : null,
      temp_max_f: a.weather?.temp_max_c != null ? +C_TO_F(a.weather.temp_max_c).toFixed(0) : null,
      apparent_avg_f: a.weather?.apparent_avg_c != null ? +C_TO_F(a.weather.apparent_avg_c).toFixed(0) : null,
      humidity_avg: a.weather?.humidity_avg ?? null,
    })),
    plan_blocks: state?.plan_blocks ?? [],
    agent_notes: (state?.agent_notes ?? []).slice(-10),
    preferences: state?.preferences ?? {},
  };
}

export async function loadFactsFromRoot(projectRoot) {
  const stravaPath  = path.join(projectRoot, "web", "public", "strava.json");
  const ouraPath    = path.join(projectRoot, "web", "public", "oura.json");
  const calPath     = path.join(projectRoot, "web", "public", "google-cal.json");
  const [strava, oura, cal, profile, state] = await Promise.all([
    fs.readFile(stravaPath, "utf8").then(JSON.parse).catch(() => null),
    fs.readFile(ouraPath,   "utf8").then(JSON.parse).catch(() => null),
    fs.readFile(calPath,    "utf8").then(JSON.parse).catch(() => null),
    loadProfile(projectRoot),
    loadState(projectRoot),
  ]);
  if (!strava) throw new Error("strava.json missing — run sync:strava");
  const base = { profile, state, ...computeFacts(strava, oura, state) };
  if (cal) {
    base.calendar = {
      fetched_at: cal.fetched_at,
      summary: cal.summary,
      // Upcoming events for the next 14 days, classified — agent uses these
      // for schedule constraints (travel, races, work blocks, appointments).
      // All-day starts are date-only strings that Date() parses as UTC
      // midnight ("past" for most of the local day), so compare those by
      // local date instead of timestamp.
      upcoming_14d: (cal.events || [])
        .filter((e) => {
          if (!e.start) return false;
          const now = new Date();
          const horizon = new Date(now.getTime() + 14 * 86400_000);
          if (e.all_day) {
            const localIso = (d) =>
              `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            const day = e.start.slice(0, 10);
            return day >= localIso(now) && day <= localIso(horizon);
          }
          const t = new Date(e.start);
          return t >= now && t <= horizon;
        })
        .slice(0, 40)
        .map((e) => ({
          start: e.start,
          end: e.end,
          all_day: e.all_day,
          duration_min: e.duration_min,
          summary: e.summary,
          location: e.location,
          classification: e.classification,
        })),
      // Schedule-shaping events over the FULL fetched window (~30 days), not
      // just 14 — the planner writes 6 weeks of plan_blocks, so a trip or a
      // recurring family commitment 3 weeks out must be visible. Includes
      // travel/race/family classifications plus any multi-day all-day block
      // (a week-long trip often appears as a bare place-name event).
      upcoming_notable: (() => {
        const localIso = (d) =>
          `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const todayIso = localIso(new Date());
        return (cal.events || [])
          .filter((e) => {
            if (!e.start) return false;
            const startDay = e.start.slice(0, 10);
            const endDay = (e.end || e.start).slice(0, 10);
            // all-day `end` is exclusive per the Google API — an all-day
            // event whose end equals today already finished yesterday
            const ended = e.all_day ? endDay <= todayIso : endDay < todayIso;
            if (ended && startDay < todayIso) return false;
            // exclusive ends also mean a single-day all-day event has
            // end = start + 1; only 2+ covered days suggests a trip
            const multiDay =
              e.all_day && (Date.parse(endDay) - Date.parse(startDay)) / 86400_000 > 1;
            return ["travel", "race", "family"].includes(e.classification) || multiDay;
          })
          .slice(0, 30)
          .map((e) => ({
            start: e.start,
            end: e.end,
            all_day: e.all_day,
            summary: e.summary,
            classification: e.classification,
          }));
      })(),
    };
  }
  return base;
}
