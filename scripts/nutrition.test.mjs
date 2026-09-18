// nutrition.json loader tests, centred on the tt-yib.9 migration: body mass
// left the race folder for config/profile.json, and the loader has to keep
// working for files written before that happened.
//
// The .ts source is imported directly, like scripts/features.test.mjs. The
// validator lives in web/src/race/nutrition-config.ts rather than in
// nutrition.ts precisely so this is possible — the fueling model next door
// imports React and ../data, which node cannot resolve.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_NUTRITION, normalizeNutrition } from "../web/src/race/nutrition-config.ts";

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MM100_PATH = path.join(PROJECT_ROOT, "races", "mogollon-monster-100-2026", "nutrition.json");

/** Minimum a payload needs to get past the structural gate. */
const minimal = (over = {}) => ({
  flask_carb_g: 55,
  phases: [{ until_h: 12, carb_g_hr: 75, supplement: "gels" }],
  ...over,
});

test("the committed MM100 nutrition.json carries no caffeine.body_kg", () => {
  const raw = JSON.parse(readFileSync(MM100_PATH, "utf8"));
  assert.equal(
    raw.caffeine?.body_kg,
    undefined,
    "body mass belongs to the athlete (config/profile.json physiology.body_kg), not to a race folder that is meant to be shareable",
  );
});

test("the committed MM100 nutrition.json still loads", () => {
  const raw = JSON.parse(readFileSync(MM100_PATH, "utf8"));
  const cfg = normalizeNutrition(raw);
  assert.notEqual(cfg, null, "MM100's nutrition.json must survive the validator");
  // the caffeine block is still a real, complete one — just without the weight
  assert.equal(cfg.caffeine.gel_mg, 100);
  assert.ok(cfg.caffeine.gels > 0);
  assert.ok(cfg.caffeine.band_hi_mg_kg > cfg.caffeine.band_lo_mg_kg);
  assert.equal("body_kg" in cfg.caffeine, false);
  assert.ok(cfg.phases.length > 0);
});

test("the defaults carry no body mass either", () => {
  assert.equal("body_kg" in DEFAULT_NUTRITION.caffeine, false);
});

test("a legacy file's caffeine.body_kg is stripped, not merged through", () => {
  const cfg = normalizeNutrition(minimal({ caffeine: { body_kg: 79.4, gels: 4 } }));
  assert.notEqual(cfg, null);
  assert.equal("body_kg" in cfg.caffeine, false, "a leftover key must not ride along in the merged config");
  // everything else in the same block is still honoured
  assert.equal(cfg.caffeine.gels, 4);
  assert.equal(cfg.caffeine.gel_mg, DEFAULT_NUTRITION.caffeine.gel_mg);
});

test("a nutrition.json with no caffeine block at all still gets the defaults", () => {
  const cfg = normalizeNutrition(minimal());
  assert.notEqual(cfg, null);
  assert.deepEqual(cfg.caffeine, DEFAULT_NUTRITION.caffeine);
});

test("caffeine hygiene survived the body_kg removal", () => {
  // the positive-number sweep used to include body_kg; make sure dropping it
  // from the list didn't drop the rest with it
  const cfg = normalizeNutrition(minimal({
    caffeine: { gel_mg: 0, half_life_h: 0, min_spacing_h: -1, gels: 2.5, pre_race_before_h: 100000 },
  }));
  assert.equal(cfg.caffeine.gel_mg, DEFAULT_NUTRITION.caffeine.gel_mg);
  assert.ok(cfg.caffeine.half_life_h >= 0.5);
  assert.equal(cfg.caffeine.min_spacing_h, DEFAULT_NUTRITION.caffeine.min_spacing_h);
  assert.equal(cfg.caffeine.gels, 3, "gel counts are rounded — '2.5 gels' is not a thing");
  assert.ok(cfg.caffeine.pre_race_before_h <= 24, "an unbounded pre-race offset freezes the render loop");
});

test("a structurally unusable payload is rejected outright", () => {
  assert.equal(normalizeNutrition(null), null);
  assert.equal(normalizeNutrition([]), null);
  assert.equal(normalizeNutrition({ phases: [] }), null);
  assert.equal(normalizeNutrition(minimal({ flask_carb_g: 0 })), null);
});
