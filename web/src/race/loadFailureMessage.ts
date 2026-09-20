import { friendlyFetchError } from "./dialogChrome";

/**
 * A network-level fetch failure (dev server unreachable — killed, crashed, a
 * phone that lost the LAN) and a genuinely corrupt/unreadable file used to
 * be reported identically by useRaceData.ts's snapshot hooks — each hook's
 * inner `r.json().catch(() => { throw new Error("parse") })` turns a real
 * parse failure into a plain Error, while `fetch()` itself rejects with a
 * TypeError when the server can't be reached at all, and the outer `.catch`
 * printed the same "<file> corrupt or unreadable" wording for both. That
 * sent an athlete whose laptop merely lost power looking at their race
 * folder for damage that wasn't there (v2 review ui3 #6).
 *
 * A standalone module, in the same style as raceDayHold.ts/whereAmI.ts/
 * holdPrecedence.ts, so this one branch is node-testable
 * (scripts/load-failure-message.test.mjs) without dragging in
 * useRaceData.ts's own transitive imports (data.ts, offlineCache.ts, …).
 * Shares dialogChrome.ts's friendlyFetchError so the wording matches what
 * the switcher already says for the identical failure.
 */
export function loadFailureMessage(e: unknown, corruptMessage: string): string {
  return e instanceof TypeError ? friendlyFetchError(e) : corruptMessage;
}
