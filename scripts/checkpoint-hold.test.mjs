// checkpointHold — the race-day hold a tracker checkpoint or a typed
// "passed <station> at HH:MM" resolves to. PRD v2 §4, bead tt-cv1b0.6.
//
// BOTH TWINS ARE TESTED IDENTICALLY. scripts/checkpoint-hold.mjs is what the
// Node side imports; web/src/race/checkpointHold.ts is what the app bundles
// and what the static crew export (bead 08) embeds. Every case below runs
// against each, so a fix landed in one and forgotten in the other fails here
// rather than on a ridge at mile 60.
//
// The .ts source is imported directly, the way scripts/race-day-hold.test.mjs
// and scripts/features.test.mjs do: node strips the types, and checkpointHold
// .ts imports nothing at all, so the test reads exactly what ships.

import test from "node:test";
import assert from "node:assert/strict";

import * as mjs from "./checkpoint-hold.mjs";
import * as ts from "../web/src/race/checkpointHold.ts";

/** The two implementations, run through the same assertions. */
const TWINS = [
  ["scripts/checkpoint-hold.mjs", mjs],
  ["web/src/race/checkpointHold.ts", ts],
];

/** Registers one case against both twins. */
function both(name, fn) {
  for (const [label, impl] of TWINS) test(`${name} · ${label}`, () => fn(impl));
}

const TZ = "America/Denver";
/** 2027-08-13 06:00 MDT (UTC−6) — the Softie's shape: a Friday 6am gun. */
const START = new Date("2027-08-13T12:00:00Z");

/** The Softie's chart, trimmed to what a hold needs. */
const COURSE = {
  aid_stations: [
    { name: "Cascade #1", total_mi: 8.3 },
    { name: "EMT #2", total_mi: 19.5 },
    { name: "Sherman #4", total_mi: 40.2 },
    { name: "Burnett", total_mi: 71.6 },
    { name: "Finish", total_mi: 100.4 },
  ],
};

/* ------------------------------ nothing ------------------------------- */

both("an empty observation is no hold at all", (m) => {
  assert.equal(m.checkpointHold(null, COURSE, START, TZ), null);
  assert.equal(m.checkpointHold({}, COURSE, START, TZ), null);
  assert.equal(m.checkpointHold({ station: "   ", clock: "" }, COURSE, START, TZ), null);
});

/* ------------------------------- miles -------------------------------- */

both("a station name resolves to its chart mile", (m) => {
  const hold = m.checkpointHold({ station: "Burnett", clock: "21:22" }, COURSE, START, TZ, { now: START });
  assert.equal(hold.mile, 71.6);
});

both("the chart is matched past case, spacing and the ordinal", (m) => {
  assert.equal(m.stationMile("burnett", COURSE), 71.6);
  assert.equal(m.stationMile("  EMT  #2 ", COURSE), 19.5);
  // the tracker's own label carries the ordinal the chart may not
  assert.equal(m.stationMile("Burnett #7", COURSE), 71.6);
  assert.equal(m.stationMile("Sherman", COURSE), 40.2);
});

both("a station nothing on the chart is leaves the mile null", (m) => {
  // NOT a guess: holding the runner at the wrong mile is worse than not
  // holding them at all, so an unmatched label reports no position.
  const hold = m.checkpointHold({ station: "Timing Mat 3", clock: "09:00" }, COURSE, START, TZ, { now: START });
  assert.equal(hold.mile, null);
  assert.ok(hold.elapsed_h > 0, "the clock still resolves even with no mile");
});

both("a bare array of stations is accepted as the course", (m) => {
  assert.equal(m.stationMile("Burnett", COURSE.aid_stations), 71.6);
  assert.equal(m.stationMile("Burnett", []), null);
  assert.equal(m.stationMile("Burnett", null), null);
});

/* ------------------------------ the clock ----------------------------- */

both("a clock later the same day is hours since the gun", (m) => {
  // 06:00 gun, seen at 09:22 → 3h22
  const hold = m.checkpointHold({ station: "Cascade #1", clock: "09:22" }, COURSE, START, TZ, {
    now: new Date("2027-08-13T16:00:00Z"),
  });
  assert.equal(hold.elapsed_h, 3 + 22 / 60);
});

both("the gun itself is elapsed zero", (m) => {
  const hold = m.checkpointHold({ station: "Cascade #1", clock: "06:00" }, COURSE, START, TZ, {
    now: new Date("2027-08-13T13:00:00Z"),
  });
  assert.equal(hold.elapsed_h, 0);
});

both("a clock past midnight rolls to the next race day", (m) => {
  // 02:04 read at 03:00 on the SECOND morning is 20h04 into the race, not a
  // negative four hours before the gun.
  const hold = m.checkpointHold({ station: "Burnett", clock: "02:04" }, COURSE, START, TZ, {
    now: new Date("2027-08-14T09:00:00Z"),
  });
  assert.equal(hold.elapsed_h, 20 + 4 / 60);
});

both("a manual entry on the second afternoon means the second afternoon", (m) => {
  // The bug the `now` horizon exists for: "earliest non-negative day" would
  // read this as 8h06 into a race that is 32h old.
  const hold = m.checkpointHold({ station: "Burnett", clock: "14:05" }, COURSE, START, TZ, {
    now: new Date("2027-08-14T20:10:00Z"), // Sat 14:10 MDT
  });
  assert.equal(hold.elapsed_h, 32 + 5 / 60);
});

both("a clock a few minutes ahead of now is still today", (m) => {
  // a phone three minutes fast must not throw the hold 24 hours forward
  const hold = m.checkpointHold({ station: "Cascade #1", clock: "09:22" }, COURSE, START, TZ, {
    now: new Date("2027-08-13T15:20:00Z"), // 09:20 MDT, two minutes BEFORE
  });
  assert.equal(hold.elapsed_h, 3 + 22 / 60);
});

both("the tracker's own elapsed picks the day when it disagrees with now", (m) => {
  // A tracker that has been up for a day answers with a checkpoint from the
  // FIRST evening; `now` alone would snap 21:22 to the most recent one.
  const hold = m.checkpointHold(
    { station: "Burnett", clock: "21:22", elapsed_h: 15.3, source: "opensplittime" },
    COURSE, START, TZ,
    { now: new Date("2027-08-14T20:00:00Z") },
  );
  assert.equal(hold.elapsed_h, 15 + 22 / 60);
});

both("elapsed_h carries the hold when there is no clock", (m) => {
  const hold = m.checkpointHold(
    { station: "Sherman #4", elapsed_h: 12.5, source: "opensplittime" }, COURSE, START, TZ,
  );
  assert.equal(hold.elapsed_h, 12.5);
  assert.equal(hold.mile, 40.2);
  // 06:00 + 12h30 = 18:30 on the race's clock
  assert.equal(hold.label, "tracker · 18:30");
});

both("an unparseable clock falls back rather than throwing", (m) => {
  const hold = m.checkpointHold({ station: "Burnett", clock: "9:22PM" }, COURSE, START, TZ, { now: START });
  assert.equal(hold.elapsed_h, null);
  assert.equal(hold.mile, 71.6);
  assert.equal(hold.label, "manual");
  assert.equal(m.checkpointHold({ station: "Burnett", clock: "26:00" }, COURSE, START, TZ, { now: START }).elapsed_h, null);
});

/* ------------------------------ the zone ------------------------------ */

both("the clock is read in the RACE's zone, not the reader's", (m) => {
  // Same gun expressed as an instant; the browser could be anywhere.
  const chamonix = new Date("2027-08-27T14:00:00Z"); // 16:00 CEST
  const hold = m.checkpointHold({ station: "Burnett", clock: "23:30" }, COURSE, chamonix, "Europe/Paris", {
    now: new Date("2027-08-27T22:00:00Z"),
  });
  assert.equal(hold.elapsed_h, 7.5);
});

both("a clock across the autumn DST fold still lands on the right instant", (m) => {
  // US fall-back 2027-11-07: 02:00 MDT → 01:00 MST. A midnight gun, a
  // checkpoint at 05:00, and the day gains an hour: 5 wall-clock hours are 6
  // real ones.
  const gun = new Date("2027-11-07T06:00:00Z"); // 2027-11-07 00:00 MDT
  const hold = m.checkpointHold({ station: "Burnett", clock: "05:00" }, COURSE, gun, TZ, {
    now: new Date("2027-11-07T13:00:00Z"),
  });
  assert.equal(hold.elapsed_h, 6);
});

/* --------------------- the race's own window (cutoffH) ----------------- */
//
// PR #24 review round 3, MEDIUM finding: PRD-v2.md §10 attributed the
// cutoff+slack window clamp to THIS function, but it lived only in
// web/src/crew/checkpoint.ts's resolveClockElapsed/applyCheckpoint —
// checkpointHold itself still resolved a bare HH:MM to "latest occurrence
// before now," capped only at MAX_SPAN_DAYS (14 days). RaceDay.tsx:399-412
// calls checkpointHold for a manual hold even when the race is long past
// (only tracker polling is gated on !racePast), with a live `now` — so
// reopening an old race's page could resolve a typed HH:MM to an occurrence
// up to 14 days off. opts.cutoffH gives checkpointHold the same
// [start, start + cutoff_h + RACE_WINDOW_SLACK_H] clamp applyCheckpoint
// already had, with MAX_SPAN_DAYS kept as the fallback when no cutoff is
// known (unchanged behavior for that case — see the next test).

both("a manual hold on a long-past race clamps to the race's own window, not to `now`", (m) => {
  // "14:05" is ambiguous across every day of a 30-day-old race; without a
  // cutoff the horizon is `now` itself (30 days out). With cutoffH: 30 (a
  // ~33h window incl. the 3h slack), the only in-window occurrences are day
  // 0 (8h05 in) and day 1 (32h05 in) — day 2 (56h05) is already past the
  // close, so day 1 must win, not some day-14+ occurrence `now` would pick.
  const hold = m.checkpointHold({ station: "Burnett", clock: "14:05" }, COURSE, START, TZ, {
    now: new Date("2027-09-12T20:10:00Z"), // 30 days after the gun
    cutoffH: 30,
  });
  assert.equal(hold.elapsed_h, 32 + 5 / 60);
});

both("without a cutoff, MAX_SPAN_DAYS stays the only ceiling — unchanged fallback behavior", (m) => {
  // Same ambiguous clock, same far-future `now`, no cutoffH: this is the
  // pre-existing, acknowledged limitation (PRD's "manual + revisited past
  // race" gap) that MAX_SPAN_DAYS bounds rather than fixes. Locked here so a
  // future change to the cutoffH path can't silently also change this one.
  const hold = m.checkpointHold({ station: "Burnett", clock: "14:05" }, COURSE, START, TZ, {
    now: new Date("2027-09-12T20:10:00Z"), // 30 days after the gun
  });
  assert.equal(hold.elapsed_h, 14 * 24 + 8 + 5 / 60);
});

both("a cutoff far enough out that `now` is still the tighter bound is a no-op", (m) => {
  // During a live race, `now` is well inside [start, start+cutoff+slack] —
  // cutoffH must not change the answer for the ordinary, non-stale case.
  const hold = m.checkpointHold({ station: "Burnett", clock: "14:05" }, COURSE, START, TZ, {
    now: new Date("2027-08-14T20:10:00Z"), // Sat 14:10 MDT, ~32h in
    cutoffH: 40,
  });
  assert.equal(hold.elapsed_h, 32 + 5 / 60);
});

both("a non-finite or absent cutoffH is treated exactly like no cutoffH at all", (m) => {
  const withoutOpt = m.checkpointHold({ station: "Burnett", clock: "14:05" }, COURSE, START, TZ, {
    now: new Date("2027-09-12T20:10:00Z"),
  });
  for (const bad of [null, undefined, NaN, "30"]) {
    const hold = m.checkpointHold({ station: "Burnett", clock: "14:05" }, COURSE, START, TZ, {
      now: new Date("2027-09-12T20:10:00Z"),
      cutoffH: bad,
    });
    assert.equal(hold.elapsed_h, withoutOpt.elapsed_h, `cutoffH: ${JSON.stringify(bad)}`);
  }
});

/* ------------------------------- labels ------------------------------- */

both("a tracker checkpoint is labelled tracker · HH:MM", (m) => {
  const hold = m.checkpointHold(
    { station: "Burnett", clock: "21:22", source: "opensplittime" }, COURSE, START, TZ,
    { now: new Date("2027-08-14T04:00:00Z") },
  );
  assert.equal(hold.label, "tracker · 21:22");
  // `source` keeps the adapter id — the LABEL is what the screen prints
  assert.equal(hold.source, "opensplittime");
});

both("a typed entry is manual, with no source given", (m) => {
  const hold = m.checkpointHold({ station: "Burnett", clock: "21:22" }, COURSE, START, TZ, {
    now: new Date("2027-08-14T04:00:00Z"),
  });
  assert.equal(hold.source, "manual");
  assert.equal(hold.label, "manual · 21:22");
});

both("a single-digit hour prints padded", (m) => {
  const hold = m.checkpointHold({ station: "Cascade #1", clock: "9:22" }, COURSE, START, TZ, {
    now: new Date("2027-08-13T16:00:00Z"),
  });
  assert.equal(hold.label, "manual · 09:22");
});

/* --------------------------- the twins agree -------------------------- */

test("both twins answer every case identically", () => {
  const cases = [
    [{ station: "Burnett", clock: "21:22", source: "opensplittime" }, new Date("2027-08-14T04:00:00Z")],
    [{ station: "Burnett", clock: "02:04" }, new Date("2027-08-14T09:00:00Z")],
    [{ station: "Sherman", elapsed_h: 12.5 }, new Date("2027-08-14T04:00:00Z")],
    [{ station: "Nowhere", clock: "12:00" }, new Date("2027-08-13T19:00:00Z")],
    [{ clock: "12:00" }, new Date("2027-08-13T19:00:00Z")],
    [{}, START],
  ];
  for (const [cp, now] of cases) {
    assert.deepEqual(
      mjs.checkpointHold(cp, COURSE, START, TZ, { now }),
      ts.checkpointHold(cp, COURSE, START, TZ, { now }),
      `twins disagree on ${JSON.stringify(cp)}`,
    );
  }
});

test("both twins answer every cutoffH case identically", () => {
  const cases = [
    [{ station: "Burnett", clock: "14:05" }, new Date("2027-09-12T20:10:00Z"), 30],
    [{ station: "Burnett", clock: "14:05" }, new Date("2027-09-12T20:10:00Z"), null],
    [{ station: "Burnett", clock: "14:05" }, new Date("2027-08-14T20:10:00Z"), 40],
    [{ station: "Burnett", clock: "14:05" }, new Date("2027-09-12T20:10:00Z"), NaN],
  ];
  for (const [cp, now, cutoffH] of cases) {
    assert.deepEqual(
      mjs.checkpointHold(cp, COURSE, START, TZ, { now, cutoffH }),
      ts.checkpointHold(cp, COURSE, START, TZ, { now, cutoffH }),
      `twins disagree on ${JSON.stringify(cp)} cutoffH=${JSON.stringify(cutoffH)}`,
    );
  }
});

test("the hold's shape is the four keys bead 08 embeds", () => {
  for (const [label, m] of TWINS) {
    const hold = m.checkpointHold({ station: "Burnett", clock: "21:22" }, COURSE, START, TZ, { now: START });
    assert.deepEqual(Object.keys(hold).sort(), ["elapsed_h", "label", "mile", "source"], label);
  }
});

test("the client twin imports nothing — it has to be copy-pasteable", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../web/src/race/checkpointHold.ts", import.meta.url), "utf8");
  assert.equal(
    /^\s*import\s/m.test(src),
    false,
    "checkpointHold.ts must stay zero-import: the crew export (bead 08) inlines it with no module graph",
  );
});
