// One-time legacy pacing-knob migration (web/src/race/knobMigration.ts).
//
// PR #23 review round 1, finding 3: the migration used to target whichever
// race was on screen FIRST after this shipped, not specifically the one the
// bare `race.<knob>` keys actually belonged to — silently copying that
// race's tuned sliders into an unrelated race's namespace and permanently
// blocking (via the migrated-slugs guard) the correct migration from ever
// running. This pins the fixed function down against a fake localStorage,
// away from the DOM and away from useRacePlan.ts's own fixed slug argument.
//
// The .ts source is imported directly, like scripts/features.test.mjs:
// knobMigration.ts has no React import and no DOM reference, so Node can
// strip its types and run it as-is (node >= 22.18). No build step, so the
// test reads exactly what the app ships.

import test from "node:test";
import assert from "node:assert/strict";

import { RACE_KNOBS, migrateLegacyKnobs } from "../web/src/race/knobMigration.ts";

/** A minimal in-memory Storage stand-in — just what migrateLegacyKnobs uses. */
function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
    _dump: () => Object.fromEntries(store),
  };
}

test("moves every bare race.<knob> key into race.<slug>.<knob> and deletes the bare key", () => {
  const storage = fakeStorage({
    "race.goal_h": "30.5",
    "race.fatigue_pct_v2": "5",
    "race.restraint_pct": "8",
  });
  migrateLegacyKnobs(storage, "mogollon-monster-100-2026", new Set());
  assert.equal(storage.getItem("race.goal_h"), null);
  assert.equal(storage.getItem("race.fatigue_pct_v2"), null);
  assert.equal(storage.getItem("race.mogollon-monster-100-2026.goal_h"), "30.5");
  assert.equal(storage.getItem("race.mogollon-monster-100-2026.fatigue_pct_v2"), "5");
  assert.equal(storage.getItem("race.mogollon-monster-100-2026.restraint_pct"), "8");
});

test("an existing namespaced value always wins over the bare key", () => {
  const storage = fakeStorage({
    "race.goal_h": "30.5",                                  // the stray bare key
    "race.mogollon-monster-100-2026.goal_h": "28",           // already set by this race's own slider
  });
  migrateLegacyKnobs(storage, "mogollon-monster-100-2026", new Set());
  assert.equal(storage.getItem("race.mogollon-monster-100-2026.goal_h"), "28");
  // the stray bare key is still cleaned up even though it lost
  assert.equal(storage.getItem("race.goal_h"), null);
});

test("runs once per slug: a second call is a no-op even if the bare key comes back", () => {
  const migrated = new Set();
  const storage = fakeStorage({ "race.goal_h": "30.5" });
  migrateLegacyKnobs(storage, "mogollon-monster-100-2026", migrated);
  assert.equal(storage.getItem("race.mogollon-monster-100-2026.goal_h"), "30.5");

  // Simulate the bare key somehow reappearing (e.g. an older tab writing it).
  storage.setItem("race.goal_h", "99");
  migrateLegacyKnobs(storage, "mogollon-monster-100-2026", migrated);
  // Second call is a no-op: the reappeared bare key is left alone, not
  // re-migrated and not deleted.
  assert.equal(storage.getItem("race.goal_h"), "99");
  assert.equal(storage.getItem("race.mogollon-monster-100-2026.goal_h"), "30.5");
});

test("THE FIX: migrating a currently-viewed race never touches the legacy slug's keys", () => {
  // This is the regression itself: before the fix, useRacePlan.ts called
  // migrateLegacyKnobs(viewedSlug) — whichever race the athlete's first page
  // load after the ship happened to land on. A first load into a brand-new
  // second race would migrate MM100's bare keys into ITS namespace instead.
  const storage = fakeStorage({ "race.goal_h": "30.5" });
  const migrated = new Set();
  // A first load that lands on a different race: the fixed call always
  // passes LEGACY_KNOB_SLUG, never the viewed slug.
  const viewedSlug = "san-juan-softie-100-2027";
  migrateLegacyKnobs(storage, "mogollon-monster-100-2026", migrated);
  assert.equal(storage.getItem(`race.san-juan-softie-100-2027.goal_h`), null, "must not land in the viewed race's namespace");
  assert.equal(storage.getItem("race.mogollon-monster-100-2026.goal_h"), "30.5", "must land in MM100's namespace");
  // and the viewed slug was never even asked for a migration
  assert.equal(migrated.has(viewedSlug), false);
});

test("no storage (no DOM / private-mode failure surfaced as undefined): silently does nothing", () => {
  assert.doesNotThrow(() => migrateLegacyKnobs(undefined, "mogollon-monster-100-2026", new Set()));
});

test("no legacy keys present: no-op, no keys invented", () => {
  const storage = fakeStorage({});
  migrateLegacyKnobs(storage, "mogollon-monster-100-2026", new Set());
  assert.deepEqual(storage._dump(), {});
});

test("RACE_KNOBS covers every knob useRacePlan.ts persists per-race", () => {
  assert.deepEqual(
    [...RACE_KNOBS].sort(),
    ["aid_stop_min", "calibration_pct", "crew_stop_min", "fatigue_pct_v2", "goal_h", "restraint_pct", "stop_overrides"].sort(),
  );
});
