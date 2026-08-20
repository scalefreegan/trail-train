import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { useBlockConfig } from "../data";
import { fmtRaceClock } from "./pacing";
import type { FuelPlan, NutritionConfig } from "./nutrition";

/* ------------------------------------------------------------------ */
/*  Drop-bag card — one 3×5in page: what to pack in each drop bag      */
/*  (and the vest at the start) to cover all carries until the next    */
/*  restock point. No-crew assumption: these bags are the ONLY way     */
/*  personal supplies re-enter the race. Shares the runner-card print  */
/*  pipeline (body.card-printing + @page 5×3in).                       */
/* ------------------------------------------------------------------ */

const INK = "#1c1c1c";
const MUTED = "#6b6b6b";
const RULE = "#d8d4cc";
const NIGHT = "#3b4a7a";

export function DropBagCard({ plan, cfg, onClose }: {
  plan: FuelPlan;
  cfg: NutritionConfig;
  onClose: () => void;
}) {
  const { race } = useBlockConfig();

  useEffect(() => {
    document.body.classList.add("card-printing");
    return () => document.body.classList.remove("card-printing");
  }, []);

  const cell: React.CSSProperties = {
    padding: "3px 4px", borderBottom: `0.5px solid ${RULE}`, fontSize: "9.5px",
    color: INK, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", textAlign: "right",
  };
  const th: React.CSSProperties = {
    ...cell, fontSize: "7px", textTransform: "uppercase", letterSpacing: "0.05em",
    color: MUTED, borderBottom: `1px solid ${INK}`, fontWeight: 600,
  };

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
            <b style={{ color: INK }}>3×5 drop-bag card</b> — pack list per bag (single side);
            each row covers every carry until the next restock.
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

        <div className="runner-card-page" style={{ marginBottom: 18 }}>
          <div style={{ border: `1px solid ${RULE}`, boxShadow: "0 1px 4px rgba(0,0,0,0.12)", width: "fit-content" }}>
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
                  {race.short} DROP BAGS · no crew
                </span>
                <span style={{ fontSize: "7px", color: MUTED }}>
                  bags are the only restock — pack these + spares
                </span>
              </div>

              <table style={{ width: "100%", borderCollapse: "collapse", flex: 1 }}>
                <thead>
                  <tr>
                    <th style={{ ...th, textAlign: "left" }}>Bag</th>
                    <th style={th}>eta</th>
                    <th style={{ ...th, textAlign: "left" }}>covers</th>
                    <th style={th}>gel</th>
                    <th style={th}>blk</th>
                    <th style={th}>hcf</th>
                    <th style={th}>tab</th>
                    <th style={{ ...th, textAlign: "left" }}>also</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.drop_bags.map((bag) => (
                    <React.Fragment key={bag.station}>
                      <tr>
                        <td style={{ ...cell, textAlign: "left", fontWeight: 700, borderBottom: "none" }}>{bag.station}</td>
                        <td style={{ ...cell, fontSize: "8.5px", color: MUTED, borderBottom: "none" }}>
                          {bag.atH > 0 ? fmtRaceClock(race.date, bag.atH) : "—"}
                        </td>
                        <td style={{ ...cell, textAlign: "left", fontSize: "8.5px", color: MUTED, borderBottom: "none" }}>{bag.covers}</td>
                        <td style={{ ...cell, fontWeight: 700, borderBottom: "none" }}>{bag.gels}</td>
                        <td style={{ ...cell, fontWeight: bag.bloks > 0 ? 700 : 400, color: bag.bloks > 0 ? INK : MUTED, borderBottom: "none" }}>
                          {bag.bloks > 0 ? bag.bloks : "·"}
                        </td>
                        <td style={{ ...cell, fontWeight: 700, borderBottom: "none" }}>{bag.hcf_scoops}</td>
                        <td style={{ ...cell, fontWeight: bag.salt_tabs > 0 ? 700 : 400, color: bag.salt_tabs > 0 ? INK : MUTED, borderBottom: "none" }}>
                          {bag.salt_tabs > 0 ? bag.salt_tabs : "·"}
                        </td>
                        <td style={{ ...cell, textAlign: "left", fontSize: "8px", borderBottom: "none" }}>
                          {bag.night && <span style={{ color: NIGHT, fontWeight: 700 }}>☾ night ahead </span>}
                          {bag.station === "Start" ? `${cfg.tailwind_flasks + (cfg.spare_flask_ml > 0 ? 3 : 2)} flasks: ${cfg.tailwind_flasks} mix · 1 water · ${cfg.spare_flask_ml > 0 ? 2 : 1} empty` : ""}
                        </td>
                      </tr>
                      {bag.gear.length > 0 && (
                        <tr>
                          <td colSpan={8} style={{ ...cell, textAlign: "left", fontSize: "7px", color: MUTED, paddingTop: 0 }}>
                            <b style={{ color: INK }}>gear:</b> {bag.gear.join(" · ")}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                  <tr>
                    <td style={{ ...cell, textAlign: "left", fontWeight: 700, borderBottom: "none" }} colSpan={3}>race total</td>
                    <td style={{ ...cell, fontWeight: 700, borderBottom: "none" }}>{plan.total_gels}</td>
                    <td style={{ ...cell, fontWeight: 700, borderBottom: "none" }}>{plan.total_bloks}</td>
                    <td style={{ ...cell, fontWeight: 700, borderBottom: "none" }}>{plan.total_hcf_scoops}</td>
                    <td style={{ ...cell, fontWeight: 700, borderBottom: "none" }}>{plan.total_tabs}</td>
                    <td style={{ ...cell, borderBottom: "none" }} />
                  </tr>
                </tbody>
              </table>

              <div style={{ fontSize: "6px", color: MUTED, paddingTop: 1.5 }}>
                add <b>+1 gel · +1 tab spare per bag</b> · hcf = High Carb scoops (1 per flask fill; aid supplies base Tailwind)
                · gel {cfg.gel.carb_g}g · blk pack {cfg.bloks.carb_g}g · edit gear + constants in nutrition.json
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
