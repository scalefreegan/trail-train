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

/** Below this many runs a median is an anecdote; the row renders dimmed so a
    band of 3 cannot carry the same visual authority as a band of 37. */
const THIN_BAND_N = 8;

function BandRow({ b, max }: { b: Band; max: number }) {
  const thin = b.n < THIN_BAND_N;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "88px 30px 1fr 52px", gap: 8, alignItems: "center", padding: "3px 0", opacity: thin ? 0.55 : 1 }}
      title={thin ? `${b.n} runs — too few to weigh heavily` : undefined}>
      <span style={{ fontSize: 11.5, color: "var(--mist-dim)" }}>{b.label}</span>
      <span className="numerals" style={{ fontSize: 10, color: thin ? "var(--lamp)" : "var(--mist-mute)" }}>n{b.n}</span>
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
        {([["best", best, "var(--pine)"], ["expected", avg, "var(--lamp)"], ["worst", worst, "var(--ember)"]] as const).map(([, h, c], i) => (
          <rect key={i} x={x(h) - 0.15} y={16} width={0.3} height={16} fill={c} />
        ))}
        {goal != null && (
          <rect x={x(goal) - 0.15} y={10} width={0.3} height={28} fill="var(--creek)" strokeDasharray="2 2" />
        )}
      </svg>
      {/* Labels are pinned to the same scale as the ticks, not spread with
          space-between — those only coincide while `expected` happens to be
          the band midpoint. Anchors then get a one-pass separation sweep: a
          tight fit (small residStd) puts best and expected a fraction of a
          percent apart, where tick-exact anchors overlap the text. Ticks stay
          exact; only the words move. */}
      <div style={{ position: "relative", height: 14, marginTop: -6, fontSize: 10 }}>
        {(() => {
          const items = ([["best", best, "var(--pine)"], ["expected", avg, "var(--lamp)"], ["worst", worst, "var(--ember)"]] as const)
            .map(([label, h, c]) => ({ label, h, c, anchor: x(h) }));
          // minimum horizontal separation between label anchors, in % of width
          const MIN_GAP = 20;
          // sweep left→right pushing labels right, then clamp the tail back
          // inside and sweep right→left so the whole cluster stays on-panel
          for (let i = 1; i < items.length; i++) {
            items[i].anchor = Math.max(items[i].anchor, items[i - 1].anchor + MIN_GAP);
          }
          items[items.length - 1].anchor = Math.min(items[items.length - 1].anchor, 100);
          for (let i = items.length - 2; i >= 0; i--) {
            items[i].anchor = Math.min(items[i].anchor, items[i + 1].anchor - MIN_GAP);
          }
          items[0].anchor = Math.max(items[0].anchor, 0);
          return items.map(({ label, h, c, anchor }, i) => (
            <span
              key={label}
              className="numerals"
              style={{
                position: "absolute", top: 0, color: c, whiteSpace: "nowrap",
                left: `${anchor}%`,
                // clamp the end labels inward so neither runs off the panel
                transform: i === 0 ? "translateX(0)" : i === items.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
              }}
            >
              {label} {fmtElapsed(h)}
            </span>
          ));
        })()}
      </div>
      {goal != null && (
        <div style={{ fontSize: 11.5, color: "var(--mist-dim)", lineHeight: 1.6, marginTop: 8 }}>
          Your goal of <span className="numerals" style={{ color: "var(--creek)" }}>{fmtElapsed(goal)}</span>{" "}
          {goalInside
            // inside the band, but WHICH side of expected changes the whole
            // sentence — fmtElapsed(avg - goal) on a goal slower than expected
            // rendered a garbled negative ("-2h 44m faster than expected")
            ? goal <= avg
              ? <>sits <strong style={{ color: "var(--mist)" }}>inside</strong> the band, {fmtElapsed(avg - goal)} faster than expected — reachable, but it is not the expected case. An expected time slower than your goal is the model disagreeing with your target, not an error.</>
              : <>sits <strong style={{ color: "var(--mist)" }}>inside</strong> the band, {fmtElapsed(goal - avg)} <strong style={{ color: "var(--pine)" }}>slower than expected</strong> — the model thinks you beat it in the median case.</>
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
            Each run is predicted by a model refit <em>without</em> that run (leave-one-out), then compared to
            what you actually ran — an in-sample test would flatter the fit most exactly in the long-run band
            it weights hardest.{" "}
            <span style={{ color: "var(--ember)" }}>Positive = you ran slower</span> than predicted;{" "}
            <span style={{ color: "var(--creek)" }}>negative = faster</span>. Dimmed rows are too thin to weigh heavily.
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
              <span className="eyebrow numerals" style={{ fontSize: 9, color: cal.anchor_n < 8 ? "var(--lamp)" : undefined }}>
                n{cal.anchor_n} · 15–25 mi{cal.anchor_n < 8 ? " · thin sample" : ""}
              </span>
            </div>
            <p style={{ fontSize: 11.5, color: "var(--mist-dim)", lineHeight: 1.6, margin: "6px 0 0", maxWidth: "72ch" }}>
              The projection evaluates its fitness pace at a single 20-mile reference point and lets the fatigue
              curve carry everything past it — this band is the held-out check on how the model behaves around
              that point, so error here scales into the race time.{" "}
              {Math.abs(anchor) < 3
                ? <>At {anchor >= 0 ? "+" : ""}{anchor.toFixed(1)}% it is inside the noise of {cal.anchor_n} held-out runs — the fit is
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
                {/* date+title alone collides on a double-run day with Strava's
                    default titles; distance disambiguates the realistic cases */}
                {[...cal.long_cohort].sort((a, b) => b.distance_mi - a.distance_mi).slice(0, 6).map((r, i) => (
                  <div key={`${r.date}-${r.title}-${r.distance_mi}-${i}`} style={{ display: "grid", gridTemplateColumns: "74px 56px 62px 1fr 52px", gap: 8, alignItems: "baseline", padding: "3px 0", borderBottom: "1px dotted var(--edge)" }}>
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
