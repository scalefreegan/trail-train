// Shared training-block facts computation. Used by:
//   - scripts/coach.mjs (one-shot readout generator)
//   - web/vite.config.ts /api/chat endpoint (interactive chat with the agent)
//
// Reads strava.json + oura.json from web/public/ and emits the deterministic
// facts the agent should be grounded in.

import fs from "node:fs/promises";
import path from "node:path";
import { loadState, loadPlanBlocks, activeContext, isoDate } from "./state.mjs";
import { bRacesFor, listRaces, loadActiveRaceFolder, raceDir, raceKind } from "./race-config.mjs";
import { loadGoals } from "./goals.mjs";
import { ROLLING_WEEKS, rollingBlock } from "./block.mjs";
import { raceStart, isValidTimeZone } from "./clock.mjs";

// Heat exposure threshold (Celsius) — mirrors weather.mjs WEATHER_HOT_THRESHOLD_C.
const HOT_THRESHOLD_C = 24;

// Athlete profile (name, location, home trails, physiology). The loader moved
// to scripts/profile.mjs in tt-yib.9 — physiology defaults and validation are
// shared with the settings API, and a module that only reads config/ is a
// cheaper import for vite.config.ts than all of facts.mjs. Re-exported here
// so every existing `import { loadProfile } from "./facts.mjs"` still works.
import { loadProfile } from "./profile.mjs";
import { deriveArrival } from "./acclimation.mjs";
export { loadProfile };

// Generic mode's window length. Re-exported because this module was its
// original home and coach.mjs/the tests import it from here; the definition
// (and the window arithmetic) now lives in block.mjs, shared with the
// dev server's /api/race/active.
export { ROLLING_WEEKS };

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

/**
 * Warnings already printed by this process, for the same reason
 * profile.mjs's `warned` Set exists: trainingContext()/computeFacts() are
 * called on every coach-chat message and every loadFactsFromRoot call, and a
 * race whose timezone stays unconfirmed for the length of a draft reprints
 * this warning on EVERY one of those — noise that trains the reader to skip
 * it, and, per profile.mjs's own comment, enough interleaved child-process
 * writes to intermittently corrupt `node --test`'s message framing.
 */
const daysUntilRaceWarned = new Set();

/** Forget what has been printed — for tests that assert on the warnings. */
export function resetDaysUntilRaceWarnings() {
  daysUntilRaceWarned.clear();
}

/** Each distinct warning printed once per process. Keyed on the race
    identity + timezone value rather than the message text, so a race whose
    slug/date stays the same but whose timezone is corrected mid-session
    warns again — the whole point is to stop repeating the SAME diagnosis,
    not to permanently silence a race that later has a real, different problem. */
function warnDaysUntilRaceOnce(race, message) {
  const key = `${race?.slug ?? race?.date}:${race?.timezone}`;
  if (daysUntilRaceWarned.has(key)) return;
  daysUntilRaceWarned.add(key);
  console.warn(message);
}

/**
 * Days remaining until race day, counted against the race's OWN wall clock
 * (scripts/clock.mjs's raceStart) rather than the machine's zone — a race
 * whose timezone differs from the athlete's laptop must not read as "started"
 * a day early or late just because the process happens to be elsewhere.
 *
 * Falls back to a naive local-machine parse of `race.date` (the pre-fix
 * behavior) only when the timezone is missing, not a zone this runtime
 * recognizes, or the race's date/start_time can't be parsed as race-local
 * wall clock — with a console.warn either way (deduped per race+timezone,
 * see warnDaysUntilRaceOnce), since a silent fallback here is exactly the
 * bug this function replaces (facts.mjs:251-253 in the review: a Phoenix
 * race trained for from Denver read as already started).
 * @param {{date?:string, start_time?:string, timezone?:string}|null} race
 * @param {number} now epoch ms
 * @returns {number|null}
 */
// Exported (PR #23 review round 1, resilience finding 12) so
// scripts/race-payload.mjs's GET /api/race/active — the OTHER place "how
// many days until this race" is answered — uses the exact same race-local,
// zone-aware math instead of a second, drifting implementation.
export function computeDaysUntilRace(race, now) {
  if (!race?.date) return null;
  if (!race.timezone || !isValidTimeZone(race.timezone)) {
    warnDaysUntilRaceOnce(
      race,
      `• race.timezone ${JSON.stringify(race.timezone)} missing/invalid — ` +
        `days_until computed in the machine's local zone, not the race's`,
    );
  } else {
    try {
      const startMs = raceStart(race.date, race.start_time ?? "00:00", race.timezone).getTime();
      return Math.ceil((startMs - now) / 86400000);
    } catch (e) {
      warnDaysUntilRaceOnce(
        race,
        `• race ${JSON.stringify(race.date)} ${JSON.stringify(race.start_time)} in zone ` +
          `${race.timezone} unparseable (${e.message}) — days_until computed in the machine's local zone`,
      );
    }
  }
  return Math.ceil((new Date(`${race.date}T00:00:00`).getTime() - now) / 86400000);
}

const C_TO_F = (c) => c * 9 / 5 + 32;

/**
 * Fit a personal pacing model from the athlete's own runs so the coach can
 * estimate how long a proposed session will actually take. Moving pace rises
 * with vert-per-distance (climbing is slow) and with total distance (fatigue),
 * which is exactly where a flat-road assumption breaks — an 18mi/4000ft day is
 * not the same 3h as 18mi on the bike path.
 *
 * Model: moving_s_per_mi ≈ base + kVert·(vert_ft_per_mi) + kDist·(dist_mi),
 * fit by ordinary least squares (3x3 normal equations, no deps) over every run
 * ≥2mi with a moving time. Returns null if too few runs to fit.
 *
 * @param {{distance_mi:number, elevation_ft:number, moving_s:number}[]} acts
 */
function fitPacing(acts) {
  const rows = acts
    .filter((a) => a.distance_mi >= 2 && a.moving_s > 0 && a.elevation_ft != null)
    .map((a) => ({
      vfpm: a.elevation_ft / a.distance_mi,   // vert ft per mile
      dmi: a.distance_mi,
      y: a.moving_s / a.distance_mi,           // moving s per mile
    }));
  if (rows.length < 8) return null;

  // 3x3 normal equations for features [1, vfpm, dmi]
  const Sxx = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Sxy = [0, 0, 0];
  for (const { vfpm, dmi, y } of rows) {
    const f = [1, vfpm, dmi];
    for (let i = 0; i < 3; i++) {
      Sxy[i] += f[i] * y;
      for (let j = 0; j < 3; j++) Sxx[i][j] += f[i] * f[j];
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
  const predict = (vfpm, dmi) => base + kVert * vfpm + kDist * dmi;

  // residual spread, as a ± confidence band the coach can quote
  const resid = rows.map((r) => r.y - predict(r.vfpm, r.dmi));
  const residStd = Math.sqrt(sumNum(resid.map((e) => e * e)) / resid.length);

  // Reference grid spanning the athlete's real terrain (flat → steep) and
  // session lengths, so the agent can read off / interpolate a duration
  // without doing the regression arithmetic itself.
  const reference = [];
  for (const dmi of [6, 10, 13, 18, 26]) {
    for (const vfpm of [50, 150, 250, 350]) {
      const s = predict(vfpm, dmi);
      reference.push({
        distance_mi: dmi,
        vert_ft: Math.round(vfpm * dmi),
        vert_ft_per_mi: vfpm,
        pace_min_per_mi: +(s / 60).toFixed(1),
        moving_h: +(s * dmi / 3600).toFixed(2),
      });
    }
  }

  return {
    basis: `fit from ${rows.length} runs ≥2mi (Strava moving time)`,
    model: "moving_s_per_mi = base + kVert·vert_ft_per_mi + kDist·dist_mi",
    base_pace_min_per_mi: +(base / 60).toFixed(2),
    add_min_per_mi_per_100ft_vert_per_mi: +(kVert * 100 / 60).toFixed(2),
    add_min_per_mi_per_10mi_distance: +(kDist * 10 / 60).toFixed(2),
    fit_error_min_per_mi: +(residStd / 60).toFixed(2),
    reference,
  };
}

/**
 * @param {object} strava    — parsed strava.json
 * @param {object|null} oura — parsed oura.json
 * @param {object} ctx       — state.json's athlete-level fields (preferences,
 *   agent_notes) merged with the training context assembled by
 *   loadFactsFromRoot: `race` + `block` from the ACTIVE race folder, or
 *   `goals` (config/goals.json) when none is active, plus `plan_blocks`.
 *   Every field is optional — with no race and no goals file this still
 *   returns a complete facts object, just a raceless one.
 * @param {number} [now]     — "now" in ms, injectable so tests can pin a date
 */
export function computeFacts(strava, oura, ctx, now = Date.now()) {
  const today = new Date(now);
  const race = ctx?.race ?? null;
  // Goals only steer the coach in generic mode; with a race active the race
  // and its block.json are the plan, and a stale goals file must not show up
  // beside them as a second, contradicting target.
  const goals = race ? null : (ctx?.goals ?? null);
  // A race whose folder carries no usable block.json (a draft, or one the
  // intake hasn't planned yet) still gets the rolling window — better a
  // window of real weeks than a block with no targets in it.
  const raceBlock = race && ctx?.block?.start_date && ctx?.block?.total_weeks ? ctx.block : null;
  // One definition of the rolling window, shared with the client payload.
  const rolling = raceBlock ? null : rollingBlock(goals, ctx?.plan_blocks, now);
  const blockStart   = raceBlock ? raceBlock.start_date  : rolling.start_date;
  const totalWeeks   = raceBlock ? raceBlock.total_weeks : rolling.total_weeks;
  const blockTargets = raceBlock ? (raceBlock.targets ?? []) : rolling.targets;
  const heatThresholdC = ctx?.preferences?.heat_threshold_c ?? 24;

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
  const heat_index_avg_c_d7  = avgNum(d7.map((a) => a.weather?.apparent_avg_c).filter((v) => typeof v === "number"));
  const heat_index_avg_c_d28 = avgNum(d28.map((a) => a.weather?.apparent_avg_c).filter((v) => typeof v === "number"));
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
  // Debt counts only nights with data (an un-synced night isn't 0h slept);
  // target prorates to 8h per recorded night. Mirrors computeCoachFacts.
  const sleepNights = o7.filter((d) => typeof d.total_sleep_s === "number");
  const sleep_total_s = sumNum(sleepNights.map((d) => d.total_sleep_s));
  const sleep_d7_h = sleep_total_s / 3600;
  const sleep_debt_h = sleepNights.length ? sleepNights.length * 8 - sleep_d7_h : null;
  // Per-night series. The d7/d28 aggregates above answer "is the trend bad",
  // but not "which nights, and were any of them missing" — and an agent asked
  // to reason about sleep would otherwise open oura.json, which is ~5k lines
  // and costs three Read calls out of a headless turn budget. One compact row
  // per night for three weeks is a few hundred bytes and removes the reason to
  // open the raw snapshot at all. Nights with NO record are deliberately
  // absent rather than zero-filled: sleep_d7_h is a total over recorded nights
  // only, so a reader has to be able to see which nights are missing to
  // interpret it (an un-synced night is not a sleepless one).
  const nights = ouraDays
    .filter((d) => within(d.day, 21, now))
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .map((d) => ({
      day: d.day,
      sleep_h: typeof d.total_sleep_s === "number" ? +(d.total_sleep_s / 3600).toFixed(2) : null,
      sleep_score: d.sleep_score ?? null,
      readiness: d.readiness_score ?? null,
      hrv: d.avg_hrv ?? null,
      rhr: d.lowest_hr ?? null,
    }));

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
  const currentWeek = Math.max(1, Math.min(totalWeeks, weekIndexFor(today.toISOString(), blockStart)));
  const block_dist_actual = sumNum(weekly.slice(0, currentWeek).map((w) => w.dist_mi));
  const block_elev_actual = sumNum(weekly.slice(0, currentWeek).map((w) => w.elev_ft));
  const block_dist_expected = sumNum(blockTargets.slice(0, currentWeek).map((w) => w.target_dist));
  const block_elev_expected = sumNum(blockTargets.slice(0, currentWeek).map((w) => w.target_elev));

  const longest = d7.reduce((m, a) => (!m || a.distance_mi > m.distance_mi ? a : m), null);
  // null, not a number, with no race — there is nothing to count down to,
  // and a 0 or a NaN here reads as "race day" to everything downstream.
  const daysUntilRace = computeDaysUntilRace(race, now);

  return {
    // local date, matching the expiry filtering — a UTC date would tell the
    // agent it's tomorrow from ~17:00 MT and skew its expiry reasoning
    today: isoDate(today),
    // null in generic mode. Every consumer must treat a raceless app as the
    // normal case: it is what the athlete sees between races.
    race: race ? { ...race, days_until: daysUntilRace } : null,
    // Also at the top level so "how far out are we?" has one answer that
    // doesn't require reaching through a possibly-null race.
    days_until: daysUntilRace,
    // The athlete's standing goals, in place of a race (PRD §5.3). null
    // whenever a race IS active — then the race is the goal.
    goals,
    // Races already run (archived folders) with their results and the notes
    // the coach wrote about them. Always an array, empty for a first-timer.
    history: (ctx?.history ?? []).map((h) => ({ ...h, agent_notes: notesAboutRace(ctx?.agent_notes, h) })),
    block: {
      // "race" = the active folder's block.json, counting toward a date;
      // "rolling" = the trailing 12-week window of generic mode.
      mode: raceBlock ? "race" : "rolling",
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
      heat_index_avg_c_d7:  heat_index_avg_c_d7  != null ? +heat_index_avg_c_d7.toFixed(1)  : null,
      heat_index_avg_f_d7:  heat_index_avg_c_d7  != null ? +C_TO_F(heat_index_avg_c_d7).toFixed(0)  : null,
      heat_index_avg_c_d28: heat_index_avg_c_d28 != null ? +heat_index_avg_c_d28.toFixed(1) : null,
      heat_index_avg_f_d28: heat_index_avg_c_d28 != null ? +C_TO_F(heat_index_avg_c_d28).toFixed(0) : null,
      hot_runs_d28:     hotRunsD28.length,
      hot_runs_d28_details: hotRunsD28.slice(0, 5).map((a) => ({
        date: a.date.slice(0, 10),
        title: a.title,
        temp_max_c: a.weather.temp_max_c,
        temp_max_f: +C_TO_F(a.weather.temp_max_c).toFixed(0),
        apparent_avg_f: a.weather.apparent_avg_c != null ? +C_TO_F(a.weather.apparent_avg_c).toFixed(0) : null,
      })),
    },
    pacing: fitPacing(acts),
    recovery: oura ? {
      hrv_d7:  hrv_d7  != null ? +hrv_d7.toFixed(1)  : null,
      hrv_d28: hrv_d28 != null ? +hrv_d28.toFixed(1) : null,
      hrv_ratio: hrv_d7 != null && hrv_d28 != null ? +(hrv_d7 / hrv_d28).toFixed(3) : null,
      rhr_d7:  rhr_d7  != null ? +rhr_d7.toFixed(1)  : null,
      rhr_d28: rhr_d28 != null ? +rhr_d28.toFixed(1) : null,
      rhr_drift_bpm: rhr_d7 != null && rhr_d28 != null ? +(rhr_d7 - rhr_d28).toFixed(1) : null,
      readiness_d7: readiness_d7 != null ? +readiness_d7.toFixed(0) : null,
      sleep_d7_h: +sleep_d7_h.toFixed(1),
      sleep_debt_h: sleep_debt_h != null ? +sleep_debt_h.toFixed(1) : null,
      // nights with no Oura record are omitted, not zeroed — see above
      nights_recorded_d7: sleepNights.length,
      nights,
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
    plan_blocks: ctx?.plan_blocks ?? [],
    agent_notes: (ctx?.agent_notes ?? []).slice(-10),
    // expired temporary context items are filtered out here — the agent
    // only ever sees constraints still in force. Local date, not UTC: an
    // item must stay active through the end of its expires day here.
    preferences: activeContext(ctx?.preferences ?? {}, isoDate(today)),
  };
}

/**
 * What the athlete is training FOR, right now: the active race folder, or —
 * with none active — the goals file that drives generic mode. Also resolves
 * where the plan lives (the race's plan.json, or config/generic-plan.json).
 *
 * Nothing here throws on race absence: generic mode is the default state of
 * the app, and even a broken pointer degrades to it with a warning rather
 * than taking the dashboard down.
 * @param {string} projectRoot
 * @param {object|null} [calendar] web/public/google-cal.json, already loaded
 *   by the caller — the acclimation derivation reads its travel events
 * @returns {Promise<{race: object|null, block: object|null, goals: object|null, plan_blocks: object[]}>}
 */
async function trainingContext(projectRoot, calendar = null) {
  const folder = await loadActiveRaceFolder(projectRoot).catch((e) => {
    console.warn(`• active race unreadable (${e.message}) — coaching in generic mode`);
    return null;
  });
  const { plan_blocks } = await loadPlanBlocks(projectRoot);
  // One listing, two questions: what the athlete has already run (history)
  // and which tune-ups sit inside the current block (race.b_races below).
  const races = await listRaces(projectRoot).catch((e) => {
    console.warn(`• races/ unreadable (${e.message}) — coaching without race history`);
    return [];
  });
  const history = await raceHistory(projectRoot, races);
  if (!folder) {
    const { goals, bootstrapped, errors } = await loadGoals(projectRoot).catch((e) => {
      console.warn(`• config/goals.json unreadable (${e.message}) — coaching without goals`);
      return { goals: null, bootstrapped: false, errors: [] };
    });
    if (bootstrapped) console.log("• created config/goals.json (phase: maintain) — edit it in coach settings");
    for (const err of errors) console.warn(`• config/goals.json: ${err}`);
    return { race: null, block: null, goals, plan_blocks, history };
  }
  const { race, block } = folder;
  return {
    race: {
      // slug so the prompt can name the folder's own files (races/<slug>/…)
      // in the agent's Read list
      slug: folder.slug,
      name: race.name,
      short: race.short,
      date: race.date,
      start_time: race.start_time,
      // the race-local zone: race day's weekday, and every clock in the prompt
      timezone: race.timezone ?? null,
      distance_mi: race.distance_mi,
      elevation_ft: race.gain_ft,
      max_elev_ft: race.elevation?.max_ft ?? null,
      cutoff_h: race.cutoff_h ?? null,
      location: race.location ?? "",
      // The v2 `notes` string was a lossy join of these sections; the prompt
      // now quotes each section verbatim, so pass them through as authored.
      coach_notes: race.coach_notes ?? {},
      // What the course asks for (night, heat, altitude, water crossings) and
      // what it withholds (crew, drop bags, pacers) — both are training demands.
      features: race.features ?? {},
      elevation: race.elevation ?? null,
      // The course's spine. The agent was previously given a bare name list
      // and could not reason about cutoff margins or where crew may appear.
      aid_stations: (race.aid_stations ?? []).map((a) => ({
        name: a.name,
        total_mi: a.total_mi,
        cutoff_h: a.cutoff_h ?? null,
        crew: Boolean(a.crew),
        drop_bag: Boolean(a.drop_bag),
        pacers: Boolean(a.pacers),
      })),
      // The tune-ups entered INSIDE this block (PRD-v2 §3), oldest first,
      // each with the weeks between it and race day. The same list the
      // dashboard draws markers from (scripts/race-payload.mjs) — one
      // function, so the coach cannot plan a taper around a race the
      // trajectory does not show.
      b_races: bRacesFor(races, { ...race, slug: folder.slug }),
      // When the athlete reaches the race's elevation, and where that came
      // from (PRD-v2 §2). Same function the dashboard payload calls
      // (scripts/race-payload.mjs), so the coach cannot be planning a taper
      // around a different arrival than the planner is projecting off. The
      // planner's manual override lives in the browser and is NOT visible
      // here — `source` therefore reads "calendar" or "default" only, and
      // the prompt should treat the number as the derived one.
      acclimation: deriveArrival({ race, calendar }),
    },
    block: block ?? null,
    goals: null,
    plan_blocks,
    history,
  };
}

/**
 * Races the athlete has already run: every archived folder, newest first,
 * with its result.json summary when one exists.
 *
 * Emitted in BOTH modes — the last race is evidence whether or not another
 * one is on the calendar. result.json is gitignored (it records a real
 * finish), so its absence is normal and lands as `result: null` rather than
 * dropping the race from the athlete's history.
 * A finished TUNE-UP is history too — `kind` says which it was, so the coach
 * reads a B-race finish as the rehearsal it was rather than as a goal race.
 * @param {string} projectRoot
 * @param {{slug: string, race: object|null}[]} races listRaces' output
 * @returns {Promise<{slug, name, kind, date, distance_mi, gain_ft, result}[]>}
 */
async function raceHistory(projectRoot, races) {
  const archived = races.filter((r) => r.race?.status === "archived");
  const out = [];
  for (const { slug, race } of archived) {
    const result = await fs
      .readFile(path.join(raceDir(projectRoot, slug), "result.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    out.push({
      slug,
      name: race.name,
      short: race.short ?? null,
      kind: raceKind(race),
      date: race.date ?? null,
      distance_mi: race.distance_mi ?? null,
      gain_ft: race.gain_ft ?? null,
      result: result
        ? {
            status: result.status ?? null,
            finish_h: result.finish_h ?? null,
            official_time: result.official_time ?? null,
            placement: result.placement ?? null,
            notes: result.notes ?? null,
          }
        : null,
    });
  }
  return out.sort((a, b) => String(b.date ?? "").localeCompare(String(a.date ?? "")));
}

/**
 * The agent's own notes about a past race — matched on the race's name or its
 * short code, most recent last. Capped at 3: this is a reminder of what the
 * coach already concluded, not the whole history.
 */
function notesAboutRace(agentNotes, race) {
  const needles = [race.name, race.short].filter((s) => typeof s === "string" && s.trim().length > 2)
    .map((s) => s.toLowerCase());
  if (!needles.length || !Array.isArray(agentNotes)) return [];
  return agentNotes
    .filter((n) => needles.some((needle) => String(n?.note ?? "").toLowerCase().includes(needle)))
    .slice(-3);
}

export async function loadFactsFromRoot(projectRoot) {
  const stravaPath  = path.join(projectRoot, "web", "public", "strava.json");
  const crossPath   = path.join(projectRoot, "web", "public", "cross-train.json");
  const ouraPath    = path.join(projectRoot, "web", "public", "oura.json");
  const calPath     = path.join(projectRoot, "web", "public", "google-cal.json");
  const [strava, cross, oura, cal, profile, state] = await Promise.all([
    fs.readFile(stravaPath, "utf8").then(JSON.parse).catch((e) => {
      // absent is expected (pre-first-sync); anything else deserves a trace —
      // same ENOENT-vs-other distinction as cross-train.json just below.
      if (e.code !== "ENOENT") console.warn(`${stravaPath} unreadable: ${e.message}`);
      return null;
    }),
    fs.readFile(crossPath,  "utf8").then(JSON.parse).catch((e) => {
      // absent is expected (pre-first-sync); anything else deserves a trace
      if (e.code !== "ENOENT") console.warn(`cross-train.json unreadable: ${e.message}`);
      return null;
    }),
    fs.readFile(ouraPath,   "utf8").then(JSON.parse).catch((e) => {
      if (e.code !== "ENOENT") console.warn(`${ouraPath} unreadable: ${e.message}`);
      return null;
    }),
    fs.readFile(calPath,    "utf8").then(JSON.parse).catch((e) => {
      if (e.code !== "ENOENT") console.warn(`${calPath} unreadable: ${e.message}`);
      return null;
    }),
    loadProfile(projectRoot),
    loadState(projectRoot),
  ]);
  // state.json no longer carries race/block/plan_blocks (v3) — the race (or
  // the goals that stand in for it) comes from the folder, not from state.
  const ctx = { ...state, ...(await trainingContext(projectRoot, cal)) };
  if (!strava) throw new Error("strava.json missing — run sync:strava");
  const base = {
    profile,
    // same expiry filter on the embedded raw state, so the agent can't see
    // expired temporary items through this path either
    // Identity only. Every substantive field of state.json is already broken
    // out at the top level of this digest (race/goals, block, plan_blocks,
    // agent_notes, preferences), so embedding the whole blob here duplicated
    // ~25 KB — a third of the file — into a digest whose entire purpose is to
    // be readable in a single Read call. `agent_notes` alone was the full
    // history against the ten recent ones at top level. Nothing consumes these
    // contents: coach.mjs tests `facts.state` for truthiness and then reloads
    // state fresh from disk on purpose (a snapshot minutes old would clobber a
    // concurrent settings save), so the key stays present and truthy.
    state: { version: state?.version ?? null, last_updated: state?.last_updated ?? null },
    ...computeFacts(strava, oura, ctx),
  };
  if (cross) {
    // Non-run activities (rides, hikes, strength, …) — context only. None of
    // the load metrics above (d7/d28, ACR, weekly, pacing) include these.
    // Emitted even when empty: "snapshot present, athlete did no cross-training"
    // is a different coaching signal from "no snapshot".
    const crossActs = cross.activities || [];
    base.cross_training = {
      fetched_at: cross.fetched_at,
      note: "Non-run activities. EXCLUDED from every load metric (d7/d28 distance, ACR, weekly actuals, pacing model) — those count runs only. Use qualitatively: systemic fatigue, time-on-feet, schedule load. `recent` lists only the latest 20; `count` and `totals` cover the full sync window.",
      count: crossActs.length,
      // derived from the activities, not the file's totals key — a snapshot
      // missing `totals` must not become confident zeros
      totals: {
        distance_mi: +(sumNum(crossActs.map((a) => a.distance_m)) / M_PER_MI).toFixed(1),
        elevation_ft: Math.round(sumNum(crossActs.map((a) => a.elevation_m)) / M_PER_FT),
        moving_h: +(sumNum(crossActs.map((a) => a.moving_s)) / 3600).toFixed(1),
      },
      recent: crossActs.slice(0, 20).map((a) => ({
        date: (a.date || "").slice(0, 10),
        start_time_local: a.start_time_local || null,
        title: a.title,
        sport: a.sport,
        distance_mi: +((a.distance_m || 0) / M_PER_MI).toFixed(1),
        elevation_ft: Math.round((a.elevation_m || 0) / M_PER_FT),
        moving_h: +((a.moving_s || 0) / 3600).toFixed(2),
        avg_hr: a.avg_hr ?? null,
      })),
    };
  }
  if (cal) {
    base.calendar = {
      fetched_at: cal.fetched_at,
      summary: cal.summary,
      // Upcoming events for the next 14 days, classified — agent uses these
      // for schedule constraints (travel, races, work blocks, appointments).
      // All-day starts are date-only strings that Date() parses as UTC
      // midnight ("past" for most of the local day), so compare those by
      // local date instead of timestamp. Events already underway (a multi-day
      // span whose start is behind us but whose end isn't) stay included.
      upcoming_14d: (cal.events || [])
        .filter((e) => {
          if (!e.start) return false;
          const now = new Date();
          const horizon = new Date(now.getTime() + 14 * 86400_000);
          if (e.all_day) {
            const localIso = (d) =>
              `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            const startDay = e.start.slice(0, 10);
            const endDay = (e.end || e.start).slice(0, 10); // exclusive end
            return endDay > localIso(now) && startDay <= localIso(horizon);
          }
          const t = new Date(e.end || e.start);
          return t >= now && new Date(e.start) <= horizon;
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
      // travel/race/family/childcare classifications plus any multi-day all-day block
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
            return ["travel", "race", "family", "childcare"].includes(e.classification) || multiDay;
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
