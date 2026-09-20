// GET /api/race/active's body, assembled outside the dev server so it can be
// unit-tested and so it cannot drift from scripts/facts.mjs: both describe
// "what is the athlete training for" from the same loaders, and in generic
// mode from the same rollingBlock(). The client is otherwise the one reader
// that would have to re-derive the 12-week window itself.
//
// Two questions, one payload (PRD §4, §7):
//   `active`  — the training target. null unless the pointer is in train mode
//               on a folder with status "active". facts.mjs answers it from
//               the same loadActiveRaceFolder, so the coach and the dashboard
//               cannot disagree about what is being trained for.
//   `viewing` — the folder ON SCREEN. Equal to `active` in train mode; in
//               view mode it is an archived or draft folder being browsed
//               read-only, and then `training` carries the goals-based
//               context the coach is actually working from, so the rail can
//               say so instead of implying the browsed race is the target.

import fs from "node:fs/promises";
import path from "node:path";

import { bRacesFor, listRaces, resolveViewedRace } from "./race-config.mjs";
import { loadPlanBlocks } from "./state.mjs";
import { loadGoals } from "./goals.mjs";
import { rollingBlock } from "./block.mjs";
import { computeDaysUntilRace } from "./facts.mjs";
import { deriveArrival } from "./acclimation.mjs";

/**
 * The calendar snapshot, or null. Absent is the normal state of a machine
 * that has never run `sync:google`, and an unreadable one must not take the
 * race payload down — deriveArrival degrades to its day-before default and
 * says "default" on the planner, which is exactly the honest answer.
 */
async function loadCalendar(root) {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "web", "public", "google-cal.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} root  project root
 * @param {number} [now] "now" in ms, injectable for tests
 * @returns {Promise<{
 *   active: string|null, mode: "train"|"view", viewing: string|null,
 *   race: object|null, goals: object|null, block: object|null,
 *   plan: {plan_blocks: object[]}, nutrition: object|null,
 *   training: {goals: object|null, block: object|null, plan: {plan_blocks: object[]}}|null,
 *   b_races: {slug, name, date, distance_mi, gain_ft, weeks_out}[],
 *   acclimation?: {arrival_date: string|null, days_at_altitude: number,
 *                  source: "calendar"|"default"|"override", matched_event?: object},
 *   warning?: string }>}
 */
export async function activeRacePayload(root, now = Date.now()) {
  // A dangling or unreadable pointer degrades to generic mode with a warning
  // rather than a 500 — same tolerance as facts.mjs's trainingContext(). The
  // dashboard staying up on a broken local config matters more than surfacing
  // it as an outage.
  let warning = null;
  const viewed = await resolveViewedRace(root).catch((e) => {
    warning = `active race unreadable (${e.message}) — showing generic mode`;
    return { slug: null, mode: "train", folder: null, training: false };
  });
  // Where the agent's plan lives follows the TRAINING target, exactly as
  // state.mjs's planBlocksPath decides it — so the client and the coach read
  // the same plan.json in every case, and browsing an archived race shows the
  // generic plan rather than that race's finished one.
  const { plan_blocks } = await loadPlanBlocks(root);
  const withWarning = (payload) => (warning ? { ...payload, warning } : payload);

  // Generic mode: no folder, or a pointer whose folder is neither active nor
  // being viewed on purpose (a hand-edited pointer at a draft in train mode).
  if (!viewed.folder || (!viewed.training && viewed.mode === "train")) {
    const { goals } = await loadGoals(root).catch(() => ({ goals: null }));
    return withWarning({
      active: null,
      mode: "train",
      viewing: null,
      race: null,
      goals,
      block: rollingBlock(goals, plan_blocks, now),
      plan: { plan_blocks },
      nutrition: null,
      training: null,
      // Tune-ups hang off an A RACE's block (PRD-v2 §3). With no race being
      // trained for there is nothing for one to sit inside, so this is empty
      // rather than absent — the key is always there, and a client that maps
      // over it never has to null-check the mode first.
      b_races: [],
    });
  }

  const folder = viewed.folder;
  // block.json, tagged so the client can discriminate without inspecting
  // fields. A draft folder with no block.json has none — the client falls
  // back to an empty plan rather than inventing a window inside a race.
  const block = folder.block ? { mode: "race", ...folder.block } : null;

  if (viewed.training) {
    const daysUntil = computeDaysUntilRace(folder.race, now);
    // When the athlete gets to altitude (PRD-v2 §2). Derived HERE rather
    // than in the client because the travel events live in a file the client
    // would otherwise have to fetch and re-classify, and because facts.mjs
    // hands the coach the same number from the same function. The planner's
    // manual override is applied on top, client-side, per slug — the server
    // reports what the calendar says and the athlete overrules it.
    const acclimation = deriveArrival({
      race: folder.race,
      calendar: await loadCalendar(root),
      today: new Date(now).toISOString(),
    });
    // The tune-ups entered inside THIS race's block, oldest first, each with
    // the weeks between it and race day (scripts/race-config.mjs's
    // bRacesFor — facts.mjs reads the same function, so the dashboard's
    // markers and the coach's list can never be different races). A races/
    // that cannot be read is not worth taking the dashboard down for: the
    // race itself already loaded.
    const b_races = bRacesFor(
      await listRaces(root).catch((e) => {
        warning = warning ?? `races/ unreadable (${e.message}) — tune-up races omitted`;
        return [];
      }),
      { ...folder.race, slug: folder.slug },
    );
    return withWarning({
      active: folder.slug,
      mode: "train",
      viewing: folder.slug,
      race: folder.race,
      // goals only steer generic mode; with a race active the race IS the
      // goal, and a stale goals file beside it would read as a second target.
      goals: null,
      block,
      plan: { plan_blocks },
      nutrition: folder.nutrition ?? null,
      training: null,
      // The race-day view used to keep projecting a finish time against an
      // active race whose date had already gone by (PR #23 review round 1,
      // resilience finding 12) — days_until goes negative once race day is
      // over, and `past` is the client's cue to show "race day has passed"
      // instead of a pace projection nobody is running anymore.
      days_until: daysUntil,
      past: typeof daysUntil === "number" && daysUntil < 0,
      acclimation,
      b_races,
    });
  }

  // View mode: the folder is furniture to browse — its course, its block, its
  // own plan.json, its fueling — while the athlete is training for nothing in
  // particular (or for goals). `active` stays null so every gate that means
  // "is there a race to train for" keeps answering no, and `training` carries
  // the real window so the training view and the coach rail don't have to
  // fetch it a second time.
  const { goals } = await loadGoals(root).catch(() => ({ goals: null }));
  return withWarning({
    active: null,
    mode: "view",
    viewing: folder.slug,
    race: folder.race,
    goals: null,
    block,
    // the VIEWED folder's plan, not the athlete's: this is the block that was
    // (or would be) run for this race.
    plan: { plan_blocks: folder.plan?.plan_blocks ?? [] },
    nutrition: folder.nutrition ?? null,
    training: {
      goals,
      block: rollingBlock(goals, plan_blocks, now),
      plan: { plan_blocks },
    },
    // View mode is by definition not training for anything (the pointer's
    // mode, not the folder's status, decides that) — so there is no A-race
    // block for a tune-up to belong to. See the generic branch above.
    b_races: [],
  });
}
