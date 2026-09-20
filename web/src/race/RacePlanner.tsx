import { useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useUnits, useMeasuredWidth, useRefresh, relativeAgo } from "../data";
import { SectionTag, Contours } from "../atoms";
import { useCrewBase, useRaceResult } from "./useRaceData";
import { useRacePlan } from "./useRacePlan";
import { gmapsDirectionsUrl } from "./links";
import { CrewSheet } from "./CrewSheet";
import { CrewExportButton } from "../crew/ExportButton";
import { RunnerCard } from "./RunnerCard";
import { FuelCard } from "./FuelCard";
import { DropBagCard } from "./DropBagCard";
import { fmtCarry } from "./nutrition";
import { useRunCourseAgain } from "./runCourseAgain";
import { courseHasCutoffs, cutoffSourceLabel } from "./cutoffSource";
import { isTuneUp, type VisibleColumns } from "./features";
import {
  projectRace, nightIntervals,
  fmtElapsed, raceClockHM,
  restraintWindowMi, raceDistanceMi, RESTRAINT_FATIGUE_PAYOFF,
  type StationProjection,
} from "./pacing";
import { ALTITUDE_THRESHOLD_FT } from "./altitude";
import type { Course } from "./types";

/** m:ss from seconds — rounds to whole seconds FIRST (independent
    floor/round renders "9:60"). */
const fmtPaceS = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t - Math.floor(t / 60) * 60).padStart(2, "0")}`;
};

/* ------------------------------------------------------------------ */
/*  Race planner — the course as it will actually unfold: real GPX     */
/*  profile, aid stations, night, cutoffs, and arrival windows         */
/*  projected from the athlete's own pacing fit.                       */
/* ------------------------------------------------------------------ */

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

/* A station row carries the flags this RACE has, not the ones its chart
   row happens to set: an aid chart copied from a crewed edition can leave
   `crew: true` on a year that forbids crew, and a CREW chip nobody may use
   is worse than no chip. H₂O and NO AID are unconditional — they describe
   the station itself, not an optional feature. */
function stationFlags(s: StationProjection["station"], cols: VisibleColumns) {
  const flags: { label: string; color: string }[] = [];
  if (cols.crew && (s.crew || s.crew_only)) flags.push({ label: "CREW", color: "var(--pine)" });
  if (cols.drop_bag && s.drop_bag) flags.push({ label: "DROP", color: "var(--lamp)" });
  if (cols.pacers && s.pacers) flags.push({ label: "PACER", color: "var(--creek)" });
  if (s.water_only) flags.push({ label: "H₂O", color: "var(--mist-mute)" });
  if (s.crew_only) flags.push({ label: "NO AID", color: "var(--mist-mute)" });
  return flags;
}

/* ---- profile chart ---- */

const H = 320;
const PAD = { top: 56, right: 16, bottom: 26, left: 46 };
/* pace trace strip below the profile — same x-axis, own y-scale
   (faster at the top, Strava-style; slower dips down) */
const PACE_TOP = H + 6;
const PACE_H = 56;
const TOTAL_H = PACE_TOP + PACE_H + 22;

function ProfileChart({ course, proj, night }: {
  course: Course;
  proj: ReturnType<typeof projectRace> | null;
  /** features.night — a race that finishes in daylight gets no bands */
  night: boolean;
}) {
  const u = useUnits();
  const { race, sun } = useRacePlan();
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

  // night bands, mapped from elapsed hours onto the mile axis via the projection.
  // nightIntervals is null-safe on sunset/sunrise (a draft's course built
  // before its date was known has neither) — []'d out here too, before the
  // mileAtElapsed mapping, since sun-unknown just means no bands to draw.
  const nights = useMemo(() => {
    if (!proj || !night || !sun) return [];
    // sunset/sunrise are race-local wall clocks, so the start has to be one too
    const horizon = Math.max(38, proj.finish_h.worst);
    return nightIntervals(raceClockHM(race.date, race.timeZone), sun.sunset, sun.sunrise, horizon)
      .map(([s, e]) => [proj.mileAtElapsed(s), proj.mileAtElapsed(e)] as [number, number])
      .filter(([a, b]) => b - a > 0.2);
  }, [proj, night, sun, race.date, race.timeZone]);

  const aidWithMi = useMemo(
    () => course.aid_stations
      .map((s, i) => ({ s, i, mi: s.gpx_mi })) // gpx_mi = measured axis space, same as maxMi
      .filter(({ mi }) => mi <= maxMi + 0.5),
    [course.aid_stations, maxMi],
  );

  /* pace trace: per-split projected pace as a step line, x in gpx miles so
     the steps land exactly on the plotted aid-station markers */
  const paceSegs = useMemo(() => {
    if (!proj) return [];
    const perUnit = u.paceUnit === "/km" ? 1 / 1.609344 : 1; // display units
    return course.aid_stations
      .map((s, i) => ({
        x0: i === 0 ? 0 : course.aid_stations[i - 1].gpx_mi,
        x1: s.gpx_mi,
        pace: proj.stations[i].seg_pace_s_per_mi * perUnit,
        goal: proj.stations[i].goal_pace_s_per_mi != null ? proj.stations[i].goal_pace_s_per_mi! * perUnit : null,
      }))
      .filter((g) => g.x1 > g.x0 + 0.05 && g.pace > 0);
  }, [proj, course.aid_stations, u.paceUnit]);

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
                    {s.name} cutoff {race.clock(s.cutoff_h)} ({fmtElapsed(s.cutoff_h)})
                    {proj_i?.cutoff_margin_h != null ? ` · margin ${fmtElapsed(Math.abs(proj_i.cutoff_margin_h))} ${proj_i.cutoff_margin_h >= 0 ? "ahead" : "SHORT"}` : ""}
                  </title>
                </rect>
              )}
            </g>
          );
        })}

        {/* pace strip — continuous grade-adjusted pace plus split averages
            (and goal) on the same mile axis */}
        {paceSegs.length > 0 && proj && (() => {
          const perUnit = u.paceUnit === "/km" ? 1 / 1.609344 : 1;
          // continuous point pace over the decimated profile, smoothed over
          // ~0.4 mi so the strip reads as terrain response, not GPS noise
          const raw = profile.map((p) => proj.paceAtMile(p.mi) * perUnit);
          const cont = raw.map((_, i) => {
            let s = 0, n = 0;
            for (let j = Math.max(0, i - 4); j <= Math.min(raw.length - 1, i + 4); j++) { s += raw[j]; n++; }
            return s / n;
          });
          // display range: clamp the slow end at the 95th percentile — the
          // savage pitches flat-line at the bottom instead of stretching the
          // whole axis (their true cost still shows in tooltip + splits)
          const sorted = [...cont].sort((a, b) => a - b);
          const p95 = sorted[Math.floor(sorted.length * 0.95)];
          const segVals = paceSegs.flatMap((g) => (g.goal != null ? [g.pace, g.goal] : [g.pace]));
          const lo = Math.min(sorted[0], ...segVals);
          const hi = Math.max(p95, ...segVals);
          const span = Math.max(hi - lo, 30);
          const [pLo, pHi] = [lo - span * 0.1, hi + span * 0.1];
          // faster (smaller) at the top
          const yPace = (p: number) => PACE_TOP + ((Math.min(p, pHi) - pLo) / (pHi - pLo)) * PACE_H;
          const contPath = profile
            .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(p.mi).toFixed(1)} ${yPace(cont[i]).toFixed(1)}`)
            .join(" ");
          const stepPath = (key: "pace" | "goal") =>
            paceSegs
              .filter((g) => g[key] != null)
              .map((g, i) => `${i === 0 ? "M" : "L"} ${xAt(g.x0).toFixed(1)} ${yPace(g[key]!).toFixed(1)} L ${xAt(g.x1).toFixed(1)} ${yPace(g[key]!).toFixed(1)}`)
              .join(" ");
          // ~3 gridlines, stepped to a round pace interval
          const NICE_STEPS = [60, 120, 300, 600, 1200];
          const stepS = NICE_STEPS.find((s) => span / s <= 3.2) ?? 1200;
          const ticks: number[] = [];
          for (let t = Math.ceil(pLo / stepS) * stepS; t <= pHi; t += stepS) ticks.push(t);
          const fmtPace = fmtPaceS;
          const hasGoal = paceSegs.some((g) => g.goal != null);
          return (
            <g>
              <text x={PAD.left} y={PACE_TOP - 2} fill="var(--mist-mute)" style={{ font: "8.5px var(--font-mono)", letterSpacing: "0.14em" }}>
                PACE {u.paceUnit.toUpperCase()}
                <tspan fill="var(--lamp)"> ── POINT</tspan>
                <tspan fill="var(--mist-dim)"> ─ SPLIT AVG</tspan>
                {hasGoal && <tspan fill="var(--creek)"> ┄ GOAL</tspan>}
              </text>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={PAD.left} x2={width - PAD.right} y1={yPace(t)} y2={yPace(t)} stroke="var(--edge)" strokeWidth="1" strokeDasharray="2 5" />
                  <text x={4} y={yPace(t) + 3} fill="var(--mist-mute)" style={{ font: "8.5px var(--font-mono)" }}>
                    {fmtPace(t)}
                  </text>
                </g>
              ))}
              {hasGoal && (
                <path d={stepPath("goal")} fill="none" stroke="var(--creek)" strokeWidth="1.2" strokeDasharray="3 4" strokeLinejoin="round" opacity={0.85} />
              )}
              <path d={stepPath("pace")} fill="none" stroke="var(--mist-dim)" strokeWidth="1.1" strokeLinejoin="round" opacity={0.9} />
              <path d={contPath} fill="none" stroke="var(--lamp)" strokeWidth="1.3" strokeLinejoin="round" opacity={0.95} />
            </g>
          );
        })()}

        {/* mile axis */}
        {Array.from({ length: Math.floor(maxMi / 10) + 1 }, (_, i) => i * 10).map((mi) => (
          <text key={mi} x={xAt(mi)} y={TOTAL_H - 6} textAnchor="middle" fill="var(--mist-mute)" style={{ font: "9px var(--font-mono)" }}>
            {u.dist(mi, 0)}
          </text>
        ))}
      </>
    );
  }, [width, profile, xAt, yAt, maxMi, plotH, minEle, maxEle, nights, aidWithMi, eleAt, proj, u, race, paceSegs]);

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
        <svg width={width} height={TOTAL_H} style={{ display: "block", transform: "translateZ(0)" }}>
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
            <span style={{ color: "var(--pine)" }}>best</span><span>{race.clock(proj.elapsedAtMile(hover.p.mi, "best"))}</span>
            <span style={{ color: "var(--lamp)" }}>avg</span><span>{race.clock(proj.elapsedAtMile(hover.p.mi, "avg"))}</span>
            <span style={{ color: "var(--ember)" }}>worst</span><span>{race.clock(proj.elapsedAtMile(hover.p.mi, "worst"))}</span>
            {(() => {
              const seg = paceSegs.find((g) => hover.p.mi >= g.x0 && hover.p.mi <= g.x1);
              const perUnit = u.paceUnit === "/km" ? 1 / 1.609344 : 1;
              const point = proj.paceAtMile(hover.p.mi) * perUnit;
              const fmt = fmtPaceS;
              return (
                <>
                  <span style={{ color: "var(--mist-dim)" }}>pace here</span>
                  <span>{point > 0 ? `${fmt(point)}${u.paceUnit}` : "—"}</span>
                  {seg && (
                    <>
                      <span style={{ color: "var(--mist-dim)" }}>split avg</span>
                      <span>
                        {fmt(seg.pace)}{u.paceUnit}
                        {seg.goal != null && <span style={{ color: "var(--creek)" }}> · goal {fmt(seg.goal)}</span>}
                      </span>
                    </>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---- the view ---- */

export function RacePlanner() {
  const u = useUnits();
  const { race } = useRacePlan();
  const { crewBase } = useCrewBase();
  // projection + fuel wiring is shared with the nutrition view — see
  // useRacePlan.ts. Both views must agree to the minute, so there is exactly
  // one projectRace/planFuel call and one set of persisted sliders.
  const { course, missing, error, fit, proj, nutrition, fuelPlan, settings, set,
    paceGrade, paceGradeError, nutritionError, nutritionSource, physiologyError, features, panels, columns,
    raceConfig, sun, acclimation } = useRacePlan();
  const { reload } = useRefresh();
  // D8: "no course data" used to just tell the athlete to run a shell
  // command — the empty state now offers the same free, deterministic
  // build the switcher's "Run course again…" row and the fuel view's own
  // empty state (NutritionPlan.tsx) call.
  const courseBuild = useRunCourseAgain(missing ? raceConfig.slug : null, reload);
  // An archived race has a result: what actually happened, station by station
  // (PRD §10). Only then does the table grow an "actual" column — a race that
  // has not been run has nothing to put in it.
  const { result } = useRaceResult(raceConfig?.status === "archived" ? raceConfig.slug : null);
  const actualByStation = useMemo(() => {
    const m = new Map<string, { h: number; source: string }>();
    for (const sp of result?.splits ?? []) {
      if (sp.elapsed_h != null) m.set(sp.station, { h: sp.elapsed_h, source: sp.source });
    }
    return m;
  }, [result]);
  const hasActual = actualByStation.size > 0;

  /* The reduced planner (PRD-v2 §3). A tune-up's crew sheet, drop-bag card
     and caffeine schedule are already gone — features.ts defaults them off
     for kind "b" — and the fuel PLAN is the last piece that would otherwise
     be furniture: the quick form writes no nutrition.json, so every gram in
     the fuel column would come from the impersonal defaults (nutrition.ts's
     DEFAULT_NUTRITION), for a race short enough that the honest answer is
     "carry what you like". The column goes with it, rather than standing
     there empty. Write a nutrition.json into the folder and the column —
     and the fuel view's own chip, which App.tsx gates on the same two facts
     — comes straight back. An A race is untouched: defaults with a warning
     beat no fuel plan on a hundred. */
  const tuneUp = isTuneUp(raceConfig);
  const showFuel = !tuneUp || nutritionSource !== "default";

  const gridClass = "race-grid" + (hasActual ? " has-actual" : "") + (showFuel ? "" : " no-fuel");
  const { fatigue, calibration, restraint, goalH, altitude, acclimationOverride,
    aidStopMin, crewStopMin, stopOverrides } = settings;
  const { fatigue: setFatigue, calibration: setCalibration, restraint: setRestraint,
    goalH: setGoalH, altitude: setAltitude, acclimationOverride: setAcclimationOverride,
    aidStopMin: setAidStopMin, crewStopMin: setCrewStopMin,
    stopOverride: setStopOverride, clearStopOverrides } = set;
  // Where the acclimation day count came from, in the fewest words that can
  // still be argued with. The distinction matters: "4 days" off the calendar
  // is evidence, "1 day" off the default is an assumption the athlete may
  // never have noticed being made for them.
  const acclimSource =
    acclimation.source === "calendar" ? `from calendar (${acclimation.event ?? "travel event"})`
    : acclimation.source === "override" ? "your override"
    : "default — the night before";
  // The altitude slider appears only where the model would do something: a
  // course that never gets above the threshold would give it a knob wired to
  // nothing (same rule as the crew-stop number on a crewless race). The test
  // is the COURSE's elevation, not the knob's value, so turning the term down
  // to 0 doesn't make the control that did it disappear.
  // (null already when the race declares features.altitude: false — see
  // useRacePlan's projectRace call)
  const alt = proj?.altitude ?? null;
  const showAltitude = alt != null && alt.max_seg_ele_ft > ALTITUDE_THRESHOLD_FT;
  // one printable document at a time — the print-isolation body classes
  // (crew-printing / card-printing) must never coexist
  const [openDoc, setOpenDoc] = useState<null | "crew" | "card" | "fuel" | "drops">(null);
  // the hold-back window is a fraction of THIS race (tt-yib.9), so the copy
  // that names its miles has to be computed, not typed
  const restraintWin = course ? restraintWindowMi(raceDistanceMi(course)) : null;
  // "cutoffs from …" names the document they came from — shared with the
  // crew sheet's own footer (CrewSheet.tsx) via cutoffSource.ts, so the two
  // views can never again disagree about whether there is a cutoff to
  // attribute in the first place (round 4 finding 12). Plain expressions
  // (not useMemo): they have to run unconditionally above the early return
  // below, and a scan of a handful of `sources`/`aid_stations` entries needs
  // no memoizing.
  const hasCutoffs = course ? courseHasCutoffs(course) : false;
  const cutoffSource = course ? cutoffSourceLabel(course, { editionYear: raceConfig.edition_year }) : "";

  if (missing || !course) {
    return (
      <section>
        <SectionTag>{tuneUp ? "tune-up planner" : "race planner"}</SectionTag>
        <div className="panel notch" style={{ padding: "28px 26px" }}>
          <span className="eyebrow" style={{ color: missing || error ? "var(--ember)" : "var(--mist-mute)" }}>
            {missing ? "no course data yet" : error ? error : "loading course…"}
          </span>
          {missing && (
            <div style={{ marginTop: 12 }}>
              <button
                className="chip"
                onClick={courseBuild.run}
                disabled={courseBuild.busy}
                style={{ fontSize: 10, minHeight: 36, padding: "0 14px" }}
              >
                {courseBuild.busy ? "building…" : "run course build"}
              </button>
              <div style={{ fontSize: 11, color: "var(--mist-mute)", marginTop: 8, lineHeight: 1.5 }}>
                Parses the stored GPX into a course profile — free, no agent turn.
              </div>
              {courseBuild.error && (
                <div style={{ fontSize: 11, color: "var(--ember)", marginTop: 6 }}>{courseBuild.error}</div>
              )}
              {/* Round 3 sweep extension (render-only edit, per the fixer who
                  owns the rest of this file): a course DID build, but the
                  hook's own `warnings` says it's degraded. In practice this
                  never paints — courseBuild.run()'s onDone() IS reload(),
                  and App.tsx wraps this whole tabpanel in
                  `key={`race-${key}`}` (that same pulse), which remounts
                  this component — and every hook's state in it, this one
                  included — the instant the build succeeds, before this
                  render ever reaches the screen (traced with a
                  temporary console.log rather than assumed: warnings gets
                  set, then the very next commit is a fresh mount with it
                  back at []). Kept anyway, since it costs nothing and is
                  correct for whatever future onDone() doesn't immediately
                  remount its own caller — but the mismatch itself is not
                  lost to the athlete either way: the persisted banner below
                  (raceConfig.unresolved, re-derived off the RELOADED
                  race.json) says the same thing the instant the reload
                  lands. See web/tests/switcher.spec.ts's "RACE tab" test
                  for the reproduction and the test that covers the real,
                  observable outcome instead of this line. */}
              {courseBuild.warnings.length > 0 && (
                <div style={{ fontSize: 11, color: "var(--lamp)", marginTop: 6 }}>⚠ {courseBuild.warnings.join(" · ")}</div>
              )}
            </div>
          )}
        </div>
      </section>
    );
  }

  const stats: { label: string; value: string; color?: string }[] = proj ? [
    { label: "best case", value: race.clock(proj.finish_h.best), color: "var(--pine)" },
    { label: "expected", value: race.clock(proj.finish_h.avg), color: "var(--lamp)" },
    { label: "worst case", value: race.clock(proj.finish_h.worst), color: "var(--ember)" },
    { label: "expected elapsed", value: fmtElapsed(proj.finish_h.avg) },
    { label: "time stopped", value: fmtElapsed(proj.stopped_h) },
    // proj.goal_h (not raw goalH): an infeasible typed goal reports "—"
    // here just like the table, instead of a confident header time
    { label: "goal", value: proj.goal_h != null ? `${fmtElapsed(proj.goal_h)} → ${race.clock(proj.goal_h)}` : "—", color: "var(--creek)" },
  ] : [];

  const numInput = (value: number, set: (n: number) => void, min: number, max: number, w = 44) => (
    <input
      type="number" min={min} max={max} step={1} value={value}
      // HTML min/max don't constrain TYPED values — clamp here so a typed
      // "-10" can't reach the model and break ETA monotonicity
      onChange={(e) => set(Math.min(max, Math.max(min, Number(e.target.value) || 0)))}
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
              title={`deliberate first-half hold-back — this much slower than model pace through mile ${restraintWin?.fullMi.toFixed(0) ?? "?"} (tapering off by ${restraintWin?.endMi.toFixed(0) ?? "?"}); restrained miles also age the fatigue clock less, flattening the late-race fade`}>
              hold-back +{restraint.toFixed(1)}%
              <input
                type="range" min={0} max={15} step={0.5} value={restraint}
                onChange={(e) => setRestraint(Number(e.target.value))}
                style={{ width: 70, accentColor: "var(--lamp)" }}
              />
            </label>
            {showAltitude && (
              <label className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                title={`how much of the modeled altitude penalty to apply — 100% is the published curve (nothing below ${u.elev(ALTITUDE_THRESHOLD_FT)} ${u.elevUnit}, then a per-${u.system === "metric" ? "300 m" : "1,000 ft"} cost above your acclimated elevation), 0% switches the term off. This course peaks at a ${u.elev(alt.max_seg_ele_ft)} ${u.elevUnit} segment; at ${altitude}% the model adds ${fmtElapsed(alt.added_h)} to the expected finish.`}>
                altitude {altitude.toFixed(0)}%
                <input
                  type="range" min={0} max={150} step={5} value={altitude}
                  onChange={(e) => setAltitude(Number(e.target.value))}
                  style={{ width: 70, accentColor: "var(--lamp)" }}
                />
              </label>
            )}
            {/* Days at altitude before the gun — the other half of the term
                the slider above scales. Shown beside it because the two are
                read together: 12,000 ft after four days and 12,000 ft after
                one are different races, and the athlete cannot check the
                second number unless the planner prints where it came from. */}
            {showAltitude && (
              <label className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                title={`days at altitude before race day, scaling the penalty down the acclimatization curve (about half the available relief by day 3, ~90% by day 14 — and it is never total). Currently ${acclimation.days} day${acclimation.days === 1 ? "" : "s"}, ${acclimSource}${acclimation.arrivalDate ? `, arriving ${acclimation.arrivalDate}` : ""}. Type a number to override it; the × puts it back.`}>
                acclim
                <input
                  type="number" min={0} max={60} step={1} value={acclimation.days}
                  onChange={(e) => {
                    const raw = e.target.value;
                    // an emptied field is "no override", not zero days
                    if (raw.trim() === "") { setAcclimationOverride(null); return; }
                    setAcclimationOverride(Math.min(60, Math.max(0, Math.floor(Number(raw) || 0))));
                  }}
                  className="numerals"
                  style={{
                    width: 42, background: "var(--night-deep)", border: "1px solid var(--edge-bright)",
                    color: "var(--mist)", fontSize: 11, padding: "3px 6px",
                  }}
                />
                d
                <span style={{ color: acclimation.source === "default" ? "var(--mist-mute)" : "var(--creek)" }}>
                  {acclimation.source}
                </span>
                {acclimationOverride != null && (
                  <button
                    type="button"
                    onClick={() => setAcclimationOverride(null)}
                    title={acclimation.derived
                      ? `back to the derived ${acclimation.derived.days_at_altitude} day${acclimation.derived.days_at_altitude === 1 ? "" : "s"} (${acclimation.derived.source})`
                      : "clear the override"}
                    style={{
                      background: "none", border: "none", color: "var(--mist-mute)",
                      cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1,
                    }}
                  >×</button>
                )}
              </label>
            )}
            <label className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              fatigue +{fatigue.toFixed(1)}%/10{u.distUnit}
              <input
                type="range" min={0} max={10} step={0.5} value={fatigue}
                onChange={(e) => setFatigue(Number(e.target.value))}
                style={{ width: 70, accentColor: "var(--lamp)" }}
              />
            </label>
            {/* the second number is the crew+drop-bag stop; with neither on
                the course it would be a knob wired to nothing */}
            <label className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              title={columns.crew || columns.drop_bag
                ? "fresh stop minutes at a regular aid station / at crew+drop-bag stations — stops stretch late-race with fatigue"
                : "fresh stop minutes at an aid station — stops stretch late-race with fatigue"}>
              stops {numInput(aidStopMin, setAidStopMin, 0, 30)}
              {(columns.crew || columns.drop_bag) && <>/{numInput(crewStopMin, setCrewStopMin, 0, 45)}</>}m
            </label>
            <label className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              goal
              <input
                type="number" min={20} max={38} step={0.5} value={goalH}
                onChange={(e) => setGoalH(Math.max(0, Number(e.target.value) || 0))}
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
        {tuneUp ? "tune-up planner" : "race planner"} — {race.short} · {u.dist(course.distance_mi, 0)} {u.distUnit} · {u.elev(course.gain_ft)} {u.elevUnit}↑
        {tuneUp && raceConfig.parent_slug ? ` · inside ${raceConfig.parent_slug}` : ""}
      </SectionTag>

      {/* course.gpx measured far enough off race.json's declared distance/gain
          that scripts/build-course.mjs's courseMismatches flagged it and
          race-build.mjs persisted "course.gpx" onto race.json's own
          unresolved[] (the same signal the review screen shows) — surfaced
          here too because a station table with no crew/drop-bag columns to
          fill the panel makes a bad GPX easy to miss otherwise: the header
          above and every "seg" cell in the table below are the MEASURED gpx
          numbers. For an A race each row's own mile column is race.json's
          DECLARED chart mile (pacing.ts projectRace) — two spaces that
          normally nearly coincide but visibly don't here (round 4 finding 1).
          A tune-up's synthesized Finish takes the measured distance instead
          (build-course.mjs, round 5), so its one row agrees with the header
          and the banner says which figure it is contradicting.

          Round 5 confirm, finding 4: build-course.mjs only snaps total_mi to
          the measured distance for `kind === "b" && lastStationIdx === 0` —
          the quick form's own one-station shape. A hand-authored or
          pre-v2 B-kind folder with more than one aid station keeps the
          stale DECLARED mile on every row, same as an A race, so the
          reassuring copy below is gated on that same one-station case
          rather than on `tuneUp` alone. */}
      {raceConfig.unresolved?.includes("course.gpx") && (
        <div className="panel notch" style={{
          padding: "10px 16px", marginBottom: 10, borderColor: "var(--ember)",
          color: "var(--ember)", fontSize: 11.5, lineHeight: 1.5,
        }}>
          ⚠ course.gpx measures {u.dist(course.distance_mi, 1)} {u.distUnit} of the declared {u.dist(course.official_distance_mi, 1)} {u.distUnit}
          {" "}— far enough off to not be normal GPX drift. The chart above and the "seg" column below are read off
          this GPX; {tuneUp && course.aid_stations.length === 1
            ? "the finish row uses the measured distance, so only the declared figure above is in doubt"
            : "the station miles are still the declared chart miles, so a pace or climb number that looks wrong may just be the wrong file uploaded"}. Re-check the GPX before trusting either.
        </div>
      )}

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
          <ProfileChart course={course} proj={proj} night={features.night} />
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
        <div className="panel race-table" style={{ marginTop: 14 }}>
          <div className={gridClass} style={{ padding: "10px 18px", borderBottom: "1px solid var(--edge-bright)" }}>
            <span className="eyebrow" style={{ fontSize: 8.5 }}>station</span>
            <span className="eyebrow" style={{ fontSize: 8.5, textAlign: "right" }}>{u.distUnit}</span>
            <span className="eyebrow col-seg" style={{ fontSize: 8.5, textAlign: "right" }}>{u.elevUnit}↑ seg</span>
            <span className="eyebrow col-stop" style={{ fontSize: 8.5, textAlign: "right" }}>stop min</span>
            <span className="eyebrow col-pace" style={{ fontSize: 8.5, textAlign: "right" }}
              title={`projected pace over this split (top) and the pace needed to hit the goal (below, when a goal is set) — min${u.paceUnit}, fatigue + hold-back included`}>
              pace {u.paceUnit}
            </span>
            <span className="eyebrow" style={{ fontSize: 8.5, display: "grid", gridTemplateColumns: "1fr 1fr 1.15fr", gap: 8 }}>
              <span style={{ textAlign: "right", color: "var(--pine)" }}>best</span>
              <span style={{ textAlign: "right" }}>eta</span>
              <span style={{ textAlign: "right", color: "var(--ember)" }}>worst</span>
            </span>
            {hasActual && (
              <span className="eyebrow col-actual" style={{ fontSize: 8.5, textAlign: "right", color: "var(--mist)" }}
                title="when you actually reached this station — the linked Strava track's first pass within 150 m, or the official split where one was entered">
                actual
              </span>
            )}
            <span className="eyebrow col-goal" style={{ fontSize: 8.5, textAlign: "right" }}>goal</span>
            <span className="eyebrow" style={{ fontSize: 8.5, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <span style={{ textAlign: "right" }}>cutoff</span>
              <span>margin</span>
            </span>
            {showFuel && <span className="eyebrow col-fuel" style={{ fontSize: 8.5, textAlign: "right" }}
              title="fuel carried OUT of the previous refill for this split — carb target, Gels/Bloks/tabs beyond the drink mix, heat-adjusted fluid + fill code counting every flask (M mix · W plain water · ↑ drink at aid before leaving); constants in nutrition.json">
              fuel
            </span>}
            <span className="eyebrow col-flags" style={{ fontSize: 8.5 }}>access</span>
          </div>
          {proj.stations.map((sp, i) => {
            const s = sp.station;
            const missedWorst = sp.cutoff_margin_worst_h != null && sp.cutoff_margin_worst_h < 0;
            return (
              <div
                key={s.name}
                className={gridClass}
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
                      onChange={(e) => setStopOverride(s.name, e.target.value === "" ? null : Math.min(120, Math.max(0, Number(e.target.value) || 0)))}
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
                <span
                  className="numerals col-pace" style={{ fontSize: 11.5, textAlign: "right" }}
                  title={sp.seg_mi > 0.01
                    ? `split pace ${u.paceUnit}: best ${u.paceFmt(sp.seg_pace_best_s_per_mi, 1)} · expected ${u.paceFmt(sp.seg_pace_s_per_mi, 1)} · worst ${u.paceFmt(sp.seg_pace_worst_s_per_mi, 1)}${sp.goal_pace_s_per_mi != null ? ` · goal ${u.paceFmt(sp.goal_pace_s_per_mi, 1)}` : ""} — these are the paces behind the arrival columns`
                    : undefined}
                >
                  {sp.seg_mi > 0.01 ? (
                    <>
                      <span style={{ display: "block", fontWeight: 600 }}>{u.paceFmt(sp.seg_pace_s_per_mi, 1)}</span>
                      {sp.goal_pace_s_per_mi != null && (
                        <span style={{ display: "block", fontSize: 9.5, color: "var(--creek)" }}>{u.paceFmt(sp.goal_pace_s_per_mi, 1)}</span>
                      )}
                    </>
                  ) : (
                    <span style={{ color: "var(--mist-mute)" }}>—</span>
                  )}
                </span>
                <span className="numerals" style={{ fontSize: 11.5, display: "grid", gridTemplateColumns: "1fr 1fr 1.15fr", gap: 8, whiteSpace: "nowrap" }}>
                  <span style={{ color: "var(--pine)", textAlign: "right" }}>{race.clock(sp.eta_h.best)}</span>
                  <span style={{ fontWeight: 700, textAlign: "right" }}>{race.clock(sp.eta_h.avg)}</span>
                  <span style={{ color: "var(--ember)", textAlign: "right" }}>{race.clock(sp.eta_h.worst)}</span>
                </span>
                {hasActual && (() => {
                  const actual = actualByStation.get(s.name);
                  // vs the EXPECTED arrival — the one number in the band that
                  // claims to be the answer rather than an edge
                  const delta = actual ? actual.h - sp.eta_h.avg : null;
                  return (
                    <span className="numerals col-actual" style={{ fontSize: 11.5, textAlign: "right", whiteSpace: "nowrap" }}
                      title={actual
                        ? `reached at ${fmtElapsed(actual.h)} elapsed (${actual.source}) · expected ${fmtElapsed(sp.eta_h.avg)}`
                        : "the linked track never came within 150 m of this station"}>
                      {actual ? (
                        <>
                          <span style={{ display: "block", fontWeight: 600 }}>{race.clock(actual.h)}</span>
                          {delta != null && (
                            <span style={{ display: "block", fontSize: 9.5, color: delta <= 0 ? "var(--pine)" : "var(--ember)" }}>
                              {delta >= 0 ? "+" : "−"}{fmtElapsed(Math.abs(delta))}
                            </span>
                          )}
                        </>
                      ) : (
                        <span style={{ color: "var(--mist-mute)" }}>—</span>
                      )}
                    </span>
                  );
                })()}
                <span className="numerals col-goal" style={{ fontSize: 11.5, color: "var(--creek)", textAlign: "right" }}>
                  {sp.goal_eta_h != null ? race.clock(sp.goal_eta_h) : "—"}
                </span>
                <span className="numerals" style={{ fontSize: 11.5, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, whiteSpace: "nowrap" }}>
                  <span style={{ textAlign: "right" }}>
                    {s.cutoff_h != null ? race.clock(s.cutoff_h) : <span style={{ color: "var(--mist-mute)" }}>—</span>}
                  </span>
                  <span style={{ color: marginColor(sp.cutoff_margin_h) }}>
                    {sp.cutoff_margin_h != null
                      ? `${sp.cutoff_margin_h >= 0 ? "+" : "−"}${fmtElapsed(Math.abs(sp.cutoff_margin_h))}`
                      : ""}
                  </span>
                </span>
                {showFuel && <span className="numerals col-fuel" style={{ fontSize: 10.5, textAlign: "right" }}
                  title={(() => {
                    const f = fuelPlan?.segments.find((seg) => seg.toIdx === i);
                    if (!f) return "no resupply here (no-crew plan) — this station is covered by the carry from the previous refill point";
                    return `${f.from} → ${f.to}${f.via.length ? ` (thru ${f.via.join(", ")} — no resupply)` : ""} · ${fmtCarry(f.carryH)} carry: ${f.carb_g}g carb target (drink ~${f.liquid_carb_g}g), ${f.gels} gel + ${f.bloks} blok pk, ${f.salt_tabs} tab, ${(f.fluid_ml / 1000).toFixed(1)}L fluid${f.water_note ? ` (${f.water_note})` : ""}${f.heat ? " · heat-adjusted" : ""}${f.night ? " · overnight" : ""} · FILL ${f.fill} — every flask you leave with (M = mix, W = plain water)${f.preloads.map((p) => ` · DRINK ${p.ml}mL AT ${p.at ? p.at.toUpperCase() : "THE AID"}`).join("")}${f.ration ? " · RATION: demand exceeds flasks + pre-load" : ""} · ${f.supplement}`;
                  })()}>
                  {(() => {
                    const f = fuelPlan?.segments.find((seg) => seg.toIdx === i);
                    if (!f) return <span style={{ color: "var(--mist-mute)" }}>—</span>;
                    const units = [f.gels > 0 ? `${f.gels}G` : "", f.bloks > 0 ? `${f.bloks}B` : ""].filter(Boolean).join("+");
                    return (
                      <>
                        <span style={{ display: "block", fontWeight: 600, whiteSpace: "nowrap" }}>
                          {f.carb_g}g{units ? ` · ${units}` : ""}{f.salt_tabs > 0 ? ` ${f.salt_tabs}t` : ""}
                        </span>
                        <span style={{ display: "block", fontSize: 9, whiteSpace: "nowrap", color: f.extra_fill ? "var(--ember)" : "var(--mist-dim)", fontWeight: f.extra_fill ? 700 : 400 }}>
                          {(f.fluid_ml / 1000).toFixed(1)}L {f.fill}{f.preloads.length > 0 ? "↑" : ""}
                        </span>
                      </>
                    );
                  })()}
                </span>}
                <span className="col-flags" style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
                  <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                    {stationFlags(s, columns).map((f) => <FlagChip key={f.label} label={f.label} color={f.color} />)}
                  </span>
                  {columns.crew && crewBase?.base && crewBase.drives[s.name] && (
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
            <span className="numerals col-pace" style={{ fontSize: 11.5, textAlign: "right" }}
              title={`overall moving pace, min${u.paceUnit} (stops excluded)`}>
              {(() => {
                const totalMi = proj.stations[proj.stations.length - 1].station.total_mi;
                const movingH = proj.finish_h.avg - proj.stopped_h;
                return (
                  <>
                    <span style={{ display: "block", fontWeight: 600 }}>{u.paceFmt((movingH * 3600) / totalMi, 1)}</span>
                    {proj.goal_h != null && (
                      <span style={{ display: "block", fontSize: 9.5, color: "var(--creek)" }}>
                        {u.paceFmt(((proj.goal_h - proj.stopped_h) * 3600) / totalMi, 1)}
                      </span>
                    )}
                  </>
                );
              })()}
            </span>
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
            {showFuel && <span className="numerals col-fuel" style={{ fontSize: 10.5, textAlign: "right" }}
              title={panels.drop_bag_card
                ? "race totals from the fuel plan — distributed across the drop bags (see ⎙ drop bags 3×5)"
                : "race totals from the fuel plan — no drop bags on this course, so this is what you carry and what gets restocked at aid"}>
              {fuelPlan && (
                <>
                  <span style={{ display: "block", fontWeight: 600, whiteSpace: "nowrap" }}>{fuelPlan.total_gels}G+{fuelPlan.total_bloks}B {fuelPlan.total_tabs}t</span>
                  <span style={{ display: "block", fontSize: 9, whiteSpace: "nowrap", color: "var(--mist-dim)" }}>{fuelPlan.total_hcf_scoops} hcf</span>
                </>
              )}
            </span>}
            <span className="col-flags" />
          </div>

          {/* totals row — one line, left-aligned */}
          <div style={{ padding: "11px 18px", borderTop: "1px solid var(--edge)", display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span className="eyebrow" style={{ fontSize: 8.5 }}>total planned aid-station time</span>
            <span className="numerals" style={{ fontSize: 13.5, fontWeight: 700, color: "var(--lamp)" }}>
              {fmtElapsed(proj.stopped_h)}
            </span>
            {showFuel && fuelPlan && (
              <>
                <span className="eyebrow" style={{ fontSize: 8.5 }}>fuel totals</span>
                <span className="numerals" style={{ fontSize: 11, fontWeight: 600 }}
                  title={`whole-race consumables (no-crew plan): Maurten gels, Clif Blok packets, Tailwind High Carb scoops (1 per MIX flask; W flasks are plain water, no scoop), salt tabs${panels.drop_bag_card ? " — split across drop bags via ⎙ drop bags 3×5" : ""}`}>
                  ≈{(fuelPlan.total_carb_g / 1000).toFixed(1)}kg carb · {fuelPlan.total_gels} gels · {fuelPlan.total_bloks} bloks · {fuelPlan.total_hcf_scoops} HCF scoops · {fuelPlan.total_tabs} tabs
                </span>
              </>
            )}
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
                    fit: {fit.basis} (eff. n={fit.effN}) · ±{u.paceFmt(fit.residStd, 1)}{u.paceUnit} band · grade: {proj?.grade_basis ?? "—"}
                    {paceGrade?.fitted_at && ` (fitted ${relativeAgo(new Date(paceGrade.fitted_at).getTime())}${paceGrade.runs_pending_time ? `, ${paceGrade.runs_pending_time} runs awaiting time streams` : ""})`}
                    {paceGradeError && <span style={{ color: "var(--ember)" }}> · {paceGradeError}</span>}
                    {nutritionError && <span style={{ color: "var(--ember)" }}> · {nutritionError}</span>}
                    {!nutritionError && nutritionSource === "default" && raceConfig && showFuel && (
                      <span style={{ color: "var(--ember)" }}> · using default fueling constants — races/{raceConfig.slug}/nutrition.json missing</span>
                    )}
                    {physiologyError && <span style={{ color: "var(--ember)" }}> · {physiologyError}</span>}
                    {" "}· tech: {course.aid_stations.filter((s) => (s.tech_pct ?? 0) > 0).map((s) => `${s.name.toLowerCase()} +${s.tech_pct}%`).join(", ") || "none"} · race-cal +{calibration}% all paces · restraint +{restraint}% thru mi {restraintWin?.fullMi.toFixed(0)} (fades by {restraintWin?.endMi.toFixed(0)}, restrained miles age ×{(1 - RESTRAINT_FATIGUE_PAYOFF * restraint / 100).toFixed(2)} on the fatigue clock) · fatigue ×{(1 + fatigue / 100).toFixed(2)}/10{u.distUnit} compounding · stops {aidStopMin}{(columns.crew || columns.drop_bag) && `/${crewStopMin}`}m fresh
                    {showAltitude && (
                      <> · altitude {altitude}%: {alt.max_penalty > 0
                        ? <>up to +{(alt.max_penalty * 100).toFixed(1)}% pace on the high segments, {fmtElapsed(alt.added_h)} added, measured from {alt.home_assumed ? "SEA LEVEL (set your home elevation in settings)" : `${u.elev(alt.home_ft)} ${u.elevUnit} home`}</>
                        : <>off</>}</>
                    )}
                    {showAltitude && (
                      <> · acclimation {acclimation.days} day{acclimation.days === 1 ? "" : "s"} · {acclimSource}
                        {acclimation.arrivalDate && <> (arrive {acclimation.arrivalDate})</>}</>
                    )}
                  </span>
                </>
              )}
              {/* a crew-base.json with no `base` is normal — the folder has
                  emergency numbers but no race-week lodging (tt-yib.9) */}
              {columns.crew && crewBase?.base && (
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
                            title="google maps directions to the start"
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
                {hasCutoffs ? <>cutoffs from {cutoffSource} · </> : "no cutoffs on this course · "}
                start {race.clock(0)} ·{" "}
                {sun
                  ? `sunset ${sun.sunset} · sunrise ${sun.sunrise}`
                  : "sun unknown — run the course build after setting the date"}
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
                onClick={() => setOpenDoc("card")}
              >
                ⎙ runner card 3×5
              </button>
              {/* Gated the same as the fuel COLUMN above (showFuel): a tune-up
                  with no nutrition.json has nothing but DEFAULT_NUTRITION
                  behind this button, which is exactly the "impersonal
                  defaults" the column's own comment says must not reach the
                  athlete (round 4 finding 4 — the print button was the one
                  place that gate was missing). */}
              {showFuel && (
                <button
                  className="chip"
                  style={{ borderColor: "var(--lamp)", color: "var(--lamp)", whiteSpace: "nowrap" }}
                  onClick={() => setOpenDoc("fuel")}
                >
                  ⎙ fuel card 3×5
                </button>
              )}
              {panels.drop_bag_card && (
                <button
                  className="chip"
                  style={{ borderColor: "var(--lamp)", color: "var(--lamp)", whiteSpace: "nowrap" }}
                  onClick={() => setOpenDoc("drops")}
                >
                  ⎙ drop bags 3×5
                </button>
              )}
              {panels.crew_sheet && (
                <button
                  className="chip"
                  style={{ borderColor: "var(--lamp)", color: "var(--lamp)", whiteSpace: "nowrap" }}
                  onClick={() => setOpenDoc("crew")}
                >
                  ⎙ crew sheet pdf
                </button>
              )}
              {panels.crew_sheet && <CrewExportButton />}
            </span>
          </div>
        </div>
      )}

      {openDoc === "crew" && panels.crew_sheet && proj && (
        <CrewSheet course={course} proj={proj} crewBase={crewBase} onClose={() => setOpenDoc(null)} />
      )}
      {openDoc === "card" && proj && (
        <RunnerCard course={course} proj={proj} crewBase={crewBase} onClose={() => setOpenDoc(null)} />
      )}
      {openDoc === "fuel" && fuelPlan && (
        <FuelCard plan={fuelPlan} cfg={nutrition} onClose={() => setOpenDoc(null)} />
      )}
      {openDoc === "drops" && panels.drop_bag_card && fuelPlan && (
        <DropBagCard plan={fuelPlan} cfg={nutrition} onClose={() => setOpenDoc(null)} />
      )}
    </section>
  );
}
