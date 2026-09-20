// v2 review ui1 #14: viewing a GPX-less tune-up logged an expected 404 on
// /course.json as browser console noise on every view, drowning real
// signal. web/src/race/courseAvailability.ts's isKnownCourseless is the
// fix's decision function; this is its contract.
//
// The .ts source is imported directly, like scripts/race-day-hold.test.mjs:
// it has no relative imports of its own, so plain type-stripping (node >=
// 22.18) is enough — no resolve hook needed.

import test from "node:test";
import assert from "node:assert/strict";

import { isKnownCourseless } from "../web/src/race/courseAvailability.ts";

test("a tune-up (kind b) with no sources at all is known-courseless", () => {
  assert.equal(isKnownCourseless({ kind: "b" }), true);
  assert.equal(isKnownCourseless({ kind: "b", sources: [] }), true);
});

test("a tune-up with a non-gpx source is still known-courseless", () => {
  assert.equal(isKnownCourseless({ kind: "b", sources: [{ kind: "url" }] }), true);
});

test("a tune-up WITH a gpx source is not known-courseless — the 404 (if any) is transient, not permanent", () => {
  assert.equal(isKnownCourseless({ kind: "b", sources: [{ kind: "gpx" }] }), false);
  assert.equal(isKnownCourseless({ kind: "b", sources: [{ kind: "url" }, { kind: "gpx" }] }), false);
});

test("an A race never counts, gpx or not — this check is tune-ups only", () => {
  assert.equal(isKnownCourseless({ kind: "a" }), false);
  assert.equal(isKnownCourseless({}), false); // kind absent = "a" by the schema's own default
  assert.equal(isKnownCourseless({ kind: "a", sources: [{ kind: "gpx" }] }), false);
});

test("no race at all (not yet resolved, or generic mode) is not known-courseless", () => {
  assert.equal(isKnownCourseless(null), false);
  assert.equal(isKnownCourseless(undefined), false);
});
