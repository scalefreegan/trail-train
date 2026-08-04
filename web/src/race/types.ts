/* ------------------------------------------------------------------ */
/*  Race data shapes — mirrors the JSON written by                     */
/*  scripts/build-course.mjs (course.json) and                         */
/*  scripts/sync-streams.mjs (climbs.json).                            */
/* ------------------------------------------------------------------ */

export type CourseProfilePoint = {
  mi: number;
  ele_ft: number;
  grade_pct: number;
};

export type CourseAidStation = {
  name: string;
  /** Official chart mile (table source of truth). */
  total_mi: number;
  /** Mile measured by snapping the GPX waypoint to the track (plot position). */
  gpx_mi: number | null;
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
