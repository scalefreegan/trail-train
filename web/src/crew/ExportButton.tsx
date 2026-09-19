import { useState } from "react";
import { useRacePlan } from "../race/useRacePlan";
import type { CrewKnobs } from "./crewData";

/* ------------------------------------------------------------------ */
/*  "export crew page" — the planner's one-press crew export (§5).     */
/*                                                                     */
/*  POSTs the knobs currently on screen, gets the finished HTML back,  */
/*  and hands it to the browser as a download. The file is ALSO written */
/*  into races/<slug>/build/ by the server, so the athlete can find it  */
/*  again without re-exporting; the download is the copy they AirDrop.  */
/*                                                                     */
/*  Sending the live knobs rather than letting the server pick its own  */
/*  defaults is the whole point: a crew sheet whose ETAs disagree with  */
/*  the planner the athlete was just looking at is worse than no crew   */
/*  sheet, because both look authoritative.                            */
/* ------------------------------------------------------------------ */

type State = { phase: "idle" | "working" } | { phase: "error"; message: string };

export function CrewExportButton() {
  const { raceConfig, settings } = useRacePlan();
  const [state, setState] = useState<State>({ phase: "idle" });

  const run = async () => {
    setState({ phase: "working" });
    const knobs: CrewKnobs = {
      fatiguePctPer10mi: settings.fatigue,
      calibrationPct: settings.calibration,
      restraintPct: settings.restraint,
      goalH: settings.goalH > 0 ? settings.goalH : null,
      aidStopMin: settings.aidStopMin,
      crewStopMin: settings.crewStopMin,
      stopOverridesMin: settings.stopOverrides,
    };
    try {
      const r = await fetch(`/api/races/${encodeURIComponent(raceConfig.slug)}/crew-export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(knobs),
      });
      if (!r.ok) {
        // The endpoint answers errors as JSON and successes as HTML, so a
        // failed parse here is itself the message rather than a second error.
        const detail = await r.json().catch(() => null);
        throw new Error((detail as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.headers.get("X-Crew-Export-Path")?.split("/").pop() ?? "crew.html";
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick: revoking synchronously can beat the click
      // through in Safari and hand the user a failed download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState({ phase: "idle" });
    } catch (e) {
      setState({ phase: "error", message: (e as Error).message || "export failed" });
    }
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <button
        className="chip"
        style={{ borderColor: "var(--lamp)", color: "var(--lamp)", whiteSpace: "nowrap" }}
        onClick={run}
        disabled={state.phase === "working"}
      >
        {state.phase === "working" ? "exporting…" : "⇩ export crew page"}
      </button>
      {state.phase === "error" && (
        <span className="eyebrow" style={{ fontSize: 8, color: "var(--ember, #c0512a)" }}>
          {state.message}
        </span>
      )}
    </span>
  );
}
