/* ------------------------------------------------------------------ */
/*  "The runner was last seen at <station> at <HH:MM>" → a race-day     */
/*  hold. PRD v2 §4, bead tt-cv1b0.6.                                   */
/*                                                                      */
/*  ONE function, two callers that share no module graph:               */
/*                                                                      */
/*    · RaceDay.tsx turns a tracker poll (GET /api/races/:slug/tracker) */
/*      or a typed "passed <station> at HH:MM" into the same hold the   */
/*      existing resolveHold path already consumes.                     */
/*    · the static crew export (bead 08) embeds it verbatim, in a page  */
/*      that has no React, no fetch and no dev server.                  */
/*                                                                      */
/*  So it is pure and ZERO-IMPORT: no ./clock, no ./types, nothing.     */
/*  The zone arithmetic below is the same two-pass offset inversion     */
/*  clock.ts documents at length, re-stated in ~30 lines rather than    */
/*  dragging a dependency into a file that has to be copy-pasteable.    */
/*                                                                      */
/*  TWIN FILE: scripts/checkpoint-hold.mjs is the Node ESM copy of this */
/*  exact API and scripts/checkpoint-hold.test.mjs runs the SAME        */
/*  assertions against both, so the two can never drift.                */
/* ------------------------------------------------------------------ */

/** What a tracker poll, or a human, says about where the runner was seen.
    Mirrors the useful half of TrackerCheckpoint (web/src/race/types.ts)
    without importing it — a manual entry fills only `station` + `clock`. */
export type CheckpointObservation = {
  /** the aid station's name, as race.json spells it when the tracker
      managed to map it, otherwise the tracker's own label */
  station?: string | null;
  /** race-local wall clock the checkpoint was recorded at, "HH:MM" */
  clock?: string | null;
  /** hours since the runner's OWN start, per the tracker. Used to pick
      which calendar day a bare HH:MM belongs to, and as the fallback when
      there is no clock at all — never preferred over the clock, because a
      wave start makes the tracker's zero a different zero from the gun's. */
  elapsed_h?: number | null;
  /** adapter id ("opensplittime"), or "manual"/absent for a typed entry */
  source?: string | null;
};

export type CheckpointStation = { name?: string | null; total_mi?: number | null };

/** course.json, its `aid_stations` array, or race.json's — all three shapes
    are accepted so the crew export can hand over whatever it already has. */
export type CheckpointCourse =
  | { aid_stations?: CheckpointStation[] | null }
  | CheckpointStation[]
  | null
  | undefined;

export type CheckpointHold = {
  /** course mile of the station, or null when the name matched nothing on
      the aid chart — the caller must NOT move the runner in that case. */
  mile: number | null;
  /** hours since the gun (raceStart), or null when neither a clock nor an
      elapsed figure was usable */
  elapsed_h: number | null;
  /** "manual" for a typed entry, otherwise the tracker adapter's id */
  source: string;
  /** what the race-day screen prints: "tracker · 21:22" / "manual · 14:05" */
  label: string;
};

/** How far past the gun a bare HH:MM is allowed to be resolved, when the
    race's own cutoff isn't known (see RACE_WINDOW_SLACK_H below for when it
    is). A 100 runs under 48 h; the extra slack covers a hold typed the
    morning after. */
const MAX_SPAN_DAYS = 14;

/** Slack past the posted cutoff that still counts as "during the race" — a
    sweeper walking the last runner in, a finish line that stays up. Same
    name, value and meaning as web/src/crew/checkpoint.ts's own
    RACE_WINDOW_SLACK_H, duplicated rather than imported for the same
    zero-dependency reason this whole file exists (see the file banner):
    that module pulls in the projection/pacing graph this one must not. */
const RACE_WINDOW_SLACK_H = 3;

/** A checkpoint may read a minute before the gun (clock skew at the start
    line, a tracker rounding down) without being pushed to the NEXT day. */
const START_TOLERANCE_MS = 60_000;

/** A clock slightly ahead of `now` (a phone a few minutes fast, a tracker
    stamping in its own skew) is still "today", not tomorrow. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

const CLOCK_RE = /^(\d{1,2}):(\d{2})$/;

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

type Civil = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function civil(instant: number, timeZone: string): Civil {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(timeZone).formatToParts(new Date(instant))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out as unknown as Civil;
}

/** Offset of `timeZone` from UTC in minutes at `instant`. Same second-floor
    as clock.ts: the formatter has no sub-second field. */
function offsetMinutes(instant: number, timeZone: string): number {
  const c = civil(instant, timeZone);
  const asUtc = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return (asUtc - Math.floor(instant / 1000) * 1000) / 60000;
}

/** The instant at which a race-local wall clock occurs. Two passes: the
    first lands within a day of the answer, the second reads the offset
    actually in force there (clock.ts's raceStart, inlined). */
function wallToInstant(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ts = wall - offsetMinutes(wall, timeZone) * 60000;
  ts = wall - offsetMinutes(ts, timeZone) * 60000;
  return ts;
}

function toMs(value: Date | number | string): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "HH:MM" of an instant, on the race's clock. */
function hhmm(instant: number, timeZone: string): string {
  const c = civil(instant, timeZone);
  return `${pad2(c.hour)}:${pad2(c.minute)}`;
}

/** Comparable form of a station name: case, punctuation and the "#7"
    ordinal races hang off aid stations all dropped. */
function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** …and again without the trailing station number, so "Burnett #7" on the
    tracker still finds "Burnett" on the chart. */
function normNoOrdinal(name: string): string {
  return norm(name).replace(/\s+\d+$/, "");
}

function stationsOf(course: CheckpointCourse): CheckpointStation[] {
  if (Array.isArray(course)) return course;
  const list = (course as { aid_stations?: CheckpointStation[] | null } | null | undefined)?.aid_stations;
  return Array.isArray(list) ? list : [];
}

/**
 * The course mile of `station`, or null when nothing on the chart is it.
 *
 * Deliberately conservative — exact name, then a normalized name, then the
 * name without its ordinal, and nothing fuzzier. The server-side matcher
 * (scripts/aid-match.mjs, via the tracker adapters) has already had its
 * chance with a real scorer and the full waypoint list; guessing again here
 * would put the hold at the wrong mile, which is worse than no hold.
 */
export function stationMile(station: string, course: CheckpointCourse): number | null {
  const wanted = station.trim();
  if (!wanted) return null;
  const list = stationsOf(course).filter(
    (s): s is CheckpointStation & { name: string; total_mi: number } =>
      typeof s?.name === "string" && typeof s?.total_mi === "number" && Number.isFinite(s.total_mi),
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
 * @param cp what was observed — a tracker checkpoint or a typed entry
 * @param course course.json (or its aid_stations), for station → mile
 * @param raceStart the gun, as an instant
 * @param timeZone the race's IANA zone — every clock here is race-local
 * @param opts.now the instant to read "which day is this HH:MM?" against;
 *   defaults to the wall clock. Injected by the tests, and by anything
 *   replaying an old race.
 * @param opts.cutoffH the race's own `cutoff_h` — when given (a finite
 *   number), a bare HH:MM can never resolve to an occurrence after the
 *   course closes (plus RACE_WINDOW_SLACK_H), no matter how far past that
 *   point `opts.now` actually is (PR #24 review round 3: RaceDay.tsx calls
 *   this for a manual hold even when the race is long past, and an
 *   unclamped `now` used to let the answer land up to MAX_SPAN_DAYS out).
 *   Without it, MAX_SPAN_DAYS is the only ceiling, same as before this
 *   option existed.
 * @returns the hold, or null when there was nothing usable to hold on to
 */
export function checkpointHold(
  cp: CheckpointObservation | null | undefined,
  course: CheckpointCourse,
  raceStart: Date | number | string,
  timeZone: string,
  opts: { now?: Date | number | string; cutoffH?: number | null } = {},
): CheckpointHold | null {
  const station = typeof cp?.station === "string" ? cp.station.trim() : "";
  const clock = typeof cp?.clock === "string" ? cp.clock.trim() : "";
  const given = typeof cp?.elapsed_h === "number" && Number.isFinite(cp.elapsed_h) ? cp.elapsed_h : null;
  if (!station && !clock && given == null) return null;

  const rawSource = typeof cp?.source === "string" ? cp.source.trim() : "";
  const source = rawSource || "manual";
  const startMs = toMs(raceStart);

  let elapsed: number | null = null;
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
    //      already happened. A manual "passed Burnett at 14:05" typed on the
    //      second afternoon means the second afternoon, not the first.
    const start = civil(startMs, timeZone);
    const nowMs = opts.now !== undefined ? toMs(opts.now) : Date.now();
    const rawHorizon = Number.isFinite(nowMs) ? nowMs : startMs;
    // Clamp to the race's own window when its cutoff is known (see the opts
    // doc above and RACE_WINDOW_SLACK_H) — this is what keeps a manual hold
    // on a long-finished race from resolving to an occurrence days after it
    // actually ended just because `now` is that far past the gun.
    const cutoffH = typeof opts.cutoffH === "number" && Number.isFinite(opts.cutoffH) ? opts.cutoffH : null;
    const windowEndMs = cutoffH != null ? startMs + (cutoffH + RACE_WINDOW_SLACK_H) * 3_600_000 : null;
    const horizon = windowEndMs != null ? Math.min(rawHorizon, windowEndMs) : rawHorizon;
    const spanDays = Math.min(
      MAX_SPAN_DAYS,
      Math.max(1, Math.ceil((horizon - startMs) / 86_400_000) + 1),
    );
    const candidates: number[] = [];
    for (let d = 0; d <= spanDays; d++) {
      const ms = wallToInstant(start.year, start.month, start.day + d, hour, minute, timeZone);
      if (ms >= startMs - START_TOLERANCE_MS) candidates.push(ms);
    }
    if (candidates.length > 0) {
      let pick: number;
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
    // is. Its zero may be the runner's wave rather than the gun — say the
    // number anyway, it is closer than nothing.
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
