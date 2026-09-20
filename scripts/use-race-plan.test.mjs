// The read-time clamp behind useRacePlan.ts's persisted numeric knobs (round
// 3, resilience finding 5): a stored `altitude_pct` of `1e308` reached the
// pacing model unclamped and crashed the race view (clock.ts's `toInstant` on
// the resulting `Invalid Date`). The clamp itself lives in
// web/src/race/persistedNumber.ts, split out zero-import — like
// checkpointHold.ts — specifically so this file can import it directly under
// `node --test`; useRacePlan.ts pulls in React and half the race module
// graph, none of which node can resolve.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCLIMATION_DAYS_RANGE, ALTITUDE_PCT_RANGE, clampToRange,
  parsePersistedNullableNumber, parsePersistedNumber,
} from "../web/src/race/persistedNumber.ts";

test("clampToRange holds a number inside [min, max], inclusive at both ends", () => {
  assert.equal(clampToRange(50, [0, 150]), 50);
  assert.equal(clampToRange(0, [0, 150]), 0);
  assert.equal(clampToRange(150, [0, 150]), 150);
  assert.equal(clampToRange(-50, [0, 150]), 0);
  assert.equal(clampToRange(1e308, [0, 150]), 150);
  assert.equal(clampToRange(-Infinity, [0, 150]), 0);
});

test("parsePersistedNumber: NaN/absent falls back to initial, unclamped", () => {
  assert.equal(parsePersistedNumber(null, 100, ALTITUDE_PCT_RANGE), 100);
  assert.equal(parsePersistedNumber("not a number", 100, ALTITUDE_PCT_RANGE), 100);
  assert.equal(parsePersistedNumber("NaN", 100, ALTITUDE_PCT_RANGE), 100);
});

test("parsePersistedNumber: altitude_pct clamps to the slider's own 0–150 range", () => {
  // The exact repro table from the resilience pass (round 3, finding 5).
  assert.equal(parsePersistedNumber("50", 100, ALTITUDE_PCT_RANGE), 50);
  assert.equal(parsePersistedNumber("-50", 100, ALTITUDE_PCT_RANGE), 0);
  assert.equal(parsePersistedNumber("500", 100, ALTITUDE_PCT_RANGE), 150);
  assert.equal(parsePersistedNumber("20000", 100, ALTITUDE_PCT_RANGE), 150);
  assert.equal(parsePersistedNumber("100000", 100, ALTITUDE_PCT_RANGE), 150);
  assert.equal(parsePersistedNumber("1e6", 100, ALTITUDE_PCT_RANGE), 150);
  // The value that crashed the race view outright.
  assert.equal(parsePersistedNumber("1e308", 100, ALTITUDE_PCT_RANGE), 150);
});

test("parsePersistedNumber: no range means no clamp — every other knob is unaffected", () => {
  assert.equal(parsePersistedNumber("500", 10), 500);
  assert.equal(parsePersistedNumber("-50", 10), -50);
});

test("parsePersistedNullableNumber: absent/blank is null, never a clamped fallback", () => {
  assert.equal(parsePersistedNullableNumber(null, ACCLIMATION_DAYS_RANGE), null);
  assert.equal(parsePersistedNullableNumber("", ACCLIMATION_DAYS_RANGE), null);
  assert.equal(parsePersistedNullableNumber("  ", ACCLIMATION_DAYS_RANGE), null);
  assert.equal(parsePersistedNullableNumber("not a number", ACCLIMATION_DAYS_RANGE), null);
  // 0 is a real value (arrive race morning), not "unset".
  assert.equal(parsePersistedNullableNumber("0", ACCLIMATION_DAYS_RANGE), 0);
});

test("parsePersistedNullableNumber: acclimation_days clamps to the field's own 0–60 range", () => {
  assert.equal(parsePersistedNullableNumber("99999", ACCLIMATION_DAYS_RANGE), 60);
  assert.equal(parsePersistedNullableNumber("-7", ACCLIMATION_DAYS_RANGE), 0);
  assert.equal(parsePersistedNullableNumber("30", ACCLIMATION_DAYS_RANGE), 30);
});
