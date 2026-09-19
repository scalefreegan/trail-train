/* ------------------------------------------------------------------ */
/*  Sun-window pure math — night bands, dark-window caffeine dosing,   */
/*  and the daily-overlap integral they share.                        */
/*                                                                     */
/*  Split out of pacing.ts / nutrition.ts / caffeine.ts for the same   */
/*  reason nutrition-config.ts was split out of nutrition.ts: this file*/
/*  imports NOTHING, so it is the one place `node --test` can load the */
/*  real client logic directly (type-stripped, no bundler) instead of  */
/*  a hand-copied reimplementation — see scripts/sun-null.test.mjs.    */
/*                                                                     */
/*  Every function here is null-safe on `sun`: a race whose course was */
/*  built before its date was known has no computed sunrise/sunset     */
/*  (build-course.mjs copies `race.sun` verbatim, and stage 2 never ran*/
/*  it because `date` was null). "Unknown" has to render as NO night/  */
/*  heat annotation, never a crash — see web/src/race/types.ts's       */
/*  Course.sun, now optional.                                          */
/* ------------------------------------------------------------------ */

export type SunTimes = { sunset: string; sunrise: string };

/** "18:35" → 18.583. Mirrors pacing.ts's clockToH exactly (that file        */
/*  re-exports this one so existing imports of `from "./pacing"` keep working). */
export function clockToH(clock: string): number {
  const [h, m] = clock.split(":").map(Number);
  return h + (m || 0) / 60;
}

/** Total overlap (hours) of [a0,a1] with window [w0,w1] repeated every 24h.
    Bounds are derived from the window edges themselves — a start bound of
    floor(a0/24)-1 silently skipped the last repeat whenever w0 < 0 (e.g. an
    evening race start putting the heat window at negative elapsed hours). */
export function dailyOverlap(a0: number, a1: number, w0: number, w1: number): number {
  let total = 0;
  for (let day = Math.floor((a0 - w1) / 24); day * 24 + w0 < a1; day++) {
    const s = Math.max(a0, day * 24 + w0);
    const e = Math.min(a1, day * 24 + w1);
    if (e > s) total += e - s;
  }
  return total;
}

/**
 * Night windows in elapsed race hours: darkness = clock time past sunset or
 * before sunrise. Returns [] when either clock string is missing — a course
 * built before the race's date was known has no sun times, and the profile
 * chart's night bands are simply absent rather than a crash.
 * Returns [startH, endH] intervals clipped to [0, horizonH]. All clock
 * strings are RACE-local — `startClock` comes from raceClockHM(), never from
 * the browser's idea of the start hour.
 */
export function nightIntervals(
  startClock: string,
  sunset: string | null | undefined,
  sunrise: string | null | undefined,
  horizonH: number,
): Array<[number, number]> {
  if (!sunset || !sunrise) return [];
  const start = clockToH(startClock);
  const set = clockToH(sunset);
  const rise = clockToH(sunrise);
  const out: Array<[number, number]> = [];
  // first sunset after the race start, then repeat every 24h
  let s = set - start;
  if (s < 0) s += 24;
  for (; s < horizonH; s += 24) {
    const e = s + (24 - set + rise); // sunset → next sunrise
    out.push([Math.max(0, s), Math.min(horizonH, e)]);
  }
  // race could also start pre-dawn (5 min of dark before a 6:00 start vs a
  // 6:05 sunrise)
  if (start < rise) out.unshift([0, Math.min(horizonH, rise - start)]);
  return out;
}

/** Elapsed-race-hour overlap of [departH, arriveH] with darkness, or 0 when
    `sun` is null — planFuel's per-leg night flag. */
export function nightOverlapH(
  departH: number, arriveH: number, sun: SunTimes | null, startH: number,
): number {
  if (!sun) return 0;
  const sunset = clockToH(sun.sunset) - startH;
  const sunriseNext = clockToH(sun.sunrise) - startH + 24;
  return dailyOverlap(departH, arriveH, sunset, sunriseNext);
}

/** Sunset→sunrise bounds in elapsed race hours, for the caffeine chart's
    night band — [] when `sun` is null. */
export function sunBoundsH(sun: SunTimes | null, startH: number, horizonH: number): Array<[number, number]> {
  if (!sun) return [];
  const set = clockToH(sun.sunset);
  const rise = clockToH(sun.sunrise);
  const out: Array<[number, number]> = [];
  let s = set - startH;
  if (s < 0) s += 24;
  for (; s < horizonH; s += 24) out.push([Math.max(0, s), Math.min(horizonH, s + (24 - set + rise))]);
  // a pre-dawn start runs in the dark before the first sunrise
  if (startH < rise) out.unshift([0, Math.min(horizonH, rise - startH)]);
  return out;
}

/**
 * The caffeine plan's darkness derivation (when night falls, and how to
 * test any elapsed hour for darkness) — null when `sun` is null, which
 * planCaffeine reads as "no dosing window: sun unknown".
 *
 * Nightfall in elapsed race hours. Taking the next sunset unconditionally
 * skips a night the runner is ALREADY in: a 20:00 start would open its
 * window 22.6 h in — the following evening — after ten hours of darkness
 * with nothing. So when the gun goes off in the dark, the window opens
 * immediately — except when that darkness is a sliver (a start five minutes
 * before sunrise): the test is whether enough darkness REMAINS to be worth
 * dosing into (one min-spacing interval), not merely whether it is dark.
 */
export function darknessWindow(
  sun: SunTimes | null, startH: number, minSpacingH: number,
): { duskH: number; isNight: (h: number) => boolean } | null {
  if (!sun) return null;
  const setClock = clockToH(sun.sunset);
  const riseClock = clockToH(sun.sunrise);
  const startsInDark = startH >= setClock || startH < riseClock;
  const darkRemainingH = startsInDark
    ? (startH >= setClock ? 24 - startH + riseClock : riseClock - startH)
    : 0;
  let duskH: number;
  if (startsInDark && darkRemainingH >= minSpacingH) {
    duskH = 0;
  } else {
    duskH = setClock - startH;
    if (duskH < 0) duskH += 24;
  }
  // darkness recurs daily, so test clock-of-day rather than elapsed hours
  const isNight = (h: number) => {
    const clock = (((startH + h) % 24) + 24) % 24;
    return clock >= setClock || clock < riseClock;
  };
  return { duskH, isNight };
}
