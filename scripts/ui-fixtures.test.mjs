// node --test scripts/ui-fixtures.test.mjs   (or: cd web && npm test)
//
// The Playwright suite's fixtures have one hard rule: nothing in them may be
// real. They stand in for files that are gitignored precisely because they
// hold a year of somebody's runs, sleep, heart rate and calendar — so a
// fixture written by copying a snapshot "just to get the shape right" would
// commit exactly the data the .gitignore exists to keep out.
//
// This is the automated half of that rule: a grep over every committed fixture
// AND over the snapshots the generator produces, for the shapes personal data
// takes — an e-mail address, a phone number, a street address, a real person's
// name, a coordinate near anywhere the athlete actually runs.
//
// It also checks the race fixtures still validate, because a fixture that has
// quietly stopped parsing takes the UI suite down with a failure that reads as
// a UI bug.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectRoot } from "./lib.mjs";
import { validateRaceJson } from "./race-config.mjs";
import { draftValidationErrors } from "./race-intake.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_RACES = path.join(ROOT, "races", "_fixtures");
const UI_FIXTURES = path.join(ROOT, "web", "tests", "fixtures");

/** Every committed fixture file, as {rel, text}. */
async function fixtureFiles() {
  const out = [];
  for (const base of [FIXTURE_RACES, UI_FIXTURES]) {
    const walk = async (dir) => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { await walk(p); continue; }
        out.push({ rel: path.relative(ROOT, p), text: await fs.readFile(p, "utf8") });
      }
    };
    await walk(base);
  }
  return out;
}

/**
 * Patterns that have no business in a synthetic fixture. Each one is paired
 * with the exceptions the fixtures legitimately contain, so the test fails on
 * a new match rather than on the ones that were deliberate.
 */
const FORBIDDEN = [
  {
    what: "an e-mail address",
    re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
    allow: () => false,
  },
  {
    what: "a phone number",
    // +1 555 867 5309 / (505) 555-0100 / 505-555-0100
    re: /(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g,
    allow: () => false,
  },
  {
    what: "a street address",
    re: /\b\d{1,5}\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place)\b/g,
    allow: () => false,
  },
  {
    what: "a real http(s) host",
    re: /https?:\/\/[^\s"'<>]+/g,
    // Only example.invalid (RFC 2606's reserved TLD — it cannot resolve) and
    // the GPX schema URL a GPX file is required to carry.
    allow: (m) => /^https?:\/\/(example\.invalid|www\.topografix\.com)\b/.test(m),
  },
  {
    what: "a real person's name",
    // r1-crew-tests.md HIGH: the module comment above promised this check for
    // two review rounds before it existed. NOT a generic "two capitalized
    // words" shape — that would flag half the fixtures' own invented place
    // names ("Rim Road", "Hell's Gate", "Cold Fork Aid"). Instead: a small,
    // explicit list of real full names — the actual person this repo is
    // built for (the one name that matters most, since it is the one a
    // careless copy-paste from a real snapshot would actually carry), plus a
    // handful of ordinary real names representative of the "shape" a real
    // crew contact or coach note might carry in verbatim. Matched
    // case-insensitively, whole-word, so a fixture's own invented names never
    // collide with it.
    re: new RegExp(
      `\\b(${[
        "Aaron Brooks",
        "John Smith", "Sarah Johnson", "Michael Chen", "Emily Davis",
        "David Martinez", "Jennifer Wilson", "Robert Garcia", "Lisa Anderson",
      ].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
      "gi",
    ),
    allow: () => false,
  },
];

/**
 * A real-world lat/lon inside a region with actual personal significance —
 * as opposed to the fixture courses' own real-world-SHAPED but INVENTED
 * mountain ranges (races/_fixtures, e.g. mm-like-100's course.gpx), which
 * are deliberately not flagged here. Narrow on purpose: this targets the
 * specific place that actually leaked (r1-crew-tests.md — a fixed
 * `start_latlng` equal to the athlete's real home city), not "any city
 * anywhere", which the invented-range fixtures would trip on by accident.
 */
const REAL_REGIONS = [
  { name: "Albuquerque, NM", latMin: 34.9, latMax: 35.3, lonMin: -106.9, lonMax: -106.4 },
];

/** Null Island (0°, 0° — open ocean, nowhere near a trail) is what
    web/tests/fixtures/snapshots.mjs's synthetic `start_latlng` sits near; a
    shared reference so a future fixture author has an obviously-safe value
    to reach for instead of a plausible-looking real one. */
export const NULL_ISLAND_LATLNG = [0, 0];

/** Two numbers that LOOK like a [lat, lon] pair, in either shape a fixture
    carries one: a JSON array (`"start_latlng": [35.11, -106.62]`) or a GPX
    attribute pair (`lat="38.2" lon="-107.4"`). */
const COORD_PATTERNS = [
  /\[\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*\]/g,
  /\blat="(-?\d{1,3}(?:\.\d+)?)"\s+lon="(-?\d{1,3}(?:\.\d+)?)"/g,
];

/** Every coordinate-shaped number pair in `text` that falls inside a region
    in REAL_REGIONS, as human-readable problem strings prefixed with `rel`. */
function coordinateProblems(rel, text) {
  const problems = [];
  for (const pattern of COORD_PATTERNS) {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const lat = Number(m[1]);
      const lon = Number(m[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue; // not a plausible lat/lon at all
      for (const region of REAL_REGIONS) {
        if (lat >= region.latMin && lat <= region.latMax && lon >= region.lonMin && lon <= region.lonMax) {
          problems.push(`${rel}: a coordinate inside ${region.name} — [${lat}, ${lon}]`);
        }
      }
    }
  }
  return problems;
}

/** Every problem `text` has, under both FORBIDDEN and the coordinate check —
    the one function both tests below share, so they can never drift apart. */
function personalDataProblems(rel, text) {
  const problems = [];
  for (const { what, re, allow } of FORBIDDEN) {
    for (const m of text.match(new RegExp(re.source, re.flags)) ?? []) {
      if (!allow(m)) problems.push(`${rel}: ${what} — ${JSON.stringify(m)}`);
    }
  }
  problems.push(...coordinateProblems(rel, text));
  return problems;
}

test("no committed UI fixture contains anything that looks like personal data", async () => {
  const problems = [];
  for (const { rel, text } of await fixtureFiles()) problems.push(...personalDataProblems(rel, text));
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});

test("the generated snapshots contain nothing that looks like personal data either", async () => {
  // The dashboard snapshots are built at launch time, not committed, so the
  // grep above never sees them — this runs the generator and greps the output.
  const { buildSnapshots, buildGenericPlan } = await import(
    path.join(ROOT, "web", "tests", "fixtures", "snapshots.mjs")
  );
  const text = JSON.stringify({ ...buildSnapshots(new Date()), plan: buildGenericPlan(new Date()) });
  const problems = personalDataProblems("generated snapshots", text);
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});

/* --------------------------------------------------------------------- */
/*  Proof the checks actually bite — r1-crew-tests.md HIGH: the header    */
/*  promised name/coordinate coverage for two review rounds before either */
/*  existed. These plant a deliberately real value in an IN-MEMORY string */
/*  (never a committed fixture) and assert the checker flags it, so a     */
/*  future edit that quietly guts either check fails loudly here rather   */
/*  than by omission.                                                     */
/* --------------------------------------------------------------------- */

test("the name check bites on a real name planted in fixture-shaped text", () => {
  const clean = `{"crew_info": {"driving": "forest roads, high clearance"}}`;
  assert.deepEqual(personalDataProblems("planted", clean), []);

  const planted = `{"crew_info": {"driving": "ask for Sarah Johnson at the gate"}}`;
  const problems = personalDataProblems("planted", planted);
  assert.ok(
    problems.some((p) => p.includes("a real person's name") && p.includes("Sarah Johnson")),
    `expected a name-check hit, got: ${JSON.stringify(problems)}`,
  );
});

test("the name check is whole-word and does not flag the fixtures' own invented place names", () => {
  const placeNames = `{"aid_stations": ["Rim Road", "Hell's Gate", "Cold Fork Aid", "Quartz Bench Aid", "Dust Devil 25K"]}`;
  assert.deepEqual(personalDataProblems("places", placeNames), []);
});

test("the coordinate check bites on a real coordinate inside the denylisted region", () => {
  // The athlete's actual home city, exactly the shape r1-crew-tests.md found
  // hardcoded in snapshots.mjs before it was fixed.
  const planted = `{"start_latlng": [35.11, -106.62]}`;
  const problems = coordinateProblems("planted", planted);
  assert.ok(
    problems.some((p) => p.includes("Albuquerque")),
    `expected a coordinate-check hit, got: ${JSON.stringify(problems)}`,
  );

  // The GPX attribute shape, same region.
  const gpx = `<wpt lat="35.05" lon="-106.55"><name>Trailhead</name></wpt>`;
  assert.ok(coordinateProblems("planted", gpx).some((p) => p.includes("Albuquerque")));
});

test("the coordinate check does not flag the fixture courses' own invented mountain ranges", () => {
  // races/_fixtures/mm-like-100/course.gpx's actual range — real-world
  // SHAPED, deliberately not the athlete's real training grounds. The check
  // must stay narrow to REAL_REGIONS or every fixture course would trip it.
  const invented = `{"aid_stations": [{"lat": 38.2, "lon": -107.4}, {"lat": 38.53, "lon": -107.3}]}`;
  assert.deepEqual(coordinateProblems("invented", invented), []);
});

test("web/tests/fixtures/snapshots.mjs's own start_latlng is near Null Island, not a real one", async () => {
  const { buildSnapshots } = await import(path.join(ROOT, "web", "tests", "fixtures", "snapshots.mjs"));
  const runs = buildSnapshots(new Date())["strava.json"].activities.filter((a) => a.start_latlng);
  assert.ok(runs.length > 0, "expected at least one synthetic run carrying start_latlng");
  for (const run of runs) {
    const [lat, lon] = run.start_latlng;
    assert.ok(
      Math.abs(lat - NULL_ISLAND_LATLNG[0]) < 1 && Math.abs(lon - NULL_ISLAND_LATLNG[1]) < 1,
      `start_latlng ${JSON.stringify(run.start_latlng)} is not near Null Island`,
    );
  }
});

test("every fixture race.json is a valid race.json", async () => {
  const slugs = (await fs.readdir(FIXTURE_RACES, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(slugs.length >= 3, `expected the fixture races to still be there, found ${slugs.join(", ") || "none"}`);
  for (const slug of slugs) {
    const race = JSON.parse(await fs.readFile(path.join(FIXTURE_RACES, slug, "race.json"), "utf8"));
    // A draft is judged by draft rules: its holes are the point (the review
    // dialog's whole job), and they are legal as long as race.json admits to
    // them in `unresolved`. Anything else has to pass the full schema.
    const errors = race.status === "draft"
      ? draftValidationErrors(race, race.unresolved ?? []).errors
      : validateRaceJson(race).errors;
    assert.deepEqual(errors, [], `races/_fixtures/${slug}/race.json: ${errors.join("; ")}`);
    assert.equal(race.slug, slug, `races/_fixtures/${slug}/race.json declares slug ${race.slug}`);
  }
});

test("exactly one fixture race is active, as the schema requires", async () => {
  const slugs = (await fs.readdir(FIXTURE_RACES, { withFileTypes: true }))
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const active = [];
  for (const slug of slugs) {
    const race = JSON.parse(await fs.readFile(path.join(FIXTURE_RACES, slug, "race.json"), "utf8"));
    if (race.status === "active") active.push(slug);
  }
  assert.deepEqual(active, ["mm-like-100"], "the fixture tree must have exactly one active race");
});

test("_fixtures is not a race folder the app can ever load", () => {
  // listRaces skips underscore-prefixed folders; this is the reminder that the
  // fixture tree is data for the tests, never a race in the app's own races/.
  assert.equal(path.basename(FIXTURE_RACES).startsWith("_"), true);
  // …and the tests read fixtures out of the checkout, not out of whatever
  // TRAIL_PROJECT_ROOT happens to be pointing at.
  assert.equal(ROOT, projectRoot());
});
