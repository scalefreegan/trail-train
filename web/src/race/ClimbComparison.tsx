import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { useUnits, useMeasuredWidth } from "../data";
import { SectionTag, Contours } from "../atoms";
import { useClimbs, useCourse } from "./useRaceData";
import type { RaceClimb, TrainingClimb } from "./types";

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

function ClimbScatter({ training, raceClimbs }: { training: TrainingClimb[]; raceClimbs: RaceClimb[] }) {
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

        {/* training dots */}
        <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }}>
          {training.map((c) => (
            <circle
              key={`${c.activity_id}-${c.start_mi.toFixed(2)}`}
              cx={xAt(c.length_mi)} cy={yAt(c.avg_grade_pct)} r={3}
              fill="var(--mist-dim)" opacity={0.55}
            />
          ))}
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
  }, [width, training, raceClimbs, xAt, yAt, maxLen, maxGrade, u]);

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
    <div ref={measureRef} style={{ position: "relative" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
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
        </div>
      )}
    </div>
  );
}

/* ---- race climb mini profile ---- */

function MiniProfile({ climb }: { climb: RaceClimb }) {
  const u = useUnits();
  const W = 100, H = 46;
  const pts = climb.profile;
  if (pts.length < 2) return null;
  const minMi = pts[0].mi, maxMi = pts[pts.length - 1].mi;
  let minE = Infinity, maxE = -Infinity;
  for (const p of pts) { if (p.ele_ft < minE) minE = p.ele_ft; if (p.ele_ft > maxE) maxE = p.ele_ft; }
  const spanE = maxE - minE || 1;
  const xAt = (mi: number) => ((mi - minMi) / (maxMi - minMi || 1)) * W;
  const yAt = (e: number) => 4 + (1 - (e - minE) / spanE) * (H - 8);

  // grade-colored segments between consecutive points
  const segs = pts.slice(1).map((p, i) => {
    const a = pts[i];
    const g = (p.ele_ft - a.ele_ft) / Math.max(1, (p.mi - a.mi) * 5280) * 100;
    return { x1: xAt(a.mi), y1: yAt(a.ele_ft), x2: xAt(p.mi), y2: yAt(p.ele_ft), color: gradeColor(g) };
  });

  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span className="eyebrow" style={{ color: "var(--lamp)", fontSize: 9 }}>{climb.label.toLowerCase()}</span>
        <span className="numerals" style={{ fontSize: 9, color: "var(--mist-mute)" }}>
          {u.distUnit} {u.dist(climb.start_mi, 0)}–{u.dist(climb.end_mi, 0)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height: 78, marginTop: 8 }}>
        <path
          d={`M ${pts.map((p) => `${xAt(p.mi).toFixed(1)} ${yAt(p.ele_ft).toFixed(1)}`).join(" L ")} L ${W} ${H} L 0 ${H} Z`}
          fill="var(--lamp)" opacity={0.06}
        />
        {segs.map((s, i) => (
          <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
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
  const raceClimbs = course?.race_climbs ?? [];

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
            <ClimbScatter training={training} raceClimbs={raceClimbs} />
          </div>
        )}

        {raceClimbs.length > 0 && (
          <div className="climb-grid">
            {raceClimbs.map((c) => <MiniProfile key={c.id} climb={c} />)}
          </div>
        )}
      </motion.div>
    </section>
  );
}
