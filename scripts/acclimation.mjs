// When did the athlete get to altitude? — PRD-v2 §2.
//
// scripts/altitude.mjs turns (elevation, home elevation, DAYS AT ALTITUDE)
// into a pace penalty. This module answers the third argument, and it is the
// one input nobody wants to type in twice: the trip is already on the
// calendar, classified as "travel" by scripts/sync-google-cal.mjs. So the
// derivation reads it from there and REPORTS WHERE IT CAME FROM, because the
// difference between "your calendar says you fly in on the 10th" and "we
// assumed you fly in the night before" is four days of acclimation and,
// on a high course, most of an hour of projected finish time.
//
// Three sources, in precedence order:
//   override  the athlete typed a number on the planner. Always wins — they
//             know about the week in Silverton that never made the calendar.
//   calendar  the LAST travel event starting on or before race day whose
//             text shares a distinctive word with the race's location or
//             name. "Last" because a season with two Colorado trips should
//             credit the one you are actually racing off, not the first.
//   default   nothing matched. Arrival is the day before the race — ONE day,
//             the fly-in-the-night-before case. Not zero: zero would be the
//             pessimistic extreme and would read as a measurement rather
//             than the assumption it is. Not more: crediting acclimation
//             nobody has evidence for is how a projection quietly gets fast.
//
// Pure and dependency-free: no clock, no fs, no network. `today` is passed
// in. Dates are plain YYYY-MM-DD strings compared as calendar days — the
// race's own zone is not consulted, because a day count does not need one
// and pretending otherwise would import scripts/clock.mjs for nothing.

/** The calendar classification the derivation reads. Set by
    scripts/sync-google-cal.mjs's classify(); a personal keyword rule in
    config/profile.json ("calendar_keywords": {"travel": ["silverton"]}) can
    make any event travel, which is the supported way to teach it about a
    trip whose title says nothing about flying. */
export const TRAVEL_CLASSIFICATION = "travel";

/** Tokens shorter than this are dropped before matching. Four, not three:
    "san" would match a San Diego work trip against the San Juan Softie, and
    a wrong arrival date is worse than no arrival date because it arrives
    wearing a source label. Four keeps "juan", "moab", "leadville". */
const MIN_TOKEN_LEN = 4;

/** Words that appear in so many race names, place names and trip titles that
    matching on them means nothing. Kept deliberately short: every entry here
    is a word the athlete CANNOT use to make a match happen, so the list
    earns its place by being obvious rather than by being thorough. */
const STOPWORDS = new Set([
  // race-name furniture
  "race", "trail", "trails", "run", "runs", "running", "ultra", "ultras",
  "mile", "miles", "miler", "endurance", "marathon", "half", "classic",
  "challenge", "championship", "championships", "series", "event",
  // travel furniture
  "trip", "travel", "flight", "flights", "airport", "hotel", "lodge",
  "lodging", "drive", "depart", "departure", "arrive", "arrival", "return",
  "airbnb", "rental", "cabin",
  // geography furniture
  "national", "state", "park", "forest", "county", "city", "town", "mount",
  "mountain", "mountains", "valley", "river", "creek", "lake", "canyon",
  "north", "south", "east", "west", "upper", "lower", "united", "states",
  // glue
  "with", "from", "into", "over", "week", "weekend", "days", "this", "that",
]);

/**
 * The distinctive words of a string: lowercase, punctuation-split, short and
 * generic words dropped, anything containing a digit dropped ("100", "50k",
 * "2027" — a year or a distance matches everything and means nothing).
 *
 * @param {unknown} s
 * @returns {Set<string>}
 */
export function distinctiveWords(s) {
  if (typeof s !== "string") return new Set();
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .map((w) => w.replace(/'/g, ""))
      .filter((w) => w.length >= MIN_TOKEN_LEN && !/\d/.test(w) && !STOPWORDS.has(w)),
  );
}

/** YYYY-MM-DD out of a date-only string or an ISO timestamp. Google's
    dateTime carries the event's own UTC offset, so its first ten characters
    already ARE the local calendar day — no parsing required, and none done,
    so a timezone this process knows nothing about cannot shift a day. */
const dayOf = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** Whole days from `a` to `b`, both YYYY-MM-DD. UTC midnights on purpose:
    the difference of two calendar days must not depend on whether a DST
    boundary sits between them. */
export function daysBetween(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86_400_000);
}

/** `date` shifted by `delta` whole days, as YYYY-MM-DD. */
function addDays(date, delta) {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t + delta * 86_400_000).toISOString().slice(0, 10);
}

/**
 * @typedef {object} Acclimation
 * @property {string|null} arrival_date  YYYY-MM-DD, or null when the race has
 *   no usable date and nothing can be derived at all
 * @property {number} days_at_altitude   whole days between arrival and race
 *   day, ≥ 0. 0 means "lands on race morning".
 * @property {"calendar"|"default"|"override"} source
 * @property {{summary: string, start: string, end: string|null, location: string|null}} [matched_event]
 *   present only for source "calendar" — the event the date came from, so the
 *   planner can name it instead of asking the athlete to trust a number
 */

/**
 * Derive when the athlete arrives at the race's elevation.
 *
 * @param {object} o
 * @param {{date?: string, name?: string, short?: string, location?: string}} o.race
 *   the race folder's race.json (only date/name/short/location are read)
 * @param {{events?: object[]}|object[]|null} [o.calendar]
 *   web/public/google-cal.json, its `events` array, or null
 * @param {string|Date|number} [o.today] "now", for deciding whether a trip
 *   already over can still be the arrival. Defaults to the real clock.
 * @param {number|null} [o.overrideDays] the planner's manual override, days
 * @returns {Acclimation}
 */
export function deriveArrival({ race, calendar, today, overrideDays = null } = {}) {
  const raceDay = dayOf(race?.date);

  // An override is the athlete's own statement and does not need a race date
  // to be meaningful — but without one there is no day to count back from,
  // so the date it implies stays null rather than being invented.
  if (Number.isFinite(overrideDays) && overrideDays >= 0) {
    const days = Math.floor(overrideDays);
    return {
      arrival_date: raceDay ? addDays(raceDay, -days) : null,
      days_at_altitude: days,
      source: "override",
    };
  }

  // No race date: nothing to count to. Report the honest zero rather than
  // the one-day default, whose whole justification is "the night before a
  // race that has a date".
  if (!raceDay) return { arrival_date: null, days_at_altitude: 0, source: "default" };

  const todayDay =
    dayOf(typeof today === "string" ? today : new Date(today ?? Date.now()).toISOString()) ??
    new Date().toISOString().slice(0, 10);

  const events = Array.isArray(calendar) ? calendar : Array.isArray(calendar?.events) ? calendar.events : [];
  const needles = new Set([
    ...distinctiveWords(race?.location),
    ...distinctiveWords(race?.name),
    ...distinctiveWords(race?.short),
  ]);

  let best = null;
  if (needles.size) {
    for (const e of events) {
      if (e?.classification !== TRAVEL_CLASSIFICATION) continue;
      const start = dayOf(e.start);
      if (!start || start > raceDay) continue;
      // A trip that finished before today cannot be how the athlete gets to a
      // race that has not happened yet — last spring's Colorado week is not
      // this August's arrival. (Google's all-day `end` is exclusive, so the
      // event covers days [start, end); a bare start is a single day.)
      const endExclusive = dayOf(e.end) ?? addDays(start, 1);
      if (raceDay >= todayDay && endExclusive <= todayDay) continue;
      const hay = new Set([...distinctiveWords(e.summary), ...distinctiveWords(e.location)]);
      let hit = false;
      for (const w of needles) if (hay.has(w)) { hit = true; break; }
      if (!hit) continue;
      // LAST qualifying trip by start date: with two matching trips on the
      // calendar, the later one is the one you are racing off.
      if (!best || start > best.start) best = { start, event: e };
    }
  }

  if (best) {
    return {
      arrival_date: best.start,
      days_at_altitude: Math.max(0, daysBetween(best.start, raceDay) ?? 0),
      source: "calendar",
      matched_event: {
        summary: typeof best.event.summary === "string" ? best.event.summary : "(untitled)",
        start: best.event.start,
        end: best.event.end ?? null,
        location: best.event.location ?? null,
      },
    };
  }

  return { arrival_date: addDays(raceDay, -1), days_at_altitude: 1, source: "default" };
}
