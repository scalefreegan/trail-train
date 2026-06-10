// Persistent agentic state for Trail Almanac.
//
// One JSON file at web/public/state.json is the source of truth for everything
// that should survive across syncs and server restarts:
//   - race meta (name, date, distance, elevation, location)
//   - 20-week block targets (planned weekly miles + vert)
//   - the agent's current plan_blocks (6 upcoming weeks of focus + key sessions)
//   - agent's persistent notes (observations the coach has made and wants
//     to remember between sessions)
//   - athlete-set preferences (training philosophy, constraints)
//
// On first run, bootstrapped from DEFAULT_STATE. The coach reads this,
// passes it to the agent as context, and MERGES the agent's response back
// (plan_blocks + new notes) — the agent never overwrites the whole file,
// which prevents accidental data loss if it returns malformed output.

import fs from "node:fs/promises";
import path from "node:path";

export const STATE_VERSION = 1;

// Defaults used to bootstrap a fresh state.json. Editable in the file once
// it's been created — the file becomes the source of truth.
export const DEFAULT_STATE = {
  version: STATE_VERSION,
  last_updated: null,
  race: {
    name: "Mogollon Monster 100",
    short: "MM100",
    date: "2026-09-12",
    distance_mi: 102.3,
    elevation_ft: 15900,
    max_elev_ft: 7912,
    cutoff_h: 38,
    location: "Mogollon Rim · Pine, AZ (90 min NE of Phoenix)",
    notes: "Climbs the rim 6×. Technical sections on Highline / Donahue / Myrtle / Promontory. September can run 80°F+ in the canyons.",
  },
  block: {
    start_date: "2026-04-27",
    total_weeks: 20,
    targets: [
      { wk: 1,  target_dist: 38, target_elev: 5800 },
      { wk: 2,  target_dist: 46, target_elev: 7400 },
      { wk: 3,  target_dist: 52, target_elev: 8900 },
      { wk: 4,  target_dist: 36, target_elev: 5400 },
      { wk: 5,  target_dist: 54, target_elev: 9500 },
      { wk: 6,  target_dist: 60, target_elev: 10800 },
      { wk: 7,  target_dist: 55, target_elev: 9800 },
      { wk: 8,  target_dist: 62, target_elev: 11200 },
      { wk: 9,  target_dist: 38, target_elev: 5800 },
      { wk: 10, target_dist: 70, target_elev: 13400 },
      { wk: 11, target_dist: 78, target_elev: 14600 },
      { wk: 12, target_dist: 72, target_elev: 13200 },
      { wk: 13, target_dist: 42, target_elev: 6100 },
      { wk: 14, target_dist: 68, target_elev: 12400 },
      { wk: 15, target_dist: 58, target_elev: 9400 },
      { wk: 16, target_dist: 52, target_elev: 8200 },
      { wk: 17, target_dist: 42, target_elev: 6200 },
      { wk: 18, target_dist: 30, target_elev: 4200 },
      { wk: 19, target_dist: 18, target_elev: 2400 },
      { wk: 20, target_dist: 102.3, target_elev: 15900 },
    ],
  },
  // Agent-managed: current 6-week plan with focus + key session for each
  // upcoming week. Reset only when the block restructure justifies it.
  plan_blocks: [],
  // Agent-managed: a running list of observations the coach has made and
  // wants to remember (e.g. "heat block needs to start by wk 10").
  // Capped at 30 most recent on save.
  agent_notes: [],
  // Athlete-set, edit in the file directly. The agent reads these but
  // shouldn't modify.
  preferences: {
    training_philosophy: "polarized — easy aerobic + occasional hard, minimize tempo",
    weekly_rest_day: "Mon",
    nutrition_target_kcal_per_hour: 300,
    heat_threshold_c: 24,
    // Plain-English constraints the agent must respect when proposing
    // sessions. Each entry can reference calendar keywords (event titles
    // containing "X"), date patterns, time windows, anything. The coach
    // is instructed to treat these as hard constraints.
    // Example:
    //   "Events with 'Family' on the calendar block long training during the day —
    //    schedule long runs early morning before, or move to another day."
    personal_constraints: [],
  },
};

function statePath(projectRoot) {
  return path.join(projectRoot, "web", "public", "state.json");
}

/**
 * Load state.json from web/public/, bootstrapping it from DEFAULT_STATE
 * the first time. Always returns a valid state object.
 */
export async function loadState(projectRoot) {
  const p = statePath(projectRoot);
  try {
    const buf = await fs.readFile(p, "utf8");
    const state = JSON.parse(buf);
    if (state.version !== STATE_VERSION) {
      console.warn(`• state.json version ${state.version} ≠ ${STATE_VERSION}; using as-is`);
    }
    return state;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  // bootstrap
  const fresh = { ...DEFAULT_STATE, last_updated: new Date().toISOString() };
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(fresh, null, 2));
  console.log(`• bootstrapped ${p} from defaults`);
  return fresh;
}

/**
 * Save state.json atomically (write-then-rename to avoid corruption mid-write).
 */
export async function saveState(projectRoot, state) {
  const p = statePath(projectRoot);
  const next = { ...state, last_updated: new Date().toISOString() };
  // cap agent_notes to last 30
  if (Array.isArray(next.agent_notes) && next.agent_notes.length > 30) {
    next.agent_notes = next.agent_notes.slice(-30);
  }
  const tmp = p + `.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2));
  await fs.rename(tmp, p);
  return next;
}

/**
 * Merge an agent's update into the loaded state.
 * - plan_blocks: replace with agent's version if non-empty
 * - agent_notes: append the agent's new notes (with timestamps)
 * - everything else: untouched (agent can't accidentally clobber)
 */
export function mergeAgentUpdate(state, update) {
  const next = { ...state };
  if (Array.isArray(update?.plan_blocks) && update.plan_blocks.length > 0) {
    next.plan_blocks = update.plan_blocks;
  }
  if (Array.isArray(update?.new_notes) && update.new_notes.length > 0) {
    const ts = new Date().toISOString();
    const dated = update.new_notes
      .filter((n) => typeof n === "string" && n.trim())
      .map((note) => ({ at: ts, note: note.trim() }));
    next.agent_notes = [...(state.agent_notes ?? []), ...dated];
  }
  return next;
}
