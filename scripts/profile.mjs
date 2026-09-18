// Athlete profile — config/profile.json (gitignored), with
// config/profile.example.json as the committed, impersonal fallback.
//
// The profile is where the ATHLETE lives: name, location, home trails,
// calendar conventions, and — since tt-yib.9 — `physiology`, the two numbers
// the race model used to hard-code. `body_kg` drove every mg/kg figure from
// the race folder's nutrition.json, and `long_run_ref_mi` was `D_REF = 20` in
// web/src/race/pacing.ts. Both are properties of the runner, not of the race,
// so a race folder can now be shared without carrying a body weight and the
// pacing fit can't silently read a reference distance someone else chose.
//
// Consumers: scripts/facts.mjs (re-exports loadProfile), the settings API in
// web/vite.config.ts (GET serves physiology, PUT validates it against
// PHYSIOLOGY_FIELDS), and web/src/race/useRaceData.ts through that API.

import fs from "node:fs/promises";
import path from "node:path";

/** Fallback body mass, kg. Deliberately a round, IMPERSONAL number: the
    committed example profile must never carry the owner's real weight, and a
    plan built on this default is announced (see normalizePhysiology's
    warnings) rather than quietly wrong. Roughly a median adult male runner —
    close enough that the mg/kg caffeine band lands in the right ballpark,
    far enough from anyone in particular that nobody mistakes it for theirs. */
export const DEFAULT_BODY_KG = 75;

/** Fallback long-run reference distance, mi — the old pacing.ts `D_REF`. The
    projection evaluates its fitted fitness pace at this one distance and lets
    the fatigue curve carry everything past it, so it should sit in the middle
    of the athlete's actual long-run regime. */
export const DEFAULT_LONG_RUN_REF_MI = 20;

/** The editable physiology fields, with the bounds the settings PUT enforces.
    `dflt` is what a missing/invalid value falls back to. KEEP IN SYNC with
    the physiology block in config/profile.example.json. */
export const PHYSIOLOGY_FIELDS = {
  body_kg: { lo: 30, hi: 200, dflt: DEFAULT_BODY_KG, label: "body mass (kg)" },
  long_run_ref_mi: { lo: 5, hi: 50, dflt: DEFAULT_LONG_RUN_REF_MI, label: "long-run reference (mi)" },
};

export const PHYSIOLOGY_KEYS = /** @type {const} */ (Object.keys(PHYSIOLOGY_FIELDS));

/**
 * Coerce a raw `physiology` block into a complete, in-range one.
 *
 * Never throws and never returns a partial block: a missing key, a null, a
 * hand-typed string and an out-of-band number all resolve to the documented
 * default. What it does NOT do is stay quiet about it — every substitution
 * comes back in `warnings`, because a caffeine band computed against a
 * stand-in body mass looks exactly like one computed against the athlete's.
 *
 * @param {unknown} raw the profile's `physiology` value (may be undefined)
 * @returns {{ physiology: { body_kg: number, long_run_ref_mi: number }, warnings: string[] }}
 */
export function normalizePhysiology(raw) {
  const warnings = [];
  const block = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (raw !== undefined && raw !== null && !block) {
    warnings.push("config/profile.json: `physiology` is not an object — using defaults");
  }
  const physiology = {};
  for (const [key, spec] of Object.entries(PHYSIOLOGY_FIELDS)) {
    const v = block?.[key];
    if (v == null) {
      physiology[key] = spec.dflt;
      warnings.push(
        `config/profile.json: physiology.${key} is not set — falling back to ${spec.dflt} ` +
          `(${spec.label}). Set it in the coach settings dialog so the plan is yours.`,
      );
      continue;
    }
    if (typeof v !== "number" || !Number.isFinite(v) || v < spec.lo || v > spec.hi) {
      physiology[key] = spec.dflt;
      warnings.push(
        `config/profile.json: physiology.${key} = ${JSON.stringify(v)} is not a number in ` +
          `[${spec.lo}, ${spec.hi}] — falling back to ${spec.dflt}`,
      );
      continue;
    }
    physiology[key] = v;
  }
  return { physiology, warnings };
}

/** Where the personal profile lives (gitignored). */
export const profilePath = (projectRoot) => path.join(projectRoot, "config", "profile.json");

/** Where the committed, impersonal example lives. */
export const profileExamplePath = (projectRoot) => path.join(projectRoot, "config", "profile.example.json");

/**
 * Load the athlete profile, falling back to the generic example file when no
 * personal profile.json exists yet, and to a minimal object when neither is
 * readable. `physiology` is ALWAYS present and complete on the way out.
 *
 * @returns {Promise<{ profile: object, warnings: string[] }>}
 */
export async function loadProfileWithWarnings(projectRoot) {
  let profile = null;
  for (const p of [profilePath(projectRoot), profileExamplePath(projectRoot)]) {
    try { profile = JSON.parse(await fs.readFile(p, "utf8")); break; } catch { /* next */ }
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    profile = { athlete_name: "the athlete", location: "their home mountains", home_trails: [] };
  }
  const { physiology, warnings } = normalizePhysiology(profile.physiology);
  return { profile: { ...profile, physiology }, warnings };
}

/**
 * Warnings already printed by this process. The scripts that read the profile
 * are one-shot, so in normal use this changes nothing — but loadFactsFromRoot
 * is called many times in one process (the coach's chat endpoint, and the
 * test suite), and repeating "body_kg is not set" on every call is noise that
 * trains the reader to skip it. Same rule as the nutrition loader's one-time
 * note on a legacy body_kg.
 *
 * It is not merely cosmetic: the volume of interleaved child-process writes
 * this produced was enough to intermittently corrupt `node --test`'s message
 * framing ("Unable to deserialize cloned data"), failing a test file that has
 * nothing to do with profiles.
 */
const warned = new Set();

/** Forget what has been printed — for tests that assert on the warnings. */
export function resetProfileWarnings() {
  warned.clear();
}

/**
 * The plain loader every script uses. Each distinct warning is printed once
 * per process — the "documented default, announced" contract from the bead,
 * announced once rather than on every read.
 */
export async function loadProfile(projectRoot) {
  const { profile, warnings } = await loadProfileWithWarnings(projectRoot);
  for (const w of warnings) {
    if (warned.has(w)) continue;
    warned.add(w);
    console.warn(`⚠︎ ${w}`);
  }
  return profile;
}
