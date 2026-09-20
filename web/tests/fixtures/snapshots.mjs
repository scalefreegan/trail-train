// Synthetic dashboard snapshots for the Playwright suite.
//
// These stand in for web/public/{strava,cross-train,oura,google-cal,coach,
// state,climbs,pace-grade}.json — the eight files `npm run sync:*` and the
// coach normally write, all of which are gitignored because the real ones are
// a year of somebody's sleep, heart rate, runs and calendar.
//
// GENERATED rather than committed as static JSON for one reason: every panel
// on the dashboard is a function of "how long ago". A committed snapshot with
// hard-coded dates reads as "SNAPSHOT FROM 412D AGO" a year after it is
// written, the trailing-12-week buckets come out empty, and the suite starts
// failing for a reason that has nothing to do with the code under test. So
// the launcher asks for the data anchored at the moment it runs.
//
// Deterministic all the same: one fixed seed drives a small PRNG, so the same
// `now` always yields byte-identical files and a failure is reproducible.
//
// Nothing here is real. Place names are invented, the athlete is "the
// athlete", every id is `fix-…`, and there are no e-mail addresses, phone
// numbers or street addresses anywhere in the module — see
// scripts/ui-fixtures.test.mjs, which greps the generated output for exactly
// that and fails if a personal-looking value ever appears.

/** mulberry32 — 4 lines, no dependency, and stable across Node versions. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260919;
const DAY_MS = 86_400_000;

const p2 = (n) => String(n).padStart(2, "0");
/** Local calendar date, `days` before/after the anchor — the form every
    snapshot uses for its `day`/`date` fields. */
function isoDate(anchor, days) {
  const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + days);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
/** A local wall-clock instant on that date, as an ISO string with an offset
    of Z — good enough for fixtures, and free of any real timezone. */
const isoAt = (anchor, days, hh = 6, mm = 30) =>
  new Date(Date.parse(`${isoDate(anchor, days)}T${p2(hh)}:${p2(mm)}:00Z`)).toISOString();

/* Invented trail and place names. None of these exist. */
const RUN_ROUTES = [
  "Tin Cup Ridge", "Lantern Draw", "Slabtown Loop", "Cold Fork", "Quartz Bench",
  "Hollow Mesa", "Nine Mile Flat", "Stonecrop Saddle", "Pinyon Gate", "Bitterroot Bowl",
];
const CROSS_ROUTES = ["valley spin", "commute loop", "rim hike", "gym strength"];

/* ------------------------------------------------------------------ */
/*  strava.json — the run log and the weekly buckets                    */
/* ------------------------------------------------------------------ */

/**
 * ~18 weeks of running, five sessions a week, on a mild build/recover cycle.
 * Long enough that generic mode's trailing 12-week window and the block-week
 * counter both have something to bucket.
 */
function stravaActivities(anchor, days) {
  const r = rng(SEED);
  const out = [];
  // Sun/Tue/Wed/Thu/Sat, so the week always has a long run and a rest day.
  const PATTERN = [0, 2, 3, 4, 6];
  for (let back = days; back >= 0; back--) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - back);
    if (!PATTERN.includes(d.getDay())) continue;
    const weeksOut = Math.floor(back / 7);
    // a 4-week cycle: three building weeks then a down week
    const cycle = weeksOut % 4 === 0 ? 0.68 : 1 + (weeksOut % 4) * 0.06;
    const long = d.getDay() === 6;
    const vert = d.getDay() === 3;
    const workout = d.getDay() === 2;
    const baseMi = long ? 17 : vert ? 9 : workout ? 7.5 : 5.5;
    const mi = +(baseMi * cycle * (0.9 + r() * 0.2)).toFixed(2);
    const ft = Math.round((long ? 2600 : vert ? 2100 : 500) * cycle * (0.85 + r() * 0.3));
    const paceS = long ? 660 : workout ? 498 : 606;
    const movingS = Math.round(mi * paceS * (0.95 + r() * 0.12));
    out.push({
      id: `fix-run-${isoDate(anchor, -back)}`,
      date: isoDate(anchor, -back),
      start_utc: isoAt(anchor, -back, 13),
      start_time_local: `${isoDate(anchor, -back)}T06:30:00`,
      utc_offset_s: -25200,
      timezone: "America/Denver",
      // Deliberately near Null Island (0,0 — open ocean off West Africa, no
      // trail within a thousand miles of it): a fixed real-world-looking
      // coordinate here used to be the actual athlete's home city, unguarded
      // by any check (r1-crew-tests.md HIGH/MEDIUM). This value is inert on
      // purpose, and scripts/ui-fixtures.test.mjs's coordinate check keeps it
      // that way — see NULL_ISLAND_LATLNG there for the shared reference.
      start_latlng: [0.35, -0.62],
      title: `${RUN_ROUTES[out.length % RUN_ROUTES.length]}${long ? " long" : vert ? " vert" : ""}`,
      sport: "Run",
      type: long ? "long" : vert ? "vert" : workout ? "workout" : "easy",
      distance_m: Math.round(mi * 1609.344),
      elevation_m: Math.round(ft * 0.3048),
      moving_s: movingS,
      elapsed_s: movingS + 240,
      avg_hr: Math.round(138 + r() * 16),
      max_hr: Math.round(166 + r() * 12),
      avg_pace_s_per_km: Math.round(paceS / 1.609344),
      rpe: long ? 4 : workout ? 4 : 2,
      strava_url: "https://example.invalid/activities/0",
      weather: {
        temp_min_c: 9 + Math.round(r() * 4),
        temp_max_c: 24 + Math.round(r() * 6),
        temp_avg_c: 17 + Math.round(r() * 4),
        apparent_avg_c: 18 + Math.round(r() * 4),
        humidity_avg: 0.24 + r() * 0.2,
      },
    });
  }
  return out;
}

/**
 * The run that IS the 100-miler, on race day.
 *
 * races/_fixtures/mm-like-100 is always dated today (launch.mjs), and the
 * archive dialog's picker is a window of ±3 days around the race date with the
 * longest race-day run first — so without this entry there is simply nothing
 * to link a result to, and the flow cannot be tested at all. It is also the
 * longest activity in the log by a wide margin, which is what makes it the
 * dialog's default selection.
 *
 * `id` deliberately keeps the `fix-` prefix every other fixture activity
 * carries: scripts/ui-fixtures.test.mjs greps the generated snapshots for
 * anything that looks like real data, and a bare numeric Strava id is exactly
 * the shape a copied-from-life fixture has.
 */
function raceDayRun(anchor) {
  const movingS = 30 * 3600 + 41 * 60;
  return {
    id: "fix-run-race-day",
    date: isoDate(anchor, 0),
    start_utc: isoAt(anchor, 0, 11),
    start_time_local: `${isoDate(anchor, 0)}T05:00:00`,
    utc_offset_s: -21600,
    timezone: "America/Denver",
    title: "Mesa Monster 100 — the whole thing",
    sport: "Run",
    type: "long",
    distance_m: Math.round(100.4 * 1609.344),
    elevation_m: Math.round(21400 * 0.3048),
    moving_s: movingS,
    elapsed_s: movingS + 4 * 3600,
    avg_hr: 132,
    max_hr: 171,
    avg_pace_s_per_km: Math.round(movingS / (100.4 * 1.609344)),
    rpe: 5,
    strava_url: "https://example.invalid/activities/0",
    weather: { temp_min_c: 4, temp_max_c: 29, temp_avg_c: 16, apparent_avg_c: 17, humidity_avg: 0.21 },
  };
}

function strava(anchor, days) {
  const activities = [...stravaActivities(anchor, days), raceDayRun(anchor)];
  return {
    fetched_at: new Date(anchor.getTime() - 40 * 60_000).toISOString(),
    window: { start: isoDate(anchor, -days), end: isoDate(anchor, 0) },
    totals: {
      distance_km: +(activities.reduce((s, a) => s + a.distance_m, 0) / 1000).toFixed(1),
      elevation_m: activities.reduce((s, a) => s + a.elevation_m, 0),
      moving_s: activities.reduce((s, a) => s + a.moving_s, 0),
      count: activities.length,
    },
    activities,
  };
}

/* ------------------------------------------------------------------ */
/*  cross-train.json — the log's "other" tab                            */
/* ------------------------------------------------------------------ */

function crossTrain(anchor, days) {
  const r = rng(SEED + 1);
  const activities = [];
  for (let back = days; back >= 0; back -= 9) {
    const i = activities.length;
    activities.push({
      id: `fix-cross-${isoDate(anchor, -back)}`,
      date: isoDate(anchor, -back),
      start_utc: isoAt(anchor, -back, 23),
      start_time_local: `${isoDate(anchor, -back)}T16:00:00`,
      title: CROSS_ROUTES[i % CROSS_ROUTES.length],
      sport: i % 2 ? "Ride" : "Hike",
      distance_m: Math.round((i % 2 ? 26000 : 7000) * (0.9 + r() * 0.2)),
      elevation_m: Math.round((i % 2 ? 320 : 410) * (0.9 + r() * 0.2)),
      moving_s: Math.round(3600 * (1 + r())),
      elapsed_s: Math.round(4200 * (1 + r())),
      avg_hr: Math.round(118 + r() * 14),
      max_hr: Math.round(150 + r() * 10),
      strava_url: "https://example.invalid/activities/0",
    });
  }
  return {
    fetched_at: new Date(anchor.getTime() - 40 * 60_000).toISOString(),
    window: { start: isoDate(anchor, -days), end: isoDate(anchor, 0) },
    totals: {
      distance_km: +(activities.reduce((s, a) => s + a.distance_m, 0) / 1000).toFixed(1),
      elevation_m: activities.reduce((s, a) => s + a.elevation_m, 0),
      moving_s: activities.reduce((s, a) => s + a.moving_s, 0),
      count: activities.length,
    },
    activities,
  };
}

/* ------------------------------------------------------------------ */
/*  oura.json — the recovery half of the vitals panel                   */
/* ------------------------------------------------------------------ */

function oura(anchor, days) {
  const r = rng(SEED + 2);
  const out = [];
  for (let back = days; back >= 1; back--) {
    const sleepS = Math.round((6.4 + r() * 1.6) * 3600);
    const hrv = Math.round(52 + r() * 22);
    out.push({
      day: isoDate(anchor, -back),
      sleep_score: Math.round(70 + r() * 22),
      sleep_contributors: { deep_sleep: 80, efficiency: 92, latency: 76, rem_sleep: 74, restfulness: 68, timing: 84, total_sleep: 79 },
      nap_s: null,
      total_sleep_s: sleepS,
      time_in_bed_s: sleepS + Math.round(1500 + r() * 900),
      rem_sleep_s: Math.round(sleepS * (0.17 + r() * 0.06)),
      deep_sleep_s: Math.round(sleepS * (0.13 + r() * 0.05)),
      light_sleep_s: Math.round(sleepS * 0.6),
      awake_s: Math.round(900 + r() * 700),
      avg_hrv: hrv,
      avg_hr: Math.round(50 + r() * 7),
      lowest_hr: Math.round(44 + r() * 6),
      latency_s: Math.round(500 + r() * 600),
      efficiency: Math.round(88 + r() * 8),
      restless_periods: Math.round(8 + r() * 14),
      readiness_score: Math.round(68 + r() * 24),
      temp_deviation_c: +(-0.3 + r() * 0.7).toFixed(2),
      temp_trend_dev_c: +(-0.2 + r() * 0.4).toFixed(2),
      readiness_contributors: { activity_balance: 82, body_temperature: 90, hrv_balance: 74, previous_day_activity: 78, previous_night: 80, recovery_index: 88, resting_heart_rate: 86, sleep_balance: 79 },
    });
  }
  const last7 = out.slice(-7);
  const avg = (f) => Math.round(last7.reduce((s, d) => s + f(d), 0) / last7.length);
  return {
    fetched_at: new Date(anchor.getTime() - 38 * 60_000).toISOString(),
    window: { start: isoDate(anchor, -days), end: isoDate(anchor, -1) },
    summary: {
      days_count: out.length,
      avg7_sleep_score: avg((d) => d.sleep_score),
      avg7_readiness: avg((d) => d.readiness_score),
      avg7_hrv: avg((d) => d.avg_hrv),
      avg7_lowest_hr: avg((d) => d.lowest_hr),
      avg7_total_sleep_s: avg((d) => d.total_sleep_s),
    },
    days: out,
  };
}

/* ------------------------------------------------------------------ */
/*  google-cal.json — "the road ahead"                                  */
/* ------------------------------------------------------------------ */

const CAL_EVENTS = [
  { at: -9, summary: "team standup", classification: "work", dur: 30 },
  { at: -4, summary: "physio check-in", classification: "appointment", dur: 45 },
  { at: -1, summary: "club group run", classification: "training", dur: 90 },
  { at: 1, summary: "team standup", classification: "work", dur: 30 },
  { at: 2, summary: "kid duty", classification: "childcare", allDay: true },
  { at: 3, summary: "club group run", classification: "training", dur: 90 },
  { at: 5, summary: "dentist", classification: "appointment", dur: 60 },
  { at: 6, summary: "kid duty", classification: "childcare", allDay: true },
  { at: 8, summary: "out of town", classification: "travel", allDay: true },
  { at: 9, summary: "out of town", classification: "travel", allDay: true },
  { at: 11, summary: "team offsite", classification: "work", dur: 480 },
  { at: 13, summary: "kid duty", classification: "childcare", allDay: true },
  { at: 16, summary: "club group run", classification: "training", dur: 90 },
  { at: 20, summary: "kid duty", classification: "childcare", allDay: true },
  { at: 24, summary: "Tin Cup Ridge 50K", classification: "race", allDay: true },
  { at: 27, summary: "team standup", classification: "work", dur: 30 },
];

function googleCal(anchor) {
  const events = CAL_EVENTS.map((e, i) => ({
    id: `fix-cal-${i}`,
    summary: e.summary,
    description: "",
    start: e.allDay ? isoDate(anchor, e.at) : isoAt(anchor, e.at, 15),
    end: e.allDay ? isoDate(anchor, e.at + 1) : isoAt(anchor, e.at, 15 + Math.ceil((e.dur ?? 60) / 60)),
    all_day: Boolean(e.allDay),
    duration_min: e.allDay ? null : (e.dur ?? 60),
    location: null,
    attendees_count: 0,
    classification: e.classification,
    calendar: "primary",
    html_link: null,
  }));
  const upcoming = events.filter((_, i) => CAL_EVENTS[i].at >= 0);
  const daysOf = (kind) => CAL_EVENTS.filter((e) => e.at >= 0 && e.classification === kind).map((e) => isoDate(anchor, e.at));
  const byDay = {};
  for (const [i, e] of events.entries()) {
    if (CAL_EVENTS[i].at < 0) continue;
    const key = isoDate(anchor, CAL_EVENTS[i].at);
    (byDay[key] ??= []).push(e);
  }
  return {
    fetched_at: new Date(anchor.getTime() - 36 * 60_000).toISOString(),
    window: { time_min: isoAt(anchor, -30, 0), time_max: isoAt(anchor, 45, 0), past_days: 30, future_days: 45 },
    calendar_id: "primary",
    calendar_ids: ["primary"],
    summary: {
      total_events: events.length,
      past_events: events.length - upcoming.length,
      upcoming_events: upcoming.length,
      races_upcoming: daysOf("race").length,
      travel_days_upcoming: daysOf("travel"),
      childcare_days_upcoming: daysOf("childcare"),
      childcare_weekend_days_upcoming: [],
    },
    events,
    upcoming_by_day: byDay,
  };
}

/* ------------------------------------------------------------------ */
/*  coach.json — the agent readout in the rail                          */
/* ------------------------------------------------------------------ */

const PLAN_BLOCKS = [
  { wk: 7, label: "build 1", dist_mi: 46, elev_ft: 7200, focus: "steady vert, no intensity", key_session: "Tin Cup Ridge long", quality: 1 },
  { wk: 8, label: "build 2", dist_mi: 52, elev_ft: 8400, focus: "back-to-back weekend", key_session: "Cold Fork double", quality: 2 },
  { wk: 9, label: "down", dist_mi: 34, elev_ft: 4800, focus: "absorb", key_session: "easy Slabtown Loop", quality: 0 },
  { wk: 10, label: "build 3", dist_mi: 58, elev_ft: 9600, focus: "longest day of the block", key_session: "Hollow Mesa 24 mi", quality: 2 },
  { wk: 11, label: "peak", dist_mi: 62, elev_ft: 10400, focus: "race-effort segments", key_session: "Quartz Bench tempo", quality: 2 },
  { wk: 12, label: "taper", dist_mi: 28, elev_ft: 3600, focus: "sharpen and sleep", key_session: "short Lantern Draw", quality: 1 },
];

function coach(anchor) {
  return {
    generated_at: new Date(anchor.getTime() - 2 * 3600_000).toISOString(),
    model: "fixture · no agent was run",
    elapsed_s: 0,
    num_turns: 0,
    cost_usd: 0,
    facts_snapshot: { block_week: 7, acr_dist: 1.06, acr_elev: 1.11, hrv_d7: 62, rhr_d7: 47, readiness_d7: 79 },
    summary: "Load is where the plan wants it and recovery has held for three weeks. Keep the next two weeks boring: vert without intensity, and protect the down week.",
    watch_outs: [
      "Elevation is climbing faster than distance — the acute:chronic on vert is the one to watch.",
      "Two travel days land mid-build; move the long run rather than shortening it.",
    ],
    recommendations: [
      "Long run on the Saturday before the travel block, not after it.",
      "Hold the easy days genuinely easy — the readiness dips follow the fast ones.",
      "Add one night of earlier lights-out in the down week.",
    ],
    plan_blocks: PLAN_BLOCKS,
    new_notes: ["Down week moved a day later to clear the offsite."],
  };
}

/* ------------------------------------------------------------------ */
/*  state.json — athlete preferences and the coach's standing context   */
/* ------------------------------------------------------------------ */

function state(anchor) {
  return {
    version: 3,
    last_updated: new Date(anchor.getTime() - 2 * 3600_000).toISOString(),
    agent_notes: [
      { at: isoAt(anchor, -14, 14), note: "Moved the down week to clear a travel block." },
      { at: isoAt(anchor, -7, 14), note: "Vert is the limiter, not distance — kept mileage flat and added climbing." },
      { at: isoAt(anchor, 0, 14), note: "Recovery steady for three weeks; no change to the plan." },
    ],
    preferences: {
      training_philosophy: "Time on feet over intensity; vert is the limiter.",
      weekly_rest_day: "Monday",
      nutrition_target_kcal_per_hour: 280,
      heat_threshold_c: 28,
      context: {
        sections: {
          about_me: "The athlete trains on invented trails for a test suite. Nothing here describes a real person.",
          calendar_conventions: "All-day \"kid duty\" means solo childcare; \"out of town\" means travel.",
          training_preferences: "Long run Saturday, rest Monday, vert midweek.",
        },
        temporary: [
          { id: "fix-tmp-1", text: "Right calf tight — reassess after the down week.", added: isoDate(anchor, -6), expires: isoDate(anchor, 21), source: "user" },
        ],
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  climbs.json / pace-grade.json — derived caches the charts read      */
/* ------------------------------------------------------------------ */

function climbs(anchor, days) {
  const r = rng(SEED + 3);
  const out = [];
  for (let back = days; back >= 0; back -= 5) {
    const lengthMi = +(0.8 + r() * 2.4).toFixed(2);
    const gainFt = Math.round(lengthMi * (420 + r() * 380));
    out.push({
      activity_id: `fix-run-${isoDate(anchor, -back)}`,
      date: isoDate(anchor, -back),
      title: RUN_ROUTES[out.length % RUN_ROUTES.length],
      start_mi: +(r() * 6).toFixed(2),
      length_mi: lengthMi,
      gain_ft: gainFt,
      avg_grade_pct: +((gainFt / (lengthMi * 5280)) * 100).toFixed(1),
      max_grade_pct: +((gainFt / (lengthMi * 5280)) * 160).toFixed(1),
      strava_url: "https://example.invalid/activities/0",
    });
  }
  return { fetched_at: new Date(anchor.getTime() - 35 * 60_000).toISOString(), window_days: days, activities_scanned: out.length * 2, activities_pending: 0, climbs: out };
}

function paceGrade(anchor) {
  const curve = [];
  for (let g = -20; g <= 20; g += 2) {
    curve.push({ g, mult: +(1 + Math.abs(g) * (g > 0 ? 0.031 : 0.012)).toFixed(3), n: 40 - Math.abs(g) });
  }
  return { fitted_at: new Date(anchor.getTime() - 35 * 60_000).toISOString(), basis: "fixture", window_m: 400, bin_pct: 2, runs_used: 64, curve, runs_pending_time: 0 };
}

/* ------------------------------------------------------------------ */

/** How much history the snapshots carry. 18 weeks covers generic mode's
    rolling 12-week window with room for the block-week counter to sit inside
    it rather than at its edge. */
export const HISTORY_DAYS = 126;

/**
 * Every web/public snapshot, keyed by the filename the app fetches it as.
 * @param {Date} [now] the anchor — "today" for every relative date inside
 * @returns {Record<string, object>}
 */
export function buildSnapshots(now = new Date()) {
  const anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  return {
    "strava.json": strava(anchor, HISTORY_DAYS),
    "cross-train.json": crossTrain(anchor, HISTORY_DAYS),
    "oura.json": oura(anchor, HISTORY_DAYS),
    "google-cal.json": googleCal(anchor),
    "coach.json": coach(anchor),
    "state.json": state(anchor),
    "climbs.json": climbs(anchor, HISTORY_DAYS),
    "pace-grade.json": paceGrade(anchor),
  };
}

/** The generic-mode plan the coach would have written (config/generic-plan
    .json) — without it "the road ahead" renders its "targets only" state. */
export function buildGenericPlan(now = new Date()) {
  const anchor = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
  return { generated_at: new Date(anchor.getTime() - 2 * 3600_000).toISOString(), plan_blocks: PLAN_BLOCKS };
}

export { DAY_MS, isoDate };
