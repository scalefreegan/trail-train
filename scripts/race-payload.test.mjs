// The web client's view of "what am I training for" — GET /api/race/active's
// body. The point of these tests is the CONTRACT between this payload and the
// coach's digest: the client buckets weekly mileage by the window this payload
// names, so if it ever disagreed with scripts/facts.mjs the dashboard would
// silently plot against targets the coach never set.
//
// Run with `npm test` from web/ (node --test, no dependencies). Every fixture
// is synthetic and written to a temp dir; no personal snapshot is read.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { activeRacePayload } from "./race-payload.mjs";
import { rollingBlock, ROLLING_WEEKS } from "./block.mjs";
import { computeFacts, loadFactsFromRoot } from "./facts.mjs";
import { loadGoals } from "./goals.mjs";

// The same pinned Friday facts.test.mjs uses: Monday of this week is
// 2026-09-14, so a 12-week window starts 2026-06-29.
const NOW = new Date("2026-09-18T09:00:00").getTime();
const WINDOW_START = "2026-06-29";

const GOALS = {
  event_class: "100 mi mountain race",
  horizon: "next A-race ~Aug 2027",
  phase: "return_to_run",
  weekly_volume_band: { dist_mi: [10, 30], vert_ft: [1000, 3000] },
  notes: "shin niggle",
};

/** A minimal race.json that validates (mirrors race-config.test.mjs). */
function validRace(over = {}) {
  return {
    schema_version: 1,
    slug: "san-juan-softie-100-2027",
    status: "active",
    name: "San Juan Softie 100",
    short: "SJS100",
    date: "2027-08-13",
    start_time: "06:00",
    timezone: "America/Denver",
    location: "Durango, CO",
    distance_mi: 104,
    gain_ft: 19000,
    elevation: { min_ft: 8770, max_ft: 12438 },
    cutoff_h: 38,
    aid_stations: [{ name: "Finish", total_mi: 104, cutoff_h: 38 }],
    ...over,
  };
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "race-payload-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.mkdir(path.join(root, "web", "public"), { recursive: true });
  return root;
}

const writeJson = (p, v) => fs.writeFile(p, JSON.stringify(v));

test("generic mode: the payload describes the rolling window in full", async (t) => {
  const root = await tempRoot(t);
  await writeJson(path.join(root, "config", "goals.json"), GOALS);

  const payload = await activeRacePayload(root, NOW);

  assert.equal(payload.active, null);
  assert.equal(payload.race, null);
  assert.deepEqual(payload.goals, GOALS);
  assert.equal(payload.block.mode, "rolling");
  assert.equal(payload.block.start_date, WINDOW_START);
  assert.equal(payload.block.total_weeks, ROLLING_WEEKS);
  assert.equal(payload.block.targets.length, ROLLING_WEEKS);
  assert.deepEqual(payload.block.targets[0], { wk: 1, target_dist: 20, target_elev: 2000 });
  assert.deepEqual(payload.plan, { plan_blocks: [] });
  assert.equal(payload.nutrition, null);
});

test("generic mode: the payload's window is the one facts.mjs computes", async (t) => {
  const root = await tempRoot(t);
  await writeJson(path.join(root, "config", "goals.json"), GOALS);
  await writeJson(path.join(root, "config", "generic-plan.json"), {
    plan_blocks: [{ wk: 12, label: "Return", dist_mi: 18, elev_ft: 2400, focus: "easy" }],
  });

  const payload = await activeRacePayload(root, NOW);
  // The coach's side of the same question, from the same files, same `now`.
  const { goals } = await loadGoals(root);
  const facts = computeFacts({ activities: [] }, null,
    { goals, plan_blocks: payload.plan.plan_blocks }, NOW);

  assert.equal(payload.block.start_date, facts.block.block_start);
  assert.equal(payload.block.total_weeks, facts.block.total_weeks);
  assert.equal(payload.block.mode, facts.block.mode);
  assert.deepEqual(payload.block.targets, facts.block.weekly_target);
  // and the planned week beat the band midpoint on both sides
  assert.deepEqual(payload.block.targets.at(-1), { wk: 12, target_dist: 18, target_elev: 2400 });
});

test("generic mode: payload and digest agree when loaded from the same root", async (t) => {
  const root = await tempRoot(t);
  await writeJson(path.join(root, "config", "goals.json"), GOALS);
  await writeJson(path.join(root, "web", "public", "strava.json"), { activities: [] });

  // Both at the wall clock — the window start can only differ if the two
  // calls straddle a Monday midnight, which milliseconds apart they do not.
  const [payload, facts] = await Promise.all([activeRacePayload(root), loadFactsFromRoot(root)]);
  assert.equal(payload.block.start_date, facts.block.block_start);
  assert.equal(payload.block.total_weeks, facts.block.total_weeks);
  assert.deepEqual(payload.block.targets, facts.block.weekly_target);
  assert.deepEqual(payload.plan.plan_blocks, facts.plan_blocks);
});

test("race mode: block.json, tagged, plus the folder's plan and nutrition", async (t) => {
  const root = await tempRoot(t);
  const slug = "san-juan-softie-100-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  const block = {
    start_date: "2027-06-28",
    total_weeks: 7,
    targets: Array.from({ length: 7 }, (_, i) => ({ wk: i + 1, target_dist: 30 + i, target_elev: 4000 })),
  };
  const plan = { plan_blocks: [{ wk: 1, label: "Base", dist_mi: 30, elev_ft: 4000, focus: "aerobic" }] };
  await writeJson(path.join(dir, "race.json"), validRace());
  await writeJson(path.join(dir, "block.json"), block);
  await writeJson(path.join(dir, "plan.json"), plan);
  await writeJson(path.join(dir, "nutrition.json"), { kcal_per_hour: 260 });
  await writeJson(path.join(root, "config", "active-race.json"), { slug });
  // a goals file that must NOT come along — the race is the goal
  await writeJson(path.join(root, "config", "goals.json"), GOALS);

  const payload = await activeRacePayload(root, NOW);

  assert.equal(payload.active, slug);
  assert.equal(payload.race.short, "SJS100");
  assert.equal(payload.goals, null);
  assert.equal(payload.block.mode, "race");
  assert.equal(payload.block.start_date, block.start_date);
  assert.deepEqual(payload.block.targets, block.targets);
  assert.deepEqual(payload.plan, plan);
  assert.deepEqual(payload.nutrition, { kcal_per_hour: 260 });
});

test("an active race whose date has passed carries past:true and a negative days_until", async (t) => {
  // PR #23 review round 1, resilience finding 12: race-day kept projecting a
  // finish time against an active race whose date had already gone by,
  // instead of saying the race was over.
  const root = await tempRoot(t);
  const slug = "san-juan-softie-100-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  // NOW is 2026-09-18; a race dated 9 days earlier in its own zone.
  await writeJson(path.join(dir, "race.json"), validRace({ date: "2026-09-09" }));
  await writeJson(path.join(root, "config", "active-race.json"), { slug });

  const payload = await activeRacePayload(root, NOW);
  assert.equal(payload.active, slug);
  assert.equal(payload.past, true);
  assert.equal(payload.days_until, -9);
});

test("an active race whose date is still ahead carries past:false and a positive days_until", async (t) => {
  const root = await tempRoot(t);
  const slug = "san-juan-softie-100-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "race.json"), validRace({ date: "2027-08-13" }));
  await writeJson(path.join(root, "config", "active-race.json"), { slug });

  const payload = await activeRacePayload(root, NOW);
  assert.equal(payload.past, false);
  assert.equal(payload.days_until, 329);
});

test("an active race ON its own race day is not yet past", async (t) => {
  const root = await tempRoot(t);
  const slug = "san-juan-softie-100-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  // NOW is 2026-09-18T09:00 America/Denver — same race day, not past (even
  // though the 06:00 gun has already gone off: `past` means race DAY has
  // gone by, not merely that the start instant has).
  await writeJson(path.join(dir, "race.json"), validRace({ date: "2026-09-18" }));
  await writeJson(path.join(root, "config", "active-race.json"), { slug });

  const payload = await activeRacePayload(root, NOW);
  assert.ok(Math.abs(payload.days_until) < 1, payload.days_until);
  assert.equal(payload.past, false);
});

test("an archived race is generic mode, with the rolling window", async (t) => {
  const root = await tempRoot(t);
  const slug = "san-juan-softie-100-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "race.json"), validRace({ status: "archived" }));
  await writeJson(path.join(root, "config", "active-race.json"), { slug });
  await writeJson(path.join(root, "config", "goals.json"), GOALS);

  const payload = await activeRacePayload(root, NOW);
  assert.equal(payload.active, null, "archived is not active — the client shows generic mode");
  assert.equal(payload.race, null);
  assert.equal(payload.block.mode, "rolling");
  assert.deepEqual(payload.block, rollingBlock(GOALS, [], NOW));
});

test("a dangling pointer degrades to generic mode with a warning, not a 500", async (t) => {
  const root = await tempRoot(t);
  await writeJson(path.join(root, "config", "active-race.json"), { slug: "not-a-race-2027" });
  await writeJson(path.join(root, "config", "goals.json"), GOALS);

  const payload = await activeRacePayload(root, NOW);
  assert.equal(payload.active, null);
  assert.equal(payload.block.mode, "rolling");
  assert.match(payload.warning, /race\.json not found|unreadable/);
});

test("a draft race with no block.json: no block, and the client gets no window", async (t) => {
  const root = await tempRoot(t);
  const slug = "san-juan-softie-100-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "race.json"), validRace());   // active, but unplanned
  await writeJson(path.join(root, "config", "active-race.json"), { slug });

  const payload = await activeRacePayload(root, NOW);
  assert.equal(payload.active, slug);
  assert.equal(payload.block, null, "no block.json — the client must not invent one");
});

/* --------------------------- view mode (PRD §7) -------------------------- */

test("view mode: the browsed folder on screen, the rolling window underneath", async (t) => {
  const root = await tempRoot(t);
  const slug = "mogollon-monster-100-2026";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  const block = { start_date: "2026-05-11", total_weeks: 18, targets: [{ wk: 1, target_dist: 40, target_elev: 6000 }] };
  const racePlan = { plan_blocks: [{ wk: 1, label: "Base", dist_mi: 40, elev_ft: 6000, focus: "aerobic" }] };
  await writeJson(path.join(dir, "race.json"), validRace({ slug, status: "archived" }));
  await writeJson(path.join(dir, "block.json"), block);
  await writeJson(path.join(dir, "plan.json"), racePlan);
  await writeJson(path.join(dir, "nutrition.json"), { kcal_per_hour: 240 });
  await writeJson(path.join(root, "config", "active-race.json"), { slug, mode: "view" });
  await writeJson(path.join(root, "config", "goals.json"), GOALS);
  // the athlete's actual plan, which the coach is writing in generic mode
  const generic = { plan_blocks: [{ wk: 12, label: "Return", dist_mi: 18, elev_ft: 2400, focus: "easy" }] };
  await writeJson(path.join(root, "config", "generic-plan.json"), generic);

  const payload = await activeRacePayload(root, NOW);

  // on screen: the archived folder, whole
  assert.equal(payload.mode, "view");
  assert.equal(payload.viewing, slug);
  assert.equal(payload.race.status, "archived");
  assert.equal(payload.block.mode, "race");
  assert.deepEqual(payload.block.targets, block.targets);
  assert.deepEqual(payload.plan, racePlan, "the VIEWED race's plan, not the athlete's");
  assert.deepEqual(payload.nutrition, { kcal_per_hour: 240 });

  // underneath: nothing is being trained for, and the coach's own window and
  // plan ride along so the rail can say what it is actually coaching toward
  assert.equal(payload.active, null, "browsing is not training");
  assert.deepEqual(payload.training.goals, GOALS);
  assert.deepEqual(payload.training.block, rollingBlock(GOALS, generic.plan_blocks, NOW));
  assert.deepEqual(payload.training.plan, generic);
});

test("view mode on a draft: no block.json, still browsable", async (t) => {
  const root = await tempRoot(t);
  const slug = "san-juan-softie-100-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "race.json"), validRace({ status: "draft" }));
  await writeJson(path.join(root, "config", "active-race.json"), { slug, mode: "view" });

  const payload = await activeRacePayload(root, NOW);
  assert.equal(payload.viewing, slug);
  assert.equal(payload.race.status, "draft");
  assert.equal(payload.block, null, "no block.json — the client must not invent one");
  assert.deepEqual(payload.plan, { plan_blocks: [] });
  assert.equal(payload.training.block.mode, "rolling");
});

test("train mode names the same folder it views, and carries no training aside", async (t) => {
  const root = await tempRoot(t);
  const slug = "san-juan-softie-100-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, "race.json"), validRace());
  await writeJson(path.join(root, "config", "active-race.json"), { slug, mode: "train" });

  const payload = await activeRacePayload(root, NOW);
  assert.equal(payload.mode, "train");
  assert.equal(payload.active, slug);
  assert.equal(payload.viewing, slug);
  assert.equal(payload.training, null);
});
