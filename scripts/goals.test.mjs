// Unit tests for the generic-mode goals file. Run with `npm test` from web/
// (node --test, no dependencies). Fixtures live in a temp dir — except the
// last test, which reads the committed config/goals.example.json so a
// hand-edit that breaks the schema fails CI.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GOAL_PHASES,
  bandMidpoint,
  goalsPath,
  loadGoals,
  saveGoals,
  validateGoals,
} from "./goals.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** A goals.json that validates — tests mutate a copy of it. */
function validGoals(over = {}) {
  return {
    event_class: "100 mi mountain race",
    horizon: "next A-race ~Aug 2027",
    phase: "return_to_run",
    weekly_volume_band: { dist_mi: [0, 25], vert_ft: [0, 3000] },
    notes: "shin niggle; reassess 2026-09-23",
    ...over,
  };
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goals-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeConfig(root, name, obj) {
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", name), JSON.stringify(obj, null, 2));
}

test("loadGoals bootstraps from the example, forcing phase maintain", async (t) => {
  const root = await tempRoot(t);
  await writeConfig(root, "goals.example.json", validGoals({ phase: "peak" }));

  const { goals, bootstrapped, errors } = await loadGoals(root);
  assert.equal(bootstrapped, true);
  assert.deepEqual(errors, []);
  assert.equal(goals.phase, "maintain", "a fresh checkout never inherits a training phase");
  assert.equal(goals.event_class, "100 mi mountain race");
  assert.deepEqual(goals.weekly_volume_band.dist_mi, [0, 25]);

  const written = JSON.parse(await fs.readFile(goalsPath(root), "utf8"));
  assert.deepEqual(written, goals, "the bootstrap is persisted, not just returned");
});

test("loadGoals bootstraps with no example at all", async (t) => {
  const root = await tempRoot(t);
  const { goals, bootstrapped, errors } = await loadGoals(root);
  assert.equal(bootstrapped, true);
  assert.deepEqual(errors, []);
  assert.equal(goals.phase, "maintain");
  assert.ok(goals.event_class, "a usable event_class is still produced");
});

test("loadGoals reads an existing file unchanged", async (t) => {
  const root = await tempRoot(t);
  await writeConfig(root, "goals.example.json", validGoals({ event_class: "50k" }));
  const mine = validGoals({ phase: "recovery", notes: "hand-written" });
  await writeConfig(root, "goals.json", mine);

  const { goals, bootstrapped } = await loadGoals(root);
  assert.equal(bootstrapped, false);
  assert.deepEqual(goals, mine, "the example must not leak into an existing goals.json");
});

test("loadGoals surfaces an invalid file instead of overwriting it", async (t) => {
  const root = await tempRoot(t);
  const broken = validGoals({ phase: "sharpening" });
  await writeConfig(root, "goals.json", broken);

  const { goals, bootstrapped, errors } = await loadGoals(root);
  assert.equal(bootstrapped, false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /phase must be one of/);
  assert.deepEqual(JSON.parse(await fs.readFile(goalsPath(root), "utf8")), broken,
    "the athlete's prose survives a bad phase");
  assert.equal(goals.phase, "sharpening", "the caller sees what is actually on disk");
});

test("validateGoals rejects the ways a band goes wrong", () => {
  assert.equal(validateGoals(validGoals()).ok, true);
  for (const phase of GOAL_PHASES) {
    assert.equal(validateGoals(validGoals({ phase })).ok, true, `${phase} is a legal phase`);
  }

  const cases = [
    [validGoals({ event_class: "  " }), /event_class/],
    [validGoals({ phase: null }), /phase must be one of/],
    [validGoals({ weekly_volume_band: { dist_mi: [10, 20] } }), /vert_ft/],
    [validGoals({ weekly_volume_band: { dist_mi: [30, 10], vert_ft: [0, 3000] } }), /lo 30 is above hi 10/],
    [validGoals({ weekly_volume_band: { dist_mi: [-1, 10], vert_ft: [0, 3000] } }), /dist_mi: \[lo, hi\]/],
    [validGoals({ weekly_volume_band: { dist_mi: [0, 10, 20], vert_ft: [0, 3000] } }), /dist_mi: \[lo, hi\]/],
    [validGoals({ notes: 42 }), /notes/],
    ["not an object", /must be a JSON object/],
  ];
  for (const [obj, re] of cases) {
    const { ok, errors } = validateGoals(obj);
    assert.equal(ok, false, `expected ${JSON.stringify(obj)} to be rejected`);
    assert.ok(errors.some((e) => re.test(e)), `expected ${re} in ${errors.join("; ")}`);
  }
});

test("saveGoals round-trips and refuses invalid goals", async (t) => {
  const root = await tempRoot(t);
  const p = await saveGoals(root, validGoals({ phase: "base" }));
  assert.equal(p, goalsPath(root));
  const { goals, bootstrapped } = await loadGoals(root);
  assert.equal(bootstrapped, false);
  assert.equal(goals.phase, "base");

  await assert.rejects(() => saveGoals(root, validGoals({ phase: "sharpening" })), /invalid goals/);
  assert.equal((await loadGoals(root)).goals.phase, "base", "the rejected write touched nothing");
});

test("bandMidpoint averages the pair", () => {
  assert.equal(bandMidpoint([0, 30]), 15);
  assert.equal(bandMidpoint([2000, 5000]), 3500);
  assert.equal(bandMidpoint(undefined), 0);
});

test("the committed config/goals.example.json validates", async () => {
  const example = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, "config", "goals.example.json"), "utf8"));
  const { ok, errors } = validateGoals(example);
  assert.equal(ok, true, errors.join("\n"));
});
