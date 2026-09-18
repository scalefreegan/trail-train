import type { RaceWeekLabels } from "./clock";

/* ------------------------------------------------------------------ */
/*  Race-week protocol prose.                                          */
/*                                                                     */
/*  The "before" section of the nutrition page used to spell the       */
/*  weekdays out — "wed → the gun", "Thu & Fri", "Nothing after noon   */
/*  Friday" — which is only true for a Saturday race. San Juan Softie  */
/*  starts on a Friday and every one of those strings is then a day    */
/*  early, so they are generated here from the race date and its IANA  */
/*  zone instead (PRD §7).                                             */
/*                                                                     */
/*  Kept out of the component and free of JSX so the exact strings the */
/*  page renders can be asserted in a plain node --test snapshot       */
/*  (scripts/race-week.test.mjs) — a weekday off by one is invisible   */
/*  in a screenshot and wrong in a way that costs a race. Only the     */
/*  TYPE comes from ./clock, so node --test can strip the types and     */
/*  import this file directly (see scripts/features.test.mjs).          */
/* ------------------------------------------------------------------ */

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Weekday name shifted by whole days — "Wednesday", -1 → "Tuesday". */
function shiftWeekday(name: string, days: number): string {
  const i = WEEKDAYS.indexOf(name);
  if (i < 0) throw new TypeError(`raceWeek: not a weekday name: ${JSON.stringify(name)}`);
  return WEEKDAYS[(((i + days) % 7) + 7) % 7];
}

/** "Wednesday" → "wed" */
const short = (name: string): string => name.slice(0, 3).toLowerCase();
/** "Wednesday" → "Wed" */
const abbr = (name: string): string => name.slice(0, 3);

export type RaceWeekProse = {
  /** section eyebrow: "wed → the gun" */
  gun: string;
  /** carb + fluid card meta: "thu–fri" (D-2 through D-1) */
  loadDays: string;
  /** "Thu & Fri" */
  loadDaysAbbr: string;
  /** "Thursday and Friday" */
  loadDaysLong: string;
  /** D-1, the day the fibre drops and the coffee stops: "Friday" */
  dayBefore: string;
  /** "Nothing after noon Friday." */
  caffeineCutoff: string;
  /** caffeine card meta: "wed–fri" (D-3 through D-1) */
  taperDays: string;
  /** "Wed–Fri" */
  taperDaysAbbr: string;
  /** sleep card meta: "tue–thu" (D-4 through D-2) */
  sleepDays: string;
  /** "Tuesday through Thursday" */
  sleepBank: string;
  /** "Treat Friday night as a write-off." */
  sleepWriteOff: string;
  /** the night the caffeine is still costing you: "Sunday" (D+1) */
  nightAfter: string;
  /** the far end of the week the plan covers: "Monday" (D+2) */
  weekEnd: string;
};

/**
 * The race-week strings, from the weekday labels alone.
 *
 * Pure and date-free on purpose: `labels` already resolved the race-local
 * calendar, and the two days outside its range (D-4 for the sleep bank, D+1/
 * D+2 for the recovery prose) are pure weekday arithmetic — the day before
 * Wednesday is Tuesday whatever the date was.
 */
export function raceWeekProse(labels: RaceWeekLabels): RaceWeekProse {
  const { d3, d2, d1, raceDay } = labels;
  const d4 = shiftWeekday(d3, -1);
  return {
    gun: `${short(d3)} → the gun`,
    loadDays: `${short(d2)}–${short(d1)}`,
    loadDaysAbbr: `${abbr(d2)} & ${abbr(d1)}`,
    loadDaysLong: `${d2} and ${d1}`,
    dayBefore: d1,
    caffeineCutoff: `Nothing after noon ${d1}.`,
    taperDays: `${short(d3)}–${short(d1)}`,
    taperDaysAbbr: `${abbr(d3)}–${abbr(d1)}`,
    sleepDays: `${short(d4)}–${short(d2)}`,
    sleepBank: `${d4} through ${d2}`,
    sleepWriteOff: `Treat ${d1} night as a write-off.`,
    nightAfter: shiftWeekday(raceDay, 1),
    weekEnd: shiftWeekday(raceDay, 2),
  };
}
