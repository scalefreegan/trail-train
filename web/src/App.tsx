import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  useRefresh, REFRESH_STEPS,
  useUnits,
  useStrava,
  useOura, type OuraDay,
  useGoogleCal, usePersistentState, useAgentReadout,
  useBlockConfig,
  computeCoachFacts, type CoachFacts, type Flag,
  type Activity, type AgentReadout, type PlanBlock, type GCalEvent,
  daysUntil, relativeAgo, fmtDuration, isStale,
} from "./data";
import { RefreshProvider, UnitsProvider, StravaProvider, OuraProvider, StateProvider } from "./providers";

/* ================================================================== */
/*  BASECAMP — pre-dawn ops surface for ultra training                 */
/*  command bar · race ribbon · vitals band · trajectory ·             */
/*  road ahead (plan ∪ calendar) · log — with the coach as a           */
/*  persistent rail that never leaves your side.                       */
/* ================================================================== */

const SEVERITY_COLOR: Record<Flag["severity"], string> = {
  info:  "var(--pine)",
  watch: "var(--lamp)",
  warn:  "var(--ember)",
};

/* ------------------------------------------------------------------ */
/*  Shared atoms                                                       */
/* ------------------------------------------------------------------ */

function SectionTag({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, margin: "26px 0 10px" }}>
      <span className="eyebrow" style={{ color: "var(--lamp)", display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 5, height: 5, background: "var(--lamp)", transform: "rotate(45deg)", display: "inline-block" }} />
        {children}
      </span>
      {right}
    </div>
  );
}

function Spark({ values, color = "var(--mist-dim)", height = 34, fill = true }: {
  values: number[]; color?: string; height?: number; fill?: boolean;
}) {
  const vs = values.length > 1 ? values : [0, 0];
  const max = Math.max(...vs, 1);
  const min = Math.min(...vs, 0);
  const span = max - min || 1;
  const w = 100, h = 28;
  const step = w / (vs.length - 1);
  const path = vs.map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(2)} ${(h - ((v - min) / span) * (h - 2) - 1).toFixed(2)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }}>
      {fill && <path d={`${path} L ${w} ${h} L 0 ${h} Z`} fill={color} opacity="0.09" />}
      <motion.path
        d={path} fill="none" stroke={color} strokeWidth="1.2"
        strokeLinecap="round" strokeLinejoin="round"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
        transition={{ duration: 1.2, ease: "easeOut" }}
      />
      <circle cx={w} cy={h - ((vs[vs.length - 1] - min) / span) * (h - 2) - 1} r="1.8" fill={color} />
    </svg>
  );
}

function Delta({ value, suffix = "", good }: { value: number | null; suffix?: string; good: boolean | null }) {
  if (value == null) return <span className="eyebrow numerals">—</span>;
  const color = good == null ? "var(--mist-mute)" : good ? "var(--pine)" : "var(--ember)";
  return (
    <span className="numerals" style={{ fontSize: 10, letterSpacing: "0.08em", color }}>
      {value > 0 ? "▲" : value < 0 ? "▼" : "•"} {Math.abs(value).toFixed(Math.abs(value) < 10 ? 1 : 0)}{suffix}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Contour backdrop — faint ridge lines behind key panels             */
/* ------------------------------------------------------------------ */

function Contours({ seed = 1, opacity = 0.1 }: { seed?: number; opacity?: number }) {
  const paths = useMemo(() => {
    const out: string[] = [];
    const cx = 50 + seed * 7;
    const cy = 50 + seed * 3;
    for (let r = 0; r < 12; r++) {
      const radius = 8 + r * 7;
      let d = "";
      for (let i = 0; i <= 60; i++) {
        const t = (i / 60) * Math.PI * 2;
        const k = Math.sin(t * (3 + (r % 3)) + seed * 1.3 + r * 0.4);
        const k2 = Math.cos(t * (2 + (seed % 4)) + r * 0.7);
        const rad = radius + k * 1.8 + k2 * 1.3;
        const x = cx + Math.cos(t) * rad;
        const y = cy + Math.sin(t) * rad * 0.7;
        d += (i === 0 ? "M" : "L") + x.toFixed(2) + " " + y.toFixed(2) + " ";
      }
      out.push(d + "Z");
    }
    return out;
  }, [seed]);

  return (
    <svg className="topo-bg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" style={{ opacity }} aria-hidden>
      {paths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--edge-bright)" strokeWidth={i % 4 === 0 ? 0.4 : 0.2} />
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Command bar — identity, block, countdown, sync, units              */
/* ------------------------------------------------------------------ */

function UnitsToggle() {
  const { system, toggle } = useUnits();
  const imperial = system === "imperial";
  return (
    <button
      onClick={toggle}
      title={`switch to ${imperial ? "metric" : "imperial"}`}
      style={{
        display: "inline-flex", border: "1px solid var(--edge-bright)",
        fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.12em",
        textTransform: "uppercase", position: "relative", height: 26, overflow: "hidden",
      }}
    >
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 380, damping: 30 }}
        style={{ position: "absolute", top: 0, bottom: 0, left: imperial ? 0 : "50%", width: "50%", background: "var(--lamp)" }}
      />
      <span style={{ padding: "0 9px", display: "grid", placeItems: "center", color: imperial ? "var(--night)" : "var(--mist-mute)", position: "relative", zIndex: 1, transition: "color 180ms" }}>mi·ft</span>
      <span style={{ padding: "0 9px", display: "grid", placeItems: "center", color: imperial ? "var(--mist-mute)" : "var(--night)", position: "relative", zIndex: 1, transition: "color 180ms" }}>km·m</span>
    </button>
  );
}

function BarStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ padding: "0 18px", borderLeft: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 1, justifyContent: "center" }}>
      <span className="eyebrow" style={{ fontSize: 8, letterSpacing: "0.24em" }}>{label}</span>
      <span className="numerals" style={{ fontSize: 14, fontWeight: 600, color: accent ? "var(--lamp)" : "var(--mist)" }}>{value}</span>
    </div>
  );
}

function CommandBar() {
  const { syncing, lastSync, refresh, currentStep, lastLog, status } = useRefresh();
  const { fetchedAt, currentWeek } = useStrava();
  const { race, totalWeeks } = useBlockConfig();
  const stamp = fetchedAt ? fetchedAt.getTime() : lastSync;
  const dleft = daysUntil(race.date);
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 20_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header style={{
      position: "sticky", top: 0, zIndex: 50,
      background: "rgba(12, 17, 14, 0.92)", backdropFilter: "blur(10px)",
      borderBottom: "1px solid var(--edge)",
    }}>
      <div style={{ maxWidth: 1680, margin: "0 auto", padding: "0 28px", height: 52, display: "flex", alignItems: "center", gap: 18 }}>
        {/* wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: 4 }}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <path d="M1 14 L6 5 L9 10 L12 3 L17 14 Z" fill="none" stroke="var(--lamp)" strokeWidth="1.4" strokeLinejoin="round" />
            <circle cx="12" cy="3" r="1.6" fill="var(--lamp)" />
          </svg>
          <span className="display" style={{ fontSize: 17, letterSpacing: "-0.02em" }}>
            Basecamp
          </span>
          <span className="eyebrow" style={{ fontSize: 8, marginTop: 3 }}>{race.short} ops</span>
        </div>

        {/* mid stats */}
        <div className="commandbar-mid" style={{ flex: 1 }}>
          <BarStat label="block week" value={`${String(currentWeek).padStart(2, "0")} / ${totalWeeks}`} />
          <BarStat label="race in" value={`${dleft} days`} accent />
          <BarStat label="race day" value={race.date.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase()} />
        </div>

        {/* sync cluster */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
          <span
            className="eyebrow"
            title={lastLog}
            style={{
              color: syncing ? "var(--lamp)" : "var(--mist-mute)",
              maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {syncing
              ? (currentStep ? `${currentStep}… ${lastLog || ""}` : "starting…")
              : `synced ${relativeAgo(stamp)}`}
          </span>
          {syncing && (
            <span style={{ display: "inline-flex", gap: 4 }}>
              {REFRESH_STEPS.map((s) => (
                <span
                  key={s}
                  title={`${s}: ${status[s] ?? "pending"}`}
                  className={status[s] === "running" ? "pulse" : undefined}
                  style={{
                    width: 6, height: 6, transform: "rotate(45deg)",
                    background:
                      status[s] === "done" ? "var(--pine)" :
                      status[s] === "running" ? "var(--lamp)" :
                      status[s] === "error" ? "var(--ember)" : "var(--edge-bright)",
                  }}
                />
              ))}
            </span>
          )}
          <UnitsToggle />
          <button
            onClick={refresh}
            disabled={syncing}
            className="chip"
            style={{
              borderColor: "var(--lamp)",
              color: syncing ? "var(--night)" : "var(--lamp)",
              background: syncing ? "var(--lamp)" : "transparent",
              cursor: syncing ? "wait" : "pointer",
              display: "inline-flex", alignItems: "center", gap: 6,
            }}
          >
            <span style={{ display: "inline-block", animation: syncing ? "spin 0.9s linear infinite" : undefined }}>↻</span>
            {syncing ? "syncing" : "resync"}
          </button>
        </div>
      </div>
      {/* sync progress filament */}
      <AnimatePresence>
        {syncing && (
          <motion.div
            initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} exit={{ scaleX: 0, transformOrigin: "right" }}
            transition={{ duration: 0.9, ease: "easeInOut" }}
            style={{ position: "absolute", bottom: -1, left: 0, right: 0, height: 1.5, background: "var(--lamp)", transformOrigin: "left" }}
          />
        )}
      </AnimatePresence>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/*  Race ribbon — name, countdown, elevation profile in one band       */
/* ------------------------------------------------------------------ */

function ElevationRibbon() {
  const u = useUnits();
  const { race } = useBlockConfig();
  const pts = useMemo(() => {
    const n = 220;
    const arr: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 100;
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

  const linePath = "M" + pts.map((p) => p.x.toFixed(2) + " " + (p.y * 0.56).toFixed(2)).join(" L ");
  const areaPath = linePath + ` L 100 60 L 0 60 Z`;

  return (
    <svg viewBox="0 0 100 60" preserveAspectRatio="none" style={{ display: "block", width: "100%", height: "100%" }}>
      <defs>
        <linearGradient id="ribbonFill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--lamp)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--lamp)" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {[20, 35, 50].map((y) => (
        <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="var(--edge)" strokeWidth="0.18" strokeDasharray="0.6 1" />
      ))}
      <motion.path d={areaPath} fill="url(#ribbonFill)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.2, delay: 0.4 }} />
      <motion.path
        d={linePath} fill="none" stroke="var(--lamp)" strokeWidth="0.5"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
        transition={{ duration: 2, ease: [0.2, 0.8, 0.2, 1] }}
      />
      {race.aid_stations.map((a, i) => {
        const idx = Math.min(pts.length - 1, Math.max(0, Math.round((a.mi / race.distance_mi) * (pts.length - 1))));
        const p = pts[idx];
        return (
          <g key={a.name}>
            <motion.circle
              cx={p.x} cy={p.y * 0.56} r="0.8" fill="var(--night)" stroke="var(--mist-dim)" strokeWidth="0.25"
              initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ duration: 0.3, delay: 1.2 + i * 0.06 }}
            >
              <title>{a.name} · {u.dist(a.mi, 1)} {u.distUnit}</title>
            </motion.circle>
          </g>
        );
      })}
    </svg>
  );
}

function RaceRibbon() {
  const u = useUnits();
  const { race } = useBlockConfig();
  const dleft = daysUntil(race.date);
  const nameWords = race.name.split(" ");
  const raceDay = race.date.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();
  const raceStart = `${String(race.date.getHours()).padStart(2, "0")}:${String(race.date.getMinutes()).padStart(2, "0")}`;

  return (
    <motion.section
      className="panel notch"
      initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}
      style={{ overflow: "hidden" }}
    >
      <Contours seed={4} opacity={0.12} />
      <div style={{ position: "relative", padding: "22px 26px 0", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>objective — {race.location.toLowerCase()}</div>
          <h1 className="display" style={{ fontSize: "clamp(30px, 4.4vw, 54px)", margin: 0 }}>
            {nameWords.map((w, i) => (
              <span key={i} style={i === 1 ? { color: "var(--lamp)" } : undefined}>
                {w}{i < nameWords.length - 1 ? " " : ""}
              </span>
            ))}
          </h1>
          <div className="eyebrow" style={{ marginTop: 10, color: "var(--mist-dim)" }}>
            {u.dist(race.distance_mi)} {u.distUnit} · {u.elev(race.elevation_ft)} {u.elevUnit}↑ · max {u.elev(race.max_elev_ft)} {u.elevUnit} · cutoff {race.cutoff_h}h · {raceDay} · {raceStart}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="eyebrow">race in</div>
          <div className="numerals" style={{ fontSize: 64, fontWeight: 600, lineHeight: 0.95, letterSpacing: "-0.05em", color: "var(--lamp)" }}>
            {String(dleft).padStart(3, "0")}
          </div>
          <div className="eyebrow">days · {Math.floor(dleft / 7)} long runs left</div>
        </div>
      </div>
      <div style={{ position: "relative", height: 96, marginTop: 6 }}>
        <ElevationRibbon />
      </div>
      <div style={{ position: "relative", display: "flex", justifyContent: "space-between", padding: "6px 26px 12px", borderTop: "1px solid var(--edge)" }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <span key={f} className="eyebrow numerals" style={{ fontSize: 9 }}>
            {String(Math.round(u.distVal(race.distance_mi * f))).padStart(3, "0")} {u.distUnit}
          </span>
        ))}
      </div>
    </motion.section>
  );
}

/* ------------------------------------------------------------------ */
/*  Vitals band — load + recovery in one unified grammar               */
/* ------------------------------------------------------------------ */

type Vital = {
  key: string;
  label: string;
  value: string;
  unit?: string;
  delta?: { value: number | null; suffix?: string; good: boolean | null };
  series: number[];
  color: string;
  note?: string;
};

function VitalsBand() {
  const u = useUnits();
  const { activities } = useStrava();
  const oura = useOura();
  const facts = useFacts();

  // anchor "now" once per mount — the section remounts on every resync
  // (AppBody keys it on the refresh counter), so this stays fresh without
  // an impure Date.now() during render
  const [now] = useState(() => Date.now());

  // daily distance + vert series, last 30 days (oldest → newest)
  const daily = useMemo(() => {
    const n = 30;
    const dist = Array(n).fill(0) as number[];
    const elev = Array(n).fill(0) as number[];
    for (const a of activities) {
      const d = Math.floor((now - new Date(a.date).getTime()) / 86400000);
      if (d >= 0 && d < n) {
        dist[n - 1 - d] += a.distance_mi;
        elev[n - 1 - d] += a.elevation_ft;
      }
    }
    return { dist, elev };
  }, [activities, now]);

  const ouraTail = oura.days.slice(0, 30).slice().reverse();
  const seriesOf = (f: (d: OuraDay) => number | null | undefined) => ouraTail.map((d) => f(d) ?? 0);

  // most recent non-null reading (last night's sync can lag a metric or two)
  const latestVal = (f: (d: OuraDay) => number | null | undefined): number | null => {
    for (const d of oura.days) {
      const v = f(d);
      if (v != null) return v;
    }
    return null;
  };
  const readiness = latestVal((d) => d.readiness_score);
  const hrv = latestVal((d) => d.avg_hrv);
  const rhr = latestVal((d) => d.lowest_hr);
  const sleepS = latestVal((d) => d.total_sleep_s);
  const latest = oura.latest;

  const vitals: Vital[] = [
    {
      key: "dist",
      label: "7d distance",
      value: u.dist(facts.d7_dist_mi, 0),
      unit: u.distUnit,
      delta: { value: (facts.acr_dist - 1) * 100, suffix: "% v28", good: facts.acr_dist <= 1.5 && facts.acr_dist >= 0.8 ? true : false },
      series: daily.dist,
      color: "var(--lamp)",
      note: `${facts.sessions_d7} sessions`,
    },
    {
      key: "vert",
      label: "7d vert",
      value: u.elev(facts.d7_elev_ft),
      unit: `${u.elevUnit}↑`,
      delta: { value: (facts.acr_elev - 1) * 100, suffix: "% v28", good: facts.acr_elev <= 1.5 },
      series: daily.elev,
      color: "var(--lamp)",
      note: `acr ${facts.acr_elev.toFixed(2)}×`,
    },
    {
      key: "acr",
      label: "acute : chronic",
      value: facts.acr_dist.toFixed(2),
      unit: "×",
      delta: undefined,
      series: daily.dist,
      color: facts.acr_dist > 1.5 ? "var(--ember)" : facts.acr_dist < 0.8 ? "var(--lamp)" : "var(--pine)",
      note: facts.acr_dist > 1.5 ? "load spike" : facts.acr_dist < 0.8 ? "volume low" : "in band",
    },
    {
      key: "block",
      label: "block vs plan",
      value: `${facts.block_dist_delta_pct >= 0 ? "+" : ""}${facts.block_dist_delta_pct.toFixed(0)}`,
      unit: "%",
      delta: { value: facts.block_elev_delta_pct, suffix: "% vert", good: facts.block_elev_delta_pct >= 0 },
      series: daily.dist,
      color: facts.block_dist_delta_pct >= 0 ? "var(--pine)" : "var(--ember)",
      note: "cumulative dist",
    },
    {
      key: "readiness",
      label: "readiness",
      value: readiness != null ? String(readiness) : "—",
      delta: { value: readiness != null && facts.readiness_d7 != null ? readiness - facts.readiness_d7 : null, suffix: " v7d", good: readiness != null && facts.readiness_d7 != null ? readiness >= facts.readiness_d7 : null },
      series: seriesOf((d) => d.readiness_score),
      color: "var(--pine)",
      note: latest?.temp_deviation_c != null ? `temp ${latest.temp_deviation_c > 0 ? "+" : ""}${latest.temp_deviation_c.toFixed(2)}°C` : undefined,
    },
    {
      key: "hrv",
      label: "hrv",
      value: hrv != null ? String(Math.round(hrv)) : "—",
      unit: "ms",
      delta: { value: facts.hrv_ratio != null ? (facts.hrv_ratio - 1) * 100 : null, suffix: "% 7v28", good: facts.hrv_ratio != null ? facts.hrv_ratio >= 0.95 : null },
      series: seriesOf((d) => d.avg_hrv),
      color: "var(--creek)",
      note: latest?.avg_hr != null ? `sleep hr ${Math.round(latest.avg_hr)}` : undefined,
    },
    {
      key: "rhr",
      label: "resting hr",
      value: rhr != null ? String(Math.round(rhr)) : "—",
      unit: "bpm",
      delta: { value: facts.rhr_drift, suffix: " drift", good: facts.rhr_drift != null ? facts.rhr_drift < 3 : null },
      series: seriesOf((d) => d.lowest_hr),
      color: "var(--creek)",
    },
    {
      key: "sleep",
      label: "sleep",
      value: sleepS != null ? fmtDuration(sleepS) : "—",
      delta: { value: facts.sleep_debt_h != null ? -facts.sleep_debt_h : null, suffix: "h debt", good: facts.sleep_debt_h != null ? facts.sleep_debt_h <= 0 : null },
      series: seriesOf((d) => (d.total_sleep_s ?? 0) / 3600),
      color: "var(--creek)",
      note: latest?.sleep_score != null ? `score ${latest.sleep_score}` : undefined,
    },
  ];

  return (
    <section>
      <SectionTag
        right={
          <span className="eyebrow">
            {oura.connected ? `ring · ${oura.days.length} nights` : "ring not connected"} · strava · {activities.length} runs
          </span>
        }
      >
        vitals — load × recovery
      </SectionTag>
      <div className="vitals-band">
        {vitals.map((v, i) => (
          <motion.div
            key={v.key}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.08 + i * 0.05 }}
            style={{ padding: "14px 14px 10px", minWidth: 0 }}
          >
            <span className="eyebrow" style={{ fontSize: 8.5, whiteSpace: "nowrap", display: "block" }}>{v.label}</span>
            <div className="numerals" style={{ fontSize: 27, fontWeight: 600, letterSpacing: "-0.04em", marginTop: 7, color: v.value === "—" ? "var(--mist-mute)" : "var(--mist)" }}>
              {v.value}
              {v.unit && <span style={{ fontSize: 11, fontWeight: 400, color: "var(--mist-mute)", marginLeft: 4 }}>{v.unit}</span>}
            </div>
            <div style={{ marginTop: 4, minHeight: 12, whiteSpace: "nowrap" }}>
              {v.delta && <Delta value={v.delta.value} suffix={v.delta.suffix} good={v.delta.good} />}
            </div>
            <div style={{ marginTop: 8 }}>
              {v.series.some((x) => x > 0)
                ? <Spark values={v.series} color={v.color} height={30} />
                : <div style={{ height: 30, display: "grid", placeItems: "center", border: "1px dashed var(--edge)" }}>
                    <span className="eyebrow" style={{ fontSize: 8 }}>no data</span>
                  </div>}
            </div>
            <div className="eyebrow" style={{ fontSize: 8, marginTop: 6, color: "var(--mist-mute)", minHeight: 10 }}>
              {v.note ?? ""}
            </div>
          </motion.div>
        ))}
      </div>
      {!oura.connected && !oura.loading && <ConnectStrip kind="oura" />}
      <SleepStagesInline />
    </section>
  );
}

function SleepStagesInline() {
  const { latest, connected } = useOura();
  if (!connected || !latest) return null;
  const total = latest.total_sleep_s ?? 0;
  if (!total) return null;
  const deep = (latest.deep_sleep_s ?? 0) / total;
  const rem = (latest.rem_sleep_s ?? 0) / total;
  const light = Math.max(0, 1 - deep - rem);
  const segs = [
    { pct: deep, label: "deep", color: "var(--creek)" },
    { pct: rem, label: "rem", color: "var(--lamp)" },
    { pct: light, label: "light", color: "var(--edge-bright)" },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 8, padding: "0 2px" }}>
      <span className="eyebrow" style={{ fontSize: 8.5, whiteSpace: "nowrap" }}>last night</span>
      <div style={{ flex: 1, display: "flex", height: 6, background: "var(--night-deep)", border: "1px solid var(--edge)" }}>
        {segs.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ width: 0 }} animate={{ width: `${s.pct * 100}%` }}
            transition={{ duration: 0.7, delay: 0.3 + i * 0.12, ease: "easeOut" }}
            style={{ background: s.color }}
            title={`${s.label} · ${(s.pct * 100).toFixed(0)}%`}
          />
        ))}
      </div>
      <span className="eyebrow numerals" style={{ fontSize: 8.5, whiteSpace: "nowrap" }}>
        {segs.map((s) => `${s.label} ${(s.pct * 100).toFixed(0)}%`).join(" · ")}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Trajectory — cumulative actual vs plan, the centerpiece chart      */
/* ------------------------------------------------------------------ */

function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function weekDates(wk: number, blockStart: string): string {
  const start = new Date(new Date(blockStart + "T00:00:00").getTime() + (wk - 1) * 7 * 86400_000);
  const end = new Date(start.getTime() + 6 * 86400_000);
  const f = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();
  return `${f(start)} – ${f(end)}`;
}

function Trajectory() {
  const u = useUnits();
  const { weekly, currentWeek } = useStrava();
  const { targets, totalWeeks, blockStart } = useBlockConfig();
  const [view, setView] = useState<"dist" | "elev">("dist");
  const [hoverWk, setHoverWk] = useState<number | null>(null); // 0-indexed
  const { ref: measureRef, width } = useMeasuredWidth();

  const data = useMemo(() => {
    const cumTarget: number[] = [];
    const cumActual: (number | null)[] = [];
    let t = 0, a = 0;
    for (let i = 0; i < targets.length; i++) {
      const wk = targets[i];
      t += view === "dist" ? wk.target_dist : wk.target_elev;
      cumTarget.push(t);
      if (i < currentWeek && weekly[i]) {
        const actWk = weekly[i];
        a += view === "dist" ? actWk.dist_mi : actWk.elev_ft;
        cumActual.push(a);
      } else {
        cumActual.push(null);
      }
    }
    return { cumTarget, cumActual };
  }, [view, weekly, currentWeek, targets]);

  const totalTarget = data.cumTarget[data.cumTarget.length - 1];
  const expectedToday = data.cumTarget[currentWeek - 1] || 1;
  const actualToday = data.cumActual[currentWeek - 1] ?? 0;
  const deltaPct = ((actualToday - expectedToday) / expectedToday) * 100;
  const projectedFinal = actualToday > 0 ? (actualToday / expectedToday) * totalTarget : totalTarget;

  const fmt = (n: number) => (view === "dist" ? u.dist(n, 0) : u.elev(n));
  const unit = view === "dist" ? u.distUnit : `${u.elevUnit}↑`;
  const ahead = deltaPct >= 0;
  const lineColor = ahead ? "var(--pine)" : "var(--ember)";

  /* ---- pixel geometry: no viewBox stretching, so text stays crisp ---- */
  const H = 280;
  const PAD = { top: 26, right: 16, bottom: 26, left: 16 };
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const maxY = Math.max(totalTarget, projectedFinal) * 1.05;
  const xAt = (i: number) => PAD.left + (i / (totalWeeks - 1)) * plotW;
  const yAt = (v: number) => PAD.top + (1 - v / maxY) * plotH;

  const targetPath = data.cumTarget.map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(" ");
  const actualPath = data.cumActual
    .map((v, i) => (v == null ? "" : `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`))
    .join(" ").replace(/^L/, "M");

  const todayX = xAt(currentWeek - 1);

  /* ---- hover: snap to nearest week ---- */
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = Math.round(((x - PAD.left) / Math.max(1, plotW)) * (totalWeeks - 1));
    setHoverWk(Math.max(0, Math.min(totalWeeks - 1, i)));
  };

  const hover = hoverWk != null ? {
    i: hoverWk,
    x: xAt(hoverWk),
    plan: data.cumTarget[hoverWk],
    actual: data.cumActual[hoverWk],
    wkTarget: view === "dist" ? targets[hoverWk]?.target_dist ?? 0 : targets[hoverWk]?.target_elev ?? 0,
    wkActual: hoverWk < currentWeek && weekly[hoverWk] ? (view === "dist" ? weekly[hoverWk].dist_mi : weekly[hoverWk].elev_ft) : null,
  } : null;
  const hoverDelta = hover && hover.actual != null && hover.plan > 0
    ? ((hover.actual - hover.plan) / hover.plan) * 100 : null;
  const tipOnLeft = hover != null && width > 0 && hover.x > width * 0.62;

  const stats: { label: string; value: string; color?: string }[] = [
    { label: "expected", value: `${fmt(expectedToday)} ${unit}` },
    { label: "actual", value: `${fmt(actualToday)} ${unit}`, color: lineColor },
    { label: "delta", value: `${ahead ? "+" : ""}${deltaPct.toFixed(1)}%`, color: lineColor },
    { label: "projected wk20", value: `${fmt(projectedFinal)} ${unit}`, color: lineColor },
    { label: "block goal", value: `${fmt(totalTarget)} ${unit}` },
  ];

  return (
    <section>
      <SectionTag
        right={
          <div style={{ display: "flex", gap: 6 }}>
            <button className={"chip" + (view === "dist" ? " active" : "")} onClick={() => setView("dist")}>dist</button>
            <button className={"chip" + (view === "elev" ? " active" : "")} onClick={() => setView("elev")}>vert</button>
          </div>
        }
      >
        trajectory — wk {currentWeek} of {totalWeeks}
      </SectionTag>

      <div className="panel notch" style={{ overflow: "hidden" }}>
        <Contours seed={13} opacity={0.08} />
        {/* inline stat row — the old right-rail, flattened into the panel */}
        <div style={{ position: "relative", display: "flex", flexWrap: "wrap", borderBottom: "1px solid var(--edge)" }}>
          {stats.map((s, i) => (
            <div key={s.label} style={{ padding: "12px 20px", borderLeft: i > 0 ? "1px solid var(--edge)" : "none", flex: "1 1 auto" }}>
              <div className="eyebrow" style={{ fontSize: 8.5 }}>{s.label}</div>
              <div className="numerals" style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.03em", marginTop: 3, color: s.color ?? "var(--mist)" }}>
                {s.value}
              </div>
            </div>
          ))}
        </div>

        <div ref={measureRef} style={{ position: "relative", padding: "6px 4px 2px" }}>
          {width > 0 && (
            <svg
              width={width} height={H} style={{ display: "block", cursor: "crosshair" }}
              onMouseMove={onMove} onMouseLeave={() => setHoverWk(null)}
            >
              {/* horizontal grid */}
              {[0.25, 0.5, 0.75, 1].map((f) => (
                <line key={f} x1={PAD.left} x2={width - PAD.right} y1={yAt(maxY * f / 1.05)} y2={yAt(maxY * f / 1.05)}
                  stroke="var(--edge)" strokeWidth="1" strokeDasharray="2 5" />
              ))}
              {/* week ticks */}
              {Array.from({ length: totalWeeks }).map((_, i) => (
                <line key={i} x1={xAt(i)} x2={xAt(i)} y1={H - PAD.bottom} y2={H - PAD.bottom + ((i + 1) % 5 === 0 || i === 0 ? 6 : 3)}
                  stroke="var(--edge-bright)" strokeWidth="1" />
              ))}
              {/* week axis labels */}
              {[1, ...Array.from({ length: Math.floor((totalWeeks - 1) / 5) }, (_, i) => (i + 1) * 5), totalWeeks]
                .filter((w, i, arr) => arr.indexOf(w) === i)
                .map((w) => (
                <text key={w} x={xAt(w - 1)} y={H - 6} fontSize="9" fontFamily="Spline Sans Mono" letterSpacing="1"
                  fill="var(--mist-mute)" textAnchor={w === 1 ? "start" : w === totalWeeks ? "end" : "middle"}>
                  WK {String(w).padStart(2, "0")}
                </text>
              ))}

              {/* plan target */}
              <motion.path
                d={targetPath} fill="none" stroke="var(--mist-mute)" strokeWidth="1.2" strokeDasharray="3 5" opacity="0.85"
                initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4, ease: "easeOut" }}
              />
              {/* actual */}
              <motion.path
                d={actualPath} fill="none" stroke={lineColor} strokeWidth="2.2" strokeLinecap="round"
                initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
                transition={{ duration: 1.4, ease: [0.2, 0.7, 0.2, 1], delay: 0.2 }}
              />
              {/* projection */}
              <motion.line
                x1={todayX} y1={yAt(actualToday)} x2={xAt(totalWeeks - 1)} y2={yAt(projectedFinal)}
                stroke={lineColor} strokeWidth="1" strokeDasharray="2 4"
                initial={{ opacity: 0 }} animate={{ opacity: 0.7 }} transition={{ duration: 0.6, delay: 1.3 }}
              />
              {/* today */}
              <motion.line
                x1={todayX} x2={todayX} y1={PAD.top - 12} y2={H - PAD.bottom} stroke="var(--lamp)" strokeWidth="1"
                initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6, delay: 1 }}
              />
              <text x={todayX + 6} y={PAD.top - 8} fontSize="10" fontFamily="Spline Sans Mono" letterSpacing="1.5" fill="var(--lamp)">
                WK {currentWeek} · TODAY
              </text>
              <circle cx={todayX} cy={yAt(expectedToday)} r="2.5" fill="var(--mist-mute)" />
              <circle cx={todayX} cy={yAt(actualToday)} r="3.5" fill={lineColor} stroke="var(--night)" strokeWidth="1" />
              {/* race marker */}
              <circle cx={xAt(totalWeeks - 1)} cy={yAt(totalTarget)} r="3" fill="var(--lamp)" />
              <text x={xAt(totalWeeks - 1) - 7} y={yAt(totalTarget) - 7} fontSize="10" fontFamily="Spline Sans Mono" letterSpacing="1.5" fill="var(--lamp)" textAnchor="end">
                RACE
              </text>

              {/* hover crosshair */}
              {hover && (
                <g>
                  <line x1={hover.x} x2={hover.x} y1={PAD.top - 4} y2={H - PAD.bottom} stroke="var(--mist-dim)" strokeWidth="1" opacity="0.5" />
                  <circle cx={hover.x} cy={yAt(hover.plan)} r="3" fill="var(--night)" stroke="var(--mist-dim)" strokeWidth="1.2" />
                  {hover.actual != null && (
                    <circle cx={hover.x} cy={yAt(hover.actual)} r="3.5" fill={lineColor} stroke="var(--night)" strokeWidth="1" />
                  )}
                </g>
              )}
            </svg>
          )}

          {/* hover tooltip — HTML so it never distorts */}
          {hover && width > 0 && (
            <div style={{
              position: "absolute",
              top: 30,
              left: tipOnLeft ? undefined : Math.min(hover.x + 14, width - 230),
              right: tipOnLeft ? width - hover.x + 14 : undefined,
              width: 216,
              background: "var(--night-deep)",
              border: "1px solid var(--edge-bright)",
              borderTop: "2px solid var(--lamp)",
              padding: "10px 12px",
              pointerEvents: "none",
              zIndex: 5,
              boxShadow: "0 8px 28px rgba(0,0,0,0.55)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="eyebrow" style={{ fontSize: 8.5, color: "var(--lamp)" }}>
                  week {String(hover.i + 1).padStart(2, "0")}{hover.i + 1 === currentWeek ? " · now" : hover.i + 1 === totalWeeks ? " · race" : ""}
                </span>
                <span className="numerals" style={{ fontSize: 9, color: "var(--mist-mute)" }}>{weekDates(hover.i + 1, blockStart)}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", marginTop: 8 }}>
                <span className="eyebrow" style={{ fontSize: 8 }}>plan · cum</span>
                <span className="numerals" style={{ fontSize: 12, textAlign: "right" }}>{fmt(hover.plan)} {unit}</span>
                <span className="eyebrow" style={{ fontSize: 8 }}>actual · cum</span>
                <span className="numerals" style={{ fontSize: 12, textAlign: "right", color: hover.actual != null ? lineColor : "var(--mist-mute)" }}>
                  {hover.actual != null ? `${fmt(hover.actual)} ${unit}` : "—"}
                </span>
                {hoverDelta != null && (
                  <>
                    <span className="eyebrow" style={{ fontSize: 8 }}>delta</span>
                    <span className="numerals" style={{ fontSize: 12, textAlign: "right", color: hoverDelta >= 0 ? "var(--pine)" : "var(--ember)" }}>
                      {hoverDelta >= 0 ? "+" : ""}{hoverDelta.toFixed(1)}%
                    </span>
                  </>
                )}
              </div>
              <div style={{ borderTop: "1px solid var(--edge)", marginTop: 8, paddingTop: 7, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px" }}>
                <span className="eyebrow" style={{ fontSize: 8 }}>wk target</span>
                <span className="numerals" style={{ fontSize: 11, textAlign: "right", color: "var(--mist-dim)" }}>{fmt(hover.wkTarget)} {unit}</span>
                <span className="eyebrow" style={{ fontSize: 8 }}>wk actual</span>
                <span className="numerals" style={{ fontSize: 11, textAlign: "right", color: "var(--mist-dim)" }}>
                  {hover.wkActual != null ? `${fmt(hover.wkActual)} ${unit}` : "—"}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Road ahead — next 14 days (calendar) ∪ next 6 weeks (plan)         */
/* ------------------------------------------------------------------ */

const CLASSIFICATION_META: Record<GCalEvent["classification"], { color: string; tag: string }> = {
  race:        { color: "var(--ember)", tag: "RACE" },
  travel:      { color: "var(--lamp)", tag: "TRVL" },
  appointment: { color: "var(--creek)", tag: "APPT" },
  training:    { color: "var(--pine)", tag: "TRN" },
  family:      { color: "var(--creek)", tag: "FAM" },
  work:        { color: "var(--mist-mute)", tag: "WORK" },
  other:       { color: "var(--mist-mute)", tag: "···" },
};

function RoadAhead() {
  const u = useUnits();
  const { currentWeek } = useStrava();
  const { data: cal, connected: calOk, missing: calMissing } = useGoogleCal();
  const { data: state, missing: stateMissing } = usePersistentState();
  const { missing: agentMissing } = useAgentReadout();

  /* ---- 14-day calendar strip ---- */
  const days = useMemo(() => {
    const now = new Date();
    const localIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const out: { date: string; label: string; events: GCalEvent[] }[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now.getTime() + i * 86400_000);
      out.push({
        date: localIso(d),
        label: d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" }),
        events: [],
      });
    }
    if (cal) {
      for (const e of cal.events) {
        if (!e.start) continue;
        if (!e.all_day) {
          const startMs = new Date(e.start).getTime();
          if (startMs < now.getTime() - 60 * 60_000) continue;
        }
        const slot = out.find((d) => d.date === e.start!.slice(0, 10));
        if (slot) slot.events.push(e);
      }
    }
    return out;
  }, [cal]);

  /* ---- plan blocks (persisted agent plan, else block targets) ---- */
  const { targets, totalWeeks } = useBlockConfig();
  const fallback: PlanBlock[] = useMemo(() => {
    const start = Math.min(totalWeeks, currentWeek + 1);
    const end = Math.min(totalWeeks, currentWeek + 6);
    return targets.slice(start - 1, end).map((b) => ({
      wk: b.wk,
      label: b.wk === totalWeeks ? "Race week" : "Planned",
      dist_mi: b.target_dist,
      elev_ft: b.target_elev,
      focus: "Awaiting agent recommendations — resync to generate.",
    }));
  }, [currentWeek, targets, totalWeeks]);
  const stateBlocks = state?.plan_blocks ?? null;
  const blocks: PlanBlock[] = stateBlocks && stateBlocks.length > 0 ? stateBlocks : fallback;
  const live = !!(stateBlocks && stateBlocks.length > 0);
  const maxDist = Math.max(...blocks.map((b) => b.dist_mi), 1);

  return (
    <section>
      <SectionTag
        right={
          <span className="eyebrow">
            {calOk
              ? `${cal!.summary.upcoming_events} events · ${cal!.summary.races_upcoming} races · ${cal!.summary.travel_days_upcoming.length} travel days`
              : calMissing ? "calendar not connected" : "loading calendar…"}
            {" — plan "}
            <span style={{ color: live ? "var(--pine)" : "var(--mist-mute)" }}>
              {live
                ? `agent · ${state?.last_updated ? new Date(state.last_updated).toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toLowerCase() : ""}`
                : agentMissing || stateMissing ? "targets only" : "loading…"}
            </span>
          </span>
        }
      >
        the road ahead — 14 days · 6 weeks
      </SectionTag>

      {/* calendar strip */}
      {calOk ? (
        <div className="horizon-days" style={{ marginBottom: 1 }}>
          {days.map((d, i) => {
            const isToday = i === 0;
            const isWeekend = ["Sat", "Sun"].includes(d.label.split(" ")[0]);
            return (
              <motion.div
                key={d.date}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: i * 0.015 }}
                style={{ padding: "9px 10px", minHeight: 74, position: "relative", overflow: "hidden" }}
              >
                {isToday && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "var(--lamp)" }} />}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="eyebrow" style={{ fontSize: 8.5, color: isToday ? "var(--lamp)" : isWeekend ? "var(--mist-dim)" : "var(--mist-mute)" }}>
                    {isToday ? "today" : d.label.toLowerCase()}
                  </span>
                  {d.events.length > 2 && (
                    <span className="eyebrow numerals" style={{ fontSize: 8 }}>+{d.events.length - 2}</span>
                  )}
                </div>
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                  {d.events.length === 0 ? (
                    <span style={{ fontSize: 10, color: "var(--edge-bright)", fontFamily: "var(--font-mono)" }}>—</span>
                  ) : (
                    d.events.slice(0, 2).map((e) => {
                      const meta = CLASSIFICATION_META[e.classification] || CLASSIFICATION_META.other;
                      const time = e.all_day ? "" : e.start ? new Date(e.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "") : "";
                      const inner = (
                        <span style={{ display: "block", fontSize: 10.5, lineHeight: 1.3, borderLeft: `2px solid ${meta.color}`, paddingLeft: 5, color: "var(--mist-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {time && <span className="numerals" style={{ color: "var(--mist-mute)", marginRight: 4, fontSize: 9 }}>{time}</span>}
                          {e.summary}
                        </span>
                      );
                      return e.html_link
                        ? <a key={e.id} href={e.html_link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }} title={e.summary}>{inner}</a>
                        : <span key={e.id} title={e.summary}>{inner}</span>;
                    })
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      ) : calMissing ? (
        <ConnectStrip kind="google" />
      ) : null}

      {/* plan weeks — rows, not cards */}
      <div className="panel" style={{ marginTop: calOk ? 0 : 8, borderTop: calOk ? "none" : undefined }}>
        {blocks.map((w, i) => {
          const offset = w.wk - currentWeek;
          const isNext = offset === 1;
          const isRace = w.wk === totalWeeks;
          return (
            <motion.div
              key={w.wk}
              initial={{ opacity: 0, x: -8 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }}
              transition={{ duration: 0.35, delay: i * 0.05 }}
              style={{
                display: "grid",
                gridTemplateColumns: "70px minmax(0,1.2fr) minmax(0,1fr) 120px",
                gap: 16,
                alignItems: "center",
                padding: "13px 18px",
                borderTop: i > 0 ? "1px solid var(--edge)" : "none",
                background: isNext ? "var(--lamp-glow)" : isRace ? "rgba(240, 102, 77, 0.06)" : "transparent",
              }}
            >
              <div>
                <div className="eyebrow" style={{ fontSize: 8, color: isNext ? "var(--lamp)" : isRace ? "var(--ember)" : "var(--mist-mute)" }}>
                  {isNext ? "next" : isRace ? "race" : `+${offset} wk`}
                </div>
                <div className="numerals" style={{ fontSize: 19, fontWeight: 600, marginTop: 1 }}>w{String(w.wk).padStart(2, "0")}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="display" style={{ fontSize: 15, fontWeight: 600 }}>
                  {w.label}
                  {w.quality != null && <span className="numerals" style={{ fontSize: 10, color: "var(--mist-mute)", marginLeft: 8 }}>Q{w.quality}</span>}
                </div>
                <div style={{ fontSize: 12, color: "var(--mist-dim)", marginTop: 3, lineHeight: 1.45 }}>{w.focus}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                {w.key_session ? (
                  <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--mist-dim)", lineHeight: 1.45, borderLeft: "2px solid var(--lamp)", paddingLeft: 8 }}>
                    <span className="eyebrow" style={{ fontSize: 7.5, color: "var(--lamp)", display: "block" }}>key session</span>
                    {w.key_session}
                  </div>
                ) : (
                  <span style={{ fontSize: 11, color: "var(--edge-bright)", fontFamily: "var(--font-mono)" }}>—</span>
                )}
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="numerals" style={{ fontSize: 14, fontWeight: 600 }}>{u.dist(w.dist_mi, 0)}<span style={{ fontSize: 9, color: "var(--mist-mute)" }}> {u.distUnit}</span></span>
                  <span className="numerals" style={{ fontSize: 11, color: "var(--mist-dim)" }}>{u.elev(w.elev_ft)}<span style={{ fontSize: 9, color: "var(--mist-mute)" }}> {u.elevUnit}↑</span></span>
                </div>
                <div style={{ height: 3, background: "var(--night-deep)", marginTop: 6 }}>
                  <motion.div
                    initial={{ width: 0 }} whileInView={{ width: `${(w.dist_mi / maxDist) * 100}%` }} viewport={{ once: true }}
                    transition={{ duration: 0.7, delay: 0.2 + i * 0.05 }}
                    style={{ height: "100%", background: isRace ? "var(--ember)" : "var(--lamp)" }}
                  />
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Log — compact field table                                          */
/* ------------------------------------------------------------------ */

const TYPE_META: Record<Activity["type"], { label: string; color: string }> = {
  run:     { label: "RUN", color: "var(--mist-dim)" },
  long:    { label: "LNG", color: "var(--lamp)" },
  vert:    { label: "VRT", color: "var(--pine)" },
  easy:    { label: "EZ",  color: "var(--mist-mute)" },
  workout: { label: "WRK", color: "var(--ember)" },
};

function LogTable() {
  const [limit, setLimit] = useState(12);
  const { activities, loading, error } = useStrava();
  const { syncing } = useRefresh();
  const u = useUnits();
  const visible = activities.slice(0, limit);

  return (
    <section>
      <SectionTag right={<span className="eyebrow">{syncing ? "pulling strava…" : `${activities.length} activities`}</span>}>
        the log
      </SectionTag>
      <div className="panel">
        <div className="log-grid" style={{ padding: "10px 18px", borderBottom: "1px solid var(--edge-bright)" }}>
          <span className="eyebrow" style={{ fontSize: 8.5 }}>date</span>
          <span className="eyebrow" style={{ fontSize: 8.5 }}>activity</span>
          <span className="eyebrow col-type" style={{ fontSize: 8.5 }}>type</span>
          <span className="eyebrow" style={{ fontSize: 8.5, textAlign: "right" }}>{u.distUnit}</span>
          <span className="eyebrow" style={{ fontSize: 8.5, textAlign: "right" }}>{u.elevUnit}↑</span>
          <span className="eyebrow col-pace" style={{ fontSize: 8.5, textAlign: "right" }}>pace{u.paceUnit}</span>
          <span className="eyebrow col-rpe" style={{ fontSize: 8.5 }}>rpe</span>
        </div>

        {loading && activities.length === 0 && (
          <div style={{ padding: "28px 0", textAlign: "center" }}><span className="eyebrow">loading strava snapshot…</span></div>
        )}
        {error && (
          <div style={{ padding: "28px 0", textAlign: "center" }}>
            <span className="eyebrow" style={{ color: "var(--ember)" }}>couldn't load strava.json — run `node scripts/sync-strava.mjs`</span>
          </div>
        )}

        {visible.map((a, i) => (
          <motion.div
            key={a.id}
            className="log-grid"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: Math.min(i * 0.025, 0.4) }}
            style={{ padding: "11px 18px", borderTop: i > 0 ? "1px solid var(--edge)" : "none" }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = "var(--panel-raise)")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = "transparent")}
          >
            <span className="numerals" style={{ fontSize: 11.5, color: "var(--mist-mute)" }}>
              {new Date(a.date).toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toLowerCase()}
            </span>
            <div style={{ minWidth: 0 }}>
              {a.strava_url ? (
                <a href={a.strava_url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 13.5, fontWeight: 500, color: "var(--mist)", textDecoration: "none", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {a.title} <span style={{ color: "var(--mist-mute)", fontSize: 10 }}>↗</span>
                </a>
              ) : (
                <span style={{ fontSize: 13.5, fontWeight: 500 }}>{a.title}</span>
              )}
              <span className="numerals" style={{ fontSize: 9.5, color: "var(--mist-mute)", display: "flex", gap: 8, marginTop: 2 }}>
                {a.start_time_local && <span>{a.start_time_local}</span>}
                {a.temp_avg_f != null && (
                  <span
                    title={[
                      `avg ${u.temp(a.temp_avg_f)}${u.tempUnit}`,
                      a.temp_max_f != null ? `max ${u.temp(a.temp_max_f)}${u.tempUnit}` : null,
                      a.apparent_avg_f != null ? `feels ${u.temp(a.apparent_avg_f)}${u.tempUnit}` : null,
                      a.humidity_avg != null ? `${a.humidity_avg}% rh` : null,
                    ].filter(Boolean).join(" · ")}
                    style={{ color: (a.apparent_avg_f ?? a.temp_avg_f) >= 75 ? "var(--ember)" : (a.apparent_avg_f ?? a.temp_avg_f) <= 40 ? "var(--creek)" : "var(--mist-mute)" }}
                  >
                    {u.temp(a.temp_avg_f)}{u.tempUnit}
                    {a.apparent_avg_f != null && Math.abs(a.apparent_avg_f - a.temp_avg_f) >= 2 && ` · feels ${u.temp(a.apparent_avg_f)}${u.tempUnit}`}
                  </span>
                )}
              </span>
            </div>
            <span className="col-type">
              <span className="eyebrow" style={{ fontSize: 8.5, color: TYPE_META[a.type].color, border: `1px solid ${TYPE_META[a.type].color}`, padding: "2px 5px" }}>
                {TYPE_META[a.type].label}
              </span>
            </span>
            <span className="numerals" style={{ fontSize: 14, fontWeight: 600, textAlign: "right" }}>{u.dist(a.distance_mi)}</span>
            <span className="numerals" style={{ fontSize: 14, fontWeight: 600, textAlign: "right", color: "var(--mist-dim)" }}>{u.elev(a.elevation_ft)}</span>
            <span className="numerals col-pace" style={{ fontSize: 11.5, color: "var(--mist-mute)", textAlign: "right" }}>{u.paceFmt(a.moving_s, a.distance_mi)}</span>
            <span className="col-rpe" style={{ display: "inline-flex", gap: 3 }}>
              {Array.from({ length: 5 }).map((_, j) => (
                <span key={j} style={{ width: 6, height: 6, transform: "rotate(45deg)", background: j < a.rpe ? "var(--lamp)" : "transparent", border: "1px solid var(--edge-bright)" }} />
              ))}
            </span>
          </motion.div>
        ))}

        {activities.length > limit && (
          <div style={{ textAlign: "center", padding: 12, borderTop: "1px solid var(--edge)" }}>
            <button className="chip" onClick={() => setLimit((l) => l + 20)}>
              show {Math.min(20, activities.length - limit)} more · {activities.length - limit} hidden
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Agent rail — readout + flags + chat, always at your side           */
/* ------------------------------------------------------------------ */

function useFacts(): CoachFacts {
  const { activities, weekly, currentWeek } = useStrava();
  const { days: ouraDays } = useOura();
  const { targets } = useBlockConfig();
  return useMemo(
    () => computeCoachFacts(activities, ouraDays, weekly, currentWeek, targets),
    [activities, ouraDays, weekly, currentWeek, targets],
  );
}

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
  "race-day fueling strategy",
];

/* chat survives page refreshes — capped so localStorage stays small */
const CHAT_STORAGE_KEY = "coach-chat";
const CHAT_STORAGE_CAP = 50;

function loadStoredChat(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function AgentRail() {
  const { data: agent, missing: agentMissing } = useAgentReadout();
  const { system } = useUnits();
  const facts = useFacts();
  const [readoutOpen, setReadoutOpen] = useState(true);

  /* chat state */
  const [messages, setMessages] = useState<ChatMessage[]>(loadStoredChat);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pending]);

  // persist the thread (drop the transient pending bubble, cap the length)
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-CHAT_STORAGE_CAP)));
    } catch { /* private mode — chat just won't persist */ }
  }, [messages]);

  // collapse the readout once a conversation starts, to give chat room
  useEffect(() => {
    if (messages.length > 0) setReadoutOpen(false);
  }, [messages.length]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", content: trimmed };
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
          // the coach answers in the dashboard's selected unit system
          units: system,
        }),
      });
      if (!res.body) throw new Error("no body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const handleEvent = (event: string, payload: { content?: string; meta?: ChatMessage["meta"]; message?: string }) => {
        if (event === "heartbeat") {
          const sec = Math.floor((Date.now() - t0) / 1000);
          setStatusLine(`thinking… ${sec}s`);
        } else if (event === "message") {
          setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: "assistant", content: payload.content ?? "", meta: payload.meta }]);
        } else if (event === "error") {
          setMessages((prev) => [...prev, { id: `e-${Date.now()}`, role: "assistant", content: payload.message ?? "unknown error", meta: { error: true } }]);
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
          try { handleEvent(event, JSON.parse(dataStr)); } catch { /* skip malformed SSE block */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setMessages((prev) => [...prev, { id: `e-${Date.now()}`, role: "assistant", content: `network error: ${(e as Error).message}`, meta: { error: true } }]);
      }
    } finally {
      setPending(false);
      setStatusLine("");
      abortRef.current = null;
    }
  }, [messages, pending, system]);

  const cancel = () => {
    abortRef.current?.abort();
    setPending(false);
    setStatusLine("");
  };

  const clearChat = () => {
    setMessages([]);
    try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch { /* nothing stored */ }
  };

  // a readout older than a day means the coach step failed (or was skipped)
  // on recent resyncs — surface it instead of silently showing old advice
  const readoutStale = !!agent && isStale(agent.generated_at);

  return (
    <aside className="rail-sticky">
      <div className="panel notch" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
        {/* status header */}
        <div style={{ padding: "13px 18px", borderBottom: "1px solid var(--edge)", display: "flex", alignItems: "center", gap: 10 }}>
          <span className={agent ? undefined : "pulse"} style={{ width: 7, height: 7, borderRadius: "50%", background: agent ? (readoutStale ? "var(--ember)" : "var(--pine)") : "var(--lamp)", flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="eyebrow" style={{ color: "var(--mist-dim)" }}>the coach</div>
            <div className="numerals" style={{ fontSize: 10, color: readoutStale ? "var(--ember)" : "var(--mist-mute)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {agent
                ? `${agent.model} · ${relativeAgo(new Date(agent.generated_at).getTime())}${readoutStale ? " · stale — resync" : ""}`
                : agentMissing ? "no readout — resync to generate" : "loading…"}
            </div>
          </div>
          {pending
            ? <span className="eyebrow numerals" style={{ color: "var(--lamp)" }}>{statusLine}</span>
            : messages.length > 0 && (
                <button className="chip" onClick={clearChat} title="clear chat history" style={{ fontSize: 9 }}>
                  clear
                </button>
              )}
        </div>

        {/* scrollable body: flags + readout + chat thread */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
          <FlagsRow flags={facts.flags} />
          <ReadoutBlock agent={agent} missing={agentMissing} open={readoutOpen} setOpen={setReadoutOpen} facts={facts} />

          {/* chat thread */}
          <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
            {messages.length === 0 && (
              <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--mist-mute)" }}>
                Ask anything — load, recovery, this weekend's plan, fueling.
                The coach reads your live Strava, Oura and calendar snapshots before answering.
              </p>
            )}
            {messages.map((m) => <ChatBubble key={m.id} msg={m} />)}
            {pending && <ChatBubble msg={{ id: "pending", role: "assistant", content: "", pending: true }} />}
          </div>
        </div>

        {/* suggested prompts */}
        {messages.length === 0 && (
          <div style={{ padding: "0 18px 10px", display: "flex", gap: 5, flexWrap: "wrap" }}>
            {SUGGESTED_PROMPTS.map((p) => (
              <button key={p} className="chip" style={{ fontSize: 9, textTransform: "none", letterSpacing: "0.04em" }} onClick={() => send(p)} disabled={pending}>
                {p}
              </button>
            ))}
          </div>
        )}

        {/* input */}
        <div style={{ borderTop: "1px solid var(--edge)", padding: "10px 14px", display: "flex", gap: 10, alignItems: "flex-end", background: "var(--night-deep)" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="ask the coach…"
            disabled={pending}
            rows={1}
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none", resize: "none",
              padding: "6px 2px", font: "13px var(--font-body)", color: "var(--mist)",
              minHeight: 30, maxHeight: 120,
            }}
          />
          {pending ? (
            <button className="chip" onClick={cancel} style={{ borderColor: "var(--ember)", color: "var(--ember)" }}>stop</button>
          ) : (
            <button
              className="chip"
              onClick={() => send(input)}
              disabled={!input.trim()}
              style={{
                background: input.trim() ? "var(--lamp)" : "transparent",
                borderColor: input.trim() ? "var(--lamp)" : "var(--edge-bright)",
                color: input.trim() ? "var(--night)" : "var(--mist-mute)",
                cursor: input.trim() ? "pointer" : "not-allowed",
              }}
            >send ⏎</button>
          )}
        </div>
      </div>
    </aside>
  );
}

function FlagsRow({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) {
    return (
      <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--edge)" }}>
        <span className="eyebrow" style={{ color: "var(--pine)" }}>● all systems green</span>
      </div>
    );
  }
  return (
    <div style={{ padding: "10px 18px 12px", borderBottom: "1px solid var(--edge)" }}>
      <div className="eyebrow" style={{ fontSize: 8.5, marginBottom: 8 }}>flags · computed locally</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {flags.map((f, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
            title={f.detail}
            style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, lineHeight: 1.45 }}
          >
            <span style={{ width: 3, alignSelf: "stretch", background: SEVERITY_COLOR[f.severity], flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <span className="eyebrow" style={{ fontSize: 8.5, color: SEVERITY_COLOR[f.severity] }}>{f.label}</span>
              <div style={{ color: "var(--mist-dim)", marginTop: 1 }}>{f.detail}</div>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function ReadoutBlock({ agent, missing, open, setOpen, facts }: {
  agent: AgentReadout | null; missing: boolean;
  open: boolean; setOpen: (b: boolean) => void;
  facts: CoachFacts;
}) {
  if (!agent) {
    return (
      <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--edge)" }}>
        <span className="eyebrow" style={{ fontSize: 8.5 }}>readout · awaiting</span>
        <p style={{ fontSize: 12, color: "var(--mist-mute)", marginTop: 6, lineHeight: 1.5 }}>
          {missing
            ? <>No agent readout for this snapshot yet — hit <span style={{ color: "var(--lamp)" }}>resync</span> (runs <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>claude -p</code> on your subscription) or <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>npm run coach</code>.</>
            : "loading…"}
        </p>
      </div>
    );
  }
  return (
    <div style={{ borderBottom: "1px solid var(--edge)" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ width: "100%", padding: "11px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", textAlign: "left" }}
      >
        <span className="eyebrow" style={{ fontSize: 8.5 }}>readout · {new Date(agent.generated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).toLowerCase()}</span>
        <span className="eyebrow" style={{ fontSize: 9, color: "var(--lamp)" }}>{open ? "− collapse" : "+ expand"}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.2, 0.7, 0.2, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: "0 18px 14px" }}>
              <p style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--mist)", whiteSpace: "pre-wrap" }}>{agent.summary}</p>
              {agent.watch_outs && agent.watch_outs.length > 0 && (
                <>
                  <div className="eyebrow" style={{ fontSize: 8.5, margin: "12px 0 5px", color: "var(--lamp)" }}>watch-outs</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.55, color: "var(--mist-dim)" }}>
                    {agent.watch_outs.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                </>
              )}
              {agent.recommendations && agent.recommendations.length > 0 && (
                <>
                  <div className="eyebrow" style={{ fontSize: 8.5, margin: "12px 0 5px", color: "var(--pine)" }}>recommendations</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.55, color: "var(--mist-dim)" }}>
                    {agent.recommendations.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </>
              )}
              {facts.recent_tags.length > 0 && (
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 12 }}>
                  {facts.recent_tags.map((t) => (
                    <span key={`${t.day}-${t.label}`} className="eyebrow" style={{ fontSize: 8, border: "1px dashed var(--edge-bright)", padding: "2px 6px", color: "var(--mist-mute)" }}>
                      {t.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  const isError = msg.meta?.error;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3, flexDirection: isUser ? "row-reverse" : "row" }}>
        <span className="eyebrow" style={{ fontSize: 8, color: isError ? "var(--ember)" : isUser ? "var(--mist-mute)" : "var(--lamp)" }}>
          {isUser ? "you" : isError ? "error" : "coach"}
        </span>
        {msg.meta?.num_turns != null && (
          <span className="numerals" style={{ fontSize: 8.5, color: "var(--mist-mute)" }}>
            {msg.meta.num_turns} turns{msg.meta.cost_usd != null && ` · $${msg.meta.cost_usd.toFixed(3)}`}
          </span>
        )}
      </div>
      <div style={{
        maxWidth: "94%",
        padding: "9px 12px",
        background: isUser ? "var(--panel-raise)" : isError ? "rgba(240, 102, 77, 0.08)" : "var(--night-deep)",
        border: `1px solid ${isUser ? "var(--edge-bright)" : isError ? "var(--ember)" : "var(--edge)"}`,
        borderLeft: isUser ? undefined : `2px solid ${isError ? "var(--ember)" : "var(--lamp)"}`,
        color: isError ? "var(--ember)" : "var(--mist)",
        fontSize: 12.5, lineHeight: 1.55,
        whiteSpace: "pre-wrap", wordBreak: "break-word",
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
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18 }}
          style={{ width: 5, height: 5, background: "var(--lamp)", display: "inline-block", transform: "rotate(45deg)" }}
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Connection strips + footer setup drawer                            */
/* ------------------------------------------------------------------ */

function ConnectStrip({ kind }: { kind: "oura" | "google" }) {
  const copy = kind === "oura"
    ? { label: "ring not connected", text: "Sleep, readiness, HRV and resting HR via Oura's OAuth2 — setup runs locally.", target: "setup-oura" }
    : { label: "calendar not connected", text: "Google Calendar gives the coach schedule context — travel, races, work blocks.", target: "setup-google" };
  const scroll = () => {
    const el = document.getElementById(copy.target);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.dispatchEvent(new CustomEvent("almanac:open"));
  };
  return (
    <div style={{
      marginTop: 8, padding: "10px 16px", border: "1px dashed var(--edge-bright)",
      display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
    }}>
      <span className="eyebrow" style={{ color: "var(--lamp)" }}>◆ {copy.label}</span>
      <span style={{ fontSize: 12, color: "var(--mist-mute)", flex: 1, minWidth: 200 }}>{copy.text}</span>
      <button className="chip" onClick={scroll} style={{ borderColor: "var(--lamp)", color: "var(--lamp)" }}>set up ↓</button>
    </div>
  );
}

const codeChip: React.CSSProperties = {
  background: "var(--night-deep)",
  border: "1px solid var(--edge)",
  padding: "1px 6px",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};
const codeBlock: React.CSSProperties = {
  background: "var(--night-deep)",
  padding: 10,
  border: "1px solid var(--edge)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  marginTop: 6,
  overflow: "auto",
  color: "var(--mist-dim)",
};
const olStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "var(--mist-dim)",
  paddingLeft: 20,
  margin: 0,
};
const linkLamp: React.CSSProperties = { color: "var(--lamp)", textDecoration: "underline" };

function SetupDrawer() {
  const strava = useStrava();
  const stravaOk = strava.activities.length > 0 && !strava.error;
  const { connected: ouraOk } = useOura();
  const { connected: googleOk } = useGoogleCal();
  const { data: agent } = useAgentReadout();
  const coachOk = !!agent;
  const [open, setOpen] = useState<"strava" | "oura" | "google" | "coach" | null>(null);
  const ouraRef = useRef<HTMLLIElement | null>(null);
  const googleRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    const oel = ouraRef.current;
    const gel = googleRef.current;
    const onOpenOura = () => setOpen("oura");
    const onOpenGoogle = () => setOpen("google");
    oel?.addEventListener("almanac:open", onOpenOura as EventListener);
    gel?.addEventListener("almanac:open", onOpenGoogle as EventListener);
    return () => {
      oel?.removeEventListener("almanac:open", onOpenOura as EventListener);
      gel?.removeEventListener("almanac:open", onOpenGoogle as EventListener);
    };
  }, []);

  const items: {
    key: "strava" | "oura" | "google" | "coach";
    title: string;
    connected: boolean;
    render: () => React.ReactNode;
  }[] = [
    {
      key: "strava",
      title: "Strava",
      connected: stravaOk,
      render: () => (
        <ol style={olStyle}>
          <li>
            Set up the strava-mcp client (one time): <a href="https://github.com/r-huijts/strava-mcp" target="_blank" rel="noopener noreferrer" style={linkLamp}>r-huijts/strava-mcp ↗</a>
          </li>
          <li>Confirm credentials saved at <code style={codeChip}>~/.config/strava-mcp/config.json</code>.</li>
          <li>Pull data from <code style={codeChip}>web/</code>:<pre style={codeBlock}>npm run sync:strava</pre></li>
        </ol>
      ),
    },
    {
      key: "oura",
      title: "Oura ring",
      connected: ouraOk,
      render: () => (
        <ol style={olStyle}>
          <li>
            Register an app:{" "}
            <a href="https://cloud.ouraring.com/oauth/applications" target="_blank" rel="noopener noreferrer" style={linkLamp}>cloud.ouraring.com/oauth/applications ↗</a>
            <div style={{ marginTop: 6, color: "var(--mist-mute)", fontSize: 12 }}>
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
          <li>Authorize once (opens browser):<pre style={codeBlock}>npm run auth:oura</pre></li>
          <li>Pull data anytime:<pre style={codeBlock}>npm run sync:oura</pre></li>
        </ol>
      ),
    },
    {
      key: "google",
      title: "Google Calendar",
      connected: googleOk,
      render: () => (
        <ol style={olStyle}>
          <li>
            Enable the Calendar API for your GCP project:{" "}
            <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener noreferrer" style={linkLamp}>calendar-json.googleapis.com ↗</a>
          </li>
          <li>Configure the OAuth consent screen (External, testing mode is fine) and add your own email under "Test users".</li>
          <li>
            Create an OAuth 2.0 Client ID (Web application):
            <div style={{ marginTop: 6, color: "var(--mist-mute)", fontSize: 12 }}>
              redirect URI: <code style={codeChip}>http://localhost:5174/google-callback</code><br />
              scopes: <code style={codeChip}>calendar.readonly</code>
            </div>
          </li>
          <li>
            Save the client credentials to <code style={codeChip}>~/.config/google/config.json</code>:
            <pre style={codeBlock}>{`{ "clientId": "...", "clientSecret": "...",
  "redirectUri": "http://localhost:5174/google-callback" }`}</pre>
            <div style={{ marginTop: 6, color: "var(--mist-mute)", fontSize: 12 }}>
              (or export <code style={codeChip}>GOOGLE_CAL_API_CLIENT_ID</code> / <code style={codeChip}>GOOGLE_CAL_API_CLIENT_SECRET</code> as env vars)
            </div>
          </li>
          <li>Authorize once (opens browser, writes tokens to <code style={codeChip}>~/.config/google/tokens.json</code>):<pre style={codeBlock}>npm run auth:google</pre></li>
          <li>Pull events anytime:<pre style={codeBlock}>npm run sync:google</pre></li>
        </ol>
      ),
    },
    {
      key: "coach",
      title: "Claude coach",
      connected: coachOk,
      render: () => (
        <ol style={olStyle}>
          <li>
            Make sure the Claude Code CLI is installed and logged in:
            <pre style={codeBlock}>claude --version</pre>
            <span style={{ fontSize: 12, color: "var(--mist-mute)" }}>
              Uses your existing Claude Code subscription via headless <code style={codeChip}>claude -p</code> — no API key needed.
            </span>
          </li>
          <li>
            From <code style={codeChip}>web/</code> run:
            <pre style={codeBlock}>npm run coach</pre>
            <span style={{ fontSize: 12, color: "var(--mist-mute)" }}>
              Computes deterministic facts → spawns <code style={codeChip}>claude -p</code> with Read access → writes <code style={codeChip}>web/public/coach.json</code>. The dashboard auto-loads it.
            </span>
          </li>
          <li>Or chain it after a sync:<pre style={codeBlock}>npm run sync:all && npm run coach</pre></li>
        </ol>
      ),
    },
  ];

  return (
    <footer style={{ marginTop: 40, borderTop: "1px solid var(--edge)", paddingTop: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <span className="eyebrow">connections · tokens stay local</span>
        <span className="eyebrow" style={{ fontSize: 8.5 }}>basecamp · set in bricolage grotesque + spline sans mono</span>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {items.map((it) => {
          const isOpen = open === it.key;
          return (
            <li
              key={it.key}
              ref={it.key === "oura" ? ouraRef : it.key === "google" ? googleRef : undefined}
              id={`setup-${it.key}`}
              style={{ borderBottom: "1px solid var(--edge)" }}
            >
              <button
                onClick={() => setOpen(isOpen ? null : it.key)}
                style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", textAlign: "left" }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span aria-hidden style={{
                    display: "inline-block", width: 12,
                    transform: isOpen ? "rotate(45deg)" : "rotate(0deg)", transition: "transform 200ms",
                    fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--lamp)",
                  }}>+</span>
                  <span className="display" style={{ fontSize: 16, fontWeight: 600 }}>{it.title}</span>
                  <span className="eyebrow" style={{ fontSize: 8.5, display: "inline-flex", alignItems: "center", gap: 6, color: it.connected ? "var(--pine)" : "var(--lamp)" }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: it.connected ? "var(--pine)" : "var(--lamp)", display: "inline-block" }} />
                    {it.connected ? "connected" : "set up"}
                  </span>
                </span>
                <span className="eyebrow" style={{ fontSize: 8.5 }}>{isOpen ? "hide" : "show"}</span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3, ease: [0.2, 0.7, 0.2, 1] }}
                    style={{ overflow: "hidden" }}
                  >
                    <div style={{ padding: "4px 0 24px 24px", maxWidth: 680 }}>{it.render()}</div>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "14px 0 0" }}>
        <span className="eyebrow" style={{ fontSize: 8.5 }}>© basecamp · mogollon bound · 2026</span>
        <span className="eyebrow" style={{ fontSize: 8.5 }}>strava · oura · google calendar · claude code</span>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/*  App shell                                                          */
/* ------------------------------------------------------------------ */

function AppBody() {
  const { key } = useRefresh();
  return (
    <>
      <CommandBar />
      <div className="shell">
        <div className="ops-grid">
          {/* main column */}
          <main style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
            <RaceRibbon />
            <div key={`vitals-${key}`}><VitalsBand /></div>
            <div key={`traj-${key}`}><Trajectory /></div>
            <div key={`road-${key}`}><RoadAhead /></div>
            <div key={`log-${key}`}><LogTable /></div>
            <SetupDrawer />
          </main>

          {/* the coach — persistent rail */}
          <AgentRail />
        </div>
      </div>
    </>
  );
}

export default function App() {
  return (
    <UnitsProvider>
      <RefreshProvider>
        <StateProvider>
          <StravaProvider>
            <OuraProvider>
              <AppBody />
            </OuraProvider>
          </StravaProvider>
        </StateProvider>
      </RefreshProvider>
    </UnitsProvider>
  );
}
