// The altitude term inside projectRace.
//
// scripts/altitude.test.mjs pins the CURVE; this pins what the projection
// does with it: the penalty multiplies the segment pace the way tech_pct
// does, so a course that never leaves the flats must project to the same
// second with the term on or off, and only the segments that actually get
// above the threshold may slow down.
//
// HOW THE .ts GETS IN HERE
// web/src/race/pacing.ts is not a zero-import module the way altitude.ts and
// nightWindow.ts are — it imports ./clock and ./types by extensionless
// specifier, which is what Vite (not Node) resolves. Rather than reimplement
// the projection in a harness that could drift from it, the test installs a
// module resolve hook that appends `.ts` to relative extensionless imports
// made FROM .ts files, and then loads the real module. Node >= 22.18 strips
// the types; everything below runs against the code the app ships.
//
// The course is synthetic on purpose: a built course.json lives under
// races/<slug>/build/, which is gitignored (generated output), so a test
// that read one would pass on the author's laptop and skip everywhere else.
// This one is shaped like the races the term exists for — a low start, a
// long stretch on a 10,000 ft plateau, a low finish — so "the high segments
// only" is a statement the fixture can actually falsify.

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
const { ALTITUDE_THRESHOLD_FT, altitudeSlowdown } = await import("../web/src/race/altitude.ts");

/* ----------------------------- the fixture ----------------------------- */

/** Elevation (ft) at a course mile: 4,000 ft valley → 10,500 ft plateau →
    back down. Piecewise linear between the knots, which is all the model
    needs and keeps the expected segment means arithmetic. */
const KNOTS = [[0, 4000], [20, 4200], [30, 10000], [55, 10800], [80, 10200], [90, 4600], [100, 4200]];

function eleAt(mi) {
  for (let i = 1; i < KNOTS.length; i++) {
    const [m0, e0] = KNOTS[i - 1], [m1, e1] = KNOTS[i];
    if (mi <= m1) return e0 + ((mi - m0) / (m1 - m0)) * (e1 - e0);
  }
  return KNOTS[KNOTS.length - 1][1];
}

/** A 100-mile course with stations bounding low and high segments. */
function makeCourse() {
  const STEP = 0.05;
  const profile = [];
  for (let mi = 0; mi <= 100 + 1e-9; mi += STEP) {
    const m = Math.round(mi * 1000) / 1000;
    profile.push({ mi: m, ele_ft: eleAt(m), grade_pct: 0 });
  }
  let gain = 0;
  for (let k = 1; k < profile.length; k++) {
    const d = profile[k].ele_ft - profile[k - 1].ele_ft;
    profile[k - 1].grade_pct = (d / (STEP * 5280)) * 100;
    if (d > 0) gain += d;
  }
  profile[profile.length - 1].grade_pct = 0;

  const marks = [20, 30, 45, 60, 80, 90, 100];
  const aid_stations = marks.map((mi, i) => ({
    name: `mi ${mi}`,
    total_mi: mi,
    gpx_mi: mi,
    seg_mi: null,
    seg_gain_ft: null,
    cutoff_h: null,
    crew: i % 2 === 0,
    crew_only: false,
    drop_bag: false,
    pacers: false,
    water_only: false,
    notes: "",
  }));

  return {
    generated_at: "2026-01-01T00:00:00Z",
    source: "synthetic",
    distance_mi: 100,
    gain_ft: gain,
    official_distance_mi: 100,
    official_gain_ft: gain,
    sun: null,
    profile,
    aid_stations,
    race_climbs: [],
  };
}

/** A plain fit object — fitPacing's own output shape. Fixed numbers so the
    projection is deterministic and the assertions are about altitude only. */
const FIT = { base: 570, kVert: 1.7, kDist: 4, residStd: 48, n: 24, effN: 18, basis: "test fit", dRefMi: 20 };

const BASE_OPTS = {
  fatiguePctPer10mi: 5,
  calibrationPct: 6,
  restraintPct: 8,
  goalH: 30,
  aidStopMin: 5,
  crewStopMin: 10,
};

const COURSE = makeCourse();
const project = (altitude) => projectRace(COURSE, FIT, { ...BASE_OPTS, altitude });

const OFF = project({ pct: 0, homeElevationFt: null, acclimationDays: 0 });
const ON = project({ pct: 100, homeElevationFt: null, acclimationDays: 0 });

/** Which fixture segments the model should charge for, by station name. */
const HIGH = new Set(["mi 30", "mi 45", "mi 60", "mi 80", "mi 90"]);
const LOW = new Set(["mi 20", "mi 100"]);

const relClose = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

/* ------------------------------ the tests ------------------------------ */

test("the fixture really does have low and high segments", () => {
  for (const s of ON.stations) {
    const high = s.seg_mean_ele_ft > ALTITUDE_THRESHOLD_FT;
    assert.equal(high, HIGH.has(s.station.name), `${s.station.name} at ${Math.round(s.seg_mean_ele_ft)} ft`);
    assert.equal(!high, LOW.has(s.station.name));
  }
  // and the reported mean is the profile's, not a station-endpoint average
  const first = ON.stations[0];
  assert.ok(relClose(first.seg_mean_ele_ft, (4000 + 4200) / 2, 1e-3), `${first.seg_mean_ele_ft}`);
});

test("altitude_pct 100 slows the HIGH segments and only those", () => {
  for (let i = 0; i < ON.stations.length; i++) {
    const on = ON.stations[i], off = OFF.stations[i];
    const name = on.station.name;
    if (HIGH.has(name)) {
      assert.ok(on.seg_pace_s_per_mi > off.seg_pace_s_per_mi, `${name} did not slow down`);
      assert.ok(on.seg_pace_best_s_per_mi > off.seg_pace_best_s_per_mi, `${name} best did not slow down`);
      assert.ok(on.seg_pace_worst_s_per_mi > off.seg_pace_worst_s_per_mi, `${name} worst did not slow down`);
      assert.ok(on.alt_penalty > 0, `${name} reported no penalty`);
      // the pace ratio IS the curve's penalty — the term is a pace multiplier
      assert.ok(
        relClose(on.seg_pace_s_per_mi / off.seg_pace_s_per_mi, 1 + on.alt_penalty, 1e-6),
        `${name}: pace ratio ${on.seg_pace_s_per_mi / off.seg_pace_s_per_mi} vs 1+${on.alt_penalty}`,
      );
    } else {
      assert.equal(on.alt_penalty, 0, `${name} was charged for a low segment`);
      assert.ok(
        relClose(on.seg_pace_s_per_mi, off.seg_pace_s_per_mi),
        `${name}: ${on.seg_pace_s_per_mi} vs ${off.seg_pace_s_per_mi}`,
      );
    }
    // stops are unaffected either way — altitude is a pace term
    assert.equal(on.stop_min, off.stop_min, `${name} stop moved`);
  }
});

test("the penalty is the published curve at the segment's mean elevation", () => {
  for (const s of ON.stations) {
    assert.ok(relClose(
      s.alt_penalty,
      altitudeSlowdown({ elevationFt: s.seg_mean_ele_ft, homeElevationFt: null, acclimationDays: 0 }),
      1e-12,
    ), s.station.name);
  }
});

test("ETAs stay monotone with the term on", () => {
  for (const [label, proj] of [["off", OFF], ["on", ON]]) {
    for (const sc of ["best", "avg", "worst"]) {
      let prev = -1;
      for (const s of proj.stations) {
        assert.ok(s.eta_h[sc] > prev, `${label}/${sc}: ETA went backwards at ${s.station.name}`);
        prev = s.eta_h[sc];
      }
    }
    let prevGoal = -1;
    for (const s of proj.stations) {
      assert.ok(s.goal_eta_h > prevGoal, `${label}: goal ETA went backwards at ${s.station.name}`);
      prevGoal = s.goal_eta_h;
    }
    // best ≤ expected ≤ worst at every station, still
    for (const s of proj.stations) {
      assert.ok(s.eta_h.best <= s.eta_h.avg && s.eta_h.avg <= s.eta_h.worst, `${label}: band inverted at ${s.station.name}`);
    }
  }
});

test("the whole race is slower, and added_h is exactly what it cost", () => {
  for (const sc of ["best", "avg", "worst"]) {
    assert.ok(ON.finish_h[sc] > OFF.finish_h[sc], `${sc} finish did not move`);
  }
  const delta = ON.finish_h.avg - OFF.finish_h.avg;
  assert.ok(relClose(ON.altitude.added_h, delta, 1e-9), `added_h ${ON.altitude.added_h} vs measured ${delta}`);
  // a real number of minutes on a course like this, not a rounding artefact
  assert.ok(ON.altitude.added_h * 60 > 30, `only ${ON.altitude.added_h * 60} min added`);
});

test("altitude_pct 0 is off but still reports the course", () => {
  assert.equal(OFF.altitude.added_h, 0);
  assert.equal(OFF.altitude.max_penalty, 0);
  assert.equal(OFF.altitude.pct, 0);
  // …including what is being declined: "the model wants 41 minutes and you
  // have it switched off" is a different statement from "this race is flat"
  assert.ok(relClose(OFF.altitude.added_h_at_full, ON.altitude.added_h, 1e-9),
    `${OFF.altitude.added_h_at_full} vs ${ON.altitude.added_h}`);
  // …and the description of the COURSE is independent of the knob
  assert.ok(relClose(OFF.altitude.max_seg_ele_ft, ON.altitude.max_seg_ele_ft));
  assert.ok(relClose(OFF.altitude.mean_ele_ft, ON.altitude.mean_ele_ft));
  assert.ok(relClose(OFF.altitude.miles_above_threshold, ON.altitude.miles_above_threshold));
  assert.ok(OFF.altitude.miles_above_threshold > 60 && OFF.altitude.miles_above_threshold < 75,
    `${OFF.altitude.miles_above_threshold} mi above the threshold`);
});

test("no altitude options at all: no term, no summary, no change", () => {
  const none = project(undefined);
  assert.equal(none.altitude, null);
  assert.equal(none.finish_h.avg, OFF.finish_h.avg);
  for (const s of none.stations) assert.equal(s.alt_penalty, 0);
  // the segment elevations are still reported — they describe the course,
  // and the planner shows them whether or not the term is switched on
  assert.ok(none.stations.some((s) => s.seg_mean_ele_ft > ALTITUDE_THRESHOLD_FT));
});

test("the knob scales the term linearly", () => {
  const half = project({ pct: 50, homeElevationFt: null, acclimationDays: 0 });
  for (let i = 0; i < ON.stations.length; i++) {
    assert.ok(relClose(half.stations[i].alt_penalty, ON.stations[i].alt_penalty / 2, 1e-12), ON.stations[i].station.name);
  }
  assert.ok(half.finish_h.avg > OFF.finish_h.avg && half.finish_h.avg < ON.finish_h.avg);
  assert.ok(relClose(half.altitude.added_h, ON.altitude.added_h / 2, 1e-9));
  // added_h_at_full describes the CURVE, so the knob does not move it
  for (const p of [OFF, half, ON, project({ pct: 150, homeElevationFt: null, acclimationDays: 0 })]) {
    assert.ok(relClose(p.altitude.added_h_at_full, ON.altitude.added_h, 1e-9), `pct ${p.altitude.pct}`);
  }
  // …but acclimation and home elevation do — it is the full curve for THIS
  // athlete, not an athlete-independent constant
  const acclimated = project({ pct: 0, homeElevationFt: null, acclimationDays: 14 });
  assert.ok(acclimated.altitude.added_h_at_full < ON.altitude.added_h);
});

test("acclimation and a high home elevation both cut the bill", () => {
  const acclimated = project({ pct: 100, homeElevationFt: null, acclimationDays: 14 });
  const mountainTown = project({ pct: 100, homeElevationFt: 7000, acclimationDays: 0 });
  assert.ok(acclimated.altitude.added_h < ON.altitude.added_h, "14 days at altitude bought nothing");
  assert.ok(acclimated.altitude.added_h > 0, "14 days should not be a full pardon");
  assert.ok(mountainTown.altitude.added_h < ON.altitude.added_h, "living at 7,000 ft bought nothing");
  assert.equal(ON.altitude.home_assumed, true, "no home elevation must be reported as assumed");
  assert.equal(mountainTown.altitude.home_assumed, false);
  assert.equal(mountainTown.altitude.home_ft, 7000);
});

test("a hand-edited negative knob cannot make thin air a tailwind", () => {
  const sabotage = project({ pct: -200, homeElevationFt: null, acclimationDays: 0 });
  assert.equal(sabotage.altitude.added_h, 0);
  for (const s of sabotage.stations) assert.ok(s.alt_penalty >= 0, s.station.name);
  assert.equal(sabotage.finish_h.avg, OFF.finish_h.avg);
});

test("a course that never leaves the flats projects identically either way", () => {
  const flat = makeCourse();
  for (const p of flat.profile) p.ele_ft = Math.min(p.ele_ft, 3000);
  for (let k = 1; k < flat.profile.length; k++) {
    flat.profile[k - 1].grade_pct = ((flat.profile[k].ele_ft - flat.profile[k - 1].ele_ft) / (0.05 * 5280)) * 100;
  }
  const a = projectRace(flat, FIT, { ...BASE_OPTS, altitude: { pct: 100, homeElevationFt: null, acclimationDays: 0 } });
  const b = projectRace(flat, FIT, { ...BASE_OPTS, altitude: null });
  assert.equal(a.finish_h.avg, b.finish_h.avg);
  assert.equal(a.altitude.added_h, 0);
  assert.equal(a.altitude.max_penalty, 0);
  assert.equal(a.altitude.miles_above_threshold, 0);
});
