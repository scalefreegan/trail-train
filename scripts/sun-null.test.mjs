// The fix-sun-null bug, pinned down at the pure-function layer.
//
// A draft's course built while `date` was still null leaves race.json (and
// therefore build/course.json) with no `sun` — build-course.mjs copies
// through whatever race.json has, which is nothing. web/src/race/types.ts's
// Course.sun used to be declared REQUIRED, so nothing guarded it: switching
// the dashboard to that draft threw `TypeError: Cannot read properties of
// undefined (reading 'sunset')` deep inside useRacePlanInstance and crashed
// the whole app to a blank page.
//
// web/src/race/nightWindow.ts is the fix's testable core: it imports
// NOTHING (same reason nutrition-config.ts was split out of nutrition.ts —
// see that file's own comment), so its .ts source is imported directly here,
// type-stripped by node >= 22.18, the way scripts/features.test.mjs imports
// web/src/race/features.ts. planFuel (nutrition.ts) and planCaffeine
// (caffeine.ts) themselves pull in React/../data/pacing's clock.ts value
// imports and so can't be loaded this way — but both now delegate their
// entire sun-dependent computation to the functions tested here
// (nightOverlapH for planFuel's per-leg night flag, darknessWindow for
// planCaffeine's whole dosing window), so this is the real logic, not a
// reimplementation of it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  clockToH,
  dailyOverlap,
  darknessWindow,
  nightIntervals,
  nightOverlapH,
  sunBoundsH,
} from "../web/src/race/nightWindow.ts";

const SUN = { sunset: "20:00", sunrise: "06:00" };

/* ------------------------------- clockToH -------------------------------- */

test("clockToH parses HH:MM into fractional hours", () => {
  assert.equal(clockToH("06:30"), 6.5);
  assert.equal(clockToH("00:00"), 0);
  assert.equal(clockToH("23:45"), 23.75);
});

/* ----------------------------- nightIntervals ----------------------------- */
//
// This is what RacePlanner.tsx's profile-chart night bands and pacing.ts's
// re-exported `nightIntervals` (unchanged call sites) both run through.

test("nightIntervals returns [] when sunset or sunrise is missing — never throws", () => {
  assert.deepEqual(nightIntervals("06:00", null, "06:00", 40), []);
  assert.deepEqual(nightIntervals("06:00", "20:00", null, 40), []);
  assert.deepEqual(nightIntervals("06:00", undefined, undefined, 40), []);
  assert.deepEqual(nightIntervals("06:00", "", "", 40), []);
});

test("nightIntervals bands sunset-to-sunrise, repeating every 24h, clipped to the horizon", () => {
  const bands = nightIntervals("06:00", "20:00", "06:00", 30);
  // first night: sunset at elapsed h=14 (20:00 - 06:00 start) → sunrise the
  // next day at elapsed h=24 (06:00 the next morning, start-relative)
  assert.deepEqual(bands[0], [14, 24]);
  // second night starts at 14+24=38, clipped to the 30h horizon — dropped
  // entirely since it starts past the horizon
  assert.equal(bands.length, 1);
});

test("nightIntervals adds a pre-dawn band when the race starts in the dark", () => {
  // MM100-shaped repro: a 06:00 start against a 06:05 sunrise — five minutes
  // of dark right at the gun, on top of the ordinary sunset band.
  const bands = nightIntervals("06:00", "20:00", "06:05", 30);
  assert.equal(bands[0][0], 0);
  assert.ok(Math.abs(bands[0][1] - 5 / 60) < 1e-9, `expected ~5/60, got ${bands[0][1]}`);
});

/* ------------------------------- dailyOverlap ------------------------------ */

test("dailyOverlap sums overlap with a repeating window, including a negative-offset window", () => {
  assert.equal(dailyOverlap(0, 10, 5, 8), 3);
  // two full repeats ([5,8], [29,32]) plus one hour of a third clipped by the
  // 30h horizon ([29,30] of [53,56])... i.e. [5,8]=3h, [29,30]=1h = 4h total
  assert.equal(dailyOverlap(0, 30, 5, 8), 4);
  // a window edge below 0 (an evening start puts the heat window at negative
  // elapsed hours) must not silently skip its first repeat: [-3,1] overlapped
  // with [-2,2] is [-2,1] = 3h
  assert.equal(dailyOverlap(-2, 2, -3, 1), 3);
});

/* ------------------------------ nightOverlapH ------------------------------ */
//
// planFuel's per-leg night flag (nutrition.ts): 0 — not a throw — when sun
// is null, so `night: nightH > 0.25` is always false and no ☾ is drawn.

test("nightOverlapH is 0 when sun is null — planFuel's leg gets no night flag", () => {
  assert.equal(nightOverlapH(0, 40, null, 6), 0);
});

test("nightOverlapH matches nightIntervals' own placement of the first night", () => {
  // race starts at clock 06:00 (startH=6 elapsed-hour origin); a leg spanning
  // elapsed hours [10, 16] crosses into the sunset-at-14 band for 2 hours.
  assert.equal(nightOverlapH(10, 16, SUN, 6), 2);
  // a daytime leg gets nothing
  assert.equal(nightOverlapH(0, 5, SUN, 6), 0);
});

/* ------------------------------- sunBoundsH -------------------------------- */
//
// The caffeine chart's night-band shading (caffeine.ts's exported
// sunBounds delegates here) — [] when sun is null.

test("sunBoundsH returns [] when sun is null", () => {
  assert.deepEqual(sunBoundsH(null, 6, 30), []);
});

test("sunBoundsH bands the same way nightIntervals does for the same clocks", () => {
  const bounds = sunBoundsH(SUN, 6, 30);
  assert.deepEqual(bounds, nightIntervals("06:00", SUN.sunset, SUN.sunrise, 30));
});

/* ----------------------------- darknessWindow ------------------------------ */
//
// planCaffeine's entire dosing window derivation (caffeine.ts). null sun ⇒
// null return ⇒ planCaffeine hands back an empty schedule with
// note: "sun unknown…" instead of computing anything.

test("darknessWindow is null when sun is null", () => {
  assert.equal(darknessWindow(null, 6, 1), null);
});

test("darknessWindow opens at dusk for a daytime start", () => {
  const dark = darknessWindow(SUN, 6, 1); // 06:00 start, well before sunset
  assert.ok(dark);
  assert.equal(dark.duskH, 14); // 20:00 - 06:00
  assert.equal(dark.isNight(13), false); // 19:00, still light
  assert.equal(dark.isNight(14), true); // 20:00, sunset
  assert.equal(dark.isNight(23.9), true); // 05:54 next day, still dark
  assert.equal(dark.isNight(24), false); // 06:00 next day, sunrise
});

test("darknessWindow opens immediately for a start already in a real night", () => {
  // gun at 22:00 against a 20:00/06:00 sun — already dark, and 8h of it left
  // (well past the 1h min-spacing floor), so dosing should start at h=0.
  const dark = darknessWindow(SUN, 22, 1);
  assert.equal(dark.duskH, 0);
});

test("darknessWindow treats a sliver of pre-dawn dark as not worth opening into immediately", () => {
  // MM100-shaped repro: 06:00 start, 06:05 sunrise — 5 minutes of technical
  // darkness, less than the 1h min-spacing floor, so it should NOT treat the
  // race as starting mid-window; it waits for the real, later sunset instead.
  const sliver = { sunset: "20:00", sunrise: "06:05" };
  const dark = darknessWindow(sliver, 6, 1);
  assert.ok(dark.duskH > 0, `duskH should be the upcoming sunset, not 0 — got ${dark.duskH}`);
});
