// Unit tests for results capture. Run with `npm test` from web/ (node --test).
// Every fixture is synthetic: a straight north-south track at a fixed
// longitude, so "how far is the runner from the station" is plain metres of
// latitude and the geometry is checkable by hand.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  archiveRace,
  loadResult,
  mergeOfficialSplits,
  splitsFromStream,
} from "./race-result.mjs";
import { readActivePointer } from "./race-config.mjs";

const LAT0 = 34.0;
const LON0 = -111.0;
const M_PER_DEG_LAT = 111320; // exact enough at this scale; the code uses haversine

/** A station `m` metres north of the origin. */
const stationAt = (name, m, over = {}) => ({
  name,
  total_mi: +(m / 1609.344).toFixed(2),
  lat: LAT0 + m / M_PER_DEG_LAT,
  lon: LON0,
  ...over,
});

/**
 * A track from a list of metre-offsets north of the origin, one sample every
 * `stepS` seconds. `time` starts at 300 the way a real Strava stream need not
 * start at zero — splits are elapsed from the first sample, not from t=0.
 */
function track(metres, stepS = 30) {
  return {
    latlng: metres.map((m) => [LAT0 + m / M_PER_DEG_LAT, LON0]),
    time: metres.map((_, i) => 300 + i * stepS),
  };
}

/** metres: 0 → `to`, stepping by `step`. */
function ramp(from, to, step = 50) {
  const out = [];
  const dir = to >= from ? 1 : -1;
  for (let m = from; dir > 0 ? m <= to : m >= to; m += dir * step) out.push(m);
  return out;
}

test("splitsFromStream: a station the track never approaches is null, not a guess", () => {
  const stream = track(ramp(0, 5000));
  const stations = [stationAt("Near", 1000), stationAt("Miles Away", 40000)];
  const splits = splitsFromStream(stream, stations);
  assert.deepEqual(splits.map((s) => s.station), ["Near", "Miles Away"]);
  // the split is the ARRIVAL — the first sample inside the 150 m radius, i.e.
  // 850 m along = sample 17, 17 × 30 s after the track's first point
  assert.equal(splits[0].elapsed_h, +((17 * 30) / 3600).toFixed(3));
  assert.equal(splits[0].source, "track");
  assert.equal(splits[1].elapsed_h, null);
  assert.equal(splits[1].source, "track");
});

test("splitsFromStream: a station with no coordinates is null", () => {
  const splits = splitsFromStream(track(ramp(0, 5000)), [{ name: "Unmapped", total_mi: 12 }]);
  assert.equal(splits[0].elapsed_h, null);
});

test("splitsFromStream: an out-and-back scores the first pass, or the second with visit: 2", () => {
  // out to 5 km and back — the 3 km station is passed twice
  const stream = track([...ramp(0, 5000), ...ramp(4950, 0)]);
  const outbound = splitsFromStream(stream, [stationAt("Turnaround Spur", 3000)]);
  const inbound = splitsFromStream(stream, [stationAt("Turnaround Spur", 3000, { visit: 2 })]);

  // going out, the first sample within 150 m of 3000 m is 2850 m → sample 57
  assert.equal(outbound[0].elapsed_h, +((57 * 30) / 3600).toFixed(3));
  // the return leg starts at index 101 (4950 m) and steps down 50 m a sample,
  // so it re-enters the radius at 3150 m → index 137
  assert.equal(inbound[0].elapsed_h, +((137 * 30) / 3600).toFixed(3));
  assert.ok(inbound[0].elapsed_h > outbound[0].elapsed_h);
});

test("splitsFromStream: loitering at a station is one visit, so visit: 2 stays honest", () => {
  // in, out by 200 m, back in — a minute apart, which is milling about, not a
  // second pass; there IS no second visit, so visit: 2 has no answer
  const stream = track([...ramp(0, 3000), 2800, 3000, ...ramp(3050, 6000)]);
  const once = splitsFromStream(stream, [stationAt("Loiter", 3000)]);
  const twice = splitsFromStream(stream, [stationAt("Loiter", 3000, { visit: 2 })]);
  assert.ok(once[0].elapsed_h > 0);
  assert.equal(twice[0].elapsed_h, null);
});

test("mergeOfficialSplits: official wins over the track, and unknown names are kept", () => {
  const derived = [
    { station: "Horton", elapsed_h: 7.5, source: "track" },
    { station: "Myrtle", elapsed_h: 14.2, source: "track" },
    { station: "Finish", elapsed_h: null, source: "track" },
  ];
  const merged = mergeOfficialSplits(derived, [
    { station: "Horton", elapsed_h: 7.62 },
    { station: "Finish", elapsed_h: 33.27 },
    { station: "Timing Mat 3", elapsed_h: 20.1 },
  ]);
  assert.deepEqual(merged, [
    { station: "Horton", elapsed_h: 7.62, source: "official" },
    { station: "Myrtle", elapsed_h: 14.2, source: "track" }, // untouched
    { station: "Finish", elapsed_h: 33.27, source: "official" },
    { station: "Timing Mat 3", elapsed_h: 20.1, source: "official" },
  ]);
});

/* ------------------------------ archiveRace ------------------------------ */

const RACE_DATE = "2026-09-12";

function raceJson(over = {}) {
  return {
    schema_version: 1,
    slug: "test-race-2026",
    status: "active",
    name: "Test Race 100",
    short: "TR100",
    date: RACE_DATE,
    start_time: "06:00",
    timezone: "America/Phoenix", // no DST — the guard's arithmetic is visible
    distance_mi: 100,
    gain_ft: 15000,
    cutoff_h: 38,
    aid_stations: [{ name: "Mid", total_mi: 1.9 }, { name: "Finish", total_mi: 3.1 }],
    ...over,
  };
}

/** A temp project root holding one race folder with a built course. */
async function tempRace(t, { race = raceJson(), pointer = null, result = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "race-result-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "races", race.slug);
  await fs.mkdir(path.join(dir, "build"), { recursive: true });
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(race, null, 2));
  await fs.writeFile(
    path.join(dir, "build", "course.json"),
    JSON.stringify({ aid_stations: [stationAt("Mid", 3000), stationAt("Finish", 5000)] }, null, 2),
  );
  if (result) await fs.writeFile(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
  if (pointer) {
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(path.join(root, "config", "active-race.json"), JSON.stringify(pointer));
  }
  return root;
}

/** Race-day activity: started 06:00 race-local (13:00 UTC in Phoenix). */
const raceDayActivity = (over = {}) => ({
  id: "20165079124",
  start_utc: `${RACE_DATE}T13:00:00Z`,
  date: `${RACE_DATE}T06:00:00Z`,
  title: "Test Race 100",
  elapsed_s: 119788,
  ...over,
});

const streams = () => track([...ramp(0, 5000)]);

test("archiveRace: writes result.json, retires race.json and releases the pointer", async (t) => {
  const root = await tempRace(t, { pointer: { slug: "test-race-2026", mode: "train" } });
  const { result, pointer } = await archiveRace({
    root,
    slug: "test-race-2026",
    activityId: "20165079124",
    notes: "hot day",
    activity: raceDayActivity(),
    streams: streams(),
  });

  assert.equal(result.status, "finished");
  assert.equal(result.strava_activity_id, "20165079124");
  assert.equal(result.finish_h, +(119788 / 3600).toFixed(2));
  assert.equal(result.notes, "hot day");
  assert.deepEqual(result.splits.map((s) => s.station), ["Mid", "Finish"]);
  assert.ok(result.splits.every((s) => s.source === "track" && s.elapsed_h > 0));

  assert.deepEqual(await loadResult(root, "test-race-2026"), result);
  const race = JSON.parse(await fs.readFile(path.join(root, "races", "test-race-2026", "race.json"), "utf8"));
  assert.equal(race.status, "archived");
  assert.equal(race.provenance.status.by, "user");
  assert.equal(race.name, "Test Race 100"); // nothing else disturbed
  assert.deepEqual(pointer, { slug: null, mode: "train" });
  assert.deepEqual(await readActivePointer(root), { slug: null, mode: "train" });
});

test("archiveRace: a pointer merely BROWSING the race is left where it is", async (t) => {
  const root = await tempRace(t, {
    race: raceJson({ status: "archived" }),
    pointer: { slug: "test-race-2026", mode: "view" },
  });
  await archiveRace({
    root,
    slug: "test-race-2026",
    activityId: "20165079124",
    activity: raceDayActivity(),
    streams: streams(),
  });
  assert.deepEqual(await readActivePointer(root), { slug: "test-race-2026", mode: "view" });
});

test("archiveRace: official results override the track and the derived finish", async (t) => {
  const root = await tempRace(t);
  const { result } = await archiveRace({
    root,
    slug: "test-race-2026",
    activityId: "20165079124",
    official: {
      finish_h: 33.52,
      official_time: "33:31:12",
      placement: "41 / 112",
      splits: [{ station: "Finish", elapsed_h: 33.52 }],
    },
    activity: raceDayActivity(),
    streams: streams(),
  });
  // the official clock, not the activity's elapsed 33.27 h
  assert.equal(result.finish_h, 33.52);
  assert.equal(result.official_time, "33:31:12");
  assert.equal(result.placement, "41 / 112");
  assert.deepEqual(result.splits[1], { station: "Finish", elapsed_h: 33.52, source: "official" });
  assert.equal(result.splits[0].source, "track"); // Mid untimed officially, track kept
});

test("archiveRace: re-archiving keeps what the previous result.json already recorded", async (t) => {
  const root = await tempRace(t, {
    result: {
      status: "finished",
      strava_activity_id: null,
      finish_h: 33.27,
      official_time: null,
      placement: null,
      splits: [],
      notes: "recorded at migration",
    },
  });
  const { result } = await archiveRace({
    root,
    slug: "test-race-2026",
    activityId: "20165079124",
    activity: raceDayActivity(),
    streams: streams(),
  });
  assert.equal(result.finish_h, 33.27); // the migration's number, not the activity's
  assert.equal(result.notes, "recorded at migration");
  assert.equal(result.strava_activity_id, "20165079124");
  assert.equal(result.splits.length, 2);
});

test("archiveRace: refuses an activity that is not from race day, in RACE-local time", async (t) => {
  const root = await tempRace(t);
  const archive = (activity) =>
    archiveRace({ root, slug: "test-race-2026", activityId: activity.id, activity, streams: streams() });

  // a week later — the wrong row in the picker
  await assert.rejects(
    archive(raceDayActivity({ start_utc: "2026-09-19T13:00:00Z" })),
    (e) => /2026-09-19.*was 2026-09-12/s.test(e.message) && e.code === "bad_request",
  );
  // the day after: a 38 h race can finish then, so ±1 day is allowed
  await assert.doesNotReject(archive(raceDayActivity({ start_utc: "2026-09-13T13:00:00Z" })));
  // 21:00 the night before race day in Phoenix is 04:00 UTC the NEXT day —
  // judged local, that is D-1 and fine; judged in UTC it would read as D+1
  await assert.doesNotReject(archive(raceDayActivity({ start_utc: "2026-09-12T04:00:00Z" })));
  // two days out in local time, whatever the UTC date says
  await assert.rejects(
    archive(raceDayActivity({ start_utc: "2026-09-15T04:00:00Z" })),
    (e) => e.code === "bad_request",
  );
});

test("archiveRace: no result is written when the race day check fails", async (t) => {
  const root = await tempRace(t, { pointer: { slug: "test-race-2026", mode: "train" } });
  await assert.rejects(
    archiveRace({
      root,
      slug: "test-race-2026",
      activityId: "1",
      activity: raceDayActivity({ id: "1", start_utc: "2026-10-01T13:00:00Z" }),
      streams: streams(),
    }),
  );
  assert.equal(await loadResult(root, "test-race-2026"), null);
  const race = JSON.parse(await fs.readFile(path.join(root, "races", "test-race-2026", "race.json"), "utf8"));
  assert.equal(race.status, "active");
  assert.deepEqual(await readActivePointer(root), { slug: "test-race-2026", mode: "train" });
});

test("archiveRace: an unknown slug is not_found; an unbuilt course is bad_request", async (t) => {
  const root = await tempRace(t);
  await assert.rejects(
    archiveRace({ root, slug: "no-such-race", activityId: "1", activity: raceDayActivity(), streams: streams() }),
    (e) => e.code === "not_found",
  );
  await fs.rm(path.join(root, "races", "test-race-2026", "build"), { recursive: true });
  await assert.rejects(
    archiveRace({
      root,
      slug: "test-race-2026",
      activityId: "1",
      activity: raceDayActivity(),
      streams: streams(),
    }),
    (e) => e.code === "bad_request" && /course:build/.test(e.message),
  );
});
