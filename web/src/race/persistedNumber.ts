// The pure half of useRacePlan.ts's persisted-knob hooks: parsing a stored
// string into a number and clamping it into a control's own range. Split out
// zero-import (like web/src/race/checkpointHold.ts) so scripts/*.test.mjs can
// import it directly under `node --test` — useRacePlan.ts itself pulls in
// React and half the race module graph, none of which node can resolve.
//
// Round 3, resilience finding 5: a stored `altitude_pct` of `1e308` reached
// the pacing model unclamped and crashed the race view (clock.ts's
// `toInstant` on the resulting `Invalid Date`). The slider/field themselves
// already bound every INTERACTIVE write to their own range; this is the
// read-time guard for a value that got into storage some other way — a
// hand-edit, or a build that once allowed a wider range.

/** [min, max], inclusive. */
export type NumberRange = readonly [number, number];

/** Clamp a finite number into `range`. */
export function clampToRange(n: number, range: NumberRange): number {
  const [min, max] = range;
  return Math.min(max, Math.max(min, n));
}

/** The altitude-pct slider's own range (RacePlanner.tsx: `min={0} max={150}`).
    Shared so the slider and the read-time clamp can never drift apart. */
export const ALTITUDE_PCT_RANGE: NumberRange = [0, 150];

/** The acclimation-days override field's own range (RacePlanner.tsx:
    `min={0} max={60}`) — see ALTITUDE_PCT_RANGE. */
export const ACCLIMATION_DAYS_RANGE: NumberRange = [0, 60];

/** Parse a persisted numeric knob: NaN/absent falls back to `initial`
    (unclamped — a caller's own default is trusted outright), and anything
    finite is clamped into `range` when one is given. */
export function parsePersistedNumber(raw: string | null, initial: number, range?: NumberRange): number {
  const n = raw == null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return initial;
  return range ? clampToRange(n, range) : n;
}

/** Same parse, for a knob whose "unset" is meaningful (see
    usePersistedNullableNumber): no value at all — absent, or blank — reads
    as null, never as a fallback number. */
export function parsePersistedNullableNumber(raw: string | null, range?: NumberRange): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return range ? clampToRange(n, range) : n;
}
