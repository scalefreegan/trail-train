/* ------------------------------------------------------------------ */
/*  Race data shapes — mirrors the JSON written by                     */
/*  scripts/build-course.mjs (course.json) and                         */
/*  scripts/sync-streams.mjs (climbs.json).                            */
/* ------------------------------------------------------------------ */

import type { NutritionConfig } from "./nutrition";
import type { ProvenanceBy, RaceStatus } from "../contracts";

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
  /** null/absent when the folder's course was built before its date was
      known (race-build.mjs runs stage-2 sun computation off race.date +
      race.timezone; a draft written before either existed has neither, so
      build-course.mjs copies through whatever race.json has — nothing).
      Every consumer must treat this as an honest "not computed yet", never
      dereference it unguarded — see useRacePlan's derived `sun`. */
  sun?: { sunset: string; sunrise: string } | null;
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
    build-course.mjs from `races/<slug>/crew.private.json`. The file exists
    whenever that private file does; the two things in it are independent, so
    a race with emergency numbers and no race-week lodging still gets one
    (tt-yib.9). */
export type CrewBase = {
  generated_at: string;
  /** null when the folder carries no race-week lodging — every consumer has
      to render without it rather than assume a base exists. */
  base: {
    label: string;
    address: string;
    lat: number;
    lon: number;
    drive_to_start_min: number | null;
    drive_to_start_mi: number | null;
  } | null;
  /** OSRM driving estimates from the base, keyed by station name (empty with
      no base — there is nowhere to drive from) */
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

/** One run's distance-weighted mean elevation, out of its cached altitude
    stream. The streams themselves live in a gitignored cache the browser
    cannot read, so this one number rides along in climbs.json for the
    altitude back-test (web/src/race/calibration.ts). */
export type ActivityElevation = {
  activity_id: string | number;
  date: string;
  mean_ele_ft: number;
};

export type ClimbsSnapshot = {
  fetched_at: string;
  window_days: number;
  activities_scanned: number;
  activities_pending: number;
  climbs: TrainingClimb[];
  /** Optional: a climbs.json written before PRD-v2 §2 has none, and the
      back-test then reports "no per-activity elevations yet" rather than
      treating every run as low. */
  activity_elevations?: ActivityElevation[];
};

/* ------------------------------------------------------------------ */
/*  Race folder config — mirrors races/<slug>/*.json, validated by     */
/*  scripts/race-config.mjs and served merged by GET /api/race/active. */
/*  Field names follow docs/PRD-modular-races.md §5.1/§5.2 exactly.    */
/* ------------------------------------------------------------------ */

/** At most one folder is "active"; a draft is never read by the training views.
    The vocabulary itself is RACE_STATUSES in scripts/contracts.mjs, which is
    what scripts/race-config.mjs validates a folder against. */
export type { RaceStatus };

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
  /** waypoint name in course.gpx, for snapping. Explicitly null when the
      station has been reviewed and has no waypoint (the finish is the track
      end); absent when nothing has looked yet. */
  gpx_wpt?: string | null;
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
  by: ProvenanceBy;
  at: string;
  source?: string;
  /** matcher only: 0..1 — below aid-match's LOW_CONFIDENCE it is never written. */
  confidence?: number;
  /** matcher only: how the waypoint was found. */
  method?: "exact" | "fuzzy" | "distance" | null;
};

export type RaceSource = { kind: "url" | "pdf" | "gpx"; ref: string; fetched_at?: string };

/** PRD §4 — which live tracker race day polls, and who to look for on it.
    `url` is seeded by intake from the race site's tracking link; `bib` and
    `name` are the athlete's and are filled in the review screen, so all
    three are independently absent until they are known. */
export type RaceTracking = {
  /** absolute http(s) URL; scripts/trackers/ picks the adapter by hostname */
  url?: string | null;
  bib?: string | null;
  name?: string | null;
};

/** GET /api/races/:slug/tracker — one poll of the configured tracker,
    served from a 60 s per-race cache. `tracker` is null when the runner is
    not on the tracker's page, or is on it with no checkpoint past the
    start. Errors come back as `{error}` with a status: 404 no tracker
    configured / no adapter for the URL, 501 a recognised but unsupported
    tracker (MAProgress), 502 the tracker was unreachable or unparseable. */
export type TrackerResponse = {
  slug: string;
  /** adapter id, e.g. "opensplittime" */
  source: string;
  tracker: TrackerCheckpoint | null;
  /** true when this answer came from the cache rather than a fresh poll */
  cached: boolean;
  /** how old the cached answer is, seconds; 0 on a fresh poll */
  age_s: number;
  /** ISO instant the underlying poll happened */
  polled_at: string;
};

/** Where the runner was last seen, per the tracker. */
export type TrackerCheckpoint = {
  /** the race.json aid station name when the checkpoint mapped onto one,
      otherwise the tracker's own label */
  station: string;
  /** the tracker's own label for the checkpoint, always */
  checkpoint: string;
  /** false when `station` is the tracker's label because nothing matched */
  matched: boolean;
  /** race-local wall clock the tracker printed, HH:MM */
  clock: string;
  /** hours since the runner's own start, per the tracker */
  elapsed_h: number | null;
  /** adapter id */
  source: string;
  /** ISO instant of the poll that produced this */
  at: string;
  bib: string;
  /** the tracker's status text, e.g. "Finished", "Dropped", "" in progress */
  runner_status: string;
};

/** A race folder is either an A race — the goal a training block counts back
    from — or a B race: a tune-up entered INSIDE somebody else's block
    (PRD-v2 §3). Absent in every folder written before v2, and absent means
    "a"; a "b" folder is never status "active". */
export type RaceKind = "a" | "b";

/** One tune-up as the payload and the coach's facts carry it: enough to draw
    a marker on the trajectory and to plan a taper around, no more. Built by
    scripts/race-config.mjs's bRacesFor. */
export type BRaceSummary = {
  slug: string;
  name: string;
  date: string | null;
  distance_mi: number | null;
  gain_ft: number | null;
  /** whole weeks between this race and the A race, counted in the A race's
      own zone: positive = before it, 0 = race week, negative = after it */
  weeks_out: number | null;
};

/** races/<slug>/race.json */
export type RaceConfig = {
  schema_version: number;
  slug: string;
  status: RaceStatus;
  /** "b" = a tune-up inside `parent_slug`'s block; absent = "a" */
  kind?: RaceKind;
  /** the A race this tune-up sits inside — only ever set on a kind "b" */
  parent_slug?: string;
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
  tracking?: RaceTracking | null;
  visual?: RaceVisual;
  provenance?: Record<string, RaceProvenanceEntry>;
  sources?: RaceSource[];
  /** What the intake wants a human to double-check before this race is
      trusted — written by scripts/race-intake.mjs, read by the review dialog. */
  review_notes?: string;
  /** Field paths nothing could establish. Recomputed on every review write
      (scripts/race-edit.mjs) and gated on before activation. */
  unresolved?: string[];
  /** The owner has seen `unresolved` and accepted what is still missing. */
  /** acknowledged unresolved paths; a legacy boolean true is migrated by the server on the next save */
  unresolved_acknowledged?: boolean | string[];
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
    plan. Assembled by scripts/race-payload.mjs.

    Two questions, one payload (PRD §4, §7): `active` is what the athlete is
    TRAINING for and `viewing` is the folder ON SCREEN. They are the same slug
    in train mode; in view mode `active` is null, `viewing` names an archived
    or draft race being browsed read-only, and `training` carries the
    goals-based window the coach is really working from. */
/** When the athlete reaches the race's elevation, and where that came from
    — derived server-side by scripts/acclimation.mjs from the calendar's
    classified travel events. The planner's manual override is NOT in here:
    it lives in the browser, per slug, and is applied on top (so `source`
    arrives as "calendar" or "default" and only ever becomes "override"
    client-side). */
export type Acclimation = {
  /** YYYY-MM-DD, or null when the race has no date to count back from */
  arrival_date: string | null;
  /** whole days between arrival and race day, >= 0 */
  days_at_altitude: number;
  source: "calendar" | "default" | "override";
  /** present only for source "calendar" — so the planner can name the event
      instead of asking the athlete to trust a bare number */
  matched_event?: { summary: string; start: string; end: string | null; location: string | null };
};

export type ActiveRaceResponse = {
  active: string | null;
  /** "train" = `viewing` is the training target; "view" = read-only browsing. */
  mode?: "train" | "view";
  /** the folder whose race/block/plan/nutrition this payload carries */
  viewing?: string | null;
  race?: RaceConfig | null;
  /** null whenever a race IS active — then the race is the goal. */
  goals?: Goals | null;
  /** null only for a race folder that carries no block.json yet (a draft the
      intake hasn't planned). Generic mode always has one. */
  block?: ActiveBlock | null;
  plan?: RacePlan | null;
  nutrition?: NutritionConfig | null;
  /** View mode only: what the athlete is ACTUALLY training toward while the
      browsed race is on screen — the goals, the rolling window and the
      generic plan. null in train mode, where the race above is the answer. */
  training?: {
    goals: Goals | null;
    block: ActiveBlock | null;
    plan: RacePlan | null;
  } | null;
  /** The tune-up races entered inside the TRAINING race's block, oldest
      first (PRD-v2 §3). Always present; empty in view and generic mode,
      where there is no A-race block for one to belong to. */
  b_races?: BRaceSummary[];
  /** Train mode only (PRD-v2 §2): the arrival at altitude behind the
      projection's acclimation credit. Absent in view and generic mode —
      the planner then falls back to the same day-before default the server
      would have derived. */
  acclimation?: Acclimation;
  /** local config was broken and the server fell back to generic mode */
  warning?: string;
};
