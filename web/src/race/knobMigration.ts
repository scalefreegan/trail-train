/* ------------------------------------------------------------------ */
/*  One-time migration of the bare `race.<knob>` localStorage keys      */
/*  (written before pacing knobs were namespaced per race) into the     */
/*  `race.<slug>.<knob>` scheme.                                        */
/*                                                                      */
/*  Split out of useRacePlan.ts, with no React import and no reference  */
/*  to the retired race's slug (that literal has to stay in             */
/*  useRacePlan.ts — see the ALLOWED_EXCEPTIONS entry in                */
/*  scripts/check-races.mjs), so this is a pure function of a           */
/*  storage-like object and can be unit-tested with a fake one          */
/*  (scripts/knob-migration.test.mjs) instead of requiring a real DOM.  */
/* ------------------------------------------------------------------ */

/** The knobs that belong to a race rather than to the athlete. */
export const RACE_KNOBS = [
  "goal_h", "fatigue_pct_v2", "calibration_pct", "restraint_pct",
  "aid_stop_min", "crew_stop_min", "stop_overrides",
] as const;

/** The minimal surface migrateLegacyKnobs needs — a real `Storage`, or a
    fake object in a test. */
export interface KnobStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Slugs already migrated this page load, so a repeat call (this hook can
    mount once per race view) is a no-op rather than a second, harmless-but-
    wasted pass. Production callers rely on the default; a test passes its
    own Set to isolate runs. */
const defaultMigrated = new Set<string>();

/**
 * One-time move of `race.<knob>` → `race.<slug>.<knob>`, then delete the old
 * key. Runs once per `slug` per page load (via `migrated`), and is a no-op
 * on the second call because the legacy keys are already gone.
 *
 * An existing namespaced value always wins: it was written by this race's
 * own sliders, whereas the bare key may be a leftover from a different one.
 *
 * `slug` is deliberately a required argument, not defaulted here: the
 * caller (useRacePlan.ts) always passes the one fixed slug the bare keys
 * actually belong to, never whichever race happens to be on screen (PR #23
 * review round 1, finding 3 — migrating into the VIEWED race's namespace
 * silently misattributed another race's tuned sliders).
 */
export function migrateLegacyKnobs(
  storage: KnobStorage | undefined,
  slug: string,
  migrated: Set<string> = defaultMigrated,
): void {
  if (!storage || migrated.has(slug)) return;
  migrated.add(slug);
  try {
    for (const knob of RACE_KNOBS) {
      const legacy = storage.getItem(`race.${knob}`);
      if (legacy == null) continue;
      const key = `race.${slug}.${knob}`;
      if (storage.getItem(key) == null) storage.setItem(key, legacy);
      storage.removeItem(`race.${knob}`);
    }
  } catch { /* private mode */ }
}
