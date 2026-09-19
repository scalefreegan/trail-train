/* ------------------------------------------------------------------ */
/*  Race-day "WHERE AM I" — hold resolution, pulled out of RaceDay.tsx  */
/*  so it is a node-testable pure function (scripts/race-day-hold.test  */
/*  .mjs imports it directly, the way scripts/features.test.mjs imports */
/*  features.ts) instead of only reachable through a Playwright click.  */
/*                                                                      */
/*  Two independent drafts feed one commit, and SET used to fire        */
/*  whichever was staler: the station <select> applied on *change* (so  */
/*  picking a station moved the hold immediately), while SET submitted  */
/*  the free-mile text field — which reads back "" once the select has  */
/*  already committed, and Number("") is 0, not NaN, so SET silently    */
/*  re-committed the hold to mile 0 (bug D1/D2: "held at 0.0 km").      */
/*                                                                      */
/*  The fix makes SET the only thing that commits either draft: the     */
/*  select just remembers what was picked (and shows it, which it never */
/*  used to) until SET or AUTO clears it. An empty draft is not a mile  */
/*  of zero — it is nothing, so SET with nothing entered is a no-op.    */
/* ------------------------------------------------------------------ */

export type DistSystem = "metric" | "imperial";

/**
 * Resolves the position (in internal miles) that pressing SET should
 * commit, or `null` if there is nothing valid to commit (both drafts
 * empty, or the typed mile is not a usable non-negative number).
 *
 * The station draft wins when both are present — it is exact station
 * mileage, typed miles are an estimate — and a station pick is cleared
 * by AUTO or a successful commit, never silently overridden by a stray
 * character left in the mile field.
 *
 * @param stationDraft the "just left…" select's value: "" or a station's
 *   `total_mi` as a decimal string (miles, the internal unit)
 * @param miDraft the free-mile text field, in whatever unit `distSystem`
 *   names — "" means nothing typed
 * @param distSystem the runner's current unit toggle, so a typed 42 (km)
 *   converts to the same internal miles the station draft is already in
 */
export function resolveHold(
  stationDraft: string,
  miDraft: string,
  distSystem: DistSystem,
): number | null {
  if (stationDraft !== "") {
    const mi = Number(stationDraft);
    return Number.isFinite(mi) ? mi : null;
  }
  const trimmed = miDraft.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return distSystem === "metric" ? n / 1.609344 : n;
}
