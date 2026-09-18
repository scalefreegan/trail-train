// Race-local clock helpers. No date library — everything is Intl.DateTimeFormat
// plus civil-date arithmetic on Date.UTC(), which is the only arithmetic that is
// safe across DST (a "day" is not always 24 h, but a calendar day always is one).
//
// Why this exists: every clock in the app currently assumes the laptop's zone.
// A race carries its own IANA zone (`race.json.timezone`), so the countdown,
// night bands, heat bands, crew ETAs and the race-week protocol all have to be
// computed in *race-local* wall clock regardless of where the browser is.
//
// TWIN FILE: web/src/race/clock.ts is a hand-kept TypeScript copy of this same
// API for the client. The logic is small and duplicated on purpose (the Node
// scripts and the Vite bundle do not share a module graph). scripts/clock.test.mjs
// is the shared test — it exercises this file, and any change here must be
// mirrored there and in the twin.
//
// The offset trick used by raceStart():
//   Intl can tell us the wall-clock fields of a known instant in a zone, but not
//   the instant of a known wall clock. So we invert it. Pretend the wanted wall
//   clock is UTC, ask the zone what offset applies at that provisional instant,
//   subtract it, then re-ask at the corrected instant and subtract again. Two
//   passes converge everywhere on Earth: the first pass lands within a day of the
//   true instant, so the second pass reads the offset that is actually in force
//   at the target wall clock. Only the two ambiguous hours around a DST shift can
//   still be ambiguous, and there we resolve the same way `new Date("...")` does
//   in a fixed-offset world: repeated wall clocks pick the first (pre-transition)
//   occurrence, skipped wall clocks land the corresponding shifted instant.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK = /^(\d{1,2}):(\d{2})$/;

const WEEKDAY_NAMES = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "long",
});

/** @type {Map<string, Intl.DateTimeFormat>} */
const partsCache = new Map();

function partsFormatter(timeZone) {
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

/** Numeric wall-clock fields of `instant` as seen in `timeZone`. */
function civilFields(instant, timeZone) {
  const out = {};
  for (const part of partsFormatter(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return out;
}

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

/** @returns {[number, number, number]} year, month (1-12), day */
function parseIsoDate(date) {
  const m = ISO_DATE.exec(String(date));
  if (!m) throw new TypeError(`clock: expected a YYYY-MM-DD date, got ${JSON.stringify(date)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** @returns {[number, number]} hour (0-23), minute */
function parseClock(time) {
  const m = CLOCK.exec(String(time));
  if (!m) throw new TypeError(`clock: expected an HH:MM time, got ${JSON.stringify(time)}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new RangeError(`clock: out-of-range time ${time}`);
  return [hour, minute];
}

function toInstant(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`clock: not a valid instant: ${String(value)}`);
  return d;
}

/**
 * Offset of `timeZone` from UTC, in minutes, at a given instant.
 * Positive east of Greenwich (Europe/Berlin in summer → +120).
 * @param {Date|number|string} instant
 * @param {string} timeZone IANA zone id
 * @returns {number}
 */
export function zoneOffsetMinutes(instant, timeZone) {
  const at = toInstant(instant);
  const c = civilFields(at, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  // Floor to the second: the formatter has no sub-second field, so comparing
  // against the raw millisecond value would leak the instant's remainder.
  return (asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000;
}

/**
 * The instant at which a race-local wall clock occurs.
 * @param {string} date race-local calendar date, "YYYY-MM-DD"
 * @param {string} startTime race-local wall clock, "HH:MM" (24 h)
 * @param {string} timeZone IANA zone id, e.g. "America/Denver"
 * @returns {Date}
 */
export function raceStart(date, startTime, timeZone) {
  const [year, month, day] = parseIsoDate(date);
  const [hour, minute] = parseClock(startTime);
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = wall - zoneOffsetMinutes(wall, timeZone) * 60000;
  ts = wall - zoneOffsetMinutes(ts, timeZone) * 60000;
  return new Date(ts);
}

/**
 * Wall-clock fields of an instant in a race's zone.
 * @param {Date|number|string} instant
 * @param {string} timeZone IANA zone id
 * @returns {{year:number, month:number, day:number, hour:number, minute:number,
 *            weekday:number, iso:string}} weekday is 0 (Sunday) – 6 (Saturday);
 *          iso is the race-local calendar date, "YYYY-MM-DD".
 */
export function raceLocalParts(instant, timeZone) {
  const c = civilFields(toInstant(instant), timeZone);
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
 * @param {Date|number|string} value instant, or a "YYYY-MM-DD" race-local date
 * @param {string} timeZone IANA zone id
 * @param {{offsetDays?: number}} [opts] days to add (−3 for D-3)
 * @returns {string} e.g. "Friday"
 */
export function weekdayName(value, timeZone, opts = {}) {
  const offsetDays = opts.offsetDays ?? 0;
  const civil =
    typeof value === "string" && ISO_DATE.test(value)
      ? { iso: value }
      : raceLocalParts(value, timeZone);
  const [year, month, day] = parseIsoDate(civil.iso);
  // Civil-day arithmetic in UTC: no DST, so "+1 day" is exactly one calendar day.
  return WEEKDAY_NAMES.format(new Date(Date.UTC(year, month - 1, day + offsetDays)));
}

/**
 * Weekday names for the race-week protocol: D-3 through race day.
 * A Friday race gives Tuesday / Wednesday / Thursday / Friday; a Saturday race
 * gives Wednesday / Thursday / Friday / Saturday.
 * @param {string} date race-local calendar date, "YYYY-MM-DD"
 * @param {string} timeZone IANA zone id
 * @returns {{d3:string, d2:string, d1:string, raceDay:string}}
 */
export function raceWeekLabels(date, timeZone) {
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
 * @param {unknown} tz
 * @returns {boolean}
 */
export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || tz === "") return false;
  try {
    if (Intl.supportedValuesOf("timeZone").includes(tz)) return true;
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
