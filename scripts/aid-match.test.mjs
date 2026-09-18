// node --test scripts/aid-match.test.mjs   (or: cd web && npm test)
//
// Covers the four strategies (exact / fuzzy / distance / miss) on a synthetic
// GPX, plus the regression that matters: matching the 15 hand-authored MM100
// stations by NAME ONLY — their `gpx_wpt` stripped — against the real committed
// GPX must reproduce the hand-authored mapping.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchAidStations, parseGpx, normalizeName, nameScore, LOW_CONFIDENCE } from "./aid-match.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Synthetic course: a due-north track, ~0.1 mi per point ──────────────────
const LAT0 = 34.0;
const LON0 = -111.0;
const DEG_PER_TENTH_MI = 0.1 / 69.09; // degrees latitude per 0.1 mi
const TRACK_PTS = 300; // ≈ 30 miles

/** lat/lon of the synthetic track point at index i. */
const trackPoint = (i) => ({ lat: LAT0 + i * DEG_PER_TENTH_MI, lon: LON0 });

/**
 * Serialize a synthetic course to GPX text so the tests exercise parseGpx too.
 * @param {{name: string, at: number}[]} wpts  `at` is a track point index
 */
function makeGpx(wpts) {
  const w = wpts
    .map(({ name, at }) => {
      const p = trackPoint(at);
      return `<wpt lat="${p.lat}" lon="${p.lon}"><name>${name}</name></wpt>`;
    })
    .join("\n");
  const trk = Array.from({ length: TRACK_PTS }, (_, i) => {
    const p = trackPoint(i);
    return `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>2000</ele></trkpt>`;
  }).join("\n");
  return `<?xml version="1.0"?>\n<gpx version="1.1">\n${w}\n<trk><name>t</name><trkseg>\n${trk}\n</trkseg></trk>\n</gpx>`;
}

/** Mile of the waypoint named `name` in `gpx`, via its track point. */
function wptMile(gpx, name) {
  const w = gpx.waypoints.find((x) => x.name === name);
  const i = Math.round((w.lat - LAT0) / DEG_PER_TENTH_MI);
  return gpx.track[i].cum_mi;
}

test("parseGpx reads waypoints and cumulative track miles without an XML dep", () => {
  const gpx = parseGpx(makeGpx([{ name: "See Canyon Aid", at: 50 }]));
  assert.equal(gpx.waypoints.length, 1);
  assert.equal(gpx.waypoints[0].name, "See Canyon Aid");
  assert.equal(gpx.track.length, TRACK_PTS);
  assert.equal(gpx.track[0].cum_mi, 0);
  // 300 points × 0.1 mi apart → ~29.9 mi, strictly increasing.
  assert.ok(Math.abs(gpx.track.at(-1).cum_mi - 29.9) < 0.2, `got ${gpx.track.at(-1).cum_mi}`);
  for (let i = 1; i < gpx.track.length; i++) {
    assert.ok(gpx.track[i].cum_mi > gpx.track[i - 1].cum_mi);
  }
  // Self-closing trkpt is legal GPX and must parse.
  assert.equal(parseGpx(`<gpx><trkpt lat="34.0" lon="-111.0" /></gpx>`).track.length, 1);
  // Garbage in, empty out — never throw.
  assert.deepEqual(parseGpx("not xml at all"), { waypoints: [], track: [] });
});

test("exact name match wins, confidence 1", () => {
  const gpx = parseGpx(makeGpx([{ name: "Pinchot Cabin", at: 100 }, { name: "Myrtle Aid", at: 200 }]));
  const [r] = matchAidStations([{ name: "Pinchot Cabin", total_mi: 10 }], gpx);
  assert.equal(r.gpx_wpt, "Pinchot Cabin");
  assert.equal(r.method, "exact");
  assert.equal(r.confidence, 1);
});

test("an authored gpx_wpt is honored; a stale one falls through instead of throwing", () => {
  const gpx = parseGpx(makeGpx([{ name: "Horton Aid", at: 100 }, { name: "Horton Spring (Natural Water Source)", at: 110 }]));
  // The hand-authored value points at the non-obvious waypoint: keep it.
  const [pinned] = matchAidStations(
    [{ name: "Horton", total_mi: 10, gpx_wpt: "Horton Spring (Natural Water Source)" }],
    gpx
  );
  assert.equal(pinned.gpx_wpt, "Horton Spring (Natural Water Source)");
  assert.equal(pinned.method, "exact");
  // A gpx_wpt naming no waypoint is the case build-course.mjs used to throw on.
  const [stale] = matchAidStations([{ name: "Horton", total_mi: 10, gpx_wpt: "Horton AS (2024)" }], gpx);
  assert.equal(stale.gpx_wpt, "Horton Aid");
  assert.equal(stale.method, "fuzzy");
});

test("case, punctuation and abbreviation variants match fuzzily", () => {
  const gpx = parseGpx(
    makeGpx([
      { name: "Cross Mountain", at: 60 },
      { name: "FISH HATCHERY AID", at: 120 },
      { name: "Buck Spr. Aid Station", at: 180 },
      { name: "Bear Cyn TH", at: 240 },
    ])
  );
  const stations = [
    { name: "Cross Mtn TH", total_mi: 6 },
    { name: "Fish Hatchery", total_mi: 12 },
    { name: "Buck Springs", total_mi: 18 },
    { name: "Bear Canyon Trailhead", total_mi: 24 },
  ];
  const got = matchAidStations(stations, gpx);
  assert.deepEqual(got.map((r) => r.gpx_wpt), [
    "Cross Mountain",
    "FISH HATCHERY AID",
    "Buck Spr. Aid Station",
    "Bear Cyn TH",
  ]);
  assert.deepEqual(got.map((r) => r.method), ["fuzzy", "fuzzy", "fuzzy", "fuzzy"]);
  for (const r of got) assert.ok(r.confidence >= LOW_CONFIDENCE, `${r.name} → ${r.confidence}`);
  // "Cross Mtn TH" keeps the extra "trailhead" token, so it scores below a
  // clean two-token hit — still matched, just less certain.
  assert.ok(got[0].confidence < got[1].confidence);
  assert.deepEqual(normalizeName("Cross Mtn TH"), ["cross", "mountain", "trailhead"]);
  assert.equal(nameScore("Buck Springs", "Buck Spr. Aid Station"), 1);
});

test("fuzzy ties are broken by proximity to the charted mile", () => {
  const gpx = parseGpx(makeGpx([{ name: "Pine Aid", at: 40 }, { name: "Pine Crew Zone", at: 250 }]));
  const near = wptMile(gpx, "Pine Crew Zone");
  const [r] = matchAidStations([{ name: "Pine", total_mi: near }], gpx);
  assert.equal(r.gpx_wpt, "Pine Crew Zone");
});

test("distance fallback picks the nearest waypoint and stays below LOW_CONFIDENCE", () => {
  const gpx = parseGpx(makeGpx([{ name: "Rimrock Tank", at: 30 }, { name: "Highline Gate", at: 200 }]));
  const mi = wptMile(gpx, "Highline Gate");
  const [r] = matchAidStations([{ name: "Powerline Junction", total_mi: mi + 0.5 }], gpx);
  assert.equal(r.gpx_wpt, "Highline Gate");
  assert.equal(r.method, "distance");
  assert.ok(r.confidence > 0 && r.confidence < LOW_CONFIDENCE, `got ${r.confidence}`);
  // Tighten the window past the offset and the same station becomes a miss.
  const [tight] = matchAidStations([{ name: "Powerline Junction", total_mi: mi + 0.5 }], gpx, { windowMi: 0.25 });
  assert.equal(tight.gpx_wpt, null);
  // A scale factor maps charted miles onto a long/short track.
  const [scaled] = matchAidStations([{ name: "Powerline Junction", total_mi: mi / 1.02 }], gpx, { scale: 1.02 });
  assert.equal(scaled.gpx_wpt, "Highline Gate");
  assert.ok(scaled.confidence > r.confidence);
});

test("no plausible match returns null with candidates, and never throws", () => {
  const gpx = parseGpx(makeGpx([{ name: "Rimrock Tank", at: 30 }, { name: "Highline Gate", at: 200 }]));
  const [r] = matchAidStations([{ name: "Zebra Junction", total_mi: 95 }], gpx);
  assert.equal(r.gpx_wpt, null);
  assert.equal(r.method, null);
  assert.equal(r.confidence, 0);
  assert.equal(r.candidates.length, 2);
  assert.ok(r.candidates.every((c) => c.score < 0.5));
  // Degenerate inputs: no waypoints, no track, missing mile.
  assert.deepEqual(matchAidStations([], gpx), []);
  const empty = matchAidStations([{ name: "Anywhere" }], { waypoints: [], track: [] });
  assert.equal(empty[0].gpx_wpt, null);
  assert.deepEqual(empty[0].candidates, []);
});

test("regression: MM100 stations matched by name alone reproduce the hand-authored gpx_wpt", () => {
  const raceDir = path.join(ROOT, "races", "mogollon-monster-100-2026");
  const race = JSON.parse(fs.readFileSync(path.join(raceDir, "race.json"), "utf8"));
  const gpx = parseGpx(fs.readFileSync(path.join(raceDir, "course.gpx"), "utf8"));
  const stations = race.aid_stations.map((a) => ({ name: a.name, total_mi: a.total_mi }));
  const got = matchAidStations(stations, gpx);

  // The finish has no waypoint in the chart (build-course.mjs uses the track end).
  // Count it correct when the matcher declines OR lands on the last waypoint —
  // "Pine TH Water" sits 1.5 mi before the finish and is the honest nearest
  // marker; its distance-method confidence keeps it in the unresolved list.
  const lastWpt = gpx.waypoints.at(-1).name;
  const correct = (want, gpxWpt) =>
    want === null ? gpxWpt === null || gpxWpt === lastWpt : gpxWpt === want;

  const rows = got.map((r, i) => {
    const { gpx_wpt: want, total_mi } = race.aid_stations[i];
    return { ...r, want, total_mi, ok: correct(want, r.gpx_wpt) };
  });

  console.log("\n  station          mi     matched                         method    conf   hand-authored");
  for (const r of rows) {
    console.log(
      `  ${r.ok ? "ok  " : "MISS"} ${r.name.padEnd(16)} ${String(r.total_mi).padStart(5)}  ` +
        `${String(r.gpx_wpt).padEnd(30)} ${String(r.method).padEnd(9)} ${String(r.confidence).padEnd(6)} ${String(r.want)}`
    );
  }
  const matched = rows.filter((r) => r.ok).length;
  console.log(`  → ${matched}/${rows.length} stations reproduced from names alone\n`);

  assert.equal(rows.length, 15);
  assert.ok(matched >= 13, `only ${matched}/15 reproduced: ${rows.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
  // Everything the build would trust must clear the threshold; the rest is the
  // caller's unresolved list.
  for (const r of rows) {
    if (r.method === "exact" || r.method === "fuzzy") assert.ok(r.confidence >= LOW_CONFIDENCE);
  }
});
