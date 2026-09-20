// Regression tests for review-v2/ui2-raceday-crew.md BUGS 4, 5, 6, 8, 9 — the
// crew handout's checkpoint updater and drawings (web/src/crew/checkpoint.ts,
// web/src/crew/render.ts, web/src/crew/main.ts). PRD v2 §5.
//
// Same node --test / type-stripping setup as scripts/checkpoint-apply.test.mjs
// (see that file's header for why); kept in its own file rather than appended
// there because this one needs a LONGER synthetic course — bug 5's "a plan
// that crosses midnight" repro needs a station whose planned ETA is past 24h,
// which the 30-mile fixture next door never reaches.

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

const { projectRace } = await import("../web/src/race/pacing.ts");
const { applyCheckpoint } = await import("../web/src/crew/checkpoint.ts");
const { mapSvg, renderCrewPage, checkpointMessage } = await import("../web/src/crew/render.ts");

/* ----------------------------- the fixture ----------------------------- */

/** A 100-mile course, slow enough that the second aid station's plan lands
    past the 24-hour mark — bug 5's "she typed a time that's really tomorrow"
    scenario needs a plan that actually crosses a calendar day to be a
    meaningful repro. */
function makeCourse() {
  const STEP = 0.2;
  const DIST = 100;
  const profile = [];
  for (let mi = 0; mi <= DIST + 1e-9; mi += STEP) {
    const m = Math.round(mi * 1000) / 1000;
    profile.push({ mi: m, ele_ft: 7000 + 25 * m, grade_pct: 0.6 });
  }
  const station = (name, mi, extra = {}) => ({
    name, total_mi: mi, gpx_mi: mi, seg_mi: null, seg_gain_ft: null, cutoff_h: null,
    crew: false, crew_only: false, drop_bag: false, pacers: false, water_only: false, notes: "",
    ...extra,
  });
  return {
    generated_at: "2026-01-01T00:00:00Z", source: "synthetic",
    distance_mi: DIST, gain_ft: 2500, official_distance_mi: DIST, official_gain_ft: 2500,
    sun: null, profile, race_climbs: [],
    aid_stations: [
      station("Cascade", 8.3, { crew: true }),
      station("Ryman", 71.3, { crew: true }),
      station("Finish", DIST, { crew: true }),
    ],
  };
}

const FIT = { base: 800, kVert: 2.0, kDist: 4, residStd: 48, n: 24, effN: 18, basis: "test fit", dRefMi: 20 };
const OPTS = { fatiguePctPer10mi: 8, calibrationPct: 6, restraintPct: 8, goalH: null, aidStopMin: 5, crewStopMin: 10 };
const COURSE = makeCourse();
const LIVE = projectRace(COURSE, FIT, OPTS);

function frozenStations(live) {
  return live.stations.map((s) => ({
    name: s.station.name, total_mi: s.station.total_mi, gpx_mi: s.station.gpx_mi,
    crew: s.station.crew, crew_only: s.station.crew_only, drop_bag: s.station.drop_bag,
    pacers: s.station.pacers, water_only: s.station.water_only, notes: s.station.notes,
    cutoff_h: s.station.cutoff_h, cutoff_clock: null, seg_mi: s.seg_mi, seg_gain_ft: s.seg_gain_ft,
    stop_min: s.stop_min, eta_h: s.eta_h, clock: { best: "", avg: "", worst: "" },
    goal_eta_h: s.goal_eta_h, goal_clock: null,
    cutoff_margin_h: s.cutoff_margin_h, cutoff_margin_worst_h: s.cutoff_margin_worst_h,
  }));
}

function makeData(overrides = {}) {
  return {
    schema_version: 1, generated_at: "2026-01-01T00:00:00Z", slug: "repro",
    race: {
      slug: "repro", name: "Repro", short: "R", date: "2026-06-01", start_time: "06:00",
      timezone: "America/Denver", distance_mi: 100, gain_ft: 2500, location: null,
      cutoff_h: null, sun: null, links: {}, crew_info: null, features: {}, sources: [],
    },
    course: COURSE, crew_base: null,
    knobs: {
      fatiguePctPer10mi: 8, calibrationPct: 6, restraintPct: 8, aidStopMin: 5, crewStopMin: 10,
      stopOverridesMin: {}, goalH: null, altitude: null,
    },
    fit: FIT, grade_curve: null,
    projection: {
      finish_h: LIVE.finish_h, finish_clock: { best: "", avg: "", worst: "" },
      stopped_h: LIVE.stopped_h, goal_h: LIVE.goal_h, grade_basis: LIVE.grade_basis,
      stations: frozenStations(LIVE),
    },
    fuel: null, crew_pickups: [], nutrition: {},
    ...overrides,
  };
}

/** race-local "HH:MM" at elapsed hour `h` after a 06:00 America/Denver
    (MDT, UTC−6 in June) start. Works past 24h (it is just the wall-clock
    READING at that instant, which is exactly what a crew chief types — they
    never write the date). Matches checkpoint-apply.test.mjs's own helper. */
function clockAt(h) {
  const d = new Date(Date.UTC(2026, 5, 1, 12, 0, 0) + h * 3_600_000);
  const hh = String((d.getUTCHours() + 24 - 6) % 24).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

const CASCADE_PLANNED_H = LIVE.stations[0].eta_h.avg;
const RYMAN_PLANNED_H = LIVE.stations[1].eta_h.avg;
assert.ok(RYMAN_PLANNED_H > 24, "fixture needs a station whose plan crosses a calendar day");

/* ============================== BUG 5 =============================== */

test("bug 5: a clock reading before the gun is refused, not rolled forward a day", () => {
  const data = makeData();
  // One hour before the 06:00 gun — the crew's classic "5 for 6" typo.
  const clock = clockAt(-1);
  assert.equal(clock, "05:00");
  const outcome = applyCheckpoint(data, LIVE, { station: "Cascade", clock });
  assert.equal(outcome.ok, false, "an at-or-before-start split must be refused, not re-dated");
  assert.match(outcome.reason, /at or before the start/);
});

test("bug 5: a split whose plan crosses midnight resolves on the day the PLAN says, not literally today", () => {
  const data = makeData();
  // Ryman's plan is >24h out. Typing the wall-clock reading that matches its
  // OWN plan must resolve on day+1, not fall back to the closer-to-now
  // same-day occurrence (elapsed ~2h short of a full day) the old
  // "latest occurrence <= now" rule would have picked.
  const clock = clockAt(RYMAN_PLANNED_H);
  const outcome = applyCheckpoint(data, LIVE, { station: "Ryman", clock });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.ok(outcome.result.observed_h > 24, `expected a day+1 resolution, got ${outcome.result.observed_h}h`);
  assert.ok(
    Math.abs(outcome.result.observed_h - RYMAN_PLANNED_H) < 0.02,
    `expected ~${RYMAN_PLANNED_H}h, got ${outcome.result.observed_h}h`,
  );
  // Squarely on plan — no extreme-pace flag, no clamp.
  assert.equal(outcome.result.clamped, false);
  assert.equal(outcome.result.extremePace, false);
});

test("bug 5: an implausibly fast split (well under a quarter of the plan's moving time) is applied but flagged loudly", () => {
  const data = makeData();
  // Cascade in ~3 minutes flat — the model's moving time to it is ~2.5h, so
  // this is nowhere close to a real performance.
  const clock = clockAt(0.05);
  const outcome = applyCheckpoint(data, LIVE, { station: "Cascade", clock });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(outcome.result.extremePace, true, "a sub-quarter-moving-time split should be flagged extreme");
  assert.equal(outcome.result.clamped, true, "extreme implies clamped — 0.25 is inside the 0.6 floor");
  // The observed clock itself is still honoured exactly (file's own rule).
  assert.equal(outcome.result.observed_h, 0.05);

  const html = renderCrewPage(data, LIVE, outcome.result, checkpointMessage(outcome.result));
  assert.match(html, /class="applied extreme"/, "the status line should carry the loud extreme-pace class");
  assert.match(html, /under a quarter/i);
  // v2 review confirm-ui2 N1: the extreme sentence used to end with its own
  // "." right before the outer template's ". Everything below…", producing
  // a visible ".." in the rendered text. The pre-existing <em> "capped"
  // variant already omits its own trailing period for exactly this reason
  // (checkpointMessage's `paceNote` branch below) — the <strong> extreme
  // sentence must follow the same convention: one full stop, not two.
  const message = checkpointMessage(outcome.result);
  assert.ok(
    !message.includes(".. Everything below"),
    `extreme-pace message has a doubled full stop: ${message}`,
  );
  assert.match(message, /not extrapolated from it<\/strong>\. Everything below/);
});

test("bug 5: an ordinary, close-to-plan split gets neither the clamp nor the extreme-pace flag", () => {
  const data = makeData();
  const clock = clockAt(CASCADE_PLANNED_H);
  const outcome = applyCheckpoint(data, LIVE, { station: "Cascade", clock });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(outcome.result.clamped, false);
  assert.equal(outcome.result.extremePace, false);
});

test("bug 5: an unparsable time is refused with the pre-existing message, not a crash in the new day search", () => {
  const data = makeData();
  const outcome = applyCheckpoint(data, LIVE, { station: "Cascade", clock: "99:99" });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /could not be placed on the race clock/);
});

/* ============================== BUG 6 =============================== */

test("bug 6: a checkpoint upstream of an already-applied later one is refused and names the later station", () => {
  const data = makeData();
  const later = applyCheckpoint(data, LIVE, { station: "Ryman", clock: clockAt(RYMAN_PLANNED_H) });
  assert.equal(later.ok, true, later.ok ? "" : later.reason);

  const upstream = applyCheckpoint(
    data, LIVE,
    { station: "Cascade", clock: clockAt(CASCADE_PLANNED_H) },
    { current: later.result },
  );
  assert.equal(upstream.ok, false, "an upstream submit after a later checkpoint must be refused");
  assert.match(upstream.reason, /Ryman/, "the refusal should name the later, already-applied station");
  assert.match(upstream.reason, /clear/i);
});

test("bug 6: re-submitting the SAME station (a correction) is allowed even with a current checkpoint", () => {
  const data = makeData();
  const first = applyCheckpoint(data, LIVE, { station: "Ryman", clock: clockAt(RYMAN_PLANNED_H) });
  assert.equal(first.ok, true);

  const corrected = applyCheckpoint(
    data, LIVE,
    { station: "Ryman", clock: clockAt(RYMAN_PLANNED_H + 0.1) },
    { current: first.result },
  );
  assert.equal(corrected.ok, true, corrected.ok ? "" : corrected.reason);
});

test("bug 6: a downstream station after an earlier one is applied normally (not treated as out-of-order)", () => {
  const data = makeData();
  const first = applyCheckpoint(data, LIVE, { station: "Cascade", clock: clockAt(CASCADE_PLANNED_H) });
  assert.equal(first.ok, true);

  const downstream = applyCheckpoint(
    data, LIVE,
    { station: "Ryman", clock: clockAt(RYMAN_PLANNED_H) },
    { current: first.result },
  );
  assert.equal(downstream.ok, true, downstream.ok ? "" : downstream.reason);
});

/* ============================== BUG 9 =============================== */

function makeSunData(overrides = {}) {
  return makeData({
    race: {
      slug: "repro", name: "Repro", short: "R", date: "2026-06-01", start_time: "06:00",
      timezone: "America/Denver", distance_mi: 100, gain_ft: 2500, location: null,
      cutoff_h: null, sun: { sunrise: "06:02", sunset: "20:14" }, links: {}, crew_info: null,
      features: {}, sources: [],
    },
    course: { ...COURSE, sun: { sunrise: "06:02", sunset: "20:14" } },
    ...overrides,
  });
}

test("bug 9: the drop-bag night copy is not shown on a sheet with no drop bags and no crew pickups", () => {
  const data = makeSunData({ crew_pickups: [] }); // makeCourse()'s stations are all drop_bag: false
  const html = renderCrewPage(data, LIVE, null, "");
  assert.doesNotMatch(html, /ride in the bags above/, "no drop-bag content exists for this to point at");
  assert.match(html, /bring her lights and warm layers yourself/i);
});

test("bug 9: the original copy still shows once the sheet actually has drop-bag/pickup content", () => {
  // crewNotesHtml reads drop-bag flags off the EMBEDDED projection rows
  // (data.projection.stations), not the raw course — that is what a crew
  // chief actually sees rendered in the table above.
  const data = makeSunData();
  data.projection.stations = data.projection.stations.map((s) =>
    s.name === "Ryman" ? { ...s, drop_bag: true } : s,
  );
  const html = renderCrewPage(data, LIVE, null, "");
  assert.match(html, /ride in the bags above/);
});

/* ============================== BUG 8 =============================== */

/** A minimal CrewData whose course loops — start and finish at the same
    lat/lon, both crew-flagged, the way a real loop course's aid chart would
    have "Start" and "Finish" as two rows sharing one trailhead. */
function makeLoopData() {
  const track = [[38.0, -107.0], [38.05, -107.02], [38.02, -107.01], [38.0, -107.0]];
  const course = {
    ...COURSE,
    map_track: track,
    aid_stations: [
      { name: "Start", total_mi: 0, gpx_mi: 0, seg_mi: null, seg_gain_ft: null, cutoff_h: null,
        crew: true, crew_only: false, drop_bag: false, pacers: false, water_only: false, notes: "",
        lat: 38.0, lon: -107.0 },
      { name: "Cascade", total_mi: 8.3, gpx_mi: 8.3, seg_mi: null, seg_gain_ft: null, cutoff_h: null,
        crew: true, crew_only: false, drop_bag: false, pacers: false, water_only: false, notes: "",
        lat: 38.05, lon: -107.02 },
      { name: "Finish", total_mi: 100, gpx_mi: 100, seg_mi: null, seg_gain_ft: null, cutoff_h: null,
        crew: true, crew_only: false, drop_bag: false, pacers: false, water_only: false, notes: "",
        lat: 38.0, lon: -107.0 },
    ],
  };
  return makeData({ course });
}

test("bug 8: Start and Finish sharing a point on a loop course are merged into one label, not three overlapping ones", () => {
  const svg = mapSvg(makeLoopData());
  assert.match(svg, /class="start-label">Start \/ Finish</, "expected a single merged 'Start / Finish' label");
  // The old failure mode: a separate "Finish · N mi" crew-label text sitting
  // on the same point as the bold START marker.
  assert.doesNotMatch(svg, /class="crew-label">Finish/, "Finish must not ALSO get its own overlapping crew label");
  assert.doesNotMatch(svg, />START</, "the bare START marker must not survive next to a coincident Finish");
});

test("bug 8: a normal (non-loop) course keeps the plain START marker and Finish keeps its own label", () => {
  const track = [[38.0, -107.0], [38.5, -107.5]];
  const course = {
    ...COURSE,
    map_track: track,
    aid_stations: [
      { name: "Cascade", total_mi: 8.3, gpx_mi: 8.3, seg_mi: null, seg_gain_ft: null, cutoff_h: null,
        crew: true, crew_only: false, drop_bag: false, pacers: false, water_only: false, notes: "",
        lat: 38.1, lon: -107.1 },
      { name: "Finish", total_mi: 100, gpx_mi: 100, seg_mi: null, seg_gain_ft: null, cutoff_h: null,
        crew: true, crew_only: false, drop_bag: false, pacers: false, water_only: false, notes: "",
        lat: 38.5, lon: -107.5 },
    ],
  };
  const svg = mapSvg(makeData({ course }));
  assert.match(svg, /class="start-label">START</);
  assert.match(svg, /class="crew-label">Finish/);
});
