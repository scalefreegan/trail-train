import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { useUnits, useMeasuredWidth } from "../data";
import { SectionTag, Contours } from "../atoms";
import { useClimbs, useCourse } from "./useRaceData";
import type { Course, RaceClimb, TrainingClimb } from "./types";

/* ------------------------------------------------------------------ */
/*  Climb comparison — every significant training climb (dots) vs the  */
/*  six race climbs (markers), plus each race climb's real profile.    */
/* ------------------------------------------------------------------ */

function gradeColor(pct: number): string {
  if (pct >= 15) return "var(--ember)";
  if (pct >= 8) return "var(--lamp)";
  return "var(--pine)";
}

/* ---- scatter ---- */

const H = 280;
const PAD = { top: 20, right: 20, bottom: 34, left: 40 };

/* Dot opacity encodes recency — same 75-day half-life as the pacing fit
   weights (pacing.ts), so a climb's visual weight matches its model weight.
   Age is measured against the snapshot's fetched_at (pure per render, and it
   advances exactly when a sync lands). The floor keeps window-edge
   (6-month-old) climbs legible on the dark surface instead of fading out. */
const DOT_HALFLIFE_DAYS = 75;
const DOT_OPACITY_MAX = 0.9;
const DOT_OPACITY_FLOOR = 0.15;
function opacityForAge(ageDays: number): number {
  return DOT_OPACITY_FLOOR + (DOT_OPACITY_MAX - DOT_OPACITY_FLOOR) * Math.pow(2, -Math.max(0, ageDays) / DOT_HALFLIFE_DAYS);
}
function dotOpacity(date: string, now: number): number {
  return opacityForAge((now - new Date(date).getTime()) / 86400000);
}

/* Climbs from the last two weeks get an accent ring — the "what have I done
   lately" highlight on top of the continuous recency fade. */
const HIGHLIGHT_DAYS = 14;
const isRecent = (date: string, now: number) =>
  (now - new Date(date).getTime()) / 86400000 <= HIGHLIGHT_DAYS;

/* Reference scale drawn in the plot's top-right corner: dots at fixed ages
   so the opacity→recency mapping is readable off the chart itself, plus the
   ringed "last 2 wk" marker. */
const SCALE_AGES_DAYS = [180, 120, 60, 0];
const SCALE_DOT_GAP = 13;

function RecencyScale({ width }: { width: number }) {
  const y = PAD.top + 2;
  const lastX = width - PAD.right - 30;
  const sixMoX = lastX - (SCALE_AGES_DAYS.length - 1) * SCALE_DOT_GAP - 9;
  const ringX = sixMoX - 52;
  return (
    <g>
      <text x={ringX - 9} y={y + 3} textAnchor="end"
        fill="var(--mist-mute)" style={{ font: "9px var(--font-mono)" }}>last 2 wk</text>
      <circle cx={ringX} cy={y} r={4} fill="var(--mist-dim)" stroke="var(--lamp)" strokeWidth="1" opacity={0.9} />
      <text x={sixMoX} y={y + 3} textAnchor="end"
        fill="var(--mist-mute)" style={{ font: "9px var(--font-mono)" }}>6 mo</text>
      {SCALE_AGES_DAYS.map((age, i) => (
        <circle key={age}
          cx={lastX - (SCALE_AGES_DAYS.length - 1 - i) * SCALE_DOT_GAP} cy={y} r={3}
          fill="var(--mist-dim)" opacity={opacityForAge(age)}
        />
      ))}
      <text x={lastX + 9} y={y + 3} fill="var(--mist-mute)" style={{ font: "9px var(--font-mono)" }}>now</text>
    </g>
  );
}

function ClimbScatter({ training, raceClimbs, now }: { training: TrainingClimb[]; raceClimbs: RaceClimb[]; now: number }) {
  const u = useUnits();
  const { ref: measureRef, width } = useMeasuredWidth();
  const [hover, setHover] = useState<TrainingClimb | null>(null);

  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;

  const [maxLen, maxGrade] = useMemo(() => [
    Math.max(4, ...training.map((c) => c.length_mi), ...raceClimbs.map((c) => c.length_mi)) * 1.08,
    Math.max(18, ...training.map((c) => c.avg_grade_pct), ...raceClimbs.map((c) => c.avg_grade_pct)) * 1.12,
  ], [training, raceClimbs]);

  const xAt = useMemo(() => (len: number) => PAD.left + (len / maxLen) * plotW, [maxLen, plotW]);
  const yAt = useMemo(() => (g: number) => PAD.top + (1 - g / maxGrade) * plotH, [maxGrade, plotH]);

  /* Static scene memoized — hover only re-renders the highlight ring +
     tooltip. Dots are plain circles: one animated group fade instead of a
     Framer Motion timeline per dot. */
  const scene = useMemo(() => {
    if (width <= 0) return null;
    const perMi = u.distVal(1);
    const maxDisp = maxLen * perMi;
    const step = maxDisp > 12 ? 2 : 1;
    const ticks = Array.from({ length: Math.floor(maxDisp / step) }, (_, i) => (i + 1) * step)
      .filter((d) => d / perMi < maxLen * 0.93);
    return (
      <>
        {/* grid + axes */}
        {[5, 10, 15, 20].filter((g) => g < maxGrade).map((g) => (
          <g key={g}>
            <line x1={PAD.left} x2={width - PAD.right} y1={yAt(g)} y2={yAt(g)} stroke="var(--edge)" strokeWidth="1" strokeDasharray="2 5" />
            <text x={6} y={yAt(g) + 3} fill="var(--mist-mute)" style={{ font: "9px var(--font-mono)" }}>{g}%</text>
          </g>
        ))}
        {/* ticks at whole display-units (mi or km) so the labels read 1,2,3… in either system */}
        {ticks.map((d) => (
          <text key={d} x={xAt(d / perMi)} y={H - 8} textAnchor="middle" fill="var(--mist-mute)" style={{ font: "9px var(--font-mono)" }}>
            {d}
          </text>
        ))}
        <text x={width - PAD.right} y={H - 8} textAnchor="end" fill="var(--mist-mute)" style={{ font: "8px var(--font-mono)", letterSpacing: "0.16em" }}>
          CLIMB LENGTH · {u.distUnit.toUpperCase()}
        </text>

        <RecencyScale width={width} />

        {/* training dots */}
        <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }}>
          {training.map((c) => {
            const recent = isRecent(c.date, now);
            return (
              <circle
                key={`${c.activity_id}-${c.start_mi.toFixed(2)}`}
                cx={xAt(c.length_mi)} cy={yAt(c.avg_grade_pct)} r={recent ? 4 : 3}
                fill="var(--mist-dim)" opacity={dotOpacity(c.date, now)}
                stroke={recent ? "var(--lamp)" : undefined} strokeWidth={recent ? 1 : undefined}
              />
            );
          })}
        </motion.g>

        {/* race climb markers */}
        {raceClimbs.map((c, i) => {
          const x = xAt(c.length_mi), y = yAt(c.avg_grade_pct);
          return (
            <g key={c.id}>
              <motion.rect
                x={x - 4.5} y={y - 4.5} width={9} height={9}
                transform={`rotate(45 ${x} ${y})`}
                fill="var(--lamp)" stroke="var(--night)" strokeWidth="1"
                initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ duration: 0.3, delay: 0.3 + i * 0.08 }}
              >
                <title>
                  {c.label} · {u.dist(c.length_mi)} {u.distUnit} · +{u.elev(c.gain_ft)} {u.elevUnit} · avg {c.avg_grade_pct.toFixed(1)}% · max {c.max_grade_pct.toFixed(0)}%
                </title>
              </motion.rect>
              <text
                x={x + 8} y={y + 3} fill="var(--lamp)"
                style={{ font: "9px var(--font-mono)", letterSpacing: "0.05em" }}
              >
                {c.label.toLowerCase()}
              </text>
            </g>
          );
        })}
      </>
    );
  }, [width, training, raceClimbs, now, xAt, yAt, maxLen, maxGrade, u]);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let best: TrainingClimb | null = null, bestD = 14 * 14;
    for (const c of training) {
      const dx = xAt(c.length_mi) - mx, dy = yAt(c.avg_grade_pct) - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = c; }
    }
    setHover((prev) => (prev === best ? prev : best));
  };

  const tipOnLeft = hover != null && width > 0 && xAt(hover.length_mi) > width * 0.6;

  return (
    <div
      ref={measureRef}
      style={{ position: "relative", cursor: hover?.strava_url ? "pointer" : undefined }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      onClick={() => { if (hover?.strava_url) window.open(hover.strava_url, "_blank", "noopener"); }}
    >
      {width > 0 && (
        <svg width={width} height={H} style={{ display: "block" }}>
          {scene}
        </svg>
      )}

      {/* hover highlight — a composited div outside the svg, so mousemove
          never forces a repaint of the dot field */}
      {hover && (
        <div style={{
          position: "absolute", left: -4.5, top: -4.5, width: 9, height: 9, borderRadius: "50%",
          background: "var(--mist)", border: "1px solid var(--lamp)", pointerEvents: "none",
          transform: `translate(${xAt(hover.length_mi)}px, ${yAt(hover.avg_grade_pct)}px)`, willChange: "transform",
        }} />
      )}

      {hover && (
        <div style={{
          position: "absolute", top: Math.max(0, yAt(hover.avg_grade_pct) - 60),
          left: tipOnLeft ? undefined : xAt(hover.length_mi) + 12,
          right: tipOnLeft ? width - xAt(hover.length_mi) + 12 : undefined,
          background: "var(--night-deep)", border: "1px solid var(--edge-bright)", padding: "9px 11px",
          pointerEvents: "none", zIndex: 5, maxWidth: 230,
        }}>
          <div style={{ fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{hover.title}</div>
          <div className="numerals" style={{ fontSize: 10, color: "var(--mist-mute)", marginTop: 3 }}>
            {new Date(hover.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase()}
            {" · "}{u.dist(hover.length_mi)} {u.distUnit} · +{u.elev(hover.gain_ft)} {u.elevUnit}
          </div>
          <div className="numerals" style={{ fontSize: 10, color: "var(--mist-dim)", marginTop: 2 }}>
            avg {hover.avg_grade_pct.toFixed(1)}% · max {hover.max_grade_pct.toFixed(0)}%
          </div>
          {hover.strava_url && (
            <div className="numerals" style={{ fontSize: 9, color: "var(--lamp)", marginTop: 4 }}>
              click to open in strava ↗
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---- race climb mini profile ----
   Every card renders the SAME course-distance window (centered on its climb,
   with surrounding terrain for context) and the SAME elevation span, so
   climb length and steepness are visually comparable across cards. */

function climbWindow(climb: RaceClimb, windowMi: number, courseMi: number): [number, number] {
  const mid = (climb.start_mi + climb.end_mi) / 2;
  const w0 = Math.max(0, Math.min(mid - windowMi / 2, courseMi - windowMi));
  return [w0, w0 + windowMi];
}

function MiniProfile({ climb, course, windowMi, sharedSpanFt }: {
  climb: RaceClimb; course: Course; windowMi: number; sharedSpanFt: number;
}) {
  const u = useUnits();
  const W = 100, H = 46;
  const [w0, w1] = climbWindow(climb, windowMi, course.distance_mi);
  const pts = useMemo(
    () => course.profile.filter((p) => p.mi >= w0 - 1e-6 && p.mi <= w1 + 1e-6),
    [course.profile, w0, w1],
  );
  if (pts.length < 2) return null;
  let minE = Infinity;
  for (const p of pts) if (p.ele_ft < minE) minE = p.ele_ft;
  const xAt = (mi: number) => ((mi - w0) / windowMi) * W;
  const yAt = (e: number) => 4 + (1 - (e - minE) / sharedSpanFt) * (H - 8);

  const inClimb = (mi: number) => mi >= climb.start_mi && mi <= climb.end_mi;
  const segs = pts.slice(1).map((p, i) => {
    const a = pts[i];
    const mid = (a.mi + p.mi) / 2;
    const g = (p.ele_ft - a.ele_ft) / Math.max(1, (p.mi - a.mi) * 5280) * 100;
    return {
      x1: xAt(a.mi), y1: yAt(a.ele_ft), x2: xAt(p.mi), y2: yAt(p.ele_ft),
      color: inClimb(mid) ? gradeColor(g) : "var(--edge-bright)",
      climb: inClimb(mid),
    };
  });
  const climbPts = pts.filter((p) => inClimb(p.mi));

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span className="eyebrow" style={{ color: "var(--lamp)", fontSize: 9 }}>{climb.label.toLowerCase()}</span>
        <span className="numerals" style={{ fontSize: 9, color: "var(--mist-mute)" }}>
          {u.distUnit} {u.dist(climb.start_mi, 0)}–{u.dist(climb.end_mi, 0)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height: 78, marginTop: 8 }}>
        {climbPts.length > 1 && (
          <path
            d={`M ${climbPts.map((p) => `${xAt(p.mi).toFixed(1)} ${yAt(p.ele_ft).toFixed(1)}`).join(" L ")} L ${xAt(climbPts[climbPts.length - 1].mi).toFixed(1)} ${H} L ${xAt(climbPts[0].mi).toFixed(1)} ${H} Z`}
            fill="var(--lamp)" opacity={0.07}
          />
        )}
        {segs.map((s, i) => (
          <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
            stroke={s.color} strokeWidth={s.climb ? 1.6 : 1} opacity={s.climb ? 1 : 0.7}
            vectorEffect="non-scaling-stroke" strokeLinecap="round" />
        ))}
      </svg>
      <div className="numerals" style={{ fontSize: 10, color: "var(--mist-dim)", marginTop: 8, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <span>{u.dist(climb.length_mi)} {u.distUnit}</span>
        <span>+{u.elev(climb.gain_ft)} {u.elevUnit}</span>
        <span>avg {climb.avg_grade_pct.toFixed(1)}%</span>
        <span style={{ color: gradeColor(climb.max_grade_pct) }}>max {climb.max_grade_pct.toFixed(0)}%</span>
      </div>
    </div>
  );
}

/* ---- the view ---- */

export function ClimbComparison() {
  const u = useUnits();
  const { course } = useCourse();
  const { climbs, missing } = useClimbs();

  const training = useMemo(() => climbs?.climbs ?? [], [climbs]);
  const raceClimbs = useMemo(() => course?.race_climbs ?? [], [course]);
  const now = useMemo(() => (climbs ? new Date(climbs.fetched_at).getTime() : 0), [climbs]);

  // shared scales for the mini profiles: every card shows the same course
  // window and elevation span, so length and steepness compare truthfully
  const windowMi = useMemo(
    () => (raceClimbs.length ? Math.max(...raceClimbs.map((c) => c.length_mi)) * 1.25 : 5),
    [raceClimbs],
  );
  const sharedSpanFt = useMemo(() => {
    if (!course || !raceClimbs.length) return 1;
    let span = 1;
    for (const c of raceClimbs) {
      const [w0, w1] = climbWindow(c, windowMi, course.distance_mi);
      let lo = Infinity, hi = -Infinity;
      for (const p of course.profile) {
        if (p.mi < w0 || p.mi > w1) continue;
        if (p.ele_ft < lo) lo = p.ele_ft;
        if (p.ele_ft > hi) hi = p.ele_ft;
      }
      span = Math.max(span, hi - lo);
    }
    return span;
  }, [course, raceClimbs, windowMi]);

  return (
    <section>
      <SectionTag
        right={
          <span className="eyebrow">
            {climbs
              ? `${training.length} training climbs ≥${u.elev(300)} ${u.elevUnit} · last ${Math.round((climbs.window_days ?? 183) / 30)} mo${climbs.activities_pending > 0 ? ` · ${climbs.activities_pending} runs awaiting sync` : ""}`
              : missing ? "no climb data yet" : "loading…"}
          </span>
        }
      >
        climb readiness — you vs the monster
      </SectionTag>

      <motion.div
        className="panel notch"
        initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}
        style={{ overflow: "hidden" }}
      >
        <Contours seed={21} opacity={0.07} />
        {missing && training.length === 0 ? (
          <div style={{ padding: "28px 26px", position: "relative" }}>
            <span className="eyebrow" style={{ color: "var(--ember)" }}>
              no climbs.json — run `npm run sync:streams` to pull elevation streams from strava
            </span>
          </div>
        ) : (
          <div style={{ position: "relative", padding: "8px 0 0" }}>
            <ClimbScatter training={training} raceClimbs={raceClimbs} now={now} />
          </div>
        )}

        {course && raceClimbs.length > 0 && (
          <div className="climb-grid">
            {raceClimbs.map((c) => (
              <MiniProfile key={c.id} climb={c} course={course} windowMi={windowMi} sharedSpanFt={sharedSpanFt} />
            ))}
          </div>
        )}
      </motion.div>
    </section>
  );
}
