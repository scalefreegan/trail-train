// Feature-gating tests.
//
// web/src/race/features.ts is the whole of the "which panels does this race
// have?" decision — the views hold conditionals and no logic — so it is worth
// pinning down away from the DOM. The rule that matters most is the default:
// an absent flag, or no active race at all, means VISIBLE, so every race
// folder written before a flag existed keeps rendering as it did.
//
// The .ts source is imported directly, like scripts/theme-presets.test.mjs:
// Node strips the types (node >= 22.18, and features.ts only ever imports
// TYPES from ./types, so nothing else is pulled in at runtime). No build step,
// so the test reads exactly what the app ships.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  FEATURE_KEYS,
  PANEL_KEYS,
  hasFeature,
  isTuneUp,
  resolveFeatures,
  visibleColumns,
  visiblePanels,
} from "../web/src/race/features.ts";
import { validateRaceJson, listRaces } from "./race-config.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_PATH = fileURLToPath(new URL("../races/_fixtures/crewless-50k/race.json", import.meta.url));
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

/** A minimal race that only carries the fields a gating question needs. */
function race(patch = {}) {
  return { schema_version: 1, slug: "test-race", status: "active", ...patch };
}

test("no active race: everything is visible", () => {
  for (const k of FEATURE_KEYS) assert.equal(hasFeature(null, k), true, `feature ${k}`);
  const panels = visiblePanels(null);
  for (const k of PANEL_KEYS) assert.equal(panels[k], true, `panel ${k}`);
  assert.deepEqual(visibleColumns(null), { crew: true, drop_bag: true, pacers: true });
});

test("undefined race (still fetching) reads the same as generic mode", () => {
  assert.deepEqual(resolveFeatures(undefined), resolveFeatures(null));
  assert.deepEqual(visiblePanels(undefined), visiblePanels(null));
});

test("a race with no features block keeps every panel", () => {
  const r = race();
  assert.deepEqual(resolveFeatures(r), resolveFeatures(null));
  assert.deepEqual(visiblePanels(r), visiblePanels(null));
});

test("an absent flag defaults to on, a false flag turns it off", () => {
  const r = race({ features: { crew: false } });
  assert.equal(hasFeature(r, "crew"), false);
  // the other flags are absent, not false — they stay visible
  assert.equal(hasFeature(r, "drop_bags"), true);
  assert.equal(hasFeature(r, "night"), true);
});

test("crewless: no crew panel, column or slider", () => {
  const r = race({ features: { crew: false } });
  assert.equal(visibleColumns(r).crew, false);
  assert.equal(visiblePanels(r).crew_sheet, false);
  // the rest of the planner is untouched
  assert.equal(visibleColumns(r).drop_bag, true);
  assert.equal(visiblePanels(r).model_check, true);
});

test("drop_bags false: no drop-bag card, no DROP chip", () => {
  const r = race({ features: { drop_bags: false } });
  assert.equal(visiblePanels(r).drop_bag_card, false);
  assert.equal(visibleColumns(r).drop_bag, false);
  assert.equal(visibleColumns(r).crew, true);
});

test("pacers false: no PACER chip", () => {
  assert.equal(visibleColumns(race({ features: { pacers: false } })).pacers, false);
});

test("night false: no caffeine section", () => {
  const r = race({ features: { night: false } });
  assert.equal(resolveFeatures(r).night, false);
  assert.equal(resolveFeatures(r).heat, true);
});

test("altitude true: the caveat is on", () => {
  assert.equal(resolveFeatures(race({ features: { altitude: true } })).altitude, true);
  assert.equal(resolveFeatures(race({ features: { altitude: false } })).altitude, false);
});

test("visual.panels hides a panel the race does have", () => {
  const r = race({ visual: { panels: { climb_comparison: false, model_check: false } } });
  assert.equal(visiblePanels(r).climb_comparison, false);
  assert.equal(visiblePanels(r).model_check, false);
  // crew_sheet was not mentioned — absent means visible here too
  assert.equal(visiblePanels(r).crew_sheet, true);
});

test("visual.panels cannot resurrect a panel the feature flag killed", () => {
  const r = race({ features: { crew: false, drop_bags: false }, visual: { panels: { crew_sheet: true, drop_bag_card: true } } });
  assert.equal(visiblePanels(r).crew_sheet, false, "no crew means no crew sheet, whatever the panel says");
  assert.equal(visiblePanels(r).drop_bag_card, false);
});

test("an unknown panel key in visual.panels is ignored, not crashed on", () => {
  const r = race({ visual: { panels: { made_up_panel: false } } });
  assert.deepEqual(visiblePanels(r), visiblePanels(null));
});

/* ---- tune-ups: the one place an absent flag is OFF (PRD-v2 §3) ---- */

/** What scripts/race-intake.mjs's quickCreateRace writes: no `features`
    block at all, because the quick form never asks about crew. */
const tuneUp = (patch = {}) => race({ kind: "b", parent_slug: "big-race-2027", status: "draft", ...patch });

test("a tune-up with no features block: no crew, no drop bags, no pacers, no night", () => {
  const b = tuneUp();
  assert.equal(isTuneUp(b), true);
  const f = resolveFeatures(b);
  assert.equal(f.crew, false);
  assert.equal(f.drop_bags, false);
  assert.equal(f.pacers, false);
  assert.equal(f.night, false, "no caffeine schedule on a Saturday tune-up");
  // the flags TUNE_UP_DEFAULTS says nothing about keep the default-visible rule
  assert.equal(f.heat, true);
  assert.equal(f.altitude, true);
  assert.equal(f.water_crossings, true);
});

test("a tune-up's reduced planner: no crew sheet, no drop-bag card, no crew/drop columns", () => {
  const b = tuneUp();
  assert.deepEqual(visibleColumns(b), { crew: false, drop_bag: false, pacers: false });
  const panels = visiblePanels(b);
  assert.equal(panels.crew_sheet, false);
  assert.equal(panels.drop_bag_card, false);
  // the model check and the climb comparison are not feature-gated — a
  // tune-up still has a course to compare and a projection to check
  assert.equal(panels.climb_comparison, true);
  assert.equal(panels.model_check, true);
});

test("an explicit flag still wins on a tune-up — a crewed tune-up says so", () => {
  const b = tuneUp({ features: { crew: true, night: true } });
  assert.equal(hasFeature(b, "crew"), true);
  assert.equal(hasFeature(b, "night"), true);
  assert.equal(visiblePanels(b).crew_sheet, true);
  // the flags it did NOT mention keep the tune-up default
  assert.equal(hasFeature(b, "drop_bags"), false);
});

test("kind \"a\" and a folder written before v2 are untouched", () => {
  assert.equal(isTuneUp(race({ kind: "a" })), false);
  assert.equal(isTuneUp(race()), false);
  assert.equal(isTuneUp(null), false);
  assert.deepEqual(resolveFeatures(race({ kind: "a" })), resolveFeatures(null));
  assert.deepEqual(resolveFeatures(race()), resolveFeatures(null));
});

/* ---- the committed fixture ---- */

test("races/_fixtures/crewless-50k/race.json is a valid race.json", () => {
  const { ok, errors } = validateRaceJson(fixture);
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test("the crewless-50k fixture renders planner + cards only", () => {
  assert.deepEqual(visibleColumns(fixture), { crew: false, drop_bag: false, pacers: false });
  assert.deepEqual(visiblePanels(fixture), {
    climb_comparison: false, model_check: false, crew_sheet: false, drop_bag_card: false,
  });
  const f = resolveFeatures(fixture);
  assert.equal(f.night, false, "no caffeine schedule on a race that finishes in daylight");
  assert.equal(f.heat, true, "heat rows stay — it is a desert 50k");
  assert.equal(f.altitude, false);
  // the fixture carries altitude prose on purpose: the flag, not the prose,
  // decides whether the paragraph renders
  assert.equal(typeof fixture.coach_notes.altitude, "string");
});

test("the fixtures folder is not a selectable race", async () => {
  const slugs = (await listRaces(REPO_ROOT)).map((r) => r.slug);
  assert.equal(slugs.includes("_fixtures"), false);
  assert.equal(slugs.includes("crewless-50k"), false, "the fixture lives one level down and is never listed");
});
