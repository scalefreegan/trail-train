// Unit tests for the facts digest — specifically the race-optional half:
// the rolling 12-week window of generic mode, and the race block that
// replaces it when a race is active. Run with `npm test` from web/
// (node --test, no dependencies). Every fixture is synthetic and every file
// is written to a temp dir; no personal snapshot is read.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ROLLING_WEEKS, computeFacts, loadFactsFromRoot } from "./facts.mjs";

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

// A Friday, pinned so the window boundaries are arithmetic, not luck:
// Monday of this week is 2026-09-14, so a 12-week window starts 2026-06-29.
const NOW = new Date("2026-09-18T09:00:00").getTime();
const WINDOW_START = "2026-06-29";

/** One Strava-shaped activity `daysAgo` before NOW. */
function activity(daysAgo, { dist_mi = 6, elev_ft = 800, title = "run" } = {}) {
  const d = new Date(NOW - daysAgo * 86400000);
  return {
    date: d.toISOString(),
    title,
    type: "Run",
    distance_m: dist_mi * M_PER_MI,
    elevation_m: elev_ft * M_PER_FT,
    moving_s: dist_mi * 660,
  };
}

const GOALS = {
  event_class: "100 mi mountain race",
  horizon: "next A-race ~Aug 2027",
  phase: "return_to_run",
  weekly_volume_band: { dist_mi: [10, 30], vert_ft: [1000, 3000] },
  notes: "shin niggle",
};

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "facts-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("generic mode: a rolling 12-week window ending on the current week", () => {
  const strava = { activities: [
    activity(1, { dist_mi: 8, elev_ft: 1200 }),    // this week (wk 12)
    activity(3, { dist_mi: 5, elev_ft: 400 }),     // this week (wk 12)
    activity(10, { dist_mi: 12, elev_ft: 2000 }),  // wk 11
    activity(80, { dist_mi: 9, elev_ft: 900 }),    // inside the window
    activity(200, { dist_mi: 20, elev_ft: 5000 }), // older than the window
  ] };

  const f = computeFacts(strava, null, { goals: GOALS }, NOW);

  assert.equal(f.race, null);
  assert.equal(f.days_until, null);
  assert.deepEqual(f.goals, GOALS);
  assert.equal(f.block.mode, "rolling");
  assert.equal(f.block.total_weeks, ROLLING_WEEKS);
  assert.equal(f.block.current_week, ROLLING_WEEKS, "the window ends on the current week");
  assert.equal(f.block.block_start, WINDOW_START);
  assert.equal(f.block.weekly_actual.length, ROLLING_WEEKS);

  const wk12 = f.block.weekly_actual.at(-1);
  assert.equal(wk12.wk, 12);
  assert.equal(wk12.sessions, 2);
  assert.equal(wk12.dist_mi, 13);
  assert.equal(wk12.elev_ft, 1600);
  assert.equal(f.block.weekly_actual[10].dist_mi, 12, "10 days ago lands in wk 11");

  // the run 200 days back is outside the window and must not be counted
  assert.equal(f.block.dist_actual_mi, 34);
});

test("generic mode targets: the goals band midpoint, per week", () => {
  const f = computeFacts({ activities: [] }, null, { goals: GOALS }, NOW);
  for (const t of f.block.weekly_target) {
    assert.equal(t.target_dist, 20, "midpoint of [10, 30]");
    assert.equal(t.target_elev, 2000, "midpoint of [1000, 3000]");
  }
  assert.equal(f.block.dist_expected_mi, 240, "12 weeks × the midpoint");
});

test("generic mode targets: a planned week beats the band midpoint", () => {
  // config/generic-plan.json's plan_blocks index this same rolling window
  const plan_blocks = [
    { wk: 11, label: "Return", dist_mi: 14, elev_ft: 1500 },
    { wk: 12, label: "Return", dist_mi: 18, elev_ft: 2400 },
  ];
  const f = computeFacts({ activities: [] }, null, { goals: GOALS, plan_blocks }, NOW);
  assert.deepEqual(f.block.weekly_target.at(-2), { wk: 11, target_dist: 14, target_elev: 1500 });
  assert.deepEqual(f.block.weekly_target.at(-1), { wk: 12, target_dist: 18, target_elev: 2400 });
  assert.deepEqual(f.block.weekly_target[0], { wk: 1, target_dist: 20, target_elev: 2000 });
  assert.deepEqual(f.plan_blocks, plan_blocks);
});

test("computeFacts returns a complete digest with no race and no goals", () => {
  const f = computeFacts({ activities: [activity(2)] }, null, {}, NOW);
  assert.equal(f.race, null);
  assert.equal(f.days_until, null);
  assert.equal(f.goals, null);
  assert.equal(f.block.mode, "rolling");
  // targets degrade to zero rather than throwing — there is no band to read
  assert.deepEqual(f.block.weekly_target[0], { wk: 1, target_dist: 0, target_elev: 0 });
  assert.equal(f.block.dist_expected_mi, 0);
  assert.equal(f.today, "2026-09-18");
  // the rest of the digest is unaffected by the absence of a race
  assert.equal(f.load.sessions_d7, 1);
  assert.deepEqual(f.plan_blocks, []);
  assert.equal(f.recovery, null);
});

test("race mode: the folder's block.json drives the window", () => {
  const ctx = {
    race: { name: "San Juan Softie 100", short: "SJS100", date: "2026-10-16", distance_mi: 104 },
    block: {
      start_date: "2026-08-31",
      total_weeks: 7,
      targets: Array.from({ length: 7 }, (_, i) => ({ wk: i + 1, target_dist: 30 + i, target_elev: 4000 })),
    },
    goals: GOALS,
  };
  const f = computeFacts({ activities: [activity(1, { dist_mi: 10, elev_ft: 1000 })] }, null, ctx, NOW);

  assert.equal(f.block.mode, "race");
  assert.equal(f.block.total_weeks, 7);
  assert.equal(f.block.block_start, "2026-08-31");
  assert.equal(f.block.current_week, 3, "2026-09-18 is the third week from 2026-08-31");
  assert.equal(f.block.weekly_target.length, 7);
  assert.equal(f.race.name, "San Juan Softie 100");
  assert.equal(f.race.days_until, 28);
  assert.equal(f.days_until, 28);
  assert.equal(f.goals, null, "a race outranks the standing goals");
});

test("days_until is computed in the race's own zone, not the process's", () => {
  // MM100-shaped: America/Phoenix (no DST). now = 2026-09-14T06:30:00Z is
  // 23:30 MST Sep 13 in Phoenix — race day hasn't started there yet, but the
  // pre-fix `new Date(race.date + "T00:00:00")` parsed in the PROCESS's own
  // zone, which under TZ=America/Denver reads race midnight as already 1h
  // past (days_until -0, "race started"). Race-local math must land on 1
  // regardless of what TZ this test happens to run under — this file is run
  // once with TZ=America/Denver and once with TZ=Pacific/Auckland to prove it.
  const ctx = { race: { name: "MM100", date: "2026-09-14", timezone: "America/Phoenix" } };
  const now = new Date("2026-09-14T06:30:00Z").getTime();
  const f = computeFacts({ activities: [] }, null, ctx, now);
  assert.equal(f.days_until, 1, `process TZ was ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  assert.equal(f.race.days_until, 1);
});

test("race mode without a usable block.json falls back to the rolling window", () => {
  const ctx = { race: { name: "Draft Race", date: "2027-06-05" }, block: null };
  const f = computeFacts({ activities: [] }, null, ctx, NOW);
  assert.equal(f.block.mode, "rolling");
  assert.equal(f.block.total_weeks, ROLLING_WEEKS);
  assert.equal(f.race.name, "Draft Race", "the race itself is still there");
  assert.ok(f.days_until > 0);
});

test("loadFactsFromRoot with no race at all: goals bootstrapped, race null", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, "web", "public"), { recursive: true });
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(
    path.join(root, "web", "public", "strava.json"),
    JSON.stringify({ activities: [activity(2, { dist_mi: 7, elev_ft: 700 })] }));
  await fs.writeFile(
    path.join(root, "config", "goals.example.json"),
    JSON.stringify({ ...GOALS, phase: "build" }));

  const f = await loadFactsFromRoot(root);
  assert.equal(f.race, null);
  assert.equal(f.days_until, null);
  assert.equal(f.goals.event_class, GOALS.event_class);
  assert.equal(f.goals.phase, "maintain", "bootstrapped, not inherited from the example");
  assert.equal(f.block.mode, "rolling");
  assert.equal(f.block.total_weeks, ROLLING_WEEKS);
  assert.deepEqual(f.plan_blocks, []);
  assert.ok(f.profile, "the digest still carries the other sections");

  // and the bootstrap landed on disk where the settings dialog reads it
  const onDisk = JSON.parse(await fs.readFile(path.join(root, "config", "goals.json"), "utf8"));
  assert.equal(onDisk.phase, "maintain");
});

test("loadFactsFromRoot ignores an archived race — archived is not active", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, "web", "public"), { recursive: true });
  await fs.writeFile(
    path.join(root, "web", "public", "strava.json"), JSON.stringify({ activities: [] }));
  const dir = path.join(root, "races", "old-race-2026");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify({
    schema_version: 1, slug: "old-race-2026", status: "archived", name: "Old Race",
    short: "OLD", date: "2026-09-12", distance_mi: 102, gain_ft: 15900,
  }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "active-race.json"), JSON.stringify({ slug: null }));

  const f = await loadFactsFromRoot(root);
  assert.equal(f.race, null, "the most recent archived race is not the active race");
  assert.equal(f.block.mode, "rolling");
  assert.ok(f.goals, "generic mode is the real default now");
});

/* -------- the race payload the coach prompt is built from (tt-yib.10) -------- */

/** Write a race folder; returns its dir. */
async function writeRace(root, slug, race) {
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify({ schema_version: 1, slug, ...race }));
  return dir;
}

test("an active race reaches facts with its course structure, not a name list", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, "web", "public"), { recursive: true });
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "web", "public", "strava.json"), JSON.stringify({ activities: [] }));
  await writeRace(root, "softie-100-2027", {
    status: "active", name: "San Juan Softie 100", short: "SJS100",
    date: "2027-08-13", start_time: "06:00", timezone: "America/Denver",
    distance_mi: 104, gain_ft: 19000, cutoff_h: 40, location: "Durango, CO",
    elevation: { min_ft: 7800, max_ft: 12438, avg_ft: 10600, altitude_significant: true },
    features: { crew: true, pacers: false, night: true },
    coach_notes: { terrain: "High and rocky.", key_demands: "Altitude." },
    aid_stations: [
      { name: "Start", total_mi: 0, cutoff_h: null, crew: true, drop_bag: false, pacers: false },
      { name: "Kennebec", total_mi: 52.5, cutoff_h: 21, crew: true, drop_bag: true, pacers: false },
    ],
  });
  await fs.writeFile(path.join(root, "config", "active-race.json"), JSON.stringify({ slug: "softie-100-2027" }));

  const f = await loadFactsFromRoot(root);
  assert.equal(f.race.slug, "softie-100-2027");
  assert.equal(f.race.timezone, "America/Denver");
  assert.equal(f.race.cutoff_h, 40);
  // the sections stay as authored — the prompt quotes each one verbatim
  assert.deepEqual(f.race.coach_notes, { terrain: "High and rocky.", key_demands: "Altitude." });
  assert.deepEqual(f.race.features, { crew: true, pacers: false, night: true });
  assert.equal(f.race.elevation.altitude_significant, true);
  assert.equal(f.race.max_elev_ft, 12438);
  // mile, cutoff hour and access flags per station — enough to reason about margins
  assert.deepEqual(f.race.aid_stations[1], {
    name: "Kennebec", total_mi: 52.5, cutoff_h: 21, crew: true, drop_bag: true, pacers: false,
  });
  assert.deepEqual(f.history, [], "the active race is not its own history");
});

test("history: archived races, their result, and the notes written about them", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, "web", "public"), { recursive: true });
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "web", "public", "strava.json"), JSON.stringify({ activities: [] }));
  await fs.writeFile(path.join(root, "config", "active-race.json"), JSON.stringify({ slug: null }));
  await fs.writeFile(path.join(root, "web", "public", "state.json"), JSON.stringify({
    version: 3,
    agent_notes: [
      { at: "2026-09-13T00:00:00Z", note: "Old Race: quads were the limiter after mile 70." },
      { at: "2026-09-14T00:00:00Z", note: "General note about sleep, no race named." },
      { at: "2026-09-15T00:00:00Z", note: "OLD taper felt about right." },
    ],
  }));
  const dir = await writeRace(root, "old-race-2026", {
    status: "archived", name: "Old Race", short: "OLD",
    date: "2026-09-12", distance_mi: 102.6, gain_ft: 15900,
  });
  await fs.writeFile(path.join(dir, "result.json"), JSON.stringify({
    status: "finished", finish_h: 33.27, official_time: "33:16:12", placement: 41, notes: "",
  }));
  // a second archived race with no result.json — gitignored, so absence is normal
  await writeRace(root, "older-race-2025", {
    status: "archived", name: "Older Race", short: "OLDER", date: "2025-06-07", distance_mi: 50, gain_ft: 7000,
  });

  const f = await loadFactsFromRoot(root);
  assert.equal(f.race, null, "history does not resurrect a race as active");
  assert.deepEqual(f.history.map((h) => h.slug), ["old-race-2026", "older-race-2025"], "newest first");
  assert.deepEqual(f.history[0].result, {
    status: "finished", finish_h: 33.27, official_time: "33:16:12", placement: 41, notes: "",
  });
  assert.equal(f.history[1].result, null, "a missing result.json is not a missing race");
  assert.equal(f.history[0].distance_mi, 102.6);
  // notes are matched on the race name OR its short code, and capped at 3
  assert.deepEqual(f.history[0].agent_notes.map((n) => n.note), [
    "Old Race: quads were the limiter after mile 70.",
    "OLD taper felt about right.",
  ]);
  assert.deepEqual(f.history[1].agent_notes, []);
});
