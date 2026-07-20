import { createContext, useContext, useEffect, useMemo, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Contexts + hooks + helpers. The provider components live in        */
/*  providers.tsx (react-refresh needs component-only files).          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Refresh context — drives a "resync everything" pulse               */
/* ------------------------------------------------------------------ */

export type RefreshStep = "strava" | "oura" | "gcal" | "coach";
export type StepStatus = "pending" | "running" | "done" | "error";
export type RefreshCtx = {
  key: number;
  syncing: boolean;
  lastSync: number;
  status: Partial<Record<RefreshStep, StepStatus>>;
  currentStep: RefreshStep | null;
  lastLog: string;
  refresh: () => void;
};
export const RefreshContext = createContext<RefreshCtx>({
  key: 0, syncing: false, lastSync: 0,
  status: {}, currentStep: null, lastLog: "",
  refresh: () => {},
});
export const useRefresh = () => useContext(RefreshContext);

export const REFRESH_STEPS: RefreshStep[] = ["strava", "oura", "gcal", "coach"];

/* ------------------------------------------------------------------ */
/*  Units context — imperial / metric toggle                           */
/* ------------------------------------------------------------------ */

export type System = "imperial" | "metric";
export type UnitsCtx = {
  system: System;
  toggle: () => void;
  // value formatters (input always in imperial source units)
  dist: (mi: number, digits?: number) => string;       // raw number string
  elev: (ft: number) => string;
  temp: (f: number) => string;                          // raw number string
  distUnit: string;                                     // "mi" | "km"
  elevUnit: string;                                     // "ft" | "m"
  tempUnit: string;                                     // "°F" | "°C"
  paceUnit: string;                                     // "/mi" | "/km"
  paceFmt: (sec: number, mi: number) => string;        // "8:42"
  // raw converters (for charts / math)
  distVal: (mi: number) => number;
  elevVal: (ft: number) => number;
};

export const UnitsContext = createContext<UnitsCtx | null>(null);
export const useUnits = () => {
  const v = useContext(UnitsContext);
  if (!v) throw new Error("UnitsProvider missing");
  return v;
};

/* ------------------------------------------------------------------ */
/*  Race + training block defaults                                     */
/*                                                                     */
/*  state.json (web/public/state.json, managed by scripts/state.mjs)   */
/*  is the source of truth for race + block config. These defaults     */
/*  only render while it loads or if it's missing. useBlockConfig()    */
/*  below is the one place components should read this from.           */
/* ------------------------------------------------------------------ */

const DEFAULT_RACE = {
  name: "Mogollon Monster 100",
  short: "MM100",
  distance_mi: 102.3,
  elevation_ft: 15900,
  max_elev_ft: 7912,
  cutoff_h: 38,
  date: "2026-09-12",
  start_time: "06:00",
  location: "Mogollon Rim · Pine, AZ",
  aid_stations: [
    { mi: 11.1, name: "See Canyon" },
    { mi: 21.5, name: "Horton" },
    { mi: 26.8, name: "Fish Hatchery" },
    { mi: 39.2, name: "Myrtle" },
    { mi: 42.8, name: "Buck Springs" },
    { mi: 52.4, name: "Pinchot Cabin" },
    { mi: 58.7, name: "General Springs · Crew" },
    { mi: 61.1, name: "Washington Park" },
    { mi: 72.3, name: "Geronimo" },
    { mi: 81.8, name: "Donahue" },
    { mi: 85.6, name: "Dickerson Flat" },
    { mi: 90.5, name: "Pine Canyon" },
    { mi: 101.1, name: "Pine TH · Finish" },
  ],
};

export type Activity = {
  id: string;
  date: string;
  start_time_local?: string | null;
  title: string;
  type: "run" | "long" | "vert" | "easy" | "workout";
  distance_mi: number;
  elevation_ft: number;
  moving_s: number;
  rpe: 1 | 2 | 3 | 4 | 5;
  strava_url?: string;
  temp_max_f?: number | null;
  temp_avg_f?: number | null;
  apparent_avg_f?: number | null;  // heat index / feels-like, avg over the activity
  humidity_avg?: number | null;
};

/* ---- 20-week training block targets (race = week 20 = Sept 12) ---- */
/*  Block start = Monday April 27, 2026 (race week begins Mon Sept 7)   */

export type WeekTarget = { wk: number; target_dist: number; target_elev: number };

const DEFAULT_BLOCK: { start_date: string; total_weeks: number; targets: WeekTarget[] } = {
  start_date: "2026-04-27",
  total_weeks: 20,
  targets: [
    { wk: 1,  target_dist: 38, target_elev: 5800 },
    { wk: 2,  target_dist: 46, target_elev: 7400 },
    { wk: 3,  target_dist: 52, target_elev: 8900 },
    { wk: 4,  target_dist: 36, target_elev: 5400 },
    { wk: 5,  target_dist: 54, target_elev: 9500 },
    { wk: 6,  target_dist: 60, target_elev: 10800 },
    { wk: 7,  target_dist: 55, target_elev: 9800 },
    { wk: 8,  target_dist: 62, target_elev: 11200 },
    { wk: 9,  target_dist: 38, target_elev: 5800 },
    { wk: 10, target_dist: 70, target_elev: 13400 },
    { wk: 11, target_dist: 78, target_elev: 14600 },
    { wk: 12, target_dist: 72, target_elev: 13200 },
    { wk: 13, target_dist: 42, target_elev: 6100 },
    { wk: 14, target_dist: 68, target_elev: 12400 },
    { wk: 15, target_dist: 58, target_elev: 9400 },
    { wk: 16, target_dist: 52, target_elev: 8200 },
    { wk: 17, target_dist: 42, target_elev: 6200 },
    { wk: 18, target_dist: 30, target_elev: 4200 },
    { wk: 19, target_dist: 18, target_elev: 2400 },
    { wk: 20, target_dist: 102.3, target_elev: 15900 },
  ],
};

export type AidStation = { mi: number; name: string };
export type RaceConfig = {
  name: string;
  short: string;
  distance_mi: number;
  elevation_ft: number;
  max_elev_ft: number;
  cutoff_h: number;
  date: Date;           // local race start (date + start_time)
  location: string;
  aid_stations: AidStation[];
};
export type BlockConfig = {
  race: RaceConfig;
  blockStart: string;   // ISO date, Monday of week 1
  totalWeeks: number;
  targets: WeekTarget[];
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export const within = (iso: string, days: number) => {
  const now = Date.now();
  return now - new Date(iso).getTime() < days * 86400 * 1000;
};

export const daysUntil = (d: Date) => {
  const now = Date.now();
  return Math.max(0, Math.ceil((d.getTime() - now) / 86400000));
};

export function isStale(iso: string, hours = 24) {
  return Date.now() - new Date(iso).getTime() > hours * 3600_000;
}

export function relativeAgo(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export function fmtDuration(secs?: number | null) {
  if (!secs && secs !== 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

/* ------------------------------------------------------------------ */
/*  Strava data context — loads /strava.json snapshot                  */
/* ------------------------------------------------------------------ */

export type StravaCtx = {
  loading: boolean;
  error: string | null;
  fetchedAt: Date | null;
  activities: Activity[];
  // weekly buckets by training block week (1..totalWeeks)
  weekly: { wk: number; dist_mi: number; elev_ft: number; sessions: number }[];
  currentWeek: number; // 1..totalWeeks
};
export const StravaContext = createContext<StravaCtx | null>(null);
export const useStrava = () => {
  const v = useContext(StravaContext);
  if (!v) throw new Error("StravaProvider missing");
  return v;
};

/* ------------------------------------------------------------------ */
/*  Oura context — loads /oura.json snapshot                           */
/* ------------------------------------------------------------------ */

export type OuraDay = {
  day: string;
  sleep_score?: number | null;
  readiness_score?: number | null;
  activity_score?: number | null;
  total_sleep_s?: number | null;
  rem_sleep_s?: number | null;
  deep_sleep_s?: number | null;
  avg_hrv?: number | null;
  avg_hr?: number | null;
  lowest_hr?: number | null;
  temp_deviation_c?: number | null;
  steps?: number | null;
  tags?: { tag_type_code: string | null; comment: string | null; tags: string[] }[];
};
export type OuraRaw = {
  fetched_at: string;
  window: { start: string; end: string };
  summary: Record<string, number | null>;
  days: OuraDay[];
};
export type OuraCtx = {
  loading: boolean;
  connected: boolean;
  error: string | null;
  fetchedAt: Date | null;
  days: OuraDay[];
  latest: OuraDay | null;
  summary: OuraRaw["summary"];
};
export const OuraContext = createContext<OuraCtx | null>(null);
export const useOura = () => {
  const v = useContext(OuraContext);
  if (!v) throw new Error("OuraProvider missing");
  return v;
};

/* ------------------------------------------------------------------ */
/*  Agent / persistent state / calendar loaders                        */
/* ------------------------------------------------------------------ */

export type PlanBlock = {
  wk: number;
  label: string;
  dist_mi: number;
  elev_ft: number;
  focus: string;
  key_session?: string;
  quality?: number;
};
export type AgentReadout = {
  generated_at: string;
  model: string;
  summary: string;
  watch_outs?: string[];
  recommendations?: string[];
  plan_blocks?: PlanBlock[];
};

export type PersistentState = {
  version: number;
  last_updated: string | null;
  race?: {
    name: string;
    short?: string;
    date: string;
    start_time?: string;
    distance_mi: number;
    elevation_ft: number;
    max_elev_ft?: number;
    cutoff_h?: number;
    location?: string;
    aid_stations?: AidStation[];
  };
  block?: {
    start_date: string;
    total_weeks: number;
    targets: WeekTarget[];
  };
  plan_blocks?: PlanBlock[];
  agent_notes?: { at: string; note: string }[];
  preferences?: Record<string, unknown>;
};

export type GCalEvent = {
  id: string;
  summary: string;
  description?: string;
  start: string | null;
  end: string | null;
  all_day: boolean;
  duration_min: number | null;
  location: string | null;
  classification: "race" | "travel" | "appointment" | "training" | "family" | "childcare" | "work" | "other";
  calendar?: string;
  html_link: string | null;
};
export type GCalRaw = {
  fetched_at: string;
  window: { time_min: string; time_max: string };
  calendar_id: string;
  calendar_ids?: string[];
  summary: {
    total_events: number;
    upcoming_events: number;
    races_upcoming: number;
    travel_days_upcoming: string[];
    childcare_days_upcoming?: string[];
  };
  events: GCalEvent[];
};

export function useGoogleCal() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<GCalRaw | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch(`/google-cal.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { setData(d); setMissing(false); })
      .catch(() => setMissing(true));
  }, [refreshKey]);
  return { data, missing, connected: !!data };
}

/* state.json is fetched once (by StateProvider in providers.tsx) and shared
   via this context — it feeds both the agent plan (RoadAhead) and the
   race/block config (useBlockConfig). */
export type StateCtx = { data: PersistentState | null; missing: boolean };
export const PersistentStateContext = createContext<StateCtx>({ data: null, missing: false });

export const usePersistentState = () => useContext(PersistentStateContext);

/**
 * The single source of truth for race + training-block config.
 * Reads state.json (race meta, block start/targets) with the hardcoded
 * defaults as fallback while it loads / if it's missing.
 */
export function useBlockConfig(): BlockConfig {
  const { data: state } = usePersistentState();
  return useMemo(() => {
    const r = { ...DEFAULT_RACE, ...(state?.race ?? {}) };
    const b = state?.block;
    const targets = b?.targets?.length ? b.targets : DEFAULT_BLOCK.targets;
    return {
      race: {
        name: r.name,
        short: r.short ?? DEFAULT_RACE.short,
        distance_mi: r.distance_mi,
        elevation_ft: r.elevation_ft,
        max_elev_ft: r.max_elev_ft ?? DEFAULT_RACE.max_elev_ft,
        cutoff_h: r.cutoff_h ?? DEFAULT_RACE.cutoff_h,
        date: new Date(`${r.date}T${r.start_time ?? DEFAULT_RACE.start_time}:00`),
        location: r.location ?? DEFAULT_RACE.location,
        aid_stations: r.aid_stations?.length ? r.aid_stations : DEFAULT_RACE.aid_stations,
      },
      blockStart: b?.start_date ?? DEFAULT_BLOCK.start_date,
      totalWeeks: b?.total_weeks ?? targets.length,
      targets,
    };
  }, [state]);
}

export function useAgentReadout() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<AgentReadout | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch(`/coach.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setMissing(true));
  }, [refreshKey]);
  return { data, missing };
}

/* ------------------------------------------------------------------ */
/*  Coach facts — deterministic computation over Strava + Oura         */
/* ------------------------------------------------------------------ */

export type Flag = { severity: "info" | "watch" | "warn"; label: string; detail: string };
export type CoachFacts = {
  // load
  d7_dist_mi: number;
  d28_dist_mi: number;
  d7_elev_ft: number;
  d28_elev_ft: number;
  acr_dist: number;     // 7d / (28d/4)
  acr_elev: number;
  longest_d7_mi: number;
  longest_d7_title: string | null;
  sessions_d7: number;

  // recovery
  hrv_d7: number | null;
  hrv_d28: number | null;
  hrv_ratio: number | null;       // d7 / d28
  rhr_d7: number | null;
  rhr_d28: number | null;
  rhr_drift: number | null;       // d7 - d28
  readiness_d7: number | null;
  sleep_d7_total_h: number | null;
  sleep_debt_h: number | null;    // 7×8h target - actual
  recent_tags: { day: string; label: string }[];

  // block
  block_dist_actual: number;
  block_dist_expected: number;
  block_dist_delta_pct: number;
  block_elev_actual: number;
  block_elev_expected: number;
  block_elev_delta_pct: number;

  flags: Flag[];
  recommendations: string[];
};

function avg(values: (number | null | undefined)[]): number | null {
  const vs = values.filter((v): v is number => typeof v === "number");
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
}
function sum(values: (number | null | undefined)[]): number {
  return values.reduce((acc: number, v) => acc + (typeof v === "number" ? v : 0), 0);
}
function withinDays(iso: string, days: number, now = Date.now()): boolean {
  return now - new Date(iso).getTime() < days * 86400 * 1000;
}

export function computeCoachFacts(
  activities: Activity[],
  ouraDays: OuraDay[],
  weekly: { wk: number; dist_mi: number; elev_ft: number }[],
  currentWeek: number,
  targets: WeekTarget[],
): CoachFacts {
  const now = Date.now();

  // load
  const d7  = activities.filter((a) => withinDays(a.date,  7, now));
  const d28 = activities.filter((a) => withinDays(a.date, 28, now));
  const d7_dist_mi  = sum(d7.map((a) => a.distance_mi));
  const d28_dist_mi = sum(d28.map((a) => a.distance_mi));
  const d7_elev_ft  = sum(d7.map((a) => a.elevation_ft));
  const d28_elev_ft = sum(d28.map((a) => a.elevation_ft));
  const longest = d7.reduce<Activity | null>((m, a) => (!m || a.distance_mi > m.distance_mi ? a : m), null);

  // recovery
  const o7  = ouraDays.filter((d) => withinDays(d.day,  7, now));
  const o28 = ouraDays.filter((d) => withinDays(d.day, 28, now));
  const hrv_d7  = avg(o7.map((d) => d.avg_hrv));
  const hrv_d28 = avg(o28.map((d) => d.avg_hrv));
  const rhr_d7  = avg(o7.map((d) => d.lowest_hr));
  const rhr_d28 = avg(o28.map((d) => d.lowest_hr));
  const readiness_d7 = avg(o7.map((d) => d.readiness_score));
  const sleep_total_s = sum(o7.map((d) => d.total_sleep_s));
  const sleep_d7_total_h = sleep_total_s ? sleep_total_s / 3600 : null;
  const sleep_debt_h = sleep_d7_total_h != null ? 7 * 8 - sleep_d7_total_h : null;

  const recent_tags = ouraDays
    .filter((d) => withinDays(d.day, 7, now))
    .flatMap((d) => (d.tags ?? []).map((t) => ({
      day: d.day,
      label: (t.tags && t.tags[0]) || t.tag_type_code || "tag",
    })));

  // block
  const block_dist_actual = sum(weekly.slice(0, currentWeek).map((w) => w.dist_mi));
  const block_elev_actual = sum(weekly.slice(0, currentWeek).map((w) => w.elev_ft));
  const block_dist_expected = sum(targets.slice(0, currentWeek).map((w) => w.target_dist));
  const block_elev_expected = sum(targets.slice(0, currentWeek).map((w) => w.target_elev));
  const block_dist_delta_pct = ((block_dist_actual - block_dist_expected) / Math.max(1, block_dist_expected)) * 100;
  const block_elev_delta_pct = ((block_elev_actual - block_elev_expected) / Math.max(1, block_elev_expected)) * 100;

  // acute:chronic ratio (1.0 = consistent, >1.5 = load spike, <0.8 = detraining)
  const acr_dist = d28_dist_mi > 0 ? d7_dist_mi / (d28_dist_mi / 4) : 1;
  const acr_elev = d28_elev_ft > 0 ? d7_elev_ft / (d28_elev_ft / 4) : 1;

  // flags
  const flags: Flag[] = [];
  if (acr_dist > 1.5) flags.push({ severity: "warn", label: "load spike · distance",
    detail: `7d miles ${(acr_dist).toFixed(2)}× the 28d weekly avg — sharp ramp.` });
  else if (acr_dist > 1.3) flags.push({ severity: "watch", label: "load rising · distance",
    detail: `7d miles ${(acr_dist).toFixed(2)}× the 28d avg.` });
  if (acr_elev > 1.5) flags.push({ severity: "warn", label: "load spike · vert",
    detail: `7d vert ${(acr_elev).toFixed(2)}× the 28d avg — easy to bury yourself here.` });
  if (acr_dist < 0.7 && d28_dist_mi > 30) flags.push({ severity: "watch", label: "volume drop",
    detail: `7d miles only ${(acr_dist).toFixed(2)}× the 28d avg — taper or under-doing it?` });

  if (hrv_d7 != null && hrv_d28 != null) {
    const ratio = hrv_d7 / hrv_d28;
    if (ratio < 0.88) flags.push({ severity: "warn", label: "HRV suppressed",
      detail: `7d HRV ${Math.round(hrv_d7)} ms vs 28d ${Math.round(hrv_d28)} ms (${((ratio - 1) * 100).toFixed(0)}%).` });
    else if (ratio < 0.95) flags.push({ severity: "watch", label: "HRV trending down",
      detail: `7d HRV ${Math.round(hrv_d7)} ms vs 28d ${Math.round(hrv_d28)} ms.` });
  }
  if (rhr_d7 != null && rhr_d28 != null && rhr_d7 - rhr_d28 >= 3)
    flags.push({ severity: "warn", label: "RHR elevated",
      detail: `7d resting HR +${(rhr_d7 - rhr_d28).toFixed(1)} bpm vs 28d baseline — under-recovery signal.` });

  if (sleep_d7_total_h != null && sleep_d7_total_h < 49) // 7h avg
    flags.push({ severity: "warn", label: "sleep debt",
      detail: `${sleep_d7_total_h.toFixed(1)}h slept in 7 days · ${(56 - sleep_d7_total_h).toFixed(1)}h under target.` });

  if (readiness_d7 != null && readiness_d7 < 70)
    flags.push({ severity: "watch", label: "readiness depressed",
      detail: `7d readiness avg ${readiness_d7.toFixed(0)}.` });

  if (block_dist_delta_pct < -10)
    flags.push({ severity: "watch", label: "behind block plan · distance",
      detail: `${block_dist_delta_pct.toFixed(1)}% under expected cumulative.` });
  if (block_elev_delta_pct > 15)
    flags.push({ severity: "info", label: "ahead on vert",
      detail: `+${block_elev_delta_pct.toFixed(0)}% over expected — banking climbing-specific fitness.` });

  // recommendations from flags
  const recommendations: string[] = [];
  if (flags.some((f) => f.label.startsWith("load spike") || f.label === "HRV suppressed" || f.label === "RHR elevated"))
    recommendations.push("Swap the next quality session for an easy aerobic day. Re-assess in 72h.");
  if (flags.some((f) => f.label === "sleep debt"))
    recommendations.push("Protect Tuesday & Friday nights this week — no late screens, lights out by 22:30.");
  if (flags.some((f) => f.label === "HRV suppressed" || f.label === "RHR elevated"))
    recommendations.push("Skip caffeine after 14:00 and add a 10-min Z1 cooldown after every run.");
  if (block_dist_delta_pct < -5 && !flags.some((f) => f.label === "HRV suppressed"))
    recommendations.push("Add one easy 60-90min Z1 day to the week without raising intensity.");
  if (flags.length === 0)
    recommendations.push("All systems green. Hold the current load, finish the block as planned.");
  recommendations.push(`Next quality target: long with 1500m+ vert at MM100-relevant grade.`);

  return {
    d7_dist_mi, d28_dist_mi, d7_elev_ft, d28_elev_ft, acr_dist, acr_elev,
    longest_d7_mi: longest?.distance_mi ?? 0,
    longest_d7_title: longest?.title ?? null,
    sessions_d7: d7.length,
    hrv_d7, hrv_d28, hrv_ratio: hrv_d7 != null && hrv_d28 != null ? hrv_d7 / hrv_d28 : null,
    rhr_d7, rhr_d28, rhr_drift: rhr_d7 != null && rhr_d28 != null ? rhr_d7 - rhr_d28 : null,
    readiness_d7, sleep_d7_total_h, sleep_debt_h, recent_tags,
    block_dist_actual, block_dist_expected, block_dist_delta_pct,
    block_elev_actual, block_elev_expected, block_elev_delta_pct,
    flags, recommendations,
  };
}
