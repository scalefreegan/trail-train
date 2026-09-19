import { projectRace, type RaceProjection } from "../race/pacing";
import { checkpointHold } from "../race/checkpointHold";
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
/*    1. checkpointHold (bead 06, verbatim, no fork) resolves the      */
/*       station to a course mile and the bare HH:MM to hours since    */
/*       the gun — including WHICH day a 02:10 belongs to.             */
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
  /** the clock as checkpointHold resolved it (day disambiguated) */
  clock: string;
  /** "manual · 19:40" — checkpointHold's own label */
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
const RACE_WINDOW_SLACK_H = 3;

/** How far the realized-pace ratio may run before it stops being extrapolated.
    0.6 is a runner an hour up on a 3-hour split; 2.5 is a death march. Beyond
    either, the number is far likelier to be a typo than a performance. */
const MIN_RATIO = 0.6;
const MAX_RATIO = 2.5;

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

/**
 * Apply a typed checkpoint to the embedded plan.
 *
 * @param data the embedded payload
 * @param base the projection the page is currently showing (the unadjusted
 *   one — the ratio must always be measured against the PLAN, never against a
 *   previous adjustment, or two corrections in a row compound)
 * @param entry what the crew typed
 * @param opts.now the instant "which day is this HH:MM?" is read against
 */
export function applyCheckpoint(
  data: CrewData,
  base: RaceProjection | null,
  entry: CheckpointEntry,
  opts: { now?: Date | number } = {},
): CheckpointOutcome {
  if (!base) return { ok: false, reason: "this device could not re-run the projection, so a split cannot move it" };

  const station = entry.station.trim();
  const clock = entry.clock.trim();
  if (!station) return { ok: false, reason: "pick the station she came through" };
  if (!/^\d{1,2}:\d{2}$/.test(clock)) return { ok: false, reason: "type the time as HH:MM on the race's clock" };

  const start = raceStart(data.race.date, data.race.start_time, data.race.timezone);
  // Which DAY a bare "01:14" belongs to is checkpointHold's job, and it reads
  // it against `now`: the latest occurrence that has already happened. On race
  // day that is exactly right. Opened a week later — an archived sheet, a
  // phone whose clock is wrong — it would resolve the same 01:14 seven days
  // out and report a 163-hour split. A checkpoint cannot happen after the
  // course has closed, so the horizon is clamped to the race's own window and
  // the split lands inside the race whenever the sheet is opened.
  const closeH = data.race.cutoff_h ?? data.projection.finish_h.worst + RACE_WINDOW_SLACK_H;
  const windowEnd = start.getTime() + (closeH + RACE_WINDOW_SLACK_H) * 3_600_000;
  const asked = opts.now === undefined ? Date.now() : new Date(opts.now).getTime();
  const hold = checkpointHold(
    { station, clock, source: "manual" },
    data.course,
    start,
    data.race.timezone,
    { now: Math.min(Number.isFinite(asked) ? asked : windowEnd, windowEnd) },
  );
  if (!hold || hold.mile == null) {
    return { ok: false, reason: `“${station}” is not on this race's aid chart` };
  }
  if (hold.elapsed_h == null) return { ok: false, reason: "that time could not be placed on the race clock" };

  const index = data.projection.stations.findIndex((s) => s.name === station);
  if (index < 0 || index >= base.stations.length) {
    return { ok: false, reason: `“${station}” is not on this race's aid chart` };
  }

  const observed = hold.elapsed_h;
  const planned = base.stations[index].eta_h.avg;
  const stopped = stoppedBeforeH(base, index);
  const movingPlanned = planned - stopped;
  const movingObserved = observed - stopped;
  if (!(movingPlanned > 0)) {
    return { ok: false, reason: "that station has no projected moving time to compare against" };
  }
  if (!(movingObserved > 0)) {
    return { ok: false, reason: `${clock} is at or before the start — check the clock` };
  }

  const rawRatio = movingObserved / movingPlanned;
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
      // checkpointHold's label ends in the clock it actually resolved to
      clock: hold.label.split("·").pop()?.trim() || clock,
      label: hold.label,
      mile: hold.mile,
      index,
      observed_h: observed,
      planned_h: planned,
      delta_h: observed - planned,
      ratio,
      clamped,
      shift_h,
      proj,
    },
  };
}
