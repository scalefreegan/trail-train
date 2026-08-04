import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { useUnits, useStrava, useBlockConfig, useMeasuredWidth } from "../data";
import { SectionTag, Contours } from "../atoms";
import { useCourse } from "./useRaceData";
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

function ProfileChart({ course, proj }: {
  course: Course;
  proj: ReturnType<typeof projectRace> | null;
}) {
  const u = useUnits();
  const { race } = useBlockConfig();
  const { ref: measureRef, width } = useMeasuredWidth();
  const [hoverMi, setHoverMi] = useState<number | null>(null);

  const H = 320;
  const PAD = { top: 56, right: 16, bottom: 26, left: 46 };
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
  const xAt = (mi: number) => PAD.left + (mi / maxMi) * plotW;
  const yAt = (ele: number) => PAD.top + (1 - (ele - minEle) / (maxEle - minEle)) * plotH;

  const linePath = profile.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(p.mi).toFixed(1)} ${yAt(p.ele_ft).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${xAt(maxMi).toFixed(1)} ${(PAD.top + plotH).toFixed(1)} L ${PAD.left} ${(PAD.top + plotH).toFixed(1)} Z`;

  const eleAt = (mi: number) => {
    let best = profile[0];
    for (const p of profile) if (Math.abs(p.mi - mi) < Math.abs(best.mi - mi)) best = p;
    return best;
  };

  // night bands, mapped from elapsed hours onto the mile axis via the projection
  const nights = useMemo(() => {
    if (!proj) return [];
    const startClock = `${String(race.date.getHours()).padStart(2, "0")}:${String(race.date.getMinutes()).padStart(2, "0")}`;
    const horizon = Math.max(38, proj.finish_h.worst);
    return nightIntervals(startClock, course.sun.sunset, course.sun.sunrise, horizon)
      .map(([s, e]) => [proj.mileAtElapsed(s), proj.mileAtElapsed(e)] as [number, number])
      .filter(([a, b]) => b - a > 0.2);
  }, [proj, course.sun, race.date]);

  const aidWithMi = course.aid_stations
    .map((s, i) => ({ s, i, mi: s.gpx_mi ?? s.total_mi }))
    .filter(({ mi }) => mi != null && mi <= maxMi + 0.5);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const mi = ((x - PAD.left) / Math.max(1, plotW)) * maxMi;
    setHoverMi(Math.max(0, Math.min(maxMi, mi)));
  };

  const hover = hoverMi != null ? (() => {
    const p = eleAt(hoverMi);
    const next = aidWithMi.find(({ mi }) => mi > p.mi);
    return { p, next };
  })() : null;
  const tipOnLeft = hover != null && width > 0 && xAt(hover.p.mi) > width * 0.6;

  return (
    <div ref={measureRef} style={{ position: "relative" }}>
      {width > 0 && (
        <svg width={width} height={H} onMouseMove={onMove} onMouseLeave={() => setHoverMi(null)} style={{ display: "block" }}>
          <defs>
            <linearGradient id="courseFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--lamp)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--lamp)" stopOpacity="0.01" />
            </linearGradient>
          </defs>

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
          <motion.path d={areaPath} fill="url(#courseFill)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1 }} />
          <motion.path
            d={linePath} fill="none" stroke="var(--lamp)" strokeWidth="1.4" strokeLinejoin="round"
            initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.8, ease: [0.2, 0.8, 0.2, 1] }}
          />

          {/* aid stations */}
          {aidWithMi.map(({ s, i, mi }, idx) => {
            const p = eleAt(mi!);
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

          {/* hover crosshair */}
          {hover && (
            <g>
              <line x1={xAt(hover.p.mi)} x2={xAt(hover.p.mi)} y1={PAD.top - 18} y2={PAD.top + plotH} stroke="var(--mist-mute)" strokeWidth="1" opacity={0.5} />
              <circle cx={xAt(hover.p.mi)} cy={yAt(hover.p.ele_ft)} r="3" fill="var(--lamp)" />
            </g>
          )}
        </svg>
      )}

      {/* hover tooltip */}
      {hover && proj && (
        <div style={{
          position: "absolute", top: 46,
          left: tipOnLeft ? undefined : Math.min(Math.max(0, xAt(hover.p.mi) + 12), Math.max(0, width - 190)),
          right: tipOnLeft ? width - xAt(hover.p.mi) + 12 : undefined,
          background: "var(--night-deep)", border: "1px solid var(--edge-bright)", padding: "10px 12px",
          pointerEvents: "none", zIndex: 5, minWidth: 168,
        }}>
          <div className="numerals" style={{ fontSize: 12, fontWeight: 600 }}>
            {u.dist(hover.p.mi)} {u.distUnit} · {u.elev(hover.p.ele_ft)} {u.elevUnit}
          </div>
          <div className="numerals" style={{ fontSize: 10, color: "var(--mist-mute)", marginTop: 3 }}>
            grade {hover.p.grade_pct > 0 ? "+" : ""}{hover.p.grade_pct.toFixed(1)}%
            {hover.next ? ` · next aid ${hover.next.s.name.toLowerCase()} in ${u.dist(Math.max(0, hover.next.mi! - hover.p.mi))} ${u.distUnit}` : ""}
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
  const { course, missing } = useCourse();
  const [fatigue, setFatigue] = usePersistedNumber("race.fatigue_pct", 4);
  const [goalH, setGoalH] = usePersistedNumber("race.goal_h", 32);

  const fit = useMemo(() => fitPacing(activities), [activities]);
  const proj = useMemo(
    () => (course && fit ? projectRace(course, fit, { fatiguePctPer10mi: fatigue, goalH }) : null),
    [course, fit, fatigue, goalH],
  );

  if (missing || !course) {
    return (
      <section>
        <SectionTag>race planner</SectionTag>
        <div className="panel notch" style={{ padding: "28px 26px" }}>
          <span className="eyebrow" style={{ color: missing ? "var(--ember)" : "var(--mist-mute)" }}>
            {missing ? "no course data — run `npm run course:build` to parse the race gpx" : "loading course…"}
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
    { label: "goal", value: goalH ? `${fmtElapsed(goalH)} → ${fmtRaceClock(race.date, goalH)}` : "—", color: "var(--creek)" },
  ] : [];

  return (
    <section>
      <SectionTag
        right={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
            <label className="eyebrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              fatigue +{fatigue.toFixed(1)}%/10{u.distUnit}
              <input
                type="range" min={0} max={10} step={0.5} value={fatigue}
                onChange={(e) => setFatigue(Number(e.target.value))}
                style={{ width: 90, accentColor: "var(--lamp)" }}
              />
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
            <span className="eyebrow" style={{ fontSize: 8.5 }}>eta best · avg · worst</span>
            <span className="eyebrow col-goal" style={{ fontSize: 8.5 }}>goal</span>
            <span className="eyebrow" style={{ fontSize: 8.5 }}>cutoff · margin</span>
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
                <span className="numerals" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                  <span style={{ color: "var(--pine)" }}>{fmtRaceClock(race.date, sp.eta_h.best)}</span>
                  <span style={{ color: "var(--mist-mute)" }}> · </span>
                  <span style={{ fontWeight: 700 }}>{fmtRaceClock(race.date, sp.eta_h.avg)}</span>
                  <span style={{ color: "var(--mist-mute)" }}> · </span>
                  <span style={{ color: "var(--ember)" }}>{fmtRaceClock(race.date, sp.eta_h.worst)}</span>
                </span>
                <span className="numerals col-goal" style={{ fontSize: 11.5, color: "var(--creek)" }}>
                  {sp.goal_eta_h != null ? fmtRaceClock(race.date, sp.goal_eta_h) : "—"}
                </span>
                <span className="numerals" style={{ fontSize: 11.5, whiteSpace: "nowrap" }}>
                  {s.cutoff_h != null ? (
                    <>
                      {fmtRaceClock(race.date, s.cutoff_h)}
                      <span style={{ color: marginColor(sp.cutoff_margin_h), marginLeft: 6 }}>
                        {sp.cutoff_margin_h != null && sp.cutoff_margin_h >= 0 ? "+" : "−"}
                        {sp.cutoff_margin_h != null ? fmtElapsed(Math.abs(sp.cutoff_margin_h)) : ""}
                      </span>
                    </>
                  ) : (
                    <span style={{ color: "var(--mist-mute)" }}>—</span>
                  )}
                </span>
                <span className="col-flags" style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                  {stationFlags(s).map((f) => <FlagChip key={f.label} label={f.label} color={f.color} />)}
                </span>
              </div>
            );
          })}
          <div style={{ padding: "10px 18px", borderTop: "1px solid var(--edge)", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <span className="eyebrow" style={{ fontSize: 8.5 }}>
              {fit ? `pacing fit from ${fit.n} runs · ±${u.paceFmt(fit.residStd, 1)}${u.paceUnit} band · fatigue +${fatigue}%/10${u.distUnit} · dwell 3–8 min/aid` : ""}
            </span>
            <span className="eyebrow" style={{ fontSize: 8.5 }}>
              cutoffs from 2025 manual · start {fmtRaceClock(race.date, 0)} · sunset {course.sun.sunset} · sunrise {course.sun.sunrise}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
