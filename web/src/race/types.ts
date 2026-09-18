/* ------------------------------------------------------------------ */
/*  Race data shapes — mirrors the JSON written by                     */
/*  scripts/build-course.mjs (course.json) and                         */
/*  scripts/sync-streams.mjs (climbs.json).                            */
/* ------------------------------------------------------------------ */

import type { NutritionConfig } from "./nutrition";

export type CourseProfilePoint = {
  mi: number;
  ele_ft: number;
  grade_pct: number;
};

export type CourseAidStation = {
  name: string;
  /** Official chart mile (table source of truth). */
  total_mi: number;
  /** Mile measured by snapping the GPX waypoint to the track (plot position).
      Always set by build-course.mjs — the plot/ETA axis space. */
  gpx_mi: number;
  seg_mi: number | null;
  seg_gain_ft: number | null;
  /** Cutoff as elapsed hours from the start, null if none posted. */
  cutoff_h: number | null;
  /** Station coordinates (GPX waypoint; track end for the finish). */
  lat?: number;
  lon?: number;
  crew: boolean;
  crew_only: boolean;
  drop_bag: boolean;
  pacers: boolean;
  water_only: boolean;
  notes: string;
  /** %-slowdown for technical tread on the segment INTO this station
      (editable in config/race-course.json; 0/absent = none). */
  tech_pct?: number;
};

export type RaceClimb = {
  id: string;
  label: string;
  start_mi: number;
  end_mi: number;
  length_mi: number;
  gain_ft: number;
  avg_grade_pct: number;
  max_grade_pct: number;
  profile: CourseProfilePoint[];
};

export type Course = {
  generated_at: string;
  source: string;
  distance_mi: number;
  gain_ft: number;
  official_distance_mi: number;
  official_gain_ft: number;
  sun: { sunset: string; sunrise: string };
  profile: CourseProfilePoint[];
  aid_stations: CourseAidStation[];
  race_climbs: RaceClimb[];
  /** [lat, lon] polyline for the crew-sheet overview map */
  map_track?: [number, number][];
  /** crew rules / directions distilled from the official crew manual */
  crew_info?: {
    source: string;
    emergency: { label: string; phone: string }[];
    rules: string[];
    cell_strategy: string;
    station_notes: Record<string, string>;
    start_notes: string;
  } | null;
};

/** crew-base.json — gitignored (contains the lodging address); written by
    build-course.mjs from config/profile.json's `race_base`. */
export type CrewBase = {
  generated_at: string;
  base: {
    label: string;
    address: string;
    lat: number;
    lon: number;
    drive_to_start_min: number | null;
    drive_to_start_mi: number | null;
  };
  /** OSRM driving estimates from the base, keyed by station name */
  drives: Record<string, { min: number; mi: number }>;
};

export type TrainingClimb = {
  activity_id: string;
  date: string;
  title: string;
  start_mi: number;
  length_mi: number;
  gain_ft: number;
  avg_grade_pct: number;
  max_grade_pct: number;
  strava_url?: string;
};

export type ClimbsSnapshot = {
  fetched_at: string;
  window_days: number;
  activities_scanned: number;
  activities_pending: number;
  climbs: TrainingClimb[];
};

/* ------------------------------------------------------------------ */
/*  Race folder config — mirrors races/<slug>/*.json, validated by     */
/*  scripts/race-config.mjs and served merged by GET /api/race/active. */
/*  Field names follow docs/PRD-modular-races.md §5.1/§5.2 exactly.    */
/* ------------------------------------------------------------------ */

/** At most one folder is "active"; a draft is never read by the training views. */
export type RaceStatus = "draft" | "active" | "archived";

/** Which optional panels/cards a race even has. Absent flag = off. */
export type RaceFeatures = {
  crew?: boolean;
  drop_bags?: boolean;
  pacers?: boolean;
  night?: boolean;
  heat?: boolean;
  altitude?: boolean;
  water_crossings?: boolean;
} & Record<string, boolean | undefined>;

export type RaceElevation = {
  min_ft?: number;
  max_ft?: number;
  avg_ft?: number;
  /** drives the coach's altitude guidance and the projection caveat */
  altitude_significant?: boolean;
};

/** One row of the official aid chart. `total_mi` is the chart mile (the
    source of truth); build-course.mjs derives the plotted `gpx_mi` from it. */
export type RaceAidStation = {
  name: string;
  /** waypoint name in course.gpx, for snapping */
  gpx_wpt?: string;
  seg_mi?: number | null;
  total_mi: number;
  seg_gain_ft?: number | null;
  tech_pct?: number;
  /** elapsed hours from the start; `cutoff_clock` wins when both exist */
  cutoff_h?: number | null;
  cutoff_clock?: string | null;
  crew?: boolean;
  crew_only?: boolean;
  drop_bag?: boolean;
  pacers?: boolean;
  water_only?: boolean;
  menu?: "full" | "basic" | "backcountry";
  lat?: number;
  lon?: number;
  notes?: string;
};

/** Hand/intake-named climbs, resolved into full RaceClimbs by build-course. */
export type RaceClimbSpec = {
  id: string;
  label: string;
  approx_mi: [number, number];
};

/** Prose handed to the coach verbatim (intake-written, user-editable). */
export type RaceCoachNotes = {
  terrain?: string;
  climate?: string;
  altitude?: string;
  key_demands?: string;
  race_week?: string;
} & Record<string, string | undefined>;

export type RaceVisual = {
  theme_preset?: string;
  accent?: string;
  hero?: string;
  panels?: Record<string, boolean>;
  /** per-token overrides on top of the preset */
  overrides?: Record<string, string>;
};

/** Who last set a top-level field — re-intake keeps `by: "user"` fields. */
export type RaceProvenanceEntry = { by: "user" | "agent"; at: string; source?: string };

export type RaceSource = { kind: "url" | "pdf" | "gpx"; ref: string; fetched_at?: string };

/** races/<slug>/race.json */
export type RaceConfig = {
  schema_version: number;
  slug: string;
  status: RaceStatus;
  name: string;
  short: string;
  edition_year?: number;
  /** race-local calendar date, YYYY-MM-DD */
  date: string;
  /** race-local start, HH:MM */
  start_time: string;
  /** IANA zone — every race-local clock derives from it */
  timezone: string;
  location?: string;
  format?: "point_to_point" | "out_and_back" | "loop";
  distance_mi: number;
  gain_ft: number;
  elevation?: RaceElevation;
  /** overall finish cutoff, elapsed hours; null when the race posts none */
  cutoff_h?: number | null;
  features?: RaceFeatures;
  /** race-local, computed from date + coords by build-course.mjs */
  sun?: { sunset: string; sunrise: string };
  aid_stations: RaceAidStation[];
  race_climbs?: RaceClimbSpec[];
  crew_info?: {
    rules?: string[];
    cell_strategy?: string;
    station_notes?: Record<string, string>;
    start_notes?: string;
    driving?: Record<string, unknown>;
  };
  coach_notes?: RaceCoachNotes;
  links?: Record<string, string>;
  visual?: RaceVisual;
  provenance?: Record<string, RaceProvenanceEntry>;
  sources?: RaceSource[];
};

/** races/<slug>/block.json — today's state.block, per race. */
export type RaceBlock = {
  start_date: string;
  total_weeks: number;
  targets: { wk: number; target_dist: number; target_elev: number }[];
};

/** races/<slug>/plan.json — today's state.plan_blocks, agent-managed.
    Structurally the PlanBlock of data.ts; kept local so the race config
    types stay free of the dashboard module graph. */
export type RacePlan = {
  plan_blocks: {
    wk: number;
    label: string;
    dist_mi: number;
    elev_ft: number;
    focus: string;
    key_session?: string;
    quality?: number;
  }[];
};

/** GET /api/race/active — `{ active: null }` is generic mode (no race). */
export type ActiveRaceResponse = {
  active: string | null;
  race?: RaceConfig;
  block?: RaceBlock | null;
  plan?: RacePlan | null;
  nutrition?: NutritionConfig | null;
};
