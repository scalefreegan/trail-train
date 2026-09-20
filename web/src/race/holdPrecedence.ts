import type { CheckpointHold } from "./checkpointHold";

/* ------------------------------------------------------------------ */
/*  Manual-vs-tracker hold precedence (RaceDay.tsx) — pulled into its   */
/*  own pure module, node-testable (scripts/hold-precedence.test.mjs),  */
/*  the same reason raceDayHold.ts and whereAmI.ts are.                 */
/*                                                                      */
/*  v2 review ui3 #2: a manual SET was silently thrown away whenever the*/
/*  live tracker's LAST checkpoint named a station that isn't on this   */
/*  race's aid chart (a mislabeled mat, a renamed station). checkpoint- */
/*  Hold() correctly reports that as `{ mile: null, elapsed_h: <real>,  */
/*  ... }` — a real sighting, just with no course position attached —   */
/*  but the old comparison only looked at WHEN each hold was observed,  */
/*  so a chronologically-later off-chart tracker reading still "won"    */
/*  and the manual hold never rendered at all: no `held at …` line, no  */
/*  station change, `SET` looked broken.                                */
/*                                                                      */
/*  An off-chart reading carries no position, so it must never outrank */
/*  a manual hold on recency — it can only win when there's no manual   */
/*  hold to compare it against, exactly as if there were no tracker at  */
/*  all. It is still available as `liveHold` for RaceDay.tsx's own      */
/*  "seen at <station> … not on this race's aid chart" notice — this    */
/*  function only decides which hold sets the RUNNER'S POSITION.        */
/* ------------------------------------------------------------------ */

/**
 * Whichever hold actually places the runner: the manual entry if there is
 * one and either there's nothing live to compare it against, the live
 * reading has no course mile (off-chart — no position to compare), or the
 * manual observation is at least as recent. Otherwise the live hold.
 *
 * @param manualObsH the manual hold's own elapsed_h, or (for a bare-mile SET,
 *   which carries no clock of its own) the elapsed hour SET was pressed at
 * @param trackerObsH the live hold's own elapsed_h, or the poll's own elapsed
 *   hour when the checkpoint carried no clock either
 */
export function pickHold(
  manualHold: CheckpointHold | null,
  manualObsH: number | null,
  liveHold: CheckpointHold | null,
  trackerObsH: number | null,
): CheckpointHold | null {
  const manualWins = manualHold != null
    && (liveHold == null || liveHold.mile == null || (manualObsH ?? -Infinity) >= (trackerObsH ?? -Infinity));
  return manualWins ? manualHold : liveHold;
}
