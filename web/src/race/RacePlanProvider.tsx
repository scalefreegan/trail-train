import { RacePlanContext, useRacePlanInstance } from "./useRacePlan";

/* The one shared race-plan instance for a subtree. Any view that renders
   more than one plan consumer (the race view: RacePlanner + ModelCheck)
   MUST wrap them in this — as independent hook copies they each own their
   settings state, and a goal typed into one keeps rendering stale in the
   other until remount. Component-only file so react-refresh stays happy. */
export function RacePlanProvider({ children }: { children: React.ReactNode }) {
  const plan = useRacePlanInstance();
  return <RacePlanContext.Provider value={plan}>{children}</RacePlanContext.Provider>;
}
