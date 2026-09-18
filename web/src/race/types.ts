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
      (editable in the race folder's race.json; 0/absent = none). */
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
    source?: string;
    /** Left behind by the race-folder split — the numbers are personal and
        live in crew-base.json now (tt-yib.2). Kept for older course.json. */
    emergency?: { label: string; phone: string }[];
    rules: string[];
    cell_strategy: string;
    station_notes: Record<string, string>;
    start_notes: string;
    /** how crews get around this course — replaces what used to be a
        hard-coded sentence in CrewSheet. Optional: falls back to generic. */
    driving?: string;
  } | null;
  /** race.json `sources` — what the aid chart and cutoffs were read from, so
      the crew sheet can name the document instead of hard-coding a year. */
  sources?: { kind: "url" | "pdf" | "gpx"; ref: string }[];
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
  /** Race-day emergency contacts, from races/<slug>/crew.private.json — they
      are personal, so they ride in this gitignored file, not course.json. */
  emergency?: { label: string; phone: string }[];
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

/** Which optional panels/cards a race even has. An ABSENT flag means on:
    a folder written before a flag existed keeps rendering as it did, so
    hiding something is always an explicit `false`. See race/features.ts,
    which is the only place that reads these. */
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

/**
 * Who last set a field — re-intake keeps `by: "user"` fields. Keyed by field
 * path, so a matcher entry can be about one station ("aid_stations[3].gpx_wpt").
 * "computed" is scripts/race-sun.mjs; "matcher" is the aid-station ↔ GPX
 * waypoint match in scripts/race-build.mjs, which also reports how it decided.
 */
export type RaceProvenanceEntry = {
  by: "user" | "agent" | "computed" | "matcher";
  at: string;
  source?: string;
  /** matcher only: 0..1 — below aid-match's LOW_CONFIDENCE it is never written. */
  confidence?: number;
  /** matcher only: how the waypoint was found. */
  method?: "exact" | "fuzzy" | "distance" | null;
};

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
  /** race-local wall clock, computed from date + coords by scripts/race-sun.mjs */
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

/** config/goals.json — what generic mode trains toward in place of a race
    (PRD §5.3). Validated by scripts/goals.mjs; every field is advisory prose
    except the volume band, which is the only number a raceless week has. */
export type Goals = {
  event_class?: string;
  horizon?: string;
  phase?: string;
  weekly_volume_band?: { dist_mi?: [number, number]; vert_ft?: [number, number] };
  notes?: string;
};

/** Generic mode's block: the 12 ISO weeks ending with the current one,
    computed by scripts/block.mjs — the SAME function that builds the coach's
    window, so the client never re-derives it (a one-day disagreement would
    shift every weekly bucket by a column). */
export type RollingBlock = {
  mode: "rolling";
  start_date: string;
  total_weeks: number;
  targets: RaceBlock["targets"];
};

/** The block the app is training in, whichever kind it is. `mode` is the
    discriminator so no consumer has to sniff fields to tell them apart. */
export type ActiveBlock = (RaceBlock & { mode: "race" }) | RollingBlock;

/** GET /api/race/active — `active: null` is generic mode (no race), and it is
    described just as fully as a race: goals, the rolling block, the generic
    plan. Assembled by scripts/race-payload.mjs. */
export type ActiveRaceResponse = {
  active: string | null;
  race?: RaceConfig | null;
  /** null whenever a race IS active — then the race is the goal. */
  goals?: Goals | null;
  /** null only for a race folder that carries no block.json yet (a draft the
      intake hasn't planned). Generic mode always has one. */
  block?: ActiveBlock | null;
  plan?: RacePlan | null;
  nutrition?: NutritionConfig | null;
  /** local config was broken and the server fell back to generic mode */
  warning?: string;
};
