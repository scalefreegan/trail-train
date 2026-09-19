// node --test scripts/race-build.test.mjs   (or: cd web && npm test)
//
// Stage 2 end to end, on temp-dir race folders only — nothing here writes into
// races/ and nothing reaches the network. Two fixtures:
//
//   · a synthetic race whose GPX is written by this file (3 waypoints + a short
//     track): one station the matcher resolves by fuzzy name, one it resolves
//     outright, one it can only guess at, and a finish line no GPX marks.
//   · the committed MM100 folder, copied into a temp root: a hand-mapped race
//     must come out of buildRace byte-identical — the matcher confirming the
//     authored waypoints, not rewriting them.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRace } from "./race-build.mjs";
import { buildCourse } from "./build-course.mjs";
import { LOW_CONFIDENCE } from "./aid-match.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MM100 = "mogollon-monster-100-2026";

/* --------------------------- synthetic course --------------------------- */

// A due-north track, 0.1 mi per point, ~29.9 mi long — the same shape
// aid-match.test.mjs uses, plus elevation so the profile builder has a series.
const LAT0 = 34.0;
const LON0 = -111.0;
const DEG_PER_TENTH_MI = 0.1 / 69.09;
const TRACK_PTS = 300;

/** Track point index → lat/lon. Index i sits at ≈ i/10 miles. */
const trackPoint = (i) => ({ lat: LAT0 + i * DEG_PER_TENTH_MI, lon: LON0 });

/**
 * Serialize the synthetic course to GPX text, in the element shape both
 * parsers read (aid-match's and build-course's stricter one).
 * @param {{name: string, mi: number}[]} wpts
 */
function makeGpx(wpts) {
  const w = wpts
    .map(({ name, mi }) => {
      const p = trackPoint(Math.round(mi * 10));
      return `<wpt lat="${p.lat}" lon="${p.lon}"><name>${name}</name></wpt>`;
    })
    .join("\n");
  const trk = Array.from({ length: TRACK_PTS }, (_, i) => {
    const p = trackPoint(i);
    // A gentle ramp with one bump — enough for a real elevation series, not
    // enough to trip detectClimbs' 300 ft / 3% bar into inventing a climb.
    const ele = 2000 + i * 0.4 + Math.sin(i / 20) * 3;
    return `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>${ele.toFixed(1)}</ele></trkpt>`;
  }).join("\n");
  return `<?xml version="1.0"?>\n<gpx version="1.1">\n${w}\n<trk><name>t</name><trkseg>\n${trk}\n</trkseg></trk>\n</gpx>`;
}

/** A draft race.json for the synthetic course: every station's gpx_wpt unknown. */
function draftRace(slug) {
  return {
    schema_version: 1,
    slug,
    status: "draft",
    name: "Cinder Cone 50K",
    short: "CC50K",
    edition_year: 2027,
    date: "2027-06-12",
    start_time: "06:00",
    timezone: "America/Denver",
    distance_mi: 30,
    gain_ft: 1200,
    cutoff_h: 12,
    // null on purpose: the sun step has to be the thing that fills this.
    sun: null,
    aid_stations: [
      // "Cross Mountain" ↔ "Cross Mtn TH": the abbreviation case the bead names.
      { name: "Cross Mountain", gpx_wpt: null, total_mi: 5, seg_mi: 5, seg_gain_ft: 200, cutoff_h: null,
        crew: true, crew_only: false, drop_bag: false, pacers: false, water_only: false },
      { name: "Bear Creek", gpx_wpt: null, total_mi: 15, seg_mi: 10, seg_gain_ft: 400, cutoff_h: null,
        crew: true, crew_only: false, drop_bag: true, pacers: false, water_only: false },
      // No waypoint is anywhere near this one, by name or by mile.
      { name: "Ghost Meadow", gpx_wpt: null, total_mi: 25, seg_mi: 10, seg_gain_ft: 400, cutoff_h: null,
        crew: false, crew_only: false, drop_bag: false, pacers: false, water_only: false },
      { name: "Finish", gpx_wpt: null, total_mi: 29.9, seg_mi: 4.9, seg_gain_ft: 200, cutoff_h: null,
        crew: true, crew_only: false, drop_bag: false, pacers: false, water_only: false },
    ],
    race_climbs: [],
    links: {},
    provenance: { aid_stations: { by: "agent", at: "2026-09-18T00:00:00Z", source: "test fixture" } },
  };
}

const WAYPOINTS = [
  { name: "Cross Mtn TH", mi: 5 },
  { name: "Summit", mi: 9.5 },
  { name: "Bear Creek Aid", mi: 15 },
];

const tmpRoots = [];

/**
 * A temp repo root holding races/<slug>/race.json (+ course.gpx unless
 * `withGpx` is false). Each test gets its own, so one run cannot see another's
 * write-backs.
 */
async function makeRoot(slug, { withGpx = true, race = draftRace(slug) } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-race-build-"));
  tmpRoots.push(root);
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(race, null, 2));
  if (withGpx) await fs.writeFile(path.join(dir, "course.gpx"), makeGpx(WAYPOINTS));
  return { root, dir };
}

const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));
const exists = async (p) => !!(await fs.stat(p).catch(() => null));

after(async () => {
  for (const root of tmpRoots) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
});

/* ------------------------------ the matcher ------------------------------ */

const SLUG = "cinder-cone-50k-2027";
const base = await makeRoot(SLUG);
const result = await buildRace({ root: base.root, slug: SLUG });
const raceAfter = await readJson(path.join(base.dir, "race.json"));

test("a confident match is written back with provenance by: matcher", () => {
  assert.equal(raceAfter.aid_stations[0].gpx_wpt, "Cross Mtn TH");
  assert.equal(raceAfter.aid_stations[1].gpx_wpt, "Bear Creek Aid");

  const p = raceAfter.provenance["aid_stations[0].gpx_wpt"];
  assert.equal(p.by, "matcher");
  assert.equal(p.method, "fuzzy");
  assert.ok(p.confidence >= LOW_CONFIDENCE, `confidence ${p.confidence} should clear the bar`);
  assert.ok(!Number.isNaN(Date.parse(p.at)), `provenance.at should be an ISO timestamp, got ${p.at}`);

  // The returned rows say which ones the run committed.
  const written = result.matched.filter((m) => m.written).map((m) => m.name);
  assert.deepEqual(written, ["Cross Mountain", "Bear Creek"]);
});

test("the agent's own provenance is left exactly as it was", () => {
  assert.deepEqual(raceAfter.provenance.aid_stations, {
    by: "agent", at: "2026-09-18T00:00:00Z", source: "test fixture",
  });
});

test("a station below LOW_CONFIDENCE goes unresolved and is NOT written", () => {
  assert.equal(raceAfter.aid_stations[2].gpx_wpt, null);
  assert.equal(raceAfter.provenance["aid_stations[2].gpx_wpt"], undefined);
  assert.ok(result.unresolved.includes("aid_stations[2].gpx_wpt"), result.unresolved.join(", "));
  assert.ok(
    result.warnings.some((w) => w.startsWith("Ghost Meadow")),
    result.warnings.join(" | ")
  );
});

test("the finish line needs no waypoint and is not reported unresolved", () => {
  assert.equal(raceAfter.aid_stations[3].gpx_wpt, null);
  assert.equal(result.matched.at(-1).method, "finish");
  assert.ok(!result.unresolved.includes("aid_stations[3].gpx_wpt"), result.unresolved.join(", "));
});

test("resolved stations are removed from the draft's unresolved list", () => {
  assert.ok(!result.unresolved.includes("aid_stations[0].gpx_wpt"));
  assert.ok(!result.unresolved.includes("aid_stations[1].gpx_wpt"));
  assert.ok(!result.unresolved.includes("sun"));
});

/* -------------------------------- outputs -------------------------------- */

test("the course build writes build/course.json", async () => {
  const course = await readJson(path.join(base.dir, "build", "course.json"));
  assert.equal(course.race, SLUG);
  assert.equal(course.aid_stations.length, 4);
  assert.ok(course.profile.length > 100, `profile had ${course.profile.length} points`);
  // Every station lands on the track, in order — including the guessed one,
  // which build-course snaps to its charted mile rather than dropping.
  for (let i = 1; i < course.aid_stations.length; i++) {
    assert.ok(course.aid_stations[i].gpx_mi >= course.aid_stations[i - 1].gpx_mi);
  }
  assert.equal(result.course.aid_stations, 4);
});

test("sun is computed from the start point and stamped by: computed", async () => {
  assert.match(raceAfter.sun.sunrise, /^\d{2}:\d{2}$/);
  assert.match(raceAfter.sun.sunset, /^\d{2}:\d{2}$/);
  assert.equal(raceAfter.provenance.sun.by, "computed");
  assert.equal(raceAfter.provenance.sun.source, "scripts/race-sun.mjs");
  // course.json carries the computed value, not a null it was built before.
  const course = await readJson(path.join(base.dir, "build", "course.json"));
  assert.deepEqual(course.sun, raceAfter.sun);
});

test("a second run changes nothing but the build timestamp", async () => {
  const racePath = path.join(base.dir, "race.json");
  const coursePath = path.join(base.dir, "build", "course.json");
  const raceBefore = await fs.readFile(racePath, "utf8");
  const courseBefore = await readJson(coursePath);

  const again = await buildRace({ root: base.root, slug: SLUG });

  assert.equal(await fs.readFile(racePath, "utf8"), raceBefore, "race.json must be byte-identical");
  assert.deepEqual(again.unresolved, result.unresolved);
  const courseAfter = await readJson(coursePath);
  assert.notEqual(courseAfter.generated_at, undefined);
  assert.deepEqual(
    { ...courseAfter, generated_at: null },
    { ...courseBefore, generated_at: null },
    "course.json must differ only in generated_at"
  );
  // The matcher still confirms the same stations — now as exact, not fuzzy.
  assert.equal(again.matched[0].method, "exact");
  assert.equal(again.matched.filter((m) => m.written).length, 0);
});

/* ------------------------------- no GPX --------------------------------- */

test("no course.gpx and no links.gpx: unresolved, not a failure", async () => {
  const slug = "no-gpx-50k-2027";
  const { root, dir } = await makeRoot(slug, { withGpx: false, race: draftRace(slug) });
  const r = await buildRace({ root, slug });

  assert.ok(r.unresolved.includes("course.gpx"), r.unresolved.join(", "));
  assert.equal(r.course, null);
  assert.deepEqual(r.matched, []);
  assert.ok(r.warnings.some((w) => /no course\.gpx/.test(w)), r.warnings.join(" | "));
  assert.equal(await exists(path.join(dir, "build")), false, "nothing should be built without a GPX");
  // race.json is untouched: no waypoint was decided, so nothing to record.
  const race = await readJson(path.join(dir, "race.json"));
  assert.equal(race.sun, null);
});

test("a non-http links.gpx is not fetched", async () => {
  const slug = "local-link-50k-2027";
  const race = { ...draftRace(slug), links: { gpx: "/Users/someone/Downloads/course.gpx" } };
  const { root } = await makeRoot(slug, { withGpx: false, race });
  const r = await buildRace({ root, slug });
  assert.ok(r.unresolved.includes("course.gpx"), r.unresolved.join(", "));
  assert.equal(r.course, null);
});

/* ------------------------------ MM100 ----------------------------------- */

test("the archived MM100 folder rebuilds to a byte-identical race.json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-race-build-mm100-"));
  tmpRoots.push(root);
  const dir = path.join(root, "races", MM100);
  await fs.mkdir(dir, { recursive: true });
  const src = path.join(ROOT, "races", MM100);
  for (const f of ["race.json", "course.gpx"]) {
    await fs.copyFile(path.join(src, f), path.join(dir, f));
  }
  const before = await fs.readFile(path.join(dir, "race.json"), "utf8");
  const committed = JSON.parse(before);

  const r = await buildRace({ root, slug: MM100 });

  // Every hand-authored waypoint is confirmed, none rewritten, none unresolved.
  assert.deepEqual(
    r.matched.map((m) => m.gpx_wpt),
    committed.aid_stations.map((s) => s.gpx_wpt ?? null)
  );
  assert.equal(r.matched.filter((m) => m.written).length, 0);
  assert.deepEqual(r.unresolved, []);
  assert.equal(
    await fs.readFile(path.join(dir, "race.json"), "utf8"),
    before,
    "a hand-mapped race must survive stage 2 untouched"
  );
  // And the build still produced the course the Race views read.
  assert.equal(r.course.aid_stations, committed.aid_stations.length);
  assert.ok(await exists(path.join(dir, "build", "course.json")));
});

test("MM100's stations resolve from names alone, gpx_wpt stripped", async () => {
  // The acceptance bar from the bead: ≥ 13 of 15 by name, no authored hints.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-race-build-mm100-bare-"));
  tmpRoots.push(root);
  const dir = path.join(root, "races", MM100);
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(path.join(ROOT, "races", MM100, "course.gpx"), path.join(dir, "course.gpx"));
  const committed = await readJson(path.join(ROOT, "races", MM100, "race.json"));
  const stripped = {
    ...committed,
    aid_stations: committed.aid_stations.map((s) => ({ ...s, gpx_wpt: null })),
  };
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(stripped, null, 2));

  const r = await buildRace({ root, slug: MM100 });
  const rebuilt = await readJson(path.join(dir, "race.json"));
  const hits = committed.aid_stations.filter(
    (s, i) => s.gpx_wpt && rebuilt.aid_stations[i].gpx_wpt === s.gpx_wpt
  ).length;
  const authored = committed.aid_stations.filter((s) => s.gpx_wpt).length;
  assert.ok(hits >= 13, `matched ${hits}/${authored} hand-authored waypoints by name: ${r.unresolved.join(", ")}`);
  // Everything it did write, it stamped.
  for (const m of r.matched.filter((x) => x.written)) {
    assert.equal(rebuilt.provenance[`aid_stations[${m.index}].gpx_wpt`].by, "matcher");
  }
});

/* ------------------------ distance/gain sanity guard ---------------------- */

test("a GPX far shorter than race.json's distance_mi is flagged structurally, not just an SSE line", async () => {
  const slug = "truncated-gpx-2027";
  const race = draftRace(slug);
  // 17% off — enough to clear MISMATCH_THRESHOLD without the scale distortion
  // large enough to also perturb aid-station snap ordering (a separate,
  // legitimate build-course.mjs guard this test is not about).
  race.distance_mi = 36;
  const { root } = await makeRoot(slug, { race });

  const r = await buildRace({ root, slug });
  assert.ok(r.unresolved.includes("course.gpx"), r.unresolved.join(", "));
  assert.ok(
    r.warnings.some((w) => /course\.gpx measures 29\.9 mi vs race\.json's 36 mi/.test(w)),
    r.warnings.join(" | "),
  );
});

test("a GPX within normal drift of race.json's distance_mi (and gain) raises nothing", async () => {
  const slug = "normal-drift-2027";
  const race = draftRace(slug);
  // The synthetic profile's own measured gain (~399 ft) is unrelated to the
  // fixture's default gain_ft (1200, itself >15% off) — pinned to the real
  // measured value here so this test isolates the DISTANCE comparison.
  race.gain_ft = 399;
  const { root } = await makeRoot(slug, { race }); // distance_mi (30) vs the ~29.9 mi track
  const r = await buildRace({ root, slug });
  assert.ok(!r.unresolved.includes("course.gpx"), r.unresolved.join(", "));
  assert.ok(!r.warnings.some((w) => /GPX may be truncated or the wrong file/.test(w)), r.warnings.join(" | "));
});

test("the fixture's own default gain_ft (1200) is far enough off to be flagged on its own", async () => {
  // Documents the pre-existing fixture property the test above works around:
  // draftRace()'s gain_ft was never calibrated to the synthetic profile's
  // measured gain, so unmodified it already trips the gain half of the guard.
  const slug = "default-gain-mismatch-2027";
  const { root } = await makeRoot(slug);
  const r = await buildRace({ root, slug });
  assert.ok(r.unresolved.includes("course.gpx"), r.unresolved.join(", "));
  assert.ok(r.warnings.some((w) => /ft of gain vs race\.json's 1,200 ft/.test(w)), r.warnings.join(" | "));
});

test("an unresolved (null) distance_mi fails the course build with an actionable error, not Infinity/NaN", async () => {
  const slug = "null-distance-2027";
  const race = draftRace(slug);
  race.distance_mi = null;
  const { root } = await makeRoot(slug, { race });
  await assert.rejects(buildRace({ root, slug }), /distance_mi is not a positive number/);
});

/* ------------------------------ race_climbs -------------------------------- */

test("validateRaceJson now refuses a reversed race_climbs approx_mi window outright — buildRace never reaches build-course.mjs with one", async () => {
  const slug = "reversed-climb-2027";
  const race = draftRace(slug);
  race.status = "active"; // draft or active, validateRaceJson checks this shape either way
  race.race_climbs = [{ id: "bad", label: "Backwards Climb", approx_mi: [15, 10] }];
  const { root } = await makeRoot(slug, { race });
  await assert.rejects(buildRace({ root, slug }), /race_climbs\[0\]\.approx_mi.*required \(got \[15,10\]\)/s);
});

test("build-course.mjs's own guard drops a reversed race_climbs window when called directly (the CLI's path, which validates nothing itself)", async () => {
  // buildRace (race-build.mjs) now refuses this race.json before build-course
  // ever sees it (previous test) — but `node scripts/build-course.mjs --race
  // <slug>` calls buildCourse directly with no schema validation of its own,
  // so this defensive guard is what protects THAT path, not a redundant one.
  const slug = "reversed-climb-direct-2027";
  const race = draftRace(slug);
  race.race_climbs = [{ id: "bad", label: "Backwards Climb", approx_mi: [15, 10] }];
  const { root, dir } = await makeRoot(slug, { race });

  const warnings = [];
  const course = await buildCourse(root, slug, { warn: (m) => warnings.push(m) });
  assert.equal(course.race_climbs, 0, "the malformed climb must not appear in course.json at all");
  assert.ok(warnings.some((w) => /Backwards Climb.*not an ascending window/.test(w)), warnings.join(" | "));
  const written = await readJson(path.join(dir, "build", "course.json"));
  assert.deepEqual(written.race_climbs, []);
});
