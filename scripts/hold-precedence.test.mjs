// Manual-vs-tracker hold precedence — v2 review ui3 #2: a manual SET was
// silently thrown away whenever the tracker's LAST checkpoint named a
// station off this race's aid chart, because the old comparison only looked
// at WHEN each hold was observed and an off-chart tracker reading still
// carries a real elapsed_h. web/src/race/holdPrecedence.ts's pickHold is the
// fix; this is its contract.
//
// The .ts source is imported directly, like scripts/pacing-format.test.mjs —
// it only imports a TYPE from checkpointHold.ts (erased at the syntax level,
// no resolve needed), so plain type-stripping (node >= 22.18) is enough.

import test from "node:test";
import assert from "node:assert/strict";

import { pickHold } from "../web/src/race/holdPrecedence.ts";

const manual = (mile, elapsed_h = null) => ({ mile, elapsed_h, source: "manual", label: "held by hand" });
const tracker = (mile, elapsed_h, label = "tracker · 21:22") => ({ mile, elapsed_h, source: "tracker", label });

test("no manual, no tracker: nothing to hold on to", () => {
  assert.equal(pickHold(null, null, null, null), null);
});

test("no manual: the live hold stands, on-chart or off", () => {
  const onChart = tracker(104.3, 15.37);
  assert.equal(pickHold(null, null, onChart, 15.37), onChart);
  const offChart = tracker(null, 15.37);
  assert.equal(pickHold(null, null, offChart, 15.37), offChart);
});

test("no live hold: the manual hold stands regardless of timing", () => {
  const m = manual(80, null);
  assert.equal(pickHold(m, 5, null, null), m);
});

test("both on-chart: whichever was observed LATER wins, tie to manual", () => {
  const m = manual(64.4, 17);
  const t = tracker(104.3, 15.37);
  assert.equal(pickHold(m, 17, t, 15.37), m, "manual is later — manual wins");
  assert.equal(pickHold(m, 10, t, 15.37), t, "tracker is later — tracker wins");
  assert.equal(pickHold(m, 15.37, t, 15.37), m, "a tie goes to manual");
});

test("v2 review ui3 #2: an off-chart tracker checkpoint never outranks a manual hold, even a chronologically later one", () => {
  const m = manual(49.71, null); // "SET 80 km" — the exact repro's mile
  const offChart = tracker(null, 15.37); // Burnett #7, not on this race's chart
  // The manual observation instant is EARLIER than the tracker's — the exact
  // shape that used to lose. It must still win, because the tracker reading
  // has no position to compare against in the first place.
  assert.equal(pickHold(m, 10, offChart, 15.37), m);
  // And when the manual observation is later, same result, for the same reason.
  assert.equal(pickHold(m, 20, offChart, 15.37), m);
});

test("an off-chart tracker checkpoint still wins over NOTHING, same as a real one would", () => {
  const offChart = tracker(null, 15.37);
  assert.equal(pickHold(null, null, offChart, 15.37), offChart);
});
