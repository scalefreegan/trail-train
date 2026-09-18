// node --test scripts/check-races.test.mjs   (or: cd web && npm test)
//
// The two pieces of scripts/check-races.mjs that are judgement rather than
// plumbing: the grep gate's comment-vs-code classifier (which decides whether
// a race literal is history or coupling) and the PRD §12 assertion set for the
// San Juan Softie draft. Nothing here shells out, reads races/ or hits the
// network — the harness's own build/test section is what does that, and it
// cannot run inside the test run it spawns.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ALLOWED_EXCEPTIONS,
  DRAFT_SLUG,
  RACE_LITERAL_RE,
  classifyLines,
  clockMinutes,
  commentStyle,
  isExcludedFromScan,
  ownedProvenance,
  scanText,
  softieChecks,
  sunWithin,
  tail,
} from "./check-races.mjs";

/* ------------------------- the comment classifier ----------------------- */

test("line comments, block comments and continuations are comments", () => {
  const src = [
    `// a mogollon mention in a line comment`,
    `/* one-line block about MM100 */`,
    `/**`,
    ` * a continuation line naming Horton`,
    ` */`,
    `const ok = 1;`,
  ].join("\n");
  const kinds = classifyLines(src, "c").map((l) => l.comment);
  assert.deepEqual(kinds, [true, true, true, true, true, false]);
  assert.deepEqual(scanText("web/src/x.ts", src).map((h) => h.kind), ["comment", "comment", "comment"]);
});

test("a code line that merely mentions the race fails the gate", () => {
  const hits = scanText("web/src/x.ts", `const title = "Mogollon Monster 100";`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "code");
  assert.equal(hits[0].line, 1);
});

test("code after a block comment closes is code again", () => {
  const src = [
    `/* a block that`,
    `   runs on about MM100`,
    `*/ const slug = "mogollon-monster-100-2026";`,
    `const after = 2;`,
  ].join("\n");
  const lines = classifyLines(src, "c");
  assert.deepEqual(lines.map((l) => l.comment), [true, true, false, false]);
  assert.deepEqual(scanText("web/src/x.ts", src).map((h) => h.kind), ["comment", "code"]);
});

test("a string that merely contains // is still code", () => {
  // The conservative direction: a URL with the race name in it must not be
  // excused because the line happens to contain a comment marker.
  const hits = scanText("scripts/x.mjs", `const u = "https://example.com/mogollon";`);
  assert.deepEqual(hits.map((h) => h.kind), ["code"]);
});

test("markdown and JSON have no comment syntax", () => {
  assert.equal(commentStyle("README.md"), "none");
  assert.equal(commentStyle("web/public/state.json"), "none");
  // A markdown bullet starts with "*" but is prose, not a comment continuation.
  assert.deepEqual(scanText("README.md", `* the Mogollon Monster`).map((h) => h.kind), ["code"]);
});

test("html, shell and applescript comments are recognised", () => {
  assert.deepEqual(classifyLines(`<!-- MM100 -->\n<title>x</title>`, "html").map((l) => l.comment), [true, false]);
  assert.deepEqual(classifyLines(`# MM100\necho hi`, "hash").map((l) => l.comment), [true, false]);
  assert.deepEqual(classifyLines(`-- MM100\nset x to 1`, "applescript").map((l) => l.comment), [true, false]);
});

/* ---------------------------- the exceptions ---------------------------- */

test("the listed exceptions are allowed, and only in their own file", () => {
  assert.ok(ALLOWED_EXCEPTIONS.length >= 1);
  for (const e of ALLOWED_EXCEPTIONS) {
    assert.ok(e.why && e.why.length > 20, `${e.file}: an exception needs a reason`);
  }
  const line = `const LEGACY_KNOB_SLUG = "mogollon-monster-100-2026";`;
  assert.equal(scanText("web/src/race/useRacePlan.ts", line)[0].kind, "allowed");
  // Same text, different file: not the exception that was granted.
  assert.equal(scanText("web/src/race/other.ts", line)[0].kind, "code");
  // Same file, different symbol: also not it.
  assert.equal(
    scanText("web/src/race/useRacePlan.ts", `const other = "mogollon-monster-100-2026";`)[0].kind,
    "code"
  );
});

test("tests and the checker itself are out of scope", () => {
  assert.equal(isExcludedFromScan("scripts/race-build.test.mjs"), true);
  assert.equal(isExcludedFromScan("scripts/check-races.mjs"), true);
  assert.equal(isExcludedFromScan("scripts/check-races.test.mjs"), true);
  assert.equal(isExcludedFromScan("scripts/race-build.mjs"), false);
});

test("the pattern covers every retired literal, case-insensitively", () => {
  for (const s of ["Mogollon", "mm100", "Pine, AZ", "Rim 6", "horton", "Buck Springs",
    "Fish Hatchery", "two-sixty", "Old Pine"]) {
    assert.ok(RACE_LITERAL_RE.test(s), `${s} should match`);
  }
  for (const s of ["San Juan Softie", "pineapple", "rim", "hatchery"]) {
    assert.equal(RACE_LITERAL_RE.test(s), false, `${s} should not match`);
  }
});

/* --------------------------- the §12 assertions -------------------------- */

/** A Softie-shaped draft: the fields PRD §12 pins, and nothing else. */
function softieFixture(overrides = {}) {
  const station = (name, total_mi, crew = false) => ({
    name, total_mi, crew, drop_bag: crew, pacers: crew, menu: "full",
  });
  return {
    schema_version: 1,
    slug: DRAFT_SLUG,
    status: "draft",
    name: "San Juan Softie 100",
    short: "SJS100",
    timezone: "America/Denver",
    cutoff_h: 38,
    elevation: { min_ft: null, max_ft: 12438, avg_ft: 10282, altitude_significant: true },
    features: { crew: true, drop_bags: true, pacers: true, night: true, heat: false, altitude: true },
    links: { results: "https://www.opensplittime.org/events/2026-san-juan-softie-100/spread" },
    unresolved: ["date"],
    review_notes: "The aid chart is an image in the PDF and was transcribed cell by cell.",
    aid_stations: [
      station("Start", 0, true),
      station("Cascade #1", 8.3),
      station("EMT #2", 19.5),
      station("Engine Creek #3", 28),
      station("Middle of Nowhere #4", 35.8),
      station("Cross Mountain #5", 45.8, true),
      station("Calico #6", 52.8),
      station("Burnett #7", 64.8),
      station("Ryman Creek #8", 71.3, true),
      station("Corral #9", 79.9),
      station("Big Lick #10", 87.8),
      station("Elbert Creek #11", 95.5, true),
      station("Finish", 103.4, true),
    ],
    ...overrides,
  };
}

const failing = (race) => softieChecks(race).filter((c) => !c.ok).map((c) => c.name);

test("the fixture draft satisfies every PRD §12 expectation", () => {
  const results = softieChecks(softieFixture());
  assert.deepEqual(results.filter((c) => !c.ok), [], JSON.stringify(results.filter((c) => !c.ok)));
  assert.equal(results.length, 11);
});

test("the start row does not count as the first crew access", () => {
  // Crew see the runners off, but PRD §12's "first crew access at 45.8" is
  // about the first place on course they can reach.
  const hit = softieChecks(softieFixture()).find((c) => c.name === "first crew access at mi 45.8");
  assert.equal(hit.ok, true);
  assert.match(hit.detail, /Cross Mountain #5/);
});

test("each expectation fails on its own when the draft drifts", () => {
  assert.deepEqual(failing(softieFixture({ timezone: "America/Phoenix" })), ["timezone America/Denver"]);
  assert.deepEqual(failing(softieFixture({ cutoff_h: 36 })), ["cutoff 38 h"]);
  assert.deepEqual(
    failing(softieFixture({ elevation: { max_ft: 12000, avg_ft: 10282 } })),
    ["high point 12,438 ft"]
  );
  assert.deepEqual(
    failing(softieFixture({ features: { crew: true, drop_bags: true, pacers: true, heat: true } })),
    ["no heat flag"]
  );
  assert.deepEqual(
    failing(softieFixture({ links: { results: "https://ultrasignup.com/results_event.aspx" } })),
    ["results on OpenSplitTime"]
  );
  assert.deepEqual(failing(softieFixture({ status: "active" })), ["status is a draft"]);
});

test("a draft with nothing flagged for review fails the transcription check", () => {
  assert.deepEqual(
    failing(softieFixture({ unresolved: [], review_notes: "" })),
    ["image-chart transcription flagged for review"]
  );
  // Either signal on its own is enough — unresolved[] alone, or prose alone.
  assert.deepEqual(failing(softieFixture({ review_notes: "" })), []);
  assert.deepEqual(failing(softieFixture({ unresolved: [] })), []);
});

test("dropping a station is caught as both a row count and a station count", () => {
  const short = softieFixture();
  short.aid_stations = short.aid_stations.filter((s) => s.name !== "Calico #6");
  assert.deepEqual(failing(short), ["11 numbered aid stations", "13 chart rows incl. start and finish"]);
});

/* ------------------------ the small shared helpers ---------------------- */

test("clock times and the five-minute sun tolerance", () => {
  assert.equal(clockMinutes("06:05"), 365);
  assert.equal(clockMinutes("6:05"), 365);
  assert.equal(clockMinutes(null), null);
  assert.deepEqual(sunWithin({ sunrise: "06:05", sunset: "18:35" }, { sunrise: "06:09", sunset: "18:31" }), []);
  assert.equal(sunWithin({ sunrise: "06:05", sunset: "18:35" }, { sunrise: "06:15", sunset: "18:35" }).length, 1);
  assert.equal(sunWithin({ sunrise: "06:05" }, {}).length, 2);
});

test("only user- and agent-owned provenance is guarded", () => {
  const owned = ownedProvenance({
    provenance: {
      date: { by: "user" },
      aid_stations: { by: "agent" },
      sun: { by: "computed" },
      "aid_stations[3].gpx_wpt": { by: "matcher" },
    },
  });
  assert.deepEqual(Object.keys(owned).sort(), ["aid_stations", "date"]);
  assert.deepEqual(ownedProvenance({}), {});
});

test("tail keeps the last non-blank lines", () => {
  assert.deepEqual(tail("a\n\nb\nc\n\n", 2), ["b", "c"]);
  assert.deepEqual(tail("only", 5), ["only"]);
});
