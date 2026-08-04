import { useEffect, useState } from "react";
import { useRefresh } from "../data";
import type { ClimbsSnapshot, Course } from "./types";

/* Snapshot hooks for the Race views — same provider-less pattern as
   useGoogleCal (data.ts): fetch keyed on the refresh pulse, `missing`
   when the file hasn't been generated yet. */

export function useCourse() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<Course | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch(`/course.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { setData(d); setMissing(false); })
      .catch(() => setMissing(true));
  }, [refreshKey]);
  return { course: data, missing };
}

export function useClimbs() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<ClimbsSnapshot | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch(`/climbs.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { setData(d); setMissing(false); })
      .catch(() => setMissing(true));
  }, [refreshKey]);
  return { climbs: data, missing };
}
