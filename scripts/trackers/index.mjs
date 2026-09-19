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

/** Registration order is match order; the first adapter claiming a host wins. */
export const ADAPTERS = [opensplittime, maprogress];

/** How long one slug's answer is reused before the tracker is asked again. */
export const CACHE_TTL_MS = 60_000;

const tagged = (code, msg) => Object.assign(new Error(msg), { code });

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
 * @returns {Promise<object|null>} null when the runner is not on the page,
 *   or is on it with no checkpoint beyond the start
 * @throws {Error & {code: string}} `not_found` when no adapter matches
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
 * Only SUCCESSES are cached, including a `null` result (a runner not yet
 * through a checkpoint is a perfectly good answer and must not be re-asked
 * every few seconds). A thrown error is deliberately NOT cached: the client
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

  const at = new Date(now).toISOString();
  const tracker = await adapter.fetchLastCheckpoint(
    {
      url: tracking.url,
      bib: tracking.bib,
      name: tracking.name,
      stations: (race?.aid_stations ?? []).map((s) => s?.name).filter((n) => typeof n === "string"),
      at,
    },
    fetchImpl,
  );

  const body = { slug, source: adapter.id, tracker, polled_at: at };
  // A cache handed in as undefined (a one-shot CLI call) still works; it
  // just does not remember.
  cache?.set(key, { at: now, body });
  return { ...body, cached: false, age_s: 0 };
}
