import { useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useUnits, useStrava, useBlockConfig, useMeasuredWidth } from "../data";
import { SectionTag, Contours } from "../atoms";
import { useCourse, useCrewBase } from "./useRaceData";
import { gmapsDirectionsUrl } from "./links";
import { CrewSheet } from "./CrewSheet";
import {
  fitPacing, projectRace, nightIntervals,
  fmtRaceClock, fmtElapsed,
  type StationProjection,
} from "./pacing";
import type { Course } from "./types";

/* ------------------------------------------------------------------ */
/*  Race planner — the course as it will actually unfold: real GPX     */
/*  profile, aid stations, night, cutoffs, and arrival windows         */
/*  projected from the athlete's own pacing fit.                       */
/* ------------------------------------------------------------------ */

function usePersistedStops(key: string) {
  const [v, setV] = useState<Record<string, number>>(() => {
    if (typeof localStorage === "undefined") return {};
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
  });
  const set = (name: string, min: number | null) => {
    setV((prev) => {
      const next = { ...prev };
      if (min == null || !Number.isFinite(min)) delete next[name];
      else next[name] = Math.max(0, min);
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  };
  const clear = () => {
    setV({});
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  };
  return [v, set, clear] as const;
}

function usePersistedNumber(key: string, initial: number) {
  const [v, setV] = useState<number>(() => {
    if (typeof localStorage === "undefined") return initial;
    const raw = localStorage.getItem(key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : initial;
  });
  const set = (n: number) => {
    setV(n);
    try { localStorage.setItem(key, String(n)); } catch { /* private mode */ }
  };
  return [v, set] as const;
}

function fmtDrive(min: number): string {
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

function marginColor(marginH: number | null): string {
  if (marginH == null) return "var(--mist-mute)";
  if (marginH < 0) return "var(--ember)";
  if (marginH < 2) return "var(--lamp)";
  return "var(--pine)";
}

function FlagChip({ label, color }: { label: string; color: string }) {
  return (
    <span className="eyebrow" style={{ fontSize: 8, color, border: `1px solid ${color}`, padding: "1px 4px", whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

function stationFlags(s: StationProjection["station"]) {
  const flags: { label: string; color: string }[] = [];
  if (s.crew || s.crew_only) flags.push({ label: "CREW", color: "var(--pine)" });
  if (s.drop_bag) flags.push({ label: "DROP", color: "var(--lamp)" });
  if (s.pacers) flags.push({ label: "PACER", color: "var(--creek)" });
  if (s.water_only) flags.push({ label: "H₂O", color: "var(--mist-mute)" });
  if (s.crew_only) flags.push({ label: "NO AID", color: "var(--mist-mute)" });
  return flags;
}

/* ---- profile chart ---- */

const H = 320;
const PAD = { top: 56, right: 16, bottom: 26, left: 46 };

function ProfileChart({ course, proj }: {
  course: Course;
  proj: ReturnType<typeof projectRace> | null;
}) {
  const u = useUnits();
  const { race } = useBlockConfig();
  const { ref: measureRef, width } = useMeasuredWidth();
  const [hoverMi, setHoverMi] = useState<number | null>(null);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;

  const profile = useMemo(() => {
    const p = course.profile;
    const step = Math.max(1, Math.ceil(p.length / 1200));
    return p.filter((_, i) => i % step === 0 || i === p.length - 1);
  }, [course.profile]);

  const [minEle, maxEle] = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const p of profile) { if (p.ele_ft < lo) lo = p.ele_ft; if (p.ele_ft > hi) hi = p.ele_ft; }
    const span = hi - lo || 1;
    return [lo - span * 0.06, hi + span * 0.1];
  }, [profile]);

  const maxMi = course.distance_mi;
  const xAt = useMemo(
    () => (mi: number) => PAD.left + (mi / maxMi) * plotW,
    [maxMi, plotW],
  );
  const yAt = useMemo(
    () => (ele: number) => PAD.top + (1 - (ele - minEle) / (maxEle - minEle)) * plotH,
    [minEle, maxEle, plotH],
  );

  // Near-O(1) nearest-point lookup: the profile is a near-uniform distance
  // grid, so index math jumps straight to the estimated bucket, then the two
  // while-loops walk to the true nearest neighbor — correcting for grid drift
  // and the off-grid final point the decimation always keeps (p[length-1]).
  const eleAt = useMemo(() => {
    const first = profile[0]?.mi ?? 0;
    const step = profile.length > 1 ? (profile[profile.length - 1].mi - first) / (profile.length - 1) : 1;
    return (mi: number) => {
      let i = Math.round((mi - first) / step);
      i = Math.max(0, Math.min(profile.length - 1, i));
      while (i > 0 && Math.abs(profile[i - 1].mi - mi) < Math.abs(profile[i].mi - mi)) i--;
      while (i < profile.length - 1 && Math.abs(profile[i + 1].mi - mi) < Math.abs(profile[i].mi - mi)) i++;
      return profile[i];
    };
  }, [profile]);

  // night bands, mapped from elapsed hours onto the mile axis via the projection
  const nights = useMemo(() => {
    if (!proj) return [];
    const startClock = `${String(race.date.getHours()).padStart(2, "0")}:${String(race.date.getMinutes()).padStart(2, "0")}`;
    const horizon = Math.max(38, proj.finish_h.worst);
    return nightIntervals(startClock, course.sun.sunset, course.sun.sunrise, horizon)
      .map(([s, e]) => [proj.mileAtElapsed(s), proj.mileAtElapsed(e)] as [number, number])
      .filter(([a, b]) => b - a > 0.2);
  }, [proj, course.sun, race.date]);

  const aidWithMi = useMemo(
    () => course.aid_stations
      .map((s, i) => ({ s, i, mi: s.gpx_mi })) // gpx_mi = measured axis space, same as maxMi
      .filter(({ mi }) => mi <= maxMi + 0.5),
    [course.aid_stations, maxMi],
  );

  /* The whole static scene is memoized: mousemove only re-renders the
     crosshair layer + tooltip, never the decimated path scene or aid markers. */
  const scene = useMemo(() => {
    if (width <= 0) return null;
    const linePath = profile.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(p.mi).toFixed(1)} ${yAt(p.ele_ft).toFixed(1)}`).join(" ");
    const areaPath = `${linePath} L ${xAt(maxMi).toFixed(1)} ${(PAD.top + plotH).toFixed(1)} L ${PAD.left} ${(PAD.top + plotH).toFixed(1)} Z`;
    return (
      <>
        {/* night bands */}
        {nights.map(([a, b], i) => (
          <g key={i}>
            <rect x={xAt(a)} y={PAD.top - 18} width={Math.max(0, xAt(b) - xAt(a))} height={plotH + 18} fill="var(--creek)" opacity={0.07} />
            <text x={(xAt(a) + xAt(b)) / 2} y={PAD.top - 6} textAnchor="middle" fill="var(--creek)" opacity={0.75}
              style={{ font: "8.5px var(--font-mono)", letterSpacing: "0.18em" }}>
              ☾ NIGHT
            </text>
          </g>
        ))}

        {/* elevation gridlines */}
        {[6000, 7000, 8000].filter((e) => e > minEle && e < maxEle).map((e) => (
          <g key={e}>
            <line x1={PAD.left} x2={width - PAD.right} y1={yAt(e)} y2={yAt(e)} stroke="var(--edge)" strokeWidth="1" strokeDasharray="2 5" />
            <text x={4} y={yAt(e) + 3} fill="var(--mist-mute)" style={{ font: "9px var(--font-mono)" }}>
              {u.elev(e)}
            </text>
          </g>
        ))}

        {/* profile */}
        <path d={areaPath} fill="url(#courseFill)" />
        <motion.path
          d={linePath} fill="none" stroke="var(--lamp)" strokeWidth="1.4" strokeLinejoin="round"
          initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.8, ease: [0.2, 0.8, 0.2, 1] }}
        />

        {/* aid stations */}
        {aidWithMi.map(({ s, i, mi }, idx) => {
          const p = eleAt(mi);
          const proj_i = proj?.stations[i] ?? null;
          const labelY = PAD.top + 6 + (idx % 3) * 11;
          return (
            <g key={s.name}>
              <line x1={xAt(p.mi)} x2={xAt(p.mi)} y1={labelY + 3} y2={yAt(p.ele_ft)} stroke="var(--edge-bright)" strokeWidth="1" strokeDasharray="1 3" />
              <circle cx={xAt(p.mi)} cy={yAt(p.ele_ft)} r="2.6"
                fill="var(--night)" strokeWidth="1.4"
                stroke={s.crew || s.crew_only ? "var(--pine)" : s.water_only ? "var(--creek)" : "var(--mist-dim)"} />
              <text x={xAt(p.mi) + 4} y={labelY} fill="var(--mist-dim)" style={{ font: "8.5px var(--font-mono)", letterSpacing: "0.06em" }}>
                {s.name.toLowerCase()}
              </text>
              {/* cutoff tick on the baseline */}
              {s.cutoff_h != null && (
                <rect
                  x={xAt(p.mi) - 3} y={PAD.top + plotH + 6} width={6} height={6}
                  transform={`rotate(45 ${xAt(p.mi)} ${PAD.top + plotH + 9})`}
                  fill={marginColor(proj_i?.cutoff_margin_h ?? null)}
                >
                  <title>
                    {s.name} cutoff {fmtRaceClock(race.date, s.cutoff_h)} ({fmtElapsed(s.cutoff_h)})
                    {proj_i?.cutoff_margin_h != null ? ` · margin ${fmtElapsed(Math.abs(proj_i.cutoff_margin_h))} ${proj_i.cutoff_margin_h >= 0 ? "ahead" : "SHORT"}` : ""}
                  </title>
                </rect>
              )}
            </g>
          );
        })}

        {/* mile axis */}
        {Array.from({ length: Math.floor(maxMi / 10) + 1 }, (_, i) => i * 10).map((mi) => (
          <text key={mi} x={xAt(mi)} y={H - 6} textAnchor="middle" fill="var(--mist-mute)" style={{ font: "9px var(--font-mono)" }}>
            {u.dist(mi, 0)}
          </text>
        ))}
      </>
    );
  }, [width, profile, xAt, yAt, maxMi, plotH, minEle, maxEle, nights, aidWithMi, eleAt, proj, u, race.date]);

  // rAF-coalesced hover: at most one state update per frame, snapped to the
  // profile grid so identical points bail out entirely
  const rafRef = useRef(0);
  const pendingMi = useRef<number | null>(null);
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const mi = ((x - PAD.left) / Math.max(1, plotW)) * maxMi;
    pendingMi.current = eleAt(Math.max(0, Math.min(maxMi, mi))).mi;
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        setHoverMi((prev) => (prev === pendingMi.current ? prev : pendingMi.current));
      });
    }
  };
  const onLeave = () => {
    pendingMi.current = null;
    setHoverMi(null);
  };

  const hover = hoverMi != null ? (() => {
    const p = eleAt(hoverMi);
    const next = aidWithMi.find(({ mi }) => mi > p.mi);
    return { p, next };
  })() : null;
  const tipOnLeft = hover != null && width > 0 && xAt(hover.p.mi) > width * 0.6;

  return (
    <div ref={measureRef} style={{ position: "relative" }} onMouseMove={onMove} onMouseLeave={onLeave}>
      {width > 0 && (
        // translateZ isolates the path scene in its own paint layer, so the
        // moving tooltip never forces it to re-rasterize
        <svg width={width} height={H} style={{ display: "block", transform: "translateZ(0)" }}>
          <defs>
            <linearGradient id="courseFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--lamp)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--lamp)" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {scene}
        </svg>
      )}

      {/* hover crosshair — composited divs OUTSIDE the svg, so mousemove
          never forces a repaint of the decimated path scene */}
      {hover && (
        <>
          <div style={{
            position: "absolute", left: 0, top: PAD.top - 18, width: 1, height: plotH + 18,
            background: "var(--mist-mute)", opacity: 0.5, pointerEvents: "none",
            transform: `translateX(${xAt(hover.p.mi)}px)`, willChange: "transform",
          }} />
          <div style={{
            position: "absolute", left: -3, top: -3, width: 6, height: 6, borderRadius: "50%",
            background: "var(--lamp)", pointerEvents: "none",
            transform: `translate(${xAt(hover.p.mi)}px, ${yAt(hover.p.ele_ft)}px)`, willChange: "transform",
          }} />
        </>
      )}

      {/* hover tooltip — fixed width, transform-positioned: composite-only moves */}
      {hover && proj && (
        <div style={{
          position: "absolute", top: 46, left: 0, width: 210,
          transform: `translateX(${tipOnLeft
            ? Math.max(0, xAt(hover.p.mi) - 210 - 12)
            : Math.min(Math.max(0, xAt(hover.p.mi) + 12), Math.max(0, width - 210))}px)`,
          willChange: "transform",
          background: "var(--night-deep)", border: "1px solid var(--edge-bright)", padding: "10px 12px",
          pointerEvents: "none", zIndex: 5,
        }}>
          <div className="numerals" style={{ fontSize: 12, fontWeight: 600 }}>
            {u.dist(hover.p.mi)} {u.distUnit} · {u.elev(hover.p.ele_ft)} {u.elevUnit}
          </div>
          <div className="numerals" style={{ fontSize: 10, color: "var(--mist-mute)", marginTop: 3 }}>
            grade {hover.p.grade_pct > 0 ? "+" : ""}{hover.p.grade_pct.toFixed(1)}%
            {hover.next ? ` · next aid ${hover.next.s.name.toLowerCase()} in ${u.dist(Math.max(0, hover.next.mi - hover.p.mi))} ${u.distUnit}` : ""}
          </div>
          <div className="numerals" style={{ fontSize: 10, marginTop: 5, display: "grid", gridTemplateColumns: "auto auto", gap: "2px 10px" }}>
            <span style={{ color: "var(--pine)" }}>best</span><span>{fmtRaceClock(race.date, proj.elapsedAtMile(hover.p.mi, "best"))}</span>
            <span style={{ color: "var(--lamp)" }}>avg</span><span>{fmtRaceClock(race.date, proj.elapsedAtMile(hover.p.mi, "avg"))}</span>
            <span style={{ color: "var(--ember)" }}>worst</span><span>{fmtRaceClock(race.date, proj.elapsedAtMile(hover.p.mi, "worst"))}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- the view ---- */

export function RacePlanner() {
  const u = useUnits();
  const { race } = useBlockConfig();
  const { activities } = useStrava();
  const { course, missing, error } = useCourse();
  const { crewBase } = useCrewBase();
  const [fatigue, setFatigue] = usePersistedNumber("race.fatigue_pct_v2", 5);
  // training runs are stronger efforts than race-sustainable pace — slow every
  // projected pace by this much (athlete-requested honesty correction)
  const [calibration, setCalibration] = usePersistedNumber("race.calibration_pct", 6);
  // deliberate hold-back through mile 50 (taper to 60); restrained miles also
  // age the fatigue clock less — bank energy for the second 50
  const [restraint, setRestraint] = usePersistedNumber("race.restraint_pct", 8);
  const [goalH, setGoalH] = usePersistedNumber("race.goal_h", 32);
  const [aidStopMin, setAidStopMin] = usePersistedNumber("race.aid_stop_min", 5);
  const [crewStopMin, setCrewStopMin] = usePersistedNumber("race.crew_stop_min", 10);
  const [stopOverrides, setStopOverride, clearStopOverrides] = usePersistedStops("race.stop_overrides");
  const [sheetOpen, setSheetOpen] = useState(false);

  const fit = useMemo(() => fitPacing(activities), [activities]);
  const proj = useMemo(
    () => (course && fit ? projectRace(course, fit, {
      // a cleared/zeroed goal field (Number("")=0) means "no goal" — coerce to
      // null so the header ("—") and the table agree instead of collapsing ETAs
      fatiguePctPer10mi: fatigue, calibrationPct: calibration, restraintPct: restraint,
      goalH: goalH > 0 ? goalH : null, aidStopMin, crewStopMin, stopOverridesMin: stopOverrides,
    }) : null),
    [course, fit, fatigue, calibration, restraint, goalH, aidStopMin, crewStopMin, stopOverrides],
  );

  if (missing || !course) {
    return (
      <section>
        <SectionTag>race planner</SectionTag>
        <div className="panel notch" style={{ padding: "28px 26px" }}>
          <span className="eyebrow" style={{ color: missing || error ? "var(--ember)" : "var(--mist-mute)" }}>
            {missing
              ? "no course data — run `npm run course:build` to parse the race gpx"
              : error
              ? error
              : "loading course…"}
          </span>
        </div>
      </section>
    );
  }

  const stats: { label: string; value: string; color?: string }[] = proj ? [
    { label: "best case", value: fmtRaceClock(race.date, proj.finish_h.best), color: "var(--pine)" },
    { label: "expected", value: fmtRaceClock(race.date, proj.finish_h.avg), color: "var(--lamp)" },
    { label: "worst case", value: fmtRaceClock(race.date, proj.finish_h.worst), color: "var(--ember)" },
    { label: "expected elapsed", value: fmtElapsed(proj.finish_h.avg) },
    { label: "time stopped", value: fmtElapsed(proj.stopped_h) },
    { label: "goal", value: goalH > 0 ? `${fmtElapsed(goalH)} → ${fmtRaceClock(race.date, goalH)}` : "—", color: "var(--creek)" },
  ] : [];

  const numInput = (value: number, set: (n: number) => void, min: number, max: number, w = 44) => (
    <input
      type="number" min={min} max={max} step={1} value={value}
      onChange={(e) => set(Number(e.target.value))}
      className="numerals"
      style={{
        width: w, background: "var(--night-deep)", border: "1px solid var(--edge-bright)",
        color: "var(--mist)", fontSize: 11, padding: "3px 6px",
      }}
    />
  );

  return (
    <section>
      <SectionTag
        right={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <label className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              title="race-pace calibration — training runs are stronger efforts than race-sustainable pace, so every projected pace is slowed by this much">
              race-cal +{calibration.toFixed(1)}%
              <input
                type="range" min={0} max={12} step={0.5} value={calibration}
                onChange={(e) => setCalibration(Number(e.target.value))}
                style={{ width: 70, accentColor: "var(--lamp)" }}
              />
            </label>
            <label className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              title="deliberate first-half hold-back — this much slower than model pace through mile 50 (tapering off by 60); restrained miles also age the fatigue clock less, flattening the late-race fade">
              hold-back +{restraint.toFixed(1)}%
              <input
                type="range" min={0} max={15} step={0.5} value={restraint}
                onChange={(e) => setRestraint(Number(e.target.value))}
                style={{ width: 70, accentColor: "var(--lamp)" }}
              />
            </label>
            <label className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              fatigue +{fatigue.toFixed(1)}%/10{u.distUnit}
              <input
                type="range" min={0} max={10} step={0.5} value={fatigue}
                onChange={(e) => setFatigue(Number(e.target.value))}
                style={{ width: 70, accentColor: "var(--lamp)" }}
              />
            </label>
            <label className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              title="fresh stop minutes at a regular aid station / at crew+drop-bag stations — stops stretch late-race with fatigue">
              stops {numInput(aidStopMin, setAidStopMin, 0, 30)}/{numInput(crewStopMin, setCrewStopMin, 0, 45)}m
            </label>
            <label className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              goal
              <input
                type="number" min={20} max={38} step={0.5} value={goalH}
                onChange={(e) => setGoalH(Number(e.target.value))}
                className="numerals"
                style={{
                  width: 52, background: "var(--night-deep)", border: "1px solid var(--edge-bright)",
                  color: "var(--mist)", fontSize: 11, padding: "3px 6px",
                }}
              />
              h
            </label>
          </span>
        }
      >
        race planner — {race.short} · {u.dist(course.distance_mi, 0)} {u.distUnit} · {u.elev(course.gain_ft)} {u.elevUnit}↑
      </SectionTag>

      <div className="panel notch" style={{ overflow: "hidden" }}>
        <Contours seed={7} opacity={0.07} />

        {proj && (
          <div style={{ position: "relative", display: "flex", flexWrap: "wrap", borderBottom: "1px solid var(--edge)" }}>
            {stats.map((s, i) => (
              <div key={s.label} style={{ padding: "12px 20px", borderLeft: i > 0 ? "1px solid var(--edge)" : "none", flex: "1 1 auto" }}>
                <div className="eyebrow" style={{ fontSize: 8, letterSpacing: "0.22em" }}>{s.label}</div>
                <div className="numerals" style={{ fontSize: 15, fontWeight: 600, color: s.color ?? "var(--mist)", marginTop: 2 }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ position: "relative", padding: "4px 0 0" }}>
          <ProfileChart course={course} proj={proj} />
        </div>

        {!fit && (
          <div style={{ padding: "10px 20px", borderTop: "1px solid var(--edge)" }}>
            <span className="eyebrow" style={{ color: "var(--lamp)" }}>
              pacing model needs ≥8 runs ≥2{u.distUnit} in strava — arrival projections hidden until then
            </span>
          </div>
        )}
      </div>

      {/* station table */}
      {proj && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="race-grid" style={{ padding: "10px 18px", borderBottom: "1px solid var(--edge-bright)" }}>
            <span className="eyebrow" style={{ fontSize: 8.5 }}>station</span>
            <span className="eyebrow" style={{ fontSize: 8.5, textAlign: "right" }}>{u.distUnit}</span>
            <span className="eyebrow col-seg" style={{ fontSize: 8.5, textAlign: "right" }}>{u.elevUnit}↑ seg</span>
            <span className="eyebrow col-stop" style={{ fontSize: 8.5, textAlign: "right" }}>stop min</span>
            <span className="eyebrow" style={{ fontSize: 8.5, display: "grid", gridTemplateColumns: "1fr 1fr 1.15fr", gap: 8 }}>
              <span style={{ textAlign: "right", color: "var(--pine)" }}>best</span>
              <span style={{ textAlign: "right" }}>eta</span>
              <span style={{ textAlign: "right", color: "var(--ember)" }}>worst</span>
            </span>
            <span className="eyebrow col-goal" style={{ fontSize: 8.5, textAlign: "right" }}>goal</span>
            <span className="eyebrow" style={{ fontSize: 8.5, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <span style={{ textAlign: "right" }}>cutoff</span>
              <span>margin</span>
            </span>
            <span className="eyebrow col-flags" style={{ fontSize: 8.5 }}>access</span>
          </div>
          {proj.stations.map((sp, i) => {
            const s = sp.station;
            const missedWorst = sp.cutoff_margin_worst_h != null && sp.cutoff_margin_worst_h < 0;
            return (
              <div
                key={s.name}
                className="race-grid"
                style={{
                  padding: "10px 18px",
                  borderTop: i > 0 ? "1px solid var(--edge)" : "none",
                  borderLeft: missedWorst ? "2px solid var(--ember)" : "2px solid transparent",
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.background = "var(--panel-raise)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.background = "transparent")}
              >
                <div style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, display: "block" }}>{s.name}</span>
                  {s.notes && <span className="numerals" style={{ fontSize: 9, color: "var(--mist-mute)" }}>{s.notes}</span>}
                </div>
                <span className="numerals" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>{u.dist(s.total_mi)}</span>
                <span className="numerals col-seg" style={{ fontSize: 11.5, color: "var(--mist-dim)", textAlign: "right" }}>
                  {sp.seg_gain_ft > 0 ? `+${u.elev(sp.seg_gain_ft)}` : "—"}
                </span>
                <span className="col-stop" style={{ textAlign: "right" }}>
                  {i < proj.stations.length - 1 ? (
                    <input
                      type="number" min={0} max={120} step={1}
                      value={sp.stop_min}
                      title={stopOverrides[s.name] != null
                        ? "custom stop — clear the field to restore the default"
                        : "default stop (scales with fatigue) — edit to set your own"}
                      onChange={(e) => setStopOverride(s.name, e.target.value === "" ? null : Number(e.target.value))}
                      className="numerals"
                      style={{
                        width: 42, textAlign: "right", fontSize: 11, padding: "3px 5px",
                        background: "var(--night-deep)",
                        border: `1px solid ${stopOverrides[s.name] != null ? "var(--lamp)" : "var(--edge-bright)"}`,
                        color: stopOverrides[s.name] != null ? "var(--lamp)" : "var(--mist)",
                      }}
                    />
                  ) : (
                    <span className="numerals" style={{ fontSize: 11.5, color: "var(--mist-mute)" }}>—</span>
                  )}
                </span>
                <span className="numerals" style={{ fontSize: 11.5, display: "grid", gridTemplateColumns: "1fr 1fr 1.15fr", gap: 8, whiteSpace: "nowrap" }}>
                  <span style={{ color: "var(--pine)", textAlign: "right" }}>{fmtRaceClock(race.date, sp.eta_h.best)}</span>
                  <span style={{ fontWeight: 700, textAlign: "right" }}>{fmtRaceClock(race.date, sp.eta_h.avg)}</span>
                  <span style={{ color: "var(--ember)", textAlign: "right" }}>{fmtRaceClock(race.date, sp.eta_h.worst)}</span>
                </span>
                <span className="numerals col-goal" style={{ fontSize: 11.5, color: "var(--creek)", textAlign: "right" }}>
                  {sp.goal_eta_h != null ? fmtRaceClock(race.date, sp.goal_eta_h) : "—"}
                </span>
                <span className="numerals" style={{ fontSize: 11.5, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, whiteSpace: "nowrap" }}>
                  <span style={{ textAlign: "right" }}>
                    {s.cutoff_h != null ? fmtRaceClock(race.date, s.cutoff_h) : <span style={{ color: "var(--mist-mute)" }}>—</span>}
                  </span>
                  <span style={{ color: marginColor(sp.cutoff_margin_h) }}>
                    {sp.cutoff_margin_h != null
                      ? `${sp.cutoff_margin_h >= 0 ? "+" : "−"}${fmtElapsed(Math.abs(sp.cutoff_margin_h))}`
                      : ""}
                  </span>
                </span>
                <span className="col-flags" style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
                  <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                    {stationFlags(s).map((f) => <FlagChip key={f.label} label={f.label} color={f.color} />)}
                  </span>
                  {crewBase?.drives[s.name] && (
                    s.lat != null && s.lon != null ? (
                      <a
                        className="numerals"
                        href={gmapsDirectionsUrl(crewBase.base.address, s.lat, s.lon)}
                        target="_blank" rel="noopener noreferrer"
                        title={`google maps directions from ${crewBase.base.address} · ${u.dist(crewBase.drives[s.name].mi, 0)} ${u.distUnit} (OSRM estimate)`}
                        style={{ fontSize: 9, color: "var(--creek)", textDecoration: "none", borderBottom: "1px dotted var(--creek)" }}
                      >
                        ⌂ drive {fmtDrive(crewBase.drives[s.name].min)} ↗
                      </a>
                    ) : (
                      <span className="numerals" style={{ fontSize: 9, color: "var(--creek)" }}>
                        ⌂ drive {fmtDrive(crewBase.drives[s.name].min)}
                      </span>
                    )
                  )}
                </span>
              </div>
            );
          })}
          {/* totals: elapsed-at-finish per scenario, aligned under the ETA columns */}
          <div className="race-grid" style={{ padding: "11px 18px", borderTop: "1px solid var(--edge-bright)" }}>
            <span className="eyebrow" style={{ fontSize: 8.5 }}>total elapsed at finish</span>
            <span />
            <span className="col-seg" />
            <span className="col-stop" />
            <span className="numerals" style={{ fontSize: 12, fontWeight: 600, display: "grid", gridTemplateColumns: "1fr 1fr 1.15fr", gap: 8, whiteSpace: "nowrap" }}>
              <span style={{ color: "var(--pine)", textAlign: "right" }}>{fmtElapsed(proj.finish_h.best)}</span>
              <span style={{ textAlign: "right" }}>{fmtElapsed(proj.finish_h.avg)}</span>
              <span style={{ color: "var(--ember)", textAlign: "right" }}>{fmtElapsed(proj.finish_h.worst)}</span>
            </span>
            <span className="numerals col-goal" style={{ fontSize: 12, fontWeight: 600, color: "var(--creek)", textAlign: "right" }}>
              {proj.goal_h != null ? fmtElapsed(proj.goal_h) : "—"}
            </span>
            <span className="numerals" style={{ fontSize: 11.5, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, whiteSpace: "nowrap" }}>
              {(() => {
                const fin = proj.stations[proj.stations.length - 1];
                return fin?.station.cutoff_h != null ? (
                  <>
                    <span style={{ textAlign: "right" }}>{fmtElapsed(fin.station.cutoff_h)}</span>
                    <span style={{ color: marginColor(fin.cutoff_margin_h) }}>
                      {fin.cutoff_margin_h != null
                        ? `${fin.cutoff_margin_h >= 0 ? "+" : "−"}${fmtElapsed(Math.abs(fin.cutoff_margin_h))}`
                        : ""}
                    </span>
                  </>
                ) : <span />;
              })()}
            </span>
            <span className="col-flags" />
          </div>

          {/* totals row — one line, left-aligned */}
          <div style={{ padding: "11px 18px", borderTop: "1px solid var(--edge)", display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span className="eyebrow" style={{ fontSize: 8.5 }}>total planned aid-station time</span>
            <span className="numerals" style={{ fontSize: 13.5, fontWeight: 700, color: "var(--lamp)" }}>
              {fmtElapsed(proj.stopped_h)}
            </span>
            <span className="numerals" style={{ fontSize: 10, color: "var(--mist-mute)" }}>
              ≈ {Math.round((proj.stopped_h / proj.finish_h.avg) * 100)}% of expected race time
            </span>
          </div>

          {/* footer meta — labeled lines left, actions right */}
          <div style={{ padding: "12px 18px", borderTop: "1px solid var(--edge)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
            <div style={{ display: "grid", gridTemplateColumns: "44px minmax(0, 1fr)", gap: "6px 12px", alignItems: "baseline", flex: "1 1 460px" }}>
              {fit && (
                <>
                  <span className="eyebrow" style={{ fontSize: 8, color: "var(--mist-mute)" }}>model</span>
                  <span className="eyebrow" style={{ fontSize: 8.5, lineHeight: 1.9 }}>
                    fit: {fit.basis} (eff. n={fit.effN}) · ±{u.paceFmt(fit.residStd, 1)}{u.paceUnit} band · race-cal +{calibration}% all paces · restraint +{restraint}% thru mi 50 (fades by 60, restrained miles age ×{(1 - 2 * restraint / 100).toFixed(2)} on the fatigue clock) · fatigue ×{(1 + fatigue / 100).toFixed(2)}/10{u.distUnit} compounding · stops {aidStopMin}/{crewStopMin}m fresh
                  </span>
                </>
              )}
              {crewBase && (
                <>
                  <span className="eyebrow" style={{ fontSize: 8, color: "var(--mist-mute)" }}>base</span>
                  <span className="eyebrow" style={{ fontSize: 8.5, lineHeight: 1.9, color: "var(--creek)" }}>
                    ⌂ {crewBase.base.address}
                    {crewBase.base.drive_to_start_min != null && (
                      <>
                        {" · "}
                        {course.map_track?.length ? (
                          <a
                            href={gmapsDirectionsUrl(crewBase.base.address, course.map_track[0][0], course.map_track[0][1])}
                            target="_blank" rel="noopener noreferrer"
                            title="google maps directions to the start (Two-Sixty TH)"
                            style={{ color: "var(--creek)", textDecoration: "none", borderBottom: "1px dotted var(--creek)", whiteSpace: "nowrap" }}
                          >
                            drive to start {fmtDrive(crewBase.base.drive_to_start_min)} ↗
                          </a>
                        ) : (
                          <span style={{ whiteSpace: "nowrap" }}>drive to start {fmtDrive(crewBase.base.drive_to_start_min)}</span>
                        )}
                      </>
                    )}
                  </span>
                </>
              )}
              <span className="eyebrow" style={{ fontSize: 8, color: "var(--mist-mute)" }}>race</span>
              <span className="eyebrow" style={{ fontSize: 8.5, lineHeight: 1.9 }}>
                cutoffs from 2025 manual · start {fmtRaceClock(race.date, 0)} · sunset {course.sun.sunset} · sunrise {course.sun.sunrise}
              </span>
            </div>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              {Object.keys(stopOverrides).length > 0 && (
                <button className="chip" style={{ fontSize: 8 }} onClick={clearStopOverrides}>
                  reset {Object.keys(stopOverrides).length} custom stop{Object.keys(stopOverrides).length > 1 ? "s" : ""}
                </button>
              )}
              <button
                className="chip"
                style={{ borderColor: "var(--lamp)", color: "var(--lamp)", whiteSpace: "nowrap" }}
                onClick={() => setSheetOpen(true)}
              >
                ⎙ crew sheet pdf
              </button>
            </span>
          </div>
        </div>
      )}

      {sheetOpen && proj && (
        <CrewSheet course={course} proj={proj} crewBase={crewBase} onClose={() => setSheetOpen(false)} />
      )}
    </section>
  );
}
