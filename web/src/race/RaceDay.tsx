import { useEffect, useState } from "react";
import { useActiveRace, useBlockConfig, useUnits } from "../data";
import { clearHash } from "./hashRoute";
import { fmtCarry, type DropBag, type FuelPlan, type FuelSegment } from "./nutrition";
import { fmtElapsed, type StationProjection } from "./pacing";
import { RacePlanProvider } from "./RacePlanProvider";
import { useCrewBase } from "./useRaceData";
import { useRacePlan, type RacePlan } from "./useRacePlan";

/* ------------------------------------------------------------------ */
/*  Race-day mode (PRD §7) — the glanceable phone companion to the     */
/*  printed cards, at `#/race-day`.                                    */
/*                                                                    */
/*  Read one-handed, at night, at mile 60, by someone who is tired.    */
/*  So: ONE column, ONE question answered per block, type big enough   */
/*  to read without stopping, and nothing that needs a horizontal      */
/*  scroll at 360 px. The printed RunnerCard/FuelCard stay the source  */
/*  of truth for the whole race; this shows only the next three        */
/*  stations, because that is all a runner can act on.                 */
/*                                                                    */
/*  It renders full-bleed — no command bar, no agent rail. Those are   */
/*  desk furniture and they cost a third of a phone screen.            */
/*                                                                    */
/*  Every number comes from the SHARED projection (useRacePlan): the   */
/*  ETAs here and the ETAs on the card the runner is carrying must     */
/*  agree to the minute, and the only way to guarantee that is to not  */
/*  compute them twice.                                                */
/* ------------------------------------------------------------------ */

/** How often the clock and the "next station" pick re-evaluate. 15 s is
    under the minute the clock displays, so the minute never looks stuck. */
const TICK_MS = 15_000;

/** How many stations past the next one to preview. Three total fits a
    360 px screen without scrolling past the thing you needed. */
const LOOKAHEAD = 2;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/* ------------------------------------------------------------------ */
/*  Manual position override                                           */
/*                                                                    */
/*  The clock alone answers "where am I" only if the projection is     */
/*  right, and by mile 60 it usually is not. So the runner can say so: */
/*  "I'm at mile X", or "I just left <station>" (which is the same     */
/*  statement with the mile filled in). Persisted per slug — an        */
/*  override is a fact about one race, and a phone that sleeps mid-    */
/*  climb must come back knowing it.                                   */
/*                                                                    */
/*  The override moves WHICH station is next. It does NOT re-project:  */
/*  the ETAs stay the shared plan's, so they still match the printed   */
/*  card, and the gap between where you are and where the plan says    */
/*  you'd be is shown as its own line instead of being silently        */
/*  absorbed.                                                          */
/* ------------------------------------------------------------------ */
function usePosition(slug: string | null) {
  const key = slug ? `race.${slug}.raceday_mi` : null;
  const read = (): number | null => {
    if (key == null || typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(key);
      const n = raw == null ? NaN : Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch { return null; }
  };
  // same render-phase re-read as useRacePlan's knobs: the slug arrives a
  // fetch late, and an effect would flash the un-overridden station first
  const [state, setState] = useState(() => ({ key, v: read() }));
  if (state.key !== key) setState({ key, v: read() });
  const set = (mi: number | null) => {
    setState({ key, v: mi });
    if (key == null) return;
    try {
      if (mi == null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(mi));
    } catch { /* private mode */ }
  };
  return [state.v, set] as const;
}

/**
 * Index of the station being run toward, or `stations.length` once the
 * finish is behind you. With an override it is the first station past the
 * stated mile; without one, the first whose expected arrival is still
 * ahead of the clock.
 */
function nextStationIdx(
  stations: StationProjection[], elapsedH: number, overrideMi: number | null,
): number {
  const i = overrideMi != null
    // 1e-9, not 0: "just left Geronimo" sets the mile to Geronimo's own, and
    // a bare > would then hand back Geronimo as the station ahead of you
    ? stations.findIndex((s) => s.station.total_mi > overrideMi + 1e-9)
    : stations.findIndex((s) => s.eta_h.avg > elapsedH);
  return i === -1 ? stations.length : i;
}

/** The fuel leg you carry OUT of station `idx`, if it is a resupply point. */
function legOut(plan: FuelPlan | null, idx: number): FuelSegment | null {
  return plan?.segments.find((s) => s.fromIdx === idx) ?? null;
}

/** The leg you are already carrying THROUGH station `idx` (crew-only or
    water-only stations resupply nothing, so there is no leg out of them). */
function legThrough(plan: FuelPlan | null, idx: number): FuelSegment | null {
  return plan?.segments.find((s) => s.fromIdx < idx && s.toIdx > idx) ?? null;
}

function fmtDrive(min: number): string {
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

/** Signed elapsed hours as "+1h 43m" / "−0h 12m". */
function fmtSigned(h: number): string {
  return `${h < 0 ? "−" : "+"}${fmtElapsed(Math.abs(h))}`;
}

/* Cutoff margin colouring, in the units that matter at 3am: under an hour
   is a decision, under two is a warning, more is fine. */
function marginColor(h: number | null): string {
  if (h == null) return "var(--mist-mute)";
  if (h < 0) return "var(--ember)";
  if (h < 1) return "var(--ember)";
  if (h < 2) return "var(--lamp)";
  return "var(--pine)";
}

/* ------------------------------------------------------------------ */
/*  Shell                                                              */
/* ------------------------------------------------------------------ */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: "100dvh", background: "var(--night)", color: "var(--mist)",
        // no horizontal scroll at 360 px, whatever a child tries
        overflowX: "hidden", padding: "10px 14px 56px",
      }}
    >
      <div style={{ maxWidth: 520, margin: "0 auto", minWidth: 0 }}>
        <button
          onClick={clearHash}
          className="eyebrow"
          /* 44 px tall: this is the one escape hatch, tapped with gloves on */
          style={{ minHeight: 44, display: "inline-flex", alignItems: "center", color: "var(--mist-dim)" }}
        >
          ← dashboard
        </button>
        {children}
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: "warn" | "mute"; children: React.ReactNode }) {
  return (
    <div
      className="numerals"
      style={{
        fontSize: 11, lineHeight: 1.5, padding: "8px 10px", marginTop: 8,
        border: `1px solid ${tone === "warn" ? "var(--lamp-deep)" : "var(--edge)"}`,
        background: tone === "warn" ? "var(--lamp-glow)" : "var(--night-deep)",
        color: tone === "warn" ? "var(--lamp)" : "var(--mist-dim)",
      }}
    >
      {children}
    </div>
  );
}

function Eyebrow({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="eyebrow" style={{ fontSize: 9, ...style }}>{children}</div>;
}

/* ------------------------------------------------------------------ */
/*  Route entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * What AppBody mounts for `#/race-day`. Gates on there being an active
 * race BEFORE the plan provider, so the no-race case gets a full-bleed
 * phone message instead of the desk-sized panel RacePlanProvider renders.
 */
export function RaceDayRoute() {
  const { race, loading } = useBlockConfig();
  const { activeRace, viewing, error } = useActiveRace();
  // the SAME condition RacePlanProvider gates on: anything else and this
  // page would claim there is no race while the provider below it would
  // happily have rendered one (view mode browsing an archived folder)
  if (!race || !(activeRace?.active || viewing)) {
    return (
      <Shell>
        <div className="display" style={{ fontSize: 28, marginTop: 18 }}>
          {loading ? "Loading…" : "No active race"}
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--mist-dim)", marginTop: 12 }}>
          {loading
            ? "Reading the active race."
            : "Race-day mode needs a race to count down to. Activate one from the dashboard and come back — this page will be here at the same address."}
        </p>
        {error && <Notice tone="warn">{error}</Notice>}
      </Shell>
    );
  }
  return (
    <RacePlanProvider>
      <RaceDay />
    </RacePlanProvider>
  );
}

/* ------------------------------------------------------------------ */
/*  The view                                                           */
/* ------------------------------------------------------------------ */

export function RaceDay() {
  const u = useUnits();
  const plan = useRacePlan();
  const { race, proj, fuelPlan, features, raceStart, error: courseError, missing } = plan;
  // the race ON SCREEN owns the override, same namespace as the plan
  // knobs (useRacePlan) — view mode browses a different folder
  const { viewing, error: activeError, offline } = useActiveRace();
  const { crewBase } = useCrewBase();
  const now = useNow();
  const [posMi, setPosMi] = usePosition(viewing);
  const [miDraft, setMiDraft] = useState("");

  const elapsedH = (now - raceStart.getTime()) / 3_600_000;
  const started = elapsedH >= 0;
  const stations = proj?.stations ?? [];
  // Where to measure "to go" from: the stated mile if the runner gave one,
  // otherwise the mile the plan has them at right now. Both are honest —
  // one is observed, the other is the projection's own answer — and the
  // "where am i" block below says which is in force.
  const posEff = posMi ?? (started && proj ? proj.mileAtElapsed(elapsedH) : null);
  const idx = nextStationIdx(stations, elapsedH, posMi);
  const next = stations[idx] ?? null;
  const upcoming = stations.slice(idx + 1, idx + 1 + LOOKAHEAD);

  const drives = features.crew ? crewBase?.drives ?? {} : {};
  const staleNotice = offline
    ? "Offline — showing the last plan this phone loaded. Reconnect to the laptop to refresh."
    : activeError ?? courseError;

  return (
    <Shell>
      {/* ---------- now ---------- */}
      <header style={{ marginTop: 6 }}>
        <Eyebrow>{race.short} · race day</Eyebrow>
        <div
          className="display numerals"
          style={{ fontSize: 56, marginTop: 4, letterSpacing: "-0.04em" }}
        >
          {race.clock(elapsedH)}
        </div>
        <div className="numerals" style={{ fontSize: 15, color: "var(--mist-dim)", marginTop: 6 }}>
          {started
            ? <>elapsed <b style={{ color: "var(--mist)" }}>{fmtElapsed(elapsedH)}</b>
                {race.cutoff_h != null && <> · cutoff {fmtElapsed(race.cutoff_h)}</>}</>
            : <>starts in <b style={{ color: "var(--lamp)" }}>{fmtElapsed(-elapsedH)}</b> · gun {race.clock(0)}</>}
        </div>
      </header>

      {staleNotice && <Notice tone="warn">{staleNotice}</Notice>}

      {/* ---------- the plan, or why there isn't one ---------- */}
      {!proj ? (
        <Notice tone="mute">
          {missing
            ? "No course.json for this race yet — build the course and reload."
            : "The projection needs the course profile and a Strava pace fit. Open the dashboard on the laptop once to load them."}
        </Notice>
      ) : !next ? (
        <FinishedCard finishH={proj.finish_h.avg} clock={race.clock} elapsedH={elapsedH} />
      ) : (
        <>
          <NextStation
            sp={next}
            plan={plan}
            idx={idx}
            elapsedH={elapsedH}
            posMi={posEff}
            legs={{ out: legOut(fuelPlan, idx), through: legThrough(fuelPlan, idx) }}
            bag={features.drop_bags && next.station.drop_bag
              ? fuelPlan?.drop_bags.find((b) => b.station === next.station.name) ?? null
              : null}
            drive={drives[next.station.name] ?? null}
            baseLabel={crewBase?.base?.label ?? "base"}
          />

          {upcoming.length > 0 && (
            <>
              <Eyebrow style={{ marginTop: 20, marginBottom: 6 }}>then</Eyebrow>
              {upcoming.map((sp) => (
                <CompactStation key={sp.station.name} sp={sp} clock={race.clock} />
              ))}
            </>
          )}

          {/* finish, always — it is the only number anyone actually wants */}
          <div
            className="numerals"
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "baseline",
              gap: 10, marginTop: 14, padding: "10px 2px", borderTop: "1px solid var(--edge)",
            }}
          >
            <span className="eyebrow" style={{ fontSize: 9 }}>finish</span>
            <span style={{ fontSize: 17 }}>
              <span style={{ color: "var(--pine)", fontSize: 13 }}>{race.clock(proj.finish_h.best)}</span>
              {" · "}<b>{race.clock(proj.finish_h.avg)}</b>{" · "}
              <span style={{ color: "var(--ember)", fontSize: 13 }}>{race.clock(proj.finish_h.worst)}</span>
            </span>
          </div>
        </>
      )}

      {/* ---------- where am I ---------- */}
      <Eyebrow style={{ marginTop: 22, marginBottom: 8 }}>where am i</Eyebrow>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "stretch" }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(miDraft);
            if (Number.isFinite(n) && n >= 0) { setPosMi(u.system === "metric" ? n / 1.609344 : n); setMiDraft(""); }
          }}
          style={{ display: "flex", gap: 6, flex: "1 1 150px", minWidth: 0 }}
        >
          <input
            value={miDraft}
            onChange={(e) => setMiDraft(e.target.value)}
            /* decimal, not numeric: mile 42.3 needs the point on iOS */
            inputMode="decimal"
            placeholder={`mile (${u.distUnit})`}
            aria-label={`current mile (${u.distUnit})`}
            className="numerals"
            style={{
              flex: 1, minWidth: 0, minHeight: 44, padding: "0 10px", fontSize: 15,
              background: "var(--night-deep)", border: "1px solid var(--edge-bright)", color: "var(--mist)",
            }}
          />
          <button type="submit" className="chip" style={{ minHeight: 44, padding: "0 14px" }}>set</button>
        </form>
        {posMi != null && (
          <button className="chip" onClick={() => setPosMi(null)} style={{ minHeight: 44, padding: "0 14px" }}>
            auto
          </button>
        )}
      </div>
      <select
        value=""
        onChange={(e) => { if (e.target.value !== "") setPosMi(Number(e.target.value)); }}
        aria-label="just left a station"
        style={{
          width: "100%", minHeight: 44, marginTop: 8, padding: "0 10px", fontSize: 15,
          background: "var(--night-deep)", border: "1px solid var(--edge-bright)",
          color: "var(--mist)", fontFamily: "var(--font-body)",
        }}
      >
        <option value="">just left…</option>
        {stations.map((sp) => (
          <option key={sp.station.name} value={sp.station.total_mi}>
            {sp.station.name} · {u.dist(sp.station.total_mi)} {u.distUnit}
          </option>
        ))}
      </select>
      {posMi == null ? (
        <div className="numerals" style={{ fontSize: 12, color: "var(--mist-mute)", marginTop: 8, lineHeight: 1.6 }}>
          auto — position and “to go” come from the projection against the clock.
          Say where you actually are if it has drifted.
        </div>
      ) : (
        <div className="numerals" style={{ fontSize: 12, color: "var(--mist-dim)", marginTop: 8, lineHeight: 1.6 }}>
          held at <b style={{ color: "var(--mist)" }}>{u.dist(posMi)} {u.distUnit}</b>
          {proj && started && (() => {
            const planMi = proj.mileAtElapsed(elapsedH);
            const d = posMi - planMi;
            if (Math.abs(d) < 0.15) return <> · on plan</>;
            return <> · <span style={{ color: d > 0 ? "var(--pine)" : "var(--ember)" }}>
              {u.dist(Math.abs(d), 1)} {u.distUnit} {d > 0 ? "ahead of" : "behind"} plan
            </span></>;
          })()}
          <div style={{ color: "var(--mist-mute)" }}>
            ETAs below are still the planned ones — “auto” hands the next station back to the clock.
          </div>
        </div>
      )}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */

function FinishedCard({ finishH, clock, elapsedH }: {
  finishH: number; clock: (h: number) => string; elapsedH: number;
}) {
  return (
    <section className="panel notch" style={{ padding: "20px 16px", marginTop: 14 }}>
      <Eyebrow>every station is behind you</Eyebrow>
      <div className="display" style={{ fontSize: 30, marginTop: 8 }}>Finish</div>
      <div className="numerals" style={{ fontSize: 15, color: "var(--mist-dim)", marginTop: 8, lineHeight: 1.6 }}>
        projected {clock(finishH)} · {fmtElapsed(finishH)}
        <div>on the clock now: {fmtElapsed(Math.max(0, elapsedH))}</div>
      </div>
    </section>
  );
}

function EtaCell({ label, value, color, big }: {
  label: string; value: string; color?: string; big?: boolean;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="eyebrow" style={{ fontSize: 8, letterSpacing: "0.14em" }}>{label}</div>
      <div
        className="numerals"
        style={{
          fontSize: big ? 26 : 17, fontWeight: big ? 700 : 500, marginTop: 2,
          color: color ?? "var(--mist)", whiteSpace: "nowrap",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function NextStation({ sp, plan, idx, elapsedH, posMi, legs, bag, drive, baseLabel }: {
  sp: StationProjection;
  plan: RacePlan;
  idx: number;
  /** race hours on the clock right now — the crew leave-by needs to know
      whether it is already in the past */
  elapsedH: number;
  posMi: number | null;
  legs: { out: FuelSegment | null; through: FuelSegment | null };
  bag: DropBag | null;
  drive: { min: number; mi: number } | null;
  /** crew-base.json's `base` is optional (tt-yib.9): a folder can carry
      emergency numbers and no race-week lodging, hence a fallback label */
  baseLabel: string;
}) {
  const u = useUnits();
  const { race, features } = plan;
  const s = sp.station;
  const toGo = posMi != null ? s.total_mi - posMi : null;

  return (
    <section className="panel notch" style={{ padding: "18px 15px", marginTop: 14 }}>
      <Eyebrow>next · station {idx + 1}</Eyebrow>
      {/* wraps rather than truncates: a phone has the vertical room a 3×5
          card does not, and a clipped station name at night is a wrong turn */}
      <h1 className="display" style={{ fontSize: 30, margin: "6px 0 0", overflowWrap: "anywhere" }}>
        {s.name}
      </h1>
      <div className="numerals" style={{ fontSize: 14, color: "var(--mist-dim)", marginTop: 5 }}>
        {u.dist(s.total_mi)} {u.distUnit}
        {toGo != null && toGo > 0 && <> · <b style={{ color: "var(--lamp)" }}>{u.dist(toGo, 1)} {u.distUnit} to go</b></>}
        {sp.seg_gain_ft > 0 && <> · ↑{u.elev(sp.seg_gain_ft)} {u.elevUnit} this leg</>}
        {s.water_only && <> · <span style={{ color: "var(--ember)" }}>water only</span></>}
        {s.crew_only && <> · <span style={{ color: "var(--ember)" }}>no aid</span></>}
      </div>

      <div
        style={{
          display: "grid", gridTemplateColumns: "1fr 1.3fr 1fr", gap: 6,
          marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--edge)",
        }}
      >
        <EtaCell label="best" value={race.clock(sp.eta_h.best)} color="var(--pine)" />
        <EtaCell label="eta" value={race.clock(sp.eta_h.avg)} big />
        <EtaCell label="worst" value={race.clock(sp.eta_h.worst)} color="var(--ember)" />
      </div>

      {s.cutoff_h != null && (
        <div
          className="numerals"
          style={{ fontSize: 13, marginTop: 12, lineHeight: 1.6, color: "var(--mist-dim)" }}
        >
          cutoff <b style={{ color: "var(--mist)" }}>{race.clock(s.cutoff_h)}</b> ·
          {" "}margin <b style={{ color: marginColor(sp.cutoff_margin_h) }}>
            {sp.cutoff_margin_h != null ? fmtSigned(sp.cutoff_margin_h) : "—"}
          </b>
          {/* the worst-case margin is the one that decides whether to stop */}
          {sp.cutoff_margin_worst_h != null && (
            <span style={{ color: "var(--mist-mute)" }}>
              {" "}(worst <b style={{ color: marginColor(sp.cutoff_margin_worst_h) }}>
                {fmtSigned(sp.cutoff_margin_worst_h)}
              </b>)
            </span>
          )}
        </div>
      )}

      {sp.stop_min > 0 && (
        <div className="numerals" style={{ fontSize: 12, color: "var(--mist-mute)", marginTop: 4 }}>
          planned stop {sp.stop_min} min
        </div>
      )}

      <PickUp out={legs.out} through={legs.through} stationName={s.name} />

      {bag && (
        <Block label="drop bag">
          <div style={{ fontSize: 16, lineHeight: 1.5 }}>
            {[
              bag.gels > 0 ? `${bag.gels} gel` : null,
              bag.bloks > 0 ? `${bag.bloks} blok` : null,
              bag.hcf_scoops > 0 ? `${bag.hcf_scoops} scoop` : null,
              bag.salt_tabs > 0 ? `${bag.salt_tabs} salt` : null,
              ...bag.gear,
            ].filter(Boolean).join(" · ") || "nothing scheduled"}
          </div>
          <div className="numerals" style={{ fontSize: 12, color: "var(--mist-mute)", marginTop: 3 }}>
            covers {bag.covers}{bag.night ? " · night section" : ""}
          </div>
        </Block>
      )}

      {features.crew && drive && (() => {
        // leave-by against the BEST case, not the expected one: crew that
        // leaves on the expected ETA misses a runner having a good day
        const leaveByH = sp.eta_h.best - drive.min / 60;
        const late = leaveByH <= elapsedH;
        return (
          <Block label="crew">
            <div className="numerals" style={{ fontSize: 15, lineHeight: 1.6 }}>
              {fmtDrive(drive.min)} drive from {baseLabel} · {u.dist(drive.mi, 0)} {u.distUnit}
              <div style={{ color: "var(--mist-dim)" }}>
                {late
                  ? <>should already be driving — <b style={{ color: "var(--ember)" }}>leave now</b> (best case {race.clock(sp.eta_h.best)})</>
                  : <>leave by <b style={{ color: "var(--lamp)" }}>{race.clock(leaveByH)}</b></>}
              </div>
            </div>
          </Block>
        );
      })()}

      {s.notes && (
        <div className="numerals" style={{ fontSize: 12, color: "var(--mist-mute)", marginTop: 12, lineHeight: 1.6 }}>
          {s.notes}
        </div>
      )}
    </section>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--edge)" }}>
      <Eyebrow style={{ marginBottom: 5 }}>{label}</Eyebrow>
      {children}
    </div>
  );
}

/** What to carry out of the next station — the fuel plan's leg, verbatim. */
function PickUp({ out, through, stationName }: {
  out: FuelSegment | null; through: FuelSegment | null; stationName: string;
}) {
  if (!out) {
    return (
      <Block label="pick up">
        <div style={{ fontSize: 15, lineHeight: 1.5, color: "var(--mist-dim)" }}>
          No resupply here — you are carrying through
          {through ? <> to <b style={{ color: "var(--mist)" }}>{through.to}</b></> : null}.
          {through?.water_note?.includes(stationName) && (
            <b style={{ color: "var(--creek)" }}> Top up water.</b>
          )}
        </div>
      </Block>
    );
  }
  const items = [
    out.fill,
    out.gels > 0 ? `${out.gels} gel` : null,
    out.bloks > 0 ? `${out.bloks} blok` : null,
    out.salt_tabs > 0 ? `${out.salt_tabs} salt` : null,
  ].filter(Boolean).join(" · ");
  return (
    <Block label="pick up">
      <div style={{ fontSize: 19, fontWeight: 600, lineHeight: 1.4, overflowWrap: "anywhere" }}>{items}</div>
      <div className="numerals" style={{ fontSize: 12, color: "var(--mist-dim)", marginTop: 5, lineHeight: 1.6 }}>
        carry {fmtCarry(out.carryH)} to {out.to} · {out.carb_g} g · {(out.fluid_ml / 1000).toFixed(1)} L
        {out.heat ? " · ☀" : ""}{out.night ? " · ☾" : ""}
        {out.via.length > 0 && <div>thru {out.via.join(", ")} — no resupply</div>}
        {out.water_note && <div style={{ color: "var(--creek)" }}>{out.water_note}</div>}
        {out.preloads.map((p) => (
          <div key={p.at ?? "aid"} style={{ color: "var(--lamp)" }}>
            drink {p.ml} mL before leaving {p.at ?? "the aid"}
          </div>
        ))}
        {out.ration && <div style={{ color: "var(--ember)" }}>RATION — demand exceeds what you can carry</div>}
      </div>
      <div className="numerals" style={{ fontSize: 12, color: "var(--mist-mute)", marginTop: 4 }}>
        {out.supplement}
      </div>
    </Block>
  );
}

function CompactStation({ sp, clock }: { sp: StationProjection; clock: (h: number) => string }) {
  const u = useUnits();
  const s = sp.station;
  return (
    <div
      className="panel"
      style={{
        padding: "11px 13px", marginTop: 7, display: "flex",
        justifyContent: "space-between", alignItems: "center", gap: 10,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600, overflowWrap: "anywhere" }}>{s.name}</div>
        <div className="numerals" style={{ fontSize: 11, color: "var(--mist-mute)", marginTop: 2 }}>
          {u.dist(s.total_mi)} {u.distUnit}
          {s.cutoff_h != null && (
            <> · cut {clock(s.cutoff_h)} <span style={{ color: marginColor(sp.cutoff_margin_h) }}>
              {sp.cutoff_margin_h != null ? fmtSigned(sp.cutoff_margin_h) : ""}
            </span></>
          )}
        </div>
      </div>
      <div className="numerals" style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{clock(sp.eta_h.avg)}</div>
        <div style={{ fontSize: 10, color: "var(--mist-mute)" }}>
          {clock(sp.eta_h.best)}–{clock(sp.eta_h.worst)}
        </div>
      </div>
    </div>
  );
}
