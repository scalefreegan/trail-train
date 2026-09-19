// Athlete goals for generic mode (PRD §5.3). With no race active, this file
// is what the coach trains the athlete toward: an event class to stay ready
// for, a phase, and the weekly volume band the rolling 12-week window is
// measured against.
//
// config/goals.json is gitignored (it names real injuries and dates); the
// committed config/goals.example.json is the template every fresh checkout
// bootstraps from, always into phase "maintain" — a checkout must never
// inherit somebody else's "peak".

import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./lib.mjs";
import { GOAL_PHASES } from "./contracts.mjs";

// The settings dialog and the settings PUT validate against the same list —
// see scripts/contracts.mjs. Re-exported so every existing import site
// (`from "./goals.mjs"`) keeps working.
export { GOAL_PHASES };

/** The phase a bootstrapped goals.json starts in — see the file header. */
export const BOOTSTRAP_PHASE = "maintain";

/** Last-resort goals when neither goals.json nor the example is readable. */
const FALLBACK_GOALS = {
  event_class: "trail ultra",
  horizon: "no race scheduled",
  phase: BOOTSTRAP_PHASE,
  weekly_volume_band: { dist_mi: [0, 30], vert_ft: [0, 4000] },
  notes: "",
};

/** config/goals.json — gitignored; the athlete's real goals. */
export function goalsPath(root) {
  return path.join(root, "config", "goals.json");
}

/** config/goals.example.json — committed; the bootstrap template. */
export function goalsExamplePath(root) {
  return path.join(root, "config", "goals.example.json");
}

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNonNegNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Validate a parsed goals.json against PRD §5.3. Collects every problem
 * rather than throwing on the first — the settings dialog shows the list.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateGoals(obj) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!isObj(obj)) return { ok: false, errors: ["goals.json must be a JSON object"] };

  if (!isStr(obj.event_class) || !obj.event_class.trim()) bad("event_class: non-empty string required");
  if (obj.horizon !== undefined && !isStr(obj.horizon)) bad("horizon: string required");
  if (!GOAL_PHASES.includes(obj.phase)) {
    bad(`phase must be one of ${GOAL_PHASES.join(" | ")} (got ${JSON.stringify(obj.phase)})`);
  }
  if (obj.notes !== undefined && !isStr(obj.notes)) bad("notes: string required");

  const band = obj.weekly_volume_band;
  if (!isObj(band)) {
    bad("weekly_volume_band: object with dist_mi and vert_ft required");
  } else {
    // Both bands are [lo, hi]: the rolling window's targets are their
    // midpoints, so a reversed or negative pair would silently produce a
    // nonsense target rather than an error the athlete can see.
    for (const key of ["dist_mi", "vert_ft"]) {
      const pair = band[key];
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(isNonNegNum)) {
        bad(`weekly_volume_band.${key}: [lo, hi] pair of non-negative numbers required`);
      } else if (pair[0] > pair[1]) {
        bad(`weekly_volume_band.${key}: lo ${pair[0]} is above hi ${pair[1]}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The midpoint of a [lo, hi] band — the rolling window's weekly target. */
export function bandMidpoint(pair) {
  return Array.isArray(pair) && pair.length === 2 ? (pair[0] + pair[1]) / 2 : 0;
}

async function readJsonIfPresent(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${p} is not readable as JSON: ${e.message}`);
  }
}

/**
 * Read config/goals.json, bootstrapping it from the example on first run.
 * An invalid file is surfaced (`errors`) rather than replaced — the athlete
 * hand-edits this, and silently overwriting a typo would lose their prose.
 * @returns {Promise<{goals: object, path: string, bootstrapped: boolean, errors: string[]}>}
 */
export async function loadGoals(root) {
  const p = goalsPath(root);
  const existing = await readJsonIfPresent(p);
  if (existing) {
    const { errors } = validateGoals(existing);
    return { goals: existing, path: p, bootstrapped: false, errors };
  }
  const example = await readJsonIfPresent(goalsExamplePath(root)).catch(() => null);
  // Always "maintain", whatever the example says: a fresh checkout has no
  // business claiming a training phase nobody chose.
  const goals = { ...FALLBACK_GOALS, ...(example ?? {}), phase: BOOTSTRAP_PHASE };
  await writeJsonAtomic(p, goals);
  return { goals, path: p, bootstrapped: true, errors: validateGoals(goals).errors };
}

/**
 * Write config/goals.json. Rejects invalid goals — this is the settings
 * dialog's write path, and a bad phase would break the coach prompt.
 * @returns {Promise<string>} the path written
 */
export async function saveGoals(root, goals) {
  const { ok, errors } = validateGoals(goals);
  if (!ok) throw new Error(`invalid goals: ${errors.join("; ")}`);
  const p = goalsPath(root);
  await writeJsonAtomic(p, goals);
  return p;
}
