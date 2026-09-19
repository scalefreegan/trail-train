// The static crew export (PRD v2 §5, bead tt-cv1b0.7).
//
// What is worth pinning down here is the SELF-CONTAINMENT, because nothing
// else will notice it break: the file is opened once, on a phone, in a canyon,
// by someone who cannot debug it. So the assertions below are about what the
// exported HTML POINTS AT (nothing) rather than about how it looks.
//
// Everything runs against a synthetic race folder in a temp directory — a
// small course, a dozen fake runs — so the test needs no race folder, no
// Strava snapshot and no network. The one real artifact it uses is the built
// shell (web/dist-crew/crew.html), which ensureShell() builds on demand; that
// is deliberate, since a shell that stops being one file is exactly the
// regression this test exists to catch.
//
// The client render path is exercised by importing web/src/crew/render.ts
// directly, type-stripped (node >= 22.18), the same way features.test.mjs
// imports features.ts. Opening the file in a real headless browser with the
// network cut belongs to the Playwright suite (PRD v2 §7), which owns a DOM.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAX_EXPORT_BYTES,
  buildCrewData,
  crewExport,
  crewPickups,
  ensureShell,
  renderCrewHtml,
  sanitizeKnobs,
} from "./crew-export.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SLUG = "fixture-crew-50";
/** Frozen export instant, so filenames and generated_at are assertable. */
const NOW = new Date("2027-06-10T18:30:00Z");

let root;
let shellPath;
let shellHtml;

/* ---------------- synthetic race folder ---------------- */

/** A rolling 30-mile course on the 0.05-mi grid build-course.mjs writes. */
function fixtureCourse() {
  const profile = [];
  for (let i = 0; i <= 600; i++) {
    const mi = +(i * 0.05).toFixed(2);
    const ele = 7000 + 600 * Math.sin(mi / 3);
    const prev = profile.at(-1);
    const grade = prev ? ((ele - prev.ele_ft) / (0.05 * 5280)) * 100 : 0;
    profile.push({ mi, ele_ft: +ele.toFixed(1), grade_pct: +grade.toFixed(2) });
  }
  const station = (name, mi, extra = {}) => ({
    name,
    total_mi: mi,
    gpx_mi: mi,
    seg_mi: null,
    seg_gain_ft: null,
    cutoff_h: null,
    crew: false,
    crew_only: false,
    drop_bag: false,
    pacers: false,
    water_only: false,
    notes: "",
    lat: 34.3 + mi / 100,
    lon: -111.4 - mi / 100,
    ...extra,
  });
  return {
    generated_at: "2027-06-01T00:00:00.000Z",
    source: "fixture",
    distance_mi: 30,
    gain_ft: 5200,
    official_distance_mi: 30,
    official_gain_ft: 5200,
    sun: { sunset: "19:40", sunrise: "05:20" },
    profile,
    aid_stations: [
      station("Rim Road", 8, { cutoff_h: 3.5 }),
      station("Hell's Gate", 15, { crew: true, drop_bag: true, cutoff_h: 7 }),
      station("Water Cache", 22, { water_only: true }),
      station("Finish", 30, { crew: true, cutoff_h: 14 }),
    ],
    race_climbs: [],
    map_track: profile.filter((p, i) => i % 50 === 0).map((p) => [34.3 + p.mi / 100, -111.4 - p.mi / 100]),
    // prose with an HTML-ish trap in it: the export must not let this close
    // the <script id="crew-data"> block early
    crew_info: {
      rules: ["no crew between Rim Road and Hell's Gate </script><b>oops</b>"],
      cell_strategy: "no service past mile 10",
      station_notes: {},
      start_notes: "park below the trailhead",
      driving: "forest roads, high clearance",
    },
    sources: [{ kind: "url", ref: "https://example.invalid/crew-manual" }],
  };
}

function fixtureRace() {
  return {
    schema_version: 1,
    slug: SLUG,
    status: "active",
    name: "Fixture Crew 50",
    short: "FC50",
    date: "2027-06-12",
    start_time: "05:00",
    timezone: "America/Phoenix",
    location: "Payson, AZ",
    distance_mi: 30,
    gain_ft: 5200,
    cutoff_h: 14,
    aid_stations: [],
    links: { site: "https://example.invalid/fc50" },
  };
}

/** Twelve long runs — enough rows for fitPacing's ≥8 floor at its ≥8 mi tier,
    and with SPREAD in both distance and vert-per-mile: the fit solves a 3×3
    normal-equation system and returns null on a singular one, so a fixture
    where every run climbs the same ft/mi silently has no pacing model. */
function fixtureStrava() {
  const activities = [];
  for (let i = 0; i < 12; i++) {
    const miles = 10 + (i % 5) * 2.5;
    const ftPerMi = 60 + (i % 4) * 55;
    activities.push({
      id: `a${i}`,
      sport: "Run",
      date: new Date(Date.UTC(2027, 4, 1 + i * 2)).toISOString(),
      distance_m: miles * 1609.344,
      elevation_m: miles * ftPerMi * 0.3048,
      moving_s: Math.round(miles * (560 + ftPerMi * 0.9 + i * 3)),
      avg_hr: 132 + (i % 3),
    });
  }
  return { fetched_at: "2027-06-01T00:00:00.000Z", window: 180, totals: {}, activities };
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "crew-export-"));
  const raceDir = path.join(root, "races", SLUG);
  await fs.mkdir(path.join(raceDir, "build"), { recursive: true });
  await fs.mkdir(path.join(root, "web", "public"), { recursive: true });
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(raceDir, "race.json"), JSON.stringify(fixtureRace()));
  await fs.writeFile(path.join(raceDir, "build", "course.json"), JSON.stringify(fixtureCourse()));
  await fs.writeFile(
    path.join(raceDir, "build", "crew-base.json"),
    JSON.stringify({
      generated_at: "2027-06-01T00:00:00.000Z",
      base: {
        label: "Crew base",
        address: "1 Fixture Rd, Payson AZ",
        lat: 34.23,
        lon: -111.32,
        drive_to_start_min: 20,
        drive_to_start_mi: 12,
      },
      drives: { "Hell's Gate": { min: 55, mi: 31 }, Finish: { min: 20, mi: 12 } },
      emergency: [{ label: "race HQ", phone: "555-0100" }],
    }),
  );
  await fs.writeFile(path.join(root, "web", "public", "strava.json"), JSON.stringify(fixtureStrava()));
  await fs.writeFile(
    path.join(root, "config", "profile.json"),
    JSON.stringify({
      athlete_name: "Fixture",
      physiology: { body_kg: 70, long_run_ref_mi: 20, home_elevation_ft: 5300 },
    }),
  );

  // The one real artifact: the built single-file shell. Built from the repo,
  // then pinned for the temp-root exports (which have no web/ of their own).
  shellPath = await ensureShell(REPO_ROOT);
  shellHtml = await fs.readFile(shellPath, "utf8");
  process.env.TRAIL_CREW_SHELL = shellPath;
});

after(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});

/* ---------------- what the file points at ---------------- */

/** Every URL the document would actually FETCH: attribute targets and CSS
    url()s, minus data: URIs and in-page fragments. Deliberately not a grep for
    "http" — the embedded JSON legitimately quotes the race's own web address,
    and a grep that cannot tell a link in DATA from a reference in MARKUP would
    either fail on real data or pass on a broken file. */
function fetchTargets(html) {
  return [
    ...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g),
    ...html.matchAll(/url\(\s*["']?([^)"']+?)["']?\s*\)/g),
  ]
    .map((m) => m[1].trim())
    .filter((v) => !v.startsWith("data:") && !v.startsWith("#"));
}

test("the built shell is one self-contained file", async () => {
  assert.deepEqual(fetchTargets(shellHtml), [], "the shell must not reference anything outside itself");
  assert.equal(/https?:\/\//.test(shellHtml), false, "the shell itself carries no URLs at all");
  assert.match(shellHtml, /<style>/, "the CSS is inlined");
  assert.match(shellHtml, /<script type="module">/, "the JS is inlined");
  assert.match(shellHtml, /id="crew-data"/, "the data block is there to inject into");
  const dir = await fs.readdir(path.dirname(shellPath));
  assert.deepEqual(dir, ["crew.html"], "the build directory holds exactly one file");
});

test("the export points at nothing, and every http(s) string in it is DATA", async () => {
  const { html, bytes, filename, outPath } = await crewExport(root, SLUG, { now: NOW });

  assert.deepEqual(fetchTargets(html), [], "no asset reference, absolute or relative, survives the export");
  assert.ok(bytes < MAX_EXPORT_BYTES, `export is ${bytes} bytes, over the ${MAX_EXPORT_BYTES} budget`);

  // The race's own links ARE in the file — inside the JSON block, as text.
  const block = /<script\b[^>]*id="crew-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(block, "the data block survived");
  const outsideData = html.slice(0, block.index) + html.slice(block.index + block[0].length);
  assert.equal(/https?:\/\//.test(outsideData), false, "no http(s) URL outside the embedded data");

  // Written where the bead says, named for the RACE-local export day.
  assert.equal(filename, "crew-2027-06-10.html");
  assert.equal(outPath, path.join(root, "races", SLUG, "build", filename));
  assert.equal((await fs.stat(outPath)).size, bytes);
});

test("prose containing </script> cannot close the data block", async () => {
  const { html } = await crewExport(root, SLUG, { now: NOW, write: false });
  const blocks = html.match(/<script\b/g) ?? [];
  // exactly two: the inlined module and the data block
  assert.equal(blocks.length, 2, "a third <script> means the trap prose escaped the block");
  const block = /<script\b[^>]*id="crew-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  const data = JSON.parse(block[1]);
  assert.match(data.course.crew_info.rules[0], /<\/script>/, "the prose survived intact as data");
  assert.equal(block[1].includes("</script>"), false, "…but not as literal markup");
});

test("renderCrewHtml refuses a shell with no data block", () => {
  assert.throws(
    () => renderCrewHtml("<html><body>nothing here</body></html>", { schema_version: 1 }),
    /crew-data/,
  );
});

/* ---------------- what the file SAYS ---------------- */

test("the payload carries the projection, its inputs, and the crew's own data", async () => {
  const data = await buildCrewData(root, SLUG, { now: NOW });

  assert.equal(data.schema_version, 1);
  assert.equal(data.slug, SLUG);
  assert.equal(data.generated_at, NOW.toISOString());

  // the inputs a local re-projection needs
  assert.ok(data.course.profile.length > 100, "the course profile rides along");
  assert.ok(Number.isFinite(data.fit.base), "the fitted pace model rides along");
  assert.equal(data.knobs.fatiguePctPer10mi, 5, "planner defaults when no knobs are given");
  assert.equal(data.knobs.goalH, 12, "goal defaults to 85% of the 14 h cutoff, to the nearest half hour");
  assert.deepEqual(
    data.knobs.altitude,
    { pct: 100, homeElevationFt: 5300, acclimationDays: 0 },
    "the altitude term is resolved from the athlete's own acclimated elevation",
  );

  // the evaluated projection
  assert.equal(data.projection.stations.length, 4);
  const hg = data.projection.stations[1];
  assert.equal(hg.name, "Hell's Gate");
  assert.ok(hg.eta_h.best < hg.eta_h.avg && hg.eta_h.avg < hg.eta_h.worst, "the three scenarios order");
  assert.match(hg.clock.avg, /^\d{1,2}:\d{2}[ap]/, "ETAs are pre-formatted on the race's wall clock");
  assert.equal(hg.cutoff_h, 7);
  assert.match(hg.cutoff_clock, /^\d{1,2}:\d{2}[ap]/);
  assert.equal(hg.stop_min > 0, true, "a crew stop gets the crew dwell");

  // the crew's own half
  assert.equal(data.crew_base.emergency.length, 1, "emergency numbers are embedded — that is the point");
  assert.equal(data.crew_base.drives["Hell's Gate"].min, 55);
  assert.deepEqual(
    data.crew_pickups.map((p) => p.station),
    ["Hell's Gate", "Finish"],
    "one pickup per crew-access station, in course order",
  );
  assert.ok(data.fuel.segments.length > 0, "the fuel plan is computed at export time");
  assert.ok(data.crew_pickups[0].segment, "the crew stop carries the leg she leaves on");
  assert.equal(data.crew_pickups[0].clock, hg.clock.avg, "the pickup agrees with the station row");
});

test("live knobs beat the defaults, and junk in the body is dropped", async () => {
  const data = await buildCrewData(root, SLUG, {
    now: NOW,
    knobs: {
      fatiguePctPer10mi: 9,
      goalH: 9.5,
      crewStopMin: 20,
      stopOverridesMin: { "Hell's Gate": 25, "Bad Station": "twenty" },
      // not a knob — must not reach projectRace
      __proto__: { polluted: true },
      residStd: 999,
    },
  });
  assert.equal(data.knobs.fatiguePctPer10mi, 9);
  assert.equal(data.knobs.goalH, 9.5);
  assert.equal(data.knobs.crewStopMin, 20);
  assert.deepEqual(data.knobs.stopOverridesMin, { "Hell's Gate": 25 }, "a non-numeric override is dropped");
  assert.equal(data.knobs.residStd, undefined, "unknown keys never reach the model");
  assert.equal(data.projection.stations[1].stop_min, 25, "the override is taken literally");

  const slower = data.projection.stations.at(-1).eta_h.avg;
  const base = (await buildCrewData(root, SLUG, { now: NOW })).projection.stations.at(-1).eta_h.avg;
  assert.ok(slower > base, "more fatigue and a longer crew stop must finish later");
});

test("sanitizeKnobs keeps only finite, recognised knobs", () => {
  assert.deepEqual(sanitizeKnobs(null), {});
  assert.deepEqual(sanitizeKnobs("nope"), {});
  assert.deepEqual(sanitizeKnobs({ fatiguePctPer10mi: NaN, calibrationPct: 4 }), { calibrationPct: 4 });
  assert.deepEqual(sanitizeKnobs({ goalH: null }), { goalH: null }, "null goal = no goal, a real setting");
  assert.deepEqual(sanitizeKnobs({ stopOverridesMin: { A: -1, B: 3 } }).stopOverridesMin, { B: 3 });
  assert.deepEqual(sanitizeKnobs({ altitude: null }), { altitude: null }, "no term is a real setting");
  assert.deepEqual(
    sanitizeKnobs({ altitude: { pct: 80, homeElevationFt: "high", acclimationDays: -3 } }).altitude,
    { pct: 80, homeElevationFt: null, acclimationDays: 0 },
    "a non-numeric home elevation means 'nobody set one', not a crash",
  );
  assert.equal(sanitizeKnobs({ altitude: { homeElevationFt: 5000 } }).altitude, undefined,
    "an altitude block with no knob in it is not a setting");
});

test("crewPickups pairs a crew station with the leg departing it", () => {
  const stations = [
    { name: "A", total_mi: 5, crew: false, crew_only: false, eta_h: { avg: 1 }, clock: { avg: "6:00a" } },
    { name: "B", total_mi: 15, crew: true, crew_only: false, eta_h: { avg: 3 }, clock: { avg: "8:00a" } },
    { name: "C", total_mi: 25, crew: false, crew_only: true, eta_h: { avg: 5 }, clock: { avg: "10:00a" } },
  ];
  const fuel = {
    segments: [{ from: "B", to: "C", gels: 4 }],
    drop_bags: [{ station: "C", gels: 2 }],
  };
  const out = crewPickups(stations, fuel);
  assert.deepEqual(out.map((p) => p.station), ["B", "C"]);
  assert.equal(out[0].segment.gels, 4);
  assert.equal(out[0].drop_bag, null);
  assert.equal(out[1].segment, null, "no leg departs the last crew stop in this plan");
  assert.equal(out[1].drop_bag.gels, 2);
  assert.deepEqual(crewPickups(stations, null), out.map((p) => ({ ...p, segment: null, drop_bag: null })),
    "no fuel plan is not an error — the stops are still crew stops");
});

/* ---------------- what the page renders ---------------- */

test("the page's own renderer turns the payload into station rows", async () => {
  const data = await buildCrewData(root, SLUG, { now: NOW });
  const { projectRace } = await import("../web/src/race/pacing.ts");
  const { projectOptions } = await import("../web/src/crew/crewData.ts");
  const { renderCrewPage, stationRows } = await import("../web/src/crew/render.ts");

  // exactly what src/crew/main.ts does on load — through the SAME mapping, so
  // a knob that stops being threaded fails here rather than in a canyon
  const live = projectRace(data.course, data.fit, projectOptions(data));

  const rows = stationRows(data, live);
  assert.equal(rows.length, 4);
  // The exporter and the page ran the same model over the same inputs, so the
  // sheet a crew opens must agree with the sheet that was exported.
  assert.deepEqual(
    rows.map((r) => r.clock.avg),
    data.projection.stations.map((r) => r.clock.avg),
    "a local re-projection reproduces the exported ETAs exactly",
  );

  const html = renderCrewPage(data, live);
  assert.equal((html.match(/<tr /g) ?? []).length, 4, "one row per station");
  assert.match(html, /data-station="Hell&#x27;s Gate"|data-station="Hell's Gate"/);
  assert.match(html, /Fixture Crew 50/);
  assert.match(html, /class="[^"]*crew[^"]*"[^>]*data-station="Hell/, "crew stops are marked");

  // the fallback path: no live projection still renders the exported times
  const frozen = renderCrewPage(data, null);
  assert.equal((frozen.match(/<tr /g) ?? []).length, 4);
});

test("renderCrewPage escapes prose rather than trusting it", async () => {
  const { renderCrewPage } = await import("../web/src/crew/render.ts");
  const data = await buildCrewData(root, SLUG, { now: NOW });
  data.race.name = 'Fix<img src=x onerror="boom">ture';
  const html = renderCrewPage(data, null);
  assert.equal(html.includes("<img"), false, "a tag in race prose must not become a tag");
  assert.match(html, /&lt;img/);
});

test("the altitude term rides along, gated by the race's own feature flag", async () => {
  // A 7,000 ft course above a 5,300 ft home: the term must cost time, and the
  // exported ETAs must be the ones that include it.
  const withAltitude = await buildCrewData(root, SLUG, { now: NOW });
  const without = await buildCrewData(root, SLUG, { now: NOW, knobs: { altitude: null } });
  assert.ok(
    withAltitude.projection.finish_h.avg > without.projection.finish_h.avg,
    "altitude above the athlete's home has to slow the projection down",
  );

  // A race that declares it has no altitude gets no term, whatever the profile
  // says — the same gate the planner applies.
  const flat = path.join(root, "races", "flatland");
  await fs.mkdir(path.join(flat, "build"), { recursive: true });
  await fs.writeFile(
    path.join(flat, "race.json"),
    JSON.stringify({ ...fixtureRace(), slug: "flatland", features: { altitude: false } }),
  );
  await fs.writeFile(path.join(flat, "build", "course.json"), JSON.stringify(fixtureCourse()));
  const gated = await buildCrewData(root, "flatland", { now: NOW });
  assert.equal(gated.knobs.altitude, null, "features.altitude: false means no term at all");
  assert.equal(
    gated.projection.finish_h.avg,
    without.projection.finish_h.avg,
    "…and the same finish the term-less projection gives",
  );
});

/* ---------------- refusals ---------------- */

test("a folder with no built course is refused by name", async () => {
  const bare = path.join(root, "races", "no-course");
  await fs.mkdir(bare, { recursive: true });
  await fs.writeFile(path.join(bare, "race.json"), JSON.stringify({ ...fixtureRace(), slug: "no-course" }));
  await assert.rejects(
    () => buildCrewData(root, "no-course", { now: NOW }),
    (e) => e.code === "no_course" && /course\.json/.test(e.message),
  );
});

test("an unknown slug is a not_found, not a crash", async () => {
  await assert.rejects(
    () => buildCrewData(root, "nope-not-here", { now: NOW }),
    (e) => e.code === "not_found",
  );
});
