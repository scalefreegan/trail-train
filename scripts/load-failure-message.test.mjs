// v2 review ui3 #6: a dead dev server and a genuinely corrupt race file both
// used to land in useRaceData.ts's snapshot hooks as "<file> corrupt or
// unreadable" — the file is fine, the server is just gone, and on race day
// that sends the athlete looking at their race folder for damage that isn't
// there. web/src/race/loadFailureMessage.ts's loadFailureMessage is the
// fix; this is its contract.
//
// The .ts source is imported directly, like scripts/pacing-format.test.mjs —
// it has one relative import of its own (./dialogChrome, itself importing
// only react), so the same resolve hook that file uses (node >= 22.18 strips
// the types; the hook appends `.ts` to the relative import) is needed here
// too.

import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && !/\.[a-z]+$/i.test(spec) && /\.tsx?$/i.test(ctx.parentURL ?? "")) {
      return next(`${spec}.ts`, ctx);
    }
    return next(spec, ctx);
  },
});

const { loadFailureMessage } = await import("../web/src/race/loadFailureMessage.ts");

test("a network-level failure (fetch's own TypeError) reads as server-unreachable, matching the switcher's wording", () => {
  const msg = loadFailureMessage(new TypeError("Failed to fetch"), "course.json corrupt or unreadable");
  assert.equal(msg, "server unreachable — is Basecamp running?");
});

test("a genuine parse failure keeps the corrupt wording", () => {
  // useCourse/useCrewBase/usePaceGrade all funnel a JSON parse failure into
  // exactly this shape: `r.json().catch(() => { throw new Error("parse") })`
  const msg = loadFailureMessage(new Error("parse"), "course.json corrupt or unreadable");
  assert.equal(msg, "course.json corrupt or unreadable");
});

test("any other non-network error also keeps the corrupt wording, not the network one", () => {
  assert.equal(
    loadFailureMessage(new RangeError("whatever"), "crew-base.json corrupt or unreadable"),
    "crew-base.json corrupt or unreadable",
  );
  assert.equal(
    loadFailureMessage("a bare string, not even an Error", "pace-grade.json corrupt or unreadable"),
    "pace-grade.json corrupt or unreadable",
  );
});
