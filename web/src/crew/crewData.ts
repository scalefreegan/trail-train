import type { Course, CrewBase, RaceConfig } from "../race/types";
import type { PaceGradeCurve, PacingFit, ProjectOptions, Scenario } from "../race/pacing";
import type { DropBag, FuelPlan, FuelSegment, NutritionConfig } from "../race/nutrition";

/* ------------------------------------------------------------------ */
/*  The crew export's data contract (PRD v2 §5).                       */
/*                                                                     */
/*  scripts/crew-export.mjs WRITES one of these into the built shell    */
/*  as a <script id="crew-data" type="application/json"> block; the     */
/*  page (src/crew/main.ts) READS it back and renders offline from      */
/*  nothing else. Nothing in the exported file ever fetches: every      */
/*  number the crew sees is either in here already (`projection`,       */
/*  `fuel`, `crew_pickups`) or is re-derivable from the inputs that     */
/*  are also in here (`course` + `fit` + `grade_curve` + `knobs`),      */
/*  which is what lets the page re-project locally when a crew chief    */
/*  types "she came through Geronimo at 19:40" (bead 08).               */
/*                                                                     */
/*  So the file carries the projection TWICE over: once evaluated (the  */
/*  ETAs as of export time) and once as the inputs that produced it.    */
/*  That redundancy is deliberate — the evaluated copy is what the      */
/*  page shows on load with no work, and the inputs are what a local    */
/*  re-projection needs. They agree at export time by construction:     */
/*  crew-export.mjs runs the SAME projectRace() the page bundles, via   */
/*  Node's type stripping, so there is one model and not a server copy  */
/*  of it.                                                              */
/* ------------------------------------------------------------------ */

/** Bumped when a field the page depends on changes shape. main.ts refuses a
    file it does not understand rather than rendering half a sheet. */
export const CREW_DATA_SCHEMA_VERSION = 1;

/** The id of the JSON block in the shell. One name, shared by the writer
    (crew-export.mjs), the reader (main.ts) and crew.html's placeholder. */
export const CREW_DATA_ELEMENT_ID = "crew-data";

/** The planner knobs the projection was run at — ProjectOptions minus the
    grade curve, which rides separately because it is a snapshot of the
    athlete's fitted curve rather than a setting anyone turns.

    KEEP IN SYNC with useRacePlan's `settings` (web/src/race/useRacePlan.ts):
    the export's whole point is that the crew sheet matches the planner the
    athlete was looking at when they pressed the button. */
export type CrewKnobs = Required<Pick<ProjectOptions,
  "fatiguePctPer10mi" | "calibrationPct" | "restraintPct" | "aidStopMin" | "crewStopMin" | "stopOverridesMin"
>> & { goalH: number | null };

/** The planner's own defaults, for a CLI export with no --knobs file.
    KEEP IN SYNC with useRacePlanInstance's usePersistedNumber initial values.
    `goalH` is the exception: its default is a function of the race's cutoff
    (see defaultGoalH), so it is filled per race rather than fixed here. */
export const DEFAULT_CREW_KNOBS: Omit<CrewKnobs, "goalH"> = {
  fatiguePctPer10mi: 5,
  calibrationPct: 6,
  restraintPct: 8,
  aidStopMin: 5,
  crewStopMin: 10,
  stopOverridesMin: {},
};

/** 85 % of the cutoff to the nearest half hour — the planner's goal default.
    KEEP IN SYNC with useRacePlanInstance's `goalDefaultH`. */
export function defaultGoalH(cutoffH: number | null | undefined): number {
  return cutoffH != null && cutoffH > 0 ? Math.round(cutoffH * 0.85 * 2) / 2 : 32;
}

/** One row of the crew sheet's station table: the course station merged with
    what the projection says about it, with race-local wall clocks already
    formatted (the page must not have to know the athlete's zone rules). */
export type CrewStation = {
  name: string;
  /** official chart mile — what the crew's own paperwork says */
  total_mi: number;
  /** the mile the projection ran on (GPX-measured) */
  gpx_mi: number;
  crew: boolean;
  crew_only: boolean;
  drop_bag: boolean;
  pacers: boolean;
  water_only: boolean;
  notes: string;
  /** posted cutoff, elapsed hours from the start; null when none is posted */
  cutoff_h: number | null;
  cutoff_clock: string | null;
  seg_mi: number;
  seg_gain_ft: number;
  /** planned dwell here, minutes */
  stop_min: number;
  eta_h: Record<Scenario, number>;
  /** the same three ETAs on the race's wall clock ("6:12p", "2:14a+1") */
  clock: Record<Scenario, string>;
  goal_eta_h: number | null;
  goal_clock: string | null;
  cutoff_margin_h: number | null;
  cutoff_margin_worst_h: number | null;
};

/** The projection as of export time, flattened to JSON. RaceProjection itself
    carries closures (elapsedAtMile, paceAtMile) that cannot be serialized —
    the page gets those back by re-running projectRace on `course`/`fit`. */
export type CrewProjection = {
  finish_h: Record<Scenario, number>;
  finish_clock: Record<Scenario, string>;
  stopped_h: number;
  goal_h: number | null;
  grade_basis: string;
  stations: CrewStation[];
};

/** What the crew hands over at one crew-access station: the leg the runner
    leaves on, and the drop bag waiting there if there is one. */
export type CrewPickup = {
  station: string;
  total_mi: number;
  /** expected (avg-scenario) arrival, elapsed hours + race-local clock */
  eta_h: number;
  clock: string;
  /** the fuel leg DEPARTING this station; null at the finish */
  segment: FuelSegment | null;
  drop_bag: DropBag | null;
};

/** race.json's crew-facing subset. The whole file is not embedded: intake
    prose, provenance and the review-screen bookkeeping are of no use to a
    crew chief standing in a parking lot at 2 a.m. */
export type CrewRace = Pick<RaceConfig,
  "slug" | "name" | "short" | "date" | "start_time" | "timezone" | "distance_mi" | "gain_ft"
> & Pick<RaceConfig, "location" | "cutoff_h" | "sun" | "links" | "crew_info" | "features" | "sources">;

export type CrewData = {
  schema_version: number;
  /** ISO instant the export ran */
  generated_at: string;
  slug: string;
  race: CrewRace;
  /** build/course.json verbatim: profile, aid stations, climbs, map track,
      crew prose. The projection inputs AND everything bead 08 draws. */
  course: Course;
  /** build/crew-base.json — lodging, drive times, emergency numbers. Personal
      (it is gitignored at rest), and it is embedded because the crew is
      exactly who it is for. null when the folder has no crew.private.json. */
  crew_base: CrewBase | null;
  knobs: CrewKnobs;
  fit: PacingFit;
  grade_curve: PaceGradeCurve;
  projection: CrewProjection;
  /** the whole fueling plan; null when no nutrition config could be read */
  fuel: FuelPlan | null;
  /** the fuel plan sliced by crew-access station — what to have in hand */
  crew_pickups: CrewPickup[];
  nutrition: NutritionConfig;
};

/** Read the embedded block out of the page. Returns null when the shell was
    opened un-injected (the placeholder is an empty object) so the page can
    say so instead of throwing into a blank screen. */
export function readCrewData(doc: Document = document): CrewData | null {
  const el = doc.getElementById(CREW_DATA_ELEMENT_ID);
  if (!el?.textContent) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(el.textContent);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const data = parsed as Partial<CrewData>;
  return data.schema_version === CREW_DATA_SCHEMA_VERSION && data.course != null ? (data as CrewData) : null;
}
