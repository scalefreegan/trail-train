// fmtElapsed / fmtRaceClock — web/src/race/pacing.ts's two elapsed-hour
// formatters. Round 1 review, r1-crew-tests.md LOW findings:
//   - fmtElapsed(-0.499) used to read "-1h 30m" (double the true magnitude)
//     because the floor/mod split is only correct for h >= 0.
//   - fmtRaceClock gave a pre-start instant no indicator at all — a bogus
//     negative ETA printed as an ordinary-looking clock time.
//
// Both are reachable from the checkpoint updater's clamped-ratio shift (see
// scripts/checkpoint-apply.test.mjs), so this pins the formatters directly
// too — the same "type-stripped import" pattern as scripts/features.test.mjs
// and scripts/altitude-projection.test.mjs (node >= 22.18 strips the types;
// a resolve hook appends `.ts` to pacing.ts's own relative imports).

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

const { fmtElapsed, fmtRaceClock } = await import("../web/src/race/pacing.ts");

/* ------------------------------ fmtElapsed ------------------------------ */

test("fmtElapsed: ordinary non-negative durations, unchanged", () => {
  assert.equal(fmtElapsed(0), "0h 00m");
  assert.equal(fmtElapsed(1.2), "1h 12m");
  assert.equal(fmtElapsed(31.4), "31h 24m");
  // round-to-minute-first: 0.999999h must not read "0h 60m"
  assert.equal(fmtElapsed(59.999 / 60), "1h 00m");
});

test("fmtElapsed: a negative duration prints sign-then-magnitude, not double", () => {
  // the reviewer's exact repro value: -0.499h is -0h 30m, not -1h 30m
  assert.equal(fmtElapsed(-0.499), "-0h 30m");
  assert.equal(fmtElapsed(-1.2), "-1h 12m");
  assert.equal(fmtElapsed(-0.0167), "-0h 01m");
});

test("fmtElapsed: magnitude matches what Math.abs(h) would already produce (fmtSigned's own contract)", () => {
  for (const h of [-2.75, -0.5, -0.0001, 0.0001, 3.333]) {
    const signed = fmtElapsed(h);
    const magnitude = fmtElapsed(Math.abs(h));
    assert.equal(signed.replace(/^-/, ""), magnitude, `fmtElapsed(${h})`);
  }
});

/* ----------------------------- fmtRaceClock ----------------------------- */

const TZ = "America/Denver";
// 2026-06-01 06:00 MDT (UTC−6) — an ordinary summer gun.
const START = new Date("2026-06-01T12:00:00Z");

test("fmtRaceClock: ordinary same-day and next-day instants, unchanged", () => {
  assert.equal(fmtRaceClock(START, 0, TZ), "6:00a");
  assert.equal(fmtRaceClock(START, 6.25, TZ), "12:15p");
  assert.equal(fmtRaceClock(START, 25, TZ), "7:00a+1"); // 25h later, next calendar day
});

test("fmtRaceClock: a pre-start instant is flagged, same day", () => {
  // 06:00 start, asked for -0.5h → 5:30a the same calendar day. No day
  // marker triggers (days === 0), so without an explicit flag this looked
  // like an ordinary clock time.
  const s = fmtRaceClock(START, -0.5, TZ, { flagPreStart: true });
  assert.match(s, /pre-start/, `expected a pre-start marker, got ${JSON.stringify(s)}`);
  assert.match(s, /5:30a/, `expected the clock-of-day to still read, got ${JSON.stringify(s)}`);
});

test("fmtRaceClock: a pre-start instant that also crosses into the previous calendar day is flagged", () => {
  const s = fmtRaceClock(START, -24.5, TZ, { flagPreStart: true });
  assert.match(s, /pre-start/);
});

test("fmtRaceClock: never flags a non-negative elapsed hour, even at exactly 0", () => {
  assert.doesNotMatch(fmtRaceClock(START, 0, TZ), /pre-start/);
  assert.doesNotMatch(fmtRaceClock(START, 40, TZ), /pre-start/);
});

test("fmtRaceClock: without the opt-in flag a pre-start instant is an ordinary clock (the race-day header before the gun)", () => {
  const s = fmtRaceClock(START, -0.5, TZ);
  assert.doesNotMatch(s, /pre-start/, `expected no marker, got ${JSON.stringify(s)}`);
  assert.match(s, /^\d{1,2}:\d{2}[ap]/);
});

test("fmtRaceClock: dayMarker defaults on, unchanged for every existing caller", () => {
  assert.equal(fmtRaceClock(START, 25, TZ), "7:00a+1");
  assert.equal(fmtRaceClock(START, -24.5, TZ), "5:30a-1");
});

test("fmtRaceClock: dayMarker:false drops the day offset, keeping the clock-of-day (v2 review ui2 #7 — the race-day header before the gun read \"5:47p-328\" 327 days out)", () => {
  assert.equal(fmtRaceClock(START, -24.5, TZ, { dayMarker: false }), "5:30a");
  // a huge pre-start offset (327 days) — the exact repro shape
  assert.equal(fmtRaceClock(START, -24 * 327 + 11.75, TZ, { dayMarker: false }), "5:45p");
});

test("fmtRaceClock: dayMarker:false composes with flagPreStart — each opt is independent", () => {
  const s = fmtRaceClock(START, -0.5, TZ, { flagPreStart: true, dayMarker: false });
  assert.match(s, /pre-start/);
  assert.doesNotMatch(s, /[+-]\d+$/);
});
