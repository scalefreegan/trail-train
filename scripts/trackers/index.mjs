// Tracker registry — PRD §4, bead tt-cv1b0.5.
//
// Race day asks one question of the outside world: "where was the runner
// last seen?". A tracker adapter answers it for one timing platform, and
// this file is the switchboard plus the cache that keeps the answer cheap.
//
// Shape of an adapter (scripts/trackers/*.mjs):
//   id          string, also the `source` on every result
//   label       human name for messages
//   hostnames   registered domains it claims (subdomains included)
//   supported   optional; false marks a documented stub (maprogress.mjs)
//   matches(url)                        → boolean
//   fetchLastCheckpoint(req, fetchImpl) → result | null, throws tagged
//
// Two rules that are load-bearing rather than stylistic:
//
//   NOTHING HERE POLLS ON ITS OWN. There is no timer, no warm-up, no
//   prefetch. `pollTracker` runs only when a caller calls it, which is only
//   when a browser asked (PRD §4: "never polls unless a client asks"). A
//   background poller would hammer a volunteer-run timing site for a page
//   nobody is looking at.
//
//   EVERY FETCH IS INJECTED. `fetchImpl` threads down to the adapter, so
//   scripts/trackers.test.mjs parses committed fixtures with zero network.
//
// Error codes travel on `e.code`, the same convention race-result.mjs uses,
// so the dev-server middleware can map them to status codes without string
// matching: `bad_request` (400), `not_found` (404), `unsupported` (501),
// `bad_gateway` (502).

import * as opensplittime from "./opensplittime.mjs";
import * as maprogress from "./maprogress.mjs";
import * as fixture from "./fixture.mjs";

/**
 * Registration order is match order; the first adapter claiming a host wins.
 *
 * The fixture adapter (bead tt-cv1b0.6) is appended ONLY under
 * TRAIL_TEST_FIXTURES=1, the same flag the dev server's fixture route is
 * gated on. It claims URLs by PATH (/__fixtures__/trackers/<file>), which no
 * real tracker uses, so it cannot shadow opensplittime or maprogress even
 * when it is loaded — but it is kept out of the list entirely unless asked
 * for, so a production run's registry is byte-identical to what it was
 * before the flag existed.
 */
export const ADAPTERS = [
  opensplittime,
  maprogress,
  ...(process.env.TRAIL_TEST_FIXTURES === "1" ? [fixture] : []),
];

/** How long one slug's answer is reused before the tracker is asked again. */
export const CACHE_TTL_MS = 60_000;

const tagged = (code, msg) => Object.assign(new Error(msg), { code });

/**
 * In-flight upstream fetches, keyed by the SAME cache instance a caller
 * passes to pollTracker (round 3, resilience finding 11): a cold burst — the
 * 60 s TTL cache has nothing yet, several browser tabs on the same race day
 * all ask in the same tick — used to start one real fetch PER REQUEST rather
 * than sharing the one already under way, which is exactly the moment a
 * volunteer-run timing site is least able to take it. A WeakMap keyed on
 * `cache` itself, not a field ON it, so a caller that passes no cache at all
 * (a one-shot CLI call) gets no sharing either — consistent with "it just
 * does not remember" below.
 */
const IN_FLIGHT = new WeakMap();

/** This cache instance's in-flight map, created on first use. */
function inFlightFor(cache) {
  let m = IN_FLIGHT.get(cache);
  if (!m) { m = new Map(); IN_FLIGHT.set(cache, m); }
  return m;
}

/**
 * Which adapter handles this URL, or null when none does.
 * @param {string} url
 * @returns {object|null}
 */
export function detect(url) {
  if (typeof url !== "string" || !url.trim()) return null;
  return ADAPTERS.find((a) => a.matches(url)) ?? null;
}

/**
 * Ask the matching adapter where the runner was last seen.
 *
 * @param {object} req
 * @param {string} req.url race.json `tracking.url`
 * @param {string|number|null} [req.bib]
 * @param {string|null} [req.name]
 * @param {string[]} [req.stations] race.json aid station names, course order
 * @param {string} [req.at] ISO poll timestamp (injected by tests)
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object|{tracker: null, reason: "runner_not_found"|"no_checkpoint"}>}
 *   the reason-tagged shape when the runner is not on the page
 *   ("runner_not_found") or is on it with no checkpoint beyond the start
 *   ("no_checkpoint") — see opensplittime.mjs's fetchLastCheckpoint
 * @throws {Error & {code: string}} `not_found` when no adapter matches,
 *   `ambiguous` when a name ties across two or more entrants
 */
export async function fetchLastCheckpoint(req, fetchImpl = fetch) {
  const url = req?.url;
  const adapter = detect(url);
  if (!adapter) {
    throw tagged("not_found", `no tracker adapter matches ${JSON.stringify(String(url ?? ""))}`);
  }
  return adapter.fetchLastCheckpoint(req, fetchImpl);
}

/**
 * A tracker's configuration as race.json carries it, validated.
 * @param {object|null|undefined} tracking race.json `tracking`
 * @returns {{url: string, bib: string|null, name: string|null}}
 * @throws {Error & {code: "not_found"}} when no tracker is configured
 */
export function requireTracking(tracking) {
  const url = typeof tracking?.url === "string" ? tracking.url.trim() : "";
  if (!url) throw tagged("not_found", "this race has no tracking.url — add one in the review screen");
  return {
    url,
    bib: typeof tracking.bib === "string" && tracking.bib.trim() ? tracking.bib.trim() : null,
    name: typeof tracking.name === "string" && tracking.name.trim() ? tracking.name.trim() : null,
  };
}

/** A fresh, empty cache. One per dev-server process; one per test. */
export function createTrackerCache() {
  return new Map();
}

/**
 * The cached poll. This is what the `/api/races/:slug/tracker` middleware
 * is a thin wrapper around — the TTL lives here, in a module `node --test`
 * can drive with an injected clock and an injected fetch, rather than in
 * vite.config.ts where nothing can reach it.
 *
 * Only SUCCESSES are cached, including a no-match result — `tracker: null`
 * with a `reason` (a runner not yet through a checkpoint is a perfectly good
 * answer and must not be re-asked every few seconds). A thrown error is
 * deliberately NOT cached: the client
 * backs off on failure anyway (PRD §4), and pinning a transient 502 for a
 * full minute would outlast the outage that caused it.
 *
 * The cache key is the slug plus everything the answer depends on, so
 * editing the bib in the review screen invalidates it without a manual
 * clear.
 *
 * @param {object} o
 * @param {string} o.slug
 * @param {object} o.race the parsed race.json
 * @param {Map} o.cache from createTrackerCache()
 * @param {typeof fetch} [o.fetchImpl]
 * @param {number} [o.now] epoch ms, injectable
 * @param {number} [o.ttlMs]
 * @returns {Promise<{slug: string, source: string, tracker: object|null,
 *   reason: "runner_not_found"|"no_checkpoint"|null,
 *   cached: boolean, age_s: number, polled_at: string}>}
 */
export async function pollTracker(o) {
  const { slug, race, cache, fetchImpl = fetch, now = Date.now(), ttlMs = CACHE_TTL_MS } = o ?? {};
  const tracking = requireTracking(race?.tracking);
  const adapter = detect(tracking.url);
  if (!adapter) {
    throw tagged("not_found", `no tracker adapter matches ${JSON.stringify(tracking.url)}`);
  }

  const key = `${slug}|${tracking.url}|${tracking.bib ?? ""}|${tracking.name ?? ""}`;
  const hit = cache?.get(key);
  if (hit && now - hit.at < ttlMs) {
    return { ...hit.body, cached: true, age_s: +((now - hit.at) / 1000).toFixed(1) };
  }

  // Join an upstream fetch this exact key already has under way rather than
  // starting a second one — see IN_FLIGHT's doc above. Only ever set when a
  // cache was actually passed, so this is a no-op for a one-shot CLI call.
  const pending = cache ? inFlightFor(cache) : null;
  const joined = pending?.get(key);
  if (joined) {
    return { ...(await joined), cached: true, age_s: 0 };
  }

  const at = new Date(now).toISOString();
  const fetchOnce = (async () => {
    const result = await adapter.fetchLastCheckpoint(
      {
        url: tracking.url,
        bib: tracking.bib,
        name: tracking.name,
        stations: (race?.aid_stations ?? []).map((s) => s?.name).filter((n) => typeof n === "string"),
        at,
      },
      fetchImpl,
    );
    // The adapter returns either a checkpoint object (a match) or a
    // `{tracker: null, reason}` miss — unwrapped here so the endpoint's JSON
    // carries `tracker` and `reason` as siblings rather than the client
    // having to know which adapter-level shape it got.
    const miss = result !== null && typeof result === "object" && "reason" in result;
    const tracker = miss ? null : result;
    const reason = miss ? result.reason : null;
    return { slug, source: adapter.id, tracker, reason, polled_at: at };
  })();
  pending?.set(key, fetchOnce);

  try {
    const body = await fetchOnce;
    // A cache handed in as undefined (a one-shot CLI call) still works; it
    // just does not remember.
    cache?.set(key, { at: now, body });
    return { ...body, cached: false, age_s: 0 };
  } finally {
    // Whether fetchOnce resolved or threw — a failure must not stay "in
    // flight" forever, and must not be cached either (see the module doc
    // above: the client backs off on failure on its own).
    pending?.delete(key);
  }
}
