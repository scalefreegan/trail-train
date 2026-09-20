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

/** Key for a per-race payload (/course.json, /crew-base.json,
    /nutrition.json). Namespaced by slug because each is served out of
    whichever race folder is pointed at, and a 50k's profile restored under
    a hundred's name is worse than no profile at all. */
export function slugKey(name: string, slug: string | null): string {
  return `${name}.${slug ?? "__generic"}`;
}

/** Key for a cached /api/race/active payload, namespaced the same way:
    keyed on the payload's OWN slug (its `active` slug in train mode, its
    `viewing` slug in view mode, or null in generic mode). A single
    unnamespaced key would get overwritten by whichever race was looked at
    last, train or view — an offline reload could then hand back a browsed
    archive as if it were the race actually being run. */
export function activeRaceCacheKey(slug: string | null): string {
  return slugKey("race-active", slug);
}

/** The athlete's actual training target's slug (or null in generic mode) —
    the identity to prefer on an offline reload, independent of whatever
    race was last merely BROWSED via the switcher. Persisted only when a
    train-mode payload is cached (never overwritten by view-mode browsing). */
const LAST_TRAIN_SLUG_KEY = PREFIX + "race-active.last-train-slug";
const GENERIC_SENTINEL = "__generic";

export function setLastTrainSlug(slug: string | null): void {
  try { localStorage.setItem(LAST_TRAIN_SLUG_KEY, slug ?? GENERIC_SENTINEL); } catch { /* private mode / quota */ }
}

/** `undefined` = no train-mode payload has ever been cached on this device. */
export function getLastTrainSlug(): string | null | undefined {
  try {
    const raw = localStorage.getItem(LAST_TRAIN_SLUG_KEY);
    if (raw == null) return undefined;
    return raw === GENERIC_SENTINEL ? null : raw;
  } catch { return undefined; }
}

/** The slug of whatever /api/race/active payload was cached most recently,
    train or view — used only to explain an offline miss (see
    activeRaceFallback in data.ts), never to stand in for the active plan. */
const LAST_CACHED_SLUG_KEY = PREFIX + "race-active.last-cached-slug";

export function setLastCachedSlug(slug: string | null): void {
  try { localStorage.setItem(LAST_CACHED_SLUG_KEY, slug ?? GENERIC_SENTINEL); } catch { /* private mode / quota */ }
}

export function getLastCachedSlug(): string | null | undefined {
  try {
    const raw = localStorage.getItem(LAST_CACHED_SLUG_KEY);
    if (raw == null) return undefined;
    return raw === GENERIC_SENTINEL ? null : raw;
  } catch { return undefined; }
}

/** Drop every cached /api/race/active payload except the slugs in `keep` —
    typically [the athlete's actual training target, whatever was just
    viewed]. Before activeRaceCacheKey was namespaced per-slug there was
    exactly one "race-active" cache slot, naturally overwritten on every
    load; namespacing it (so a browsed archive can never clobber the actual
    training plan's cache) means every race the switcher is ever pointed at
    in view mode would otherwise leave a permanent bc.cache.race-active.<slug>
    entry with nothing to ever remove it. Called after every successful load
    (see data.ts's requestActiveRace) so this stays bounded instead of
    growing once per race ever browsed over the life of the install. Only
    race-active.* PAYLOAD entries are touched — the last-train-slug/
    last-cached-slug bookkeeping keys, and the unrelated per-slug course/
    crew-base/nutrition caches, are left alone. */
export function pruneActiveRaceCache(keep: (string | null)[]): void {
  try {
    const keepKeys = new Set(keep.map((slug) => PREFIX + activeRaceCacheKey(slug)));
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k
        && k.startsWith(`${PREFIX}race-active.`)
        && k !== LAST_TRAIN_SLUG_KEY
        && k !== LAST_CACHED_SLUG_KEY
        && !keepKeys.has(k)
      ) {
        doomed.push(k);
      }
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch { /* private mode / quota */ }
}

/** @returns whether the write actually landed — false on a private-mode
    write or a quota overflow, so a caller with a smaller fallback payload
    (see cachePutBounded) knows to try it. */
export function cachePut(key: string, value: unknown): boolean {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); return true; }
  catch { return false; } // private mode / quota
}

export function cacheGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch { return null; } // private mode, or a half-written entry
}

/**
 * cachePut, with a smaller fallback for a payload big enough to blow
 * localStorage's quota by itself (a browser's per-origin cap is typically a
 * few MB total, shared with every other bc.cache.* entry already written
 * this session). Every other cached payload here (course/crew-base/
 * nutrition/race-active) has stayed small enough that plain cachePut has
 * never needed this; StravaProvider's /strava.json — years of activity
 * history, one row per training run — is the one exception, so it is the
 * one caller that passes a `reduced` thunk.
 *
 * `reduced` is called only on overflow, not on every put, so it is a
 * function rather than an eagerly-computed value.
 */
export function cachePutBounded(key: string, value: unknown, reduced: () => unknown): boolean {
  if (cachePut(key, value)) return true;
  return cachePut(key, reduced());
}
