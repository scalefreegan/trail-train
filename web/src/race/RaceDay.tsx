import { useEffect, useState } from "react";
import { useActiveRace, useBlockConfig, useRefresh, useUnits } from "../data";
import { raceLocalParts } from "./clock";
import { clearHash } from "./hashRoute";
import { fmtCarry, type DropBag, type FuelPlan, type FuelSegment } from "./nutrition";
import { fmtElapsed, fmtRaceClock, type StationProjection } from "./pacing";
import { checkpointHold, type CheckpointHold } from "./checkpointHold";
import { pickHold } from "./holdPrecedence";
import { resolveHold } from "./raceDayHold";
import { parseWhereAmI } from "./whereAmI";
import { RacePlanProvider } from "./RacePlanProvider";
import { RaceErrorBoundary } from "./RaceErrorBoundary";
import { useCrewBase, useRaceResult, useTracker } from "./useRaceData";
import { useRacePlan, type RacePlan } from "./useRacePlan";
import { useRunCourseAgain } from "./runCourseAgain";

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
/*  Where the runner actually is — three answers, one hold             */
/*                                                                    */
/*  The clock alone answers "where am I" only if the projection is     */
/*  right, and by mile 60 it usually is not. So three things can say   */
/*  otherwise, in the order they became possible:                      */
/*                                                                    */
/*    1. the runner, by mile or by station: "I'm at mile X" / "I just  */
/*       left <station>" (the SET control);                            */
/*    2. the runner, by checkpoint: "passed <station> at HH:MM" — the  */
/*       same statement with a TIME on it, which is what makes it      */
/*       comparable to the tracker's;                                  */
/*    3. the race's own timing site, polled every 60 s (PRD v2 §4).    */
/*                                                                    */
/*  Both manual forms are persisted per slug — an override is a fact   */
/*  about one race, and a phone that sleeps mid-climb must come back   */
/*  knowing it. The tracker is not persisted: it re-polls.             */
/*                                                                    */
/*  WHO WINS. Not "whichever was entered most recently" — the tracker  */
/*  re-polls every minute, so its poll timestamp is always the newest  */
/*  thing on the page and it would bulldoze a manual entry a minute    */
/*  after it was made. What is compared is when each one says the      */
/*  runner was SEEN: a checkpoint at 21:40 typed by hand beats the     */
/*  tracker's last sighting at 21:22, and stops beating it the moment  */
/*  the tracker catches up at 22:10. Manual wins a tie.                */
/*                                                                    */
/*  The override moves WHICH station is next. It does NOT re-project:  */
/*  the ETAs stay the shared plan's, so they still match the printed   */
/*  card, and the gap between where you are and where the plan says    */
/*  you'd be is shown as its own line instead of being silently        */
/*  absorbed.                                                          */
/* ------------------------------------------------------------------ */

/** What the runner said, as it is stored. Exactly one of `mi` (a mile off
    the chart or typed) and `station` (+ optional `clock`) is set. */
type ManualHold = {
  mi: number | null;
  station: string | null;
  /** race-local HH:MM the station was passed at, when one was given */
  clock: string | null;
  /** ISO instant the entry was MADE — the fallback "when was this true?"
      for a bare mile, which carries no clock of its own */
  at: string;
};

/** What a hold written by the pre-tracker build (a bare number under
    `raceday_mi`) is dated. Deliberately the epoch: it is a real hold and
    still applies, but nothing is known about when it was made, so the
    first tracker checkpoint of the race outranks it. */
const LEGACY_HOLD_AT = new Date(0).toISOString();

/**
 * Per-slug localStorage state, re-read in the RENDER phase when the slug
 * changes rather than in an effect — the slug arrives a fetch late, and an
 * effect would flash the un-overridden station first (the same pattern
 * useRacePlan's knobs use).
 */
function useSlugStored<T>(
  slug: string | null,
  name: string,
  decode: (raw: string) => T | null,
  encode: (v: T) => string,
) {
  const key = slug ? `race.${slug}.${name}` : null;
  const read = (): T | null => {
    if (key == null || typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? null : decode(raw);
    } catch { return null; }
  };
  const [state, setState] = useState(() => ({ key, v: read() }));
  if (state.key !== key) setState({ key, v: read() });
  const set = (v: T | null) => {
    setState({ key, v });
    if (key == null) return;
    try {
      if (v == null) localStorage.removeItem(key);
      else localStorage.setItem(key, encode(v));
    } catch { /* private mode */ }
  };
  return [state.v, set] as const;
}

function decodeManualHold(raw: string): ManualHold | null {
  try {
    const d = JSON.parse(raw) as Partial<ManualHold>;
    const mi = typeof d?.mi === "number" && Number.isFinite(d.mi) ? d.mi : null;
    const station = typeof d?.station === "string" && d.station.trim() ? d.station : null;
    if (mi == null && station == null) return null;
    return {
      mi,
      station,
      clock: typeof d?.clock === "string" && d.clock.trim() ? d.clock : null,
      at: typeof d?.at === "string" && !Number.isNaN(Date.parse(d.at)) ? d.at : LEGACY_HOLD_AT,
    };
  } catch { return null; } // a half-written entry
}

const decodeNumber = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

/** The runner's own hold, whichever form it was entered in. */
function useManualHold(slug: string | null) {
  const [stored, setStored] = useSlugStored<ManualHold>(slug, "raceday_hold", decodeManualHold, JSON.stringify);
  // Written by every build before this one: a bare mile, no timestamp.
  const [legacyMi, setLegacyMi] = useSlugStored<number>(slug, "raceday_mi", decodeNumber, String);
  const hold: ManualHold | null = stored
    ?? (legacyMi != null ? { mi: legacyMi, station: null, clock: null, at: LEGACY_HOLD_AT } : null);
  const set = (next: ManualHold | null) => {
    setStored(next);
    // Migrate on the first write of the session: leaving the old key behind
    // would resurrect the old mile the next time AUTO cleared the new one.
    if (legacyMi != null) setLegacyMi(null);
  };
  return [hold, set] as const;
}

/**
 * Elapsed hours at or below which a tracker checkpoint is ignored, set by
 * AUTO. The tracker keeps polling and will keep reporting the checkpoint
 * that was just dismissed, so "AUTO clears the tracker hold" has to mean
 * "and stays cleared until the tracker sees something NEW" — which it does,
 * at the next aid station, and then the hold comes back on its own.
 */
function useTrackerMute(slug: string | null) {
  return useSlugStored<number>(slug, "raceday_tracker_muted_h", decodeNumber, String);
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

/** Countdown to the gun: "Xh Ym" once under a day, "Xd Yh" beyond that.
    Plain hours with no bound reads as "7869h 53m" for a race a year out —
    nobody parses that at a glance, and the dashboard's own command bar
    already gets it right in the same session ("RACE IN 328 days"). */
function fmtCountdown(h: number): string {
  if (h < 24) return fmtElapsed(h);
  const days = Math.floor(h / 24);
  const hh = Math.floor(h - days * 24);
  return `${days}d ${hh}h`;
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
    // outside the provider on purpose — useRacePlanInstance computes the
    // whole plan during RacePlanScope's render, so a bad folder (a draft's
    // course built before its date was known, say) throws before RaceDay
    // itself ever mounts (tt bug fix-sun-null).
    <RaceErrorBoundary slug={viewing}>
      <RacePlanProvider>
        <RaceDay />
      </RacePlanProvider>
    </RaceErrorBoundary>
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
  const { viewing, error: activeError, offline, viewOnlyCacheMiss } = useActiveRace();
  const { crewBase } = useCrewBase();
  const { reload } = useRefresh();
  const now = useNow();
  const [manual, setManual] = useManualHold(viewing);
  const [mutedH, setMutedH] = useTrackerMute(viewing);
  const [miDraft, setMiDraft] = useState("");
  const [stationDraft, setStationDraft] = useState("");
  // Set only when the free-text box held something SET could not place —
  // "mile 50", "50 mi", "80 km", a station name typed instead of picked —
  // so the box can say so instead of looking broken (v2 review ui1 #3).
  // Cleared on the next keystroke or a successful commit, never carried
  // across an unrelated field.
  const [whereAmIError, setWhereAmIError] = useState<string | null>(null);
  // the "passed <station> at HH:MM" form's two controls
  const [cpStation, setCpStation] = useState("");
  const [cpClock, setCpClock] = useState<string | null>(null);
  // D8: the same free, deterministic build the switcher's "Run course
  // again…" row and the fuel view's empty state call.
  //
  // Round 3 sweep, second pass: slug passed unconditionally, matching
  // RacePlanner.tsx's/NutritionPlan.tsx's own copies of this line — this
  // call site was never remounted by its own reload() (RaceDayRoute has no
  // App.tsx-style `key={pulse}` wrapping it), but leaving a real slug
  // sitting here regardless means runCourseAgain.ts's resultStore-recovery
  // effect still helps across whatever DOES unmount this component, such as
  // navigating away from #/race-day and back.
  const courseBuild = useRunCourseAgain(viewing, reload);

  const elapsedH = (now - raceStart.getTime()) / 3_600_000;
  const started = elapsedH >= 0;
  // The race's OWN calendar date vs. today, both read on the race's clock —
  // not "has the gun gone off" (elapsedH >= 0 is true for the entire race,
  // including one still under way) but "is race day itself behind us."
  // D5: a race whose date has passed kept projecting a finish as if the
  // runner were still on pace 9 days after the gun.
  const racePast = raceLocalParts(raceStart, plan.timeZone).iso < raceLocalParts(now, plan.timeZone).iso;
  // Only fetched once the race is actually past — a live race has no result
  // yet, and asking is noise (useRaceResult(null) fetches nothing at all).
  const { result: pastResult } = useRaceResult(racePast ? viewing : null);
  // round 2, generic finding 4: telling the athlete to archive a race that
  // is already archived (it already HAS a result) is advice with nothing
  // left to act on.
  const alreadyArchived = plan.raceConfig.status === "archived";
  const stations = proj?.stations ?? [];

  /* ---- live tracker (PRD v2 §4) ---- */
  // Polled only when the folder actually names a tracker: useTracker(null)
  // fetches nothing at all, so a race with no `tracking.url` costs one
  // conditional rather than a 404 a minute.
  const trackerUrl = plan.raceConfig.tracking?.url?.trim() ?? "";
  const { tracker, notice: trackerNotice } = useTracker(trackerUrl && !racePast ? viewing : null);
  // The aid chart, in the shape checkpointHold reads. The projection's own
  // stations, so a hold and an ETA can never be about different charts.
  const chart = stations.map((sp) => sp.station);
  const startMs = raceStart.getTime();
  /** Race hours at an ISO instant — how a hold with no clock of its own is
      dated, so it can still be compared against one that has a clock. */
  const atElapsed = (iso: string | null | undefined): number | null => {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? (ms - startMs) / 3_600_000 : null;
  };

  const manualHold: CheckpointHold | null = manual == null ? null
    : manual.station != null
      ? checkpointHold(
          { station: manual.station, clock: manual.clock, source: "manual" },
          chart, raceStart, plan.timeZone, { now },
        )
      // A bare mile carries no station and no clock, so it is not something
      // checkpointHold can resolve — it IS the answer already.
      : manual.mi != null
        ? { mile: manual.mi, elapsed_h: null, source: "manual", label: "held by hand" }
        : null;
  const manualObsH = manualHold ? manualHold.elapsed_h ?? atElapsed(manual?.at) : null;

  const trackerHold = tracker ? checkpointHold(tracker, chart, raceStart, plan.timeZone, { now }) : null;
  const trackerObsH = trackerHold ? trackerHold.elapsed_h ?? atElapsed(tracker?.at) : null;
  // Dismissed by AUTO, and still dismissed until the tracker sees the runner
  // somewhere NEW (see useTrackerMute).
  const trackerMuted = mutedH != null && (trackerObsH == null || trackerObsH <= mutedH);
  const liveHold = trackerMuted ? null : trackerHold;

  // Whichever says the runner was seen LATER — not whichever was recorded
  // most recently, which the tracker always would be. Manual wins a tie, and
  // an off-chart live reading (no course mile — see pickHold) never outranks
  // a manual hold on recency, since it has no position to compare in the
  // first place (v2 review ui3 #2).
  const hold = pickHold(manualHold, manualObsH, liveHold, trackerObsH);
  // A checkpoint whose name is not on the aid chart is a real sighting with
  // no mile attached (a timing mat, a renamed station). It is reported, but
  // it must not move the runner to a mile nobody worked out.
  const posMi = hold?.mile ?? null;
  const holdOffChart = hold != null && hold.mile == null;
  // The checkpoint form's default time. RACE-local: the runner may be in a
  // different zone from the race (a phone that never left home time), and
  // every other clock on this page is the race's.
  const nowLocal = raceLocalParts(now, plan.timeZone);
  const nowHHMM = `${String(nowLocal.hour).padStart(2, "0")}:${String(nowLocal.minute).padStart(2, "0")}`;
  // Where to measure "to go" from: the stated mile if the runner gave one,
  // otherwise the mile the plan has them at right now. Both are honest —
  // one is observed, the other is the projection's own answer — and the
  // "where am i" block below says which is in force.
  const posEff = posMi ?? (started && proj ? proj.mileAtElapsed(elapsedH) : null);
  const idx = nextStationIdx(stations, elapsedH, posMi);
  const next = stations[idx] ?? null;
  const upcoming = stations.slice(idx + 1, idx + 1 + LOOKAHEAD);

  const drives = features.crew ? crewBase?.drives ?? {} : {};
  // viewOnlyCacheMiss: the failed reload's only offline fallback was a
  // browsed OTHER race, not this one — the plan already on screen is still
  // fine, so it reads the same friendly way `offline` does rather than as
  // the internals-flavored "(HTTP 500) — only a view-mode copy of ... is
  // cached offline" string activeError would otherwise carry verbatim.
  const staleNotice = offline || viewOnlyCacheMiss
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
          {/* A race day that has passed has nothing live to project — the
              "+7" race-relative clock offset it used to show (round 2,
              generic finding 4) is a number about TODAY, not about the race,
              on a screen that has just said there is nothing left to show.
              The recorded finish, once archived, is worth the same space;
              until then it's a dash, not a stale countdown. */}
          {racePast
            ? (pastResult?.finish_h != null ? race.clock(pastResult.finish_h) : "—")
            : started
            ? race.clock(elapsedH)
            /* Before the gun, elapsedH is negative and stands in for "right
               now", not a race-relative ETA — a +/-N day marker on it is a
               number about the calendar, not about the race, and glitchy to
               read at that (v2 review ui2 #7: "5:47p-328" 327 days out). The
               line right under this already says "starts in 327d 12h · gun
               6:00a"; this one just wants the current race-local wall clock. */
            : fmtRaceClock(raceStart, elapsedH, plan.timeZone, { dayMarker: false })}
        </div>
        <div className="numerals" style={{ fontSize: 15, color: "var(--mist-dim)", marginTop: 6 }}>
          {racePast
            ? <span style={{ color: "var(--mist-mute)" }}>race day has passed</span>
            : started
            ? <>elapsed <b style={{ color: "var(--mist)" }}>{fmtElapsed(elapsedH)}</b>
                {race.cutoff_h != null && <> · cutoff {fmtElapsed(race.cutoff_h)}</>}</>
            : <>starts in <b style={{ color: "var(--lamp)" }}>{fmtCountdown(-elapsedH)}</b> · gun {race.clock(0)}</>}
        </div>
      </header>

      {staleNotice && <Notice tone="warn">{staleNotice}</Notice>}

      {racePast ? (
        // D5: a race whose calendar date is behind us used to keep
        // projecting a finish "on pace" no matter how far past the cutoff
        // the clock had run (218h elapsed against a 38h cutoff, still
        // showing a finish ETA). Race day is over; say so instead of
        // guessing a position for a runner who is either long done or long
        // since stopped.
        <Notice tone="mute">
          {race.short} was {raceLocalParts(raceStart, plan.timeZone).iso} — race day has passed, so this page
          won't project a live position for it any more.
          {alreadyArchived
            ? (pastResult?.finish_h != null && <> Finished in {fmtElapsed(pastResult.finish_h)}.</>)
            : " Archive it with a result from the dashboard switcher when you're ready."}
        </Notice>
      ) : (
        <>
          {/* ---------- the plan, or why there isn't one ---------- */}
          {!proj ? (
            <Notice tone="mute">
              {missing ? (
                <>
                  No course.json for this race yet.
                  <div style={{ marginTop: 10 }}>
                    <button
                      className="chip"
                      onClick={courseBuild.run}
                      disabled={courseBuild.busy}
                      style={{ minHeight: 40, padding: "0 14px" }}
                    >
                      {courseBuild.busy ? "building…" : "run course build"}
                    </button>
                    <div style={{ marginTop: 6 }}>Parses the stored GPX — free, no agent turn.</div>
                    {courseBuild.error && <div style={{ color: "var(--ember)", marginTop: 6 }}>{courseBuild.error}</div>}
                    {/* Round 3 sweep extension: a course DID build (this
                        whole block is about to disappear once `missing`
                        flips false) but the hook's own `warnings` says it's
                        degraded — worth a beat before the real course view
                        takes over. Unlike RacePlanner.tsx's/NutritionPlan.tsx's
                        own copies of this same block, this one actually
                        reaches the screen: RaceDayRoute (#/race-day) mounts
                        RacePlanProvider directly, with none of App.tsx's
                        `key={`race-${key}`}`/`key={`fuel-${key}`}` remount-
                        on-every-reload wrapping the RACE/FUEL tabpanels do —
                        so courseBuild.run()'s onDone()/reload() re-fetches
                        course.json in place here rather than tearing this
                        component down first. Pinned in
                        web/tests/switcher.spec.ts's RaceDay test. */}
                    {courseBuild.warnings.length > 0 && (
                      <div style={{ color: "var(--lamp)", marginTop: 6 }}>⚠ {courseBuild.warnings.join(" · ")}</div>
                    )}
                  </div>
                </>
              ) : (
                "The projection needs the course profile and a Strava pace fit. Open the dashboard on the laptop once to load them."
              )}
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
                const resolved = resolveHold(stationDraft, miDraft, u.system);
                // Nothing valid to commit (both drafts empty, or an
                // unparseable/negative mile) is a no-op — SET must never
                // fall back to mile 0 (D1/D2).
                if (resolved != null) {
                  setManual({ mi: resolved, station: null, clock: null, at: new Date(now).toISOString() });
                  setStationDraft("");
                  setMiDraft("");
                  setWhereAmIError(null);
                  return;
                }
                // resolveHold only reads the station <select> or a bare
                // number — everything else typed into the free-text box
                // (the select itself is untouched here, since it's exact by
                // construction) falls through to the wider parser: "mile
                // 50", "50 mi", "80 km", a station name (v2 review ui1 #3).
                if (stationDraft === "" && miDraft.trim() !== "") {
                  const parsed = parseWhereAmI(miDraft, stations.map((sp) => sp.station.name), u.system);
                  const mi = parsed.kind === "mile"
                    ? parsed.mi
                    : parsed.kind === "station"
                    ? stations.find((sp) => sp.station.name === parsed.name)?.station.total_mi ?? null
                    : null;
                  if (mi != null) {
                    setManual({ mi, station: null, clock: null, at: new Date(now).toISOString() });
                    setStationDraft("");
                    setMiDraft("");
                    setWhereAmIError(null);
                    return;
                  }
                  // Unparsable: leave the text so the runner can fix it,
                  // rather than clearing a box that never took the entry.
                  setWhereAmIError(
                    // v2 review confirm-ui1 NEW #3: a bare number is read in
                    // whatever unit the toggle currently shows (u.distUnit,
                    // matching parseWhereAmI/resolveHold's own rule) — in
                    // KM·M mode "try a mile number" told the runner the
                    // wrong thing about the box she was staring at.
                    `can't read "${miDraft.trim()}" — try a bare ${u.distUnit} number, "mile 50", "50 mi", "80 km", or a station name`,
                  );
                }
              }}
              style={{ display: "flex", gap: 6, flex: "1 1 150px", minWidth: 0 }}
            >
              <input
                value={miDraft}
                onChange={(e) => { setMiDraft(e.target.value); setStationDraft(""); setWhereAmIError(null); }}
                /* decimal, not numeric: mile 42.3 needs the point on iOS, and
                   "mile 50"/"50 mi"/"80 km"/a station name all need letters */
                inputMode="text"
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
            {hold != null && (
              <button
                className="chip"
                onClick={() => {
                  // BOTH holds. Dropping only the manual one would leave the
                  // tracker's still in force and AUTO would look broken; the
                  // mute lifts by itself at the next new checkpoint.
                  setManual(null);
                  setMutedH(trackerHold ? trackerObsH ?? elapsedH : null);
                  setStationDraft("");
                  setMiDraft("");
                  setWhereAmIError(null);
                  setCpStation("");
                  setCpClock(null);
                }}
                style={{ minHeight: 44, padding: "0 14px" }}
              >
                auto
              </button>
            )}
          </div>
          {whereAmIError && (
            <div className="numerals" style={{ fontSize: 11, color: "var(--ember)", marginTop: 6, lineHeight: 1.5 }}>
              {whereAmIError}
            </div>
          )}
          {/* Controlled by stationDraft, not committed until SET: picking a
              station used to move the hold on *change*, and then SET — read
              as "confirm what I just picked" — actually submitted the (now
              empty-looking) mile field instead, silently resetting the hold
              to mile 0. Now the select just stages a choice, SET commits
              whichever draft has something in it (see resolveHold), and the
              picked station stays visible instead of snapping back to the
              placeholder. */}
          <select
            value={stationDraft}
            onChange={(e) => { setStationDraft(e.target.value); setMiDraft(""); setWhereAmIError(null); }}
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
          {stationDraft !== "" && (
            <div className="numerals" style={{ fontSize: 11, color: "var(--lamp)", marginTop: 6 }}>
              picked — press SET to hold here
            </div>
          )}

          {/* ---------- passed <station> at HH:MM ---------- */}
          {/* The same fact as a station pick, WITH A TIME on it. That time is
              what makes a hand entry comparable to the tracker's last
              sighting (see the header comment): without it, the tracker
              would reclaim the hold on its very next poll. */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (cpStation === "") return;
              setManual({
                mi: null,
                station: cpStation,
                clock: cpClock ?? nowHHMM,
                at: new Date(now).toISOString(),
              });
              setCpStation("");
              setCpClock(null);
              setStationDraft("");
              setMiDraft("");
              // Round 3 finding 3: this form commits a hold exactly like the
              // "where am i" one above and clears the same two drafts, but
              // used to leave whereAmIError on screen — a stale complaint
              // about a mile/station typo the runner never even used this
              // form to retype, sitting under a hold that just succeeded.
              setWhereAmIError(null);
            }}
            style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}
          >
            <select
              value={cpStation}
              onChange={(e) => setCpStation(e.target.value)}
              aria-label="passed a station"
              style={{
                flex: "2 1 150px", minWidth: 0, minHeight: 44, padding: "0 10px", fontSize: 15,
                background: "var(--night-deep)", border: "1px solid var(--edge-bright)",
                color: "var(--mist)", fontFamily: "var(--font-body)",
              }}
            >
              <option value="">passed…</option>
              {stations.map((sp) => (
                <option key={sp.station.name} value={sp.station.name}>
                  {sp.station.name}
                </option>
              ))}
            </select>
            <input
              type="time"
              value={cpClock ?? nowHHMM}
              onChange={(e) => setCpClock(e.target.value)}
              aria-label="time passed (race time)"
              className="numerals"
              style={{
                flex: "1 1 96px", minWidth: 0, minHeight: 44, padding: "0 8px", fontSize: 15,
                background: "var(--night-deep)", border: "1px solid var(--edge-bright)", color: "var(--mist)",
              }}
            />
            <button
              type="submit"
              className="chip"
              disabled={cpStation === ""}
              style={{ minHeight: 44, padding: "0 14px", opacity: cpStation === "" ? 0.5 : 1 }}
            >
              at
            </button>
          </form>

          {hold == null ? (
            <div className="numerals" style={{ fontSize: 12, color: "var(--mist-mute)", marginTop: 8, lineHeight: 1.6 }}>
              auto — position and “to go” come from the projection against the clock.
              Say where you actually are if it has drifted.
              {trackerUrl && !trackerNotice && (
                <div>Watching the race tracker — it will take over as soon as it sees you.</div>
              )}
            </div>
          ) : holdOffChart ? (
            // A sighting with no mile: reported, never guessed at. The
            // projection keeps the position.
            <div className="numerals" style={{ fontSize: 12, color: "var(--mist-dim)", marginTop: 8, lineHeight: 1.6 }}>
              seen at <b style={{ color: "var(--mist)" }}>{hold === manualHold ? manual?.station : tracker?.station}</b>
              {" "}({hold.label}) — that checkpoint is not on this race's aid chart, so the position
              below is still the projection's.
            </div>
          ) : (
            <div className="numerals" style={{ fontSize: 12, color: "var(--mist-dim)", marginTop: 8, lineHeight: 1.6 }}>
              held at <b style={{ color: "var(--mist)" }}>{u.dist(posMi ?? 0)} {u.distUnit}</b>
              {" · "}<span style={{ color: hold.source === "manual" ? "var(--mist-mute)" : "var(--creek)" }}>{hold.label}</span>
              {proj && started && posMi != null && (() => {
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

          {trackerNotice && <Notice tone="mute">{trackerNotice}</Notice>}
        </>
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
