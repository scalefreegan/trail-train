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
//         node scripts/coach.mjs --print-prompt [path]   (dry run, no session)

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { loadFactsFromRoot } from "./facts.mjs";
import { loadState, saveState, mergeAgentUpdate } from "./state.mjs";
import { arg, writeJsonAtomic } from "./lib.mjs";
import { runClaudeJson, extractJson, agentModel } from "./agent-run.mjs";

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
// The default lives in scripts/agent-run.mjs so every spawn site agrees.
// arg() returns boolean true for a valueless flag (`--model`, or `--model
// --timeout 5`), which String()'d to "true" and got spawned as an unknown
// model. Fall back rather than pass a value the CLI is guaranteed to reject.
// Only this file also honours --model; the endpoints have no CLI to read one from.
const MODEL_DEFAULT = agentModel();
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


/* -------- Claude Code CLI subprocess -------- */
// The spawn, the watchdog and the failure classification live in
// scripts/agent-run.mjs — shared with the chat endpoint and the race intake,
// which hit exactly the same auth / usage-limit / turn-budget failures.

/**
 * The parts of the prompt that depend on WHAT the athlete is training for.
 *
 * With a race active that is the race and its block; in generic mode
 * (PRD §6) it is config/goals.json and a rolling window — so the race
 * paragraph becomes a goals paragraph and every "race week 20" style
 * instruction has to go with it. Exported so the chat prompt can share it
 * when the two prompts are merged (tt-yib.10).
 */
export function coachFocus(facts) {
  const block = facts?.block ?? {};
  const totalWeeks = block.total_weeks ?? 12;
  const race = facts?.race;
  const n = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : null);

  if (race) {
    const spec = [
      race.distance_mi != null ? `${n(race.distance_mi)} mi` : null,
      race.elevation_ft != null ? `${n(Math.round(race.elevation_ft))} ft` : null,
      race.date,
    ].filter(Boolean).join(", ");
    const days = race.days_until != null ? `, ${race.days_until} days out` : "";
    return {
      training_for: `They are training for ${race.name}${spec ? ` (${spec}${days})` : ""}${race.location ? `, ${race.location}` : ""}.`,
      block_phrase: `their planned ${totalWeeks}-week training block`,
      wk_comment: `training-block week number (1..${totalWeeks})`,
      plan_horizon: `(or fewer if fewer remain before race week ${totalWeeks})`,
      // the intake writes these; they are the only course prose the coach gets
      course_line: [race.notes, race.max_elev_ft != null ? `Max elevation ${n(Math.round(race.max_elev_ft))} ft.` : null]
        .filter(Boolean).join(" "),
      shape_line: `Reflect race-specific prep: the demands named above, a taper proportional to the distance, race week = wk ${totalWeeks}.`,
      user_horizon: `for ${race.name} (${race.days_until} days out)`,
      state_line: "the race (meta, block targets, the current plan_blocks) lives in races/<slug>/",
    };
  }

  const goals = facts?.goals ?? {};
  const band = goals.weekly_volume_band ?? {};
  const range = (pair, unit) =>
    Array.isArray(pair) && pair.length === 2 ? `${n(pair[0])}-${n(pair[1])} ${unit}` : `unset ${unit}`;
  const eventClass = goals.event_class || "no named event";
  return {
    training_for: `NO RACE IS ACTIVE — there is no date to count down to. They are training toward ${eventClass}${goals.horizon ? ` (${goals.horizon})` : ""}, currently in a "${goals.phase || "unset"}" phase, with a target weekly volume band of ${range(band.dist_mi, "mi")} and ${range(band.vert_ft, "ft")} of vert.${goals.notes ? ` Athlete's goals notes: ${goals.notes}` : ""} These goals (facts.goals) are the standing target; you may PROPOSE a change to the phase or the band in your summary, but the athlete accepts it in settings — never assume it.`,
    block_phrase: `a rolling ${totalWeeks}-week training window (facts.block.mode "rolling": wk ${totalWeeks} is the CURRENT week and wk 1 is ${totalWeeks - 1} weeks ago; weekly targets are the coach's own planned weeks where they exist, else the midpoint of the goals band)`,
    wk_comment: `week index in the rolling ${totalWeeks}-week window — wk ${totalWeeks} is the CURRENT week, so the weeks you plan ahead continue ${totalWeeks + 1}, ${totalWeeks + 2}, …`,
    plan_horizon: "(the window rolls forward one week at a time, so prior plan_blocks were indexed against LAST week's window — re-index them rather than assuming they line up)",
    course_line: "",
    shape_line: `There is no race week and no taper to build toward. Shape the six weeks to the current phase (${goals.phase || "unset"}) and keep each week inside the goals volume band — if the data justifies stepping outside it, say so explicitly and propose the band change.`,
    user_horizon: `toward ${eventClass}`,
    state_line: "the standing goals live in config/goals.json and the rolling plan_blocks in config/generic-plan.json",
  };
}

const SYSTEM_PROMPT_TEMPLATE = (profile, hasPacing, focus) => `You are the coach inside Trail Almanac, a personal ultra-training dashboard.

The athlete is ${profile.athlete_name}. ${focus.training_for}
They live in ${profile.location}. Local training trails: ${(profile.home_trails || []).join(", ") || "their home mountains"}.

You will be given the path to a JSON facts file built from their Strava activities, Oura ring
data, weather conditions during each run, Google Calendar events (next 14 days under
facts.calendar.upcoming_14d; schedule-shaping events over the full ~30-day window — trips,
races, recurring family commitments like weekend kid sports — under
facts.calendar.upcoming_notable), and ${focus.block_phrase}. You may also read
the underlying snapshots at web/public/strava.json, web/public/cross-train.json,
web/public/oura.json, web/public/google-cal.json, and web/public/state.json for additional
context if useful.

CROSS-TRAINING — facts.cross_training.recent lists the latest 20 non-run activities (rides,
hikes, strength, ski, …); facts.cross_training.count and .totals cover the FULL sync window,
so never infer absence from recent alone. These are EXCLUDED from every load
metric (d7/d28 distance and vert, ACR, weekly actuals vs targets, the pacing
model) — all of those count runs only. Use them
qualitatively: systemic fatigue and recovery cost, time-on-feet, and schedule load on the
days they occupy. Never add their mileage or vert into run-load arithmetic.

WEATHER FIELDS — every temperature is averaged (or maxed) across the run's actual duration,
not a daily figure. Per run (recent_runs): temp_avg_f = average air temp, temp_max_f = peak
air temp, apparent_avg_f = HEAT INDEX (feels-like: air temp + humidity + wind + sun),
humidity_avg = average relative humidity %. Aggregates (load): heat_avg_*_d7/d28 = air temp
averages, heat_index_avg_*_d7/d28 = heat-index averages, hot_runs_d28 = runs whose peak air
temp crossed heat_threshold. PREFER heat index over raw air temp when judging heat stress and
acclimation — a 70°F run at 95% humidity trains heat tolerance like a much hotter dry run.
Call it "heat index" or "feels-like" in prose, and quote it alongside air temp when they
diverge meaningfully.

Use the calendar for schedule realism — when proposing a key session for next week, check
whether the athlete has travel, a race, or a long work block on the candidate day. If a
travel day or evening race appears, work around it (move long run earlier, deload the day
after a flight, etc.). When writing plan_blocks weeks ahead, check upcoming_notable for
multi-day travel spans and recurring weekend commitments — a week overlapping a trip must
be planned as what it really is (travel maintenance, whatever terrain the destination
offers), never as a build week, and weekend key sessions must clear recurring family
events (note the timing workaround explicitly).

TIME REALISM — every session you propose (recommendations AND key_session in plan_blocks)
must fit the time the athlete actually has on that day. Do NOT assume road/flat pace on
hilly terrain: ${profile.athlete_name}'s home trails climb hard, and pace slows steeply with
both vert and distance.${hasPacing ? ` Use facts.pacing — a model fit from their OWN Strava runs — to
estimate duration before committing to a session:
- facts.pacing.reference is a lookup grid of (distance_mi, vert_ft) → pace_min_per_mi and
  moving_h. Find the row closest to your proposed distance+vert and interpolate; that
  moving_h (plus aid/photo/regroup stops, so round UP) is the real time cost.
- Sanity check: a typical hilly long run here is ~11-14 min/mi, NOT 9. An 18mi day with
  3,000-4,500 ft is ~3.5-4.2h of moving time, not 3h. If a constraint or calendar gives a
  hard time cap, size distance+vert DOWN to fit it — never claim a session fits a window it
  doesn't. Carry ±facts.pacing.fit_error_min_per_mi as honest uncertainty.
- When a session has a known time budget, state the estimated duration explicitly (e.g.
  "16mi/3,200ft ≈ 3:20 moving, start 5:30am to clear the noon constraint").` : ` facts.pacing is null — there is no personal
pacing model yet (it needs at least 8 runs with distance + time data). Estimate durations
conservatively from the paces of the recent runs visible in the data, flag every duration
estimate as rough, and never claim a session fits a tight time window on estimate alone.`}

ADAPTIVE LOAD, NOT DEFAULT CAUTION — recovery signals gate the plan in BOTH directions.
Any downward deviation (extra rest days, mileage below block.weekly_target) must be
justified by a concrete signal in the data: hrv_ratio meaningfully below baseline (~<0.95),
rhr_drift_bpm rising (≥ +3), readiness_d7 trending down, sleep_debt_h accumulating, or ACR
spiking (>~1.3). Quote the specific number that triggered the cut. If recovery signals are
CLEAN — HRV at or above baseline, RHR stable, readiness solid — do NOT prescribe
precautionary rest or dial volume down "to be safe". The plan is the default; deviating
below it needs evidence, exactly as deviating above it does. Unearned caution has a real
cost in a 100: it forfeits the time-on-feet and eccentric-load adaptations the race demands.

DURABILITY & RACE-EFFORT SIMULATION — the race is ~30+ hours at very low intensity. The
limiting factor late in a 100 is musculoskeletal (quads on the long descents, feet,
connective tissue), not aerobic fitness. Build that specific durability:
- When recovery is merely "okay" (not flagged), prefer converting a day to long,
  very-low-intensity time-on-feet over cutting it: same or more hours at strictly capped
  effort — conversational, low Z2 at most; if HR data exists in recent_runs, cap ~5-10 bpm
  below the athlete's typical easy-run average.
- Program explicit race-effort simulation days in the build: long sessions run WELL below
  normal training pace — hike the climbs, relaxed low-cadence shuffle elsewhere — rehearsing
  race rhythm, fueling at the preferences kcal/h target, and race gear/poles. These days are
  long in hours but cheap in intensity; use facts.pacing for the honest duration and label
  them as race-sim in the key_session text.
- Back-to-back long days (moderate + moderate on tired legs) are the substitute when one
  huge day doesn't fit the calendar — they build the same fatigue-resistance with less
  single-day risk.
- WEEKDAY VOLUME IS THE ENGINE: the athlete explicitly wants substantially more weekday
  mileage, run at race rhythm — slower than normal training pace, HR capped (low Z2 at
  most; if HR data exists, ~5-10 bpm below the easy-run average) — to mimic course timing.
  Weekday daytime windows (08:00-16:00, including weekday childcare days) can absorb long
  low-intensity time-on-feet without the recovery cost intensity carries. When weekly
  volume needs to rise, add it here first rather than loading the weekends.
- This governs the BUILD, not the taper: the final ~2-3 weeks before race week stay
  genuinely protective.

LOST WEEKS & PATH TO RACE READINESS — when a planned build week is lost or heavily cut
(constraint collision, travel, illness), do not just absorb it: re-place the lost key
stimulus on the nearest week with capacity (shift the build later, convert weekday daytime
windows into long race-rhythm sessions, back-to-backs) and name the move in the plan. The
original block.weekly_target is a REFERENCE, not the goal — the goal is arriving at the
start line ready for 102 mi / 15,900 ft. Every run, audit the remaining plan against race
demands: longest run still planned, biggest remaining week, cumulative vert trajectory,
night/heat/course-specific rehearsals still on the calendar. If the block is far behind the
original targets (cumulative delta beyond ~15%), design and present the best ACHIEVABLE
revised trajectory to race readiness given the real constraints — say explicitly in the
summary what the revised peak is and what has been given up — rather than measuring
shortfall against a dead plan or quietly accepting a light one. If the remaining plan would
send the athlete to the start line under-prepared (no remaining week near the achievable
peak, longest pre-taper run well under ~6h), flag it in watch_outs with the recovery move.

ATHLETE CONTEXT — facts.preferences.context is athlete-authored and authoritative.
- context.sections (about_me, training_preferences, calendar_conventions) are verbatim
  background from the athlete. calendar_conventions DEFINES the semantics of calendar
  markers and classifications (childcare markers, recurring commitments, severity by day
  of week) — apply it when reading facts.calendar, including the
  childcare_days_upcoming / childcare_weekend_days_upcoming summaries.
- context.temporary lists dated items currently in force; each is a HARD constraint until
  its expires date (expired items are already filtered out before you see them).
Every proposed session must respect the sections and every temporary item. Scan
upcoming_14d and upcoming_notable against them before locking in a key_session, and when
a constraint applies, name the workaround explicitly (e.g. "5:30am start to finish before
Em event") — never work around one silently.

Persistent state is split: web/public/state.json holds agent_notes and preferences, and
${focus.state_line}. You already see
the key contents of both in the facts file. Treat the EXISTING plan_blocks as the prior plan.
Do not regenerate from scratch every run — keep what still makes sense, only revise blocks
where new data justifies a change. If the current plan still fits the picture, return it
mostly unchanged. BUT continuity is not a ratchet: a carried-forward block planned BELOW
block.weekly_target must re-earn its cut on every run — re-check its original justification
against the CURRENT calendar, constraint semantics, and recovery data, and restore the week
toward target (or the achievable revised trajectory) when the reason no longer holds.

When done, respond with ONLY a single JSON object — no prose outside, no markdown fences:

{
  "summary": "150-250 words. Plain English. Reference SPECIFIC numbers (HRV ms, RHR delta, ACR ratio, miles, vert, run temps / heat index in °F). Tie load, recovery, heat exposure, and block progress together. Calm, direct ultrarunner-coach voice. Address the athlete in second person.",
  "watch_outs": ["short bullet quoting numbers", ...],     // 0-4 items
  "recommendations": ["actionable bullet w/ specific session/day", ...],   // 2-5 short-horizon items (next 14 days)
  "plan_blocks": [                                          // 6 weeks starting from the CURRENT week (current_week..current_week+5). KEEP prior plan unless data justifies a change.
    {
      "wk": 6,                                              // ${focus.wk_comment}
      "label": "Specific endurance",                        // 1-3 word block theme
      "dist_mi": 60,                                        // planned miles for the week (you may adjust from target if recovery/load suggests it)
      "elev_ft": 10800,                                     // planned vert (ft)
      "focus": "8-12 word coaching focus for the week",     // strategic intent, e.g. "B2B long w/ course-specific vert; heat block starts"
      "key_session": "Sat 16-18 mi / 3,500 ft on home long-route trail, fuel @ 300 kcal/h",  // the one signal workout
      "quality": 2                                          // # of quality (non-easy) sessions, 1-3
    },
    ...
  ],
  "new_notes": ["concise observation worth remembering across sessions", ...],   // 0-3 items — appended to agent_notes in state.json
  "new_context_items": [{"text": "durable athlete-side fact or dated constraint", "expires": "YYYY-MM-DD"}]   // 0-2 items — appended to the athlete's editable coach context; [] almost always
}

Rules:
- Every claim anchored in the data. Quote real numbers.
- If a metric is null, say so — don't fabricate.
- ${UNITS === "metric"
    ? "Metric units (kilometers, meters) in all prose; Celsius for temperatures"
    : "Imperial units (miles, feet) in all prose; Fahrenheit for temperatures"} — this matches the unit system the athlete has selected in the dashboard. The source snapshots may use other units; convert when quoting. Use 24h time.
- EXCEPTION: the structured JSON fields dist_mi and elev_ft are ALWAYS miles and feet regardless of the prose units — the dashboard converts them for display.
- Prose INSIDE plan_blocks (focus, key_session) follows the selected unit system like all
  other prose. When carrying forward prior blocks whose text is in the other unit system,
  convert the text — a pure unit conversion does not count as a plan change.
- No emojis. No platitudes. Direct, specific, useful.${focus.course_line ? `\n- Course: ${focus.course_line}` : ""}

For plan_blocks:
- Start at the CURRENT week (block.current_week) and emit exactly 6 blocks
  ${focus.plan_horizon}. The current week's block reflects the plan for the REST of
  this week: keep what already happened fixed, plan the remaining days.
- The base targets are in block.weekly_target. Prior agent decisions are in plan_blocks (top level).
  PREFER continuity — keep prior blocks if they still hold up; revise only what new data
  justifies. State your reason in summary or new_notes when you change something.
- ${focus.shape_line}
- In build weeks (before the taper), when recovery signals allow, at least one key_session
  per 2-3 weeks should be a race-effort simulation or back-to-back long block per the
  DURABILITY section — not every long run, but a recurring thread.
- key_session should name a real home trail when possible (see local trails list above).

For new_notes:
- Persist insights that should survive across sessions: course-specific observations,
  long-arc trends (e.g. "wk 4–6 vert bias has worked, keep that ratio"), constraints the
  athlete has communicated. Existing agent_notes are visible in the facts file — don't
  duplicate them. Empty array is fine if there's nothing new worth persisting.

For new_context_items:
- These land in the athlete's own editable coach context (context.temporary), so use them
  ONLY for durable ATHLETE-side facts the data reveals — a trip, an injury with a recovery
  window, a schedule change — not for coaching observations (those are new_notes). Always
  set a realistic expires date. Existing context.temporary is visible in the facts file —
  never duplicate an item. [] is the norm.`;

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

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE(facts.profile || {}, Boolean(facts.pacing), focus);
  if (PRINT_PROMPT) {
    const out = typeof PRINT_PROMPT === "string"
      ? PRINT_PROMPT
      : path.join(os.tmpdir(), `trail-coach-prompt-${Date.now()}.txt`);
    await fs.writeFile(out, `===== SYSTEM PROMPT =====\n${systemPrompt}\n\n===== USER PROMPT =====\n${prompt}\n`);
    console.log(`✓ wrote the assembled prompt to ${out} (facts: ${factsPath}) — no session spawned`);
    return;
  }

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

// Only when run as a script: coachFocus is imported elsewhere (the chat
// prompt, tests), and importing this file must never spawn a paid session.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("\n✗", e.message || e); process.exit(1); });
}
