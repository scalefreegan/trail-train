// Race-day "WHERE AM I" hold resolution — pinned down away from the DOM.
//
// D1/D2: the station <select> used to apply on *change* while a separate
// SET button committed the free-mile text field; once the select had
// already moved the hold, the mile field read back "" and Number("") is 0,
// so pressing SET re-committed the hold to mile 0 — "held at 0.0 km" at
// mile 95 in the dark. web/src/race/raceDayHold.ts is now the only place
// that decides what SET commits; this test is its contract.
//
// The .ts source is imported directly, like scripts/features.test.mjs:
// Node strips the types (raceDayHold.ts has no JSX and no runtime import
// besides its own types), so the test reads exactly what the app ships.

import test from "node:test";
import assert from "node:assert/strict";

import { resolveHold } from "../web/src/race/raceDayHold.ts";

test("both drafts empty: no-op, not mile zero", () => {
  assert.equal(resolveHold("", "", "imperial"), null);
  assert.equal(resolveHold("", "", "metric"), null);
});

test("a station pick commits that station's mile", () => {
  assert.equal(resolveHold("52.8", "", "imperial"), 52.8);
  assert.equal(resolveHold("95.5", "", "metric"), 95.5);
});

test("a station pick wins over a stray mile draft", () => {
  // the exact bug scenario: the select already moved the hold, and a stale
  // mile field must never override it with something else
  assert.equal(resolveHold("52.8", "999", "imperial"), 52.8);
});

test("a typed mile commits, converted from the display unit", () => {
  assert.equal(resolveHold("", "42", "imperial"), 42);
  // metric: the typed number is km, so it converts down to internal miles
  assert.equal(resolveHold("", "42", "metric"), 42 / 1.609344);
});

test("an empty mile draft is a no-op, never zero", () => {
  assert.equal(resolveHold("", "", "imperial"), null);
  assert.equal(resolveHold("", "   ", "imperial"), null);
});

test("an unparseable or negative mile is rejected, not coerced", () => {
  assert.equal(resolveHold("", "abc", "imperial"), null);
  assert.equal(resolveHold("", "-5", "imperial"), null);
  assert.equal(resolveHold("", "NaN", "imperial"), null);
});

test("mile zero is a legitimate, distinct commit from 'nothing typed'", () => {
  assert.equal(resolveHold("", "0", "imperial"), 0);
  assert.equal(resolveHold("0", "", "imperial"), 0);
});
