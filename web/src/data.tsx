import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

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
const RefreshContext = createContext<RefreshCtx>({
  key: 0, syncing: false, lastSync: Date.now(),
  status: {}, currentStep: null, lastLog: "",
  refresh: () => {},
});
export const useRefresh = () => useContext(RefreshContext);

export const REFRESH_STEPS: RefreshStep[] = ["strava", "oura", "gcal", "coach"];

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  const [key, setKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(() => Date.now() - 12 * 60 * 1000);
  const [status, setStatus] = useState<Partial<Record<RefreshStep, StepStatus>>>({});
  const [currentStep, setCurrentStep] = useState<RefreshStep | null>(null);
  const [lastLog, setLastLog] = useState("");

  const refresh = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setStatus({ strava: "pending", oura: "pending", gcal: "pending", coach: "pending" });
    setCurrentStep(null);
    setLastLog("");

    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      if (!res.body) throw new Error("no body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const parseEvent = (block: string) => {
        const lines = block.split("\n");
        let evt = "message", data = "";
        for (const l of lines) {
          if (l.startsWith("event:")) evt = l.slice(6).trim();
          else if (l.startsWith("data:")) data += l.slice(5).trim();
        }
        if (!data) return;
        let payload: any;
        try { payload = JSON.parse(data); } catch { return; }
        if (evt === "step") {
          const s = payload.id as RefreshStep;
          if (payload.status === "start") {
            setCurrentStep(s);
            setStatus((prev) => ({ ...prev, [s]: "running" }));
            setLastLog(payload.label || `running ${s}`);
          } else if (payload.status === "done") {
            setStatus((prev) => ({ ...prev, [s]: "done" }));
          } else if (payload.status === "error") {
            setStatus((prev) => ({ ...prev, [s]: "error" }));
          }
        } else if (evt === "log") {
          setLastLog(payload.line);
        } else if (evt === "done") {
          if (payload.ok) setLastSync(Date.now());
          setCurrentStep(null);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          parseEvent(block);
        }
      }
    } catch (e) {
      setLastLog(`error: ${(e as Error).message}`);
    } finally {
      // bump key so subscribers refetch /strava.json etc
      setKey((k) => k + 1);
      setSyncing(false);
    }
  }, [syncing]);

  return (
    <RefreshContext.Provider value={{
      key, syncing, lastSync,
      status, currentStep, lastLog,
      refresh,
    }}>
      {children}
    </RefreshContext.Provider>
  );
}

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
  distUnit: string;                                     // "mi" | "km"
  elevUnit: string;                                     // "ft" | "m"
  paceUnit: string;                                     // "/mi" | "/km"
  paceFmt: (sec: number, mi: number) => string;        // "8:42"
  // raw converters (for charts / math)
  distVal: (mi: number) => number;
  elevVal: (ft: number) => number;
};

const MI_TO_KM = 1.609344;
const FT_TO_M = 0.3048;

const UnitsContext = createContext<UnitsCtx | null>(null);
export const useUnits = () => {
  const v = useContext(UnitsContext);
  if (!v) throw new Error("UnitsProvider missing");
  return v;
};

export function UnitsProvider({ children }: { children: React.ReactNode }) {
  const [system, setSystem] = useState<System>(() =>
    (typeof localStorage !== "undefined" && (localStorage.getItem("units") as System)) || "imperial"
  );
  const toggle = useCallback(() => {
    setSystem((s) => {
      const next = s === "imperial" ? "metric" : "imperial";
      try { localStorage.setItem("units", next); } catch {}
      return next;
    });
  }, []);

  const value = useMemo<UnitsCtx>(() => {
    const metric = system === "metric";
    const distVal = (mi: number) => (metric ? mi * MI_TO_KM : mi);
    const elevVal = (ft: number) => (metric ? ft * FT_TO_M : ft);
    return {
      system,
      toggle,
      distVal,
      elevVal,
      distUnit: metric ? "km" : "mi",
      elevUnit: metric ? "m" : "ft",
      paceUnit: metric ? "/km" : "/mi",
      dist: (mi, digits = 1) => distVal(mi).toLocaleString("en-US", {
        minimumFractionDigits: digits, maximumFractionDigits: digits,
      }),
      elev: (ft) => Math.round(elevVal(ft)).toLocaleString("en-US"),
      paceFmt: (sec, mi) => {
        if (!mi) return "—";
        const distanceUnits = metric ? mi * MI_TO_KM : mi;
        const perUnit = sec / distanceUnits;
        const m = Math.floor(perUnit / 60);
        const s = Math.round(perUnit % 60);
        return `${m}:${s.toString().padStart(2, "0")}`;
      },
    };
  }, [system, toggle]);

  return <UnitsContext.Provider value={value}>{children}</UnitsContext.Provider>;
}

/* ------------------------------------------------------------------ */
/*  Race + training block constants                                    */
/* ------------------------------------------------------------------ */

export const RACE = {
  name: "Mogollon Monster 100",
  short: "MM100",
  distance_mi: 102.3,
  elevation_ft: 15900,
  max_elev_ft: 7912,
  cutoff_h: 38,
  date: new Date("2026-09-12T06:00:00"),
  location: "Mogollon Rim · Pine, AZ",
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
  humidity_avg?: number | null;
};

/* ---- 20-week training block targets (race = week 20 = Sept 12) ---- */
/*  Block start = Monday April 27, 2026 (race week begins Mon Sept 7)   */

export const BLOCK_START = "2026-04-27";

export const BLOCK_TARGETS: { wk: number; target_dist: number; target_elev: number }[] = [
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
];

export const TOTAL_WEEKS = 20;

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

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

type StravaRaw = {
  fetched_at: string;
  window: { start: string; end: string };
  totals: { distance_km: number; elevation_m: number; moving_s: number; count: number };
  activities: Array<{
    id: string;
    date: string;
    start_time_local?: string | null;
    title: string;
    sport: string;
    type: Activity["type"];
    distance_m: number;
    elevation_m: number;
    moving_s: number;
    avg_hr: number | null;
    rpe: number;
    strava_url: string;
    weather?: {
      temp_min_c: number;
      temp_max_c: number;
      temp_avg_c: number;
      apparent_avg_c: number | null;
      humidity_avg: number | null;
    } | null;
  }>;
};

export type StravaCtx = {
  loading: boolean;
  error: string | null;
  fetchedAt: Date | null;
  activities: Activity[];
  // weekly buckets by training block week (1..20)
  weekly: { wk: number; dist_mi: number; elev_ft: number; sessions: number }[];
  currentWeek: number; // 1..20
  reload: () => void;
};
const StravaContext = createContext<StravaCtx | null>(null);
export const useStrava = () => {
  const v = useContext(StravaContext);
  if (!v) throw new Error("StravaProvider missing");
  return v;
};

function weekIndex(date: string, blockStart: string) {
  const d = new Date(date).getTime();
  const s = new Date(blockStart + "T00:00:00").getTime();
  const days = Math.floor((d - s) / 86400000);
  return Math.floor(days / 7) + 1; // 1-indexed
}

export function StravaProvider({ children }: { children: React.ReactNode }) {
  const { key: refreshKey } = useRefresh();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<StravaRaw | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/strava.json?t=${Date.now()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<StravaRaw>;
      })
      .then(setData)
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload, refreshKey]);

  const value = useMemo<StravaCtx>(() => {
    const cToF = (c: number) => Math.round(c * 9 / 5 + 32);
    const activities: Activity[] = (data?.activities ?? []).map((a) => ({
      id: a.id,
      date: a.date,
      start_time_local: a.start_time_local ?? null,
      title: a.title,
      type: a.type,
      distance_mi: a.distance_m / M_PER_MI,
      elevation_ft: a.elevation_m / M_PER_FT,
      moving_s: a.moving_s,
      rpe: Math.max(1, Math.min(5, Math.round(a.rpe))) as Activity["rpe"],
      strava_url: a.strava_url,
      temp_max_f: a.weather?.temp_max_c != null ? cToF(a.weather.temp_max_c) : null,
      temp_avg_f: a.weather?.temp_avg_c != null ? cToF(a.weather.temp_avg_c) : null,
      humidity_avg: a.weather?.humidity_avg ?? null,
    }));

    const weekly: { wk: number; dist_mi: number; elev_ft: number; sessions: number }[] =
      Array.from({ length: TOTAL_WEEKS }, (_, i) => ({
        wk: i + 1, dist_mi: 0, elev_ft: 0, sessions: 0,
      }));
    for (const a of activities) {
      const w = weekIndex(a.date, BLOCK_START);
      if (w >= 1 && w <= TOTAL_WEEKS) {
        weekly[w - 1].dist_mi += a.distance_mi;
        weekly[w - 1].elev_ft += a.elevation_ft;
        weekly[w - 1].sessions += 1;
      }
    }
    const today = new Date();
    const cw = Math.max(1, Math.min(TOTAL_WEEKS, weekIndex(today.toISOString(), BLOCK_START)));

    return {
      loading, error,
      fetchedAt: data ? new Date(data.fetched_at) : null,
      activities, weekly, currentWeek: cw,
      reload,
    };
  }, [data, loading, error, reload]);

  return <StravaContext.Provider value={value}>{children}</StravaContext.Provider>;
}

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
type OuraRaw = {
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
const OuraContext = createContext<OuraCtx | null>(null);
export const useOura = () => {
  const v = useContext(OuraContext);
  if (!v) throw new Error("OuraProvider missing");
  return v;
};

export function OuraProvider({ children }: { children: React.ReactNode }) {
  const { key: refreshKey } = useRefresh();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<OuraRaw | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/oura.json?t=${Date.now()}`)
      .then((r) => (r.ok ? (r.json() as Promise<OuraRaw>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const value = useMemo<OuraCtx>(() => {
    const days = (data?.days ?? []).slice().sort((a, b) => b.day.localeCompare(a.day));
    return {
      loading,
      error,
      connected: !!data && days.length > 0,
      fetchedAt: data ? new Date(data.fetched_at) : null,
      days,
      latest: days[0] ?? null,
      summary: data?.summary ?? {},
    };
  }, [data, loading, error]);

  return <OuraContext.Provider value={value}>{children}</OuraContext.Provider>;
}

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
  race?: { name: string; date: string; distance_mi: number; elevation_ft: number };
  block?: {
    start_date: string;
    total_weeks: number;
    targets: { wk: number; target_dist: number; target_elev: number }[];
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
  classification: "race" | "travel" | "appointment" | "training" | "work" | "other";
  html_link: string | null;
};
export type GCalRaw = {
  fetched_at: string;
  window: { time_min: string; time_max: string };
  calendar_id: string;
  summary: {
    total_events: number;
    upcoming_events: number;
    races_upcoming: number;
    travel_days_upcoming: string[];
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

export function usePersistentState() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<PersistentState | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch(`/state.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setMissing(true));
  }, [refreshKey]);
  return { data, missing };
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
  const block_dist_expected = sum(BLOCK_TARGETS.slice(0, currentWeek).map((w) => w.target_dist));
  const block_elev_expected = sum(BLOCK_TARGETS.slice(0, currentWeek).map((w) => w.target_elev));
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
