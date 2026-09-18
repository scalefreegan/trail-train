// Unit tests for the persistent-state file and its migrations. Run with
// `npm test` from web/ (node --test, no dependencies). Every fixture is
// synthetic and written to a temp dir — nothing here touches the athlete's
// real web/public/state.json.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_STATE,
  STATE_BACKUP_NAME,
  STATE_VERSION,
  loadPlanBlocks,
  loadState,
  mergeAgentUpdate,
} from "./state.mjs";
import { validateRaceJson } from "./race-config.mjs";

/** A throwaway project root, removed when the test ends. */
async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trail-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "web", "public"), { recursive: true });
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  return root;
}

const statePath = (root) => path.join(root, "web", "public", "state.json");
const backupPath = (root) => path.join(root, "web", "public", STATE_BACKUP_NAME);
const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));

/** A v2 state.json as the athlete's file looked before the split. */
function v2State(over = {}) {
  return {
    version: 2,
    last_updated: "2026-09-18T12:00:00.000Z",
    race: {
      name: "Mogollon Monster 100",
      short: "MM100",
      date: "2026-09-12",
      start_time: "06:00",
      distance_mi: 102.3,
      elevation_ft: 15900,
      max_elev_ft: 7912,
      cutoff_h: 38,
      location: "Mogollon Rim · Pine, AZ",
      notes: "Climbs the rim 6×.",
      aid_stations: [{ mi: 11.1, name: "See Canyon" }, { mi: 21.5, name: "Horton" }],
    },
    block: {
      start_date: "2026-04-27",
      total_weeks: 20,
      targets: [{ wk: 1, target_dist: 38, target_elev: 5800 }],
      original_targets: [{ wk: 1, target_dist: 38, target_elev: 5800 }],
    },
    plan_blocks: [{ wk: 20, label: "Race week", dist_mi: 110, elev_ft: 16150, focus: "race" }],
    agent_notes: [{ at: "2026-09-01T00:00:00.000Z", note: "heat block landed" }],
    preferences: {
      training_philosophy: "polarized",
      weekly_rest_day: "Mon",
      context: { sections: { about_me: "runs early", calendar_conventions: "", training_preferences: "" }, temporary: [] },
    },
    ...over,
  };
}

test("DEFAULT_STATE carries no race data", () => {
  assert.equal(STATE_VERSION, 3);
  assert.deepEqual(Object.keys(DEFAULT_STATE).sort(), ["agent_notes", "last_updated", "preferences", "version"]);
});

test("v2 → v3 moves race/block/plan into the race folder and keeps the athlete's data", async (t) => {
  const root = await tempRoot(t);
  const before = v2State();
  await fs.writeFile(statePath(root), JSON.stringify(before, null, 2));

  const after = await loadState(root);
  assert.equal(after.version, 3);
  assert.deepEqual(Object.keys(after).sort(), ["agent_notes", "last_updated", "preferences", "version"]);
  // the two things that must never be lost
  assert.deepEqual(after.agent_notes, before.agent_notes);
  assert.deepEqual(after.preferences, before.preferences);
  // and the file on disk matches what was returned
  assert.deepEqual(await readJson(statePath(root)), after);

  const dir = path.join(root, "races", "mogollon-monster-100-2026");
  const race = await readJson(path.join(dir, "race.json"));
  assert.equal(validateRaceJson(race).ok, true, JSON.stringify(validateRaceJson(race).errors));
  assert.equal(race.status, "archived");
  assert.equal(race.aid_stations.length, 2);
  assert.equal(race.aid_stations[0].total_mi, 11.1);
  assert.deepEqual(await readJson(path.join(dir, "block.json")), before.block);
  assert.deepEqual(await readJson(path.join(dir, "plan.json")), { plan_blocks: before.plan_blocks });
});

test("v2 → v3 is idempotent and writes the backup exactly once", async (t) => {
  const root = await tempRoot(t);
  await fs.writeFile(statePath(root), JSON.stringify(v2State(), null, 2));

  const first = await loadState(root);
  const backup = await readJson(backupPath(root));
  assert.equal(backup.version, 2);
  assert.equal(backup.race.name, "Mogollon Monster 100");
  assert.deepEqual(backup.plan_blocks, v2State().plan_blocks);

  // Re-running must not touch the backup, the folder or the state file.
  const stampBefore = (await fs.stat(backupPath(root))).mtimeMs;
  const racePath = path.join(root, "races", "mogollon-monster-100-2026", "race.json");
  await fs.writeFile(racePath, JSON.stringify({ ...(await readJson(racePath)), short: "EDITED" }, null, 2));
  const second = await loadState(root);
  assert.deepEqual(second, first);
  assert.equal((await fs.stat(backupPath(root))).mtimeMs, stampBefore);
  assert.equal((await readJson(racePath)).short, "EDITED", "an existing race.json must never be overwritten");
  assert.deepEqual(await readJson(backupPath(root)), backup);
});

test("v2 → v3 refuses to run when the backup cannot be written", async (t) => {
  const root = await tempRoot(t);
  const before = v2State();
  await fs.writeFile(statePath(root), JSON.stringify(before, null, 2));
  // A directory where the backup file must go: the write cannot produce a
  // backup, the observable stand-in for a full disk or a read-only mount.
  await fs.mkdir(backupPath(root));

  await assert.rejects(() => loadState(root), /refusing to split state\.json to v3/);
  // nothing moved, nothing lost
  assert.deepEqual(await readJson(statePath(root)), before);
  await assert.rejects(() => fs.access(path.join(root, "races")), { code: "ENOENT" });
});

test("a v1 file passes through both migrations", async (t) => {
  const root = await tempRoot(t);
  const v1 = v2State({ version: 1 });
  v1.preferences = { training_philosophy: "polarized", personal_constraints: ["No running Mondays"] };
  await fs.writeFile(statePath(root), JSON.stringify(v1, null, 2));

  const after = await loadState(root);
  assert.equal(after.version, 3);
  assert.ok(after.preferences.context.sections.training_preferences.includes("No running Mondays"));
  assert.equal("race" in after, false);
  await fs.access(path.join(root, "races", "mogollon-monster-100-2026", "race.json"));
});

test("a v3 file loads untouched and writes no backup", async (t) => {
  const root = await tempRoot(t);
  const v3 = { version: 3, last_updated: null, agent_notes: [], preferences: DEFAULT_STATE.preferences };
  await fs.writeFile(statePath(root), JSON.stringify(v3, null, 2));

  assert.deepEqual(await loadState(root), v3);
  await assert.rejects(() => fs.access(backupPath(root)), { code: "ENOENT" });
});

test("mergeAgentUpdate writes plan_blocks to the active race, notes to state", async (t) => {
  const root = await tempRoot(t);
  const dir = path.join(root, "races", "softie-100-2027");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(root, "config", "active-race.json"), JSON.stringify({ slug: "softie-100-2027" }));

  const state = { version: 3, last_updated: null, agent_notes: [], preferences: DEFAULT_STATE.preferences };
  const blocks = [{ wk: 1, label: "Wk 1", dist_mi: 38, elev_ft: 5800, focus: "base" }];
  const { state: next, plan } = await mergeAgentUpdate(root, state, { plan_blocks: blocks, new_notes: ["noted"] });

  assert.equal(plan.path, path.join(dir, "plan.json"));
  assert.equal(plan.previous_count, 0);
  assert.equal(plan.count, 1);
  assert.equal(plan.written, true);
  assert.deepEqual(await readJson(path.join(dir, "plan.json")), { plan_blocks: blocks });
  assert.equal("plan_blocks" in next, false, "plan_blocks must not come back into state.json");
  assert.equal(next.agent_notes[0].note, "noted");
  assert.deepEqual((await loadPlanBlocks(root)).plan_blocks, blocks);
});

test("mergeAgentUpdate falls back to config/generic-plan.json with no active race", async (t) => {
  const root = await tempRoot(t);
  const state = { version: 3, last_updated: null, agent_notes: [], preferences: DEFAULT_STATE.preferences };
  const blocks = [{ wk: 1, label: "Wk 1", dist_mi: 20, elev_ft: 2000, focus: "return to run" }];
  const { plan } = await mergeAgentUpdate(root, state, { plan_blocks: blocks });

  assert.equal(plan.path, path.join(root, "config", "generic-plan.json"));
  assert.deepEqual(await readJson(plan.path), { plan_blocks: blocks });

  // An empty proposal leaves the existing plan alone.
  const { plan: again } = await mergeAgentUpdate(root, state, { plan_blocks: [] });
  assert.equal(again.written, false);
  assert.equal(again.count, 1);
  assert.deepEqual(await readJson(plan.path), { plan_blocks: blocks });
});
