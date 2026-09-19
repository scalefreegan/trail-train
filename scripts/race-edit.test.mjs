// scripts/race-edit.mjs — the review dialog's write gate.
//
// Two questions, asked the way the dev server asks them: what may a PUT change
// (and what must it refuse), and when may a draft become the active race.

import test from "node:test";
import assert from "node:assert/strict";
import {
  EDITABLE_AID_FIELDS,
  EDITABLE_RACE_KEYS,
  acknowledgedPaths,
  applyBlockTargetsEdit,
  applyRaceEdit,
  applyStatus,
  isBlockStale,
  loadReview,
  otherActiveSlugs,
  pruneAcknowledgedNulls,
  recomputeUnresolved,
  unresolvedFromMatches,
  validateRaceEdit,
  validateStatusTransition,
  valueAtPath,
} from "./race-edit.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { raceStart, raceLocalParts } from "./clock.mjs";

/** A minimal race.json that validateRaceJson accepts outright. `sun` is set
    (features.night defaults to ON, and validateStatusTransition now refuses
    activation of a night race with no computed sun) — the dedicated
    sun-gate tests below override it back to null/absent explicitly. */
function race(over = {}) {
  return {
    schema_version: 1,
    slug: "test-race-2027",
    status: "draft",
    name: "Test Race 100",
    short: "TR100",
    date: "2027-08-13",
    start_time: "06:00",
    timezone: "America/Denver",
    distance_mi: 100,
    gain_ft: 20000,
    cutoff_h: 36,
    sun: { sunset: "20:14", sunrise: "06:02" },
    aid_stations: [
      { name: "Start", total_mi: 0, cutoff_h: null, crew: true, drop_bag: false, pacers: false },
      { name: "Cross Mountain", total_mi: 45.8, cutoff_h: 16, crew: true, drop_bag: true, pacers: true },
      { name: "Finish", total_mi: 100, cutoff_h: 36, crew: true, drop_bag: false, pacers: false },
    ],
    provenance: {
      name: { by: "agent", at: "2026-01-01T00:00:00.000Z", source: "race-intake" },
      sun: { by: "computed", at: "2026-01-01T00:00:00.000Z", source: "scripts/race-sun.mjs" },
    },
    ...over,
  };
}

const AT = "2026-09-18T12:00:00.000Z";
const ctx = { stationCount: 3 };

/* --------------------------- accepted subset ---------------------------- */

test("validateRaceEdit accepts the fields the review screen renders", () => {
  const r = validateRaceEdit({
    aid_stations: [{ index: 1, name: "Cross Mtn", total_mi: 45.9, cutoff_h: 16.5, crew: true, drop_bag: false, pacers: true, gpx_wpt: "CROSS MTN" }],
    date: "2027-08-13",
    visual: { theme_preset: "alpine" },
    unresolved_acknowledged: true,
    block_targets: [{ wk: 1, target_dist: 40, target_elev: 6000 }],
  }, ctx);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.code, null);
});

test("validateRaceEdit accepts a null cutoff and a null gpx_wpt — both mean \"none posted\"", () => {
  const r = validateRaceEdit({ aid_stations: [{ index: 0, cutoff_h: null, gpx_wpt: null }] }, ctx);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("the editable field lists are the ones the module documents", () => {
  assert.deepEqual(EDITABLE_AID_FIELDS, ["name", "total_mi", "cutoff_h", "crew", "drop_bag", "pacers", "gpx_wpt"]);
  assert.deepEqual(EDITABLE_RACE_KEYS, [
    "aid_stations", "date", "visual", "unresolved_acknowledged", "block_targets", "unresolved_fills",
  ]);
});

/* ------------------------------ refusals -------------------------------- */

test("validateRaceEdit refuses status — activation is a different endpoint", () => {
  const r = validateRaceEdit({ status: "active" }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_request");
  assert.match(r.errors.join(" "), /status: not an editable field/);
  assert.match(r.errors.join(" "), /POST \/api\/races\/:slug\/status/);
});

test("validateRaceEdit refuses the pointer, provenance and any unknown field, by name", () => {
  for (const key of ["pointer", "mode", "provenance", "slug", "schema_version", "sources", "coach_notes", "wat"]) {
    const r = validateRaceEdit({ [key]: "whatever" }, ctx);
    assert.equal(r.ok, false, `${key} should be refused`);
    assert.match(r.errors.join(" "), new RegExp(`^${key}: not an editable field`));
  }
});

test("validateRaceEdit refuses an aid-station field the table does not render", () => {
  const r = validateRaceEdit({ aid_stations: [{ index: 0, lat: 37.5, notes: "x" }] }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /aid_stations\[0\]\.lat: not an editable aid-station field/);
  assert.match(r.errors.join(" "), /aid_stations\[0\]\.notes: not an editable aid-station field/);
});

test("validateRaceEdit refuses a visual key other than the preset picker", () => {
  const r = validateRaceEdit({ visual: { overrides: { "--lamp": "#fff" } } }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /visual\.overrides: not an editable field/);
});

test("validateRaceEdit bounds the station index to the stations that exist", () => {
  assert.equal(validateRaceEdit({ aid_stations: [{ index: 3, name: "x" }] }, ctx).ok, false);
  assert.equal(validateRaceEdit({ aid_stations: [{ index: -1, name: "x" }] }, ctx).ok, false);
  assert.equal(validateRaceEdit({ aid_stations: [{ index: 1.5, name: "x" }] }, ctx).ok, false);
  assert.equal(validateRaceEdit({ aid_stations: [{ index: 2, name: "x" }] }, ctx).ok, true);
});

test("validateRaceEdit type-checks every accepted field", () => {
  const cases = [
    [{ aid_stations: [{ index: 0, name: "  " }] }, /name: non-empty string/],
    [{ aid_stations: [{ index: 0, total_mi: -1 }] }, /total_mi: non-negative number/],
    [{ aid_stations: [{ index: 0, cutoff_h: 0 }] }, /cutoff_h: positive number or null/],
    [{ aid_stations: [{ index: 0, crew: "yes" }] }, /crew: boolean/],
    [{ aid_stations: [{ index: 0, gpx_wpt: "" }] }, /gpx_wpt: non-empty string or null/],
    [{ date: "8/13/2027" }, /date must be a YYYY-MM-DD/],
    [{ date: "2027-13-01" }, /date must be a YYYY-MM-DD/],
    [{ visual: { theme_preset: 7 } }, /theme_preset: non-empty string/],
    [{ unresolved_acknowledged: "true" }, /unresolved_acknowledged: boolean/],
    [{ block_targets: [{ wk: 0, target_dist: 1, target_elev: 1 }] }, /wk: positive integer/],
    [{ block_targets: [{ wk: 1, target_dist: -1, target_elev: 1 }] }, /target_dist: non-negative number/],
    [{ block_targets: [{ wk: 1, target_dist: 1, target_elev: 1, focus: "x" }] }, /focus: not a block target field/],
    [{ block_targets: [{ wk: 1, target_dist: 1, target_elev: 1 }, { wk: 1, target_dist: 2, target_elev: 2 }] }, /week 1 appears twice/],
    [{}, /nothing to write/],
    ["not an object", /body must be a JSON object/],
  ];
  for (const [body, re] of cases) {
    const r = validateRaceEdit(body, ctx);
    assert.equal(r.ok, false, `${JSON.stringify(body)} should be refused`);
    assert.match(r.errors.join(" | "), re);
  }
});

/* RaceIntake.tsx carries a compatibility fallback: on a 400 whose message
   matches /unresolved_acknowledged: boolean required/ it collapses its
   array to a bare boolean and retries — so a message this server emits for
   a GENUINE error must never accidentally match that exact phrase, or a
   real client bug (e.g. a stray number in the array) would silently get
   retried as "acknowledge everything" instead of surfacing as refused. */
test("unresolved_acknowledged: array-of-wrong-type gets a message distinct from the legacy fallback trigger", () => {
  const r = validateRaceEdit({ unresolved_acknowledged: [1, 2] }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" | "), /array of string field paths required/);
  assert.ok(!/unresolved_acknowledged: boolean required/.test(r.errors.join(" | ")), r.errors.join(" | "));
});

test("unresolved_acknowledged: wrong type entirely also never matches the legacy fallback trigger", () => {
  const r = validateRaceEdit({ unresolved_acknowledged: "true" }, ctx);
  assert.equal(r.ok, false);
  assert.ok(!/unresolved_acknowledged: boolean required/.test(r.errors.join(" | ")), r.errors.join(" | "));
});

test("unresolved_acknowledged accepts a well-formed array or boolean outright", () => {
  assert.equal(validateRaceEdit({ unresolved_acknowledged: ["links.tracking"] }, ctx).ok, true);
  assert.equal(validateRaceEdit({ unresolved_acknowledged: [] }, ctx).ok, true);
  assert.equal(validateRaceEdit({ unresolved_acknowledged: true }, ctx).ok, true);
  assert.equal(validateRaceEdit({ unresolved_acknowledged: false }, ctx).ok, true);
});

test("validateRaceEdit collects every problem rather than stopping at the first", () => {
  const r = validateRaceEdit({ status: "active", date: "nope", visual: { hero: "x" } }, ctx);
  assert.equal(r.errors.length, 3, r.errors.join(" | "));
});

/* -------------- 400 messages name the STATION, not the patch position (R9) ------------- */

test("a validation error names the resolved station — index and name — not its position in the patch array", () => {
  // PR #23 review round 1, resilience finding 9: a save touching only
  // station 2 (patch array position 0) used to report "aid_stations[0]",
  // the patch's own index — not station 2's real index or name.
  const aidStations = race().aid_stations;
  const r = validateRaceEdit({ aid_stations: [{ index: 2, total_mi: -5 }] }, { ...ctx, aidStations });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" | "), /aid_stations\[2\] \(Finish\)\.total_mi: non-negative number required/);
  assert.ok(!r.errors.join(" | ").includes("aid_stations[0]"));
});

test("a validation error falls back to the patch position when the row's own index does not resolve", () => {
  const r = validateRaceEdit({ aid_stations: [{ index: 99, name: "" }] }, { ...ctx, aidStations: race().aid_stations });
  assert.match(r.errors.join(" | "), /aid_stations\[0\]\.index: integer 0\.\.2 required/);
});

/* -------------------------- duplicate gpx_wpt (D3) ----------------------- */

test("validateRaceEdit refuses a gpx_wpt already mapped to a different station, naming both", () => {
  const aidStations = race().aid_stations.map((s, i) => (i === 1 ? { ...s, gpx_wpt: "#1 Cascade" } : s));
  const r = validateRaceEdit({ aid_stations: [{ index: 0, gpx_wpt: "#1 Cascade" }] }, { ...ctx, aidStations });
  assert.equal(r.ok, false);
  assert.match(
    r.errors.join(" | "),
    /aid_stations\[0\] \(Start\)\.gpx_wpt: "#1 Cascade" is already mapped to aid_stations\[1\] \(Cross Mountain\)/,
  );
});

test("validateRaceEdit allows two stations in the same save to swap waypoints with each other", () => {
  const aidStations = race().aid_stations.map((s, i) => (
    i === 0 ? { ...s, gpx_wpt: "A" } : i === 1 ? { ...s, gpx_wpt: "B" } : s
  ));
  const r = validateRaceEdit(
    { aid_stations: [{ index: 0, gpx_wpt: "B" }, { index: 1, gpx_wpt: "A" }] },
    { ...ctx, aidStations },
  );
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("validateRaceEdit does not flag a gpx_wpt against itself when the row also carries other edits", () => {
  const aidStations = race().aid_stations.map((s, i) => (i === 1 ? { ...s, gpx_wpt: "#1 Cascade" } : s));
  const r = validateRaceEdit(
    { aid_stations: [{ index: 1, name: "Cross Mtn", gpx_wpt: "#1 Cascade" }] },
    { ...ctx, aidStations },
  );
  assert.equal(r.ok, true, r.errors.join("; "));
});

/* --------------------------- name length cap (R10) ------------------------ */

test("validateRaceEdit caps an aid-station name (R10)", () => {
  const r = validateRaceEdit({ aid_stations: [{ index: 0, name: "Z".repeat(5000) }] }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" | "), /name: at most 80 characters \(got 5000\)/);

  const ok = validateRaceEdit({ aid_stations: [{ index: 0, name: "Z".repeat(80) }] }, ctx);
  assert.equal(ok.ok, true, ok.errors.join("; "));
});

/* --------------------------- provenance stamp --------------------------- */

test("applyRaceEdit stamps user provenance on every field it changes", () => {
  const { race: next, written } = applyRaceEdit(race(), {
    aid_stations: [{ index: 1, name: "Cross Mtn", gpx_wpt: "CROSS MTN" }],
    date: "2027-08-20",
    visual: { theme_preset: "alpine" },
  }, { at: AT });

  assert.deepEqual(written.sort(), [
    "aid_stations[1].gpx_wpt", "aid_stations[1].name", "date", "visual.theme_preset",
  ]);
  for (const f of written) {
    assert.deepEqual(next.provenance[f], { by: "user", at: AT }, f);
  }
  assert.equal(next.aid_stations[1].name, "Cross Mtn");
  assert.equal(next.aid_stations[1].gpx_wpt, "CROSS MTN");
  assert.equal(next.date, "2027-08-20");
  assert.equal(next.visual.theme_preset, "alpine");
});

test("applyRaceEdit does not stamp a field whose value did not change", () => {
  const before = race();
  const { race: next, written } = applyRaceEdit(before, {
    aid_stations: [{ index: 1, name: "Cross Mountain", total_mi: 45.8 }],
    date: "2027-08-13",
  }, { at: AT });
  assert.deepEqual(written, []);
  // the agent's stamp on `name` survives — a no-op save must not convert the
  // whole draft into user-owned data a re-intake would refuse to update
  assert.equal(next.provenance.name.by, "agent");
});

test("applyRaceEdit does not mutate the race it is given", () => {
  const before = race();
  const snapshot = structuredClone(before);
  applyRaceEdit(before, { date: "2027-09-01", aid_stations: [{ index: 0, crew: false }] }, { at: AT });
  assert.deepEqual(before, snapshot);
});

/* ------------------- seg_mi / cutoff_clock stay consistent (D9) ---------- */

test("applyRaceEdit recomputes seg_mi and cutoff_clock when total_mi or cutoff_h changes", () => {
  const before = race({
    aid_stations: [
      { name: "Start", total_mi: 0, cutoff_h: null, crew: true, drop_bag: false, pacers: false },
      { name: "Ryman Creek #9", total_mi: 71.3, cutoff_h: 26, crew: true, drop_bag: true, pacers: true },
      { name: "Corral #9", total_mi: 79.9, cutoff_h: 29.5, crew: true, drop_bag: true, pacers: true },
      { name: "Finish", total_mi: 100, cutoff_h: 36, crew: true, drop_bag: false, pacers: false },
    ],
  });
  const { race: next } = applyRaceEdit(before, {
    aid_stations: [{ index: 2, name: "Corral #9 (Coral)", total_mi: 80.2, cutoff_h: 30 }],
  }, { at: AT });

  // PR #23 review round 1, draft finding 9's exact repro: seg_mi used to
  // stay at the PRE-edit 8.6 and cutoff_clock at the PRE-edit 11:30, and the
  // NEXT station's seg_mi (Finish) was untouched too.
  assert.equal(next.aid_stations[2].seg_mi, 8.9); // 80.2 - 71.3
  assert.equal(next.aid_stations[3].seg_mi, 19.8); // 100 - 80.2
  assert.equal(next.aid_stations[1].seg_mi, 71.3); // recomputed on the same pass, value unchanged

  const expectedClock = raceLocalParts(
    new Date(raceStart(next.date, next.start_time, next.timezone).getTime() + 30 * 3600000),
    next.timezone,
  );
  const hh = String(expectedClock.hour).padStart(2, "0");
  const mm = String(expectedClock.minute).padStart(2, "0");
  assert.equal(next.aid_stations[2].cutoff_clock, `${hh}:${mm}`);
});

test("applyRaceEdit leaves cutoff_clock null when the race has no date/timezone yet (legal for a draft)", () => {
  const before = race({ date: null, timezone: null });
  const { race: next } = applyRaceEdit(before, {
    aid_stations: [{ index: 1, cutoff_h: 20 }],
  }, { at: AT });
  assert.equal(next.aid_stations[1].cutoff_clock, null);
});

test("applyRaceEdit does not touch seg_mi/cutoff_clock when neither total_mi nor cutoff_h is edited", () => {
  const before = race();
  const { race: next } = applyRaceEdit(before, { aid_stations: [{ index: 1, crew: false }] }, { at: AT });
  assert.equal(next.aid_stations[1].seg_mi, undefined);
  assert.equal(next.aid_stations[1].cutoff_clock, undefined);
});

test("applyRaceEdit returns block targets narrowed to the three keys block.json holds", () => {
  const { race: next, block_targets, written } = applyRaceEdit(race(), {
    block_targets: [{ wk: 1, target_dist: 40, target_elev: 6000 }],
  }, { at: AT });
  assert.deepEqual(block_targets, [{ wk: 1, target_dist: 40, target_elev: 6000 }]);
  assert.ok(written.includes("block.targets"));
  // Ownership is stamped on block.json itself (applyBlockTargetsEdit) — see
  // that test below — not on race.provenance, which nothing ever read.
  assert.ok(!("block.targets" in (next.provenance ?? {})));
});

test("applyBlockTargetsEdit stamps block.json's own provenance, keeping the rest of the file", () => {
  const block = { start_date: "2027-05-24", total_weeks: 12, targets: [{ wk: 1, target_dist: 30, target_elev: 4000 }] };
  const next = applyBlockTargetsEdit(block, [{ wk: 1, target_dist: 40, target_elev: 6000 }], { at: AT });
  assert.deepEqual(next.targets, [{ wk: 1, target_dist: 40, target_elev: 6000 }]);
  assert.deepEqual(next.provenance, { targets: { by: "user", at: AT } });
  assert.equal(next.start_date, "2027-05-24", "unrelated block fields survive");
  assert.equal(next.total_weeks, 12);
  assert.deepEqual(block.targets, [{ wk: 1, target_dist: 30, target_elev: 4000 }], "the input block is not mutated");
});

test("applyBlockTargetsEdit preserves other provenance keys a future field might add", () => {
  const block = { targets: [], provenance: { start_date: { by: "computed", at: "2027-01-01T00:00:00Z" } } };
  const next = applyBlockTargetsEdit(block, [{ wk: 1, target_dist: 1, target_elev: 1 }], { at: AT });
  assert.deepEqual(next.provenance.start_date, { by: "computed", at: "2027-01-01T00:00:00Z" });
  assert.deepEqual(next.provenance.targets, { by: "user", at: AT });
});

test("applyRaceEdit records an explicit acknowledgement list as a user-provenance field", () => {
  const before = race({ unresolved: ["links.tracking", "elevation.min_ft"] });
  const { race: next, written } = applyRaceEdit(before, { unresolved_acknowledged: ["links.tracking"] }, { at: AT });
  assert.deepEqual(next.unresolved_acknowledged, ["links.tracking"]);
  assert.deepEqual(next.provenance.unresolved_acknowledged, { by: "user", at: AT });
  assert.deepEqual(written, ["unresolved_acknowledged"]);
});

test("applyRaceEdit expands a body-provided boolean against the folder's stored unresolved when no live list is given", () => {
  const before = race({ unresolved: ["links.tracking", "elevation.min_ft"] });
  const { race: next } = applyRaceEdit(before, { unresolved_acknowledged: true }, { at: AT });
  assert.deepEqual(next.unresolved_acknowledged, ["elevation.min_ft", "links.tracking"]);
});

test("applyRaceEdit expands a body-provided boolean against the LIVE unresolved list when given (currentUnresolved)", () => {
  // RaceIntake.tsx's compatibility fallback sends `true` to mean "acknowledge
  // every path the review screen shows right now" — which includes
  // matcher/sun/course-mismatch entries loadReview computes live and NEVER
  // persists to race.json's own `unresolved` (see loadReview's comments).
  // The vite PUT handler passes that live list through as `currentUnresolved`;
  // a body-provided `true` must expand against it, not the narrower stored one.
  const before = race({ unresolved: ["links.tracking"] });
  const { race: next } = applyRaceEdit(
    before,
    { unresolved_acknowledged: true },
    { at: AT, currentUnresolved: ["links.tracking", "aid_stations[0].gpx_wpt"] },
  );
  assert.deepEqual(next.unresolved_acknowledged, ["aid_stations[0].gpx_wpt", "links.tracking"]);
});

test("applyRaceEdit's UNCONDITIONAL migration of an already-on-disk legacy boolean still uses only the stored list, never currentUnresolved", () => {
  // The two cases are deliberately different: a save that does not TOUCH
  // acknowledgement must not have currentUnresolved's live extras silently
  // acknowledged just because they happened to be passed through for some
  // OTHER reason on this call.
  const before = race({ unresolved: ["links.tracking"], unresolved_acknowledged: true });
  const { race: next, written } = applyRaceEdit(
    before,
    { date: "2027-08-14" },
    { at: AT, currentUnresolved: ["links.tracking", "aid_stations[0].gpx_wpt"] },
  );
  assert.deepEqual(next.unresolved_acknowledged, ["links.tracking"]);
  assert.ok(!written.includes("unresolved_acknowledged"), written.join(", "));
});

test("applyRaceEdit migrates a legacy boolean already on disk to the array shape even on an unrelated save", () => {
  // PR #23 review round 1, resilience finding 3: the on-disk shape moves to
  // string[] on the very next save whether or not that save touches
  // acknowledgement at all — and this migration is bookkeeping, not
  // something the athlete chose to change this time, so it is not stamped.
  const before = race({ unresolved: ["links.tracking"], unresolved_acknowledged: true });
  const { race: next, written } = applyRaceEdit(before, { date: "2027-08-14" }, { at: AT });
  assert.deepEqual(next.unresolved_acknowledged, ["links.tracking"]);
  assert.ok(!written.includes("unresolved_acknowledged"), written.join(", "));
});

test("acknowledgedPaths never retroactively acknowledges a path the folder's stored unresolved never named", () => {
  // The exact resilience-round-1 repro: race.json says
  // unresolved: ["links.tracking"], unresolved_acknowledged: true — a
  // freshly-surfaced aid_stations[0].gpx_wpt (a matcher re-run, never
  // persisted to the stored list) must NOT come back acknowledged.
  const before = race({ unresolved: ["links.tracking"], unresolved_acknowledged: true });
  const acked = acknowledgedPaths(before);
  assert.deepEqual(acked, ["links.tracking"]);
  assert.ok(!acked.includes("aid_stations[0].gpx_wpt"));
});

/* ------------------------ unresolved recomputation ---------------------- */

test("valueAtPath walks the paths collectUnresolved emits", () => {
  const r = race({ elevation: { min_ft: null }, links: { tracking: null } });
  assert.equal(valueAtPath(r, "date"), "2027-08-13");
  assert.equal(valueAtPath(r, "elevation.min_ft"), null);
  assert.equal(valueAtPath(r, "links.tracking"), null);
  assert.equal(valueAtPath(r, "aid_stations[1].name"), "Cross Mountain");
  assert.equal(valueAtPath(r, "aid_stations[9].name"), undefined);
  assert.equal(valueAtPath(r, "nope.nope"), undefined);
});

test("recomputeUnresolved drops an entry whose field the human just filled", () => {
  const filled = race({ date: "2027-08-13" });
  assert.deepEqual(recomputeUnresolved(filled, ["date"]), []);
});

test("recomputeUnresolved keeps an entry whose field is still null, and finds new nulls", () => {
  const r = race({ date: null, elevation: { min_ft: null, max_ft: 12438 } });
  const out = recomputeUnresolved(r, ["date", "links.tracking"]);
  // `date` is still null (carried AND re-found), elevation.min_ft is new,
  // links.tracking is carried because the field is simply not there yet
  assert.deepEqual(out, ["date", "elevation.min_ft", "links.tracking"]);
});

test("recomputeUnresolved after an edit is what the PUT persists", () => {
  const before = race({ date: null, unresolved: ["date"] });
  const { race: next } = applyRaceEdit(before, { date: "2027-08-13" }, { at: AT });
  assert.deepEqual(recomputeUnresolved(next, before.unresolved), []);
});

test("unresolvedFromMatches flags only the stations whose waypoint is still a guess", () => {
  const stations = [
    { name: "Start", gpx_wpt: "START" },        // authored and real
    { name: "Cross Mountain" },                  // matcher is confident
    { name: "Ryman Creek" },                     // matcher is not
    { name: "Elbert Creek", gpx_wpt: "GONE" },   // authored but no longer in the GPX
    { name: "Finish" },                          // the track end IS the finish
  ];
  const matches = [
    { gpx_wpt: "START", confidence: 1 },
    { gpx_wpt: "CROSS MTN", confidence: 0.9 },
    { gpx_wpt: "RYMAN?", confidence: 0.4 },
    { gpx_wpt: null, confidence: 0 },
    { gpx_wpt: null, confidence: 0 },
  ];
  assert.deepEqual(
    unresolvedFromMatches(stations, matches, ["START", "CROSS MTN", "RYMAN?"]),
    ["aid_stations[2].gpx_wpt", "aid_stations[3].gpx_wpt"],
  );
});

/* -------------------------- status transition --------------------------- */

test("a clean draft with no unresolved fields activates", () => {
  const r = validateStatusTransition(race(), { status: "active" }, { unresolved: [] });
  assert.equal(r.ok, true, r.errors.join("; "));
  assert.equal(r.status, "active");
});

test("unresolved fields block activation until they are acknowledged", () => {
  const blocked = validateStatusTransition(race(), { status: "active" }, { unresolved: ["elevation.min_ft", "links.tracking"] });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "bad_request");
  assert.match(blocked.errors.join(" "), /2 unresolved fields/);
  assert.ok(blocked.errors.includes("elevation.min_ft"));

  const acked = validateStatusTransition(
    race({ unresolved: ["elevation.min_ft", "links.tracking"], unresolved_acknowledged: true }),
    { status: "active" },
    { unresolved: ["elevation.min_ft", "links.tracking"] },
  );
  assert.equal(acked.ok, true, acked.errors.join("; "));

  // per-field: acknowledging only ONE of two open paths still blocks (PR #23
  // review round 1, resilience finding 3 — the whole point of the array
  // contract over the old blanket boolean).
  const partial = validateStatusTransition(
    race({ unresolved: ["elevation.min_ft", "links.tracking"], unresolved_acknowledged: ["elevation.min_ft"] }),
    { status: "active" },
    { unresolved: ["elevation.min_ft", "links.tracking"] },
  );
  assert.equal(partial.ok, false);
  assert.ok(partial.errors.includes("links.tracking"));
});

test("only a draft activates — an active or archived folder is refused", () => {
  for (const status of ["active", "archived"]) {
    const r = validateStatusTransition(race({ status }), { status: "active" }, {});
    assert.equal(r.ok, false, status);
    assert.match(r.errors.join(" "), /only a draft can be activated/);
  }
});

test("the endpoint only promotes to active — archiving and demoting are refused", () => {
  for (const status of ["draft", "archived"]) {
    const r = validateStatusTransition(race(), { status }, {});
    assert.equal(r.ok, false, status);
    assert.match(r.errors.join(" "), /only promotes a draft to "active"/);
  }
  const bogus = validateStatusTransition(race(), { status: "live" }, {});
  assert.equal(bogus.ok, false);
  assert.match(bogus.errors.join(" "), /status must be one of/);
  assert.equal(validateStatusTransition(race(), null, {}).ok, false);
});

test("an acknowledgement does not excuse a race.json that is not valid as an active race", () => {
  // `date: null` is a legal DRAFT (race-intake excuses a listed hole) and an
  // illegal active race — this is the line the review gate exists to hold.
  const r = validateStatusTransition(
    race({ date: null, unresolved: ["date"], unresolved_acknowledged: true }),
    { status: "active" },
    { unresolved: ["date"] },
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /not valid as an active race/);
  assert.match(r.errors.join(" "), /date must be a YYYY-MM-DD/);
});

test("activation refuses while another folder is still active", () => {
  const r = validateStatusTransition(race(), { status: "active" }, { unresolved: [], otherActive: ["mogollon-monster-100-2026"] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /mogollon-monster-100-2026 is already active/);
});

test("otherActiveSlugs ignores the folder being activated and unreadable ones", () => {
  const races = [
    { slug: "a", race: { status: "active" } },
    { slug: "b", race: { status: "draft" } },
    { slug: "c", race: null },
    { slug: "d", race: { status: "active" } },
  ];
  assert.deepEqual(otherActiveSlugs(races, "a"), ["d"]);
  assert.deepEqual(otherActiveSlugs(races, "b"), ["a", "d"]);
});

test("applyStatus writes the status and stamps who did it, without mutating", () => {
  const before = race();
  const snapshot = structuredClone(before);
  const next = applyStatus(before, "active", { at: AT });
  assert.equal(next.status, "active");
  assert.deepEqual(next.provenance.status, { by: "user", at: AT });
  assert.deepEqual(before, snapshot);
});

/* --------------------------- unresolved fills --------------------------- */

test("unresolved_fills writes only paths the folder currently declares open", () => {
  const open = ["elevation.min_ft", "links.tracking"];
  const ok = validateRaceEdit({ unresolved_fills: { "elevation.min_ft": 7900 } }, { ...ctx, unresolved: open });
  assert.equal(ok.ok, true, ok.errors.join("; "));

  const closed = validateRaceEdit({ unresolved_fills: { "distance_mi": 50 } }, { ...ctx, unresolved: open });
  assert.equal(closed.ok, false);
  assert.match(closed.errors.join(" "), /only a field the folder currently lists as unresolved/);
});

test("unresolved_fills never writes the folder's identity or the aid table", () => {
  for (const p of ["status", "slug", "provenance", "sources", "unresolved_acknowledged", "aid_stations[0].name"]) {
    const r = validateRaceEdit({ unresolved_fills: { [p]: "x" } }, { ...ctx, unresolved: [p] });
    assert.equal(r.ok, false, p);
    assert.match(r.errors.join(" "), /is never filled through this endpoint/);
  }
});

test("unresolved_fills takes scalars only — no grafting new structure on", () => {
  const open = ["elevation.min_ft"];
  for (const v of [{ a: 1 }, [1, 2], Infinity]) {
    const r = validateRaceEdit({ unresolved_fills: { "elevation.min_ft": v } }, { ...ctx, unresolved: open });
    assert.equal(r.ok, false, JSON.stringify(v));
  }
});

test("applyRaceEdit fills a declared hole and stamps the path", () => {
  const before = race({ elevation: { min_ft: null, max_ft: 12438 }, links: { tracking: null } });
  const { race: next, written } = applyRaceEdit(before, {
    unresolved_fills: { "elevation.min_ft": 7900, "links.tracking": "https://track.example/sjs" },
  }, { at: AT });
  assert.equal(next.elevation.min_ft, 7900);
  assert.equal(next.links.tracking, "https://track.example/sjs");
  assert.deepEqual(written.sort(), ["elevation.min_ft", "links.tracking"]);
  assert.deepEqual(next.provenance["elevation.min_ft"], { by: "user", at: AT });
  // and the hole is a hole no longer
  assert.deepEqual(recomputeUnresolved(next, ["elevation.min_ft", "links.tracking"]), []);
});

test("applyRaceEdit will not invent a container a fill path passes through", () => {
  const { race: next, written } = applyRaceEdit(race(), { unresolved_fills: { "elevation.min_ft": 7900 } }, { at: AT });
  assert.equal(next.elevation, undefined);
  assert.deepEqual(written, []);
});

/* ------------------- acknowledged holes become absences ------------------ */

test("an acknowledged null is recorded as an ABSENT key, which is how the schema says \"not known\"", () => {
  const r = race({
    elevation: { min_ft: null, max_ft: 12438 }, links: { tracking: null },
    unresolved: ["elevation.min_ft", "links.tracking"], unresolved_acknowledged: true,
  });
  const { race: next, pruned } = pruneAcknowledgedNulls(r, ["elevation.min_ft", "links.tracking"]);
  assert.deepEqual(pruned.sort(), ["elevation.min_ft", "links.tracking"]);
  assert.equal("min_ft" in next.elevation, false);
  assert.equal(next.elevation.max_ft, 12438);
  assert.equal("tracking" in next.links, false);
});

test("pruneAcknowledgedNulls does nothing until the holes are acknowledged", () => {
  const r = race({ elevation: { min_ft: null } });
  const { race: next, pruned } = pruneAcknowledgedNulls(r, ["elevation.min_ft"]);
  assert.deepEqual(pruned, []);
  assert.equal(next.elevation.min_ft, null);
});

test("acknowledging an optional null lets the draft activate; a required one still does not", () => {
  const optional = race({ elevation: { min_ft: null }, unresolved: ["elevation.min_ft"], unresolved_acknowledged: true });
  assert.equal(
    validateStatusTransition(optional, { status: "active" }, { unresolved: ["elevation.min_ft"] }).ok,
    true,
  );
  const required = race({ date: null, unresolved: ["date"], unresolved_acknowledged: true });
  const r = validateStatusTransition(required, { status: "active" }, { unresolved: ["date"] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /date must be a YYYY-MM-DD/);
});

test("applyStatus prunes the acknowledged holes it was validated against", () => {
  const r = race({ elevation: { min_ft: null, max_ft: 12438 }, unresolved: ["elevation.min_ft"], unresolved_acknowledged: true });
  const next = applyStatus(r, "active", { at: AT, unresolved: ["elevation.min_ft"] });
  assert.equal(next.status, "active");
  assert.equal("min_ft" in next.elevation, false);
  // the on-disk field is also migrated to the array shape here, the same
  // rule applyRaceEdit follows on an ordinary save.
  assert.deepEqual(next.unresolved_acknowledged, ["elevation.min_ft"]);
});

/* ------------------------------ block staleness --------------------------- */

test("isBlockStale: true when race.date has moved out of the block's race week", () => {
  const block = { start_date: "2027-05-24", total_weeks: 12, targets: [] };
  // week 12 (the last) runs 2027-08-09 through 2027-08-15 — inside it, not stale
  assert.equal(isBlockStale(block, { date: "2027-08-13" }), false);
  assert.equal(isBlockStale(block, { date: "2027-08-09" }), false);
  assert.equal(isBlockStale(block, { date: "2027-08-15" }), false);
  // the owner moved the race a week later — now stale
  assert.equal(isBlockStale(block, { date: "2027-08-20" }), true);
  // and a week earlier
  assert.equal(isBlockStale(block, { date: "2027-08-06" }), true);
});

test("isBlockStale: false when there is nothing sane to compare — a separate problem, not staleness", () => {
  const block = { start_date: "2027-05-24", total_weeks: 12, targets: [] };
  assert.equal(isBlockStale(block, { date: null }), false);
  assert.equal(isBlockStale(block, { date: "not-a-date" }), false);
  assert.equal(isBlockStale(null, { date: "2027-08-13" }), false);
  assert.equal(isBlockStale({ start_date: "2027-05-24" }, { date: "2027-08-13" }), false, "total_weeks missing");
});

test("loadReview surfaces block_stale without touching block.json — the athlete's targets are never at risk", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "race-edit-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const slug = "test-race-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  const r = race({ date: "2027-08-20" }); // the block below was planned for 2027-08-13
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(r, null, 2));
  const block = { start_date: "2027-05-24", total_weeks: 12, targets: [{ wk: 1, target_dist: 30, target_elev: 4000 }] };
  await fs.writeFile(path.join(dir, "block.json"), JSON.stringify(block, null, 2));

  const review = await loadReview(root, slug);
  assert.equal(review.block_stale, true);
  assert.deepEqual(review.block, block, "the targets themselves are untouched");
  // and loadReview is read-only — the file on disk is exactly what was written
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, "block.json"), "utf8")), block);
});

test("loadReview re-derives the course.gpx mismatch live from build/course.json, and clears a stale persisted entry a plain carry-forward could never drop", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "race-edit-review-mismatch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const slug = "test-race-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(path.join(dir, "build"), { recursive: true });

  // race.json still carries a stale "course.gpx" entry from a build that
  // once mismatched. recomputeUnresolved's carry-forward rule reads
  // valueAtPath(race, "course.gpx"), which is always undefined for this
  // synthetic path, so it can never clear on its own — loadReview has to
  // recompute the comparison live instead of trusting the carried value.
  const r = race({ unresolved: ["course.gpx"], distance_mi: 100, gain_ft: 20000 });
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(r, null, 2));
  // A course.json whose measured figures are within MISMATCH_THRESHOLD of
  // the current official ones — the underlying problem is actually fixed.
  await fs.writeFile(
    path.join(dir, "build", "course.json"),
    JSON.stringify({ distance_mi: 101, gain_ft: 19800 }, null, 2)
  );

  const clean = await loadReview(root, slug);
  assert.ok(!clean.unresolved.includes("course.gpx"), clean.unresolved.join(", "));
  assert.equal(clean.activation.ok, true, JSON.stringify(clean.activation.errors));

  // Now point course.json at a genuine mismatch — race.json's persisted
  // `unresolved` is never touched — and confirm loadReview flags it live,
  // and that validateStatusTransition (which is handed loadReview's own
  // `unresolved`) blocks activation on it.
  await fs.writeFile(
    path.join(dir, "build", "course.json"),
    JSON.stringify({ distance_mi: 40, gain_ft: 19800 }, null, 2)
  );
  const mismatched = await loadReview(root, slug);
  assert.ok(mismatched.unresolved.includes("course.gpx"), mismatched.unresolved.join(", "));
  assert.equal(mismatched.activation.ok, false);
  assert.ok(
    mismatched.activation.errors.some((e) => /course\.gpx/.test(e)),
    mismatched.activation.errors.join(" | ")
  );
});

/* ------------------------------- fix-sun-null ---------------------------- */
//
// A draft's course built while `date` was still null leaves `sun` missing
// forever unless something revisits it once the date is known — these pin
// down the review screen's half of that (race-build.mjs's half, recomputing
// it, is covered in race-build.test.mjs).

test('loadReview lists "sun" in unresolved, with a hint to re-run the course build, once date is set but sun is still missing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "race-edit-review-sun-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const slug = "test-race-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });

  // the exact repro: a draft's course built before its date was known
  // (sun and provenance.sun absent), then the date filled in during review.
  const r = race();
  delete r.sun;
  delete r.provenance.sun;
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(r, null, 2));

  const review = await loadReview(root, slug);
  assert.ok(review.unresolved.includes("sun"), review.unresolved.join(", "));
  assert.match(review.unresolved_hints.sun, /course build/);

  // and it clears the moment a build fills sun back in — live, not carried,
  // same treatment as the course.gpx mismatch above.
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(race(), null, 2));
  const reviewed = await loadReview(root, slug);
  assert.ok(!reviewed.unresolved.includes("sun"), reviewed.unresolved.join(", "));
  assert.equal(reviewed.unresolved_hints.sun, undefined);
});

test("loadReview does not flag \"sun\" on a draft whose date isn't set yet — that's collectUnresolved's null, not this live check", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "race-edit-review-sun-nodate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const slug = "test-race-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  const r = race({ date: null });
  delete r.sun;
  delete r.provenance.sun;
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(r, null, 2));

  const review = await loadReview(root, slug);
  assert.ok(!review.unresolved.includes("sun"), review.unresolved.join(", "));
  assert.ok(review.unresolved.includes("date"), review.unresolved.join(", "));
});

test("activation refuses a night race with no computed sun outright — acknowledging does not excuse it", () => {
  const withoutSun = race({ features: { night: true } });
  delete withoutSun.sun;
  delete withoutSun.provenance.sun;

  const blocked = validateStatusTransition(withoutSun, { status: "active" }, { unresolved: ["sun"] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors.join(" "), /night sections/);

  const acked = validateStatusTransition(
    { ...withoutSun, unresolved_acknowledged: true },
    { status: "active" },
    { unresolved: ["sun"] },
  );
  assert.equal(acked.ok, false, "unlike an ordinary hole, ticking acknowledge must not open the gate");
  assert.match(acked.errors.join(" "), /night sections/);
});

test("a day race (features.night: false) with no sun is an ordinary unresolved hole, not a hard block", () => {
  const dayRace = race({ features: { night: false } });
  delete dayRace.sun;
  delete dayRace.provenance.sun;

  const unacked = validateStatusTransition(dayRace, { status: "active" }, { unresolved: ["sun"] });
  assert.equal(unacked.ok, false);
  assert.ok(!/night sections/.test(unacked.errors.join(" ")), unacked.errors.join(" | "));

  const acked = validateStatusTransition(
    { ...dayRace, unresolved: ["sun"], unresolved_acknowledged: true },
    { status: "active" },
    { unresolved: ["sun"] },
  );
  assert.equal(acked.ok, true, JSON.stringify(acked.errors));
});

test("loadReview reports refresh_interrupted only when acceptRefresh's applying marker is on disk, not for an ordinary pending refresh", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "race-edit-review-refresh-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const slug = "test-race-2027";
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(race(), null, 2));

  // No .refresh/ at all — the ordinary "nothing pending" case.
  assert.equal((await loadReview(root, slug)).refresh_interrupted, false);

  // A refresh waiting for review — .refresh/diff.json exists, but acceptRefresh
  // was never called, so there is no applying marker. This must read the
  // same as "nothing pending", not as interrupted.
  const shadow = path.join(dir, ".refresh");
  await fs.mkdir(shadow, { recursive: true });
  await fs.writeFile(path.join(shadow, "diff.json"), JSON.stringify({ slug, at: "2026-09-18T00:00:00Z" }, null, 2));
  assert.equal((await loadReview(root, slug)).refresh_interrupted, false, "a merely-pending refresh is not an interrupted one");

  // acceptRefresh started applying and (per this test) never got to remove
  // its own marker — the crashed-mid-accept case the switcher/review UI
  // should flag with a "re-run Accept" notice.
  await fs.writeFile(path.join(shadow, "applying"), "2026-09-18T00:05:00.000Z");
  assert.equal((await loadReview(root, slug)).refresh_interrupted, true);
});
