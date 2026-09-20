// The altitude back-test in web/src/race/calibration.ts.
//
// Two claims worth pinning, because both are the kind that fail silently:
//   1. the >= 5 gate — with four high runs the panel must say "uncalibrated"
//      and suggest NOTHING, because one cold day at 11,000 ft otherwise sets
//      the athlete's altitude knob for the season;
//   2. the direction and magnitude — a cohort that ran exactly as much slower
//      as the published curve says must land on 100%, one that ran half as
//      much slower on 50%, and one that ran twice as much slower above 100%.
//
// HOW THE .ts GETS IN HERE
// Same resolve hook as scripts/altitude-projection.test.mjs: calibration.ts
// imports ./pacing and ./altitude by extensionless specifier (Vite resolves
// those, Node does not), so the hook appends `.ts` for relative imports made
// from .ts files and Node >= 22.18 strips the types. The test therefore runs
// against the module the app ships, not a reimplementation of it.
//
// Every activity below is synthetic and generated from a closed-form pace
// model, so the expected suggestions are exact rather than approximate.
// Nothing reads web/public/strava.json or the stream cache.

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

const { calibrateAltitude, HIGH_ALTITUDE_MARGIN_FT, MIN_ALTITUDE_COHORT, ALTITUDE_PCT_MAX } =
  await import("../web/src/race/calibration.ts");
const { altitudeSlowdown } = await import("../web/src/race/altitude.ts");

const NOW = Date.parse("2027-06-01T12:00:00Z");
const HOME_FT = 5000;
const HIGH_FT = 10000;

/* The athlete's true near-home pace model — exactly linear in the three
   terms fitPacing solves for, so a weighted least-squares fit recovers it to
   machine precision whatever the weights are, and every expected number
   below is an identity rather than a tolerance. */
const BASE_S = 600;      // s/mi on the flat at zero distance
const K_VERT = 1.0;      // s/mi per ft-per-mile of climbing
const K_DIST = 2.0;      // s/mi per mile of distance

const trueSPerMi = (distMi, vfpm) => BASE_S + K_VERT * vfpm + K_DIST * distMi;

let seq = 0;
/**
 * @param {number} distMi
 * @param {number} vfpm     ft of climb per mile
 * @param {number} slowdown fraction slower than the near-home model
 */
function act(distMi, vfpm, slowdown = 0) {
  seq += 1;
  const date = new Date(NOW - seq * 3 * 86_400_000).toISOString().slice(0, 10);
  return {
    id: `a${seq}`,
    date,
    title: `run ${seq}`,
    type: "run",
    distance_mi: distMi,
    elevation_ft: vfpm * distMi,
    moving_s: distMi * trueSPerMi(distMi, vfpm) * (1 + slowdown),
  };
}

/** Twelve near-home runs spread over distance and climb rate — enough for
    fitPacing's 8-row floor, and non-collinear so the 3x3 solve is unique. */
function lowRuns() {
  const spec = [
    [10, 0], [12, 40], [14, 90], [16, 30], [18, 140], [20, 60],
    [11, 200], [13, 10], [15, 250], [17, 80], [19, 20], [22, 120],
  ];
  return spec.map(([d, v]) => act(d, v));
}

/** `n` runs up high, each `slowdown` slower than the near-home model. */
function highRuns(n, slowdown) {
  const spec = [[12, 100], [14, 160], [16, 120], [18, 200], [13, 80], [20, 140], [15, 180]];
  return spec.slice(0, n).map(([d, v]) => act(d, v, slowdown));
}

/** The elevation map climbs.json carries: everything in `low` near home,
    everything in `high` up at HIGH_FT. */
function eleMap(low, high) {
  const m = {};
  for (const a of low) m[a.id] = HOME_FT - 1000;
  for (const a of high) m[a.id] = HIGH_FT;
  return m;
}

function run({ nHigh, slowdown, homeElevationFt = HOME_FT, currentAltitudePct = 100, dropElevations = false }) {
  seq = 0;
  const low = lowRuns();
  const high = highRuns(nHigh, slowdown);
  return calibrateAltitude({
    activities: [...low, ...high],
    meanElevationFtById: dropElevations ? {} : eleMap(low, high),
    homeElevationFt,
    dRefMi: 20,
    nowMs: NOW,
    currentAltitudePct,
  });
}

/** What the published curve charges at HIGH_FT for a HOME_FT athlete who
    drove up this morning — the denominator every suggestion is a ratio of. */
const MODELED_PCT =
  altitudeSlowdown({ elevationFt: HIGH_FT, homeElevationFt: HOME_FT, acclimationDays: 0 }) * 100;

test("the fixture's modeled penalty is what the published curve says", () => {
  // 10,000 ft is 5,000 ft over a 5,000 ft athlete's reference → 5 × 1.8 %.
  assert.ok(Math.abs(MODELED_PCT - 9) < 1e-9, `modeled ${MODELED_PCT}`);
});

/* ------------------------------ the gate ------------------------------ */

test(`${MIN_ALTITUDE_COHORT - 1} high runs is uncalibrated and suggests nothing`, () => {
  const c = run({ nHigh: MIN_ALTITUDE_COHORT - 1, slowdown: 0.09 });
  assert.equal(c.status, "uncalibrated");
  assert.equal(c.n, MIN_ALTITUDE_COHORT - 1);
  assert.equal(c.suggested_altitude_pct, null);
  assert.match(c.label, /uncalibrated \(4 high-altitude runs, need 5\)/);
});

test(`${MIN_ALTITUDE_COHORT} high runs crosses the gate`, () => {
  const c = run({ nHigh: MIN_ALTITUDE_COHORT, slowdown: 0.09 });
  assert.equal(c.status, "calibrated");
  assert.equal(c.n, MIN_ALTITUDE_COHORT);
  assert.notEqual(c.suggested_altitude_pct, null);
});

/* --------------------------- bias direction --------------------------- */

test("running exactly as slow as the curve predicts suggests 100%", () => {
  const c = run({ nHigh: 6, slowdown: MODELED_PCT / 100 });
  assert.equal(c.status, "calibrated");
  assert.ok(Math.abs(c.observed_pct - MODELED_PCT) < 1e-6, `observed ${c.observed_pct}`);
  assert.equal(c.suggested_altitude_pct, 100);
});

test("running only half as slow as the curve predicts suggests 50%", () => {
  const c = run({ nHigh: 6, slowdown: MODELED_PCT / 200 });
  assert.equal(c.suggested_altitude_pct, 50);
  assert.ok(c.observed_pct < c.modeled_pct);
});

test("running slower than the curve predicts suggests more than 100%", () => {
  const c = run({ nHigh: 6, slowdown: (MODELED_PCT * 1.3) / 100 });
  assert.equal(c.suggested_altitude_pct, 130);
  assert.ok(c.observed_pct > c.modeled_pct);
});

test("running at altitude as fast as at home suggests switching the term off", () => {
  const c = run({ nHigh: 6, slowdown: 0 });
  assert.equal(c.suggested_altitude_pct, 0);
  assert.ok(Math.abs(c.observed_pct) < 1e-6);
});

test("an absurd measured excess is clamped to the slider's range, and says so", () => {
  const c = run({ nHigh: 6, slowdown: (MODELED_PCT * 4) / 100 });
  assert.equal(c.suggested_altitude_pct, ALTITUDE_PCT_MAX);
  assert.equal(c.suggestion_clamped, true);
});

test("the suggestion is not clamped when it lands inside the range", () => {
  const c = run({ nHigh: 6, slowdown: MODELED_PCT / 100 });
  assert.equal(c.suggestion_clamped, false);
});

/* ---------------------- the baseline is LOW-only ---------------------- */

test("the high runs do not contaminate the baseline they are measured against", () => {
  // If the near-home baseline were fitted on every run (the ordinary
  // leave-one-out path), the high cohort's own slowdown would be partly
  // absorbed into the coefficients and the measured excess would come back
  // SMALLER than the slowdown actually imposed. It must come back exact.
  const slowdown = 0.12;
  const c = run({ nHigh: 7, slowdown });
  assert.ok(Math.abs(c.observed_pct - slowdown * 100) < 1e-6, `observed ${c.observed_pct}`);
  for (const r of c.runs) {
    assert.ok(Math.abs(r.err_pct - slowdown * 100) < 1e-6, `${r.title}: ${r.err_pct}`);
  }
});

test("every counted run is above home + the margin, and carries its elevation", () => {
  const c = run({ nHigh: 6, slowdown: 0.09 });
  assert.equal(c.threshold_ft, HOME_FT + HIGH_ALTITUDE_MARGIN_FT);
  assert.equal(c.home_ft, HOME_FT);
  for (const r of c.runs) assert.ok(r.mean_ele_ft > c.threshold_ft);
});

/* ------------------------- the honest refusals ------------------------ */

test("no home elevation: no back-test, and the label asks for one", () => {
  const c = run({ nHigh: 6, slowdown: 0.09, homeElevationFt: null });
  assert.equal(c.status, "no-home");
  assert.equal(c.suggested_altitude_pct, null);
  assert.equal(c.threshold_ft, null);
  assert.match(c.label, /home elevation/);
});

test("no per-activity elevations: reported as missing data, not as low runs", () => {
  const c = run({ nHigh: 6, slowdown: 0.09, dropElevations: true });
  assert.equal(c.status, "no-elevations");
  assert.equal(c.n, 0);
  assert.equal(c.suggested_altitude_pct, null);
  assert.match(c.label, /sync:streams/);
});

test("high runs but too thin a near-home history to build a baseline", () => {
  seq = 0;
  const low = lowRuns().slice(0, 3);
  const high = highRuns(6, 0.09);
  const c = calibrateAltitude({
    activities: [...low, ...high],
    meanElevationFtById: eleMap(low, high),
    homeElevationFt: HOME_FT,
    dRefMi: 20,
    nowMs: NOW,
  });
  assert.equal(c.status, "uncalibrated");
  assert.equal(c.suggested_altitude_pct, null);
  assert.match(c.label, /baseline/);
});

test("a mountain-town athlete's home runs are not 'at altitude'", () => {
  // Home at 10,000 ft: the same runs that were high for a 5,000 ft athlete
  // are now near home, and there is nothing to calibrate against.
  const c = run({ nHigh: 6, slowdown: 0.09, homeElevationFt: HIGH_FT });
  assert.equal(c.status, "uncalibrated");
  assert.equal(c.n, 0);
  assert.equal(c.suggested_altitude_pct, null);
  assert.match(c.label, /0 high-altitude runs, need 5/);
});

test("the current knob value is quoted back for comparison", () => {
  const c = run({ nHigh: 6, slowdown: MODELED_PCT / 200, currentAltitudePct: 100 });
  assert.match(c.label, /you are at 100%/);
  assert.match(c.label, /altitude 50%/);
});
