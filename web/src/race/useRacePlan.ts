import { createContext, useContext, useMemo, useState } from "react";
import { useStrava, useBlockConfig } from "../data";
import { useCourse, usePaceGrade } from "./useRaceData";
import { planFuel, useNutrition, type FuelPlan, type NutritionConfig } from "./nutrition";
import { fitPacing, projectRace, type PacingFit, type PaceGradeCurve } from "./pacing";
import type { Course } from "./types";

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

export function usePersistedNumber(key: string, initial: number) {
  const [v, setV] = useState<number>(() => {
    if (typeof localStorage === "undefined") return initial;
    const raw = localStorage.getItem(key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : initial;
  });
  const set = (n: number) => {
    setV(n);
    try { localStorage.setItem(key, String(n)); } catch { /* private mode */ }
  };
  return [v, set] as const;
}

export function usePersistedStops(key: string) {
  const [v, setV] = useState<Record<string, number>>(() => {
    if (typeof localStorage === "undefined") return {};
    try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; }
  });
  const set = (name: string, min: number | null) => {
    setV((prev) => {
      const next = { ...prev };
      if (min == null || !Number.isFinite(min)) delete next[name];
      else next[name] = Math.max(0, min);
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  };
  const clear = () => {
    setV({});
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  };
  return [v, set, clear] as const;
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
  /** local race START instant (date + start_time), from block config */
  raceStart: Date;
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

/** Read the shared plan when a provider is present; otherwise build a
    private instance (fine for a view with exactly one consumer). The
    instance hook still runs unconditionally — rules of hooks — but its
    memos are cheap and the shared value wins. */
export function useRacePlan(): RacePlan {
  const shared = useContext(RacePlanContext);
  const fallback = useRacePlanInstance();
  return shared ?? fallback;
}

export function useRacePlanInstance(): RacePlan {
  const { race } = useBlockConfig();
  const { activities } = useStrava();
  const { course, missing, error: courseError } = useCourse();
  const { paceGrade, error: paceGradeError } = usePaceGrade();
  const { nutrition, error: nutritionError } = useNutrition();

  const [fatigue, setFatigue] = usePersistedNumber("race.fatigue_pct_v2", 5);
  // training runs are stronger efforts than race-sustainable pace — slow every
  // projected pace by this much (athlete-requested honesty correction)
  const [calibration, setCalibration] = usePersistedNumber("race.calibration_pct", 6);
  // deliberate hold-back through mile 50 (taper to 60); restrained miles also
  // age the fatigue clock less — bank energy for the second 50
  const [restraint, setRestraint] = usePersistedNumber("race.restraint_pct", 8);
  const [goalH, setGoalH] = usePersistedNumber("race.goal_h", 32);
  const [aidStopMin, setAidStopMin] = usePersistedNumber("race.aid_stop_min", 5);
  const [crewStopMin, setCrewStopMin] = usePersistedNumber("race.crew_stop_min", 10);
  const [stopOverrides, setStopOverride, clearStopOverrides] = usePersistedStops("race.stop_overrides");

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
    () => (course && proj ? planFuel(proj, course, race.date, nutrition) : null),
    [course, proj, race.date, nutrition],
  );

  return {
    course, missing, error: courseError,
    paceGrade, paceGradeError, nutritionError,
    fit, proj, nutrition, fuelPlan, raceStart: race.date,
    settings: { fatigue, calibration, restraint, goalH, aidStopMin, crewStopMin, stopOverrides },
    set: {
      fatigue: setFatigue, calibration: setCalibration, restraint: setRestraint,
      goalH: setGoalH, aidStopMin: setAidStopMin, crewStopMin: setCrewStopMin,
      stopOverride: setStopOverride, clearStopOverrides,
    },
  };
}
