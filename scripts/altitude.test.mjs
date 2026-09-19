// The altitude slowdown curve, pinned.
//
// Two jobs:
//  1. Pin the SHAPE at the points that were chosen deliberately — the
//     5,000 ft threshold, the per-1,000 ft cost, and the two published
//     acclimatization anchors (half the benefit by day 3, ~90 % by day 14).
//     These numbers reach the athlete as minutes on a race plan, so a
//     re-tuning should have to walk past a failing assertion.
//  2. Prove the twins agree. scripts/altitude.mjs is what the Node scripts
//     import and web/src/race/altitude.ts is what the app bundles; both are
//     loaded HERE (the .ts directly, type-stripped by node >= 22.18 — it
//     imports nothing, the same trick scripts/features.test.mjs and
//     scripts/sun-null.test.mjs use) and compared constant by constant and
//     value by value. A change mirrored in only one file fails this file.

import test from "node:test";
import assert from "node:assert/strict";

import * as mjs from "./altitude.mjs";
import * as ts from "../web/src/race/altitude.ts";

/** Both twins, so every behavioural assertion runs against each. */
const TWINS = [["scripts/altitude.mjs", mjs], ["web/src/race/altitude.ts", ts]];

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/* --------------------------- the twins agree --------------------------- */

test("the .mjs and .ts twins export the same constants", () => {
  for (const key of [
    "ALTITUDE_THRESHOLD_FT", "PACE_PENALTY_PER_1000FT", "ACCLIMATION_MAX_RELIEF",
    "ACCLIMATION_HALF_DAYS", "ACCLIMATION_NEAR_DAYS", "ACCLIMATION_NEAR_FRACTION",
  ]) {
    assert.equal(typeof mjs[key], "number", `${key} missing from the .mjs twin`);
    assert.equal(ts[key], mjs[key], `${key} differs between the twins`);
  }
});

test("the .mjs and .ts twins agree across a grid of inputs", () => {
  for (const elevationFt of [-200, 0, 4999, 5000, 6500, 8000, 10300, 12000, 14100]) {
    for (const homeElevationFt of [null, 0, 3000, 5280, 7000]) {
      for (const acclimationDays of [0, 1, 3, 7, 14, 30]) {
        const args = { elevationFt, homeElevationFt, acclimationDays };
        assert.ok(
          near(ts.altitudeSlowdown(args), mjs.altitudeSlowdown(args)),
          `twins disagree at ${JSON.stringify(args)}`,
        );
      }
    }
    // no-argument / partial calls have to agree too
    assert.ok(near(ts.altitudeSlowdown({ elevationFt }), mjs.altitudeSlowdown({ elevationFt })));
  }
  for (const d of [0, 0.5, 3, 14, 100]) {
    assert.ok(near(ts.acclimationFraction(d), mjs.acclimationFraction(d)), `acclimationFraction(${d})`);
  }
});

/* ------------------------- the curve itself ---------------------------- */

for (const [name, A] of TWINS) {
  test(`${name}: nothing is charged below the threshold`, () => {
    for (const ele of [-300, 0, 1000, 4000, 4999, A.ALTITUDE_THRESHOLD_FT]) {
      assert.equal(A.altitudeSlowdown({ elevationFt: ele }), 0, `${ele} ft`);
    }
    // an absent or unusable elevation is sea level, not NaN reaching a pace
    assert.equal(A.altitudeSlowdown({}), 0);
    assert.equal(A.altitudeSlowdown(), 0);
    assert.equal(A.altitudeSlowdown({ elevationFt: NaN }), 0);
    assert.equal(A.altitudeSlowdown({ elevationFt: 9000, homeElevationFt: NaN }), A.altitudeSlowdown({ elevationFt: 9000 }));
  });

  test(`${name}: unacclimated penalty is the per-1,000 ft cost above the threshold`, () => {
    // 8,000 ft = 3,000 ft over the threshold = 3 × 1.8 % = 5.4 %
    assert.ok(near(A.altitudeSlowdown({ elevationFt: 8000, acclimationDays: 0 }), 0.054, 1e-12));
    // 12,000 ft = 7,000 ft over = 12.6 %
    assert.ok(near(A.altitudeSlowdown({ elevationFt: 12000, acclimationDays: 0 }), 0.126, 1e-12));
    // and it is exactly linear in the excess
    assert.ok(near(
      A.altitudeSlowdown({ elevationFt: 12000 }) - A.altitudeSlowdown({ elevationFt: 11000 }),
      A.PACE_PENALTY_PER_1000FT, 1e-12,
    ));
  });

  test(`${name}: acclimation hits the two published anchors`, () => {
    // day 3 → half the available benefit; day 14 → 90 % of it
    assert.ok(near(A.acclimationFraction(A.ACCLIMATION_HALF_DAYS), 0.5, 1e-9));
    assert.ok(near(A.acclimationFraction(A.ACCLIMATION_NEAR_DAYS), A.ACCLIMATION_NEAR_FRACTION, 1e-9));
    assert.equal(A.acclimationFraction(0), 0);
    assert.equal(A.acclimationFraction(-5), 0, "a negative stay is no stay, not a bonus");

    // …and those land on the penalty as (1 − maxRelief × fraction)
    const raw = A.altitudeSlowdown({ elevationFt: 8000, acclimationDays: 0 });
    assert.ok(near(A.altitudeSlowdown({ elevationFt: 8000, acclimationDays: 3 }), raw * 0.75, 1e-12));
    assert.ok(near(A.altitudeSlowdown({ elevationFt: 8000, acclimationDays: 14 }), raw * 0.55, 1e-12));
    assert.ok(near(A.altitudeSlowdown({ elevationFt: 12000, acclimationDays: 3 }), 0.0945, 1e-12));
    assert.ok(near(A.altitudeSlowdown({ elevationFt: 12000, acclimationDays: 14 }), 0.0693, 1e-12));
  });

  test(`${name}: acclimation is partial, however long the stay`, () => {
    const raw = A.altitudeSlowdown({ elevationFt: 12000, acclimationDays: 0 });
    const floor = raw * (1 - A.ACCLIMATION_MAX_RELIEF);
    for (const d of [30, 365, 10000]) {
      const v = A.altitudeSlowdown({ elevationFt: 12000, acclimationDays: d });
      assert.ok(v >= floor - 1e-12, `${d} d fell below the structural floor`);
      assert.ok(v < raw, `${d} d did not help at all`);
    }
    assert.ok(near(A.altitudeSlowdown({ elevationFt: 12000, acclimationDays: 1e9 }), floor, 1e-9));
  });

  test(`${name}: the athlete's home elevation raises the threshold, never lowers it`, () => {
    // a mountain-town athlete pays only for what is ABOVE home
    assert.ok(near(A.altitudeSlowdown({ elevationFt: 10000, homeElevationFt: 7000 }), 3 * A.PACE_PENALTY_PER_1000FT, 1e-12));
    // living at 3,000 ft does not make 5,000 ft cost anything
    assert.equal(A.altitudeSlowdown({ elevationFt: 5000, homeElevationFt: 3000 }), 0);
    assert.equal(
      A.altitudeSlowdown({ elevationFt: 8000, homeElevationFt: 3000 }),
      A.altitudeSlowdown({ elevationFt: 8000, homeElevationFt: null }),
      "below-threshold homes all read as the threshold",
    );
    // …and living HIGH than the race is not a speed bonus
    assert.equal(A.altitudeSlowdown({ elevationFt: 6000, homeElevationFt: 9000 }), 0);
  });

  test(`${name}: monotone in all three inputs`, () => {
    let prev = -1;
    for (let ele = 0; ele <= 15000; ele += 250) {
      const v = A.altitudeSlowdown({ elevationFt: ele, homeElevationFt: 5280, acclimationDays: 2 });
      assert.ok(v >= prev, `penalty fell going up at ${ele} ft`);
      assert.ok(v >= 0, `negative penalty at ${ele} ft`);
      prev = v;
    }
    prev = Infinity;
    for (let d = 0; d <= 60; d += 0.5) {
      const v = A.altitudeSlowdown({ elevationFt: 11000, acclimationDays: d });
      assert.ok(v <= prev, `penalty rose with another day at altitude (day ${d})`);
      prev = v;
    }
    prev = Infinity;
    for (let home = 0; home <= 11000; home += 250) {
      const v = A.altitudeSlowdown({ elevationFt: 11000, homeElevationFt: home });
      assert.ok(v <= prev, `penalty rose with a higher home elevation (${home} ft)`);
      prev = v;
    }
    let f = -1;
    for (let d = 0; d <= 60; d += 0.25) {
      const v = A.acclimationFraction(d);
      assert.ok(v >= f && v <= 1, `acclimationFraction not monotone/bounded at day ${d}`);
      f = v;
    }
  });
}
