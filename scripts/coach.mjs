#!/usr/bin/env node
// Headless Claude coach — runs the local Claude Code CLI in `-p` mode.
// Uses your Claude Code subscription (NO API key needed). Pattern lifted
// from agent-trade/src/agent_trade/claude_wrapper.py.
//
// Flow:
//   1. Read strava.json + oura.json snapshots from web/public/
//   2. Compute deterministic facts (acute:chronic, HRV drift, block delta...)
//   3. Write the facts to a temp JSON file
//   4. Spawn `claude -p ...` with Read tool allowed; agent reads the
//      facts + raw snapshots and produces a structured JSON readout
//   5. Extract the JSON, write web/public/coach.json
//
// Usage:  node scripts/coach.mjs [--max-turns 8] [--timeout 240]
//         node scripts/coach.mjs --print-prompt [path]        (dry run, no session)
//         node scripts/coach.mjs --print-chat-prompt [path]   (the chat endpoint's prompt)

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadFactsFromRoot } from "./facts.mjs";
import { loadState, saveState, mergeAgentUpdate } from "./state.mjs";
import { arg, writeJsonAtomic } from "./lib.mjs";
import { runClaudeJson, extractJson } from "./agent-run.mjs";
import { COACH_MODEL, coachFocus, readoutSystemPrompt, chatSystemPrompt } from "./coach-prompt.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_PATH = path.join(ROOT, "web", "public", "coach.json");

// Turn budget. The agent runs Read-only against snapshots far larger than one
// Read returns (oura.json ~5k lines, strava.json ~4.5k, google-cal.json ~2.2k;
// Read truncates at 2000), so a single file can cost three turns and a budget
// below ~12 gets spent paging before the readout is written — the CLI then
// exits nonzero with subtype `error_max_turns` and no result at all.
// Measured 2026-08-23 on the chat path against the same snapshots: 11 turns
// and 134 s for a two-file question. The timeout has to scale with the turns
// or one failure mode simply replaces the other.
const MAX_TURNS = Number(arg("max-turns", 16));
const TIMEOUT   = Number(arg("timeout",  300));
// Model for the headless CLI. Pinned rather than inherited: without --model
// the CLI silently uses whatever ~/.claude/settings.json happens to say, so
// the readout's provenance depends on an unrelated global setting.
// The default lives in scripts/coach-prompt.mjs, which the chat endpoint
// imports too, so the two coach paths cannot drift onto different models.
// arg() returns boolean true for a valueless flag (`--model`, or `--model
// --timeout 5`), which String()'d to "true" and got spawned as an unknown
// model. Fall back rather than pass a value the CLI is guaranteed to reject.
// Only this file also honours --model; the endpoints have no CLI to read one from.
// Re-exported so a test can compare it against the endpoint's without a CLI.
export const MODEL_DEFAULT = COACH_MODEL;
const MODEL_ARG = arg("model", null);
const MODEL = typeof MODEL_ARG === "string" && MODEL_ARG.trim() ? MODEL_ARG.trim() : MODEL_DEFAULT;
// Narrative units for the readout — "metric" (default) or "imperial".
// Passed by the dashboard's resync endpoint from the live UI toggle, or
// set manually: `node scripts/coach.mjs --units imperial`.
const UNITS = String(arg("units", process.env.TRAIL_UNITS || "metric")) === "imperial" ? "imperial" : "metric";
// Dry run: assemble the facts and both prompts, write them out, spawn nothing.
// A headless session costs real money and a usage slot, so reviewing a prompt
// change must not require paying for one.
//   node scripts/coach.mjs --print-prompt [path]
const PRINT_PROMPT = arg("print-prompt", null);
// Same dry run for the CHAT system prompt, which the dev server assembles at
// request time from the same module. Printing it here is the only way to
// review a chat-prompt change without opening a (paid) chat session.
//   node scripts/coach.mjs --print-chat-prompt [path]
const PRINT_CHAT_PROMPT = arg("print-chat-prompt", null);


/* -------- Claude Code CLI subprocess -------- */
// The spawn, the watchdog and the failure classification live in
// scripts/agent-run.mjs — shared with the chat endpoint and the race intake,
// which hit exactly the same auth / usage-limit / turn-budget failures.

async function main() {
  console.log("• computing facts from snapshots…");
  let facts;
  try {
    facts = await loadFactsFromRoot(ROOT);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  if (!facts.recovery) console.warn("• oura.json missing — agent will reason on strava alone");
  const factsPath = path.join(os.tmpdir(), `trail-facts-${Date.now()}.json`);
  await fs.writeFile(factsPath, JSON.stringify(facts, null, 2));
  const focus = coachFocus(facts);
  console.log(facts.race
    ? `• race: ${facts.race.name} (${facts.race.days_until} days out)`
    : `• no active race — coaching toward the goals in config/goals.json (phase ${facts.goals?.phase ?? "unset"})`);

  const prompt = `Today is ${facts.today}. Read the training facts at:
  ${factsPath}

The facts file already contains, in full: recovery.nights (the last 21 nights individually
— sleep hours, sleep score, readiness, HRV, RHR — with unrecorded nights OMITTED rather
than zeroed, and nights_recorded_d7 giving the denominator for the weekly sleep total),
recent_runs (last 14 with vert, HR, pace and weather), calendar, block, load, pacing,
plan_blocks, agent_notes and preferences. Write the readout from it.

You may also Read web/public/strava.json and web/public/oura.json for raw detail the digest
genuinely lacks — a session older than the last 14, a night older than 21 days. Do so
sparingly: you have a hard turn limit, those snapshots run to thousands of lines and take
several reads to page through, and being cut off before you write the readout is worse
than a readout built from the facts digest alone. Read the slice you need with
offset/limit rather than the whole file, and stop as soon as you can write.

Produce the JSON coach readout per the schema in the system prompt. Be specific about the
next 14 days ${focus.user_horizon}. Anchor every claim in real numbers from the data.`;

  const promptOpts = { units: UNITS, hasPacing: Boolean(facts.pacing), root: ROOT };
  const systemPrompt = readoutSystemPrompt(facts, facts.profile || {}, promptOpts);
  if (PRINT_PROMPT) {
    const out = typeof PRINT_PROMPT === "string"
      ? PRINT_PROMPT
      : path.join(os.tmpdir(), `trail-coach-prompt-${Date.now()}.txt`);
    await fs.writeFile(out, `===== SYSTEM PROMPT =====\n${systemPrompt}\n\n===== USER PROMPT =====\n${prompt}\n`);
    console.log(`✓ wrote the assembled prompt to ${out} (facts: ${factsPath}) — no session spawned`);
  }
  if (PRINT_CHAT_PROMPT) {
    // The endpoint passes the live temp paths; the dry run passes this run's
    // facts file and the real coach.json so the printed text is what a chat
    // turn would actually see.
    const chatPrompt = chatSystemPrompt(facts, facts.profile || {}, {
      ...promptOpts,
      factsPath,
      coachPath: OUT_PATH,
    });
    const out = typeof PRINT_CHAT_PROMPT === "string"
      ? PRINT_CHAT_PROMPT
      : path.join(os.tmpdir(), `trail-chat-prompt-${Date.now()}.txt`);
    await fs.writeFile(out, `===== CHAT SYSTEM PROMPT =====\n${chatPrompt}\n`);
    console.log(`✓ wrote the assembled chat prompt to ${out} (facts: ${factsPath}) — no session spawned`);
  }
  if (PRINT_PROMPT || PRINT_CHAT_PROMPT) return;

  console.log(`• spawning claude -p (model ${MODEL}, max-turns ${MAX_TURNS}, timeout ${TIMEOUT}s)…`);
  const t0 = Date.now();
  if (!facts.pacing) console.warn("• facts.pacing null (< 8 usable runs) — agent will estimate durations without a pacing model");
  // runClaudeJson owns the watchdog and the auth / usage-limit / turn-budget
  // classification; anything it rejects with is already a sentence for a human.
  const { text: agentText, wrapper } = await runClaudeJson({
    prompt,
    systemPrompt,
    maxTurns: MAX_TURNS,
    timeoutSec: TIMEOUT,
    cwd: ROOT,
    model: MODEL,
    allowedTools: ["Read"],
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const numTurns = wrapper.numTurns;
  const cost = wrapper.costUsd;

  const readout = extractJson(agentText);

  const payload = {
    generated_at: new Date().toISOString(),
    model: `${MODEL} · claude-code headless`,
    elapsed_s: +elapsed,
    num_turns: numTurns,
    cost_usd: cost,
    facts_snapshot: {
      block_week: facts.block.current_week,
      acr_dist: facts.load.acr_dist,
      acr_elev: facts.load.acr_elev,
      hrv_d7: facts.recovery?.hrv_d7 ?? null,
      rhr_d7: facts.recovery?.rhr_d7 ?? null,
      readiness_d7: facts.recovery?.readiness_d7 ?? null,
    },
    ...readout,
  };
  // new_context_items is merge input for state.json, not readout content
  delete payload.new_context_items;

  await writeJsonAtomic(OUT_PATH, payload);
  await fs.unlink(factsPath).catch(() => {});

  // Merge agent updates into persistent state.json (plan_blocks + new_notes
  // + new_context_items). The agent does NOT overwrite state directly; this
  // script controls writes so a malformed agent response can't corrupt
  // persistent state. Re-load fresh rather than merging into facts.state:
  // that snapshot is minutes old (a settings save made during this run would
  // be clobbered) and its preferences are expiry-filtered (merging it back
  // would silently delete expired context items).
  if (facts.state) {
    const freshState = await loadState(ROOT);
    // Since v3 the plan_blocks land in the active race's plan.json (or
    // config/generic-plan.json), not state.json — mergeAgentUpdate writes
    // that file and reports where it went.
    const { state: merged, plan } = await mergeAgentUpdate(ROOT, freshState, readout);
    const saved = await saveState(ROOT, merged);
    const notesDelta = (saved.agent_notes?.length ?? 0) - (freshState.agent_notes?.length ?? 0);
    const ctxDelta = (saved.preferences?.context?.temporary?.length ?? 0) - (freshState.preferences?.context?.temporary?.length ?? 0);
    console.log(`✓ merged into state.json  (+${notesDelta} note${notesDelta === 1 ? "" : "s"}${ctxDelta > 0 ? `, +${ctxDelta} context item${ctxDelta === 1 ? "" : "s"}` : ""})`);
    console.log(`  plan_blocks ${plan.previous_count}→${plan.count} → ${path.relative(ROOT, plan.path)}${plan.written ? "" : " (unchanged)"}`);
  }

  console.log(`✓ wrote ${OUT_PATH}  (${elapsed}s · ${numTurns ?? "?"} turns${cost != null ? ` · $${cost.toFixed(4)}` : ""})`);
  console.log("\n" + (readout.summary || "").trim() + "\n");
  if (readout.watch_outs?.length) {
    console.log("watch-outs:");
    for (const w of readout.watch_outs) console.log(`  · ${w}`);
  }
  if (readout.recommendations?.length) {
    console.log("\nrecommendations:");
    for (const r of readout.recommendations) console.log(`  → ${r}`);
  }
}

// Only when run as a script: MODEL_DEFAULT is imported elsewhere (the tests
// that check both coach paths agree on a model), and importing this file must
// never spawn a paid session.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("\n✗", e.message || e); process.exit(1); });
}
