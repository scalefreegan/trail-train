// Context providers, split from data.ts so that file can export hooks and
// helpers without breaking react-refresh (fast refresh needs component-only
// files). All contexts + hooks live in data.ts; the components live here.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshContext, useRefresh, type RefreshStep, type StepStatus, type RefreshCtx,
  UnitsContext, useUnits, type System, type UnitsCtx,
  StravaContext, type StravaCtx, type Activity,
  OuraContext, type OuraCtx, type OuraRaw,
  PersistentStateContext, type PersistentState,
  useBlockConfig,
} from "./data";

/* ------------------------------------------------------------------ */
/*  Refresh — drives the "resync everything" pulse                     */
/* ------------------------------------------------------------------ */

type RefreshEventPayload = {
  id?: string;
  status?: string;
  label?: string;
  line?: string;
  ok?: boolean;
};

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  const { system } = useUnits();
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
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // the coach step generates its readout in the dashboard's units
        body: JSON.stringify({ units: system }),
      });
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
        let payload: RefreshEventPayload;
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
          setLastLog(payload.line ?? "");
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
  }, [syncing, system]);

  const value = useMemo<RefreshCtx>(() => ({
    key, syncing, lastSync, status, currentStep, lastLog, refresh,
  }), [key, syncing, lastSync, status, currentStep, lastLog, refresh]);

  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

/* ------------------------------------------------------------------ */
/*  Units — imperial / metric toggle                                   */
/* ------------------------------------------------------------------ */

const MI_TO_KM = 1.609344;
const FT_TO_M = 0.3048;

export function UnitsProvider({ children }: { children: React.ReactNode }) {
  const [system, setSystem] = useState<System>(() =>
    (typeof localStorage !== "undefined" && (localStorage.getItem("units") as System)) || "metric"
  );
  const toggle = useCallback(() => {
    setSystem((s) => {
      const next = s === "imperial" ? "metric" : "imperial";
      try { localStorage.setItem("units", next); } catch { /* private mode — preference just won't persist */ }
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
      tempUnit: metric ? "°C" : "°F",
      temp: (f) => String(Math.round(metric ? (f - 32) * 5 / 9 : f)),
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
/*  Strava — loads /strava.json snapshot                               */
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

function weekIndex(date: string, blockStart: string) {
  const d = new Date(date).getTime();
  const s = new Date(blockStart + "T00:00:00").getTime();
  const days = Math.floor((d - s) / 86400000);
  return Math.floor(days / 7) + 1; // 1-indexed
}

type StravaFetch = { loading: boolean; error: string | null; data: StravaRaw | null };

export function StravaProvider({ children }: { children: React.ReactNode }) {
  const { key: refreshKey } = useRefresh();
  const { blockStart, totalWeeks } = useBlockConfig();
  const [fetchState, setFetchState] = useState<StravaFetch>({ loading: true, error: null, data: null });

  useEffect(() => {
    let cancelled = false;
    fetch(`/strava.json?t=${Date.now()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<StravaRaw>;
      })
      .then((d) => { if (!cancelled) setFetchState({ loading: false, error: null, data: d }); })
      .catch((e) => {
        if (!cancelled) setFetchState((s) => ({ loading: false, error: String(e.message || e), data: s.data }));
      });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const value = useMemo<StravaCtx>(() => {
    const { loading, error, data } = fetchState;
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
      apparent_avg_f: a.weather?.apparent_avg_c != null ? cToF(a.weather.apparent_avg_c) : null,
      humidity_avg: a.weather?.humidity_avg ?? null,
    }));

    const weekly: { wk: number; dist_mi: number; elev_ft: number; sessions: number }[] =
      Array.from({ length: totalWeeks }, (_, i) => ({
        wk: i + 1, dist_mi: 0, elev_ft: 0, sessions: 0,
      }));
    for (const a of activities) {
      const w = weekIndex(a.date, blockStart);
      if (w >= 1 && w <= totalWeeks) {
        weekly[w - 1].dist_mi += a.distance_mi;
        weekly[w - 1].elev_ft += a.elevation_ft;
        weekly[w - 1].sessions += 1;
      }
    }
    const today = new Date();
    const cw = Math.max(1, Math.min(totalWeeks, weekIndex(today.toISOString(), blockStart)));

    return {
      loading, error,
      fetchedAt: data ? new Date(data.fetched_at) : null,
      activities, weekly, currentWeek: cw,
    };
  }, [fetchState, blockStart, totalWeeks]);

  return <StravaContext.Provider value={value}>{children}</StravaContext.Provider>;
}

/* ------------------------------------------------------------------ */
/*  Oura — loads /oura.json snapshot                                   */
/* ------------------------------------------------------------------ */

type OuraFetch = { loading: boolean; error: string | null; data: OuraRaw | null };

export function OuraProvider({ children }: { children: React.ReactNode }) {
  const { key: refreshKey } = useRefresh();
  const [fetchState, setFetchState] = useState<OuraFetch>({ loading: true, error: null, data: null });

  useEffect(() => {
    let cancelled = false;
    fetch(`/oura.json?t=${Date.now()}`)
      .then((r) => (r.ok ? (r.json() as Promise<OuraRaw>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (!cancelled) setFetchState({ loading: false, error: null, data: d }); })
      .catch((e) => {
        if (!cancelled) setFetchState((s) => ({ loading: false, error: String(e.message || e), data: s.data }));
      });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const value = useMemo<OuraCtx>(() => {
    const { loading, error, data } = fetchState;
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
  }, [fetchState]);

  return <OuraContext.Provider value={value}>{children}</OuraContext.Provider>;
}

/* ------------------------------------------------------------------ */
/*  Persistent state — loads /state.json once, shared via context      */
/* ------------------------------------------------------------------ */

export function StateProvider({ children }: { children: React.ReactNode }) {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<PersistentState | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch(`/state.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { setData(d); setMissing(false); })
      .catch(() => setMissing(true));
  }, [refreshKey]);
  const value = useMemo(() => ({ data, missing }), [data, missing]);
  return <PersistentStateContext.Provider value={value}>{children}</PersistentStateContext.Provider>;
}
