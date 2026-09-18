import { useBlockConfig, useActiveRace } from "../data";
import { RacePlanContext, useRacePlanInstance } from "./useRacePlan";
import type { RaceView } from "../data";
import type { RaceConfig } from "./types";

/* The one shared race-plan instance for a subtree. Any view that renders
   more than one plan consumer (the race view: RacePlanner + ModelCheck)
   MUST wrap them in this — as independent hook copies they each own their
   settings state, and a goal typed into one keeps rendering stale in the
   other until remount. Component-only file so react-refresh stays happy. */
export function RacePlanProvider({ children }: { children: React.ReactNode }) {
  const { race, loading } = useBlockConfig();
  const { activeRace } = useActiveRace();
  const raceConfig = activeRace?.active ? activeRace.race ?? null : null;
  // The race gate lives HERE rather than in every consumer: below this line
  // the race is resolved, so the planner, the cards and the fuel plan can
  // read race.short and race.clock() without a null check apiece. The view
  // chips are already hidden in generic mode (App.tsx), so this only shows
  // during the first fetch or if someone deep-links the view.
  if (!race || !raceConfig) return <NoRace loading={loading} />;
  return <RacePlanScope race={race} raceConfig={raceConfig}>{children}</RacePlanScope>;
}

/* Split out because useRacePlanInstance is a hook: it cannot sit after the
   conditional return above. */
function RacePlanScope({ race, raceConfig, children }: {
  race: RaceView; raceConfig: RaceConfig; children: React.ReactNode;
}) {
  const plan = useRacePlanInstance(race, raceConfig);
  return <RacePlanContext.Provider value={plan}>{children}</RacePlanContext.Provider>;
}

function NoRace({ loading }: { loading: boolean }) {
  return (
    <section>
      <div className="panel" style={{ padding: "26px 24px" }}>
        <div className="eyebrow" style={{ marginBottom: 8 }}>{loading ? "loading" : "no race"}</div>
        <div style={{ fontSize: 13, color: "var(--mist-dim)", lineHeight: 1.6, maxWidth: 560 }}>
          {loading
            ? "Reading the active race…"
            : "No race is active, so there is nothing to project. Point config/active-race.json at a race folder to bring the planner, crew sheet and fuel plan back."}
        </div>
      </div>
    </section>
  );
}
