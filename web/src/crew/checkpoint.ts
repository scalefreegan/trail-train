import { projectRace, type RaceProjection } from "../race/pacing";
import { raceStart } from "../race/clock";
import { projectOptions, type CrewData } from "./crewData";

/* ------------------------------------------------------------------ */
/*  "She came through Geronimo at 19:40" → the rest of the sheet.      */
/*  PRD v2 §5, bead tt-cv1b0.8.                                        */
/*                                                                     */
/*  The crew chief has one fact the exported projection does not: a    */
/*  time the runner was actually seen. This module turns that fact     */
/*  into a new projection for everything downstream, using ONLY what   */
/*  the file already carries — the course, the fit, the knobs and the  */
/*  same projectRace the planner runs. Nothing fetches.                */
/*                                                                     */
/*  The arithmetic, deliberately small enough to argue with:           */
/*                                                                     */
/*    1. The bare HH:MM is resolved to hours since the gun — including */
/*       WHICH day it belongs to (resolveClockElapsed, below). This is */
/*       deliberately its OWN day-resolution, not checkpointHold's     */
/*       (bead 06, used by the tracker/race-day path): that path never */
/*       resolves to before the gun, which is exactly wrong for a crew */
/*       chief's typo (see the function's own doc for why, bug 5).     */
/*    2. Planned dwell before that station is subtracted from both     */
/*       the observed and the planned arrival, because a stop does     */
/*       not get faster when the runner does. What is left on each     */
/*       side is MOVING time, and their quotient is how the day is     */
/*       actually going: 1.08 = eight percent slower than the model.   */
/*    3. That quotient is folded into the calibration knob — the one   */
/*       knob that scales every projected pace — and projectRace is    */
/*       run again over the same course and the same fit. The shape    */
/*       of the race (grade, fatigue, restraint, altitude, stops) is   */
/*       untouched; only the athlete's overall pace moves.             */
/*    4. Whatever is left between the re-projection and the observed   */
/*       arrival (rounding, a clamped ratio) is applied as a uniform   */
/*       shift, so the checkpoint row reads back EXACTLY the time the  */
/*       crew typed. A sheet that argues with the crew about a time    */
/*       they watched happen is a sheet they stop believing.           */
/*                                                                     */
/*  The ratio is clamped: a typo ("9:40" for "19:40") must not project */
/*  a finish from a pace nobody ran. The clamp limits the SLOPE only — */
/*  the observed time itself is still honoured by step 4, because it   */
/*  is the one thing here that is not a model output.                  */
/* ------------------------------------------------------------------ */

/** What the updater persists and re-applies on load. */
export type CheckpointEntry = {
  /** station name, exactly as the embedded aid chart spells it */
  station: string;
  /** race-local wall clock, "HH:MM" */
  clock: string;
};

export type CheckpointResult = {
  station: string;
  /** the clock as typed, normalized to zero-padded "HH:MM" */
  clock: string;
  /** "manual · 19:40" — how the race-day screen labels a manual hold too */
  label: string;
  /** course mile of the station */
  mile: number;
  /** index into the embedded station list */
  index: number;
  /** hours since the gun, observed */
  observed_h: number;
  /** hours since the gun, as the exported plan had it */
  planned_h: number;
  /** observed − planned: positive is behind plan */
  delta_h: number;
  /** the moving-pace ratio actually applied (1 = exactly on plan) */
  ratio: number;
  /** true when the ratio hit its bound and the extrapolation was limited */
  clamped: boolean;
  /** true when the RAW (pre-clamp) ratio implies covering the leg in under
      a quarter of the plan's moving time — a split so fast it is far likelier
      to be a mistyped clock than a real performance (bug 5). Still applied
      (the observed clock is honoured regardless, see the file banner above)
      but flagged loudly so the crew catches their own typo. */
  extremePace: boolean;
  /** uniform hours added to the re-projection to pin the checkpoint */
  shift_h: number;
  /** the re-projection itself; every ETA the page shows is this + shift_h */
  proj: RaceProjection;
};

export type CheckpointOutcome =
  | { ok: true; result: CheckpointResult }
  | { ok: false; reason: string };

/** Slack past the posted cutoff that still counts as "during the race" — a
    sweeper walking the last runner in, a finish line that stays up. */
export const RACE_WINDOW_SLACK_H = 3;

/** How far the realized-pace ratio may run before it stops being extrapolated.
    0.6 is a runner an hour up on a 3-hour split; 2.5 is a death march. Beyond
    either, the number is far likelier to be a typo than a performance. */
const MIN_RATIO = 0.6;
const MAX_RATIO = 2.5;

/** Below this fraction of the plan's moving time, a split is flagged as
    implausible rather than just clamped — see `extremePace` on
    CheckpointResult. Well inside MIN_RATIO so the flag is reserved for
    splits the 0.6 floor alone would not call out loudly enough. */
const EXTREME_RATIO = 0.25;

/** How many calendar days past the gun a bare HH:MM may resolve to — a 100
    runs under 48 h; the slack covers a sheet reopened well after the fact. */
const MAX_SPAN_DAYS = 14;

/** localStorage key for one race's last checkpoint. Per slug: a crew chief
    with two sheets open must not have one race's split move the other. */
export function checkpointKey(slug: string): string {
  return `basecamp.crew.${slug}.checkpoint`;
}

/**
 * Read the persisted checkpoint back.
 *
 * Every access is guarded: a file:// page in a private window (and Safari on
 * an iPhone with cookies blocked) THROWS on the first `localStorage` touch,
 * and a crew sheet that white-screens because it could not remember something
 * is worse than one that simply forgets.
 */
export function loadCheckpoint(slug: string, store: Storage | null = safeStorage()): CheckpointEntry | null {
  if (!store) return null;
  try {
    const raw = store.getItem(checkpointKey(slug));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { station, clock } = parsed as Partial<CheckpointEntry>;
    if (typeof station !== "string" || typeof clock !== "string") return null;
    return { station, clock };
  } catch {
    return null;
  }
}

export function saveCheckpoint(slug: string, entry: CheckpointEntry, store: Storage | null = safeStorage()): void {
  try {
    store?.setItem(checkpointKey(slug), JSON.stringify(entry));
  } catch {
    /* no persistence available — the checkpoint still applies to this view */
  }
}

export function clearCheckpoint(slug: string, store: Storage | null = safeStorage()): void {
  try {
    store?.removeItem(checkpointKey(slug));
  } catch {
    /* see saveCheckpoint */
  }
}

/** `localStorage`, or null where merely NAMING it throws. */
export function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Planned hours stopped at every station BEFORE index `idx`. Dwell is not a
    pace, so it comes off both sides before the ratio is taken. */
function stoppedBeforeH(proj: RaceProjection, idx: number): number {
  let s = 0;
  for (let i = 0; i < idx && i < proj.stations.length; i++) s += proj.stations[i].stop_min / 60;
  return s;
}

/** `date` (a race-local "YYYY-MM-DD") shifted by whole calendar days. Pure
    civil-day arithmetic in UTC — the same trick clock.ts's weekdayName uses
    for D-3/D-2/D-1 — because a day offset has no timezone in it. */
function shiftIsoDate(date: string, days: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/**
 * Which CALENDAR DAY does a bare "HH:MM" belong to, for a crew-typed split?
 *
 * A 100 runs across two or three calendar days and the crew never writes the
 * date, only the clock. checkpointHold (web/src/race/checkpointHold.ts) also
 * answers this question, but for a different caller with a different right
 * answer: the tracker/race-day path reads "which day?" against `now` (the
 * latest occurrence that has already happened) and — deliberately — NEVER
 * resolves to an instant before the gun, because "the runner hasn't started
 * yet" is never the right answer to a live poll. A crew chief typing "05:00"
 * for a 6:00a gun is the opposite case: that is almost always a typo for
 * "15:00" or a slip of AM/PM, and the sheet should say so (bug 5) rather than
 * roll the day forward and hand back a fabricated 23-hour split.
 *
 * So this tries EVERY calendar day the race could plausibly still be
 * running — including days before the gun, so a too-early candidate stays
 * available to be refused rather than being filtered out before it can be —
 * and picks whichever occurrence lands CLOSEST to the plan's own ETA for the
 * named station. The crew is reporting what actually happened, and what
 * happened is usually close to what the model predicted; the caller
 * (`applyCheckpoint`) is what turns "closest still lands at or before the
 * gun" into the refusal message.
 */
function resolveClockElapsed(
  clock: string,
  raceDate: string,
  timeZone: string,
  startMs: number,
  windowEndMs: number,
  plannedH: number,
): number | null {
  const spanDays = Math.min(MAX_SPAN_DAYS, Math.ceil((windowEndMs - startMs) / 86_400_000) + 1);
  let bestMs: number | null = null;
  let bestDiff = Infinity;
  // Starts a day early too: a gun before dawn can make a wall clock typed
  // "the night before" resolve to the calendar day ahead of the race's own
  // start date in race-local terms.
  for (let d = -1; d <= spanDays; d++) {
    let ms: number;
    try {
      ms = raceStart(shiftIsoDate(raceDate, d), clock, timeZone).getTime();
    } catch {
      continue;
    }
    // A day so far past the close it can never be the answer is dropped
    // rather than compared — otherwise a sheet opened long after the race
    // could pick a repeat of the same HH:MM weeks later just because nothing
    // closer happened to be in range.
    if (ms > windowEndMs + 3_600_000) continue;
    const diff = Math.abs((ms - startMs) / 3_600_000 - plannedH);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestMs = ms;
    }
  }
  return bestMs == null ? null : (bestMs - startMs) / 3_600_000;
}

/**
 * Apply a typed checkpoint to the embedded plan.
 *
 * @param data the embedded payload
 * @param base the projection the page is currently showing (the unadjusted
 *   one — the ratio must always be measured against the PLAN, never against a
 *   previous adjustment, or two corrections in a row compound)
 * @param entry what the crew typed
 * @param opts.now unused by the day resolution itself (see
 *   resolveClockElapsed's doc for why); kept for callers/tests that still
 *   want to pin "now" for other reasons.
 * @param opts.current the checkpoint currently in force, if any — used only
 *   to refuse an out-of-order submit (bug 6); pass nothing on first apply,
 *   on load, or on a refused submit that must not move the "current" one.
 */
export function applyCheckpoint(
  data: CrewData,
  base: RaceProjection | null,
  entry: CheckpointEntry,
  opts: { now?: Date | number; current?: CheckpointResult | null } = {},
): CheckpointOutcome {
  if (!base) return { ok: false, reason: "this device could not re-run the projection, so a split cannot move it" };

  const station = entry.station.trim();
  const rawClock = entry.clock.trim();
  if (!station) return { ok: false, reason: "pick the station she came through" };
  const m = /^(\d{1,2}):(\d{2})$/.exec(rawClock);
  if (!m) return { ok: false, reason: "type the time as HH:MM on the race's clock" };
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return { ok: false, reason: "that time could not be placed on the race clock" };
  const clock = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  const index = data.projection.stations.findIndex((s) => s.name === station);
  if (index < 0 || index >= base.stations.length) {
    return { ok: false, reason: `“${station}” is not on this race's aid chart` };
  }

  // Bug 6: a crew chief who types an earlier station's split AFTER a later
  // one is already checked in has almost always fat-fingered which row they
  // meant, not watched the runner go backwards. Silently discarding the more
  // recent, more informative split is worse than refusing — "clear" is the
  // explicit, deliberate way to throw a checkpoint away.
  if (opts.current && index < opts.current.index) {
    return {
      ok: false,
      reason:
        `“${station}” is upstream of “${opts.current.station}”, which is already checked in — ` +
        `“clear” first if that entry was wrong`,
    };
  }

  const start = raceStart(data.race.date, data.race.start_time, data.race.timezone);
  const startMs = start.getTime();
  // A checkpoint cannot happen after the course has closed, so the day search
  // is bounded to the race's own window (see resolveClockElapsed). Slack is
  // added exactly once, uniformly, here — never folded into closeH itself, or
  // a cutoff-less race would get it twice (6 h, not 3).
  const closeH = data.race.cutoff_h ?? data.projection.finish_h.worst;
  const windowEnd = startMs + (closeH + RACE_WINDOW_SLACK_H) * 3_600_000;

  const planned = base.stations[index].eta_h.avg;
  const stopped = stoppedBeforeH(base, index);
  const movingPlanned = planned - stopped;
  if (!(movingPlanned > 0)) {
    return { ok: false, reason: "that station has no projected moving time to compare against" };
  }

  const observed = resolveClockElapsed(clock, data.race.date, data.race.timezone, startMs, windowEnd, planned);
  if (observed == null) return { ok: false, reason: "that time could not be placed on the race clock" };

  const movingObserved = observed - stopped;
  if (!(movingObserved > 0)) {
    return { ok: false, reason: `${clock} is at or before the start — check the clock` };
  }

  const rawRatio = movingObserved / movingPlanned;
  const extremePace = rawRatio < EXTREME_RATIO;
  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, rawRatio));
  const clamped = ratio !== rawRatio;

  // The calibration knob multiplies every projected pace, which is exactly
  // what "she is running 8 % slower than the model said" means. Re-deriving
  // it through projectOptions keeps every OTHER knob threaded by the one
  // mapping crewData.ts owns — a knob added to the planner cannot be dropped
  // here without being dropped on load too, where it is obvious.
  const opt = projectOptions(data);
  const cal = 1 + (opt.calibrationPct ?? 0) / 100;
  let proj: RaceProjection;
  try {
    proj = projectRace(data.course, data.fit, { ...opt, calibrationPct: (cal * ratio - 1) * 100 });
  } catch {
    return { ok: false, reason: "the projection could not be re-run on this device" };
  }

  const shift_h = observed - proj.stations[index].eta_h.avg;
  return {
    ok: true,
    result: {
      station,
      clock,
      label: `manual · ${clock}`,
      mile: base.stations[index].station.total_mi,
      index,
      observed_h: observed,
      planned_h: planned,
      delta_h: observed - planned,
      ratio,
      clamped,
      extremePace,
      shift_h,
      proj,
    },
  };
}
