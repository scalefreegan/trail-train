import { useMemo } from "react";
import { useStrava, useMeasuredWidth } from "../data";
import { SectionTag } from "../atoms";
import { useRacePlan } from "./useRacePlan";
import { calibrate, type Band, type Flag } from "./calibration";
import { fmtElapsed } from "./pacing";

/* ------------------------------------------------------------------ */
/*  Model check — how much to trust the number above.                  */
/*                                                                    */
/*  The planner prints best / expected / worst and a goal, and it is   */
/*  not obvious how they relate: an expected time SLOWER than the goal */
/*  reads like a contradiction rather than what it is (the goal is an  */
/*  aspiration sitting between best and expected). So show the band    */
/*  and put the goal on it.                                            */
/*                                                                    */
/*  Then the harder question — is the fit itself any good? It is least */
/*  squares, so it is unbiased across its own training set by          */
/*  construction and the headline residual proves nothing. The         */
/*  back-test in calibration.ts looks for bias per band instead, and   */
/*  in particular at the distance the projection actually reads from.  */
/* ------------------------------------------------------------------ */

const SEV: Record<Flag["severity"], string> = {
  ok: "var(--pine)",
  watch: "var(--lamp)",
  warn: "var(--ember)",
};

/** Signed error bar: negative (faster than predicted) left, positive right. */
function ErrBar({ pct, max }: { pct: number; max: number }) {
  if (!Number.isFinite(pct)) return <div style={{ height: 8 }} />;
  const half = Math.max(1, max);
  const frac = Math.max(-1, Math.min(1, pct / half));
  const w = Math.abs(frac) * 50;
  const slow = pct > 0;
  return (
    <div style={{ position: "relative", height: 8, background: "var(--night-deep)", border: "1px solid var(--edge)" }}>
      <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--edge-bright)" }} />
      <div
        style={{
          position: "absolute", top: 1, bottom: 1,
          left: slow ? "50%" : `${50 - w}%`,
          width: `${w}%`,
          background: slow ? "var(--ember)" : "var(--creek)",
          opacity: 0.75,
        }}
      />
    </div>
  );
}

function BandRow({ b, max }: { b: Band; max: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "88px 30px 1fr 52px", gap: 8, alignItems: "center", padding: "3px 0" }}>
      <span style={{ fontSize: 11.5, color: "var(--mist-dim)" }}>{b.label}</span>
      <span className="numerals" style={{ fontSize: 10, color: "var(--mist-mute)" }}>n{b.n}</span>
      <ErrBar pct={b.median_err_pct} max={max} />
      <span className="numerals" style={{ fontSize: 11, textAlign: "right", color: Math.abs(b.median_err_pct) >= 3 ? "var(--lamp)" : "var(--mist-dim)" }}>
        {b.median_err_pct >= 0 ? "+" : ""}{b.median_err_pct.toFixed(1)}%
      </span>
    </div>
  );
}

/** best — expected — worst as a scale, with the goal marked on it. */
function Band3({ best, avg, worst, goal }: { best: number; avg: number; worst: number; goal: number | null }) {
  const { ref, width } = useMeasuredWidth();
  const lo = Math.min(best, goal ?? best);
  const hi = Math.max(worst, goal ?? worst);
  const span = hi - lo || 1;
  const x = (h: number) => ((h - lo) / span) * 100;
  const H = 54;
  if (width < 60) return <div ref={ref} style={{ height: H }} />;
  const goalInside = goal != null && goal >= best && goal <= worst;
  return (
    <div ref={ref}>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height: H }}>
        <rect x={x(best)} y={20} width={Math.max(0.4, x(worst) - x(best))} height={8} fill="var(--lamp)" opacity={0.18} />
        <rect x={x(best)} y={20} width={Math.max(0.4, x(avg) - x(best))} height={8} fill="var(--lamp)" opacity={0.28} />
        {[["best", best, "var(--pine)"], ["expected", avg, "var(--lamp)"], ["worst", worst, "var(--ember)"]].map(([, h, c], i) => (
          <rect key={i} x={x(h as number) - 0.15} y={16} width={0.3} height={16} fill={c as string} />
        ))}
        {goal != null && (
          <rect x={x(goal) - 0.15} y={10} width={0.3} height={28} fill="var(--creek)" strokeDasharray="2 2" />
        )}
      </svg>
      {/* Labels are pinned to the same scale as the ticks, not spread with
          space-between. Those coincide only while `expected` is the midpoint
          of best/worst — which stops being true the moment a goal outside the
          band widens the scale, and then every label points at the wrong mark. */}
      <div style={{ position: "relative", height: 14, marginTop: -6, fontSize: 10 }}>
        {([["best", best, "var(--pine)"], ["expected", avg, "var(--lamp)"], ["worst", worst, "var(--ember)"]] as const).map(([label, h, c], i) => (
          <span
            key={label}
            className="numerals"
            style={{
              position: "absolute", top: 0, color: c, whiteSpace: "nowrap",
              left: `${x(h)}%`,
              // clamp the end labels inward so neither runs off the panel
              transform: i === 0 ? "translateX(0)" : i === 2 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {label} {fmtElapsed(h)}
          </span>
        ))}
      </div>
      {goal != null && (
        <div style={{ fontSize: 11.5, color: "var(--mist-dim)", lineHeight: 1.6, marginTop: 8 }}>
          Your goal of <span className="numerals" style={{ color: "var(--creek)" }}>{fmtElapsed(goal)}</span>{" "}
          {goalInside
            ? <>sits <strong style={{ color: "var(--mist)" }}>inside</strong> the band, {fmtElapsed(avg - goal)} faster than expected — reachable, but it is not the expected case. An expected time slower than your goal is the model disagreeing with your target, not an error.</>
            : goal < best
            ? <>is <strong style={{ color: "var(--ember)" }}>faster than the best case</strong> this model can produce. Nothing in your training data supports it.</>
            : <>is <strong style={{ color: "var(--mist)" }}>slower than the worst case</strong> — you have it comfortably.</>}
        </div>
      )}
    </div>
  );
}

export function ModelCheck() {
  const { course, proj, fit, paceGrade, settings } = useRacePlan();
  const { activities } = useStrava();

  const cal = useMemo(
    () => calibrate({
      fit, course, activities, gradeCurve: paceGrade,
      currentCalibrationPct: settings.calibration,
    }),
    [fit, course, activities, paceGrade, settings.calibration],
  );

  if (!proj || !cal) return null;

  const maxErr = Math.max(
    5,
    ...cal.by_distance.map((b) => Math.abs(b.median_err_pct)),
    ...cal.by_vert.map((b) => Math.abs(b.median_err_pct)),
  );
  const anchor = cal.anchor_bias_pct;

  return (
    <section>
      <SectionTag right={
        <span className="eyebrow numerals" style={{ fontSize: 9 }}>
          {cal.runs.length} runs back-tested
        </span>
      }>
        model check
      </SectionTag>

      <div className="panel notch" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 16 }}>

        {/* ---- where the goal sits ---- */}
        <div>
          <span className="eyebrow" style={{ fontSize: 8.5, display: "block", marginBottom: 8 }}>projection band</span>
          <Band3 best={proj.finish_h.best} avg={proj.finish_h.avg} worst={proj.finish_h.worst} goal={proj.goal_h} />
        </div>

        {/* ---- is the fit any good ---- */}
        <div style={{ borderTop: "1px solid var(--edge)", paddingTop: 14 }}>
          <span className="eyebrow" style={{ fontSize: 8.5, display: "block", marginBottom: 4 }}>
            back-test · median error by distance
          </span>
          <p style={{ fontSize: 11.5, color: "var(--mist-mute)", lineHeight: 1.55, margin: "0 0 8px", maxWidth: "72ch" }}>
            Each band compares what the fit predicted for your own runs against what you actually ran.{" "}
            <span style={{ color: "var(--ember)" }}>Positive = you ran slower</span> than the model expected;{" "}
            <span style={{ color: "var(--creek)" }}>negative = faster</span>. A least-squares fit is unbiased
            overall by construction, so the structure between bands is the part that means anything.
          </p>
          {cal.by_distance.map((b) => <BandRow key={b.label} b={b} max={maxErr} />)}
        </div>

        <div>
          <span className="eyebrow" style={{ fontSize: 8.5, display: "block", marginBottom: 6 }}>by climb rate</span>
          {cal.by_vert.map((b) => <BandRow key={b.label} b={b} max={maxErr} />)}
        </div>

        {/* ---- the number that actually propagates ---- */}
        {anchor != null && (
          <div style={{ borderTop: "1px solid var(--edge)", paddingTop: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--mist)" }}>
                Anchor-band bias{" "}
                <span className="numerals" style={{ color: Math.abs(anchor) >= 3 ? "var(--lamp)" : "var(--pine)" }}>
                  {anchor >= 0 ? "+" : ""}{anchor.toFixed(1)}%
                </span>
              </span>
              <span className="eyebrow numerals" style={{ fontSize: 9 }}>n{cal.anchor_n} · 16–30 mi</span>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--mist-dim)", lineHeight: 1.6, margin: "6px 0 0", maxWidth: "72ch" }}>
              The projection reads its fitness pace at a 20-mile reference and lets the fatigue curve carry
              everything past it, so this is the band whose error actually scales into the race time.{" "}
              {Math.abs(anchor) < 3
                ? <>At {anchor >= 0 ? "+" : ""}{anchor.toFixed(1)}% it is inside the noise of {cal.anchor_n} runs — the fit is
                    tracking you here, and your {settings.calibration}% calibration sits on top of it as a deliberate
                    race-day margin rather than a correction for anything measured.</>
                : <>That is large enough to matter. {cal.suggested_calibration_pct != null
                    ? <>Folding it into calibration would mean <span className="numerals" style={{ color: "var(--lamp)" }}>{cal.suggested_calibration_pct}%</span> instead
                       of the {settings.calibration}% set now — your call, the planner will not change it for you.</>
                    : null}</>}
            </p>
          </div>
        )}

        {/* ---- inputs still current? ---- */}
        <div style={{ borderTop: "1px solid var(--edge)", paddingTop: 14 }}>
          <span className="eyebrow" style={{ fontSize: 8.5, display: "block", marginBottom: 8 }}>inputs</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {cal.flags.map((f) => (
              <div key={f.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span style={{ width: 5, height: 5, flex: "0 0 auto", background: SEV[f.severity], transform: "rotate(45deg)", marginTop: 5 }} />
                <div>
                  <span style={{ fontSize: 12, color: f.severity === "ok" ? "var(--mist-dim)" : "var(--mist)" }}>{f.label}</span>
                  {f.detail && (
                    <span style={{ fontSize: 11, color: "var(--mist-mute)", display: "block", lineHeight: 1.5, maxWidth: "72ch" }}>{f.detail}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ---- the long efforts, named ---- */}
        {cal.long_cohort.length > 0 && (
          <div style={{ borderTop: "1px solid var(--edge)", paddingTop: 14 }}>
            <span className="eyebrow" style={{ fontSize: 8.5, display: "block", marginBottom: 6 }}>
              longest efforts · predicted vs actual
            </span>
            <div style={{ overflowX: "auto" }}>
              <div style={{ minWidth: 460 }}>
                {[...cal.long_cohort].sort((a, b) => b.distance_mi - a.distance_mi).slice(0, 6).map((r) => (
                  <div key={r.date + r.title} style={{ display: "grid", gridTemplateColumns: "74px 56px 62px 1fr 52px", gap: 8, alignItems: "baseline", padding: "3px 0", borderBottom: "1px dotted var(--edge)" }}>
                    <span className="numerals" style={{ fontSize: 10.5, color: "var(--mist-mute)" }}>{r.date}</span>
                    <span className="numerals" style={{ fontSize: 11.5, color: "var(--mist)" }}>{r.distance_mi.toFixed(1)} mi</span>
                    <span className="numerals" style={{ fontSize: 10.5, color: "var(--mist-mute)" }}>{Math.round(r.vert_ft_per_mi)} ft/mi</span>
                    <span style={{ fontSize: 11.5, color: "var(--mist-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                    <span className="numerals" style={{ fontSize: 11.5, textAlign: "right", color: r.err_pct > 0 ? "var(--ember)" : "var(--creek)" }}>
                      {r.err_pct >= 0 ? "+" : ""}{r.err_pct.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
