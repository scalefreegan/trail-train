// Local-fixture tracker adapter — TEST ONLY. PRD v2 §4, bead tt-cv1b0.6.
//
// WHY THIS EXISTS. Race day's whole point is a page that polls a live
// timing site, and the only honest way to prove the polling works is to
// actually poll something over HTTP. The real adapters claim a URL by
// HOSTNAME (opensplittime.org, maprogress.com), so a committed fixture
// served off 127.0.0.1 matches none of them and the endpoint answers 404
// before a single byte is parsed.
//
// So: one more adapter, registered ONLY when TRAIL_TEST_FIXTURES=1 (see
// ADAPTERS in ./index.mjs), that claims any URL whose path is under
// /__fixtures__/trackers/. The dev server serves exactly that path out of
// scripts/fixtures/trackers/ under the same flag. With the flag unset —
// which is every real run, every `npm run build`, every `node --test` — this
// module is not in the registry at all and the product behaves identically.
//
// It is not a second parser. The fixture IS an OpenSplitTime spread page
// (that is the one we captured), so the parse is opensplittime.mjs's,
// imported rather than copied: a fixture that stopped exercising the real
// parser would be worth nothing.
//
// The `source` it reports is "fixture", never "opensplittime" — a test
// double that claimed to be the real thing could pass a test the real
// adapter would fail.

import {
  findRow,
  lastCheckpointFromRow,
  mapStation,
  parseRows,
  parseStationHeaders,
} from "./opensplittime.mjs";

/** Registry id; surfaces as `source` on every result. */
export const id = "fixture";

export const label = "Local fixture";

/** None — this adapter is claimed by PATH, not by host, because the host is
    whatever loopback address the dev server happens to be on. */
export const hostnames = [];

/** The one path shape the dev server serves fixtures at. */
const FIXTURE_PATH = /^\/__fixtures__\/trackers\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

const TIMEOUT_MS = 5_000;

const tagged = (code, msg) => Object.assign(new Error(msg), { code });

/** True when `url` points at the dev server's fixture route. */
export function matches(url) {
  let pathname;
  try {
    pathname = new URL(String(url)).pathname;
  } catch {
    return false;
  }
  return FIXTURE_PATH.test(pathname);
}

/**
 * Where was this runner last seen, per the committed fixture page?
 *
 * Same contract as every other adapter — same arguments, same result shape,
 * same tagged errors — so the endpoint, the cache and the client cannot tell
 * which one answered except by reading `source`.
 *
 * @param {object} req
 * @param {string} req.url the fixture URL from race.json `tracking.url`
 * @param {string|number|null} [req.bib]
 * @param {string|null} [req.name]
 * @param {string[]} [req.stations] race.json aid station names
 * @param {string} [req.at] ISO poll timestamp
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<object|{tracker: null, reason: "runner_not_found"|"no_checkpoint"}>}
 *   see opensplittime.mjs's fetchLastCheckpoint — same reason-tagged miss.
 * @throws {Error & {code: string}} including `ambiguous` (from findRow, via
 *   opensplittime.mjs) for a name that ties across two or more entrants
 */
export async function fetchLastCheckpoint(req, fetchImpl = fetch) {
  const { url, bib = null, name = null, stations = [] } = req ?? {};
  if (!matches(url)) {
    throw tagged("bad_request", `not a fixture URL: ${String(url)} (expected /__fixtures__/trackers/<file>)`);
  }

  let res;
  try {
    res = await fetchImpl(String(url), {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw tagged("bad_gateway", `${label}: ${url} could not be read (${e?.message ?? e})`);
  }
  if (!res?.ok) throw tagged("bad_gateway", `${label}: ${url} returned HTTP ${res?.status ?? "?"}`);

  const html = await res.text();
  const headers = parseStationHeaders(html);
  const rows = parseRows(html);
  if (!headers.length || !rows.length) {
    throw tagged("bad_gateway", `${label}: ${url} is not a readable spread table`);
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
