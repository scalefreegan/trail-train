// Shared test for the race-local clock helpers.
//
// It runs against scripts/clock.mjs, which is the Node twin of the client's
// web/src/race/clock.ts. The two files hold the same logic by hand, so a change
// to either must keep this test green and be mirrored in the other.
//
// Nothing here may depend on the machine's own zone — that is the entire point
// of the module. Run it under `TZ=Pacific/Auckland node --test scripts/` to
// prove it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  isValidTimeZone,
  raceLocalParts,
  raceStart,
  raceWeekLabels,
  weekdayName,
  zoneOffsetMinutes,
} from "./clock.mjs";

test("raceStart: Mogollon Monster 100 — Arizona never observes DST", () => {
  // 2026-09-12 06:00 MST (UTC-7) → 13:00 Z.
  assert.equal(
    raceStart("2026-09-12", "06:00", "America/Phoenix").toISOString(),
    "2026-09-12T13:00:00.000Z",
  );
  // ...and the same wall clock in midwinter resolves with the same offset,
  // because Phoenix has exactly one offset all year.
  assert.equal(zoneOffsetMinutes(raceStart("2026-01-12", "06:00", "America/Phoenix"), "America/Phoenix"), -420);
});

test("raceStart: San Juan Softie 100 — Denver is on MDT in August", () => {
  // 2027-08-13 06:00 MDT (UTC-6) → 12:00 Z.
  assert.equal(
    raceStart("2027-08-13", "06:00", "America/Denver").toISOString(),
    "2027-08-13T12:00:00.000Z",
  );
});

test("raceStart: the same wall clock straddling a DST transition", () => {
  // US DST 2027 begins 02:00 on Sunday 2027-03-14 (second Sunday in March).
  // 23:00 the evening before is MST (UTC-7); 23:00 the evening after is MDT
  // (UTC-6). A naive `new Date("2027-03-14T23:00:00")` in a fixed-offset world
  // gets one of these wrong.
  assert.equal(
    raceStart("2027-03-13", "23:00", "America/Denver").toISOString(),
    "2027-03-14T06:00:00.000Z",
  );
  assert.equal(
    raceStart("2027-03-14", "23:00", "America/Denver").toISOString(),
    "2027-03-15T05:00:00.000Z",
  );
  assert.equal(zoneOffsetMinutes(Date.UTC(2027, 2, 13), "America/Denver"), -420);
  assert.equal(zoneOffsetMinutes(Date.UTC(2027, 2, 15), "America/Denver"), -360);

  // A wall clock inside the spring-forward gap (02:00–03:00 never happens)
  // resolves to the correspondingly shifted instant, 03:30 MDT.
  assert.equal(
    raceStart("2027-03-14", "02:30", "America/Denver").toISOString(),
    "2027-03-14T08:30:00.000Z",
  );
  // A repeated wall clock in the fall-back hour picks the first occurrence,
  // 01:30 MDT rather than 01:30 MST.
  assert.equal(
    raceStart("2027-11-07", "01:30", "America/Denver").toISOString(),
    "2027-11-07T07:30:00.000Z",
  );

  // Southern-hemisphere DST runs the other way: Sydney shifts forward on
  // 2027-10-03, so the same October wall clock is UTC+10 then UTC+11.
  assert.equal(zoneOffsetMinutes(raceStart("2027-10-02", "12:00", "Australia/Sydney"), "Australia/Sydney"), 600);
  assert.equal(zoneOffsetMinutes(raceStart("2027-10-04", "12:00", "Australia/Sydney"), "Australia/Sydney"), 660);
});

test("raceLocalParts: fields are race-local, never machine-local", () => {
  const start = raceStart("2026-09-12", "06:00", "America/Phoenix");
  assert.deepEqual(raceLocalParts(start, "America/Phoenix"), {
    year: 2026,
    month: 9,
    day: 12,
    hour: 6,
    minute: 0,
    weekday: 6, // Saturday
    iso: "2026-09-12",
  });

  // The very same instant, read in three other zones.
  assert.equal(raceLocalParts(start, "UTC").iso, "2026-09-12");
  assert.equal(raceLocalParts(start, "UTC").hour, 13);
  const auckland = raceLocalParts(start, "Pacific/Auckland");
  assert.equal(auckland.iso, "2026-09-13"); // next calendar day across the line
  assert.equal(auckland.weekday, 0); // Sunday
  assert.equal(auckland.hour, 1);

  // Mid-race, 20 h in: still Saturday evening in Arizona.
  const night = new Date(start.getTime() + 20 * 3600 * 1000);
  const parts = raceLocalParts(night, "America/Phoenix");
  assert.equal(parts.iso, "2026-09-13");
  assert.equal(parts.hour, 2);
});

test("weekdayName: a Saturday race and a Friday race", () => {
  assert.equal(weekdayName("2026-09-12", "America/Phoenix"), "Saturday");
  assert.equal(weekdayName("2027-08-13", "America/Denver"), "Friday");

  // Also accepts an instant, resolved in the race's zone.
  const start = raceStart("2027-08-13", "06:00", "America/Denver");
  assert.equal(weekdayName(start, "America/Denver"), "Friday");
  // That instant is already Saturday in Auckland — the zone argument decides.
  assert.equal(weekdayName(start, "Pacific/Auckland"), "Saturday");

  // offsetDays walks calendar days, including across month and year ends.
  assert.equal(weekdayName("2027-08-13", "America/Denver", { offsetDays: -1 }), "Thursday");
  assert.equal(weekdayName("2027-08-13", "America/Denver", { offsetDays: 1 }), "Saturday");
  assert.equal(weekdayName("2027-03-01", "America/Denver", { offsetDays: -1 }), "Sunday"); // 2027-02-28
  assert.equal(weekdayName("2028-03-01", "America/Denver", { offsetDays: -1 }), "Tuesday"); // leap day
  assert.equal(weekdayName("2027-01-01", "America/Denver", { offsetDays: -1 }), "Thursday"); // 2026-12-31
});

test("raceWeekLabels: race-week protocol weekdays", () => {
  // San Juan Softie 100 — Friday gun.
  assert.deepEqual(raceWeekLabels("2027-08-13", "America/Denver"), {
    d3: "Tuesday",
    d2: "Wednesday",
    d1: "Thursday",
    raceDay: "Friday",
  });
  // Mogollon Monster 100 — Saturday gun. The prose shifts by one day.
  assert.deepEqual(raceWeekLabels("2026-09-12", "America/Phoenix"), {
    d3: "Wednesday",
    d2: "Thursday",
    d1: "Friday",
    raceDay: "Saturday",
  });
  // A Monday race reaches back into the previous week.
  assert.deepEqual(raceWeekLabels("2027-04-19", "America/New_York"), {
    d3: "Friday",
    d2: "Saturday",
    d1: "Sunday",
    raceDay: "Monday",
  });
});

test("isValidTimeZone", () => {
  assert.equal(isValidTimeZone("America/Denver"), true);
  assert.equal(isValidTimeZone("America/Phoenix"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("US/Arizona"), true); // legacy alias Intl still accepts
  assert.equal(isValidTimeZone("Mars/Olympus_Mons"), false);
  assert.equal(isValidTimeZone("MST7MDT-nope"), false);
  assert.equal(isValidTimeZone(""), false);
  assert.equal(isValidTimeZone(null), false);
  assert.equal(isValidTimeZone(undefined), false);
  assert.equal(isValidTimeZone(42), false);
});

test("bad inputs throw rather than silently producing an Invalid Date", () => {
  assert.throws(() => raceStart("9/12/2026", "06:00", "America/Phoenix"), TypeError);
  assert.throws(() => raceStart("2026-09-12", "6am", "America/Phoenix"), TypeError);
  assert.throws(() => raceStart("2026-09-12", "25:00", "America/Phoenix"), RangeError);
  assert.throws(() => raceLocalParts("not a date", "America/Phoenix"), TypeError);
});
