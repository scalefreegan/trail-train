// Aid-station ↔ GPX-waypoint reconciliation. Pure functions, no I/O, no deps.
//
// Why this exists: organizer GPX files name their waypoints nothing like the
// runner manual's aid chart ("See Canyon" in the chart is "See Canyon Aid" in
// the GPX, "Pine Trailhead" is "Pine TH Water"). Today config/race-course.json
// carries a hand-authored `gpx_wpt` per station and build-course.mjs throws when
// one doesn't name a real waypoint — fine for one hand-tuned race, fatal for the
// modular-races intake, where the GPX arrives from a race site unseen.
//
// So: match by name first (exact, then normalized/token overlap), then fall back
// to the waypoint nearest the station's charted mile along the track. Every
// result carries a method and a 0..1 confidence, and NOTHING throws on a miss —
// a miss is `gpx_wpt: null` plus the candidates that were considered, so the
// caller (the intake validator, the review dialog) can show a mapping UI instead
// of failing the build. Distance matches are deliberately scored below
// LOW_CONFIDENCE: a mile-only match is a guess a human should confirm.
//
// Used by: scripts/build-course.mjs (snapping) and the race-intake build stage.

import { haversine } from "./climb-lib.mjs";

/**
 * Results at or above this confidence are trustworthy enough to build with;
 * below it, callers route the station to their `unresolved[]` list for review.
 */
export const LOW_CONFIDENCE = 0.6;

/** Minimum token-overlap score (0..1) before a fuzzy name match is preferred over distance. */
const FUZZY_MIN = 0.5;

/** Default ± window, in station miles, for the nearest-waypoint fallback. */
const DEFAULT_WINDOW_MI = 3;

/** How many scored candidates each result carries, so a mapping UI has options. */
const MAX_CANDIDATES = 3;

// Abbreviations seen in trail/GPX naming, expanded so "Cross Mtn TH" and
// "Cross Mountain Trailhead" normalize to the same tokens.
const SYNONYMS = new Map(Object.entries({
  mtn: "mountain",
  mtns: "mountain",
  mt: "mountain",
  cyn: "canyon",
  cnyn: "canyon",
  spr: "springs",
  sprs: "springs",
  spg: "springs",
  spgs: "springs",
  spring: "springs",
  th: "trailhead",
  trailhd: "trailhead",
  ck: "creek",
  crk: "creek",
  cr: "creek",
  rd: "road",
  jct: "junction",
  cg: "campground",
  lk: "lake",
  pk: "peak",
  riv: "river",
  rvr: "river",
  hwy: "highway",
  as: "aid",
}));

// Tokens that carry no identity — they mark what a point *is*, not which point
// it is. Dropped from both sides so "Horton" matches "Horton Aid" and
// "Black Mesa" matches "Black Mesa Crew Zone". Kept out of SYNONYMS so a
// station named only by its type still has at least its literal text to score.
const STOP_TOKENS = new Set([
  "aid", "station", "stn", "checkpoint", "cp", "crew", "zone", "only",
  "water", "drop", "bag", "the", "of", "at", "and", "a",
]);

/**
 * Normalize a place name to comparable tokens: lowercase, punctuation to spaces,
 * abbreviations expanded, type words ("Aid", "Crew Zone") dropped.
 * @param {string} name
 * @returns {string[]} tokens, order preserved, duplicates removed
 */
export function normalizeName(name) {
  const raw = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!raw) return [];
  const tokens = [];
  for (const word of raw.split(" ")) {
    const expanded = SYNONYMS.get(word) ?? word;
    if (STOP_TOKENS.has(expanded)) continue;
    if (!tokens.includes(expanded)) tokens.push(expanded);
  }
  // A name made entirely of type words ("Water", "Aid Station") would score 0
  // against everything; keep its literal tokens so it can still match itself.
  if (!tokens.length) return raw.split(" ").filter((w, i, all) => all.indexOf(w) === i);
  return tokens;
}

/**
 * Token-overlap score between two names, 0..1. Divides by the LONGER token set so
 * an extra word on either side costs something — "Pine" alone shouldn't score 1.0
 * against "Pine Canyon" when "Pine Canyon Aid" is also on the table.
 * @param {string} a
 * @param {string} b
 */
export function nameScore(a, b) {
  const ta = normalizeName(a);
  const tb = normalizeName(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  const hit = ta.filter((t) => setB.has(t)).length;
  return hit / Math.max(ta.length, tb.length);
}

/**
 * Parse a GPX document with regex/string scanning — no XML dependency, matching
 * how build-course.mjs already reads this same file (StravaGPX output is flat and
 * stable). Track points get cumulative haversine miles.
 * @param {string} xmlString
 * @returns {{waypoints: {name: string, lat: number, lon: number}[],
 *            track: {lat: number, lon: number, cum_mi: number}[]}}
 */
export function parseGpx(xmlString) {
  const xml = String(xmlString ?? "");

  const waypoints = [];
  const wptRe = /<wpt\s[^>]*?lat="([-\d.]+)"[^>]*?lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/wpt>/g;
  let m;
  while ((m = wptRe.exec(xml)) !== null) {
    const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(m[3]);
    waypoints.push({
      name: nameMatch ? nameMatch[1].trim() : "",
      lat: parseFloat(m[1]),
      lon: parseFloat(m[2]),
    });
  }

  const track = [];
  let cum = 0;
  // Self-closing <trkpt .../> is legal GPX, so don't require a closing tag.
  const trkRe = /<trkpt\s[^>]*?lat="([-\d.]+)"[^>]*?lon="([-\d.]+)"[^>]*?(?:\/>|>)/g;
  while ((m = trkRe.exec(xml)) !== null) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (track.length) {
      const prev = track[track.length - 1];
      cum += haversine(prev.lat, prev.lon, lat, lon);
    }
    track.push({ lat, lon, cum_mi: cum });
  }

  return { waypoints, track };
}

/**
 * Cumulative mile of the track point nearest each waypoint (null with no track).
 * Used to break name-score ties and to drive the distance fallback.
 */
function waypointMiles(waypoints, track) {
  return waypoints.map((w) => {
    if (!track.length || !Number.isFinite(w.lat) || !Number.isFinite(w.lon)) return null;
    let best = null;
    for (const p of track) {
      const d = haversine(w.lat, w.lon, p.lat, p.lon);
      if (best === null || d < best.d) best = { d, mi: p.cum_mi };
    }
    return best.mi;
  });
}

/** Top-N {wpt, score} pairs, highest first, ties broken by waypoint order. */
function topCandidates(waypoints, scores) {
  return waypoints
    .map((w, i) => ({ wpt: w.name, score: +scores[i].toFixed(4), i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_CANDIDATES)
    .map(({ wpt, score }) => ({ wpt, score }));
}

/**
 * Match each aid station to a GPX waypoint. Pure: no I/O, inputs untouched.
 *
 * Strategy per station, first hit wins:
 *   1. exact    — the station's existing `gpx_wpt`, or its name, equals a waypoint
 *                 name verbatim. confidence 1.
 *   2. fuzzy    — best normalized token-overlap score ≥ 0.5 (case, punctuation and
 *                 abbreviations folded; "Aid"/"Crew Zone"/"TH" handled). confidence
 *                 0.95 × score, so even a perfect fuzzy match stays under an exact one.
 *                 Equal scores are broken by proximity to the station's charted mile.
 *   3. distance — nearest waypoint whose track mile is within ±`windowMi` of the
 *                 station's mile. confidence 0.5 × (1 − off/window), which is always
 *                 below LOW_CONFIDENCE on purpose: a mile-only match is a guess.
 *   4. miss     — `gpx_wpt: null`, `method: null`, confidence 0. Never throws.
 *
 * @param {{name: string, total_mi: number, gpx_wpt?: string|null}[]} stations
 * @param {{waypoints: {name: string, lat: number, lon: number}[],
 *          track: {lat: number, lon: number, cum_mi: number}[]}} gpx
 * @param {{windowMi?: number, scale?: number}} [opts]
 *   windowMi: ± window for the distance fallback, in station miles (default 3).
 *   scale: measured track miles per charted station mile (default 1). GPX tracks
 *   routinely run 1–3% long or short against a race's official mileage;
 *   build-course.mjs already computes this ratio and can pass it.
 * @returns {{name: string, gpx_wpt: string|null,
 *            method: "exact"|"fuzzy"|"distance"|null, confidence: number,
 *            candidates: {wpt: string, score: number}[]}[]}
 */
export function matchAidStations(stations, gpx, opts = {}) {
  const windowMi = opts.windowMi ?? DEFAULT_WINDOW_MI;
  const scale = opts.scale ?? 1;
  const waypoints = gpx?.waypoints ?? [];
  const track = gpx?.track ?? [];
  const wptMi = waypointMiles(waypoints, track);
  const byName = new Map(waypoints.map((w) => [w.name, w]));

  return (stations ?? []).map((station) => {
    const nameScores = waypoints.map((w) => nameScore(station.name, w.name));
    const candidates = topCandidates(waypoints, nameScores);
    const expectedMi = Number.isFinite(station.total_mi) ? station.total_mi * scale : null;
    const result = { name: station.name, gpx_wpt: null, method: null, confidence: 0, candidates };

    // 1. Exact. An authored `gpx_wpt` wins when it names a real waypoint; when it
    //    doesn't (a typo, or a GPX that changed under us) we fall through to the
    //    matcher rather than throwing the way build-course.mjs used to.
    for (const literal of [station.gpx_wpt, station.name]) {
      if (literal && byName.has(literal)) {
        return { ...result, gpx_wpt: literal, method: "exact", confidence: 1 };
      }
    }

    // 2. Fuzzy. Ties go to the waypoint sitting closest to the charted mile —
    //    without that, two "Pine …" waypoints would be decided by file order.
    let bestI = -1;
    for (let i = 0; i < waypoints.length; i++) {
      if (nameScores[i] < FUZZY_MIN) continue;
      if (bestI < 0 || nameScores[i] > nameScores[bestI]) {
        bestI = i;
        continue;
      }
      if (nameScores[i] === nameScores[bestI] && expectedMi !== null &&
          wptMi[i] !== null && wptMi[bestI] !== null &&
          Math.abs(wptMi[i] - expectedMi) < Math.abs(wptMi[bestI] - expectedMi)) {
        bestI = i;
      }
    }
    if (bestI >= 0) {
      return {
        ...result,
        gpx_wpt: waypoints[bestI].name,
        method: "fuzzy",
        confidence: +(0.95 * nameScores[bestI]).toFixed(3),
      };
    }

    // 3. Distance: nearest waypoint by track mile, inside the window.
    if (expectedMi !== null) {
      let nearest = null;
      for (let i = 0; i < waypoints.length; i++) {
        if (wptMi[i] === null) continue;
        const off = Math.abs(wptMi[i] - expectedMi);
        if (off > windowMi) continue;
        if (!nearest || off < nearest.off) nearest = { i, off };
      }
      if (nearest) {
        return {
          ...result,
          gpx_wpt: waypoints[nearest.i].name,
          method: "distance",
          confidence: +(0.5 * (1 - nearest.off / windowMi)).toFixed(3),
          candidates: [
            { wpt: waypoints[nearest.i].name, score: +(1 - nearest.off / windowMi).toFixed(4) },
            ...candidates.filter((c) => c.wpt !== waypoints[nearest.i].name),
          ].slice(0, MAX_CANDIDATES),
        };
      }
    }

    // 4. Miss. Candidates still ride along so a human can pick.
    return result;
  });
}
