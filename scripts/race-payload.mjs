// GET /api/race/active's body, assembled outside the dev server so it can be
// unit-tested and so it cannot drift from scripts/facts.mjs: both describe
// "what is the athlete training for" from the same loaders, and in generic
// mode from the same rollingBlock(). The client is otherwise the one reader
// that would have to re-derive the 12-week window itself.

import { loadActiveRaceFolder } from "./race-config.mjs";
import { loadPlanBlocks } from "./state.mjs";
import { loadGoals } from "./goals.mjs";
import { rollingBlock } from "./block.mjs";

/**
 * @param {string} root  project root
 * @param {number} [now] "now" in ms, injectable for tests
 * @returns {Promise<{
 *   active: string|null, race: object|null, goals: object|null,
 *   block: object|null, plan: {plan_blocks: object[]},
 *   nutrition: object|null, warning?: string }>}
 */
export async function activeRacePayload(root, now = Date.now()) {
  // A dangling or unreadable pointer degrades to generic mode with a warning
  // rather than a 500 — same call and same tolerance as facts.mjs's
  // trainingContext(). The dashboard staying up on a broken local config
  // matters more than surfacing it as an outage.
  let warning = null;
  const folder = await loadActiveRaceFolder(root).catch((e) => {
    warning = `active race unreadable (${e.message}) — showing generic mode`;
    return null;
  });
  // Where the agent's plan lives follows the POINTER, not the folder's
  // status, exactly as state.mjs's planBlocksPath decides it — so the client
  // and the coach read the same plan.json in every case.
  const { plan_blocks } = await loadPlanBlocks(root);

  if (!folder) {
    const { goals } = await loadGoals(root).catch(() => ({ goals: null }));
    const payload = {
      active: null,
      race: null,
      goals,
      block: rollingBlock(goals, plan_blocks, now),
      plan: { plan_blocks },
      nutrition: null,
    };
    return warning ? { ...payload, warning } : payload;
  }

  return {
    active: folder.slug,
    race: folder.race,
    // goals only steer generic mode; with a race active the race IS the goal,
    // and a stale goals file beside it would read as a second target.
    goals: null,
    // block.json, tagged so the client can discriminate without inspecting
    // fields. A draft folder with no block.json has none — the client falls
    // back to an empty plan rather than inventing a window inside a race.
    block: folder.block ? { mode: "race", ...folder.block } : null,
    plan: { plan_blocks },
    nutrition: folder.nutrition ?? null,
  };
}
