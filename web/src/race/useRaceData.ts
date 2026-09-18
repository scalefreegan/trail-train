import { useEffect, useState } from "react";
import { useRefresh } from "../data";
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

export function useCourse() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<Course | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/course.json?t=${Date.now()}`)
      .then(async (r) => {
        if (r.status === 404) { setData(null); setMissing(true); setError(null); return; }
        if (!r.ok) { setMissing(false); setError(`course.json failed to load (HTTP ${r.status})`); return; }
        const d = await r.json().catch(() => { throw new Error("parse"); });
        setData(d); setMissing(false); setError(null);
      })
      .catch(() => { setMissing(false); setError("course.json corrupt or unreadable"); });
  }, [refreshKey]);
  return { course: data, missing, error };
}

/** Optional — crew-base.json exists wherever the race folder has a
    crew.private.json (tt-yib.9). Its `base` may still be null: emergency
    numbers and race-week lodging are independent. */
export function useCrewBase() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<CrewBase | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/crew-base.json?t=${Date.now()}`)
      .then(async (r) => {
        if (r.status === 404) { setData(null); setError(null); return; }
        if (!r.ok) { setError(`crew-base.json failed to load (HTTP ${r.status})`); return; }
        const d = await r.json().catch(() => { throw new Error("parse"); });
        setData(d); setError(null);
      })
      .catch(() => setError("crew-base.json corrupt or unreadable"));
  }, [refreshKey]);
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
};

/** KEEP IN SYNC with PHYSIOLOGY_FIELDS in scripts/profile.mjs — the server
    normalizes to the same numbers, these cover the endpoint being absent. */
export const DEFAULT_PHYSIOLOGY: Physiology = { body_kg: 75, long_run_ref_mi: 20 };

const isPhysNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

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
        setData({ body_kg: p.body_kg, long_run_ref_mi: p.long_run_ref_mi });
        setError(null);
      })
      .catch(() => {
        if (!stale) setError(`athlete profile unreadable — planning against ${DEFAULT_PHYSIOLOGY.body_kg} kg defaults`);
      });
    return () => { stale = true; };
  }, [refreshKey]);
  return { physiology: data, error };
}
