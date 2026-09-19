// The race-day screen's tracker copy — web/src/race/useRaceData.ts's
// useTracker(). PRD v2 §4, bead tt-cv1b0.6; follow-up to the v2 review round
// 1 tracker-ambiguity fix (scripts/trackers/opensplittime.mjs's `ambiguous`
// error, web/vite.config.ts's 409 + `candidates`, TrackerResponse.reason in
// types.ts).
//
// useTracker's poll() talks to a real `fetch`, a `setTimeout` backoff chain
// and React state — none of which this needs to touch. The COPY it picks is
// two small pure functions, `stoppedTrackerNotice`/`successTrackerNotice`,
// exported specifically so this is a unit test of the copy selector rather
// than a browser flow that has to actually win a live-tracker race:
//
//   - stoppedTrackerNotice(status, body) — the notice for a poll that stops
//     for good: 404 (no tracker configured), 501 (a recognised but
//     unsupported tracker), 409 (a bib/name that ties across two or more
//     entrants — `code: "ambiguous"`, `candidates` on the body).
//   - successTrackerNotice(reason) — the notice for a 200 whose `tracker`
//     came back null: "no_checkpoint" gets none of its own (the race-day
//     screen's existing "Watching the race tracker…" line already covers
//     it), "runner_not_found" does.
//
// The .ts source is imported directly, the way scripts/features.test.mjs and
// scripts/altitude-projection.test.mjs do: node >= 22.18 strips the types,
// and a resolve hook appends `.ts` to useRaceData.ts's own relative,
// extensionless imports (../data, ./offlineCache, ./types, ./pacing,
// ../contracts) so the real module loads, not a reimplementation.

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

const { stoppedTrackerNotice, successTrackerNotice } = await import("../web/src/race/useRaceData.ts");

/* ---------------------------- stoppedTrackerNotice ---------------------------- */

test("409 (ambiguous): points at the review screen's bib field, regardless of the error body", () => {
  assert.equal(
    stoppedTrackerNotice(409, { error: "two runners named Alex Rivera on the spread" }),
    "several runners match — set your bib on the review screen",
  );
  // Even with no parseable body (a malformed 409, or the fetch's own
  // `.catch(() => null)`), the ambiguous copy still wins — it is keyed on
  // the STATUS, not on the body being readable.
  assert.equal(
    stoppedTrackerNotice(409, null),
    "several runners match — set your bib on the review screen",
  );
});

test("404: no tracker configured, falling back to a fixed sentence with no body", () => {
  assert.equal(stoppedTrackerNotice(404, null), "no live tracker is configured for this race");
});

test("404: a server-supplied reason wins over the fixed sentence", () => {
  assert.equal(
    stoppedTrackerNotice(404, { error: "race.json has no tracking.url" }),
    "live tracking is off — race.json has no tracking.url",
  );
});

test("501: a recognised-but-unsupported tracker, with no body", () => {
  assert.equal(
    stoppedTrackerNotice(501, null),
    "this race's tracker can't be read automatically — use the manual checkpoint below",
  );
});

test("501: a server-supplied reason still wins over the fixed sentence", () => {
  assert.equal(
    stoppedTrackerNotice(501, { error: "MAProgress has no public spread page" }),
    "live tracking is off — MAProgress has no public spread page",
  );
});

/* ---------------------------- successTrackerNotice ---------------------------- */

test("no_checkpoint: no notice of its own — the race-day screen's \"Watching…\" line covers it", () => {
  assert.equal(successTrackerNotice("no_checkpoint"), null);
});

test("runner_not_found: a notice telling the crew to check the bib/name", () => {
  assert.equal(successTrackerNotice("runner_not_found"), "runner not found on the tracker — check bib/name");
});

test("null reason (a checkpoint was actually found): no notice", () => {
  assert.equal(successTrackerNotice(null), null);
});
