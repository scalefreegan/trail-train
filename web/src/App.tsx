import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";

/* ------------------------------------------------------------------ */
/*  Refresh context — drives a "resync everything" pulse               */
/* ------------------------------------------------------------------ */

type RefreshStep = "strava" | "oura" | "coach";
type StepStatus = "pending" | "running" | "done" | "error";
type RefreshCtx = {
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
const useRefresh = () => useContext(RefreshContext);

const REFRESH_STEPS: RefreshStep[] = ["strava", "oura", "coach"];

function RefreshProvider({ children }: { children: React.ReactNode }) {
  const [key, setKey] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState(() => Date.now() - 12 * 60 * 1000);
  const [status, setStatus] = useState<Partial<Record<RefreshStep, StepStatus>>>({});
  const [currentStep, setCurrentStep] = useState<RefreshStep | null>(null);
  const [lastLog, setLastLog] = useState("");

  const refresh = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setStatus({ strava: "pending", oura: "pending", coach: "pending" });
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

type System = "imperial" | "metric";
type UnitsCtx = {
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
const useUnits = () => {
  const v = useContext(UnitsContext);
  if (!v) throw new Error("UnitsProvider missing");
  return v;
};

function UnitsProvider({ children }: { children: React.ReactNode }) {
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
    title: string;
    sport: string;
    type: Activity["type"];
    distance_m: number;
    elevation_m: number;
    moving_s: number;
    avg_hr: number | null;
    rpe: number;
    strava_url: string;
  }>;
};

type StravaCtx = {
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
const useStrava = () => {
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

function StravaProvider({ children }: { children: React.ReactNode }) {
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
    const activities: Activity[] = (data?.activities ?? []).map((a) => ({
      id: a.id,
      date: a.date,
      title: a.title,
      type: a.type,
      distance_mi: a.distance_m / M_PER_MI,
      elevation_ft: a.elevation_m / M_PER_FT,
      moving_s: a.moving_s,
      rpe: Math.max(1, Math.min(5, Math.round(a.rpe))) as Activity["rpe"],
      strava_url: a.strava_url,
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

type OuraDay = {
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
type OuraCtx = {
  loading: boolean;
  connected: boolean;
  error: string | null;
  fetchedAt: Date | null;
  days: OuraDay[];
  latest: OuraDay | null;
  summary: OuraRaw["summary"];
};
const OuraContext = createContext<OuraCtx | null>(null);
const useOura = () => {
  const v = useContext(OuraContext);
  if (!v) throw new Error("OuraProvider missing");
  return v;
};

function OuraProvider({ children }: { children: React.ReactNode }) {
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

function relativeAgo(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

/* ------------------------------------------------------------------ */
/*  Data (mock — wired for Strava MCP swap)                            */
/* ------------------------------------------------------------------ */

const RACE = {
  name: "Mogollon Monster 100",
  short: "MM100",
  distance_mi: 102.3,
  elevation_ft: 15900,
  max_elev_ft: 7912,
  cutoff_h: 38,
  date: new Date("2026-09-12T06:00:00"),
  location: "Mogollon Rim · Pine, AZ",
};

type Activity = {
  id: string;
  date: string;
  title: string;
  type: "run" | "long" | "vert" | "easy" | "workout";
  distance_mi: number;
  elevation_ft: number;
  moving_s: number;
  rpe: 1 | 2 | 3 | 4 | 5;
  strava_url?: string;
};

/* ---- 20-week training block targets (race = week 20 = Sept 12) ---- */
/*  Block start = Monday April 27, 2026 (race week begins Mon Sept 7)   */

const BLOCK_START = "2026-04-27";

const BLOCK_TARGETS: { wk: number; target_dist: number; target_elev: number }[] = [
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

const TOTAL_WEEKS = 20;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const within = (iso: string, days: number) => {
  const now = new Date("2026-05-26T12:00:00").getTime();
  return now - new Date(iso).getTime() < days * 86400 * 1000;
};

const daysUntil = (d: Date) => {
  const now = new Date("2026-05-26T12:00:00").getTime();
  return Math.max(0, Math.ceil((d.getTime() - now) / 86400000));
};

/* ------------------------------------------------------------------ */
/*  Contour topographic backdrop SVG                                   */
/* ------------------------------------------------------------------ */

function ContourBackdrop({ seed = 1, opacity = 0.5 }: { seed?: number; opacity?: number }) {
  // generate concentric, slightly-perturbed closed contours that read as topo
  const paths = useMemo(() => {
    const out: string[] = [];
    const cx = 50 + seed * 7;
    const cy = 50 + seed * 3;
    const rings = 14;
    for (let r = 0; r < rings; r++) {
      const radius = 6 + r * 6;
      const points = 60;
      let d = "";
      for (let i = 0; i <= points; i++) {
        const t = (i / points) * Math.PI * 2;
        // pseudo-random perturbation, deterministic per seed
        const k = Math.sin(t * (3 + (r % 3)) + seed * 1.3 + r * 0.4);
        const k2 = Math.cos(t * (2 + (seed % 4)) + r * 0.7);
        const rad = radius + k * 1.6 + k2 * 1.2;
        const x = cx + Math.cos(t) * rad;
        const y = cy + Math.sin(t) * rad * 0.78;
        d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2) + " ";
      }
      out.push(d + "Z");
    }
    return out;
  }, [seed]);

  return (
    <svg
      className="topo-bg"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      style={{ opacity }}
      aria-hidden
    >
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke="var(--sand)"
          strokeWidth={i % 5 === 0 ? 0.35 : 0.18}
          strokeOpacity={0.7}
        />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Elevation profile SVG for the race                                 */
/* ------------------------------------------------------------------ */

function ElevationProfile() {
  const u = useUnits();
  // 100-mile fictional profile w/ aid stations
  const pts = useMemo(() => {
    const n = 220;
    const arr: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 100;
      // 6 rim climbs + roll — Mogollon profile
      const y =
        50 +
        Math.sin((i / n) * Math.PI * 6) * 20 +
        Math.sin((i / n) * Math.PI * 14) * 5 +
        Math.sin((i / n) * Math.PI * 2.1) * 7 +
        Math.cos((i / n) * Math.PI * 9) * 3;
      arr.push({ x, y: 100 - y });
    }
    return arr;
  }, []);

  const aids = [
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
  ];

  const linePath = "M" + pts.map((p) => p.x.toFixed(2) + " " + p.y.toFixed(2)).join(" L ");
  const areaPath = linePath + ` L 100 100 L 0 100 Z`;

  return (
    <svg viewBox="0 0 100 60" className="block w-full h-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="elevFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--moss)" stopOpacity="0.85" />
          <stop offset="100%" stopColor="var(--moss)" stopOpacity="0.05" />
        </linearGradient>
        <pattern id="hatch" patternUnits="userSpaceOnUse" width="3" height="3" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="3" stroke="var(--moss-deep)" strokeWidth="0.5" opacity="0.35" />
        </pattern>
      </defs>

      {/* horizon grid */}
      {[15, 30, 45].map((y) => (
        <line key={y} x1="0" x2="100" y1={y * 0.6} y2={y * 0.6} stroke="var(--ink)" strokeWidth="0.08" strokeDasharray="0.6 0.8" opacity="0.4" />
      ))}

      <motion.path
        d={areaPath}
        fill="url(#elevFill)"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 1.2, delay: 0.3 }}
      />
      <motion.path
        d={areaPath}
        fill="url(#hatch)"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.55 }}
        transition={{ duration: 1.5, delay: 0.6 }}
      />
      <motion.path
        d={linePath}
        fill="none"
        stroke="var(--ink)"
        strokeWidth="0.45"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 2.2, ease: [0.2, 0.8, 0.2, 1] }}
      />

      {/* aid stations */}
      {aids.map((a, i) => {
        const idx = Math.min(pts.length - 1, Math.max(0, Math.round((a.mi / 102.3) * (pts.length - 1))));
        const p = pts[idx];
        return (
          <g key={a.name}>
            <motion.line
              x1={p.x}
              x2={p.x}
              y1={p.y}
              y2={p.y - 8}
              stroke="var(--blaze)"
              strokeWidth="0.18"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.6, delay: 1.5 + i * 0.08 }}
            />
            <motion.circle
              cx={p.x}
              cy={p.y - 8}
              r="0.7"
              fill="var(--blaze)"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.4, delay: 1.6 + i * 0.08 }}
            />
            {i % 2 === 0 && (
              <motion.text
                x={p.x}
                y={p.y - 9.5}
                fontSize="1.5"
                fontFamily="JetBrains Mono"
                fill="var(--ink)"
                textAnchor="middle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5, delay: 1.8 + i * 0.08 }}
              >
                {Math.round(u.distVal(a.mi))}
              </motion.text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Sparkline                                                          */
/* ------------------------------------------------------------------ */

function Sparkline({ values, color = "var(--ink)" }: { values: number[]; color?: string }) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const w = 200;
  const h = 56;
  const step = w / (values.length - 1);
  const path = values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${i * step} ${h - ((v - min) / span) * h}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="block w-full h-14" preserveAspectRatio="none">
      <path d={`${path} L ${w} ${h} L 0 ${h} Z`} fill={color} opacity="0.08" />
      <motion.path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.4, ease: "easeOut" }}
      />
      {values.map((v, i) => (
        <circle
          key={i}
          cx={i * step}
          cy={h - ((v - min) / span) * h}
          r={i === values.length - 1 ? 2.4 : 1.1}
          fill={color}
        />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Header / Masthead                                                  */
/* ------------------------------------------------------------------ */

function UnitsToggle() {
  const { system, toggle } = useUnits();
  const imperial = system === "imperial";
  return (
    <button
      onClick={toggle}
      title={`switch to ${imperial ? "metric" : "imperial"}`}
      style={{
        display: "inline-flex",
        border: "1px solid var(--ink)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        background: "var(--paper-fade)",
        position: "relative",
        height: 26,
        cursor: "pointer",
        overflow: "hidden",
      }}
    >
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 380, damping: 30 }}
        style={{
          position: "absolute",
          top: 0, bottom: 0,
          left: imperial ? 0 : "50%",
          width: "50%",
          background: "var(--ink)",
        }}
      />
      <span style={{
        padding: "0 10px", display: "grid", placeItems: "center",
        color: imperial ? "var(--paper)" : "var(--ink)",
        position: "relative", zIndex: 1, transition: "color 180ms",
      }}>mi · ft</span>
      <span style={{
        padding: "0 10px", display: "grid", placeItems: "center",
        color: imperial ? "var(--ink)" : "var(--paper)",
        position: "relative", zIndex: 1, transition: "color 180ms",
      }}>km · m</span>
    </button>
  );
}

function Masthead() {
  const { syncing, lastSync, refresh, currentStep, lastLog, status } = useRefresh();
  const { fetchedAt } = useStrava();
  const stamp = fetchedAt ? fetchedAt.getTime() : lastSync;
  const [, force] = useState(0);
  // tick the "ago" label every 20s
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 20_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header style={{ borderBottom: "1px solid var(--ink)", position: "sticky", top: 0, background: "var(--paper)", zIndex: 50 }}>
      <div className="container masthead-row">
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <span className="display-roman" style={{ fontSize: 22, fontStyle: "italic" }}>Trail&nbsp;Almanac</span>
          <span className="eyebrow">Vol. I · No. 21</span>
        </div>
        <nav className="masthead-nav">
          {["Dashboard", "Log", "Coach", "Plan"].map((n, i) => (
            <a
              key={n}
              href={`#${n.toLowerCase()}`}
              className="eyebrow"
              style={{
                textDecoration: "none",
                color: i === 0 ? "var(--blaze)" : "var(--ink)",
                paddingBottom: 2,
                borderBottom: i === 0 ? "2px solid var(--blaze)" : "2px solid transparent",
              }}
            >{n}</a>
          ))}
        </nav>
        <div className="masthead-right">
          <UnitsToggle />
          <span
            className="eyebrow"
            style={{
              color: syncing ? "var(--blaze)" : "var(--ink-mute)",
              maxWidth: 320,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={lastLog}
          >
            {syncing
              ? (currentStep ? `${currentStep}…  ${lastLog || ""}` : "starting…")
              : `snapshot ${relativeAgo(stamp)}`}
          </span>
          {syncing && (
            <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              {REFRESH_STEPS.map((s) => (
                <span
                  key={s}
                  title={`${s}: ${status[s] ?? "pending"}`}
                  style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background:
                      status[s] === "done" ? "var(--moss)" :
                      status[s] === "running" ? "var(--blaze)" :
                      status[s] === "error" ? "var(--blaze-deep)" :
                      "var(--paper-deep)",
                    border: "1px solid var(--ink)",
                    animation: status[s] === "running" ? "spin 1.2s linear infinite" : undefined,
                    transformOrigin: "center",
                  }}
                />
              ))}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={syncing}
            className="chip blaze"
            style={{
              background: syncing ? "var(--blaze)" : "transparent",
              color: syncing ? "var(--paper-fade)" : "var(--ink)",
              borderColor: "var(--blaze)",
              display: "inline-flex", alignItems: "center", gap: 6,
              cursor: syncing ? "wait" : "pointer",
            }}
          >
            <span
              style={{
                display: "inline-block",
                animation: syncing ? "spin 0.8s linear infinite" : undefined,
                transformOrigin: "center",
              }}
            >↻</span>
            <span>{syncing ? "resyncing" : "resync all"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/*  Hero                                                               */
/* ------------------------------------------------------------------ */

function Hero() {
  const u = useUnits();
  const dleft = daysUntil(RACE.date);
  const dateStr = RACE.date.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  return (
    <section style={{ position: "relative", paddingTop: 56, paddingBottom: 0 }}>
      <ContourBackdrop seed={3} opacity={0.4} />
      <div className="container" style={{ position: "relative" }}>
        {/* Top metadata strip */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 36 }}>
          <div style={{ display: "flex", gap: 18, alignItems: "center" }}>
            <span className="stamp">Block 7 / 20 · Specific Strength</span>
            <span className="eyebrow">{RACE.location}</span>
          </div>
          <div className="eyebrow">{dateStr}</div>
        </div>

        <div className="hero-grid">
          <div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7 }}
              className="eyebrow"
              style={{ marginBottom: 16, color: "var(--blaze)" }}
            >
              Training for —
            </motion.div>
            <motion.h1
              className="display display-hero"
              style={{ margin: 0 }}
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.9, delay: 0.15 }}
            >
              Mogollon
            </motion.h1>
            <motion.h1
              className="display-roman display-hero-mid"
              style={{ margin: "-0.04em 0 0 0.14em", color: "var(--moss-deep)" }}
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.9, delay: 0.3 }}
            >
              Monster
            </motion.h1>
            <motion.h1
              className="display display-hero-blaze"
              style={{
                margin: "-0.05em 0 0 0",
                color: "var(--blaze)",
                fontVariationSettings: '"opsz" 144, "SOFT" 80, "WONK" 1',
              }}
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.9, delay: 0.45 }}
            >
              100
            </motion.h1>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.9 }}
              style={{ display: "flex", gap: 28, marginTop: 24, alignItems: "baseline" }}
            >
              <span className="eyebrow">
                {u.dist(RACE.distance_mi)} {u.distUnit} · {u.elev(RACE.elevation_ft)} {u.elevUnit}↑ · {u.elev(RACE.max_elev_ft)} {u.elevUnit} max · cut-off {RACE.cutoff_h}h
              </span>
              <span style={{ flex: 1, borderTop: "1px dashed var(--ink-mute)", transform: "translateY(-4px)" }} />
              <span className="eyebrow">Sept 12 · 06:00 MST</span>
            </motion.div>
          </div>

          {/* Countdown panel */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.8, delay: 0.6 }}
            style={{ position: "relative" }}
          >
            <div className="card card-corner" style={{ padding: 28 }}>
              <ContourBackdrop seed={11} opacity={0.25} />
              <div style={{ position: "relative" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="eyebrow">Days remaining</span>
                  <span className="eyebrow">T-minus</span>
                </div>
                <div
                  className="numerals"
                  style={{
                    fontSize: 132,
                    lineHeight: 0.85,
                    fontWeight: 700,
                    letterSpacing: "-0.06em",
                    marginTop: 8,
                    color: "var(--ink)",
                  }}
                >
                  {String(dleft).padStart(3, "0")}
                </div>
                <div className="rule" style={{ marginTop: 20, marginBottom: 16 }} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  <Stat tiny label="Weeks" value={Math.floor(dleft / 7)} />
                  <Stat tiny label="Long runs" value={Math.floor(dleft / 7) - 2} />
                  <Stat tiny label="Race days" value={1} />
                </div>
              </div>
            </div>
          </motion.div>
        </div>

        {/* Elevation profile */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 1 }}
          style={{ marginTop: 56, position: "relative" }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <span className="eyebrow">
              Race profile · climbs the rim 6× · {u.elev(5300)} → {u.elev(RACE.max_elev_ft)} {u.elevUnit}
            </span>
            <span className="eyebrow">click bib for splits ↗</span>
          </div>
          <div style={{ height: 220, borderTop: "1px solid var(--ink)", borderBottom: "1px solid var(--ink)" }}>
            <ElevationProfile />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
            {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
              const v = Math.round(u.distVal(RACE.distance_mi * frac));
              return (
                <span key={frac} className="eyebrow numerals">
                  {String(v).padStart(3, "0")} {u.distUnit}
                </span>
              );
            })}
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function Stat({ label, value, tiny }: { label: string; value: number | string; tiny?: boolean }) {
  return (
    <div>
      <div className="eyebrow" style={{ fontSize: tiny ? 9 : 10 }}>{label}</div>
      <div
        className="numerals"
        style={{
          fontSize: tiny ? 22 : 36,
          fontWeight: 700,
          marginTop: 4,
          letterSpacing: "-0.04em",
          color: "var(--ink)",
        }}
      >{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Activity stats — week/month + distance/elevation toggles           */
/* ------------------------------------------------------------------ */

type Range = "week" | "month";
type Metric = "distance" | "elevation" | "time";

function StatsPanel() {
  const u = useUnits();
  const { activities } = useStrava();
  const [range, setRange] = useState<Range>("week");
  const [metric, setMetric] = useState<Metric>("distance");

  const days = range === "week" ? 7 : 30;
  const filtered = activities.filter((a) => within(a.date, days));

  const dist = filtered.reduce((s, a) => s + a.distance_mi, 0);
  const elev = filtered.reduce((s, a) => s + a.elevation_ft, 0);
  const time = filtered.reduce((s, a) => s + a.moving_s, 0);

  const target = range === "week" ? { dist: 55, elev: 9500, time: 5.5 * 3600 } : { dist: 220, elev: 38000, time: 22 * 3600 };
  const pct = (val: number, t: number) => Math.min(100, Math.round((val / t) * 100));

  const dailyBuckets = useMemo(() => {
    const n = days;
    const dist = Array(n).fill(0) as number[];
    const elev = Array(n).fill(0) as number[];
    const now = Date.now();
    for (const a of activities) {
      const d = Math.floor((now - new Date(a.date).getTime()) / 86400000);
      if (d >= 0 && d < n) {
        dist[n - 1 - d] += u.distVal(a.distance_mi);
        elev[n - 1 - d] += u.elevVal(a.elevation_ft);
      }
    }
    return { dist, elev };
  }, [days, u, activities]);

  const big =
    metric === "distance" ? u.dist(dist, 1) :
    metric === "elevation" ? u.elev(elev) :
    `${Math.floor(time / 3600)}h ${Math.floor((time % 3600) / 60)}m`;
  const unit =
    metric === "distance" ? u.distUnit :
    metric === "elevation" ? `${u.elevUnit}↑` : "moving";

  const targetDisplay =
    metric === "distance" ? `${u.dist(target.dist, 0)} ${u.distUnit}` :
    metric === "elevation" ? `${u.elev(target.elev)} ${u.elevUnit}` :
    `${Math.floor(target.time / 3600)}h`;
  const targetVal = metric === "distance" ? target.dist : metric === "elevation" ? target.elev : target.time;
  const actualVal = metric === "distance" ? dist : metric === "elevation" ? elev : time;
  const progress = pct(actualVal, targetVal);

  return (
    <section id="dashboard" className="sec-pad" style={{ paddingTop: 96, position: "relative" }}>
      <div className="container">
        <div className="section-head" style={{ marginBottom: 28 }}>
          <div>
            <span className="eyebrow">§ I · The Numbers</span>
            <h2 className="display display-section" style={{ margin: "4px 0 0", color: "var(--ink)" }}>
              What the legs <em style={{ fontStyle: "italic", color: "var(--blaze)" }}>have&nbsp;done</em>.
            </h2>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className={"chip" + (range === "week" ? " active" : "")} onClick={() => setRange("week")}>
              7 day
            </button>
            <button className={"chip" + (range === "month" ? " active" : "")} onClick={() => setRange("month")}>
              30 day
            </button>
          </div>
        </div>

        <div className="double-rule" style={{ marginBottom: 36 }} />

        <GoalTrajectory />

        <div className="stats-grid">
          {/* Big number card */}
          <div className="card card-corner" style={{ padding: 32, position: "relative", minHeight: 320 }}>
            <ContourBackdrop seed={5} opacity={0.3} />
            <div style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span className="eyebrow">{range === "week" ? "this week" : "this month"}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  {(["distance", "elevation", "time"] as Metric[]).map((m) => (
                    <button
                      key={m}
                      className={"chip blaze" + (metric === m ? " active" : "")}
                      onClick={() => setMetric(m)}
                    >{m === "distance" ? u.distUnit : m === "elevation" ? `${u.elevUnit}↑` : "hr"}</button>
                  ))}
                </div>
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={metric + range}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.35 }}
                  style={{ marginTop: 18 }}
                >
                  <div
                    className="numerals"
                    style={{
                      fontSize: 118,
                      lineHeight: 0.86,
                      letterSpacing: "-0.06em",
                      fontWeight: 700,
                    }}
                  >{big}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 6 }}>
                    <span className="display" style={{ fontSize: 28, color: "var(--moss-deep)" }}>{unit}</span>
                    <span className="eyebrow">target {targetDisplay} · {progress}%</span>
                  </div>
                </motion.div>
              </AnimatePresence>

              <div style={{ marginTop: "auto" }}>
                <ProgressBar pct={progress} />
              </div>
            </div>
          </div>

          {/* Sparkline card — dual: distance + elevation */}
          <div className="card" style={{ padding: 28, position: "relative" }}>
            <ContourBackdrop seed={8} opacity={0.18} />
            <div style={{ position: "relative" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="eyebrow">Daily</span>
                <span className="eyebrow">d-{days} → today</span>
              </div>

              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="eyebrow" style={{ color: "var(--blaze)" }}>distance · {u.distUnit}</span>
                  <span className="numerals" style={{ fontSize: 12, color: "var(--ink-mute)" }}>
                    max {Math.round(Math.max(...dailyBuckets.dist))}
                  </span>
                </div>
                <div style={{ height: 44, marginTop: 4 }}>
                  <Sparkline values={dailyBuckets.dist} color="var(--blaze)" />
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="eyebrow" style={{ color: "var(--moss-deep)" }}>elevation · {u.elevUnit}↑</span>
                  <span className="numerals" style={{ fontSize: 12, color: "var(--ink-mute)" }}>
                    max {Math.round(Math.max(...dailyBuckets.elev)).toLocaleString()}
                  </span>
                </div>
                <div style={{ height: 44, marginTop: 4 }}>
                  <Sparkline values={dailyBuckets.elev} color="var(--moss-deep)" />
                </div>
              </div>

              <div className="rule" style={{ marginTop: 18, marginBottom: 12 }} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <Stat label="sessions" value={filtered.length} tiny />
                <Stat label="avg RPE" value={(filtered.reduce((s, a) => s + a.rpe, 0) / Math.max(1, filtered.length)).toFixed(1)} tiny />
              </div>
            </div>
          </div>

          {/* Block snapshot */}
          <div className="card" style={{ padding: 28, position: "relative" }}>
            <ContourBackdrop seed={2} opacity={0.18} />
            <div style={{ position: "relative" }}>
              <span className="eyebrow">Block · 7/20</span>
              <div className="display-roman" style={{ fontSize: 30, marginTop: 8, lineHeight: 1.05 }}>
                Specific<br/>Strength.
              </div>
              <div className="rule" style={{ marginTop: 20, marginBottom: 14 }} />
              <BlockProgress />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 18 }}>
                {["vert ladders", "hill bounds", "back-to-backs"].map((t) => (
                  <span key={t} className="eyebrow"
                    style={{
                      padding: "4px 8px",
                      border: "1px dashed var(--ink-mute)",
                      color: "var(--ink-soft)",
                    }}>{t}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Goal Trajectory — cumulative actual vs plan, with "today" marker   */
/* ------------------------------------------------------------------ */

type SeriesKey = "dist" | "elev";

function GoalTrajectory() {
  const u = useUnits();
  const { weekly, currentWeek } = useStrava();
  const [view, setView] = useState<SeriesKey>("dist");

  const data = useMemo(() => {
    const cumTarget: number[] = [];
    const cumActual: (number | null)[] = [];
    let t = 0, a = 0;
    for (let i = 0; i < BLOCK_TARGETS.length; i++) {
      const wk = BLOCK_TARGETS[i];
      t += view === "dist" ? wk.target_dist : wk.target_elev;
      cumTarget.push(t);
      if (i < currentWeek) {
        const actWk = weekly[i];
        a += view === "dist" ? actWk.dist_mi : actWk.elev_ft;
        cumActual.push(a);
      } else {
        cumActual.push(null);
      }
    }
    return { cumTarget, cumActual };
  }, [view, weekly, currentWeek]);

  const totalTarget = data.cumTarget[data.cumTarget.length - 1];
  const expectedToday = data.cumTarget[currentWeek - 1] || 1;
  const actualToday = data.cumActual[currentWeek - 1] ?? 0;
  const deltaPct = ((actualToday - expectedToday) / expectedToday) * 100;
  const projectedFinal =
    actualToday > 0
      ? (actualToday / expectedToday) * totalTarget
      : totalTarget;

  const fmt = (n: number) =>
    view === "dist" ? u.dist(n, 0) : u.elev(n);
  const unit = view === "dist" ? u.distUnit : `${u.elevUnit}↑`;

  // svg geometry
  const W = 100, H = 38;
  const maxY = Math.max(totalTarget, projectedFinal) * 1.05;
  const xAt = (i: number) => (i / (TOTAL_WEEKS - 1)) * W;
  const yAt = (v: number) => H - (v / maxY) * H;

  const targetPath = data.cumTarget
    .map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(2)} ${yAt(v).toFixed(2)}`)
    .join(" ");
  const actualPath = data.cumActual
    .map((v, i) => (v == null ? "" : `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(2)} ${yAt(v).toFixed(2)}`))
    .join(" ")
    .replace(/^L/, "M");

  const todayX = xAt(currentWeek - 1);
  const expectedY = yAt(expectedToday);
  const actualY = yAt(actualToday);
  const projColor = deltaPct >= 0 ? "var(--moss)" : "var(--blaze)";

  return (
    <section style={{ paddingTop: 56, position: "relative" }}>
      <div className="section-head" style={{ marginBottom: 18 }}>
        <div>
          <span className="eyebrow">§ I·b · Block trajectory</span>
          <h3 className="display-roman" style={{ fontSize: 36, margin: "4px 0 0", lineHeight: 1.05 }}>
            {view === "dist" ? "Cumulative miles" : "Cumulative climb"}
            <span style={{ color: "var(--ink-mute)", fontStyle: "italic", fontWeight: 400 }}> · vs plan</span>
          </h3>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className={"chip" + (view === "dist" ? " active" : "")} onClick={() => setView("dist")}>
            distance
          </button>
          <button className={"chip" + (view === "elev" ? " active" : "")} onClick={() => setView("elev")}>
            elevation
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 28, position: "relative" }}>
        <ContourBackdrop seed={13} opacity={0.16} />
        <div className="trajectory-grid">
          <div>
            <svg viewBox={`0 0 ${W} ${H + 8}`} className="block w-full" preserveAspectRatio="none" style={{ height: 280 }}>
              <defs>
                <linearGradient id="actualFill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={projColor} stopOpacity="0.35" />
                  <stop offset="100%" stopColor={projColor} stopOpacity="0.02" />
                </linearGradient>
              </defs>

              {/* horizontal grid */}
              {[0.25, 0.5, 0.75, 1].map((f) => (
                <line key={f} x1="0" x2={W} y1={H - f * H} y2={H - f * H}
                  stroke="var(--ink)" strokeWidth="0.06" strokeDasharray="0.6 0.8" opacity="0.35" />
              ))}

              {/* vertical week ticks */}
              {Array.from({ length: TOTAL_WEEKS }).map((_, i) => {
                const isQuarter = (i + 1) % 4 === 0;
                return (
                  <line key={i} x1={xAt(i)} x2={xAt(i)} y1={H - 0.6} y2={H + (isQuarter ? 1.8 : 1)}
                    stroke="var(--ink)" strokeWidth="0.08" opacity={isQuarter ? 0.7 : 0.3} />
                );
              })}

              {/* target dashed path */}
              <motion.path
                d={targetPath}
                fill="none"
                stroke="var(--ink-mute)"
                strokeWidth="0.35"
                strokeDasharray="0.9 0.7"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 1.4, ease: "easeOut" }}
              />

              {/* actual area */}
              <motion.path
                d={`${actualPath} L ${xAt(currentWeek - 1)} ${H} L 0 ${H} Z`}
                fill="url(#actualFill)"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 1, delay: 0.5 }}
              />
              {/* actual line */}
              <motion.path
                d={actualPath}
                fill="none"
                stroke={projColor}
                strokeWidth="0.6"
                strokeLinecap="round"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 1.4, ease: [0.2, 0.7, 0.2, 1], delay: 0.2 }}
              />

              {/* projection from today → final (if ahead/behind, extrapolate) */}
              <motion.line
                x1={todayX}
                y1={actualY}
                x2={xAt(TOTAL_WEEKS - 1)}
                y2={yAt(projectedFinal)}
                stroke={projColor}
                strokeWidth="0.25"
                strokeDasharray="0.5 0.6"
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.8 }}
                transition={{ duration: 0.6, delay: 1.4 }}
              />

              {/* today vertical line */}
              <motion.line
                x1={todayX} x2={todayX} y1="0" y2={H}
                stroke="var(--blaze)"
                strokeWidth="0.18"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.6, delay: 1.1 }}
              />
              <text
                x={todayX} y={-1}
                fontSize="1.6"
                fontFamily="JetBrains Mono"
                fill="var(--blaze)"
                textAnchor="middle"
              >▼ today · wk {currentWeek}</text>

              {/* expected today dot */}
              <circle cx={todayX} cy={expectedY} r="0.7" fill="var(--ink)" />
              {/* actual today dot */}
              <circle cx={todayX} cy={actualY} r="1.0" fill={projColor} stroke="var(--paper)" strokeWidth="0.18" />

              {/* race finish marker */}
              <circle cx={W} cy={yAt(totalTarget)} r="0.8" fill="var(--blaze)" />
              <text
                x={W - 0.6} y={yAt(totalTarget) - 1.4}
                fontSize="1.5"
                fontFamily="JetBrains Mono"
                fill="var(--blaze)"
                textAnchor="end"
              >race · wk 20</text>
            </svg>

            {/* x-axis week labels */}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
              {[1, 5, 10, 15, 20].map((w) => (
                <span key={w} className="eyebrow numerals">wk {String(w).padStart(2, "0")}</span>
              ))}
            </div>
          </div>

          {/* Right rail: numbers */}
          <div style={{ borderLeft: "1px solid var(--ink-mute)", paddingLeft: 24, display: "flex", flexDirection: "column", gap: 18 }}>
            <div>
              <span className="eyebrow">expected today</span>
              <div className="numerals" style={{ fontSize: 36, fontWeight: 700, letterSpacing: "-0.04em", marginTop: 2 }}>
                {fmt(expectedToday)} <span style={{ fontSize: 14, color: "var(--ink-mute)", fontWeight: 400 }}>{unit}</span>
              </div>
            </div>
            <div>
              <span className="eyebrow">actual today</span>
              <div className="numerals" style={{ fontSize: 36, fontWeight: 700, letterSpacing: "-0.04em", marginTop: 2, color: projColor }}>
                {fmt(actualToday)} <span style={{ fontSize: 14, color: "var(--ink-mute)", fontWeight: 400 }}>{unit}</span>
              </div>
              <div className="eyebrow numerals" style={{ marginTop: 6, color: projColor }}>
                {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(1)}% vs plan
              </div>
            </div>

            <div className="rule" />

            <div>
              <span className="eyebrow">block goal</span>
              <div className="numerals" style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.04em", marginTop: 2 }}>
                {fmt(totalTarget)} <span style={{ fontSize: 13, color: "var(--ink-mute)", fontWeight: 400 }}>{unit}</span>
              </div>
              <div className="eyebrow" style={{ marginTop: 2 }}>20-wk total to MM100</div>
            </div>

            <div>
              <span className="eyebrow">projected finish</span>
              <div className="numerals" style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.04em", marginTop: 2, color: projColor }}>
                {fmt(projectedFinal)} {unit}
              </div>
              <div className="eyebrow numerals" style={{ marginTop: 2 }}>
                if current trend holds
              </div>
            </div>

            {/* Legend */}
            <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 6, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--ink-soft)" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 18, height: 2, background: projColor }} /> actual
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 18, height: 0, borderTop: "1.5px dashed var(--ink-mute)" }} /> plan target
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 18, height: 0, borderTop: "1px dashed " + projColor }} /> projection
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span className="eyebrow">progress</span>
        <span className="eyebrow numerals">{pct}%</span>
      </div>
      <div
        style={{
          position: "relative",
          height: 10,
          background: "var(--paper-deep)",
          border: "1px solid var(--ink)",
        }}
      >
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1.1, ease: [0.2, 0.7, 0.2, 1] }}
          style={{
            position: "absolute",
            inset: 0,
            right: "auto",
            background:
              "repeating-linear-gradient(45deg, var(--blaze) 0 6px, var(--blaze-deep) 6px 12px)",
          }}
        />
        {/* tick marks */}
        {[25, 50, 75].map((t) => (
          <div key={t} style={{
            position: "absolute", left: `${t}%`, top: -2, bottom: -2,
            width: 1, background: "var(--ink)", opacity: 0.6,
          }} />
        ))}
      </div>
    </div>
  );
}

function BlockProgress() {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "flex-end" }}>
      {Array.from({ length: 20 }).map((_, i) => {
        const done = i < 7;
        const current = i === 6;
        const future = i > 6;
        const h = 24 + (i % 5) * 6;
        return (
          <motion.div
            key={i}
            initial={{ height: 0 }}
            animate={{ height: h }}
            transition={{ duration: 0.5, delay: i * 0.04 }}
            style={{
              width: 10,
              background: done ? "var(--blaze)" : current ? "var(--ink)" : "transparent",
              border: future ? "1px solid var(--ink-mute)" : "1px solid var(--ink)",
            }}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Body Panel — Oura sleep / readiness / HRV / RHR                    */
/* ------------------------------------------------------------------ */

function fmtDuration(secs?: number | null) {
  if (!secs && secs !== 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

function trendColor(latest: number | null | undefined, avg: number | null | undefined, higherIsBetter = true) {
  if (latest == null || avg == null) return "var(--ink)";
  const diff = latest - avg;
  const sig = higherIsBetter ? diff : -diff;
  if (Math.abs(diff) < (avg * 0.02)) return "var(--ink)";
  return sig > 0 ? "var(--moss)" : "var(--blaze)";
}

function BodyPanel() {
  const { connected, loading, days, latest, summary, error } = useOura();

  // Build trailing sparkline series (oldest → newest, last 30 days)
  const seriesLen = 30;
  const tail = days.slice(0, seriesLen).slice().reverse();
  const sleepSeries     = tail.map((d) => d.sleep_score      ?? 0);
  const readinessSeries = tail.map((d) => d.readiness_score  ?? 0);
  const hrvSeries       = tail.map((d) => d.avg_hrv          ?? 0);
  const rhrSeries       = tail.map((d) => d.lowest_hr        ?? 0);

  return (
    <section id="body" className="sec-pad" style={{ paddingTop: 96, position: "relative" }}>
      <div className="container">
        <div className="section-head" style={{ marginBottom: 28 }}>
          <div>
            <span className="eyebrow">§ II · The Body</span>
            <h2 className="display display-section" style={{ margin: "4px 0 0" }}>
              What the <em style={{ color: "var(--blaze)" }}>ring</em> says.
            </h2>
          </div>
          <span className="eyebrow">
            {connected
              ? `${days.length} nights · oura ring`
              : loading
                ? "loading…"
                : "ring not connected"}
          </span>
        </div>

        <div className="double-rule" style={{ marginBottom: 36 }} />

        {!connected && !loading && (
          <ConnectOuraPrompt error={error} />
        )}

        {connected && latest && (
          <>
            <div className="stats-grid" style={{ marginTop: 0 }}>
              <BodyMetric
                label="sleep score"
                value={latest.sleep_score ?? null}
                unit=""
                avg={summary.avg7_sleep_score ?? null}
                series={sleepSeries}
                color="var(--blaze)"
                secondary={fmtDuration(latest.total_sleep_s ?? null)}
                secondaryLabel="total sleep"
                higherIsBetter
              />
              <BodyMetric
                label="readiness"
                value={latest.readiness_score ?? null}
                unit=""
                avg={summary.avg7_readiness ?? null}
                series={readinessSeries}
                color="var(--moss-deep)"
                secondary={latest.temp_deviation_c != null ? `${latest.temp_deviation_c > 0 ? "+" : ""}${latest.temp_deviation_c.toFixed(2)}°C` : "—"}
                secondaryLabel="body temp dev"
                higherIsBetter
              />
              <BodyMetric
                label="hrv · avg"
                value={latest.avg_hrv != null ? Math.round(latest.avg_hrv) : null}
                unit="ms"
                avg={summary.avg7_hrv ?? null}
                series={hrvSeries}
                color="var(--rust)"
                secondary={latest.avg_hr != null ? `${Math.round(latest.avg_hr)} bpm` : "—"}
                secondaryLabel="sleeping HR"
                higherIsBetter
              />
              <BodyMetric
                label="rhr · low"
                value={latest.lowest_hr != null ? Math.round(latest.lowest_hr) : null}
                unit="bpm"
                avg={summary.avg7_lowest_hr ?? null}
                series={rhrSeries}
                color="var(--ink)"
                secondary={latest.steps != null ? latest.steps.toLocaleString() : "—"}
                secondaryLabel="steps"
                higherIsBetter={false}
              />
            </div>

            <TagsStrip days={days.slice(0, 14)} />

            <SleepStageBar latest={latest} />
          </>
        )}
      </div>
    </section>
  );
}

function BodyMetric({
  label, value, unit, avg, series, color, secondary, secondaryLabel, higherIsBetter,
}: {
  label: string;
  value: number | null;
  unit: string;
  avg: number | null;
  series: number[];
  color: string;
  secondary?: string;
  secondaryLabel?: string;
  higherIsBetter: boolean;
}) {
  const tColor = trendColor(value, avg, higherIsBetter);
  const delta = value != null && avg != null ? value - avg : null;

  return (
    <div className="card" style={{ padding: 24, position: "relative" }}>
      <ContourBackdrop seed={label.length} opacity={0.18} />
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="eyebrow">{label}</span>
          {avg != null && (
            <span className="eyebrow numerals" style={{ color: "var(--ink-mute)" }}>
              7d avg {Math.round(avg)}
            </span>
          )}
        </div>
        <div className="numerals" style={{
          fontSize: 64,
          lineHeight: 0.95,
          fontWeight: 700,
          letterSpacing: "-0.04em",
          marginTop: 8,
          color: value == null ? "var(--ink-mute)" : "var(--ink)",
        }}>
          {value ?? "—"}
          {unit && <span style={{ fontSize: 20, color: "var(--ink-mute)", marginLeft: 6, fontWeight: 400 }}>{unit}</span>}
        </div>
        {delta != null && (
          <div className="eyebrow numerals" style={{ marginTop: 4, color: tColor }}>
            {delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} {Math.abs(delta).toFixed(unit === "ms" || unit === "bpm" ? 0 : 1)} vs 7d
          </div>
        )}
        <div style={{ height: 44, marginTop: 14 }}>
          {series.some((v) => v > 0) ? <Sparkline values={series} color={color} /> : <EmptySpark />}
        </div>
        {secondaryLabel && (
          <>
            <div className="rule" style={{ marginTop: 16, marginBottom: 10 }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span className="eyebrow">{secondaryLabel}</span>
              <span className="numerals" style={{ fontSize: 16, fontWeight: 600 }}>{secondary}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EmptySpark() {
  return (
    <div style={{
      height: "100%",
      display: "grid", placeItems: "center",
      border: "1px dashed var(--ink-mute)",
    }}>
      <span className="eyebrow" style={{ color: "var(--ink-mute)" }}>no data</span>
    </div>
  );
}

function SleepStageBar({ latest }: { latest: OuraDay }) {
  const total = (latest.total_sleep_s ?? 0);
  if (!total) return null;
  const deep = (latest.deep_sleep_s ?? 0) / total;
  const rem  = (latest.rem_sleep_s ?? 0) / total;
  const light = Math.max(0, 1 - deep - rem);
  const segs = [
    { pct: deep,  label: "deep",  color: "var(--moss-deep)" },
    { pct: rem,   label: "rem",   color: "var(--blaze)" },
    { pct: light, label: "light", color: "var(--sand)" },
  ];

  return (
    <div className="card" style={{ marginTop: 18, padding: 20, position: "relative" }}>
      <ContourBackdrop seed={42} opacity={0.14} />
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
          <span className="eyebrow">last night · stages</span>
          <span className="numerals" style={{ fontSize: 13, color: "var(--ink-mute)" }}>
            {new Date(latest.day).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
          </span>
        </div>
        <div style={{ display: "flex", height: 14, border: "1px solid var(--ink)" }}>
          {segs.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ width: 0 }}
              animate={{ width: `${s.pct * 100}%` }}
              transition={{ duration: 0.8, delay: 0.1 + i * 0.15, ease: "easeOut" }}
              style={{ background: s.color, borderRight: i < segs.length - 1 ? "1px solid var(--paper)" : "none" }}
              title={`${s.label} · ${(s.pct * 100).toFixed(0)}%`}
            />
          ))}
        </div>
        <div style={{ display: "flex", gap: 18, marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-soft)" }}>
          {segs.map((s) => (
            <span key={s.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, background: s.color, border: "1px solid var(--ink)" }} />
              {s.label} · {(s.pct * 100).toFixed(0)}%
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function TagsStrip({ days }: { days: OuraDay[] }) {
  const flat = days.flatMap((d) =>
    (d.tags ?? []).map((t) => ({ day: d.day, ...t }))
  );
  if (flat.length === 0) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <span className="eyebrow">recent tags · 14d</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        {flat.map((t, i) => (
          <span
            key={i}
            className="eyebrow"
            style={{
              border: "1px dashed var(--ink-mute)",
              padding: "4px 8px",
              color: "var(--ink-soft)",
              background: "var(--paper-fade)",
            }}
          >
            {new Date(t.day).toLocaleDateString("en-US", { month: "short", day: "2-digit" })}
            {" · "}
            {(t.tags?.length ? t.tags.join(", ") : t.tag_type_code) || "tagged"}
            {t.comment ? ` — “${t.comment}”` : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

const codeChip: React.CSSProperties = {
  background: "var(--paper-deep)",
  padding: "2px 6px",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
};
const codeBlock: React.CSSProperties = {
  background: "var(--paper-deep)",
  padding: 10,
  border: "1px solid var(--ink-mute)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  marginTop: 6,
  overflow: "auto",
};

function ConnectOuraPrompt({ error }: { error: string | null }) {
  const scroll = () => {
    const el = document.getElementById("setup-oura");
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    // open the accordion
    el.dispatchEvent(new CustomEvent("almanac:open"));
  };
  return (
    <div className="card card-corner" style={{ padding: 24, position: "relative" }}>
      <ContourBackdrop seed={17} opacity={0.16} />
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
        <span className="stamp">ring not connected</span>
        <p style={{ fontSize: 14, color: "var(--ink-soft)", margin: 0, flex: 1, minWidth: 220 }}>
          Sleep, readiness, HRV and resting HR via Oura's OAuth2 flow — set up runs locally.
        </p>
        <button
          onClick={scroll}
          className="chip blaze active"
          style={{ display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          set up oura ↓
        </button>
        {error && (
          <span className="eyebrow" style={{ color: "var(--ink-mute)", width: "100%", marginTop: 4 }}>
            last fetch: {error}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Activity Log                                                       */
/* ------------------------------------------------------------------ */

function ActivityLog() {
  const [hover, setHover] = useState<string | null>(null);
  const [limit, setLimit] = useState(20);
  const { lastSync, syncing } = useRefresh();
  const { activities, loading, error } = useStrava();
  const u = useUnits();
  const visible = activities.slice(0, limit);
  return (
    <section id="log" className="sec-pad" style={{ paddingTop: 96, position: "relative" }}>
      <div className="container">
        <div className="section-head" style={{ marginBottom: 24 }}>
          <div>
            <span className="eyebrow">§ III · The Log</span>
            <h2 className="display display-section" style={{ margin: "4px 0 0" }}>
              <em>Pulled</em> from Strava.
            </h2>
          </div>
          <div className="eyebrow" style={{ color: syncing ? "var(--blaze)" : undefined }}>
            {syncing ? "pulling strava…" : `${activities.length} runs · snapshot ${relativeAgo(lastSync)}`}
          </div>
        </div>

        <div className="double-rule" style={{ marginBottom: 0 }} />

        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          <li className="log-grid" style={{ padding: "10px 0", borderBottom: "1px solid var(--ink)" }}>
            <span className="eyebrow col-date">date</span>
            <span className="eyebrow col-type">type</span>
            <span className="eyebrow col-title">title</span>
            <span className="eyebrow col-dist">dist ({u.distUnit})</span>
            <span className="eyebrow col-vert">vert ({u.elevUnit})</span>
            <span className="eyebrow col-pace">pace{u.paceUnit}</span>
            <span className="eyebrow col-rpe">rpe</span>
          </li>

          {loading && activities.length === 0 && (
            <li style={{ padding: "32px 0", textAlign: "center" }}>
              <span className="eyebrow">loading strava snapshot…</span>
            </li>
          )}
          {error && (
            <li style={{ padding: "32px 0", textAlign: "center" }}>
              <span className="eyebrow" style={{ color: "var(--blaze)" }}>
                couldn't load strava.json — run `node scripts/sync-strava.mjs`
              </span>
            </li>
          )}
          {visible.map((a, i) => (
            <motion.li
              key={a.id}
              className="log-grid"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.03 }}
              onMouseEnter={() => setHover(a.id)}
              onMouseLeave={() => setHover(null)}
              style={{
                padding: "14px 0",
                borderBottom: "1px solid var(--ink-mute)",
                background: hover === a.id ? "rgba(196, 57, 29, 0.05)" : "transparent",
                transition: "background 120ms",
                cursor: "pointer",
              }}
            >
              <span className="numerals col-date" style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                {new Date(a.date).toLocaleDateString("en-US", { month: "short", day: "2-digit" })}
              </span>
              <span className="col-type"><TypeBadge type={a.type} /></span>
              <div className="col-title" style={{ minWidth: 0 }}>
                {a.strava_url ? (
                  <a
                    href={a.strava_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="display-roman"
                    style={{
                      fontSize: 17,
                      lineHeight: 1.15,
                      color: "var(--ink)",
                      textDecoration: "none",
                      display: "block",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {a.title} <span style={{ color: "var(--ink-mute)", fontSize: 12 }}>↗</span>
                  </a>
                ) : (
                  <div className="display-roman" style={{ fontSize: 17, lineHeight: 1.15 }}>{a.title}</div>
                )}
              </div>
              <span className="numerals col-dist" style={{ fontSize: 17, fontWeight: 700 }}>{u.dist(a.distance_mi)}</span>
              <span className="numerals col-vert" style={{ fontSize: 17, color: "var(--moss-deep)", fontWeight: 700 }}>
                {u.elev(a.elevation_ft)}
              </span>
              <span className="numerals col-pace" style={{ fontSize: 13, color: "var(--ink-soft)" }}>
                {u.paceFmt(a.moving_s, a.distance_mi)}{u.paceUnit}
              </span>
              <span className="col-rpe"><RpeDots rpe={a.rpe} /></span>
            </motion.li>
          ))}
        </ul>

        {activities.length > limit && (
          <div style={{ textAlign: "center", marginTop: 18 }}>
            <button className="chip" onClick={() => setLimit((l) => l + 20)}>
              show {Math.min(20, activities.length - limit)} more ↓ · {activities.length - limit} hidden
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

const TYPE_META: Record<Activity["type"], { label: string; color: string }> = {
  run:      { label: "RUN", color: "var(--ink)" },
  long:     { label: "LNG", color: "var(--blaze)" },
  vert:     { label: "VRT", color: "var(--moss-deep)" },
  easy:     { label: "EZ",  color: "var(--ink-mute)" },
  workout:  { label: "WRK", color: "var(--rust)" },
};
function TypeBadge({ type }: { type: Activity["type"] }) {
  const m = TYPE_META[type];
  return (
    <span
      className="eyebrow"
      style={{
        border: `1px solid ${m.color}`,
        color: m.color,
        padding: "3px 6px",
        textAlign: "center",
        letterSpacing: "0.16em",
      }}
    >{m.label}</span>
  );
}
function RpeDots({ rpe }: { rpe: number }) {
  return (
    <span style={{ display: "inline-flex", gap: 3 }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <span
          key={i}
          style={{
            width: 8, height: 8,
            background: i < rpe ? "var(--blaze)" : "transparent",
            border: "1px solid var(--ink)",
            borderRadius: "50%",
          }}
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Coach facts — deterministic computation over Strava + Oura         */
/* ------------------------------------------------------------------ */

type Flag = { severity: "info" | "watch" | "warn"; label: string; detail: string };
type CoachFacts = {
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

function computeCoachFacts(
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

/* ------------------------------------------------------------------ */
/*  Agent coach output (loaded from /coach.json if present)            */
/* ------------------------------------------------------------------ */

type PlanBlock = {
  wk: number;
  label: string;
  dist_mi: number;
  elev_ft: number;
  focus: string;
  key_session?: string;
  quality?: number;
};
type AgentReadout = {
  generated_at: string;
  model: string;
  summary: string;
  watch_outs?: string[];
  recommendations?: string[];
  plan_blocks?: PlanBlock[];
};

function useAgentReadout() {
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
/*  Coach readout — deterministic + optional agent                     */
/* ------------------------------------------------------------------ */

const SEVERITY_COLOR: Record<Flag["severity"], string> = {
  info:  "var(--moss)",
  watch: "var(--rust)",
  warn:  "var(--blaze)",
};

function CoachReadout() {
  const u = useUnits();
  const { activities } = useStrava();
  const { days: ouraDays, connected: ouraConnected } = useOura();
  const { weekly, currentWeek } = useStrava();
  const { data: agent, missing: agentMissing } = useAgentReadout();

  const facts = useMemo(
    () => computeCoachFacts(activities, ouraDays, weekly, currentWeek),
    [activities, ouraDays, weekly, currentWeek],
  );

  const fmtD = (mi: number) => `${u.dist(mi, 0)} ${u.distUnit}`;
  const fmtE = (ft: number) => `${u.elev(ft)} ${u.elevUnit}`;

  return (
    <section id="coach" className="sec-pad" style={{ paddingTop: 96, position: "relative" }}>
      <div className="container">
        <div className="coach-grid">
          {/* LEFT — narrative & inputs */}
          <div>
            <span className="eyebrow">§ IV · The Coach</span>
            <h2 className="display display-section" style={{ margin: "4px 0 24px" }}>
              An <em style={{ color: "var(--blaze)" }}>agent</em><br />that <em>knows</em> the route.
            </h2>

            <div style={{ marginTop: 4, marginBottom: 18 }}>
              <span className="eyebrow">data ingested</span>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-soft)" }}>
                <span>· strava — {activities.length} activities · 28d {fmtD(facts.d28_dist_mi)} / {fmtE(facts.d28_elev_ft)}</span>
                <span style={{ color: ouraConnected ? "var(--ink-soft)" : "var(--ink-mute)" }}>
                  · oura  — {ouraConnected ? `${ouraDays.length} nights · HRV ${facts.hrv_d7 ? Math.round(facts.hrv_d7) : "—"} ms · RHR ${facts.rhr_d7 ? Math.round(facts.rhr_d7) : "—"} bpm` : "not connected"}
                </span>
                <span>· block  — wk {currentWeek}/{TOTAL_WEEKS} · {facts.block_dist_delta_pct >= 0 ? "+" : ""}{facts.block_dist_delta_pct.toFixed(1)}% dist · {facts.block_elev_delta_pct >= 0 ? "+" : ""}{facts.block_elev_delta_pct.toFixed(1)}% vert</span>
              </div>
            </div>

            <div className="rule" style={{ marginTop: 24, marginBottom: 14 }} />
            <span className="eyebrow">agent status</span>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: agent ? "var(--moss)" : "var(--blaze)",
                display: "inline-block",
              }} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-soft)" }}>
                {agent
                  ? `${agent.model} · generated ${relativeAgo(new Date(agent.generated_at).getTime())}`
                  : agentMissing
                    ? "no readout yet · `npm run coach`"
                    : "loading…"}
              </span>
            </div>
          </div>

          {/* RIGHT — facts + agent + chat stacked */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <FactsPanel facts={facts} u={u} ouraConnected={ouraConnected} />
            <AgentPanel agent={agent} missing={agentMissing} />
            <ChatPanel />
          </div>
        </div>
      </div>
    </section>
  );
}

function FactsPanel({
  facts, u, ouraConnected,
}: { facts: CoachFacts; u: UnitsCtx; ouraConnected: boolean }) {
  return (
    <div className="card card-corner" style={{ padding: 28, position: "relative" }}>
      <ContourBackdrop seed={9} opacity={0.2} />
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="eyebrow">facts · computed locally</span>
          <span className="eyebrow numerals" style={{ color: "var(--ink-mute)" }}>
            block wk {/* current week */}
          </span>
        </div>

        {/* metric grid: 3 columns */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 1fr)",
            gap: 18,
            marginTop: 18,
          }}
        >
          <FactStat
            label="acute : chronic"
            value={facts.acr_dist.toFixed(2)}
            sub={`dist · ${u.dist(facts.d7_dist_mi, 0)} ${u.distUnit} / 7d`}
            color={facts.acr_dist > 1.5 ? "var(--blaze)" : facts.acr_dist < 0.8 ? "var(--rust)" : "var(--ink)"}
          />
          <FactStat
            label="vert acr"
            value={facts.acr_elev.toFixed(2)}
            sub={`${u.elev(facts.d7_elev_ft)} ${u.elevUnit}↑ · 7d`}
            color={facts.acr_elev > 1.5 ? "var(--blaze)" : "var(--moss-deep)"}
          />
          <FactStat
            label="block trajectory"
            value={`${facts.block_elev_delta_pct >= 0 ? "+" : ""}${facts.block_elev_delta_pct.toFixed(0)}%`}
            sub="vert vs plan"
            color={facts.block_elev_delta_pct >= 0 ? "var(--moss)" : "var(--blaze)"}
          />

          {ouraConnected ? (
            <>
              <FactStat
                label="HRV · 7d"
                value={facts.hrv_d7 != null ? `${Math.round(facts.hrv_d7)} ms` : "—"}
                sub={facts.hrv_ratio != null ? `${facts.hrv_ratio < 1 ? "▼" : "▲"} ${((facts.hrv_ratio - 1) * 100).toFixed(0)}% vs 28d` : "—"}
                color={facts.hrv_ratio != null && facts.hrv_ratio < 0.9 ? "var(--blaze)" : "var(--ink)"}
              />
              <FactStat
                label="RHR drift"
                value={facts.rhr_drift != null ? `${facts.rhr_drift >= 0 ? "+" : ""}${facts.rhr_drift.toFixed(1)} bpm` : "—"}
                sub={facts.rhr_d7 != null ? `7d avg ${Math.round(facts.rhr_d7)} bpm` : "—"}
                color={facts.rhr_drift != null && facts.rhr_drift >= 3 ? "var(--blaze)" : "var(--ink)"}
              />
              <FactStat
                label="sleep · 7d"
                value={facts.sleep_d7_total_h != null ? `${facts.sleep_d7_total_h.toFixed(1)} h` : "—"}
                sub={facts.sleep_debt_h != null ? `${facts.sleep_debt_h > 0 ? "−" : "+"}${Math.abs(facts.sleep_debt_h).toFixed(1)}h vs target` : "—"}
                color={facts.sleep_d7_total_h != null && facts.sleep_d7_total_h < 49 ? "var(--blaze)" : "var(--ink)"}
              />
            </>
          ) : (
            <div style={{ gridColumn: "span 3", padding: 14, border: "1px dashed var(--ink-mute)", textAlign: "center" }}>
              <span className="eyebrow" style={{ color: "var(--ink-mute)" }}>
                Oura not connected — recovery facts unavailable
              </span>
            </div>
          )}
        </div>

        {/* flags */}
        {facts.flags.length > 0 ? (
          <>
            <div className="rule" style={{ marginTop: 24, marginBottom: 14 }} />
            <span className="eyebrow">flags</span>
            <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "flex", flexDirection: "column", gap: 6 }}>
              {facts.flags.map((f, i) => (
                <motion.li
                  key={i}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, lineHeight: 1.5 }}
                >
                  <span style={{
                    width: 4, alignSelf: "stretch",
                    background: SEVERITY_COLOR[f.severity], flexShrink: 0,
                  }} />
                  <div>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: SEVERITY_COLOR[f.severity] }}>
                      {f.severity} · {f.label}
                    </span>
                    <div style={{ color: "var(--ink-soft)", marginTop: 2 }}>{f.detail}</div>
                  </div>
                </motion.li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="rule" style={{ marginTop: 24, marginBottom: 14 }} />
            <span className="eyebrow" style={{ color: "var(--moss)" }}>● all systems green</span>
          </>
        )}

        {/* recommendations */}
        <div className="rule" style={{ marginTop: 18, marginBottom: 14 }} />
        <span className="eyebrow">next actions</span>
        <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0", display: "flex", flexDirection: "column", gap: 6 }}>
          {facts.recommendations.map((r, i) => (
            <li key={i} style={{ display: "flex", gap: 8, fontSize: 14, lineHeight: 1.5, color: "var(--ink)" }}>
              <span style={{ color: "var(--blaze)" }}>→</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>

        {facts.recent_tags.length > 0 && (
          <>
            <div className="rule" style={{ marginTop: 18, marginBottom: 12 }} />
            <span className="eyebrow">context · 7d tags</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              {facts.recent_tags.map((t, i) => (
                <span key={i} className="eyebrow" style={{
                  border: "1px dashed var(--ink-mute)", padding: "3px 7px", color: "var(--ink-soft)",
                }}>
                  {t.label}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FactStat({
  label, value, sub, color,
}: { label: string; value: string; sub: string; color: string }) {
  return (
    <div>
      <div className="eyebrow" style={{ fontSize: 9 }}>{label}</div>
      <div className="numerals" style={{
        fontSize: 24, fontWeight: 700, letterSpacing: "-0.03em",
        marginTop: 4, color,
      }}>{value}</div>
      <div className="eyebrow numerals" style={{ marginTop: 2, color: "var(--ink-mute)" }}>{sub}</div>
    </div>
  );
}

function AgentPanel({ agent, missing }: { agent: AgentReadout | null; missing: boolean }) {
  if (!agent) {
    return (
      <div className="card" style={{ padding: 24, position: "relative", borderStyle: "dashed", borderColor: "var(--ink-mute)" }}>
        <span className="eyebrow">agent readout · awaiting</span>
        <p style={{ fontSize: 14, color: "var(--ink-soft)", marginTop: 8, lineHeight: 1.5 }}>
          {missing
            ? "No headless run yet for this snapshot. Spawns `claude -p` via your Claude Code subscription, reads the facts + raw snapshots, writes coach.json."
            : "loading…"}
        </p>
        <pre style={{
          background: "var(--paper-deep)",
          padding: 10,
          border: "1px solid var(--ink-mute)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          marginTop: 10,
        }}>npm run coach</pre>
        <p style={{ fontSize: 12, color: "var(--ink-mute)", marginTop: 6 }}>
          Uses your Claude Code subscription — no API key.
        </p>
      </div>
    );
  }
  return (
    <div className="card card-corner" style={{ padding: 28, position: "relative" }}>
      <ContourBackdrop seed={11} opacity={0.18} />
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="eyebrow">agent readout · {agent.model}</span>
          <span className="eyebrow numerals" style={{ color: "var(--ink-mute)" }}>
            {new Date(agent.generated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
        <div style={{ marginTop: 16, fontSize: 15, lineHeight: 1.6, color: "var(--ink)", whiteSpace: "pre-wrap" }}>
          {agent.summary}
        </div>
        {agent.watch_outs && agent.watch_outs.length > 0 && (
          <>
            <div className="rule" style={{ marginTop: 18, marginBottom: 12 }} />
            <span className="eyebrow">watch-outs</span>
            <ul style={{ paddingLeft: 18, margin: "8px 0 0", fontSize: 14, lineHeight: 1.6 }}>
              {agent.watch_outs.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </>
        )}
        {agent.recommendations && agent.recommendations.length > 0 && (
          <>
            <div className="rule" style={{ marginTop: 14, marginBottom: 12 }} />
            <span className="eyebrow">agent recommendations</span>
            <ul style={{ paddingLeft: 18, margin: "8px 0 0", fontSize: 14, lineHeight: 1.6 }}>
              {agent.recommendations.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Plan — upcoming weeks                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Chat panel — interactive headless agent                            */
/* ------------------------------------------------------------------ */

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  meta?: { num_turns?: number; cost_usd?: number | null; duration_ms?: number | null; error?: boolean };
  pending?: boolean;
};

const SUGGESTED_PROMPTS = [
  "what should I do this weekend?",
  "why is my HRV up?",
  "swap a session this week",
  "heat block plan?",
  "race-day fueling strategy",
];

function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, pending]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
    };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInput("");
    setPending(true);
    setStatusLine("thinking…");

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t0 = Date.now();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          messages: newHistory.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.body) throw new Error("no body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const handleEvent = (event: string, payload: any) => {
        if (event === "heartbeat") {
          const sec = Math.floor((Date.now() - t0) / 1000);
          setStatusLine(`thinking… ${sec}s`);
        } else if (event === "message") {
          setMessages((prev) => [
            ...prev,
            { id: `a-${Date.now()}`, role: "assistant", content: payload.content, meta: payload.meta },
          ]);
        } else if (event === "error") {
          setMessages((prev) => [
            ...prev,
            { id: `e-${Date.now()}`, role: "assistant", content: payload.message, meta: { error: true } },
          ]);
        } else if (event === "done") {
          setStatusLine("");
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
          let event = "message", dataStr = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
          }
          if (!dataStr) continue;
          try { handleEvent(event, JSON.parse(dataStr)); } catch {}
        }
      }
    } catch (e) {
      if ((e as any).name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          { id: `e-${Date.now()}`, role: "assistant", content: `network error: ${(e as Error).message}`, meta: { error: true } },
        ]);
      }
    } finally {
      setPending(false);
      setStatusLine("");
      abortRef.current = null;
    }
  }, [messages, pending]);

  const cancel = () => {
    abortRef.current?.abort();
    setPending(false);
    setStatusLine("");
  };

  return (
    <div className="card card-corner" style={{ padding: 0, position: "relative", overflow: "hidden" }}>
      <ContourBackdrop seed={29} opacity={0.16} />
      <div style={{ position: "relative", padding: 24, paddingBottom: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span className="eyebrow">chat · headless claude</span>
          <span className="eyebrow numerals" style={{ color: pending ? "var(--blaze)" : "var(--ink-mute)" }}>
            {pending ? statusLine : `${messages.length} messages`}
          </span>
        </div>
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        style={{
          position: "relative",
          padding: "16px 24px",
          maxHeight: 420,
          minHeight: 80,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {messages.length === 0 && (
          <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ink-mute)", fontStyle: "italic" }}>
            Ask anything about your training — load, recovery, this weekend's plan, race-day strategy.
            The agent reads your Strava + Oura snapshots and the latest readout before answering.
          </div>
        )}
        {messages.map((m) => <ChatBubble key={m.id} msg={m} />)}
        {pending && <ChatBubble msg={{ id: "pending", role: "assistant", content: "", pending: true }} />}
      </div>

      {/* Suggested prompts */}
      {messages.length === 0 && (
        <div style={{ position: "relative", padding: "0 24px 12px", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {SUGGESTED_PROMPTS.map((p) => (
            <button
              key={p}
              className="chip"
              onClick={() => send(p)}
              disabled={pending}
              style={{ fontSize: 11 }}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div style={{
        position: "relative",
        padding: "12px 24px 18px",
        borderTop: "1px solid var(--ink)",
        display: "flex", gap: 12, alignItems: "flex-end",
      }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder="ask the coach… (⏎ to send, ⇧⏎ for newline)"
          disabled={pending}
          rows={1}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            borderBottom: "1px solid var(--ink)",
            padding: "8px 4px",
            font: "15px var(--font-body)",
            color: "var(--ink)",
            outline: "none",
            resize: "none",
            minHeight: 36,
            maxHeight: 140,
            fontFamily: "var(--font-body)",
          }}
        />
        {pending ? (
          <button className="chip" onClick={cancel} style={{ background: "var(--blaze)", color: "var(--paper)", borderColor: "var(--blaze)" }}>
            cancel ⏹
          </button>
        ) : (
          <button
            className="chip"
            onClick={() => send(input)}
            disabled={!input.trim()}
            style={{
              background: input.trim() ? "var(--ink)" : "transparent",
              color: input.trim() ? "var(--paper)" : "var(--ink-mute)",
              cursor: input.trim() ? "pointer" : "not-allowed",
            }}
          >
            send ⏎
          </button>
        )}
      </div>
    </div>
  );
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  const isError = msg.meta?.error;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}
    >
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 4,
        flexDirection: isUser ? "row-reverse" : "row",
      }}>
        <span className="eyebrow" style={{
          fontSize: 9,
          color: isError ? "var(--blaze)" : isUser ? "var(--blaze)" : "var(--moss-deep)",
        }}>
          {isUser ? "you" : isError ? "error" : "coach"}
        </span>
        {msg.meta?.num_turns != null && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-mute)" }}>
            {msg.meta.num_turns} turns
            {msg.meta.cost_usd != null && ` · $${msg.meta.cost_usd.toFixed(3)}`}
          </span>
        )}
      </div>
      <div style={{
        maxWidth: "92%",
        padding: msg.pending ? "10px 14px" : "10px 14px",
        background: isUser
          ? "var(--ink)"
          : isError
            ? "rgba(196, 57, 29, 0.08)"
            : "var(--paper-fade)",
        color: isUser ? "var(--paper-fade)" : isError ? "var(--blaze)" : "var(--ink)",
        border: isUser ? "1px solid var(--ink)" : isError ? "1px solid var(--blaze)" : "1px solid var(--ink-mute)",
        fontFamily: isUser ? "var(--font-body)" : "var(--font-body)",
        fontSize: 14,
        lineHeight: 1.55,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        {msg.pending ? <TypingDots /> : msg.content}
      </div>
    </motion.div>
  );
}

function TypingDots() {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18 }}
          style={{
            width: 6, height: 6, borderRadius: "50%",
            background: "var(--ink-mute)",
            display: "inline-block",
          }}
        />
      ))}
    </span>
  );
}

function Plan() {
  const u = useUnits();
  const { currentWeek } = useStrava();
  const { data: agent, missing } = useAgentReadout();

  // Build the 6-week window: prefer agent's plan_blocks, fall back to BLOCK_TARGETS planned values.
  const fallback: PlanBlock[] = useMemo(() => {
    const start = Math.min(TOTAL_WEEKS, currentWeek + 1);
    const end = Math.min(TOTAL_WEEKS, currentWeek + 6);
    return BLOCK_TARGETS.slice(start - 1, end).map((b) => ({
      wk: b.wk,
      label: b.wk === TOTAL_WEEKS ? "Race week" : "Planned",
      dist_mi: b.target_dist,
      elev_ft: b.target_elev,
      focus: "Awaiting agent recommendations — run `npm run coach` for live focus.",
    }));
  }, [currentWeek]);

  const agentBlocks = agent?.plan_blocks ?? null;
  const blocks: PlanBlock[] = agentBlocks && agentBlocks.length > 0 ? agentBlocks : fallback;
  const source = agentBlocks ? "live · agent" : missing ? "fallback · planned targets only" : "loading…";

  return (
    <section id="plan" className="sec-pad" style={{ paddingTop: 96, paddingBottom: 96 }}>
      <div className="container">
        <div className="section-head" style={{ marginBottom: 28 }}>
          <div>
            <span className="eyebrow">§ V · The Plan</span>
            <h2 className="display display-section" style={{ margin: "4px 0 0" }}>
              The <em style={{ color: "var(--blaze)" }}>weeks</em> ahead.
            </h2>
          </div>
          <span className="eyebrow" style={{ color: agentBlocks ? "var(--moss)" : "var(--ink-mute)" }}>
            <span style={{
              display: "inline-block", width: 7, height: 7, borderRadius: "50%",
              background: agentBlocks ? "var(--moss)" : "var(--blaze)",
              marginRight: 8, verticalAlign: "1px",
            }} />
            {source}
          </span>
        </div>

        <div className="double-rule" style={{ marginBottom: 36 }} />

        <div className="plan-grid">
          {blocks.map((w, i) => {
            const offset = w.wk - currentWeek;
            const tag = offset === 1 ? "next"
                      : w.wk === TOTAL_WEEKS ? "RACE"
                      : `in ${offset} wks`;
            const accent = offset === 1 ? "var(--blaze)"
                         : w.wk === TOTAL_WEEKS ? "var(--blaze)"
                         : "var(--ink-mute)";
            return (
              <motion.div
                key={w.wk}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.06 }}
                className="card"
                style={{ padding: 22, position: "relative" }}
              >
                <ContourBackdrop seed={w.wk} opacity={0.16} />
                <div style={{ position: "relative" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span className="eyebrow">week {w.wk}</span>
                    <span className="eyebrow" style={{ color: accent, letterSpacing: w.wk === TOTAL_WEEKS ? "0.22em" : undefined }}>
                      {tag}
                    </span>
                  </div>
                  <div className="display-roman" style={{ fontSize: 26, marginTop: 8, lineHeight: 1.05 }}>
                    {w.label}
                  </div>
                  <p style={{ fontSize: 13, color: "var(--ink-soft)", marginTop: 8, lineHeight: 1.5 }}>{w.focus}</p>
                  {w.key_session && (
                    <div style={{
                      marginTop: 10,
                      padding: "8px 10px",
                      border: "1px dashed var(--ink-mute)",
                      background: "rgba(196, 57, 29, 0.04)",
                      fontSize: 12,
                      lineHeight: 1.45,
                    }}>
                      <span className="eyebrow" style={{ fontSize: 9, color: "var(--blaze)" }}>key session</span>
                      <div style={{ marginTop: 2, fontFamily: "var(--font-mono)", color: "var(--ink)" }}>
                        {w.key_session}
                      </div>
                    </div>
                  )}
                  <div className="rule" style={{ margin: "18px 0 12px" }} />
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    <MiniStat label={u.distUnit} value={u.dist(w.dist_mi, 0)} />
                    <MiniStat label={`${u.elevUnit}↑`} value={u.elev(w.elev_ft)} />
                    <MiniStat label="Q" value={w.quality ?? "—"} />
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function MiniStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <span className="eyebrow" style={{ fontSize: 9 }}>{label}</span>
      <div className="numerals" style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-0.03em" }}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Footer colophon                                                    */
/* ------------------------------------------------------------------ */

function SetupAccordion() {
  const strava = useStrava();
  const stravaOk = strava.activities.length > 0 && !strava.error;
  const { connected: ouraOk } = useOura();
  const { data: agent } = useAgentReadout();
  const coachOk = !!agent;
  const [open, setOpen] = useState<"strava" | "oura" | "coach" | null>(null);
  const ouraRef = useRef<HTMLLIElement | null>(null);

  // External trigger: opens the Oura panel when the BodyPanel button is clicked
  useEffect(() => {
    const el = ouraRef.current;
    if (!el) return;
    const onOpen = () => setOpen("oura");
    el.addEventListener("almanac:open", onOpen as EventListener);
    return () => el.removeEventListener("almanac:open", onOpen as EventListener);
  }, []);

  const items: {
    key: "strava" | "oura" | "coach";
    title: string;
    connected: boolean;
    note: string;
    render: () => React.ReactNode;
  }[] = [
    {
      key: "strava",
      title: "Strava",
      connected: stravaOk,
      note: stravaOk ? "connected" : "click to set up",
      render: () => (
        <ol style={olStyle}>
          <li>
            Set up the strava-mcp client (one time). The repo: <a href="https://github.com/r-huijts/strava-mcp" target="_blank" rel="noopener noreferrer" style={linkBlaze}>r-huijts/strava-mcp ↗</a>
          </li>
          <li>
            Confirm credentials saved at <code style={codeChip}>~/.config/strava-mcp/config.json</code>.
          </li>
          <li>
            Pull data from <code style={codeChip}>web/</code>:
            <pre style={codeBlock}>npm run sync:strava</pre>
          </li>
        </ol>
      ),
    },
    {
      key: "oura",
      title: "Oura ring",
      connected: ouraOk,
      note: ouraOk ? "connected" : "click to set up",
      render: () => (
        <ol style={olStyle}>
          <li>
            Register an app:{" "}
            <a href="https://cloud.ouraring.com/oauth/applications" target="_blank" rel="noopener noreferrer" style={linkBlaze}>
              cloud.ouraring.com/oauth/applications ↗
            </a>
            <div style={{ marginTop: 6, color: "var(--ink-mute)", fontSize: 13 }}>
              redirect URI: <code style={codeChip}>http://localhost:5174/oura-callback</code><br />
              scopes: <code style={codeChip}>daily heartrate tag personal</code>
            </div>
          </li>
          <li>
            Save credentials to <code style={codeChip}>~/.config/oura/config.json</code>:
            <pre style={codeBlock}>{`{
  "clientId": "...",
  "clientSecret": "...",
  "redirectUri": "http://localhost:5174/oura-callback"
}`}</pre>
          </li>
          <li>
            Authorize once (opens browser):
            <pre style={codeBlock}>npm run auth:oura</pre>
          </li>
          <li>
            Pull data anytime:
            <pre style={codeBlock}>npm run sync:oura</pre>
          </li>
        </ol>
      ),
    },
    {
      key: "coach",
      title: "Claude coach",
      connected: coachOk,
      note: coachOk ? "readout generated" : "click to set up",
      render: () => (
        <ol style={olStyle}>
          <li>
            Make sure the Claude Code CLI is installed and logged in:
            <pre style={codeBlock}>claude --version</pre>
            <span style={{ fontSize: 12, color: "var(--ink-mute)" }}>
              Uses your existing Claude Code subscription via headless <code style={codeChip}>claude -p</code> — no API key needed. Same pattern as <code style={codeChip}>agent-trade</code>.
            </span>
          </li>
          <li>
            From <code style={codeChip}>web/</code> run:
            <pre style={codeBlock}>npm run coach</pre>
            <span style={{ fontSize: 12, color: "var(--ink-mute)" }}>
              Computes deterministic facts → writes them to a temp file → spawns <code style={codeChip}>claude -p</code> with Read tool access → captures the JSON output → writes <code style={codeChip}>web/public/coach.json</code>. The dashboard auto-loads it.
            </span>
          </li>
          <li>
            Or chain it after a sync:
            <pre style={codeBlock}>npm run sync:all && npm run coach</pre>
          </li>
        </ol>
      ),
    },
  ];

  return (
    <div style={{ marginTop: 36 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <span className="eyebrow">Connections · click to expand</span>
        <span className="eyebrow" style={{ color: "var(--ink-mute)" }}>tokens stay local</span>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, borderTop: "1px solid var(--ink)" }}>
        {items.map((it) => {
          const isOpen = open === it.key;
          return (
            <li
              key={it.key}
              ref={it.key === "oura" ? ouraRef : undefined}
              id={it.key === "oura" ? "setup-oura" : `setup-${it.key}`}
              style={{ borderBottom: "1px solid var(--ink)" }}
            >
              <button
                onClick={() => setOpen(isOpen ? null : it.key)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "14px 0",
                  cursor: "pointer",
                  background: "transparent",
                  textAlign: "left",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <span
                    aria-hidden
                    style={{
                      display: "inline-block",
                      transform: isOpen ? "rotate(45deg)" : "rotate(0deg)",
                      transition: "transform 220ms",
                      fontFamily: "var(--font-mono)",
                      fontSize: 14,
                      color: "var(--blaze)",
                      width: 12,
                    }}
                  >+</span>
                  <span className="display-roman" style={{ fontSize: 24, fontStyle: "italic", lineHeight: 1 }}>
                    {it.title}
                  </span>
                  <span
                    className="eyebrow"
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 6,
                      color: it.connected ? "var(--moss)" : "var(--blaze)",
                    }}
                  >
                    <span style={{
                      width: 7, height: 7, borderRadius: "50%",
                      background: it.connected ? "var(--moss)" : "var(--blaze)",
                      display: "inline-block",
                    }} />
                    {it.note}
                  </span>
                </span>
                <span className="eyebrow">{isOpen ? "hide" : "show"} steps</span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.32, ease: [0.2, 0.7, 0.2, 1] }}
                    style={{ overflow: "hidden" }}
                  >
                    <div style={{ padding: "8px 0 28px 26px", maxWidth: 720 }}>
                      {it.render()}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const olStyle: React.CSSProperties = {
  fontSize: 14,
  lineHeight: 1.7,
  color: "var(--ink)",
  paddingLeft: 20,
  margin: 0,
};
const linkBlaze: React.CSSProperties = { color: "var(--blaze)", textDecoration: "underline" };

function Colophon() {
  return (
    <footer style={{ borderTop: "1px solid var(--ink)", paddingTop: 36, paddingBottom: 48 }}>
      <div className="container">
        <div className="footer-grid">
          <div>
            <div className="display-roman" style={{ fontSize: 28, fontStyle: "italic" }}>Trail Almanac</div>
            <p style={{ fontSize: 13, color: "var(--ink-mute)", marginTop: 8, lineHeight: 1.5, maxWidth: 320 }}>
              A field-journal dashboard for ultra training. Local-hosted. Strava-fed. Coached by an
              agent that remembers your block.
            </p>
          </div>
          <FooterCol title="Sources" items={["Strava API", "Oura ring v2", "claude-code"]} />
          <FooterCol title="Status" items={["live · 4f2", "sync 12m ago", "v 0.1.0"]} />
        </div>
        <SetupAccordion />
        <div className="double-rule" style={{ marginTop: 36, marginBottom: 16 }} />
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span className="eyebrow">© trail almanac · mogollon bound · 2026</span>
          <span className="eyebrow">set in fraunces · instrument · jet brains</span>
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <span className="eyebrow">{title}</span>
      <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
        {items.map((it) => (
          <li key={it} style={{ fontSize: 13, color: "var(--ink-soft)", padding: "4px 0", borderBottom: "1px dotted var(--ink-mute)" }}>
            {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

function AppBody() {
  const { key, syncing } = useRefresh();
  return (
    <>
      <Masthead />
      <div style={{ position: "relative" }}>
        <AnimatePresence>
          {syncing && (
            <motion.div
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              exit={{ scaleX: 0, transformOrigin: "right" }}
              transition={{ duration: 0.9, ease: "easeInOut" }}
              style={{
                position: "fixed",
                top: 56, left: 0, right: 0,
                height: 2,
                background: "var(--blaze)",
                transformOrigin: "left",
                zIndex: 60,
              }}
            />
          )}
        </AnimatePresence>
        <Hero />
        <div key={`stats-${key}`}><StatsPanel /></div>
        <div key={`body-${key}`}><BodyPanel /></div>
        <div key={`log-${key}`}><ActivityLog /></div>
        <CoachReadout />
        <Plan />
        <Colophon />
      </div>
    </>
  );
}

export default function App() {
  return (
    <UnitsProvider>
      <RefreshProvider>
        <StravaProvider>
          <OuraProvider>
            <AppBody />
          </OuraProvider>
        </StravaProvider>
      </RefreshProvider>
    </UnitsProvider>
  );
}
