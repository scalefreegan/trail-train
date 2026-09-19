// OpenSplitTime adapter — PRD §4, bead tt-cv1b0.5.
//
// OpenSplitTime (opensplittime.org) is the timing/results platform the San
// Juan Softie and a long tail of other 100s publish live splits on. Its
// "spread" page (/events/<event-slug>/spread) is ONE server-rendered HTML
// table holding every entrant as a row and every aid station as a column —
// no JS, no XHR, no auth. That is the whole reason this adapter is real and
// maprogress.mjs is a stub: the numbers are already in the HTML the first
// GET returns.
//
// What the page looks like (see scripts/fixtures/trackers/README.md for the
// committed, scrubbed copy this module's tests parse):
//
//   <thead> … 7 fixed columns (watch star, O/G place, Bib, Name, Category,
//             From, Status) then one <th> per station:
//               "Cascade #1<br>(Mile 8.3)"
//               "EMT #2<br>In / Out<br>(Mile 19.5)"
//   <tbody> … <tr id="effort_111479"> with one <td> per column:
//               "Fri 6:00AM"                  a single-time station
//               "Fri 9:19AM / Fri 9:22AM"     in / out
//               "--:--:-- / Fri 11:25AM"      the in-time was never recorded
//               "--:--:--"                    not reached (or not started)
//
// So: find the runner's row by bib (exact) or name (the aid-match
// normaliser), walk its station cells LEFT TO RIGHT, and the last cell
// holding a real time is where they were last seen. The elapsed clock comes
// from the row's own first station cell (the start), not from race.json's
// start_time — a runner who started in a later wave has a different zero,
// and the page already knows theirs.
//
// Day rollover: the page prints a weekday, not a date ("Fri 9:20PM",
// "Sat 2:04AM"). Elapsed is therefore accumulated across the row: a time
// earlier in the day than the one before it has crossed midnight. The
// weekday is used when both ends carry one; otherwise the monotonic bump
// carries it. A race longer than 7 days would alias, which no 100 is.

import { nameScore } from "../aid-match.mjs";

/** Registry id; surfaces as `source` on every result and in the endpoint. */
export const id = "opensplittime";

/** For messages and, later, the review dialog's tracker picker. */
export const label = "OpenSplitTime";

/** Hostnames this adapter claims. Matched on the registered domain, so any
    subdomain (www., staging.) belongs to it too. */
export const hostnames = ["opensplittime.org"];

/** Cap on the fetched page — a spread for a 500-entrant race is ~1 MB. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Per-poll network timeout. Shorter than the intake's 25 s: race day polls
    on a repeating timer and a stuck request must not stack up. */
const TIMEOUT_MS = 12_000;

/**
 * Minimum aid-match score before a tracker's checkpoint label is considered
 * the same place as a race.json aid station. Deliberately high: mapping
 * "Cascade #1" onto the wrong station would put the race-day hold at the
 * wrong mile, which is worse than showing the tracker's own label.
 */
export const STATION_MATCH_MIN = 0.6;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const tagged = (code, msg, extra) => Object.assign(new Error(msg), { code, ...extra });

/** True when `url`'s host is (or is under) one of this adapter's domains. */
export function matches(url) {
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostnames.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Normalize a configured tracking URL to the spread page.
 *
 * The URL an athlete pastes is whatever the race site linked: the event page
 * (/events/<slug>), the spread (/events/<slug>/spread) or one of the other
 * views (/events/<slug>/podium). All of them name the same event, and only
 * the spread carries every split, so the path is rewritten rather than
 * refused. Query and hash are dropped — a `?sort=bib_number` inherited from
 * a copied link would reorder rows for no benefit, and the cache key is
 * cleaner without it.
 *
 * @param {string} url
 * @returns {string}
 */
export function spreadUrl(url) {
  const u = new URL(String(url));
  const m = /^\/events\/([^/]+)/.exec(u.pathname);
  if (!m) {
    throw tagged("bad_request", `not an OpenSplitTime event URL: ${u.href} (expected /events/<event-slug>/spread)`);
  }
  return `${u.origin}/events/${m[1]}/spread`;
}

/* ------------------------------ parsing -------------------------------- */

const stripTags = (html) => String(html).replace(/<[^>]*>/g, " ");
const decodeEntities = (s) =>
  String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
const squash = (s) => decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();

/**
 * The station column names, in course order.
 *
 * A station header is "Name<br>In / Out<br>(Mile 12.3)"; only the first line
 * is the place. The "In / Out" line and the mile are dropped — the mile is
 * already in race.json and the matcher works on names.
 *
 * @param {string} html the whole page
 * @returns {string[]}
 */
export function parseStationHeaders(html) {
  const thead = /<thead[^>]*>([\s\S]*?)<\/thead>/i.exec(String(html));
  if (!thead) return [];
  const out = [];
  const thRe = /<th\b([^>]*)>([\s\S]*?)<\/th>/gi;
  let m;
  while ((m = thRe.exec(thead[1])) !== null) {
    // The 7 fixed columns are plain <th> or <th class="text-center
    // align-bottom">; every station column is <th class="text-nowrap
    // text-center">. Keying on that class is what keeps "Bib"/"Name"/
    // "Status" out of the station list without hard-coding a column count.
    if (!/text-nowrap/.test(m[1])) continue;
    const first = m[2].split(/<br\s*\/?>/i)[0];
    const name = squash(first);
    if (name) out.push(name);
  }
  return out;
}

/**
 * Every entrant row, as flat cell text.
 * @param {string} html
 * @returns {{bib: string, name: string, status: string, cells: string[]}[]}
 */
export function parseRows(html) {
  const rows = [];
  const trRe = /<tr\b[^>]*\bid="effort_\d+"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(String(html))) !== null) {
    const cells = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let c;
    while ((c = tdRe.exec(m[1])) !== null) cells.push(squash(c[1]));
    // 1 watch star + place + bib + name + category + from + status.
    if (cells.length < 7) continue;
    rows.push({ bib: cells[2], name: cells[3], status: cells[6], cells: cells.slice(7) });
  }
  return rows;
}

/**
 * One printed time → minutes since midnight plus the weekday it named.
 * Accepts the three shapes the page emits: "Fri 9:19AM", "Fri 5:28:32AM"
 * (the finish, which carries seconds) and 24-hour "Fri 21:19" (the page's
 * `display_style=military`). Returns null for "--:--:--", "", and anything
 * else — a placeholder is not an error, it is a station not reached.
 *
 * @param {string} token
 * @returns {{minutes: number, weekday: number|null}|null}
 */
export function parseClockToken(token) {
  const t = String(token ?? "").trim();
  if (!t || /^-+[:\-]/.test(t)) return null;
  const m = /^(?:([A-Za-z]{3})[a-z]*\.?\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?$/.exec(t);
  if (!m) return null;
  const [, day, hhRaw, mm, ss, ap] = m;
  let hh = Number(hhRaw);
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    const pm = ap.toLowerCase() === "p";
    hh = (hh % 12) + (pm ? 12 : 0);
  } else if (hh > 23) return null;
  const minutes = hh * 60 + Number(mm) + (ss ? Number(ss) / 60 : 0);
  const weekday = day ? WEEKDAYS.indexOf(day.toLowerCase()) : -1;
  return { minutes, weekday: weekday < 0 ? null : weekday };
}

/**
 * The time a station cell reports, or null.
 *
 * An "in / out" cell holds two: the out-time is the later fact, so it wins,
 * and "--:--:-- / Fri 11:25AM" (an in-time nobody recorded) still yields the
 * out. A cell whose halves are both placeholders is null.
 *
 * @param {string} cell
 * @returns {{minutes: number, weekday: number|null, text: string}|null}
 */
export function parseStationCell(cell) {
  const parts = String(cell ?? "").split("/");
  for (let i = parts.length - 1; i >= 0; i--) {
    const parsed = parseClockToken(parts[i]);
    if (parsed) return { ...parsed, text: parts[i].trim() };
  }
  return null;
}

/** "9:19AM"/"21:19" minutes-since-midnight → the "HH:MM" the hold is labelled with. */
function clockLabel(minutes) {
  const total = Math.floor(minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Walk one row's station cells and return the last one holding a real time,
 * with elapsed hours measured from the row's own first recorded time.
 *
 * @param {string[]} cells station cells, course order
 * @param {string[]} headers station column names, same order
 * @returns {{index: number, checkpoint: string, clock: string, elapsed_h: number|null}|null}
 */
export function lastCheckpointFromRow(cells, headers) {
  let startAbs = null;
  let prevAbs = null;
  let prevWeekday = null;
  let dayCarry = 0;
  let last = null;

  for (let i = 0; i < cells.length; i++) {
    const hit = parseStationCell(cells[i]);
    if (!hit) continue;

    // Absolute minutes since the row's first recorded day-midnight. The
    // weekday advances the day count when it is printed on both ends; a
    // clock that simply went backwards advances it when it is not.
    if (hit.weekday !== null && prevWeekday !== null) {
      dayCarry += (hit.weekday - prevWeekday + 7) % 7;
    }
    let abs = dayCarry * 1440 + hit.minutes;
    if (prevAbs !== null && abs < prevAbs) {
      // Same printed weekday but an earlier clock: midnight passed and the
      // page (or a missing weekday) did not say so.
      const bumps = Math.ceil((prevAbs - abs) / 1440);
      dayCarry += bumps;
      abs += bumps * 1440;
    }
    prevAbs = abs;
    if (hit.weekday !== null) prevWeekday = hit.weekday;
    if (startAbs === null) startAbs = abs;

    last = {
      index: i,
      checkpoint: headers[i] ?? `Station ${i + 1}`,
      clock: clockLabel(hit.minutes),
      elapsed_h: +((abs - startAbs) / 60).toFixed(3),
    };
  }
  // The first recorded time IS the start; a row whose only time is the start
  // has not reached a checkpoint yet and there is nothing to report.
  return last && last.index > 0 ? last : null;
}

/**
 * Pick the row for this runner. Bib is exact and wins outright — it is the
 * identifier the athlete configured and two entrants never share one. Name
 * is the fallback, through the same normaliser the GPX matcher uses (case,
 * punctuation and abbreviations folded), and only above 0.9: "Chris Adams"
 * must not resolve to "Chris Adamson".
 *
 * A name that ties the winning score across two or more rows (a father/son
 * or a duo sharing a name, common enough in ultrarunning) is refused rather
 * than guessed at — silently attaching the hold to whichever row happened to
 * print first would be the wrong entrant's splits shown as fact. The same
 * "showing the tracker's own label is honest; silently attaching it to the
 * wrong station is not" principle mapStation already applies.
 *
 * @param {{bib: string, name: string}[]} rows
 * @param {{bib?: string|null, name?: string|null}} who
 * @returns {object|null}
 * @throws {Error & {code: "ambiguous", candidates: number}} when two or more
 *   rows tie at the winning name score
 */
export function findRow(rows, { bib, name } = {}) {
  const wantBib = bib === undefined || bib === null ? "" : String(bib).trim();
  if (wantBib) {
    const hit = rows.find((r) => r.bib === wantBib);
    if (hit) return hit;
  }
  const wantName = typeof name === "string" ? name.trim() : "";
  if (wantName) {
    let best = null;
    let tied = 0;
    for (const r of rows) {
      const score = r.name.toLowerCase() === wantName.toLowerCase() ? 1 : nameScore(r.name, wantName);
      if (score < 0.9) continue;
      if (!best || score > best.score) {
        best = { row: r, score };
        tied = 1;
      } else if (score === best.score) {
        tied += 1;
      }
    }
    if (best) {
      if (tied > 1) {
        throw tagged(
          "ambiguous",
          `${tied} entrants match name ${JSON.stringify(wantName)} — set a bib to tell them apart`,
          { candidates: tied },
        );
      }
      return best.row;
    }
  }
  return null;
}

/**
 * Drop the "#7" an aid chart numbers its stations with. It is an ordinal,
 * not part of the place: OpenSplitTime prints "Burnett #7" and a
 * hand-authored race.json may say "Burnett Aid", and the normaliser scores
 * those 0.5 (one shared token out of two) purely because of the digit.
 * Removed from BOTH sides before scoring; the exact-string check in
 * mapStation runs first and is unaffected.
 * @param {string} name
 */
function withoutOrdinal(name) {
  return String(name ?? "").replace(/#\s*\d+/g, " ").trim();
}

/**
 * Map the tracker's checkpoint label onto a race.json aid station name.
 * Falls back to the tracker's own label when nothing scores high enough —
 * showing "Cascade #1" is honest; silently attaching it to the wrong
 * station is not.
 *
 * @param {string} checkpoint
 * @param {string[]} stations race.json aid_stations names, course order
 * @returns {{station: string, matched: boolean, score: number}}
 */
export function mapStation(checkpoint, stations = []) {
  let best = { station: checkpoint, matched: false, score: 0 };
  const wantExact = String(checkpoint).trim().toLowerCase();
  for (const s of stations) {
    if (typeof s !== "string" || !s.trim()) continue;
    const score = s.trim().toLowerCase() === wantExact ? 1 : nameScore(withoutOrdinal(s), withoutOrdinal(checkpoint));
    if (score > best.score) best = { station: s, matched: score >= STATION_MATCH_MIN, score: +score.toFixed(3) };
  }
  return best.matched ? best : { station: checkpoint, matched: false, score: best.score };
}

/* ------------------------------- fetch --------------------------------- */

/**
 * Where was this runner last seen?
 *
 * @param {object} req
 * @param {string} req.url the configured race.json `tracking.url`
 * @param {string|number|null} [req.bib]
 * @param {string|null} [req.name]
 * @param {string[]} [req.stations] race.json aid station names, for mapping
 * @param {string} [req.at] ISO poll timestamp (injected by tests)
 * @param {typeof fetch} [fetchImpl] injected in tests; NOTHING in this module
 *        reaches the network on its own
 * @returns {Promise<{station: string, checkpoint: string, clock: string,
 *   elapsed_h: number|null, source: string, at: string, bib: string,
 *   runner_status: string, matched: boolean} |
 *   {tracker: null, reason: "runner_not_found"|"no_checkpoint"}>}
 *   the reason-tagged shape distinguishes a bib/name that matches nobody
 *   ("runner_not_found") from a matched row that has not passed a
 *   checkpoint yet ("no_checkpoint") — both were a bare `null` before this
 *   was split out, and a mistyped bib failed exactly as quietly as an
 *   unstarted race.
 * @throws {Error & {code: string}} `bad_gateway` for an unreachable or
 *   unparseable page, `bad_request` for a URL that is not an OST event,
 *   `ambiguous` for a name that ties across two or more entrants
 */
export async function fetchLastCheckpoint(req, fetchImpl = fetch) {
  const { url, bib = null, name = null, stations = [] } = req ?? {};
  const target = spreadUrl(url);

  let res;
  try {
    res = await fetchImpl(target, {
      redirect: "follow",
      headers: { accept: "text/html", "user-agent": "trail-train/basecamp tracker" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw tagged(
      "bad_gateway",
      e?.name === "TimeoutError"
        ? `${label}: ${target} did not answer within ${TIMEOUT_MS / 1000}s`
        : `${label}: ${target} could not be reached (${e?.message ?? e})`,
    );
  }
  if (!res?.ok) throw tagged("bad_gateway", `${label}: ${target} returned HTTP ${res?.status ?? "?"}`);

  const html = await res.text();
  if (html.length > MAX_BYTES) {
    throw tagged("bad_gateway", `${label}: ${target} returned more than ${MAX_BYTES} bytes`);
  }

  // A page that parses to no columns and no rows is not "this runner is not
  // entered" — it is a login wall, an error page, or a redesign. Saying so
  // is the difference between the race-day screen showing a stale hold and
  // it showing a lie.
  const headers = parseStationHeaders(html);
  const rows = parseRows(html);
  if (!headers.length || !rows.length) {
    throw tagged(
      "bad_gateway",
      `${label}: ${target} has no readable spread table (${headers.length} station columns, ${rows.length} entrant rows) — the page may have changed or the event may not be public`,
    );
  }

  const row = findRow(rows, { bib, name });
  if (!row) return { tracker: null, reason: "runner_not_found" };
  const last = lastCheckpointFromRow(row.cells, headers);
  if (!last) return { tracker: null, reason: "no_checkpoint" };

  const mapped = mapStation(last.checkpoint, stations);
  return {
    station: mapped.station,
    checkpoint: last.checkpoint,
    matched: mapped.matched,
    clock: last.clock,
    elapsed_h: last.elapsed_h,
    source: id,
    at: req?.at ?? new Date().toISOString(),
    bib: row.bib,
    runner_status: row.status,
  };
}
