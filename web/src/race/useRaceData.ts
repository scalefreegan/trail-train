import { useEffect, useState } from "react";
import { useActiveRace, useRefresh } from "../data";
import { cacheGet, cachePut, slugKey } from "./offlineCache";
import type { ClimbsSnapshot, Course, CrewBase } from "./types";
import type { PaceGradeCurve } from "./pacing";

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
  const { viewing: slug, resolved } = useActiveRace();
  const [data, setData] = useState<Course | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!resolved) return;
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
      .catch(() => fallback("course.json corrupt or unreadable"));
    return () => { stale = true; };
  }, [refreshKey, resolved, slug]);
  return { course: data, missing, error };
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
      .catch(() => fallback("crew-base.json corrupt or unreadable"));
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
export function usePaceGrade() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<PaceGradeCurve>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    fetch(`/pace-grade.json?t=${Date.now()}`)
      .then(async (r) => {
        if (stale) return;
        if (r.status === 404) { setData(null); setError(null); return; }
        if (!r.ok) { setError(`pace-grade.json failed to load (HTTP ${r.status})`); return; }
        const d = await r.json().catch(() => { throw new Error("parse"); });
        const valid = d && Array.isArray(d.curve) && d.curve.length > 0 &&
          d.curve.every((p: { g: unknown; mult: unknown }) =>
            Number.isFinite(p.g) && Number.isFinite(p.mult) && (p.mult as number) > 0);
        if (!valid) { if (!stale) setError("pace-grade.json invalid — using previous curve or fallback"); return; }
        if (stale) return;
        setData(d); setError(null);
      })
      .catch(() => { if (!stale) setError("pace-grade.json corrupt or unreadable"); });
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
      `optional` in scripts/profile.mjs. */
  home_elevation_ft: number | null;
};

/** KEEP IN SYNC with PHYSIOLOGY_FIELDS in scripts/profile.mjs — the server
    normalizes to the same numbers, these cover the endpoint being absent. */
export const DEFAULT_PHYSIOLOGY: Physiology = { body_kg: 75, long_run_ref_mi: 20, home_elevation_ft: null };

const isPhysNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
/** Elevation is the one physiology number that may legitimately be 0 (or
    below it — the Dead Sea, Death Valley), so it can't use isPhysNumber. */
const isElevation = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -300 && v <= 15000;

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
    it. KEEP IN SYNC with scripts/race-result.mjs, which writes it. */
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
