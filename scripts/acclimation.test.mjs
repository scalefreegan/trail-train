// deriveArrival — where the acclimation day count comes from.
//
// The interesting failures here are not arithmetic, they are PROVENANCE: a
// derivation that quietly matches the wrong trip hands the projection four
// days of acclimation it has no evidence for, and labels them "from
// calendar". So most of what follows is about what must NOT match.
//
// Every event below is invented. Nothing reads web/public/google-cal.json:
// that file is the author's real calendar.

import test from "node:test";
import assert from "node:assert/strict";
import { deriveArrival, distinctiveWords, daysBetween } from "./acclimation.mjs";

const RACE = {
  date: "2027-08-14",
  name: "San Juan Softie 100",
  short: "Softie",
  location: "Silverton, CO",
};

/** A calendar the way sync-google-cal.mjs writes one. */
const cal = (...events) => ({ fetched_at: "2027-07-01T00:00:00Z", events });

const travel = (summary, start, end = null, location = null) => ({
  id: `e-${summary}-${start}`,
  summary,
  description: "",
  start,
  end,
  all_day: !start.includes("T"),
  location,
  classification: "travel",
});

test("matches the last travel event whose words overlap the race location", () => {
  const a = deriveArrival({
    race: RACE,
    calendar: cal(
      travel("Fly to Silverton", "2027-08-10", "2027-08-16"),
      travel("Dentist follow-up trip", "2027-08-12", "2027-08-13"),
    ),
    today: "2027-07-01",
  });
  assert.equal(a.source, "calendar");
  assert.equal(a.arrival_date, "2027-08-10");
  assert.equal(a.days_at_altitude, 4);
  assert.equal(a.matched_event.summary, "Fly to Silverton");
});

test("matches on the race NAME, not just the location", () => {
  const a = deriveArrival({
    race: RACE,
    calendar: cal(travel("Softie crew weekend", "2027-08-11", "2027-08-16")),
    today: "2027-07-01",
  });
  assert.equal(a.source, "calendar");
  assert.equal(a.days_at_altitude, 3);
});

test("matches on the event's LOCATION field when the title says nothing", () => {
  const a = deriveArrival({
    race: RACE,
    calendar: cal(travel("Flight out", "2027-08-09", "2027-08-10", "Silverton, Colorado")),
    today: "2027-07-01",
  });
  assert.equal(a.source, "calendar");
  assert.equal(a.arrival_date, "2027-08-09");
  assert.equal(a.days_at_altitude, 5);
});

test("the LATER of two matching trips wins", () => {
  const a = deriveArrival({
    race: RACE,
    calendar: cal(
      travel("Silverton recon", "2027-06-05", "2027-06-08"),
      travel("Silverton race week", "2027-08-09", "2027-08-16"),
    ),
    today: "2027-06-01",
  });
  assert.equal(a.arrival_date, "2027-08-09");
});

test("no matching event → the day before the race, source default", () => {
  const a = deriveArrival({
    race: RACE,
    calendar: cal(
      travel("Chicago work trip", "2027-08-02", "2027-08-05"),
      travel("Flight to Boston", "2027-07-20", "2027-07-24"),
    ),
    today: "2027-07-01",
  });
  assert.equal(a.source, "default");
  assert.equal(a.arrival_date, "2027-08-13");
  assert.equal(a.days_at_altitude, 1);
  assert.equal(a.matched_event, undefined);
});

test("an empty / absent calendar falls back to the default, not a crash", () => {
  for (const calendar of [null, undefined, [], { events: [] }, { events: null }]) {
    const a = deriveArrival({ race: RACE, calendar, today: "2027-07-01" });
    assert.equal(a.source, "default", `calendar=${JSON.stringify(calendar)}`);
    assert.equal(a.days_at_altitude, 1);
  }
});

test("an override wins over a matching calendar event", () => {
  const a = deriveArrival({
    race: RACE,
    calendar: cal(travel("Fly to Silverton", "2027-08-10", "2027-08-16")),
    today: "2027-07-01",
    overrideDays: 9,
  });
  assert.equal(a.source, "override");
  assert.equal(a.days_at_altitude, 9);
  assert.equal(a.arrival_date, "2027-08-05");
  assert.equal(a.matched_event, undefined);
});

test("an override of 0 is a real answer (lands race morning), not a missing one", () => {
  const a = deriveArrival({ race: RACE, calendar: cal(travel("Fly to Silverton", "2027-08-10")), overrideDays: 0 });
  assert.equal(a.source, "override");
  assert.equal(a.days_at_altitude, 0);
  assert.equal(a.arrival_date, "2027-08-14");
});

test("a negative or non-numeric override is ignored rather than trusted", () => {
  for (const overrideDays of [-3, NaN, "4", null]) {
    const a = deriveArrival({ race: RACE, calendar: cal(), today: "2027-07-01", overrideDays });
    assert.notEqual(a.source, "override", `overrideDays=${String(overrideDays)}`);
  }
});

test("only `travel` events are candidates — a race-classified event is not an arrival", () => {
  const a = deriveArrival({
    race: RACE,
    calendar: cal({ ...travel("San Juan Softie 100", "2027-08-14"), classification: "race" }),
    today: "2027-07-01",
  });
  assert.equal(a.source, "default");
});

test("a trip that starts after race day is not how you got there", () => {
  const a = deriveArrival({
    race: RACE,
    calendar: cal(travel("Silverton after-party", "2027-08-16", "2027-08-18")),
    today: "2027-07-01",
  });
  assert.equal(a.source, "default");
});

test("a trip already finished before today is not the arrival for a future race", () => {
  const a = deriveArrival({
    race: RACE,
    calendar: cal(travel("Silverton recon", "2027-06-05", "2027-06-08")),
    today: "2027-07-01",
  });
  assert.equal(a.source, "default");
});

test("…but for a race that already happened, the trip that covered it still counts", () => {
  const a = deriveArrival({
    race: RACE,
    calendar: cal(travel("Silverton race week", "2027-08-09", "2027-08-16")),
    today: "2027-09-01",
  });
  assert.equal(a.source, "calendar");
  assert.equal(a.days_at_altitude, 5);
});

test("a same-day arrival credits zero days, not a negative number", () => {
  const a = deriveArrival({
    race: RACE,
    calendar: cal(travel("Drive to Silverton", "2027-08-14", "2027-08-15")),
    today: "2027-08-01",
  });
  assert.equal(a.source, "calendar");
  assert.equal(a.days_at_altitude, 0);
});

test("a timed event's local date is read off the string, not through a timezone", () => {
  // 21:40 on the 9th in Denver. Parsed as a timestamp and rendered in UTC
  // this is the 10th — one day of acclimation silently lost.
  const a = deriveArrival({
    race: RACE,
    calendar: cal(travel("Land in Silverton", "2027-08-09T21:40:00-06:00", "2027-08-09T23:00:00-06:00")),
    today: "2027-08-01",
  });
  assert.equal(a.arrival_date, "2027-08-09");
  assert.equal(a.days_at_altitude, 5);
});

test("a race with no date derives nothing rather than defaulting to one day", () => {
  const a = deriveArrival({ race: { name: "Unnamed", location: "Silverton" }, calendar: cal(), today: "2027-07-01" });
  assert.equal(a.arrival_date, null);
  assert.equal(a.days_at_altitude, 0);
  assert.equal(a.source, "default");
});

test("a race with no location or name matches nothing at all", () => {
  const a = deriveArrival({
    race: { date: "2027-08-14" },
    calendar: cal(travel("Fly to Silverton", "2027-08-10", "2027-08-16")),
    today: "2027-07-01",
  });
  assert.equal(a.source, "default");
});

/* ---- the matcher itself ---- */

test("distinctiveWords drops short, generic and numeric tokens", () => {
  assert.deepEqual([...distinctiveWords("San Juan Softie 100")], ["juan", "softie"]);
  assert.deepEqual([...distinctiveWords("Silverton, CO")], ["silverton"]);
  // every word is furniture — an event titled this can match nothing
  assert.equal(distinctiveWords("Trail race trip 2027").size, 0);
});

test("a three-letter town fragment cannot carry a match on its own", () => {
  // "San Diego" shares "san" with "San Juan Softie" and nothing else. If the
  // token floor were three characters this would be a confident, wrong
  // "from calendar (Fly to San Diego)" on the planner.
  const a = deriveArrival({
    race: RACE,
    calendar: cal(travel("Fly to San Diego", "2027-08-11", "2027-08-13")),
    today: "2027-08-01",
  });
  assert.equal(a.source, "default");
});

test("daysBetween counts calendar days across a DST boundary", () => {
  assert.equal(daysBetween("2027-03-13", "2027-03-15"), 2); // US spring-forward is the 14th
  assert.equal(daysBetween("2027-11-06", "2027-11-08"), 2); // fall-back is the 7th
  assert.equal(daysBetween("2027-08-14", "2027-08-14"), 0);
});
