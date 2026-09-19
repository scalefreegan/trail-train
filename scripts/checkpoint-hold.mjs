// "The runner was last seen at <station> at <HH:MM>" → a race-day hold.
// PRD v2 §4, bead tt-cv1b0.6.
//
// TWIN FILE: web/src/race/checkpointHold.ts is the client copy of this exact
// API, and scripts/checkpoint-hold.test.mjs runs the SAME assertions against
// both, so neither can drift. The duplication is the same bargain clock.ts /
// clock.mjs already made: the Node scripts and the Vite bundle share no
// module graph, and this is ~200 lines with zero dependencies.
//
// Why zero dependencies at all: the static crew export (bead 08) embeds the
// client twin into a single HTML file with no React, no fetch and no dev
// server behind it. A helper that reached for ./clock.mjs could not go.
//
// The zone arithmetic is clock.mjs's two-pass offset inversion, re-stated
// rather than imported for exactly that reason.

/** How far past the gun a bare HH:MM is allowed to be resolved. */
const MAX_SPAN_DAYS = 14;

/** A checkpoint may read a minute before the gun without being pushed to
    the NEXT day (clock skew at the start line, a tracker rounding down). */
const START_TOLERANCE_MS = 60_000;

/** A clock slightly ahead of `now` is still "today", not tomorrow. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

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

function civil(instant, timeZone) {
  const out = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of `timeZone` from UTC in minutes at `instant`. */
function offsetMinutes(instant, timeZone) {
  const c = civil(instant, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return (asUtc - Math.floor(instant / 1000) * 1000) / 60000;
}

/** The instant at which a race-local wall clock occurs. */
function wallToInstant(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = wall - offsetMinutes(wall, timeZone) * 60000;
  ts = wall - offsetMinutes(ts, timeZone) * 60000;
  return ts;
}

function toMs(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

const pad2 = (n) => String(n).padStart(2, "0");

/** "HH:MM" of an instant, on the race's clock. */
function hhmm(instant, timeZone) {
  const c = civil(instant, timeZone);
  return `${pad2(c.hour)}:${pad2(c.minute)}`;
}

/** Comparable form of a station name: case, punctuation and the "#7"
    ordinal races hang off aid stations all dropped. */
function norm(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** …and again without the trailing station number. */
function normNoOrdinal(name) {
  return norm(name).replace(/\s+\d+$/, "");
}

function stationsOf(course) {
  if (Array.isArray(course)) return course;
  const list = course?.aid_stations;
  return Array.isArray(list) ? list : [];
}

/**
 * The course mile of `station`, or null when nothing on the chart is it.
 *
 * Deliberately conservative — exact name, then a normalized name, then the
 * name without its ordinal, and nothing fuzzier. scripts/aid-match.mjs has
 * already had its chance with a real scorer and the full waypoint list;
 * guessing again here would put the hold at the wrong mile.
 *
 * @param {string} station
 * @param {object|Array|null|undefined} course course.json, or its aid_stations
 * @returns {number|null}
 */
export function stationMile(station, course) {
  const wanted = String(station).trim();
  if (!wanted) return null;
  const list = stationsOf(course).filter(
    (s) => typeof s?.name === "string" && typeof s?.total_mi === "number" && Number.isFinite(s.total_mi),
  );
  const exact = list.find((s) => s.name.trim() === wanted);
  if (exact) return exact.total_mi;
  const n = norm(wanted);
  const normed = list.find((s) => norm(s.name) === n);
  if (normed) return normed.total_mi;
  const nn = normNoOrdinal(wanted);
  if (!nn) return null;
  const loose = list.find((s) => normNoOrdinal(s.name) === nn);
  return loose ? loose.total_mi : null;
}

/**
 * Turn "seen at <station> at <HH:MM>" into the hold the race-day screen (and
 * the crew export) holds the runner at.
 *
 * @param {{station?: string|null, clock?: string|null, elapsed_h?: number|null,
 *   source?: string|null}|null|undefined} cp what was observed
 * @param {object|Array|null|undefined} course course.json, or its aid_stations
 * @param {Date|number|string} raceStart the gun, as an instant
 * @param {string} timeZone the race's IANA zone
 * @param {{now?: Date|number|string}} [opts] `now` is the instant a bare
 *   HH:MM is read against; defaults to the wall clock
 * @returns {{mile: number|null, elapsed_h: number|null, source: string,
 *   label: string}|null} null when there was nothing usable to hold on to
 */
export function checkpointHold(cp, course, raceStart, timeZone, opts = {}) {
  const station = typeof cp?.station === "string" ? cp.station.trim() : "";
  const clock = typeof cp?.clock === "string" ? cp.clock.trim() : "";
  const given = typeof cp?.elapsed_h === "number" && Number.isFinite(cp.elapsed_h) ? cp.elapsed_h : null;
  if (!station && !clock && given == null) return null;

  const rawSource = typeof cp?.source === "string" ? cp.source.trim() : "";
  const source = rawSource || "manual";
  const startMs = toMs(raceStart);

  let elapsed = null;
  let stamp = "";

  const m = CLOCK_RE.exec(clock);
  const hour = m ? Number(m[1]) : NaN;
  const minute = m ? Number(m[2]) : NaN;

  if (m && hour <= 23 && minute <= 59 && Number.isFinite(startMs)) {
    // Which DAY does a bare HH:MM belong to? A 100 runs through two or three
    // of them, and the tracker prints a weekday at best. Two disambiguators,
    // in order of how much they actually know:
    //   1. the tracker's own elapsed figure — wrong zero under a wave start,
    //      but never wrong by half a day, so it picks the day exactly;
    //   2. otherwise the clock on the wall: the LATEST occurrence that has
    //      already happened.
    const start = civil(startMs, timeZone);
    const nowMs = opts.now !== undefined ? toMs(opts.now) : Date.now();
    const horizon = Number.isFinite(nowMs) ? nowMs : startMs;
    const spanDays = Math.min(
      MAX_SPAN_DAYS,
      Math.max(1, Math.ceil((horizon - startMs) / 86_400_000) + 1),
    );
    const candidates = [];
    for (let d = 0; d <= spanDays; d++) {
      const ms = wallToInstant(start.year, start.month, start.day + d, hour, minute, timeZone);
      if (ms >= startMs - START_TOLERANCE_MS) candidates.push(ms);
    }
    if (candidates.length > 0) {
      let pick;
      if (given != null) {
        pick = candidates.reduce((best, c) =>
          Math.abs((c - startMs) / 3_600_000 - given) < Math.abs((best - startMs) / 3_600_000 - given) ? c : best);
      } else {
        const past = candidates.filter((c) => c <= horizon + FUTURE_TOLERANCE_MS);
        pick = past.length > 0 ? Math.max(...past) : Math.min(...candidates);
      }
      elapsed = (pick - startMs) / 3_600_000;
      stamp = hhmm(pick, timeZone);
    }
  }

  if (elapsed == null && given != null) {
    // No clock (or an unparseable one): the tracker's elapsed is all there
    // is. Its zero may be the runner's wave rather than the gun.
    elapsed = given;
    if (Number.isFinite(startMs)) stamp = hhmm(startMs + given * 3_600_000, timeZone);
  }

  const kind = source === "manual" ? "manual" : "tracker";
  return {
    mile: station ? stationMile(station, course) : null,
    elapsed_h: elapsed,
    source,
    label: stamp ? `${kind} · ${stamp}` : kind,
  };
}
