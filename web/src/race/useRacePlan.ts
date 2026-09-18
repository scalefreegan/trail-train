import { createContext, useContext, useMemo, useState } from "react";
import { useStrava, useBlockConfig, useActiveRace } from "../data";
import { useCourse, usePaceGrade } from "./useRaceData";
import { planFuel, useNutrition, type FuelPlan, type NutritionConfig } from "./nutrition";
import { fitPacing, projectRace, type PacingFit, type PaceGradeCurve } from "./pacing";
import {
  resolveFeatures, visibleColumns, visiblePanels,
  type ResolvedFeatures, type VisibleColumns, type VisiblePanels,
} from "./features";
import type { Course, RaceConfig } from "./types";

/* ------------------------------------------------------------------ */
/*  Shared race-plan wiring.                                          */
/*                                                                    */
/*  The projection + fuel plan are consumed by more than one view (the */
/*  planner table and the nutrition page), and both must agree to the  */
/*  minute — a leg table that disagrees with the caffeine schedule is  */
/*  worse than either alone. So the projectRace call, the planFuel     */
/*  call and the settings that feed them are DEFINED here once, rather */
/*  than copied into each view where they would drift a knob at a time.*/
/*                                                                    */
/*  Sharing is via CONTEXT: the race view renders a RacePlanProvider   */
/*  and every consumer reads the same instance through useRacePlan().  */
/*  This became load-bearing the moment two consumers (RacePlanner and */
/*  ModelCheck) mounted at the same time — as independent hook copies, */
/*  a goal typed into the planner updated its own state + localStorage */
/*  while the other copy kept rendering the stale value until remount, */
/*  a live contradiction on one screen. useRacePlan() falls back to a  */
/*  private instance when no provider is above it, so a solo consumer  */
/*  (the fuel view) still works unwrapped.                             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Persisted knobs.                                                   */
/*                                                                     */
/*  A NULL key means "which race is this?" has not been answered yet   */
/*  (/api/race/active is still in flight). The hooks then render the   */
/*  default and persist nothing: a goal written into the wrong race's  */
/*  namespace is worse than a goal not written at all, and the window  */
/*  is one fetch long — the planner has no course to draw yet either.  */
/*                                                                     */
/*  Both the key and the default therefore arrive LATE, so both hooks  */
/*  re-read storage when either changes. That is the render-phase      */
/*  "adjust state when the inputs change" pattern: it lands in the     */
/*  same paint, where an effect would flash the pre-resolution value.  */
/* ------------------------------------------------------------------ */

export function usePersistedNumber(key: string | null, initial: number) {
  const read = (): number => {
    if (key == null || typeof localStorage === "undefined") return initial;
    const raw = localStorage.getItem(key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : initial;
  };
  const [state, setState] = useState(() => ({ key, initial, v: read() }));
  if (state.key !== key || state.initial !== initial) setState({ key, initial, v: read() });
  const set = (n: number) => {
    setState({ key, initial, v: n });
    if (key == null) return;
    try { localStorage.setItem(key, String(n)); } catch { /* private mode */ }
  };
  return [state.v, set] as const;
}

export function usePersistedStops(key: string | null) {
  const read = (): Record<string, number> => {
    if (key == null || typeof localStorage === "undefined") return {};
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
  };
  const [state, setState] = useState(() => ({ key, v: read() }));
  if (state.key !== key) setState({ key, v: read() });
  const set = (name: string, min: number | null) => {
    setState((prev) => {
      const next = { ...prev.v };
      if (min == null || !Number.isFinite(min)) delete next[name];
      else next[name] = Math.max(0, min);
      if (key != null) {
        try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode */ }
      }
      return { key, v: next };
    });
  };
  const clear = () => {
    setState({ key, v: {} });
    if (key == null) return;
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  };
  return [state.v, set, clear] as const;
}

/** The knobs that belong to a race rather than to the athlete. */
const RACE_KNOBS = [
  "goal_h", "fatigue_pct_v2", "calibration_pct", "restraint_pct",
  "aid_stop_min", "crew_stop_min", "stop_overrides",
] as const;

/**
 * Where the un-namespaced keys land when nothing is active: MM100 is the only
 * race that existed before race folders did, so anything stored under the bare
 * `race.*` keys was set while planning it.
 */
const LEGACY_KNOB_SLUG = "mogollon-monster-100-2026";

const migratedSlugs = new Set<string>();

/**
 * One-time move of `race.<knob>` → `race.<slug>.<knob>`, then delete the old
 * key. Runs once per slug per page load (the Set), and is a no-op on the
 * second visit because the legacy keys are gone.
 *
 * An existing namespaced value always wins: it was written by this race's
 * sliders, whereas the bare key may be a leftover from a different one.
 */
function migrateLegacyKnobs(slug: string) {
  if (migratedSlugs.has(slug)) return;
  migratedSlugs.add(slug);
  if (typeof localStorage === "undefined") return;
  try {
    for (const knob of RACE_KNOBS) {
      const legacy = localStorage.getItem(`race.${knob}`);
      if (legacy == null) continue;
      const key = `race.${slug}.${knob}`;
      if (localStorage.getItem(key) == null) localStorage.setItem(key, legacy);
      localStorage.removeItem(`race.${knob}`);
    }
  } catch { /* private mode */ }
}

export type RacePlan = {
  course: Course | null;
  /** 404 on course.json — the file has not been generated yet */
  missing: boolean;
  /** course.json load failure — the one that blocks rendering entirely */
  error: string | null;
  /** the personal pace-vs-grade curve, for provenance display */
  paceGrade: PaceGradeCurve;
  /** kept separate from `error`: these degrade the plan, they don't block it,
      and the planner footer reports them individually */
  paceGradeError: string | null;
  nutritionError: string | null;
  fit: PacingFit | null;
  proj: ReturnType<typeof projectRace> | null;
  nutrition: NutritionConfig;
  fuelPlan: FuelPlan | null;
  /** the active race folder's race.json — null in generic mode, and on
      every render before /api/race/active answers */
  raceConfig: RaceConfig | null;
  /** what this race even has. Resolved HERE, once, rather than in each
      component: the race view mounts four consumers of it, and four
      useActiveRace() calls would be four fetches of the same file that
      could disagree with each other mid-flight. */
  features: ResolvedFeatures;
  panels: VisiblePanels;
  columns: VisibleColumns;
  /** the race START instant (date + start_time resolved in the race's zone) */
  raceStart: Date;
  /** the race's IANA zone — every wall clock on the page reads in it */
  timeZone: string;
  /** an elapsed race hour on the race's wall clock ("6:00a", "2:14p+1") */
  clock: (elapsedH: number) => string;
  settings: {
    fatigue: number; calibration: number; restraint: number; goalH: number;
    aidStopMin: number; crewStopMin: number; stopOverrides: Record<string, number>;
  };
  set: {
    fatigue: (n: number) => void; calibration: (n: number) => void;
    restraint: (n: number) => void; goalH: (n: number) => void;
    aidStopMin: (n: number) => void; crewStopMin: (n: number) => void;
    stopOverride: (name: string, min: number | null) => void;
    clearStopOverrides: () => void;
  };
};

/** Context carrying the subtree's ONE shared plan instance. Exported for
    RacePlanProvider (its own .tsx file — this file stays JSX-free so hooks
    and the provider component don't share a module, per house react-refresh
    convention). */
export const RacePlanContext = createContext<RacePlan | null>(null);

/** Read the subtree's shared plan. Requires a RacePlanProvider above —
    there is deliberately NO private-instance fallback: a fallback is a
    second copy of the settings state, and a second copy is exactly the
    divergence bug this context exists to prevent (two views of the same
    plan disagreeing on one screen). It also made every consumer pay for
    its own fetches and projection memos even when the shared value won.
    Failing loudly in dev beats degrading quietly in prod. */
export function useRacePlan(): RacePlan {
  const shared = useContext(RacePlanContext);
  if (shared == null) {
    throw new Error("useRacePlan requires a <RacePlanProvider> above it — wrap the view in one (see App.tsx's race view)");
  }
  return shared;
}

export function useRacePlanInstance(): RacePlan {
  const { race } = useBlockConfig();
  const { activeRace, slug: activeSlug, resolved: raceResolved } = useActiveRace();
  const { activities } = useStrava();
  const { course, missing, error: courseError } = useCourse();
  const { paceGrade, error: paceGradeError } = usePaceGrade();
  const { nutrition, error: nutritionError } = useNutrition();

  const raceConfig = activeRace?.race ?? null;

  // Knobs are namespaced by race: a goal set for a 38 h hundred means nothing
  // on a 50k, and switching the active race used to inherit the last race's
  // sliders silently. null until the pointer resolves — see usePersistedNumber.
  const knobSlug = raceResolved ? (activeSlug ?? LEGACY_KNOB_SLUG) : null;
  if (knobSlug) migrateLegacyKnobs(knobSlug);
  const knob = (name: string) => (knobSlug ? `race.${knobSlug}.${name}` : null);

  // 85 % of the cutoff, to the nearest half hour: a goal that is ambitious but
  // inside the cutoff, for THIS race — the old constant 32 was MM100's answer
  // and would be an impossible target on a race with a 24 h limit.
  const cutoffH = raceConfig?.cutoff_h ?? race.cutoff_h;
  const goalDefaultH = cutoffH != null && cutoffH > 0 ? Math.round(cutoffH * 0.85 * 2) / 2 : 32;

  const [fatigue, setFatigue] = usePersistedNumber(knob("fatigue_pct_v2"), 5);
  // training runs are stronger efforts than race-sustainable pace — slow every
  // projected pace by this much (athlete-requested honesty correction)
  const [calibration, setCalibration] = usePersistedNumber(knob("calibration_pct"), 6);
  // deliberate hold-back through mile 50 (taper to 60); restrained miles also
  // age the fatigue clock less — bank energy for the second 50
  const [restraint, setRestraint] = usePersistedNumber(knob("restraint_pct"), 8);
  const [goalH, setGoalH] = usePersistedNumber(knob("goal_h"), goalDefaultH);
  const [aidStopMin, setAidStopMin] = usePersistedNumber(knob("aid_stop_min"), 5);
  const [crewStopMin, setCrewStopMin] = usePersistedNumber(knob("crew_stop_min"), 10);
  const [stopOverrides, setStopOverride, clearStopOverrides] = usePersistedStops(knob("stop_overrides"));

  const features = useMemo(() => resolveFeatures(raceConfig), [raceConfig]);
  const panels = useMemo(() => visiblePanels(raceConfig), [raceConfig]);
  const columns = useMemo(() => visibleColumns(raceConfig), [raceConfig]);

  const fit = useMemo(() => fitPacing(activities), [activities]);

  const proj = useMemo(
    () => (course && fit ? projectRace(course, fit, {
      // a cleared/zeroed goal field (Number("")=0) means "no goal" — coerce to
      // null so the header ("—") and the table agree instead of collapsing ETAs
      fatiguePctPer10mi: fatigue, calibrationPct: calibration, restraintPct: restraint,
      gradeCurve: paceGrade,
      goalH: goalH > 0 ? goalH : null, aidStopMin, crewStopMin, stopOverridesMin: stopOverrides,
    }) : null),
    [course, fit, paceGrade, fatigue, calibration, restraint, goalH, aidStopMin, crewStopMin, stopOverrides],
  );

  const fuelPlan = useMemo(
    () => (course && proj ? planFuel(proj, course, race.date, nutrition, race.timeZone) : null),
    [course, proj, race.date, race.timeZone, nutrition],
  );

  return {
    course, missing, error: courseError,
    paceGrade, paceGradeError, nutritionError,
    fit, proj, nutrition, fuelPlan,
    raceStart: race.date, timeZone: race.timeZone, clock: race.clock,
    raceConfig, features, panels, columns,
    settings: { fatigue, calibration, restraint, goalH, aidStopMin, crewStopMin, stopOverrides },
    set: {
      fatigue: setFatigue, calibration: setCalibration, restraint: setRestraint,
      goalH: setGoalH, aidStopMin: setAidStopMin, crewStopMin: setCrewStopMin,
      stopOverride: setStopOverride, clearStopOverrides,
    },
  };
}
