// node --test scripts/check-races.test.mjs   (or: cd web && npm test)
//
// Mostly the pieces of scripts/check-races.mjs that are judgement rather than
// plumbing: the grep gate's comment-vs-code classifier (which decides whether
// a race literal is history or coupling) and the PRD §12 assertion set for the
// San Juan Softie draft. Nothing here shells out or hits the network — the
// harness's own build/test section is what does that, and it cannot run
// inside the test run it spawns. checkFolders' block-staleness WARN-vs-FAIL
// split is the one exception that reads a (temp-dir, never the real races/)
// folder — its judgement call is specific enough, and easy enough to regress
// silently, to be worth the disk I/O.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ALLOWED_EXCEPTIONS,
  DRAFT_SLUG,
  RACE_LITERAL_RE,
  REFERENCE_SLUG,
  checkFolders,
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

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

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
    unresolved: ["links.tracking"],
    unresolved_acknowledged: true,
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
    failing(softieFixture({ unresolved: [], unresolved_acknowledged: false, review_notes: "" })),
    ["image-chart transcription flagged for review"]
  );
  // Any one of the three signals on its own is enough. In particular a draft
  // whose holes have all been filled and acknowledged (tt-yib.14 prunes the
  // key, so unresolved[] empties as the review progresses) is still flagged.
  assert.deepEqual(failing(softieFixture({ review_notes: "", unresolved_acknowledged: false })), []);
  assert.deepEqual(failing(softieFixture({ unresolved: [], review_notes: "" })), []);
  assert.deepEqual(failing(softieFixture({ unresolved: [], unresolved_acknowledged: false })), []);
});

test("a filled-in date is not a regression", () => {
  // The draft started with date null in unresolved[]; tt-yib.14's review
  // dialog filled it. Nothing in §12 pins the date, and the check must not
  // read a resolved hole as one.
  assert.deepEqual(failing(softieFixture({ date: "2027-08-13", unresolved: ["links.tracking"] })), []);
  assert.deepEqual(failing(softieFixture({ date: null, unresolved: ["date", "links.tracking"] })), []);
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

/* ------------------------ checkFolders: block staleness ------------------ */

/** A temp root holding one copy of the reference race's folder, re-slugged
    and re-dated far enough from its committed block.json's calendar to be
    unmistakably stale under any reasonable week count. */
async function staleBlockFolder(slug, status) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "check-races-blockstale-"));
  const src = path.join(ROOT, "races", REFERENCE_SLUG);
  const dir = path.join(tmp, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  for (const f of ["course.gpx", "block.json", "nutrition.json", "race.json"]) {
    await fs.copyFile(path.join(src, f), path.join(dir, f));
  }
  const race = JSON.parse(await fs.readFile(path.join(dir, "race.json"), "utf8"));
  race.slug = slug;
  race.status = status;
  race.date = "2099-01-05"; // nowhere near the committed block's calendar
  if (status === "draft") race.unresolved = [];
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(race, null, 2));
  return tmp;
}

test("checkFolders warns (does not fail) a draft folder whose block was counted back from a different race date", async (t) => {
  const tmp = await staleBlockFolder("stale-draft-2099", "draft");
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const r = await checkFolders(tmp);
  assert.equal(r.status, "PASS", `a stale block on a DRAFT must not fail the gate: ${JSON.stringify(r.detail)}`);
  assert.equal(r.detail.length, 0);
  assert.ok(
    r.warnings.some((w) => /stale-draft-2099\/block\.json/.test(w) && /counted back from a race date/.test(w)),
    JSON.stringify(r.warnings)
  );
});

test("checkFolders fails an active folder whose block was counted back from a different race date", async (t) => {
  const tmp = await staleBlockFolder("stale-active-2099", "active");
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const r = await checkFolders(tmp);
  assert.equal(r.status, "FAIL");
  assert.ok(
    r.detail.some((e) => /stale-active-2099\/block\.json/.test(e) && /counted back from a race date/.test(e)),
    JSON.stringify(r.detail)
  );
  assert.deepEqual(r.warnings, []);
});

/* ------------------ checkFolders: B folders (PRD-v2 §3) ------------------ */

/** A temp root holding one A race and one tune-up hanging off it, both
    written the way quickCreateRace writes them: race.json alone, no
    block.json, no nutrition.json, no plan. */
async function tuneUpRoot(over = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "check-races-bfolder-"));
  const parent = {
    schema_version: 1,
    slug: "san-juan-softie-100-2027",
    status: "active",
    name: "San Juan Softie 100",
    short: "SJS100",
    date: "2027-08-13",
    start_time: "06:00",
    timezone: "America/Denver",
    distance_mi: 104,
    gain_ft: 19000,
    cutoff_h: 38,
    aid_stations: [{ name: "Finish", total_mi: 104, cutoff_h: 38 }],
  };
  const tuneUp = {
    schema_version: 1,
    slug: "jemez-mountain-50k-2027",
    kind: "b",
    parent_slug: parent.slug,
    status: "draft",
    name: "Jemez Mountain 50K",
    short: "JM50K",
    date: "2027-05-22",
    start_time: "06:00",
    timezone: "America/Denver",
    distance_mi: 31,
    gain_ft: 5000,
    cutoff_h: null,
    unresolved: ["cutoff_h"],
    aid_stations: [{ name: "Finish", total_mi: 31, cutoff_h: null, crew: false, drop_bag: false }],
    ...over,
  };
  for (const race of [parent, tuneUp]) {
    const dir = path.join(tmp, "races", race.slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(race, null, 2));
  }
  return tmp;
}

test("checkFolders accepts a tune-up folder that carries no block, plan or nutrition", async (t) => {
  const tmp = await tuneUpRoot();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const r = await checkFolders(tmp);
  assert.equal(r.status, "PASS", JSON.stringify(r.detail));
  assert.deepEqual(r.warnings, []);
  // the folder line says which kind it is, so the "—"s read as the expected
  // shape rather than as something missing
  assert.ok(
    r.info.some((line) => /jemez-mountain-50k-2027\s+tune-up of san-juan-softie-100-2027/.test(line)),
    JSON.stringify(r.info),
  );
  // and the A race it hangs off is still the one active folder
  assert.match(r.reason, /active: san-juan-softie-100-2027/);
});

test("checkFolders catches a tune-up whose parent folder is not there", async (t) => {
  const tmp = await tuneUpRoot({ parent_slug: "deleted-race-2026" });
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const r = await checkFolders(tmp);
  assert.equal(r.status, "FAIL");
  assert.ok(
    r.detail.some((e) => /jemez-mountain-50k-2027\/race\.json/.test(e) && /no race folder races\/deleted-race-2026\//.test(e)),
    JSON.stringify(r.detail),
  );
});

test("tail keeps the last non-blank lines", () => {
  assert.deepEqual(tail("a\n\nb\nc\n\n", 2), ["b", "c"]);
  assert.deepEqual(tail("only", 5), ["only"]);
});
