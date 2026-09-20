// Race-day "WHERE AM I" free-text parser — v2 review, ui1 #3: the box
// accepted a bare number and silently ignored "mile 50", "50 mi", "80 km"
// and a typed station name, leaving the text in place with no feedback.
// web/src/race/whereAmI.ts is the fix; this is its contract.
//
// The .ts source is imported directly, like scripts/race-day-hold.test.mjs:
// it has no relative imports of its own, so plain type-stripping (node >=
// 22.18) is enough — no resolve hook needed.

import test from "node:test";
import assert from "node:assert/strict";

import { matchStationName, parseWhereAmI } from "../web/src/race/whereAmI.ts";

const STATIONS = ["Start", "Cascade #1", "Cross Mountain #5", "Calico #6", "Ryman Creek #8"];

test("a bare number reads in the current display unit, same as resolveHold", () => {
  assert.deepEqual(parseWhereAmI("50", STATIONS, "imperial"), { kind: "mile", mi: 50 });
  assert.deepEqual(parseWhereAmI("50", STATIONS, "metric"), { kind: "mile", mi: 50 / 1.609344 });
});

test('"mile N" is always miles, regardless of the display unit', () => {
  assert.deepEqual(parseWhereAmI("mile 50", STATIONS, "metric"), { kind: "mile", mi: 50 });
  assert.deepEqual(parseWhereAmI("Mile 50.5", STATIONS, "imperial"), { kind: "mile", mi: 50.5 });
});

test('"N mi" is always miles', () => {
  assert.deepEqual(parseWhereAmI("50 mi", STATIONS, "metric"), { kind: "mile", mi: 50 });
  assert.deepEqual(parseWhereAmI("50mi", STATIONS, "metric"), { kind: "mile", mi: 50 });
});

test('"N km" is always kilometers, converted to internal miles', () => {
  const r = parseWhereAmI("80 km", STATIONS, "imperial");
  assert.equal(r.kind, "mile");
  assert.ok(Math.abs(r.mi - 80 / 1.609344) < 1e-9);
  assert.deepEqual(parseWhereAmI("80km", STATIONS, "imperial"), r);
});

test("an exact station name matches", () => {
  assert.deepEqual(parseWhereAmI("Cross Mountain #5", STATIONS, "imperial"), { kind: "station", name: "Cross Mountain #5" });
  // case/whitespace-insensitive
  assert.deepEqual(parseWhereAmI("  cross mountain #5  ", STATIONS, "imperial"), { kind: "station", name: "Cross Mountain #5" });
});

test("an unambiguous station prefix matches", () => {
  assert.deepEqual(parseWhereAmI("Ryman", STATIONS, "imperial"), { kind: "station", name: "Ryman Creek #8" });
});

test("an ambiguous prefix is unparsable, not guessed at", () => {
  assert.deepEqual(matchStationName("ca", ["Cascade #1", "Calico #6"]), null);
  assert.deepEqual(parseWhereAmI("ca", STATIONS, "imperial"), { kind: "unparsable" });
});

test("empty, garbage, and a negative or non-finite number are all unparsable", () => {
  assert.deepEqual(parseWhereAmI("", STATIONS, "imperial"), { kind: "unparsable" });
  assert.deepEqual(parseWhereAmI("   ", STATIONS, "imperial"), { kind: "unparsable" });
  assert.deepEqual(parseWhereAmI("-5", STATIONS, "imperial"), { kind: "unparsable" });
  assert.deepEqual(parseWhereAmI("NaN", STATIONS, "imperial"), { kind: "unparsable" });
  assert.deepEqual(parseWhereAmI("Not A Station", STATIONS, "imperial"), { kind: "unparsable" });
});

test("a compound phrase (mile + time) is unparsable, not half-read", () => {
  // the "passed <station> at HH:MM" control next to this box already covers
  // a timed sighting — this box deliberately does not also parse one
  assert.deepEqual(parseWhereAmI("mile 50 at 15:30", STATIONS, "imperial"), { kind: "unparsable" });
});

test("mile zero is a legitimate parse, not unparsable", () => {
  assert.deepEqual(parseWhereAmI("0", STATIONS, "imperial"), { kind: "mile", mi: 0 });
  assert.deepEqual(parseWhereAmI("mile 0", STATIONS, "imperial"), { kind: "mile", mi: 0 });
});
