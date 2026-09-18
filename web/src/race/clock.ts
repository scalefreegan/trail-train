/* ------------------------------------------------------------------ */
/*  Race-local clock helpers for the client.                           */
/*                                                                     */
/*  TWIN FILE: scripts/clock.mjs is the Node ESM copy of this exact     */
/*  API, and scripts/clock.test.mjs is the shared test for both — it    */
/*  runs against the .mjs twin, so any change here must be mirrored     */
/*  there (and covered by that test). The logic is duplicated on        */
/*  purpose: the sync scripts and the Vite bundle have no shared        */
/*  module graph, and this is ~80 lines with no dependencies.          */
/*                                                                     */
/*  Why: a race carries its own IANA zone (race.json.timezone). The     */
/*  countdown, night bands, heat bands, crew ETAs and the race-week     */
/*  protocol must read in RACE-local wall clock no matter where the     */
/*  browser is. Nothing below ever touches the browser's zone.          */
/*                                                                     */
/*  raceStart() inverts Intl: Intl maps instant → wall clock, we need   */
/*  wall clock → instant. Pretend the wanted wall clock is UTC, ask     */
/*  the zone what offset applies at that provisional instant, subtract  */
/*  it, then re-ask at the corrected instant and subtract again. Two    */
/*  passes converge: the first lands within a day of the true instant,  */
/*  so the second reads the offset actually in force at the target.     */
/*  Across a DST shift, a repeated wall clock resolves to its first     */
/*  (pre-transition) occurrence and a skipped one to the shifted        */
/*  instant.                                                            */
/* ------------------------------------------------------------------ */

export type RaceLocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 (Sunday) – 6 (Saturday) */
  weekday: number;
  /** race-local calendar date, "YYYY-MM-DD" */
  iso: string;
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^(\d{1,2}):(\d{2})$/;

const WEEKDAY_NAMES = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
});

const partsCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsCache.set(timeZone, fmt);
  }
  return fmt;
}

type CivilFields = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** Numeric wall-clock fields of `instant` as seen in `timeZone`. */
function civilFields(instant: Date, timeZone: string): CivilFields {
  const out: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out as unknown as CivilFields;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function parseIsoDate(date: string): [number, number, number] {
  const m = ISO_DATE.exec(date);
  if (!m) throw new TypeError(`clock: expected a YYYY-MM-DD date, got ${JSON.stringify(date)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function parseClock(time: string): [number, number] {
  const m = CLOCK.exec(time);
  if (!m) throw new TypeError(`clock: expected an HH:MM time, got ${JSON.stringify(time)}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new RangeError(`clock: out-of-range time ${time}`);
  return [hour, minute];
}

function toInstant(value: Date | number | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`clock: not a valid instant: ${String(value)}`);
  return d;
}

/**
 * Offset of `timeZone` from UTC, in minutes, at a given instant.
 * Positive east of Greenwich (Europe/Berlin in summer → +120).
 */
export function zoneOffsetMinutes(value: Date | number | string, timeZone: string): number {
  const at = toInstant(value);
  const c = civilFields(at, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  // Floor to the second: the formatter has no sub-second field, so comparing
  // against the raw millisecond value would leak the instant's remainder.
  return (asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000;
}

/**
 * The instant at which a race-local wall clock occurs.
 * @param date race-local calendar date, "YYYY-MM-DD"
 * @param startTime race-local wall clock, "HH:MM" (24 h)
 * @param timeZone IANA zone id, e.g. "America/Denver"
 */
export function raceStart(date: string, startTime: string, timeZone: string): Date {
  const [year, month, day] = parseIsoDate(date);
  const [hour, minute] = parseClock(startTime);
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = wall - zoneOffsetMinutes(wall, timeZone) * 60000;
  ts = wall - zoneOffsetMinutes(ts, timeZone) * 60000;
  return new Date(ts);
}

/** Wall-clock fields of an instant in a race's zone. */
export function raceLocalParts(value: Date | number | string, timeZone: string): RaceLocalParts {
  const c = civilFields(toInstant(value), timeZone);
  return {
    year: c.year,
    month: c.month,
    day: c.day,
    hour: c.hour,
    minute: c.minute,
    weekday: new Date(Date.UTC(c.year, c.month - 1, c.day)).getUTCDay(),
    iso: `${pad(c.year, 4)}-${pad(c.month)}-${pad(c.day)}`,
  };
}

/**
 * English weekday name for a race-local day, optionally shifted by whole days.
 * Accepts either an instant (resolved to its race-local calendar date) or a
 * "YYYY-MM-DD" race-local date directly.
 * @param opts.offsetDays days to add (−3 for D-3)
 */
export function weekdayName(
  value: Date | number | string,
  timeZone: string,
  opts: { offsetDays?: number } = {},
): string {
  const offsetDays = opts.offsetDays ?? 0;
  const iso =
    typeof value === "string" && ISO_DATE.test(value) ? value : raceLocalParts(value, timeZone).iso;
  const [year, month, day] = parseIsoDate(iso);
  // Civil-day arithmetic in UTC: no DST, so "+1 day" is exactly one calendar day.
  return WEEKDAY_NAMES.format(new Date(Date.UTC(year, month - 1, day + offsetDays)));
}

export type RaceWeekLabels = { d3: string; d2: string; d1: string; raceDay: string };

/**
 * Weekday names for the race-week protocol: D-3 through race day.
 * A Friday race gives Tuesday / Wednesday / Thursday / Friday; a Saturday race
 * gives Wednesday / Thursday / Friday / Saturday.
 */
export function raceWeekLabels(date: string, timeZone: string): RaceWeekLabels {
  return {
    d3: weekdayName(date, timeZone, { offsetDays: -3 }),
    d2: weekdayName(date, timeZone, { offsetDays: -2 }),
    d1: weekdayName(date, timeZone, { offsetDays: -1 }),
    raceDay: weekdayName(date, timeZone),
  };
}

/**
 * Whether a string is an IANA zone this runtime knows.
 * Checks Intl.supportedValuesOf("timeZone") first (canonical ids), then falls
 * back to constructing a formatter so legacy aliases like "US/Arizona" — which
 * Intl accepts but does not list — are still reported valid.
 */
export function isValidTimeZone(tz: unknown): boolean {
  if (typeof tz !== "string" || tz === "") return false;
  // Typed by hand: supportedValuesOf is not in the "ES2023" lib this app targets.
  const supportedValuesOf = (Intl as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  try {
    if (supportedValuesOf?.("timeZone").includes(tz)) return true;
  } catch {
    // Runtime without supportedValuesOf; fall through to the constructor probe.
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
