import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useUnits, useBlockConfig } from "../data";
import { fmtRaceClock, fmtElapsed, type projectRace } from "./pacing";
import type { Course } from "./types";

/* ------------------------------------------------------------------ */
/*  Crew sheet — a light, printer-friendly handout: station table with */
/*  ETAs, access, stops, GPS links, and an overview map. Deliberately  */
/*  styled with its own light palette (not the app's dark CSS vars)    */
/*  so screen preview and paper match.                                 */
/* ------------------------------------------------------------------ */

const INK = "#1c1c1c";
const MUTED = "#6b6b6b";
const ACCENT = "#b05c10";
const RULE = "#d8d4cc";

const NO_TRACK: [number, number][] = [];

function CourseMap({ course }: { course: Course }) {
  const u = useUnits();
  const pts = course.map_track ?? NO_TRACK;
  const geom = useMemo(() => {
    if (pts.length < 2) return null;
    const lats = pts.map((p) => p[0]);
    const lons = pts.map((p) => p[1]);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
    const W = 700;
    const spanX = (maxLon - minLon) * kx || 1;
    const spanY = (maxLat - minLat) || 1;
    const H = Math.round(W * (spanY / spanX));
    const PAD = 34;
    const xAt = (lon: number) => PAD + ((lon - minLon) * kx / spanX) * (W - 2 * PAD);
    const yAt = (lat: number) => PAD + ((maxLat - lat) / spanY) * (H - 2 * PAD);
    const path = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(p[1]).toFixed(1)} ${yAt(p[0]).toFixed(1)}`).join(" ");
    return { W, H: H + 2 * PAD - PAD, xAt, yAt, path, height: H };
  }, [pts]);
  if (!geom) return null;

  const labeled = course.aid_stations.filter((s) => s.lat != null && s.lon != null);
  const startX = geom.xAt(pts[0][1]);
  const startLeft = startX > geom.W * 0.7; // anchor away from the near edge

  // crew labels sit to the right of their dot; a greedy pass nudges any label
  // that would sit within 12px of an already-placed neighbor (Pine TH/Finish)
  const crewLabels: { name: string; text: string; x: number; y: number; ly: number }[] = [];
  for (const s of labeled.filter((s) => s.crew || s.crew_only).sort((a, b) => geom.yAt(a.lat!) - geom.yAt(b.lat!))) {
    const x = geom.xAt(s.lon!), y = geom.yAt(s.lat!);
    let ly = y + 4;
    while (crewLabels.some((p) => Math.abs(p.ly - ly) < 12 && Math.abs(p.x - x) < 170)) ly += 13;
    crewLabels.push({ name: s.name, text: `${s.name} · ${u.dist(s.total_mi, 0)}${u.distUnit}`, x, y, ly });
  }

  return (
    <svg viewBox={`0 0 ${geom.W} ${geom.height + 40}`} style={{ width: "100%", display: "block" }}>
      <path d={geom.path} fill="none" stroke="#8a8578" strokeWidth="1.6" strokeLinejoin="round" />
      {/* start */}
      <g>
        <circle cx={startX} cy={geom.yAt(pts[0][0])} r="4" fill={INK} />
        <text
          x={startLeft ? startX - 7 : startX + 7} y={geom.yAt(pts[0][0]) + 4}
          textAnchor={startLeft ? "end" : "start"}
          style={{ font: "600 11px Archivo, sans-serif", fill: INK }}
        >
          START 6:00a
        </text>
      </g>
      {labeled.filter((s) => !(s.crew || s.crew_only)).map((s) => (
        <circle key={s.name} cx={geom.xAt(s.lon!)} cy={geom.yAt(s.lat!)} r={2.5} fill="#fff" stroke={MUTED} strokeWidth={1} />
      ))}
      {crewLabels.map((l) => (
        <g key={l.name}>
          <circle cx={l.x} cy={l.y} r={4} fill={ACCENT} stroke="#fff" strokeWidth={1.2} />
          <text x={l.x + 7} y={l.ly} style={{ font: "600 10.5px Archivo, sans-serif", fill: ACCENT }}>
            {l.text}
          </text>
        </g>
      ))}
      <text x={geom.W - 8} y={geom.height + 26} textAnchor="end" style={{ font: "9px Archivo, sans-serif", fill: MUTED }}>
        ● crew access · ○ runner-only aid · line = course
      </text>
    </svg>
  );
}

export function CrewSheet({ course, proj, onClose }: {
  course: Course;
  proj: NonNullable<ReturnType<typeof projectRace>>;
  onClose: () => void;
}) {
  const u = useUnits();
  const { race } = useBlockConfig();

  // print isolation: while the sheet is open, @media print shows only it
  useEffect(() => {
    document.body.classList.add("crew-printing");
    return () => document.body.classList.remove("crew-printing");
  }, []);

  const crewNames = course.aid_stations.filter((s) => s.crew || s.crew_only).map((s) => s.name);
  const dropNames = course.aid_stations.filter((s) => s.drop_bag).map((s) => s.name);
  const firstPacer = course.aid_stations.find((s) => s.pacers);

  const cell: React.CSSProperties = { padding: "5px 8px", borderBottom: `1px solid ${RULE}`, fontSize: 11, color: INK, verticalAlign: "top" };
  const th: React.CSSProperties = { ...cell, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: MUTED, borderBottom: `2px solid ${INK}`, textAlign: "left" };

  // portal to <body>: outside #root, so print CSS can hide the whole app
  // (display:none) without hiding the sheet — no blank trailing pages
  return createPortal(
    <div
      className="crew-sheet"
      style={{
        position: "fixed", inset: 0, zIndex: 100, overflow: "auto",
        background: "#f6f4ef", color: INK, fontFamily: "Archivo, system-ui, sans-serif",
      }}
    >
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "28px 32px 48px" }}>
        {/* screen-only controls */}
        <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginBottom: 12 }}>
          <button
            onClick={() => window.print()}
            style={{ background: INK, color: "#fff", border: "none", padding: "8px 18px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
          >
            ⎙ print / save pdf
          </button>
          <button
            onClick={onClose}
            style={{ background: "transparent", color: INK, border: `1px solid ${INK}`, padding: "8px 18px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}
          >
            close
          </button>
        </div>

        {/* header */}
        <div style={{ borderBottom: `3px solid ${INK}`, paddingBottom: 10, marginBottom: 14 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{race.name} — Crew Sheet</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>
            {race.date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            {" · start "}{fmtRaceClock(race.date, 0)} · {u.dist(course.official_distance_mi, 1)} {u.distUnit} · {u.elev(course.official_gain_ft)} {u.elevUnit}↑
            {" · course closes "}{fmtRaceClock(race.date, 38)} (38h)
          </div>
          <div style={{ display: "flex", gap: 26, marginTop: 10, fontSize: 12 }}>
            <span><b style={{ color: "#3d7a48" }}>{fmtRaceClock(race.date, proj.finish_h.best)}</b> best</span>
            <span><b style={{ color: ACCENT }}>{fmtRaceClock(race.date, proj.finish_h.avg)}</b> expected ({fmtElapsed(proj.finish_h.avg)})</span>
            <span><b style={{ color: "#a33b2a" }}>{fmtRaceClock(race.date, proj.finish_h.worst)}</b> worst</span>
            <span><b>{fmtElapsed(proj.stopped_h)}</b> planned in aid stations</span>
            {proj.goal_h != null && <span><b>{fmtRaceClock(race.date, proj.goal_h)}</b> goal ({fmtElapsed(proj.goal_h)})</span>}
          </div>
        </div>

        {/* station table */}
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Station</th>
              <th style={{ ...th, textAlign: "right" }}>{u.distUnit}</th>
              <th style={th}>ETA best · <b>avg</b> · worst</th>
              <th style={th}>Goal</th>
              <th style={th}>Cutoff</th>
              <th style={{ ...th, textAlign: "right" }}>Stop</th>
              <th style={th}>Access</th>
              <th style={th}>GPS</th>
            </tr>
          </thead>
          <tbody>
            {proj.stations.map((sp) => {
              const s = sp.station;
              const crew = s.crew || s.crew_only;
              const access = [
                crew ? "CREW" : null,
                s.drop_bag ? "DROP" : null,
                s.pacers ? "PACER" : null,
                s.water_only ? "H₂O only" : null,
                s.crew_only ? "no aid" : null,
              ].filter(Boolean).join(" · ");
              return (
                <tr key={s.name} style={crew ? { background: "#efe6d8" } : undefined}>
                  <td style={{ ...cell, fontWeight: crew ? 700 : 500 }}>
                    {s.name}
                    {s.notes && <div style={{ fontSize: 9, color: MUTED, fontWeight: 400 }}>{s.notes}</div>}
                  </td>
                  <td style={{ ...cell, textAlign: "right", fontWeight: 600 }}>{u.dist(s.total_mi)}</td>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>
                    {fmtRaceClock(race.date, sp.eta_h.best)} · <b>{fmtRaceClock(race.date, sp.eta_h.avg)}</b> · {fmtRaceClock(race.date, sp.eta_h.worst)}
                  </td>
                  <td style={cell}>{sp.goal_eta_h != null ? fmtRaceClock(race.date, sp.goal_eta_h) : "—"}</td>
                  <td style={cell}>{s.cutoff_h != null ? fmtRaceClock(race.date, s.cutoff_h) : "—"}</td>
                  <td style={{ ...cell, textAlign: "right" }}>{sp.stop_min > 0 ? `${sp.stop_min}m` : "—"}</td>
                  <td style={{ ...cell, fontSize: 9.5, color: crew ? ACCENT : MUTED, fontWeight: crew ? 700 : 400 }}>{access || "aid"}</td>
                  <td style={{ ...cell, fontSize: 9.5, whiteSpace: "nowrap" }}>
                    {s.lat != null && s.lon != null ? (
                      <a
                        href={`https://maps.google.com/?q=${s.lat},${s.lon}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{ color: INK, textDecoration: "none" }}
                      >
                        {s.lat.toFixed(4)}, {s.lon.toFixed(4)}
                      </a>
                    ) : "—"}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td style={{ ...cell, fontWeight: 700, borderBottom: "none" }} colSpan={5}>Total planned aid-station time</td>
              <td style={{ ...cell, textAlign: "right", fontWeight: 700, borderBottom: "none" }}>{fmtElapsed(proj.stopped_h)}</td>
              <td style={{ ...cell, borderBottom: "none" }} colSpan={2} />
            </tr>
          </tbody>
        </table>

        {/* notes */}
        <div style={{ marginTop: 12, fontSize: 10.5, color: INK, lineHeight: 1.6 }}>
          <b>Crew access:</b> {crewNames.join(", ")} — see the official Crew Guide for driving directions; never block forest roads.<br />
          <b>Drop bags:</b> {dropNames.join(", ")}.
          {" "}<b>Pacers:</b> from {firstPacer?.name} ({u.dist(firstPacer?.total_mi ?? 0, 0)} {u.distUnit}) onward, one at a time.<br />
          <b>Night:</b> sunset {course.sun.sunset} · sunrise {course.sun.sunrise} — headlamp in the Fish Hatchery drop bag.
          {" "}<b>If the runner drops:</b> they must report to an aid station captain — never leave the course unreported.<br />
          <span style={{ color: MUTED }}>
            ETAs from Basecamp's pacing model (best/worst = ± model band); cutoffs from the 2025 runner manual. GPS links open Google Maps — coordinates are the station point, not the parking area.
          </span>
        </div>

        {/* map */}
        <div style={{ marginTop: 16, borderTop: `1px solid ${RULE}`, paddingTop: 12 }}>
          <CourseMap course={course} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
