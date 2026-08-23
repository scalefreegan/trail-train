import { useMemo, useState } from "react";
import { useBlockConfig, useMeasuredWidth } from "../data";
import { SectionTag } from "../atoms";
import { useRacePlan } from "./useRacePlan";
import { planCaffeine, heatBands, sunBounds, type CaffeinePlan } from "./caffeine";
import { fmtCarry, type FuelSegment } from "./nutrition";
import { fmtElapsed, fmtRaceClock } from "./pacing";

/* ------------------------------------------------------------------ */
/*  Nutrition plan — the whole intake picture in one place: race week, */
/*  the course itself, and recovery, with the reasoning attached to    */
/*  every number rather than living in someone's head.                 */
/*                                                                    */
/*  Everything on the course side is derived from the same projection  */
/*  the planner uses (useRacePlan), so moving the goal slider moves    */
/*  the fuel table and the caffeine schedule together. Nothing here is */
/*  a transcribed constant except the guidance prose.                  */
/* ------------------------------------------------------------------ */

const NIGHT_TINT = "rgba(127, 196, 216, 0.10)";
const HEAT_TINT = "rgba(240, 102, 77, 0.09)";
const BAND_TINT = "rgba(143, 212, 154, 0.12)";

/* ---- small presentational pieces ---- */

function Card({ title, meta, accent, children, why }: {
  title: string;
  meta?: string;
  accent?: "lamp" | "ember";
  children: React.ReactNode;
  why: { label: string; body: string };
}) {
  return (
    <div
      className="panel"
      style={{
        padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8,
        borderColor: accent === "lamp" ? "var(--lamp-deep)" : accent === "ember" ? "#5a2f26" : "var(--edge)",
        background: accent === "lamp" ? "linear-gradient(var(--lamp-glow), var(--lamp-glow)), var(--panel)" : "var(--panel)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--mist)" }}>{title}</span>
        {meta && <span className="eyebrow numerals" style={{ fontSize: 9, whiteSpace: "nowrap" }}>{meta}</span>}
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--mist-dim)", display: "flex", flexDirection: "column", gap: 5 }}>
        {children}
      </div>
      <div style={{ borderTop: "1px dashed var(--edge-bright)", paddingTop: 8, marginTop: "auto" }}>
        <span className="eyebrow" style={{ fontSize: 8, color: "var(--lamp-deep)", display: "block", marginBottom: 3 }}>{why.label}</span>
        <span style={{ fontSize: 11.5, lineHeight: 1.55, color: "var(--mist-mute)" }}>{why.body}</span>
      </div>
    </div>
  );
}

function Cards({ children, min = 260 }: { children: React.ReactNode; min?: number }) {
  return (
    <div style={{ display: "grid", gap: 10, gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` }}>
      {children}
    </div>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 7, alignItems: "baseline" }}>
      <span style={{ color: "var(--mist-mute)", flex: "0 0 auto", lineHeight: 1.6 }}>·</span>
      <span>{children}</span>
    </div>
  );
}

const B = ({ children }: { children: React.ReactNode }) => (
  <strong style={{ color: "var(--mist)", fontWeight: 600 }}>{children}</strong>
);
const N = ({ children }: { children: React.ReactNode }) => (
  <span className="numerals" style={{ color: "var(--mist)" }}>{children}</span>
);

function Vital({ k, v, unit, accent }: { k: string; v: string; unit?: string; accent?: string }) {
  return (
    <div style={{ background: "var(--panel)", padding: "9px 13px" }}>
      <span className="eyebrow" style={{ fontSize: 8, display: "block" }}>{k}</span>
      <span className="numerals" style={{ fontSize: 17, color: accent ?? "var(--mist)", display: "block", marginTop: 2 }}>
        {v}{unit && <span style={{ fontSize: 10.5, color: "var(--mist-dim)" }}> {unit}</span>}
      </span>
    </div>
  );
}

/* ---- caffeine body-load chart ---- */

const CH = { h: 300, top: 18, right: 14, bottom: 40, left: 46 };

function CaffeineChart({ caf, raceStart, finishH, heat, night, kg }: {
  caf: CaffeinePlan;
  raceStart: Date;
  finishH: number;
  heat: Array<[number, number]>;
  night: Array<[number, number]>;
  kg: number;
}) {
  const { ref, width } = useMeasuredWidth();
  const [hover, setHover] = useState<{ h: number; mg: number; x: number; y: number } | null>(null);

  const x0 = caf.curve[0]?.h ?? -1.5;
  const x1 = finishH + 0.5;
  const yMax = Math.max(caf.band.hi_mg * 1.08, caf.peak.mg * 1.15, 100);
  const plotW = Math.max(0, width - CH.left - CH.right);
  const plotH = CH.h - CH.top - CH.bottom;
  const px = (h: number) => CH.left + ((h - x0) / (x1 - x0)) * plotW;
  const py = (mg: number) => CH.top + (1 - mg / yMax) * plotH;

  // not memoised: px/py are rebuilt every render anyway, so a dependency array
  // here would either lie or defeat itself. ~700 points of string building is
  // cheap next to the layout it feeds.
  const path = caf.curve
    .map((p, i) => `${i ? "L" : "M"}${px(p.h).toFixed(1)} ${py(p.mg).toFixed(1)}`)
    .join(" ");

  // Guard the PLOT area, not the container. At any width in [40, 60] the
  // margins alone consume everything, plotW is 0, every point maps to the same
  // x, and onMove's divide-by-plotW yields NaN — which passes the range check
  // below (NaN comparisons are false both ways) and indexes the curve with NaN.
  // Require enough room for the margins plus a usable plot.
  if (width < CH.left + CH.right + 40) return <div ref={ref} style={{ height: CH.h }} />;

  const gridStep = yMax > 600 ? 200 : 100;
  const ticks: number[] = [];
  for (let g = 0; g <= yMax; g += gridStep) ticks.push(g);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const h = x0 + ((e.clientX - r.left) / r.width * width - CH.left) / plotW * (x1 - x0);
    // !(in range) rather than (out of range): a NaN h fails BOTH `<` and `>`,
    // so the positive form would let it through into the index arithmetic
    if (!(h >= x0 && h <= x1)) { setHover(null); return; }
    // nearest sample rather than re-integrating the dose list per mousemove
    const step = caf.curve.length > 1 ? caf.curve[1].h - caf.curve[0].h : 0;
    if (!(step > 0)) return;
    const i = Math.min(caf.curve.length - 1, Math.max(0, Math.round((h - x0) / step)));
    const p = caf.curve[i];
    if (!p) return;
    setHover({ h: p.h, mg: p.mg, x: px(p.h), y: py(p.mg) });
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${width} ${CH.h}`} style={{ display: "block", width: "100%", height: CH.h }}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Caffeine on board across the race. Peak ${Math.round(caf.peak.mg)} milligrams, ${caf.peak.mg_kg.toFixed(1)} milligrams per kilogram, ${caf.over_band ? "above" : "inside"} the ergogenic band.`}
      >
        {heat.map(([a, b], i) => (
          <rect key={`ht${i}`} x={px(a)} y={CH.top} width={Math.max(0, px(b) - px(a))} height={plotH} fill={HEAT_TINT} />
        ))}
        {night.map(([a, b], i) => (
          <rect key={`ni${i}`} x={px(a)} y={CH.top} width={Math.max(0, px(b) - px(a))} height={plotH} fill={NIGHT_TINT} />
        ))}

        {/* ergogenic band — the whole point of the chart */}
        <rect
          x={CH.left} y={py(caf.band.hi_mg)} width={plotW}
          height={Math.max(0, py(caf.band.lo_mg) - py(caf.band.hi_mg))} fill={BAND_TINT}
        />
        {[caf.band.lo_mg, caf.band.hi_mg].map((v, i) => (
          <line
            key={`bd${i}`} x1={CH.left} x2={CH.left + plotW} y1={py(v)} y2={py(v)}
            stroke="rgba(143, 212, 154, 0.45)" strokeWidth={1} strokeDasharray="4 4"
          />
        ))}

        {ticks.map((v) => (
          <g key={`y${v}`}>
            <line x1={CH.left} x2={CH.left + plotW} y1={py(v)} y2={py(v)} stroke="var(--edge)" strokeWidth={1} />
            <text x={CH.left - 7} y={py(v) + 3.5} textAnchor="end" className="numerals" fontSize={9.5} fill="var(--mist-mute)">{v}</text>
          </g>
        ))}
        <text x={CH.left - 7} y={CH.top - 6} textAnchor="end" className="eyebrow" fontSize={8} fill="var(--mist-mute)">mg</text>

        {Array.from({ length: Math.floor(finishH / 4) + 1 }, (_, i) => i * 4).map((h) => (
          <g key={`x${h}`}>
            <line x1={px(h)} x2={px(h)} y1={CH.h - CH.bottom} y2={CH.h - CH.bottom + 4} stroke="var(--edge-bright)" strokeWidth={1} />
            <text x={px(h)} y={CH.h - CH.bottom + 16} textAnchor="middle" className="numerals" fontSize={9.5} fill="var(--mist-mute)">
              {fmtRaceClock(raceStart, h)}
            </text>
          </g>
        ))}

        <path d={`${path} L${px(x1).toFixed(1)} ${py(0).toFixed(1)} L${px(x0).toFixed(1)} ${py(0).toFixed(1)} Z`} fill="var(--lamp)" opacity={0.13} />
        <path d={path} fill="none" stroke="var(--lamp)" strokeWidth={1.8} strokeLinejoin="round" />

        {caf.doses.map((d) => {
          const y = py(caf.curve[Math.min(caf.curve.length - 1, Math.round((d.h + 0.02 - x0) / (caf.curve[1].h - caf.curve[0].h)))]?.mg ?? 0);
          return (
            <g key={d.n}>
              <line x1={px(d.h)} x2={px(d.h)} y1={y} y2={CH.h - CH.bottom} stroke="var(--lamp)" strokeWidth={1} opacity={0.28} />
              <circle cx={px(d.h)} cy={y} r={4} fill="var(--night)" stroke="var(--lamp)" strokeWidth={1.8} />
              <text x={px(d.h)} y={y - 9} textAnchor="middle" className="numerals" fontSize={9} fill="var(--lamp)">{d.n}</text>
            </g>
          );
        })}

        {hover && (
          <g>
            <line x1={hover.x} x2={hover.x} y1={CH.top} y2={CH.h - CH.bottom} stroke="var(--mist)" strokeWidth={1} opacity={0.35} />
            <circle cx={hover.x} cy={hover.y} r={3.5} fill="var(--lamp)" stroke="var(--night)" strokeWidth={1.5} />
          </g>
        )}
      </svg>

      {hover && (
        <div
          className="numerals"
          style={{
            position: "absolute", pointerEvents: "none", zIndex: 3,
            left: Math.min(Math.max(0, hover.x + 12), Math.max(0, width - 128)),
            top: Math.max(0, hover.y - 16),
            background: "var(--night-deep)", border: "1px solid var(--edge-bright)",
            padding: "5px 8px", fontSize: 10.5, lineHeight: 1.5, color: "var(--mist)", whiteSpace: "nowrap",
          }}
        >
          {fmtRaceClock(raceStart, hover.h)} · {fmtElapsed(hover.h)}<br />
          {Math.round(hover.mg)} mg on board<br />
          {(hover.mg / kg).toFixed(1)} mg/kg
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 6 }}>
        {[
          ["caffeine on board", "var(--lamp)"],
          ["ergogenic band", "rgba(143, 212, 154, 0.5)"],
          ["darkness", "rgba(127, 196, 216, 0.45)"],
          ["heat window", "rgba(240, 102, 77, 0.45)"],
        ].map(([label, color]) => (
          <span key={label} className="eyebrow" style={{ fontSize: 8, display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 14, height: 8, background: color, display: "inline-block" }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---- leg table ---- */

function LegRow({ seg, caf, raceStart, last }: {
  seg: FuelSegment; caf: number; raceStart: Date; last: boolean;
}) {
  const flags: Array<[string, string]> = [];
  if (seg.heat) flags.push(["heat", "var(--ember)"]);
  if (seg.night) flags.push(["night", "var(--creek)"]);
  if (seg.long_carry) flags.push(["long", "var(--mist-mute)"]);
  const cell: React.CSSProperties = {
    padding: "7px 9px", textAlign: "right", fontSize: 11.5,
    borderBottom: last ? "none" : "1px solid var(--edge)", whiteSpace: "nowrap",
  };
  return (
    <>
      <div style={{ ...cell, textAlign: "left", whiteSpace: "normal" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--mist)" }}>{seg.from} → {seg.to}</span>
        <span className="numerals" style={{ display: "block", fontSize: 9.5, color: "var(--mist-mute)", marginTop: 1 }}>
          {fmtRaceClock(raceStart, seg.departH)} → {fmtRaceClock(raceStart, seg.arriveH)}
          {seg.via.length > 0 && ` · thru ${seg.via.join(", ")}`}
          {seg.water_note && ` · ${seg.water_note}`}
        </span>
        {flags.length > 0 && (
          <span style={{ display: "inline-flex", gap: 4, marginTop: 3 }}>
            {flags.map(([f, c]) => (
              <span key={f} className="eyebrow" style={{ fontSize: 7.5, color: c, border: `1px solid ${c}`, padding: "0 4px" }}>{f}</span>
            ))}
          </span>
        )}
      </div>
      <div className="numerals" style={cell}>{fmtCarry(seg.carryH)}</div>
      <div className="numerals" style={cell}>{seg.carb_g} g</div>
      <div className="numerals" style={cell}>{seg.gels || <span style={{ color: "var(--mist-mute)" }}>—</span>}</div>
      {/* the caffeine schedule is placed by darkness, not by carb demand, so a
          dose can land on a leg whose carb target rounds to fewer gels than the
          doses it carries. Say so rather than rendering "— gels, 1 caf". */}
      <div
        className="numerals"
        title={caf > seg.gels
          ? `${caf} caffeinated gel${caf > 1 ? "s" : ""} on a leg the fuel model only asks ${seg.gels} gel${seg.gels === 1 ? "" : "s"} for — you carry ${caf}, and the extra ${(caf - seg.gels) * 25} g of carbs rides along above target.`
          : undefined}
        style={{
          ...cell,
          color: caf > seg.gels ? "var(--ember)" : caf > 0 ? "var(--lamp)" : "var(--mist-mute)",
          fontWeight: caf > 0 ? 600 : 400,
        }}
      >
        {caf || "—"}{caf > seg.gels && "*"}
      </div>
      <div className="numerals" style={cell}>{seg.bloks || <span style={{ color: "var(--mist-mute)" }}>—</span>}</div>
      <div className="numerals" style={cell}>{seg.salt_tabs || <span style={{ color: "var(--mist-mute)" }}>—</span>}</div>
      <div className="numerals" style={cell}>{(seg.fluid_ml / 1000).toFixed(1)} L</div>
      <div className="numerals" style={cell}>{seg.fill}</div>
      <div className="numerals" style={cell}>
        {seg.preloads.length
          ? seg.preloads.map((p) => `${p.ml}`).join(" + ")
          : <span style={{ color: "var(--mist-mute)" }}>—</span>}
      </div>
    </>
  );
}

/* ---- the view ---- */

export function NutritionPlan() {
  const { race } = useBlockConfig();
  const { course, missing, error, proj, nutrition, fuelPlan, raceStart, nutritionError } = useRacePlan();
  const cfg = nutrition.caffeine;

  const caf = useMemo(
    () => (course && proj && fuelPlan ? planCaffeine(proj, course, fuelPlan, raceStart, cfg) : null),
    [course, proj, fuelPlan, raceStart, cfg],
  );

  const finishH = proj?.finish_h.avg ?? 0;
  const startClock = raceStart.getHours() + raceStart.getMinutes() / 60;
  const heat = useMemo(
    () => (course ? heatBands(startClock, nutrition.heat_window.start, nutrition.heat_window.end, finishH) : []),
    [course, startClock, nutrition.heat_window, finishH],
  );
  const night = useMemo(
    () => (course ? sunBounds(course, raceStart, finishH) : []),
    [course, raceStart, finishH],
  );

  if (missing || !course) {
    return (
      <section>
        <SectionTag>nutrition plan</SectionTag>
        <div className="panel notch" style={{ padding: "28px 26px" }}>
          <span className="eyebrow" style={{ color: missing || error ? "var(--ember)" : "var(--mist-mute)" }}>
            {missing
              ? "no course data — run `npm run course:build` to parse the race gpx"
              : error ?? "loading course…"}
          </span>
        </div>
      </section>
    );
  }

  if (!proj || !fuelPlan || !caf) {
    return (
      <section>
        <SectionTag>nutrition plan</SectionTag>
        <div className="panel notch" style={{ padding: "28px 26px" }}>
          <span className="eyebrow" style={{ color: "var(--mist-mute)" }}>
            no pacing fit yet — sync Strava so the projection (and everything derived from it) has something to stand on
          </span>
        </div>
      </section>
    );
  }

  const kg = cfg.body_kg;
  const g = (perKg: number) => Math.round(perKg * kg);
  const cafGels = caf.doses.length;
  const plainGels = Math.max(0, fuelPlan.total_gels - cafGels);
  const goalH = proj.goal_h;

  const colHead = ["leg", "carry", "carb", "gels", "↳ caf", "bloks", "tabs", "fluid", "fill", "pre-load"];
  const gridCols = "minmax(190px, 1.6fr) repeat(9, minmax(52px, auto))";

  return (
    <section>
      {/* ---------------- masthead ---------------- */}
      <SectionTag right={
        <span className="eyebrow" style={{ fontSize: 9 }}>
          {race.short} · {fmtElapsed(finishH)} projected
        </span>
      }>
        nutrition plan
      </SectionTag>

      <div className="panel notch" style={{ padding: "18px 20px 16px" }}>
        <div style={{ fontSize: 13, color: "var(--mist-dim)", lineHeight: 1.6, maxWidth: "68ch" }}>
          Everything that goes in, from race week to the Monday after. The course side is derived live from the expected
          projection — move the pacing sliders in the planner and the legs, the drop bags and the caffeine schedule
          all follow.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))", gap: 1, background: "var(--edge)", border: "1px solid var(--edge)", marginTop: 14 }}>
          <Vital k="carbs" v={String(Math.round(fuelPlan.total_carb_g))} unit="g" />
          <Vital k="gels" v={String(fuelPlan.total_gels)} />
          <Vital k="caffeinated" v={String(cafGels)} accent="var(--lamp)" />
          <Vital k="blok pks" v={String(fuelPlan.total_bloks)} />
          <Vital k="salt tabs" v={String(fuelPlan.total_tabs)} />
          <Vital k="hcf scoops" v={String(fuelPlan.total_hcf_scoops)} />
          <Vital k="peak caf" v={caf.peak.mg_kg.toFixed(1)} unit="mg/kg" accent={caf.over_band ? "var(--ember)" : "var(--mist)"} />
          <Vital k="body mass" v={String(kg)} unit="kg" />
        </div>
      </div>

      {/* ---------------- read first ---------------- */}
      <SectionTag right={<span className="eyebrow" style={{ fontSize: 9 }}>before you buy anything</span>}>read first</SectionTag>
      <Cards>
        <Card
          title="Check the Tailwind flavor"
          accent="lamp"
          why={{
            label: "why it matters",
            body: `The plan fills ${fuelPlan.total_hcf_scoops} mix flasks across the race. A caffeinated flavor at ~35 mg per scoop would add roughly ${Math.round(fuelPlan.total_hcf_scoops * 35)} mg of untracked caffeine on top of the ${caf.gel_mg_total} mg from gels — enough on its own to push peak load past the ceiling this page is built around.`,
          }}
        >
          <Li>Confirm the mix is a <B>non-caffeinated</B> flavor.</Li>
          <Li>Nothing else in this plan assumes caffeine from the drink.</Li>
        </Card>

        <Card
          title="The clock follows the projection"
          accent="ember"
          meta={goalH != null ? `goal ${fmtElapsed(goalH)}` : "no goal set"}
          why={{
            label: "why it still holds",
            body: "Nightfall and the aid stations don't move when your pace does, and every dose is anchored to one or the other. Trust the place column over the clock column and the schedule survives a finish well either side of the projection.",
          }}
        >
          <Li>Times here come from the <B>expected</B> projection, {fmtElapsed(finishH)} — your pacing fit, not your goal.</Li>
          {goalH != null && (
            <Li>
              Your typed goal is {fmtElapsed(goalH)}, {fmtElapsed(Math.abs(finishH - goalH))}{" "}
              {goalH < finishH ? "faster" : "slower"} — this page plans for the projection.
            </Li>
          )}
          <Li>Move fatigue, calibration or restraint in the planner and this page follows.</Li>
        </Card>

        <Card
          title="Hot legs may over-prescribe gels"
          accent="ember"
          why={{
            label: "what to do about it",
            body: "This is a known open issue in the fueling model, not a transcription error. On heat-flagged legs treat the gel count as a ceiling rather than a quota — if the mix is going down, you need fewer than the table says.",
          }}
        >
          <Li>On hot legs with no plain-water flask, forced mix intake can exceed the model's sipping-rate credit.</Li>
          <Li>The gap is then re-prescribed as gels — up to <N>+13 g/hr</N> over target.</Li>
          <Li>{fuelPlan.segments.filter((s) => s.heat).length} of {fuelPlan.segments.length} legs carry the heat flag.</Li>
        </Card>
      </Cards>

      {/* ---------------- caffeine ---------------- */}
      <SectionTag right={
        <span className="eyebrow numerals" style={{ fontSize: 9, color: caf.over_band ? "var(--ember)" : "var(--mist-mute)" }}>
          {cafGels} gels · {caf.gel_mg_total} mg · peak {caf.peak.mg_kg.toFixed(1)} mg/kg
        </span>
      }>
        caffeine load
      </SectionTag>

      <div className="panel" style={{ padding: "14px 16px 12px" }}>
        <CaffeineChart caf={caf} raceStart={raceStart} finishH={finishH} heat={heat} night={night} kg={kg} />
        <div style={{ fontSize: 11.5, color: "var(--mist-mute)", lineHeight: 1.55, marginTop: 10, maxWidth: "76ch" }}>
          Single-compartment decay at a {cfg.half_life_h} h half-life against {kg} kg, including the {cfg.pre_race_mg} mg
          race-morning coffee and {cfg.cola_cups} aid-station colas at {cfg.cola_mg} mg each. The shaded band is{" "}
          {cfg.band_lo_mg_kg}–{cfg.band_hi_mg_kg} mg/kg ({Math.round(caf.band.lo_mg)}–{Math.round(caf.band.hi_mg)} mg):
          below it caffeine does nothing, above it the dose–response curve is flat and only the side effects keep scaling.
          {caf.over_band && <span style={{ color: "var(--ember)" }}> Peak load is above the band — reduce <code>caffeine.gels</code>.</span>}
          {caf.note && <span style={{ color: "var(--lamp)" }}> {caf.note}</span>}
        </div>
      </div>

      {caf.doses.length > 0 && (
        <div className="panel" style={{ marginTop: 10, display: "grid", gap: 1, background: "var(--edge)" }}>
          {caf.doses.map((d, i) => (
            <div
              key={d.n}
              style={{
                background: d.night ? "linear-gradient(90deg, rgba(127,196,216,0.06), transparent), var(--panel)" : "var(--panel)",
                padding: "8px 14px", display: "grid", gap: "2px 14px",
                gridTemplateColumns: "22px 74px 62px minmax(0, 1fr)", alignItems: "baseline",
              }}
            >
              <span className="numerals" style={{ fontSize: 12, color: "var(--lamp)" }}>{d.n}</span>
              <span className="numerals" style={{ fontSize: 12, color: "var(--mist)" }}>{fmtRaceClock(raceStart, d.h)}</span>
              <span className="numerals" style={{ fontSize: 10.5, color: "var(--mist-mute)" }}>mi {d.mi.toFixed(1)}</span>
              <span style={{ fontSize: 12, color: "var(--mist-dim)" }}>
                {d.station
                  ? <><B>{d.station}</B>, on the way out</>
                  : <>mid-leg · {fuelPlan.segments[d.segIdx].from} → {fuelPlan.segments[d.segIdx].to}</>}
                <span style={{ color: "var(--mist-mute)" }}>
                  {" · "}from the {d.bag === "Start" ? "vest" : `${d.bag} bag`}
                  {i > 0 && ` · ${fmtCarry(d.h - caf.doses[i - 1].h)} since the last`}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <Cards>
          <Card
            title="Nothing before nightfall"
            meta={`first dose ${caf.doses.length ? fmtRaceClock(raceStart, caf.doses[0].h) : "—"}`}
            why={{
              label: "why",
              body: "For a habitual coffee drinker a dose in daylight does almost nothing except raise the baseline you'll be dosing against at 3 a.m. Holding the first half dry is what makes the night doses work at all — it is the highest-leverage decision on this page.",
            }}
          >
            <Li>No gel caffeine for the first <N>{caf.window ? fmtElapsed(caf.window.fromH) : "—"}</N>.</Li>
            <Li>The morning coffee is the only caffeine before dark.</Li>
          </Card>
          <Card
            title="Spacing sets the plateau"
            meta={`~${cfg.min_spacing_h}–2.3 h apart`}
            why={{
              label: "why not one big dose",
              body: "A single large dose spikes and crashes. Even spacing holds a steady plateau through the circadian low and into the finish, so you are not flat for the last marathon — which is exactly where a hundred-miler is won or lost.",
            }}
          >
            <Li>{cafGels} doses of <N>{cfg.gel_mg} mg</N>, never closer than <N>{cfg.min_spacing_h} h</N>.</Li>
            <Li>Peak <N>{Math.round(caf.peak.mg)} mg</N> at {fmtRaceClock(raceStart, caf.peak.h)}.</Li>
          </Card>
          <Card
            title="Caffeine is the first thing to drop"
            accent="ember"
            why={{
              label: "why",
              body: `${cfg.gel_mg} mg on top of 70 g/hr of carbohydrate is a well-known route to GI shutdown, and a shut gut ends races that tired legs do not. Caffeine is the most expendable item in the plan — carbs, fluid and sodium are not.`,
            }}
          >
            <Li>Nauseous at night? <B>Skip the next dose</B> rather than pushing through.</Li>
            <Li>Then drop solids before you ever cut the carb rate.</Li>
          </Card>
          <Card
            title="What the ceiling costs"
            meta={`${Math.round(caf.at_finish_mg)} mg at the finish`}
            why={{
              label: "the honest trade",
              body: "This is what the higher dose buys and it is worth naming: Sunday night's sleep will be worse than it would be on half the gels. You will likely sleep anyway after a hundred miles, but sleep is the largest single lever on recovery — so don't spend more of it than the plan already does.",
            }}
          >
            <Li>All-in total across the race: <N>{Math.round(caf.total_mg)} mg</N>.</Li>
            <Li>Well past the 400 mg/day general guideline — that figure is not an exercise ceiling, but the gap is deliberate rather than overlooked.</Li>
          </Card>
        </Cards>
      </div>

      {/* ---------------- before ---------------- */}
      <SectionTag right={<span className="eyebrow" style={{ fontSize: 9 }}>wed → the gun</span>}>before</SectionTag>
      <Cards>
        <Card
          title="Carbohydrate"
          meta="thu–fri"
          why={{
            label: "why not a full 10–12 g/kg load",
            body: "Classic carb-loading is built for marathon-intensity racing where glycogen is the binding constraint. At hundred-mile pace you burn a far higher share of fat and you eat continuously on the move, so the extra few hundred grams a day buys mostly water weight and gut bloat. Topped up beats stuffed.",
          }}
        >
          <Li>Thu &amp; Fri: <B>~7 g/kg/day</B> → about <N>{g(7)} g</N> of carbs a day.</Li>
          <Li>Friday: shift to <B>low-fibre</B> sources — white rice, potatoes, pasta, bananas, juice.</Li>
          <Li>Displace fat and protein rather than eating more on top.</Li>
        </Card>
        <Card
          title="Caffeine taper"
          meta="wed–fri"
          why={{
            label: "why a partial taper",
            body: "Evidence that a full washout amplifies the effect is weak, and the cost is certain: withdrawal headache, flat mood and poor sleep in the exact week you are trying to arrive rested. A modest cut recovers some sensitivity at almost no cost. The Friday cutoff is about sleep, not sensitivity.",
          }}
        >
          <Li>Wed–Fri: down to <B>one cup a day</B>.</Li>
          <Li><B>Nothing after noon Friday.</B></Li>
          <Li>Do <em>not</em> attempt a full withdrawal.</Li>
        </Card>
        <Card
          title="Fluid &amp; sodium"
          meta="thu–fri"
          why={{
            label: "why not more water",
            body: "Over-drinking before a hot race dilutes plasma sodium before you have lost a gram of it — the wrong side of the ledger to start on. The plan already asks for a high sodium rate on course; arrive with sodium aboard and normal hydration, not a full tank.",
          }}
        >
          <Li>Salt food generously Thursday and Friday.</Li>
          <Li>Drink to thirst — pale yellow, not clear.</Li>
          <Li>No pre-race water loading.</Li>
        </Card>
        <Card
          title="Sleep"
          meta="tue–thu"
          why={{
            label: "why",
            body: "Nobody sleeps well before a pre-dawn hundred-mile start, and forcing it just adds anxiety. Sleep debt is cumulative and partially repayable in advance — the nights that help are two and three out, so spend the effort there and let Friday be what it is.",
          }}
        >
          <Li>Bank sleep <B>Tuesday through Thursday</B>.</Li>
          <Li>Treat Friday night as a write-off.</Li>
        </Card>
        <Card
          title="Race morning"
          accent="lamp"
          meta={`${fmtRaceClock(raceStart, -2.25)} → the gun`}
          why={{
            label: "why two hours before the gun",
            body: "It leaves time for gastric emptying and one unhurried bathroom stop, and puts the insulin response from breakfast well behind you before the first climb. The fluid cutoff is the same logic applied to your bladder. The coffee goes with breakfast so its peak has passed by the start — you do not want caffeine sharpening your legs at mile two.",
          }}
        >
          <Li>Breakfast <B>1–2 g/kg carb</B> → <N>{g(1)}–{g(2)} g</N>. Low fibre, low fat, nothing new.</Li>
          <Li>Coffee, <N>{cfg.pre_race_mg} mg</N> — dose zero, already counted in the curve above.</Li>
          <Li><N>500 mL</N> with electrolyte, finished ~45 min before the start.</Li>
          <Li>One plain gel at the line if you want it.</Li>
        </Card>
      </Cards>

      {/* ---------------- during ---------------- */}
      <SectionTag right={
        <span className="eyebrow numerals" style={{ fontSize: 9 }}>{fuelPlan.segments.length} legs · {fmtElapsed(finishH)}</span>
      }>
        during
      </SectionTag>

      <Cards>
        <Card
          title="Carbs taper down"
          meta={`${nutrition.phases[0].carb_g_hr} → ${nutrition.phases[nutrition.phases.length - 1].carb_g_hr} g/hr`}
          why={{
            label: "why it falls",
            body: `Gut absorption degrades over a long race and your ability to hold a plan degrades faster. The taper is realism, not surrender — a paper target of ${nutrition.phases[0].carb_g_hr} g/hr at hour 28 just becomes uneaten gels in a pocket. The ${nutrition.carb_cap_over_h} h cap exists for the same reason: nobody holds target through a four-hour climb.`,
          }}
        >
          {/* index in the key: normalizeNutrition sorts phases but never dedupes
              them, so a hand-edited nutrition.json with two phases sharing an
              until_h would collide on until_h alone */}
          {nutrition.phases.map((p, i) => (
            <Li key={`${p.until_h}-${i}`}>
              <N>{p.carb_g_hr} g/hr</N> {i === 0 ? "to" : "→"} hour {p.until_h}
              <span style={{ color: "var(--mist-mute)" }}> · {p.supplement}</span>
            </Li>
          ))}
          <Li>Carries over <N>{nutrition.carb_cap_over_h} h</N> capped at <N>{nutrition.carb_cap_g_hr} g/hr</N>.</Li>
        </Card>
        <Card
          title="Sodium holds flat"
          meta={`${nutrition.sodium_mg_hr} mg/hr`}
          why={{
            label: "why it doesn't taper",
            body: "Sweat sodium concentration doesn't fall as the race goes on the way appetite does, and the back half runs through a second hot afternoon. Tab counts climb late because the mix volume you are actually drinking falls while the losses don't.",
          }}
        >
          <Li>Mix carries <N>{nutrition.flask_sodium_mg} mg</N> per flask.</Li>
          <Li>Tabs at <N>{nutrition.salt_tab_mg} mg</N> each make up the gap.</Li>
          <Li>Drink alone leaves <N>{Math.round(fuelPlan.sodium_gap_mg_hr)} mg/hr</N> uncovered.</Li>
        </Card>
        <Card
          title="Fluid follows heat"
          meta={`${nutrition.fluid_ml_hr} → ${nutrition.fluid_ml_hr_heat} mL/hr`}
          why={{
            label: "why the pre-load column",
            body: "Several legs demand more fluid than your flasks hold. Rather than carry another flask for a 200 mL overage, you drink the difference at the aid station before leaving — so a pre-load figure is already drunk, not carried.",
          }}
        >
          <Li><N>{nutrition.fluid_ml_hr_heat} mL/hr</N> inside the {nutrition.heat_window.start}–{nutrition.heat_window.end} heat window.</Li>
          <Li><N>{nutrition.fluid_ml_hr} mL/hr</N> outside it.</Li>
          <Li>Fill codes: <N>M</N> = mix, <N>W</N> = plain water.</Li>
        </Card>
      </Cards>

      <div className="panel race-table" style={{ marginTop: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: gridCols, minWidth: 900 }}>
          {colHead.map((h, i) => (
            <div
              key={h}
              className="eyebrow"
              style={{
                fontSize: 8, padding: "8px 9px", textAlign: i === 0 ? "left" : "right",
                borderBottom: "1px solid var(--edge)", background: "var(--panel-raise)", whiteSpace: "nowrap",
              }}
            >
              {h}
            </div>
          ))}
          {fuelPlan.segments.map((seg, i) => (
            <LegRow
              key={`${seg.from}-${seg.to}-${i}`}
              seg={seg}
              caf={caf.perSegment[i] ?? 0}
              raceStart={raceStart}
              last={i === fuelPlan.segments.length - 1}
            />
          ))}
        </div>
      </div>
      <div style={{ fontSize: 11, color: "var(--mist-mute)", lineHeight: 1.55, margin: "8px 0 0", maxWidth: "76ch" }}>
        <B>↳ caf</B> is a subset of <B>gels</B>, not additional — a leg showing 1 gel and 1 caf carries one gel, and it is
        the caffeinated one. Pre-load figures are millilitres drunk at the aid station before departing. Carry times sum to
        more than moving time because stops at crew-only points fall inside a leg rather than ending it.
        {fuelPlan.segments.some((s, i) => (caf.perSegment[i] ?? 0) > s.gels) && (
          <span style={{ color: "var(--ember)" }}>
            {" "}A <B>*</B> marks a leg carrying more caffeinated gels than the fuel model asks gels for — the dose is
            scheduled by darkness, not carb demand, so those legs run slightly over their carb target.
          </span>
        )}
      </div>

      {/* ---- drop bags ---- */}
      <SectionTag right={<span className="eyebrow" style={{ fontSize: 9 }}>packing list</span>}>drop bags</SectionTag>
      <Cards min={230}>
        {fuelPlan.drop_bags.map((bag) => {
          const bagCaf = caf.perBag[bag.station] ?? 0;
          const lastBag = bag === fuelPlan.drop_bags[fuelPlan.drop_bags.length - 1];
          const row = (label: string, value: React.ReactNode) => (
            <div key={label} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "3px 0", borderBottom: "1px dotted var(--edge)" }}>
              <span style={{ fontSize: 12, color: "var(--mist-dim)" }}>{label}</span>
              <span className="numerals" style={{ fontSize: 12, color: "var(--mist)" }}>{value}</span>
            </div>
          );
          return (
            <Card
              key={bag.station}
              title={bag.station === "Start" ? "Vest at start" : bag.station}
              accent={bagCaf > 0 ? "lamp" : undefined}
              meta={bag.atH > 0 ? fmtRaceClock(raceStart, bag.atH) : "mi 0"}
              why={{
                label: lastBag ? "last bag — no resupply after this" : "covers",
                body: lastBag
                  ? `Everything ${bag.covers.replace("→ ", "through to ")} rides on this bag. Have crew hold two spare caffeinated gels at the next crew point in case it goes missing or one gets dropped in the dark.${bag.gear.length ? ` Gear: ${bag.gear.join(", ")}.` : ""}`
                  : `${bag.covers}.${bag.gear.length ? ` Gear: ${bag.gear.join(", ")}.` : ""}`,
              }}
            >
              {row("Plain gels", Math.max(0, bag.gels - bagCaf) || "—")}
              {row("Caffeinated", bagCaf ? <span style={{ color: "var(--lamp)", fontWeight: 600 }}>{bagCaf}</span> : "—")}
              {row("Blok packs", bag.bloks || "—")}
              {row("Salt tabs", bag.salt_tabs || "—")}
              {row("HCF scoops", bag.hcf_scoops || "—")}
            </Card>
          );
        })}
      </Cards>
      <div style={{ fontSize: 11, color: "var(--mist-mute)", lineHeight: 1.55, margin: "8px 0 0", maxWidth: "76ch" }}>
        Buy list with spares: <B>{cafGels + 2} caffeinated</B>, <B>{plainGels + 3} plain</B>,{" "}
        <B>{fuelPlan.total_bloks + 2} blok packs</B>, <B>{fuelPlan.total_tabs + 4} salt tabs</B>.
      </div>

      {/* ---- troubleshooting ---- */}
      <SectionTag right={<span className="eyebrow" style={{ fontSize: 9 }}>when it goes wrong</span>}>on course</SectionTag>
      <Cards>
        <Card
          title="If the stomach turns"
          accent="ember"
          why={{
            label: "why in that order",
            body: "Cheapest thing first. Caffeine is the most likely irritant and the least costly to lose. Carbohydrate is last because under-fuelling at mile 70 is a slower but more certain way to end the day.",
          }}
        >
          <Li>Drop the <B>next caffeine dose</B> first.</Li>
          <Li>Then drop solids — liquid only for an hour.</Li>
          <Li>Then halve the carb rate until it settles.</Li>
          <Li>Slow down; blood returns to the gut at lower effort.</Li>
        </Card>
        <Card
          title="Sloshing stomach"
          accent="ember"
          why={{
            label: "why salt, not water",
            body: "A sloshing stomach means fluid isn't emptying, which usually means the contents are too dilute relative to your blood. Adding more water makes it worse; sodium restores the gradient that lets it move.",
          }}
        >
          <Li>Stop drinking for <N>20–30 min</N>.</Li>
          <Li>Take a salt tab.</Li>
          <Li>Walk until it clears.</Li>
        </Card>
        <Card
          title="Watch for hyponatremia"
          accent="ember"
          why={{
            label: "why it matters here",
            body: `Two hot afternoons and a ${nutrition.sodium_mg_hr} mg/hr sodium plan means the real risk is over-drinking, not under-drinking. It is the one nutrition failure on this page that is genuinely dangerous rather than merely race-ending.`,
          }}
        >
          <Li>Headache, nausea, puffy fingers, confusion.</Li>
          <Li>Clear urine plus weight <em>gain</em> is the tell.</Li>
          <Li>Stop drinking, take salt, tell an aid captain.</Li>
        </Card>
        <Card
          title="Aid-station food"
          why={{
            label: "why real food helps late",
            body: "By hour 24 gels stop being appetising no matter how well they have worked. Warm salty broth and flat cola go down when nothing else will, and the carb source matters far less than whether it gets eaten.",
          }}
        >
          <Li>Cola ≈ <N>{cfg.cola_mg} mg</N> caffeine per small cup — already counted.</Li>
          <Li>Mountain Dew is ~1.5× that; skip it or count it.</Li>
          <Li>Broth covers sodium when a tab won't go down.</Li>
        </Card>
      </Cards>

      {/* ---------------- after ---------------- */}
      <SectionTag right={<span className="eyebrow" style={{ fontSize: 9 }}>finish → the week after</span>}>after</SectionTag>
      <Cards>
        <Card
          title="First 60 minutes"
          accent="lamp"
          meta={fmtRaceClock(raceStart, finishH)}
          why={{
            label: "why this hour specifically",
            body: "Glycogen resynthesis runs fastest in the first hour or two while the muscle is still insulin-sensitive. Protein alongside it blunts the breakdown cascade. You will not be hungry — appetite is suppressed after long efforts and usually doesn't return until day two — so this has to be deliberate rather than intuitive.",
          }}
        >
          <Li><B>{g(1)}–{g(1.2)} g carbohydrate</B> (1.0–1.2 g/kg).</Li>
          <Li><B>25–40 g protein</B>.</Li>
          <Li><N>500–750 mL</N> fluid with sodium.</Li>
          <Li>Whatever form you'll actually swallow.</Li>
        </Card>
        <Card
          title="Rehydration"
          meta="first 6 hours"
          why={{
            label: "why 150% and why sodium",
            body: "You keep sweating and urinating after you stop, so replacing exactly what you lost leaves you short. Post-race is also when hyponatremia risk peaks: ADH stays elevated for hours, so plain water in volume gets retained and dilutes an already-depleted sodium pool.",
          }}
        >
          <Li>Aim for <B>150%</B> of the fluid deficit over 4–6 h.</Li>
          <Li>Every drink carries sodium — broth, mix, salty food.</Li>
          <Li>Sip steadily; don't tank a litre at once.</Li>
        </Card>
        <Card
          title="No more caffeine"
          accent="ember"
          meta={`${Math.round(caf.at_finish_mg)} mg still on board`}
          why={{
            label: "why",
            body: "You cross the line with a meaningful dose still circulating and a half-life of hours ahead of it. Adding a finish-line coffee spends sleep you need more than alertness you don't.",
          }}
        >
          <Li>Roughly <N>{Math.round(caf.at_finish_mg)} mg</N> on board at the finish.</Li>
          <Li>Skip the celebratory coffee; take the food instead.</Li>
        </Card>
        <Card
          title="Alcohol"
          meta="that evening"
          why={{
            label: "why wait rather than abstain",
            body: "Alcohol impairs glycogen resynthesis and works against rehydration, and both matter most in the first few hours. After that window the interference is small enough that the finish-line beer or the good bottle is a fair trade. A timing note, not a prohibition.",
          }}
        >
          <Li>Eat a real meal and rehydrate first.</Li>
          <Li>Then have the drink if you want it.</Li>
        </Card>
        <Card
          title="Days 2–7"
          meta="the week after"
          why={{
            label: "why over-eating slightly is correct",
            body: "You have a large repair bill and a deficit no single day closes. Under-fuelling the week after a hundred is a common and costly mistake — it stretches recovery out by weeks and is the classic on-ramp to low energy availability. The scale will mislead you for about a week; ignore it.",
          }}
        >
          <Li><B>{g(1.6)}–{g(2)} g protein a day</B> (1.6–2.0 g/kg).</Li>
          <Li>Do not restrict calories.</Li>
          <Li>Appetite spikes on day 2–3, not day 1.</Li>
        </Card>
        <Card
          title="Two things to watch"
          accent="ember"
          meta="medical"
          why={{
            label: "why the ferritin note",
            body: "Ferritin is an acute-phase reactant: it spikes with the inflammation from a hundred-mile race, and foot-strike hemolysis skews the rest of the iron panel at the same time. A draw in the first fortnight gives you a number that looks reassuring and means nothing.",
          }}
        >
          <Li><B>Dark urine past 24 h</B> with severe muscle pain — get it checked.</Li>
          <Li><B>Don't test ferritin</B> for at least two weeks.</Li>
        </Card>
      </Cards>

      {/* ---------------- provenance ---------------- */}
      <div style={{ marginTop: 26, paddingTop: 14, borderTop: "1px solid var(--edge)", fontSize: 11, color: "var(--mist-mute)", lineHeight: 1.6, maxWidth: "76ch", display: "flex", flexDirection: "column", gap: 7 }}>
        <span>
          Course, aid stations and sun times from <code>course.json</code>. Rates, phases, flask and gel constants, and the
          caffeine block from <code>nutrition.json</code> — edit that file and this page changes. Legs, fill codes,
          pre-loads and tab counts come from the same <code>planFuel</code> model as the printable fuel card; the dose
          schedule and body-load curve from <code>caffeine.ts</code>.
        </span>
        <span>
          Body mass ({kg} kg) lives in <code>nutrition.json</code> because no other file in this repo carries one, and the
          Strava profile's value is stale. Every mg/kg figure on this page depends on it.
        </span>
        <span>Not medical advice. Rehearse the caffeine timing and the gel-to-mix ratio on a long run before race day.</span>
        {nutritionError && <span style={{ color: "var(--ember)" }}>{nutritionError}</span>}
      </div>
    </section>
  );
}
