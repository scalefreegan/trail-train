/* ------------------------------------------------------------------ */
/*  Race-day "WHERE AM I" free-text parser (RaceDay.tsx)                */
/*                                                                      */
/*  v2 review, ui1 #3: the free-mile box next to the "just left a       */
/*  station" <select> accepted a bare number ("50") and silently        */
/*  ignored every other phrasing a runner (or their crew, texting on    */
/*  their behalf) is likely to type — "mile 50", "50 mi", "80 km", a    */
/*  station's name. SET looked broken: no message, text left in the     */
/*  box, nothing on screen changed.                                     */
/*                                                                      */
/*  This is a pure, node-testable module (scripts/where-am-i.test.mjs)  */
/*  in the same style as raceDayHold.ts — RaceDay.tsx calls it only     */
/*  when resolveHold's own bare-number/select path already failed, so   */
/*  every existing commit path is untouched; this only widens what a   */
/*  typed miss can still turn into.                                     */
/* ------------------------------------------------------------------ */

export type DistSystem = "metric" | "imperial";

export type WhereAmIParse =
  | { kind: "mile"; mi: number } // internal miles, already unit-converted
  | { kind: "station"; name: string } // one exact station name, matched
  | { kind: "unparsable" };

const MI_PER_KM = 1 / 1.609344;

/**
 * Case/whitespace-insensitive match of free text against a list of station
 * names: exact first, then a prefix match — but only if exactly ONE station
 * starts with what was typed. Two stations sharing a prefix ("Cascade #1" /
 * "Cascade Overlook") is reported as unparsable rather than guessed at; a
 * wrong station silently applied is worse than an ignored one.
 */
export function matchStationName(text: string, stationNames: string[]): string | null {
  const q = text.trim().toLowerCase();
  if (!q) return null;
  const exact = stationNames.find((n) => n.toLowerCase() === q);
  if (exact) return exact;
  const prefixed = stationNames.filter((n) => n.toLowerCase().startsWith(q));
  return prefixed.length === 1 ? prefixed[0] : null;
}

/**
 * Parses the WHERE AM I free-text box into a mile (already converted to
 * internal miles) or a station name, or reports it as unparsable.
 *
 * Recognized forms, checked in order: "mile 50" / "mile 50.5" (explicit
 * miles, whatever unit the toggle is in); "50 mi" / "50mi" (explicit
 * miles); "80 km" / "80km" (explicit kilometers); a bare number ("50",
 * matching resolveHold's existing contract — read in the CURRENT display
 * unit); and finally a station name.
 *
 * Deliberately NOT parsed: a combined form like "mile 50 at 15:30" — the
 * "passed <station> at HH:MM" control next to this box already covers a
 * timed sighting, so a compound phrase here is reported unparsable rather
 * than half-read.
 *
 * @param stationNames every station on this race's aid chart, in whatever
 *   order the caller has them (only used for the name match)
 */
export function parseWhereAmI(
  raw: string,
  stationNames: string[],
  distSystem: DistSystem,
): WhereAmIParse {
  const text = raw.trim();
  if (text === "") return { kind: "unparsable" };

  const asMiles = (s: string): WhereAmIParse => {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? { kind: "mile", mi: n } : { kind: "unparsable" };
  };
  const asKm = (s: string): WhereAmIParse => {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? { kind: "mile", mi: n * MI_PER_KM } : { kind: "unparsable" };
  };

  let m = /^mile\s+([\d.]+)$/i.exec(text);
  if (m) return asMiles(m[1]);

  m = /^([\d.]+)\s*mi$/i.exec(text);
  if (m) return asMiles(m[1]);

  m = /^([\d.]+)\s*km$/i.exec(text);
  if (m) return asKm(m[1]);

  // A bare number reads in whatever unit the toggle is currently showing —
  // the same rule resolveHold already applies to the same box.
  m = /^([\d.]+)$/.exec(text);
  if (m) return distSystem === "metric" ? asKm(m[1]) : asMiles(m[1]);

  const station = matchStationName(text, stationNames);
  return station ? { kind: "station", name: station } : { kind: "unparsable" };
}
