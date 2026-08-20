import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useBlockConfig } from "../data";
import { fmtRaceClock } from "./pacing";
import { fmtCarry, type FuelPlan, type FuelSegment, type NutritionConfig } from "./nutrition";

/* ------------------------------------------------------------------ */
/*  Fuel card — the nutrition companion to RunnerCard: a double-sided  */
/*  3×5in card of what to carry OUT of each aid station. Reuses the    */
/*  runner-card print classes (body.card-printing, .runner-card-page,  */
/*  .runner-card-break) so the 5×3in @page pipeline is shared.         */
/* ------------------------------------------------------------------ */

const INK = "#1c1c1c";
const MUTED = "#6b6b6b";
const ACCENT = "#b05c10";
const RULE = "#d8d4cc";
const WORST = "#a33b2a";
const NIGHT = "#3b4a7a";

function segFlags(seg: FuelSegment): { text: string; color: string }[] {
  const f: { text: string; color: string }[] = [];
  if (seg.heat) f.push({ text: "☀", color: ACCENT });
  if (seg.night) f.push({ text: "☾", color: NIGHT });
  return f;
}

function FuelFace({ side, pages, segments, plan, cfg }: {
  side: number;
  pages: number;
  segments: FuelSegment[];
  plan: FuelPlan;
  cfg: NutritionConfig;
}) {
  const { race } = useBlockConfig();

  const cell: React.CSSProperties = {
    padding: "1.5px 3px", borderBottom: `0.5px solid ${RULE}`, fontSize: "8.5px",
    color: INK, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", textAlign: "right",
  };
  const th: React.CSSProperties = {
    ...cell, fontSize: "6.5px", textTransform: "uppercase", letterSpacing: "0.05em",
    color: MUTED, borderBottom: `1px solid ${INK}`, fontWeight: 600,
  };

  const phaseSummary = cfg.phases
    .map((p, i) => `${p.carb_g_hr}g${i === cfg.phases.length - 1 ? "+" : `→${p.until_h}h`}`)
    .join(" · ");

  return (
    <div
      className="runner-card-face"
      style={{
        width: "4.68in", height: "2.62in", boxSizing: "border-box", overflow: "hidden",
        background: "#fff", color: INK, fontFamily: "Archivo, system-ui, sans-serif",
        display: "flex", flexDirection: "column", padding: "3px 5px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: `1.5px solid ${INK}`, paddingBottom: 1 }}>
        <span style={{ fontSize: "8px", fontWeight: 700, letterSpacing: "0.04em" }}>
          {race.short} FUEL · {side}/{pages}
        </span>
        <span style={{ fontSize: "7px", color: MUTED, fontVariantNumeric: "tabular-nums" }}>
          {phaseSummary} · Na {cfg.sodium_mg_hr}mg/h
        </span>
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", flex: 1 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Leave</th>
            <th style={th}>at</th>
            <th style={th}>carry</th>
            <th style={th}>need g</th>
            <th style={th}>gel</th>
            <th style={th}>blk</th>
            <th style={th}>tab</th>
            <th style={th}>need L</th>
            <th style={{ ...th, textAlign: "left" }}>fill</th>
            <th style={{ ...th, textAlign: "left" }}>·</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((seg) => {
            const longest = plan.segments[plan.longest_idx] === seg;
            return (
              <tr key={seg.to} style={seg.extra_fill ? { background: "#f6e4dc" } : undefined}>
                <td style={{ ...cell, textAlign: "left", fontWeight: 600 }}>
                  {seg.from.length > 14 ? `${seg.from.slice(0, 13)}…` : seg.from}
                  <span style={{ color: MUTED, fontWeight: 400 }}> →{seg.to.length > 10 ? `${seg.to.slice(0, 9)}…` : seg.to}</span>
                  {(seg.via.length > 0 || seg.water_note) && (
                    <span style={{ display: "block", fontSize: "5.5px", color: MUTED, fontWeight: 400 }}>
                      {seg.via.length > 0 ? `thru ${seg.via.join(", ")} — no resupply` : ""}
                      {seg.water_note ? `${seg.via.length ? " · " : ""}${seg.water_note}` : ""}
                    </span>
                  )}
                </td>
                <td style={{ ...cell, fontSize: "7.5px", color: MUTED }}>
                  {seg.fromIdx >= 0 ? fmtRaceClock(race.date, seg.departH) : fmtRaceClock(race.date, 0)}
                </td>
                <td style={{ ...cell, fontWeight: longest || seg.long_carry ? 700 : 400, color: longest ? WORST : INK }}>
                  {fmtCarry(seg.carryH)}
                </td>
                <td style={{ ...cell, fontWeight: 700 }}>{seg.carb_g}</td>
                <td style={{ ...cell, fontWeight: seg.gels > 0 ? 700 : 400, color: seg.gels > 0 ? INK : MUTED }}>
                  {seg.gels > 0 ? seg.gels : "·"}
                </td>
                <td style={{ ...cell, fontWeight: seg.bloks > 0 ? 700 : 400, color: seg.bloks > 0 ? INK : MUTED }}>
                  {seg.bloks > 0 ? seg.bloks : "·"}
                </td>
                <td style={{ ...cell, color: seg.salt_tabs > 0 ? INK : MUTED, fontWeight: seg.salt_tabs > 0 ? 700 : 400 }}>
                  {seg.salt_tabs > 0 ? seg.salt_tabs : "·"}
                </td>
                <td style={{ ...cell, fontWeight: seg.extra_fill ? 700 : 400, color: seg.extra_fill ? WORST : INK }}>
                  {(seg.fluid_ml / 1000).toFixed(1)}
                </td>
                <td style={{ ...cell, textAlign: "left", fontWeight: seg.extra_fill ? 700 : 400, color: seg.extra_fill ? WORST : MUTED }}>
                  {seg.fill}
                  {seg.preloads.map((p, pi) => (
                    <span key={p.at ?? "aid"} style={{ display: "block", fontSize: "5.5px", color: WORST, fontWeight: 700 }}>
                      +drink {p.ml}mL @ {p.at ? p.at.slice(0, 9) : "aid"}{seg.ration && pi === seg.preloads.length - 1 ? " · RATION" : ""}
                    </span>
                  ))}
                </td>
                <td style={{ ...cell, textAlign: "left", fontWeight: 700, fontSize: "7.5px" }}>
                  {segFlags(seg).map((f) => (
                    <span key={f.text} style={{ color: f.color, marginRight: 2 }}>{f.text}</span>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* first face carries the fill math, last face the legend + totals — a
          single-face plan stacks both rather than losing either */}
      <div style={{ fontSize: "6px", color: MUTED, paddingTop: 1.5, whiteSpace: "nowrap" }}>
        {side === 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
            <span>
              base fill: {cfg.tailwind_flasks}×{cfg.flask_ml}mL TW + 1 HCF scoop each = <b>{cfg.tailwind_flasks * cfg.flask_carb_g}g · {cfg.tailwind_flasks * cfg.flask_sodium_mg}Na</b> ·
              water flasks only when the fill says W · gel {cfg.gel.carb_g}g · blk {cfg.bloks.carb_g}g · tab {cfg.salt_tab_mg}mg
            </span>
            <span>drink alone leaves <b style={{ color: INK }}>−{plan.sodium_gap_mg_hr}Na/h</b></span>
          </div>
        )}
        {side === pages && (
          <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
            <span>
              fill = every flask you leave with: <b>M</b> = {cfg.flask_ml}mL Tailwind+HCF · <b>W</b> = plain water ·
              <b style={{ color: WORST }}> +drink @ aid</b> = water at the table before leaving · ☀ heat · ☾ night: {cfg.phases[cfg.phases.length - 1].supplement}
            </span>
            <span>total ≈ <b style={{ color: INK }}>{plan.total_gels} gel · {plan.total_bloks} blk · {plan.total_tabs} tab · {plan.total_hcf_scoops} HCF</b></span>
          </div>
        )}
      </div>
    </div>
  );
}

export function FuelCard({ plan, cfg, onClose }: {
  plan: FuelPlan;
  cfg: NutritionConfig;
  onClose: () => void;
}) {
  useEffect(() => {
    document.body.classList.add("card-printing");
    return () => document.body.classList.remove("card-printing");
  }, []);

  const split = Math.ceil(plan.segments.length / 2);
  const halves = [plan.segments.slice(0, split), plan.segments.slice(split)]
    .filter((h) => h.length > 0);

  return createPortal(
    <div
      className="runner-card"
      style={{
        position: "fixed", inset: 0, zIndex: 100, overflow: "auto",
        background: "#f6f4ef", color: INK, fontFamily: "Archivo, system-ui, sans-serif",
      }}
    >
      <style>{`@media print { @page { size: 5in 3in; margin: 0.15in; } }`}</style>

      <div style={{ maxWidth: 620, margin: "0 auto", padding: "28px 32px 48px" }}>
        <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5 }}>
            <b style={{ color: INK }}>3×5 fuel card</b> — no-crew plan: each row is a carry between true refill
            points (crew-only stations offer nothing); print side 1, re-feed flipped, print side 2.
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

        {halves.map((segments, i) => (
          <div key={i} className={i < halves.length - 1 ? "runner-card-page runner-card-break" : "runner-card-page"} style={{ marginBottom: 18 }}>
            <div className="no-print" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: MUTED, marginBottom: 4 }}>
              side {i + 1} — leaving {segments[0].from} → {segments[segments.length - 1].to}
            </div>
            <div style={{ border: `1px solid ${RULE}`, boxShadow: "0 1px 4px rgba(0,0,0,0.12)", width: "fit-content" }}>
              <FuelFace side={i + 1} pages={halves.length} segments={segments} plan={plan} cfg={cfg} />
            </div>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
