/* ------------------------------------------------------------------ */
/*  Last-known-good snapshots in localStorage.                         */
/*                                                                    */
/*  Race-day mode is read on a phone, on a ridge, over a LAN link to a */
/*  laptop that may be asleep, in a tent, or out of Wi-Fi range. The   */
/*  page itself comes from the browser's HTTP cache on a reload; what  */
/*  does NOT survive is the two fetches the plan is built from         */
/*  (/api/race/active and /course.json), so a reload with the server   */
/*  unreachable renders an empty view of a race that is happening.     */
/*                                                                    */
/*  So both payloads are written here on every successful load and     */
/*  read back when a fetch fails. The caller surfaces an error string  */
/*  either way — a cached plan is shown AS cached, never passed off as */
/*  fresh.                                                            */
/*                                                                    */
/*  LIMITATION (v1, deliberate): this is not a service worker. The     */
/*  HTML/JS bundle still has to come from the dev server, so a FIRST   */
/*  load with the laptop unreachable shows the browser's offline page  */
/*  and this cache never gets a chance to run. It covers the case it   */
/*  was built for — the tab is already open and gets reloaded, or      */
/*  reopened from history while the bundle is still in the HTTP cache  */
/*  — and nothing more. A real offline-first shell needs a service     */
/*  worker, which is a PWA dependency this app does not take.          */
/* ------------------------------------------------------------------ */

const PREFIX = "bc.cache.";

/** The merged /api/race/active payload. One key: there is one active race. */
export const ACTIVE_RACE_CACHE = "race-active";

/** Key for a per-race payload (/course.json, /crew-base.json,
    /nutrition.json). Namespaced by slug because each is served out of
    whichever race folder is pointed at, and a 50k's profile restored under
    a hundred's name is worse than no profile at all. */
export function slugKey(name: string, slug: string | null): string {
  return `${name}.${slug ?? "__generic"}`;
}

export function cachePut(key: string, value: unknown): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* private mode / quota */ }
}

export function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch { return null; } // private mode, or a half-written entry
}
