import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useUnits, useBlockConfig } from "../data";
import { fmtRaceClock, fmtElapsed, type projectRace, type StationProjection } from "./pacing";
import type { Course } from "./types";

/* ------------------------------------------------------------------ */
/*  Runner card — a double-sided 3×5in index card the runner carries.  */
/*  Side 1 = first half of the course, side 2 = second half; each side */
/*  prints as one 5×3in page (feed card stock twice, flipping between  */
/*  prints). Same light paper palette as the crew sheet so the screen  */
/*  preview matches what comes out of the printer.                     */
/* ------------------------------------------------------------------ */

const INK = "#1c1c1c";
const MUTED = "#6b6b6b";
const ACCENT = "#b05c10";
const RULE = "#d8d4cc";
const BEST = "#3d7a48";
const WORST = "#a33b2a";

/* face content box: @page is 5×3in with 0.15in margins; size the face
   slightly under the 4.7×2.7in content area so rounding never spills a
   face onto a blank second page */
const FACE_W = "4.68in";
const FACE_H = "2.62in";

type Proj = NonNullable<ReturnType<typeof projectRace>>;

function flags(sp: StationProjection): { text: string; warn: boolean } {
  const s = sp.station;
  const f = [
    s.crew || s.crew_only ? "C" : null,
    s.drop_bag ? "D" : null,
    s.pacers ? "P" : null,
    s.water_only ? "W" : null,
  ].filter(Boolean).join("");
  return { text: f, warn: s.water_only || s.crew_only };
}

function CardFace({ side, stations, course, proj }: {
  side: 1 | 2;
  stations: StationProjection[];
  course: Course;
  proj: Proj;
}) {
  const u = useUnits();
  const { race } = useBlockConfig();

  const cell: React.CSSProperties = {
    padding: "1.5px 3px", borderBottom: `0.5px solid ${RULE}`, fontSize: "8.5px",
    color: INK, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", textAlign: "right",
  };
  const th: React.CSSProperties = {
    ...cell, fontSize: "6.5px", textTransform: "uppercase", letterSpacing: "0.05em",
    color: MUTED, borderBottom: `1px solid ${INK}`, fontWeight: 600,
  };

  const emergency = course.crew_info?.emergency[0];

  return (
    <div
      className="runner-card-face"
      style={{
        width: FACE_W, height: FACE_H, boxSizing: "border-box", overflow: "hidden",
        background: "#fff", color: INK, fontFamily: "Archivo, system-ui, sans-serif",
        display: "flex", flexDirection: "column", padding: "3px 5px",
      }}
    >
      {/* header strip */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: `1.5px solid ${INK}`, paddingBottom: 1 }}>
        <span style={{ fontSize: "8px", fontWeight: 700, letterSpacing: "0.04em" }}>
          {race.short} · {side}/2
        </span>
        <span style={{ fontSize: "7px", color: MUTED, fontVariantNumeric: "tabular-nums" }}>
          {side === 1
            ? <>start <b style={{ color: INK }}>{fmtRaceClock(race.date, 0)}</b> · cutoff {race.cutoff_h}h · {u.dist(course.official_distance_mi, 0)}{u.distUnit} {u.elev(course.official_gain_ft)}{u.elevUnit}↑</>
            : <>finish <b style={{ color: BEST }}>{fmtRaceClock(race.date, proj.finish_h.best)}</b> <b style={{ color: INK }}>{fmtRaceClock(race.date, proj.finish_h.avg)}</b> <b style={{ color: WORST }}>{fmtRaceClock(race.date, proj.finish_h.worst)}</b>{proj.goal_h != null && <> · goal {fmtElapsed(proj.goal_h)}</>}</>}
        </span>
      </div>

      {/* station table */}
      <table style={{ width: "100%", borderCollapse: "collapse", flex: 1 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Station</th>
            <th style={th}>{u.distUnit}</th>
            <th style={{ ...th, color: BEST }}>best</th>
            <th style={th}>eta</th>
            <th style={{ ...th, color: WORST }}>worst</th>
            <th style={{ ...th, color: WORST }}>cutoff</th>
            <th style={th}>{u.paceUnit}</th>
            <th style={th}>↑{u.elevUnit}</th>
            <th style={th}>stop</th>
            <th style={{ ...th, textAlign: "left" }}>·</th>
          </tr>
        </thead>
        <tbody>
          {stations.map((sp) => {
            const s = sp.station;
            const crew = s.crew || s.crew_only;
            const f = flags(sp);
            return (
              <tr key={s.name} style={crew ? { background: "#efe6d8" } : undefined}>
                <td style={{ ...cell, textAlign: "left", fontWeight: crew ? 700 : 500, maxWidth: 78, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {s.name}{s.crew_only ? "*" : ""}
                </td>
                <td style={{ ...cell, fontWeight: 600 }}>{u.dist(s.total_mi)}</td>
                <td style={{ ...cell, color: BEST, fontSize: "7.5px" }}>{fmtRaceClock(race.date, sp.eta_h.best)}</td>
                <td style={{ ...cell, fontWeight: 700 }}>{fmtRaceClock(race.date, sp.eta_h.avg)}</td>
                <td style={{ ...cell, color: WORST, fontSize: "7.5px" }}>{fmtRaceClock(race.date, sp.eta_h.worst)}</td>
                <td style={{ ...cell, color: WORST, fontWeight: s.cutoff_h != null ? 700 : 400 }}>
                  {s.cutoff_h != null ? fmtRaceClock(race.date, s.cutoff_h) : "—"}
                </td>
                <td style={cell}>{sp.seg_mi > 0 ? u.paceFmt(sp.seg_pace_s_per_mi, 1) : "—"}</td>
                <td style={cell}>{sp.seg_mi > 0 ? u.elev(sp.seg_gain_ft) : "—"}</td>
                <td style={{ ...cell, color: sp.stop_min > 0 ? INK : MUTED }}>{sp.stop_min > 0 ? sp.stop_min : "·"}</td>
                <td style={{ ...cell, textAlign: "left", color: f.warn ? WORST : ACCENT, fontWeight: 700, fontSize: "7.5px" }}>{f.text}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* footer strip */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: "6px", color: MUTED, paddingTop: 1.5, whiteSpace: "nowrap" }}>
        {side === 1 ? (
          <>
            <span>C crew · D drop · P pacer · W water-only · <b>* no aid</b> · {u.paceUnit} + ↑ = segment into that station</span>
            <span>sunset <b style={{ color: INK }}>{course.sun.sunset}</b></span>
          </>
        ) : (
          <>
            <span>
              drop only at a station — tell the captain
              {emergency && <> · {emergency.label} <b style={{ color: INK }}>{emergency.phone}</b></>}
            </span>
            <span>sunrise <b style={{ color: INK }}>{course.sun.sunrise}</b></span>
          </>
        )}
      </div>
    </div>
  );
}

export function RunnerCard({ course, proj, onClose }: {
  course: Course;
  proj: Proj;
  onClose: () => void;
}) {
  // print isolation: while the card is open, @media print shows only it
  useEffect(() => {
    document.body.classList.add("card-printing");
    return () => document.body.classList.remove("card-printing");
  }, []);

  const split = Math.ceil(proj.stations.length / 2);
  const halves: [StationProjection[], StationProjection[]] = [
    proj.stations.slice(0, split),
    proj.stations.slice(split),
  ];

  // portal to <body>: outside #root, so print CSS can hide the whole app
  return createPortal(
    <div
      className="runner-card"
      style={{
        position: "fixed", inset: 0, zIndex: 100, overflow: "auto",
        background: "#f6f4ef", color: INK, fontFamily: "Archivo, system-ui, sans-serif",
      }}
    >
      {/* while mounted, print pages are 3×5 card stock (overrides the
          letter-size default the crew sheet uses) */}
      <style>{`@media print { @page { size: 5in 3in; margin: 0.15in; } }`}</style>

      <div style={{ maxWidth: 620, margin: "0 auto", padding: "28px 32px 48px" }}>
        <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
            <b style={{ color: INK }}>3×5 index card</b> — set paper size to 3×5in (the page is pre-sized);
            print side 1, re-feed the card flipped, print side 2.
          </div>
          <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
            <button
              onClick={() => window.print()}
              style={{ background: INK, color: "#fff", border: "none", padding: "8px 18px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
            >
              ⎙ print
            </button>
            <button
              onClick={onClose}
              style={{ background: "transparent", color: INK, border: `1px solid ${INK}`, padding: "8px 18px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
            >
              close
            </button>
          </div>
        </div>

        {halves.map((stations, i) => (
          <div key={i} className={i === 0 ? "runner-card-page runner-card-break" : "runner-card-page"} style={{ marginBottom: 18 }}>
            <div className="no-print" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: MUTED, marginBottom: 4 }}>
              side {i + 1} — {stations[0].station.name} → {stations[stations.length - 1].station.name}
            </div>
            <div style={{ border: `1px solid ${RULE}`, boxShadow: "0 1px 4px rgba(0,0,0,0.12)", width: "fit-content" }}>
              <CardFace side={(i + 1) as 1 | 2} stations={stations} course={course} proj={proj} />
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
