import { useEffect, useState } from "react";
import { useActiveRace, useRefresh } from "../data";
import { cacheGet, cachePut, slugKey } from "./offlineCache";
import type { ClimbsSnapshot, Course, CrewBase, TrackerCheckpoint, TrackerResponse } from "./types";
import type { PaceGradeCurve } from "./pacing";
import { PHYSIOLOGY_FIELDS } from "../contracts";
import { loadFailureMessage } from "./loadFailureMessage";
import { isKnownCourseless } from "./courseAvailability";

/* Snapshot hooks for the Race views — same provider-less pattern as
   useGoogleCal (data.ts): fetch keyed on the refresh pulse.

   Failure semantics are deliberate: only an HTTP 404 means "the file hasn't
   been generated yet" (`missing: true`, or null data for the optional
   crew-base). Every other failure — non-404 status, JSON parse error, network
   error — is a load failure, not an absence: previously-loaded data is KEPT,
   `missing` stays false, and a concise `error` string is surfaced so the UI
   can flag stale/failed data instead of telling the user to rebuild a file
   that already exists. */

/**
 * The active race's course profile + aid chart.
 *
 * Gated on the active-race pointer having RESOLVED, and keyed on its slug:
 * /course.json is served out of whichever race folder is pointed at, so the
 * offline copy has to be filed under the race it belongs to — a 50k's
 * profile restored under a hundred's name would be a silently wrong plan.
 * The extra round-trip costs nothing visible: every consumer of this hook
 * already sits inside a race gate that waits on the same pointer.
 */
export function useCourse() {
  const { key: refreshKey } = useRefresh();
  // `viewing`, not `slug`: the dev server serves /course.json,
  // /crew-base.json and /nutrition.json out of the folder the POINTER
  // names, which in view mode (tt-yib.7) is the archived race being
  // browsed rather than the training target. Keying the cache on the
  // training slug would file one race's course under another's name.
  const { viewing: slug, resolved, activeRace } = useActiveRace();
  const [data, setData] = useState<Course | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v2 review ui1 #14: see courseAvailability.ts — a tune-up created
  // without a GPX 404s on /course.json for its whole life, and Chrome logs
  // that to the console on its own no matter how the response is handled.
  // Overridden only in the RETURNED value, never via setState in the effect
  // (a synchronous setState right in an effect body is its own lint-flagged
  // smell) — so a stale `data`/`missing`/`error` left over from whatever was
  // on screen before switching to this tune-up can never leak through.
  const knownCourseless = isKnownCourseless(activeRace?.race);
  useEffect(() => {
    if (!resolved || knownCourseless) return;
    let stale = false;
    const cacheKey = slugKey("course", slug);
    // a load failure is not an absence: fall back to the last copy that DID
    // load (see offlineCache.ts) and label it, rather than blanking the view
    const fallback = (message: string) => {
      if (stale) return;
      const cached = cacheGet<Course>(cacheKey);
      setMissing(false);
      if (cached) { setData(cached); setError(`${message} — showing the last saved copy`); }
      else setError(message);
    };
    // `?slug=` pins the response to THIS race regardless of the server's
    // mutable pointer (config/active-race.json) — without it, a request left
    // in flight across a race switch resolves against whichever folder the
    // pointer names by the time the server gets to it, not the one this hook
    // was fetching for, and the wrong race's course then gets cached under
    // this (correct) slug's offline key (PR #23 review round 2, resilience
    // finding 1). Omitted only in generic mode (`slug` null), where there is
    // no specific race to pin to and the server's "most recent" fallback is
    // the existing, harmless behavior.
    const url = slug ? `/course.json?slug=${encodeURIComponent(slug)}&t=${Date.now()}` : `/course.json?t=${Date.now()}`;
    fetch(url)
      .then(async (r) => {
        if (stale) return;
        if (r.status === 404) { setData(null); setMissing(true); setError(null); return; }
        if (!r.ok) { fallback(`course.json failed to load (HTTP ${r.status})`); return; }
        const d = await r.json().catch(() => { throw new Error("parse"); });
        cachePut(cacheKey, d);
        if (stale) return;
        setData(d); setMissing(false); setError(null);
      })
      .catch((e) => fallback(loadFailureMessage(e, "course.json corrupt or unreadable")));
    return () => { stale = true; };
  }, [refreshKey, resolved, slug, knownCourseless]);
  return knownCourseless
    ? { course: null, missing: true, error: null }
    : { course: data, missing, error };
}

/** Optional — crew-base.json exists wherever the race folder has a
    crew.private.json (tt-yib.9). Its `base` may still be null: emergency
    numbers and race-week lodging are independent. */
export function useCrewBase() {
  const { key: refreshKey } = useRefresh();
  // `viewing`, not `slug`: the dev server serves /course.json,
  // /crew-base.json and /nutrition.json out of the folder the POINTER
  // names, which in view mode (tt-yib.7) is the archived race being
  // browsed rather than the training target. Keying the cache on the
  // training slug would file one race's course under another's name.
  const { viewing: slug, resolved } = useActiveRace();
  const [data, setData] = useState<CrewBase | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!resolved) return;
    let stale = false;
    // cached like course.json: race-day mode shows the crew drive and the
    // leave-by time off this file, and they are exactly what a crew captain
    // checks from a car park with one bar of signal
    const cacheKey = slugKey("crew-base", slug);
    const fallback = (message: string) => {
      if (stale) return;
      const cached = cacheGet<CrewBase>(cacheKey);
      if (cached) { setData(cached); setError(`${message} — showing the last saved copy`); }
      else setError(message);
    };
    // see useCourse's comment on `?slug=` — same pointer race, same fix
    const url = slug ? `/crew-base.json?slug=${encodeURIComponent(slug)}&t=${Date.now()}` : `/crew-base.json?t=${Date.now()}`;
    fetch(url)
      .then(async (r) => {
        if (stale) return;
        if (r.status === 404) { setData(null); setError(null); return; }
        if (!r.ok) { fallback(`crew-base.json failed to load (HTTP ${r.status})`); return; }
        const d = await r.json().catch(() => { throw new Error("parse"); });
        cachePut(cacheKey, d);
        if (stale) return;
        setData(d); setError(null);
      })
      .catch((e) => fallback(loadFailureMessage(e, "crew-base.json corrupt or unreadable")));
    return () => { stale = true; };
  }, [refreshKey, resolved, slug]);
  return { crewBase: data, error };
}

/** Personal pace-vs-grade curve written by sync-streams. Same failure
    semantics as the other snapshot hooks: 404 = not fitted yet (null, no
    error); any other failure KEEPS the previously loaded curve and surfaces
    an error string, so the projection never silently swaps to the fallback
    grade model mid-session. Entries are validated — a hand-corrupted file
    reads as a load failure, not as a curve. */
/** Not namespaced by slug: the pace-vs-grade fit is the athlete's own, the
    same file whichever race is on screen — same reasoning as StravaProvider's
    STRAVA_CACHE_KEY in providers.tsx. */
const PACE_GRADE_CACHE_KEY = "pace-grade";

export function usePaceGrade() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<PaceGradeCurve>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    // v2 review ui2 #1: the projection needs this curve offline exactly as
    // much as it needs course.json, but until now nothing cached it — a
    // reload with the server unreachable fell back to the fallback grade
    // model silently mid-race. Same fallback shape as useCourse/useCrewBase:
    // a load failure (never a 404, which means "not fitted yet") reaches for
    // the last copy that DID load rather than blanking the curve.
    const fallback = (message: string) => {
      if (stale) return;
      const cached = cacheGet<PaceGradeCurve>(PACE_GRADE_CACHE_KEY);
      if (cached) { setData(cached); setError(`${message} — showing the last saved copy`); }
      else setError(message);
    };
    fetch(`/pace-grade.json?t=${Date.now()}`)
      .then(async (r) => {
        if (stale) return;
        if (r.status === 404) { setData(null); setError(null); return; }
        if (!r.ok) { fallback(`pace-grade.json failed to load (HTTP ${r.status})`); return; }
        const d = await r.json().catch(() => { throw new Error("parse"); });
        const valid = d && Array.isArray(d.curve) && d.curve.length > 0 &&
          d.curve.every((p: { g: unknown; mult: unknown }) =>
            Number.isFinite(p.g) && Number.isFinite(p.mult) && (p.mult as number) > 0);
        if (!valid) { fallback("pace-grade.json invalid — using previous curve or fallback"); return; }
        if (stale) return;
        cachePut(PACE_GRADE_CACHE_KEY, d);
        setData(d); setError(null);
      })
      .catch((e) => fallback(loadFailureMessage(e, "pace-grade.json corrupt or unreadable")));
    return () => { stale = true; };
  }, [refreshKey]);
  return { paceGrade: data, error };
}

export function useClimbs() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<ClimbsSnapshot | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/climbs.json?t=${Date.now()}`)
      .then(async (r) => {
        if (r.status === 404) { setData(null); setMissing(true); setError(null); return; }
        if (!r.ok) { setMissing(false); setError(`climbs.json failed to load (HTTP ${r.status})`); return; }
        const d = await r.json().catch(() => { throw new Error("parse"); });
        setData(d); setMissing(false); setError(null);
      })
      .catch(() => { setMissing(false); setError("climbs.json corrupt or unreadable"); });
  }, [refreshKey]);
  return { climbs: data, missing, error };
}

/* ------------------------------------------------------------------ */
/*  Athlete physiology — config/profile.json (tt-yib.9)                */
/*                                                                    */
/*  Body mass and the long-run reference distance belong to the        */
/*  RUNNER, not to the race: a race folder has to be shareable without */
/*  carrying someone's weight, and the pacing fit must not silently be */
/*  read at a reference distance a different race chose. They live in  */
/*  the gitignored config/profile.json and reach the client through    */
/*  the settings endpoint the coach dialog already uses, rather than   */
/*  through a generated file in web/public — one writer, one reader,   */
/*  and an edit in the dialog is live on the next refresh pulse.       */
/*                                                                    */
/*  That endpoint is dev-only middleware, so a static build (or a dev  */
/*  server that hasn't been restarted) legitimately has no profile.    */
/*  The defaults below then carry the page, and `error` says which     */
/*  numbers the plan is actually built on — a caffeine band against a  */
/*  stand-in body mass looks exactly like one against the athlete's,   */
/*  which is the whole reason this stopped being a hard-coded literal  */
/*  in a committed race folder.                                        */
/* ------------------------------------------------------------------ */

export type Physiology = {
  /** athlete mass, kg — drives every mg/kg caffeine figure */
  body_kg: number;
  /** distance the fitted fitness pace is evaluated at, mi (pacing D_REF) */
  long_run_ref_mi: number;
  /** the elevation the athlete is acclimated to, ft — the altitude term
      measures the race's elevation against it. NULL means nobody has set
      one: the model then falls back to sea level and every view that shows
      the term says so, because silently assuming sea level would hand a
      mountain-town athlete hours of penalty they do not owe. Unlike the two
      above there is no default worth substituting — see PHYSIOLOGY_FIELDS'
      `optional` in scripts/contracts.mjs. */
  home_elevation_ft: number | null;
};

/** What the client plans against when /api/settings is unreachable. The
    numbers are PHYSIOLOGY_FIELDS' own defaults, which is exactly what the
    server normalizes a fresh profile to — so a missing endpoint and a
    just-bootstrapped checkout produce the same plan, not two different ones. */
export const DEFAULT_PHYSIOLOGY: Physiology = {
  body_kg: PHYSIOLOGY_FIELDS.body_kg.dflt,
  long_run_ref_mi: PHYSIOLOGY_FIELDS.long_run_ref_mi.dflt,
  home_elevation_ft: PHYSIOLOGY_FIELDS.home_elevation_ft.dflt,
};

const isPhysNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
/** Elevation is the one physiology number that may legitimately be 0 (or
    below it — the Dead Sea, Death Valley), so it can't use isPhysNumber. The
    band is the server's own, so a value the settings PUT accepted is never
    thrown away here. */
const isElevation = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isFinite(v) &&
  v >= PHYSIOLOGY_FIELDS.home_elevation_ft.lo &&
  v <= PHYSIOLOGY_FIELDS.home_elevation_ft.hi;

export function usePhysiology() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<Physiology>(DEFAULT_PHYSIOLOGY);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    fetch(`/api/settings?t=${Date.now()}`)
      .then(async (r) => {
        if (stale) return;
        if (!r.ok) {
          setError(`athlete profile unavailable (HTTP ${r.status}) — planning against ${DEFAULT_PHYSIOLOGY.body_kg} kg defaults`);
          return;
        }
        const d = await r.json().catch(() => { throw new Error("parse"); });
        if (stale) return;
        const p = (d as { physiology?: Partial<Physiology> }).physiology;
        // the server already applied its own defaults; this is belt-and-braces
        // against a hand-edited profile reaching the client half-validated
        if (!p || !isPhysNumber(p.body_kg) || !isPhysNumber(p.long_run_ref_mi)) {
          setError(`config/profile.json has no usable physiology — planning against ${DEFAULT_PHYSIOLOGY.body_kg} kg / ${DEFAULT_PHYSIOLOGY.long_run_ref_mi} mi defaults`);
          return;
        }
        setData({
          body_kg: p.body_kg,
          long_run_ref_mi: p.long_run_ref_mi,
          // absent until the athlete sets it (bead 02's settings field) —
          // null, never a stand-in
          home_elevation_ft: isElevation(p.home_elevation_ft) ? p.home_elevation_ft : null,
        });
        setError(null);
      })
      .catch(() => {
        if (!stale) setError(`athlete profile unreadable — planning against ${DEFAULT_PHYSIOLOGY.body_kg} kg defaults`);
      });
    return () => { stale = true; };
  }, [refreshKey]);
  return { physiology: data, error };
}

/** races/<slug>/result.json (PRD §10), as GET /api/races/:slug/result serves
    it. scripts/race-result.mjs writes the file and is the authority on its
    shape: it is a whole document rather than a table of values, so there is
    nothing for scripts/contracts.mjs to share — read that module before
    adding a field here, and add it there first. */
export type RaceResult = {
  status: "finished" | "dnf" | "dns";
  strava_activity_id: string | null;
  finish_h: number | null;
  official_time: string | null;
  placement: string | null;
  splits: { station: string; elapsed_h: number | null; source: "track" | "official" | "manual" }[];
  notes: string | null;
};

/**
 * The result of an archived race — null while the race has none, which is
 * every race that has not been run yet and every archived one whose activity
 * was never linked. Pass `null` for the slug to fetch nothing at all, which
 * is what a live race wants: the endpoint would 200 with `result: null`, but
 * asking is noise.
 *
 * Same failure semantics as the snapshot hooks above: an absent result is a
 * `null`, not an error, and a real failure keeps whatever was loaded.
 */
export function useRaceResult(slug: string | null) {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<RaceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!slug) return;
    let stale = false;
    fetch(`/api/races/${encodeURIComponent(slug)}/result?t=${Date.now()}`)
      .then(async (r) => {
        if (stale) return;
        if (r.status === 404) { setData(null); setError(null); return; }
        if (!r.ok) { setError(`result.json failed to load (HTTP ${r.status})`); return; }
        const d = await r.json().catch(() => { throw new Error("parse"); });
        if (stale) return;
        setData(((d as { result?: RaceResult | null }).result) ?? null);
        setError(null);
      })
      .catch(() => { if (!stale) setError("result.json corrupt or unreadable"); });
    return () => { stale = true; };
  }, [slug, refreshKey]);
  // With no slug there is nothing to report — including whatever the last
  // slug left behind, which belonged to a different race.
  return { result: slug ? data : null, error: slug ? error : null };
}

/* ------------------------------------------------------------------ */
/*  Live tracker polling — PRD v2 §4, bead tt-cv1b0.6                  */
/*                                                                    */
/*  GET /api/races/:slug/tracker asks the race's configured timing     */
/*  site where the runner was last seen. The SERVER holds a 60 s cache */
/*  (scripts/trackers/index.mjs) and nothing anywhere polls on a timer */
/*  unless a browser is asking — this hook is that browser, and these  */
/*  are its manners:                                                   */
/*                                                                    */
/*    · 60 s between polls, matching the server's TTL exactly. Asking  */
/*      faster only burns battery on a cached answer.                  */
/*    · PAUSED while the tab is hidden. A phone in a pocket for six    */
/*      hours must not keep a volunteer-run timing site company; the   */
/*      first thing it does on coming back is poll.                    */
/*    · exponential backoff on a 502 (or any other failure, or the     */
/*      network being gone): the tracker being down mid-race is        */
/*      ordinary, and hammering it does not bring it back.             */
/*    · STOPPED, permanently, on 404 (no tracker configured, or no     */
/*      adapter for the URL) and 501 (a recognised tracker that cannot */
/*      be read — MAProgress). Neither fixes itself while the page is  */
/*      open, so it says so in one line and stops asking.              */
/*                                                                    */
/*  It fetches nothing but this endpoint. Course files are loaded once */
/*  by useCourse and never re-read on a tracker tick.                  */
/* ------------------------------------------------------------------ */

/** Matches CACHE_TTL_MS in scripts/trackers/index.mjs. */
const TRACKER_POLL_MS = 60_000;

/** First retry after a failure; doubles per consecutive failure. */
const TRACKER_BACKOFF_MS = 60_000;

/** Ceiling on the backoff — beyond this the page has effectively given up,
    and a runner who reloads is the recovery path that actually works. */
const TRACKER_MAX_BACKOFF_MS = 8 * 60_000;

export type TrackerState = {
  /** the last checkpoint the tracker reported, or null when the runner is
      not on its page / has no checkpoint past the start */
  tracker: TrackerCheckpoint | null;
  /** ISO instant of the poll behind `tracker` */
  polledAt: string | null;
  /** one line for the race-day screen; null while everything is fine */
  notice: string | null;
  /** true once polling has stopped for good (404/501/409) */
  stopped: boolean;
};

const TRACKER_IDLE: TrackerState = { tracker: null, polledAt: null, notice: null, stopped: false };

/**
 * The notice for a poll that stops for good — a config problem no retry
 * fixes, so polling does not resume on its own (see `stopped` above).
 *
 * 409 is `code: "ambiguous"` (web/vite.config.ts's raceTrackerApi): a bib/name
 * ties across two or more entrants, which is the athlete's to resolve (set a
 * bib on the review screen), not a transient failure worth retrying.
 *
 * Pure and exported so the copy is unit-testable without mocking `fetch` —
 * see scripts/tracker-notice.test.mjs.
 */
export function stoppedTrackerNotice(status: 404 | 501 | 409, body: { error?: string } | null): string {
  if (status === 409) return "several runners match — set your bib on the review screen";
  if (body?.error) return `live tracking is off — ${body.error}`;
  return status === 501
    ? "this race's tracker can't be read automatically — use the manual checkpoint below"
    : "no live tracker is configured for this race";
}

/**
 * The notice for a SUCCESSFUL poll whose `tracker` came back null.
 *
 * `TrackerResponse.reason` is additive (scripts/trackers/index.mjs's
 * `pollTracker`): null whenever a checkpoint was found, "no_checkpoint" for
 * a matched runner who simply hasn't reached one yet — which needs no notice
 * of its own, since the race-day screen's own "Watching the race tracker…"
 * line (RaceDay.tsx, shown whenever there is no notice) already says exactly
 * that — and "runner_not_found" for a bib/name that matches nobody on the
 * tracker's page, which does.
 */
export function successTrackerNotice(reason: TrackerResponse["reason"]): string | null {
  return reason === "runner_not_found" ? "runner not found on the tracker — check bib/name" : null;
}

/**
 * Poll this race's live tracker while the page is open.
 *
 * @param slug the race to poll, or `null` to poll nothing at all — which is
 *   what a race with no `tracking.url` passes, the same way useRaceResult
 *   takes null for a race with no result worth asking about.
 */
export function useTracker(slug: string | null): TrackerState {
  // Keyed on the slug and re-read in the RENDER phase, the way usePosition
  // and useRacePlan's knobs are: an effect that reset the state instead
  // would flash the PREVIOUS race's checkpoint for one paint after a switch.
  const [state, setState] = useState<{ slug: string | null; v: TrackerState }>(() => ({ slug, v: TRACKER_IDLE }));
  if (state.slug !== slug) setState({ slug, v: TRACKER_IDLE });

  useEffect(() => {
    if (!slug) return;

    let stale = false;
    // `stopped` is local to this effect run, not React state: the scheduler
    // below reads it synchronously between a response and the next timer,
    // and a state update would not be visible in time.
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** Every write goes through here so a late response from a race that has
        since been switched away from can never land on the new one. */
    const put = (fn: (prev: TrackerState) => TrackerState) => {
      if (stale) return;
      setState((s) => (s.slug === slug ? { slug, v: fn(s.v) } : s));
    };

    const schedule = (ms: number) => {
      if (stale || stopped) return;
      timer = setTimeout(() => { timer = null; void poll(); }, ms);
    };

    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

    const poll = async () => {
      if (stale || stopped) return;
      // Hidden: drop the chain entirely rather than re-arming it. The
      // visibility listener below restarts it the moment the tab is looked
      // at, which is also when the answer starts mattering again.
      if (hidden()) return;
      try {
        const r = await fetch(`/api/races/${encodeURIComponent(slug)}/tracker?t=${Date.now()}`);
        if (stale) return;
        if (r.status === 404 || r.status === 501 || r.status === 409) {
          const body = await r.json().catch(() => null) as { error?: string } | null;
          stopped = true;
          put((v) => ({ ...v, stopped: true, notice: stoppedTrackerNotice(r.status as 404 | 501 | 409, body) }));
          return;
        }
        if (!r.ok) {
          failures += 1;
          put((v) => ({ ...v, notice: `tracker unreachable (HTTP ${r.status}) — retrying` }));
          schedule(backoff(failures));
          return;
        }
        const d = await r.json() as TrackerResponse;
        if (stale) return;
        failures = 0;
        put(() => ({
          tracker: d.tracker ?? null,
          polledAt: d.polled_at ?? null,
          notice: successTrackerNotice(d.reason),
          stopped: false,
        }));
        schedule(TRACKER_POLL_MS);
      } catch {
        if (stale) return;
        failures += 1;
        // The offline case lands here too. The last checkpoint STAYS on
        // screen — it was true when it was read, and a runner who has just
        // walked out of signal still wants to know where they were.
        put((v) => ({ ...v, notice: "tracker unreachable — retrying" }));
        schedule(backoff(failures));
      }
    };

    const onVisible = () => {
      if (stale || stopped || hidden() || timer !== null) return;
      void poll();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);

    void poll();
    return () => {
      stale = true;
      if (timer !== null) clearTimeout(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug]);

  // With no slug there is nothing to report, including whatever the previous
  // slug left behind — the same rule useRaceResult applies.
  return slug && state.slug === slug ? state.v : TRACKER_IDLE;
}

/** Doubling backoff, capped. `n` is the consecutive-failure count. */
function backoff(n: number): number {
  return Math.min(TRACKER_MAX_BACKOFF_MS, TRACKER_BACKOFF_MS * 2 ** Math.max(0, n - 1));
}
