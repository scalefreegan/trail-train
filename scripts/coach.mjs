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

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadFactsFromRoot } from "./facts.mjs";
import { saveState, mergeAgentUpdate } from "./state.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_PATH = path.join(ROOT, "web", "public", "coach.json");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}
const MAX_TURNS = Number(arg("max-turns", 8));
const TIMEOUT   = Number(arg("timeout",  240));


/* -------- Claude Code CLI subprocess (pattern from agent-trade) -------- */

const SYSTEM_PROMPT_TEMPLATE = (profile) => `You are the coach inside Trail Almanac, a personal ultra-training dashboard.

The athlete is ${profile.athlete_name}, training for the Mogollon Monster 100 (102.3 mi, 15,900 ft, Sept 12, 2026).
They live in ${profile.location}. Local training trails: ${(profile.home_trails || []).join(", ") || "their home mountains"}.

You will be given the path to a JSON facts file built from their Strava activities, Oura ring
data, weather conditions during each run, Google Calendar events (next 14 days under
facts.calendar.upcoming_14d; schedule-shaping events over the full ~30-day window — trips,
races, recurring family commitments like weekend kid sports — under
facts.calendar.upcoming_notable), and their planned 20-week training block. You may also read
the underlying snapshots at web/public/strava.json, web/public/oura.json,
web/public/google-cal.json, and web/public/state.json for additional context if useful.

Use the calendar for schedule realism — when proposing a key session for next week, check
whether the athlete has travel, a race, or a long work block on the candidate day. If a
travel day or evening race appears, work around it (move long run earlier, deload the day
after a flight, etc.). When writing plan_blocks weeks ahead, check upcoming_notable for
multi-day travel spans and recurring weekend commitments — a week overlapping a trip must
be planned as what it really is (travel maintenance, whatever terrain the destination
offers), never as a build week, and weekend key sessions must clear recurring family
events (note the timing workaround explicitly).

The athlete's preferences.personal_constraints (plain-English rules they've set) are HARD
constraints. Every proposed session must respect them. Scan upcoming_14d and upcoming_notable
against each constraint before locking in a key_session — e.g. if a constraint says events
with "X" block long-run timing on weekends, do not schedule a long-run key_session on a
day with an "X" event without explicitly noting the workaround (e.g. "5:30am start to
finish before Em event").

Persistent state lives in web/public/state.json — you already see its key contents in the facts
file (plan_blocks, agent_notes, preferences). Treat the EXISTING plan_blocks as the prior plan.
Do not regenerate from scratch every run — keep what still makes sense, only revise blocks
where new data justifies a change. If the current plan still fits the picture, return it
mostly unchanged.

When done, respond with ONLY a single JSON object — no prose outside, no markdown fences:

{
  "summary": "150-250 words. Plain English. Reference SPECIFIC numbers (HRV ms, RHR delta, ACR ratio, miles, vert, run temps in °F). Tie load, recovery, heat exposure, and block progress together. Calm, direct ultrarunner-coach voice. Address the athlete in second person.",
  "watch_outs": ["short bullet quoting numbers", ...],     // 0-4 items
  "recommendations": ["actionable bullet w/ specific session/day", ...],   // 2-5 short-horizon items (next 14 days)
  "plan_blocks": [                                          // 6 upcoming weeks, starting from current_week+1. KEEP prior plan unless data justifies a change.
    {
      "wk": 6,                                              // training-block week number (1..total_weeks)
      "label": "Specific endurance",                        // 1-3 word block theme
      "dist_mi": 60,                                        // planned miles for the week (you may adjust from target if recovery/load suggests it)
      "elev_ft": 10800,                                     // planned vert (ft)
      "focus": "8-12 word coaching focus for the week",     // strategic intent, e.g. "B2B long w/ rim-specific vert; heat block starts"
      "key_session": "Sat 16-18 mi / 3,500 ft on home long-route trail, fuel @ 300 kcal/h",  // the one signal workout
      "quality": 2                                          // # of quality (non-easy) sessions, 1-3
    },
    ...
  ],
  "new_notes": ["concise observation worth remembering across sessions", ...]   // 0-3 items — appended to agent_notes in state.json
}

Rules:
- Every claim anchored in the data. Quote real numbers.
- If a metric is null, say so — don't fabricate.
- Imperial units (miles, feet) for run data; Fahrenheit for temperatures. Use 24h time.
- No emojis. No platitudes. Direct, specific, useful.
- The course climbs the rim 6×, max elev 7,912 ft. Heat / altitude / technical descent are the real wildcards.

For plan_blocks:
- Start at current_week + 1 and emit exactly 6 blocks (or fewer if fewer remain before race week 20).
- The base targets are in block.weekly_target. Prior agent decisions are in state.plan_blocks.
  PREFER continuity — keep prior blocks if they still hold up; revise only what new data
  justifies. State your reason in summary or new_notes when you change something.
- Reflect Mogollon-specific prep: heat block in the build-out, course rec near peak, taper
  proportional, race week = wk 20.
- key_session should name a real home trail when possible (see local trails list above).

For new_notes:
- Persist insights that should survive across sessions: course-specific observations,
  long-arc trends (e.g. "wk 4–6 vert bias has worked, keep that ratio"), constraints the
  athlete has communicated. Existing agent_notes are visible in the facts file — don't
  duplicate them. Empty array is fine if there's nothing new worth persisting.`;

function runClaude({ prompt, systemPrompt, maxTurns, timeoutSec, cwd, allowedTools }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--max-turns", String(maxTurns),
    ];
    for (const t of allowedTools) args.push("--allowedTools", t);
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

    const proc = spawn("claude", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => {
      try { process.kill(-proc.pid, "SIGKILL"); } catch {}
      reject(new Error(`claude timed out after ${timeoutSec}s`));
    }, timeoutSec * 1000);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}\nstderr: ${stderr.slice(0, 800)}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

function extractJson(text) {
  const tryParse = (s) => {
    const v = JSON.parse(s);
    if (typeof v !== "object" || v === null) throw new Error("not an object");
    return v;
  };
  // direct
  try { return tryParse(text); } catch {}
  // fenced ```json ... ``` (anywhere)
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) { try { return tryParse(fence[1]); } catch {} }
  // first bare {
  const i = text.indexOf("{");
  if (i >= 0) { try { return tryParse(text.slice(i)); } catch {} }
  throw new Error(`agent returned non-JSON: ${text.slice(0, 240)}`);
}

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

  const prompt = `Today is ${facts.today}. Read the training facts at:
  ${factsPath}

You may also Read web/public/strava.json and web/public/oura.json for raw detail if a number
in the facts file needs verifying or you want to look at specific recent sessions.

Produce the JSON coach readout per the schema in the system prompt. Be specific about the
next 14 days for ${facts.race.name} (${facts.race.days_until} days out). Anchor every claim
in real numbers from the data.`;

  console.log(`• spawning claude -p (max-turns ${MAX_TURNS}, timeout ${TIMEOUT}s)…`);
  const t0 = Date.now();
  const { stdout } = await runClaude({
    prompt,
    systemPrompt: SYSTEM_PROMPT_TEMPLATE(facts.profile || {}),
    maxTurns: MAX_TURNS,
    timeoutSec: TIMEOUT,
    cwd: ROOT,
    allowedTools: ["Read"],
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // `claude -p --output-format json` wraps as { type, result, ... }
  let wrapper;
  try { wrapper = JSON.parse(stdout); }
  catch (e) {
    throw new Error(`malformed wrapper from claude: ${stdout.slice(0, 240)}`);
  }
  const agentText = (wrapper && wrapper.result) ? wrapper.result : stdout;
  const numTurns = wrapper?.num_turns ?? null;
  const cost = wrapper?.total_cost_usd ?? null;

  const readout = extractJson(agentText);

  const payload = {
    generated_at: new Date().toISOString(),
    model: "claude-code · headless",
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

  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2));
  await fs.unlink(factsPath).catch(() => {});

  // Merge agent updates into persistent state.json (plan_blocks + new_notes).
  // The agent does NOT overwrite state directly; this script controls writes
  // so a malformed agent response can't corrupt persistent state.
  if (facts.state) {
    const merged = mergeAgentUpdate(facts.state, readout);
    const saved = await saveState(ROOT, merged);
    const prevCount = facts.state.plan_blocks?.length ?? 0;
    const newCount = saved.plan_blocks?.length ?? 0;
    const notesDelta = (saved.agent_notes?.length ?? 0) - (facts.state.agent_notes?.length ?? 0);
    console.log(`✓ merged into state.json  (plan_blocks ${prevCount}→${newCount}, +${notesDelta} note${notesDelta === 1 ? "" : "s"})`);
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

main().catch((e) => { console.error("\n✗", e.message || e); process.exit(1); });
