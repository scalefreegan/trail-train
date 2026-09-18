// Race-week protocol prose (PRD §7).
//
// The nutrition page's "before" section is the one place in the app where a
// weekday is stated as a fact rather than derived — "Nothing after noon
// Friday" is an instruction someone follows, and on a Friday race it would be
// a day late. web/src/race/raceWeek.ts generates those strings from the race
// date + IANA zone, so what is pinned here is the FULL SET of rendered
// strings for a Saturday race and for a Friday race: a shift of one day shows
// up as a failing snapshot rather than as prose nobody re-read.
//
// The .ts source is imported directly (Node strips the types, node >= 22.18)
// like scripts/features.test.mjs — raceWeek.ts imports only a TYPE from
// ./clock, so nothing else is pulled in at runtime. The labels themselves
// come from scripts/clock.mjs, the Node twin of web/src/race/clock.ts, which
// also keeps the twins honest: the prose is only right if both agree.
//
// Zone-proof: run under `TZ=Pacific/Auckland node --test scripts/` and the
// weekdays do not move.

import test from "node:test";
import assert from "node:assert/strict";

import { raceWeekProse } from "../web/src/race/raceWeek.ts";
import { raceWeekLabels } from "./clock.mjs";

/** Mogollon Monster 100 2026 — Saturday 06:00, Arizona (no DST). */
const MM100 = { date: "2026-09-12", timezone: "America/Phoenix" };
/** San Juan Softie 2027 — Friday 06:00 Mountain, the race that broke this. */
const SOFTIE = { date: "2027-08-13", timezone: "America/Denver" };

const prose = (r) => raceWeekProse(raceWeekLabels(r.date, r.timezone));

test("a Saturday race reads exactly as the page always has", () => {
  assert.deepEqual(prose(MM100), {
    gun: "wed → the gun",
    loadDays: "thu–fri",
    loadDaysAbbr: "Thu & Fri",
    loadDaysLong: "Thursday and Friday",
    dayBefore: "Friday",
    caffeineCutoff: "Nothing after noon Friday.",
    taperDays: "wed–fri",
    taperDaysAbbr: "Wed–Fri",
    sleepDays: "tue–thu",
    sleepBank: "Tuesday through Thursday",
    sleepWriteOff: "Treat Friday night as a write-off.",
    nightAfter: "Sunday",
    weekEnd: "Monday",
  });
});

test("a Friday race moves every day back by one", () => {
  assert.deepEqual(prose(SOFTIE), {
    gun: "tue → the gun",
    loadDays: "wed–thu",
    loadDaysAbbr: "Wed & Thu",
    loadDaysLong: "Wednesday and Thursday",
    dayBefore: "Thursday",
    caffeineCutoff: "Nothing after noon Thursday.",
    taperDays: "tue–thu",
    taperDaysAbbr: "Tue–Thu",
    sleepDays: "mon–wed",
    sleepBank: "Monday through Wednesday",
    sleepWriteOff: "Treat Thursday night as a write-off.",
    nightAfter: "Saturday",
    weekEnd: "Sunday",
  });
});

test("the week wraps: a Monday race banks sleep the previous week", () => {
  // D-4 is the previous Thursday and D+2 the following Wednesday — the
  // arithmetic has to go round the array in both directions.
  const p = prose({ date: "2026-09-14", timezone: "America/Phoenix" }); // Monday
  assert.equal(p.sleepBank, "Thursday through Saturday");
  assert.equal(p.gun, "fri → the gun");
  assert.equal(p.nightAfter, "Tuesday");
  assert.equal(p.weekEnd, "Wednesday");
});

test("the zone decides the weekday, not the machine", () => {
  // 2026-09-12 in Kiritimati (UTC+14) is still a Saturday race locally; the
  // point is that nothing here reads the process's own zone.
  assert.equal(prose({ date: "2026-09-12", timezone: "Pacific/Kiritimati" }).gun, "wed → the gun");
  assert.equal(prose({ date: "2026-09-12", timezone: "Pacific/Midway" }).gun, "wed → the gun");
});
