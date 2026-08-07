import { useEffect, useState } from "react";
import { useRefresh } from "../data";
import type { ClimbsSnapshot, Course, CrewBase } from "./types";

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

/** Optional — crew-base.json only exists where profile.json has race_base. */
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
