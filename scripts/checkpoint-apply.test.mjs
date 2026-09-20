// applyCheckpoint / stationRows — the crew-sheet checkpoint updater's own
// math (web/src/crew/checkpoint.ts, web/src/crew/render.ts). PRD v2 §5,
// bead tt-cv1b0.8. Round 1 review findings r1-crew-tests.md (HIGH,
// checkpoint.ts:88-89,234 + render.ts:93-124) and r1-models.md (LOW,
// checkpoint.ts:184-185, RACE_WINDOW_SLACK_H double-add).
//
// HOW THE .ts GETS IN HERE: same pattern as
// scripts/altitude-projection.test.mjs — a module resolve hook appends
// `.ts` to relative extensionless imports made from .ts files, then the
// real modules load with Node's own type stripping (node >= 22.18). No
// build step, so this reads exactly what the app ships.
//
// The course/fit/data below are synthetic — no race folder needed.

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
const { applyCheckpoint, RACE_WINDOW_SLACK_H } = await import("../web/src/crew/checkpoint.ts");
const { stationRows } = await import("../web/src/crew/render.ts");

/* ----------------------------- the fixture ----------------------------- */

/** A plain 30-mile course, three aid stations: an upstream one ("See
    Canyon"), a crew stop ("Horton") and the finish — named after the
    reviewer's real Mogollon Monster reproduction, on a synthetic profile. */
function makeCourse() {
  const STEP = 0.1;
  const profile = [];
  for (let mi = 0; mi <= 30 + 1e-9; mi += STEP) {
    const m = Math.round(mi * 1000) / 1000;
    profile.push({ mi: m, ele_ft: 5000 + 20 * m, grade_pct: 0.4 });
  }
  const station = (name, mi, extra = {}) => ({
    name, total_mi: mi, gpx_mi: mi, seg_mi: null, seg_gain_ft: null, cutoff_h: null,
    crew: false, crew_only: false, drop_bag: false, pacers: false, water_only: false, notes: "",
    ...extra,
  });
  return {
    generated_at: "2026-01-01T00:00:00Z", source: "synthetic",
    distance_mi: 30, gain_ft: 600, official_distance_mi: 30, official_gain_ft: 600,
    sun: null, profile, race_climbs: [],
    aid_stations: [
      station("See Canyon", 12),
      station("Horton", 21.3, { crew: true }),
      station("Finish", 30, { crew: true }),
    ],
  };
}

const FIT = { base: 570, kVert: 1.7, kDist: 4, residStd: 48, n: 24, effN: 18, basis: "test fit", dRefMi: 20 };
const OPTS = { fatiguePctPer10mi: 5, calibrationPct: 6, restraintPct: 8, goalH: null, aidStopMin: 5, crewStopMin: 10 };
const COURSE = makeCourse();
const LIVE = projectRace(COURSE, FIT, OPTS);

/** The embedded/frozen projection — CrewStation[], "agreeing at export time"
    with LIVE the way crew-export.mjs's real writer does. */
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

/** A minimal CrewData — only the fields checkpoint.ts/render.ts actually
    read. `cutoffH`/`finishWorstH` are exposed separately so the
    RACE_WINDOW_SLACK_H test can drive the fallback path without depending
    on the fit's own finish estimate. */
function makeData({ cutoffH = null, finishWorstH = LIVE.finish_h.worst } = {}) {
  return {
    schema_version: 1, generated_at: "2026-01-01T00:00:00Z", slug: "repro",
    race: {
      slug: "repro", name: "Repro", short: "R", date: "2026-06-01", start_time: "06:00",
      timezone: "America/Denver", distance_mi: 30, gain_ft: 600, location: null,
      cutoff_h: cutoffH, sun: null, links: {}, crew_info: null, features: {}, sources: [],
    },
    course: COURSE, crew_base: null,
    knobs: {
      fatiguePctPer10mi: 5, calibrationPct: 6, restraintPct: 8, aidStopMin: 5, crewStopMin: 10,
      stopOverridesMin: {}, goalH: null, altitude: null,
    },
    fit: FIT, grade_curve: null,
    projection: {
      finish_h: { ...LIVE.finish_h, worst: finishWorstH }, finish_clock: { best: "", avg: "", worst: "" },
      stopped_h: LIVE.stopped_h, goal_h: LIVE.goal_h, grade_basis: LIVE.grade_basis,
      stations: frozenStations(LIVE),
    },
    fuel: null, crew_pickups: [], nutrition: {},
  };
}

/** race-local "HH:MM" at elapsed hour `h` after a 06:00 America/Denver
    (MDT, UTC−6 in June) start — matches `makeData`'s race fields. */
function clockAt(h) {
  const d = new Date(Date.UTC(2026, 5, 1, 12, 0, 0) + h * 3_600_000);
  const hh = String((d.getUTCHours() + 24 - 6) % 24).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
const START_MS = Date.UTC(2026, 5, 1, 12, 0, 0);

/* ------------------------- the HIGH finding ------------------------- */

test("a clamped ratio never re-dates a passed station before itself, and never before the gun", () => {
  const data = makeData();
  // An implausibly fast Horton split (21.3 mi in 21 minutes) — clamps the
  // ratio to its 0.6 floor and produces a large negative shift_h, exactly
  // the reviewer's Horton/See Canyon reproduction.
  const clock = clockAt(0.35);
  const outcome = applyCheckpoint(data, LIVE, { station: "Horton", clock }, { now: START_MS + 0.35 * 3_600_000 });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  assert.equal(outcome.result.clamped, true, "the ratio should have clamped for this split to be a useful repro");
  assert.ok(outcome.result.shift_h < -2, `shift_h ${outcome.result.shift_h} is not the large negative shift the repro needs`);

  const rows = stationRows(data, LIVE, outcome.result);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

  // See Canyon (upstream, already passed) keeps its live/prior ETA — it is
  // NOT re-projected backwards by the downstream shift.
  const liveSeeCanyon = LIVE.stations[0].eta_h;
  assert.equal(byName["See Canyon"].eta_h.avg, liveSeeCanyon.avg, "See Canyon was re-dated by the checkpoint shift");
  assert.ok(byName["See Canyon"].eta_h.avg > 0, "See Canyon eta_h.avg went negative — pre-start");

  // Horton itself reads back exactly what the crew typed.
  assert.equal(byName["Horton"].eta_h.avg, outcome.result.observed_h);
  assert.equal(byName["Horton"].eta_h.best, outcome.result.observed_h);
  assert.equal(byName["Horton"].eta_h.worst, outcome.result.observed_h);

  // No station, anywhere on the sheet, is negative or before the checkpoint.
  for (const r of rows) {
    for (const sc of ["best", "avg", "worst"]) {
      assert.ok(r.eta_h[sc] >= 0, `${r.name} ${sc} eta_h ${r.eta_h[sc]} is before the gun`);
    }
  }
  for (const r of rows.slice(outcome.result.index + 1)) {
    for (const sc of ["best", "avg", "worst"]) {
      assert.ok(
        r.eta_h[sc] >= outcome.result.observed_h - 1e-9,
        `${r.name} ${sc} eta_h ${r.eta_h[sc]} is before the checkpoint (${outcome.result.observed_h})`,
      );
    }
  }
});

test("an even more extreme clamp still floors every downstream station, best/avg/worst alike", () => {
  const data = makeData();
  const clock = clockAt(0.1);
  const outcome = applyCheckpoint(data, LIVE, { station: "Horton", clock }, { now: START_MS + 0.1 * 3_600_000 });
  if (!outcome.ok) return; // too fast to place at all — not the scenario under test
  const rows = stationRows(data, LIVE, outcome.result);
  for (const r of rows.slice(outcome.result.index)) {
    for (const sc of ["best", "avg", "worst"]) {
      assert.ok(r.eta_h[sc] >= outcome.result.observed_h - 1e-9, `${r.name} ${sc} below the checkpoint`);
      assert.ok(r.eta_h[sc] >= 0, `${r.name} ${sc} negative`);
    }
  }
});

test("a checkpoint at the very first station has nothing upstream to protect, and still floors downstream", () => {
  const data = makeData();
  const clock = clockAt(0.2);
  const outcome = applyCheckpoint(data, LIVE, { station: "See Canyon", clock }, { now: START_MS + 0.2 * 3_600_000 });
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
  const rows = stationRows(data, LIVE, outcome.result);
  assert.equal(rows[0].eta_h.avg, outcome.result.observed_h);
  for (const r of rows.slice(1)) {
    assert.ok(r.eta_h.avg >= outcome.result.observed_h - 1e-9, `${r.name} below the checkpoint`);
  }
});

test("with no checkpoint applied, stationRows is a pass-through of the live/frozen ETAs (no floor artefact)", () => {
  const data = makeData();
  const rows = stationRows(data, LIVE, null);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].eta_h.avg, LIVE.stations[i].eta_h.avg);
  }
});

/* ------------------------- the LOW finding ------------------------- */

test("RACE_WINDOW_SLACK_H is added exactly once when cutoff_h is null, not twice", () => {
  // finish_h.worst pinned to a round number decoupled from the fit, so the
  // window math is exact: fixed at 20h, with the fallback close-of-course at
  // 20h and the window's own slack (3h) added on top — 23h, not 26h.
  const cutoffLess = makeData({ cutoffH: null, finishWorstH: 20 });
  const explicit = makeData({ cutoffH: 20, finishWorstH: 20 });

  // A See Canyon split whose HH:MM recurs every 24h (06:05, 5 min after the
  // 06:00 gun) — one occurrence at elapsed 1/12 h, the next at 24 + 1/12 h.
  // Asked "now" sits at 24.5h after the start: inside the OLD (buggy)
  // cutoff-less window (20 + 3 + 3 = 26h, unclamped) but past the FIXED one
  // (20 + 3 = 23h, clamped). If the double-add regressed, `now` would not be
  // clamped and checkpointHold would resolve the LATE (24h+) occurrence
  // instead of the early one.
  const clock = clockAt(1 / 12);
  const now = START_MS + 24.5 * 3_600_000;

  const outCutoffLess = applyCheckpoint(cutoffLess, LIVE, { station: "See Canyon", clock }, { now });
  const outExplicit = applyCheckpoint(explicit, LIVE, { station: "See Canyon", clock }, { now });

  assert.equal(outExplicit.ok, true, outExplicit.ok ? "" : outExplicit.reason);
  assert.equal(outCutoffLess.ok, true, outCutoffLess.ok ? "" : outCutoffLess.reason);

  // Both must clamp to the SAME window and resolve the SAME (early) day —
  // the cutoff-less fallback must behave exactly like an explicit cutoff at
  // the same hour, once slack is added only once.
  assert.equal(outCutoffLess.result.observed_h, outExplicit.result.observed_h);
  assert.ok(
    outCutoffLess.result.observed_h < 1,
    `expected the early (1/12 h) occurrence, got ${outCutoffLess.result.observed_h} — ` +
      `the cutoff-less window is still wider than the explicit-cutoff one (double-add regressed)`,
  );
});

test("RACE_WINDOW_SLACK_H is exported as the documented 3-hour constant", () => {
  assert.equal(RACE_WINDOW_SLACK_H, 3);
});
