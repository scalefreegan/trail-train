// MAProgress adapter — DELIBERATE STUB. PRD §4, bead tt-cv1b0.5.
//
// MAProgress (maprogress.com) is the San Juan Softie's satellite-tracking
// provider from 2026 on ("we require satellite tracking … rent one from our
// tracking provider MAProgress" — sanjuansoftie.com FAQ, read 2026-09-19).
// It is registered here, and detect() DOES claim maprogress.com URLs, so an
// athlete who pastes one gets this module's explicit refusal instead of the
// registry's generic "no adapter" 404. Knowing the tracker is recognised but
// unsupported is worth a route of its own.
//
// Why it is a stub rather than a parser — what was actually checked on
// 2026-09-19:
//
//   1. sanjuansoftie.com names MAProgress in prose and links NO event page.
//      There is no public Softie URL to point an adapter at; the tracking
//      link is mailed to entrants "a month or so before the race".
//   2. https://app.maprogress.com/ serves an empty jQuery shell. Its inline
//      `fms_settings` block declares `useEventSubdomains: true`,
//      `signalRHubsVersion: "1"` and a CDN origin — i.e. each event lives on
//      its own subdomain and positions arrive over a SignalR websocket hub
//      after the page boots. The first GET's HTML contains no entrant, no
//      checkpoint and no position.
//   3. There is no documented public JSON endpoint, and the SignalR hub
//      names are minified into the CDN bundle, so any parse would be a
//      reverse-engineered handshake against an undocumented, unversioned,
//      auth-adjacent socket — re-broken by the next deploy, and unfixable
//      without a live event to test against.
//
// So this adapter fails loudly and says why. What it would take to make it
// real: one public MAProgress event URL (ideally the Softie's, once it is
// issued), captured with the websocket frames its map subscribes to; if a
// plain XHR JSON endpoint turns up in that capture, it becomes the fixture
// and this file becomes a parser like opensplittime.mjs. Until then a
// convincing-looking parser written blind would be worse than this error:
// on race morning it would fail in a way nobody had ever seen.

/** Registry id; matches the `source` an implementation would report. */
export const id = "maprogress";

export const label = "MAProgress";

/** Hostnames this adapter claims — including the per-event subdomains
    (`<event>.maprogress.com`) the app's own config says it uses. */
export const hostnames = ["maprogress.com"];

/** No fixture: nothing static to parse. Kept so the registry shape is
    uniform and `supported: false` is a fact callers can read, not infer. */
export const supported = false;

/** True when `url`'s host is (or is under) maprogress.com. */
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
 * Always refuses, with the reason. Never touches the network — there is
 * nothing to ask for.
 *
 * @returns {Promise<never>}
 * @throws {Error & {code: "unsupported"}}
 */
export async function fetchLastCheckpoint() {
  throw Object.assign(
    new Error(
      `${label} live tracking is not supported: its event pages render from a SignalR websocket after load, ` +
        "so the first response carries no checkpoint data to read. Point `tracking.url` at an OpenSplitTime " +
        "spread page instead, or enter checkpoints by hand on the race-day screen.",
    ),
    { code: "unsupported" },
  );
}
