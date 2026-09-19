// The coach's system prompts, in one place.
//
// Both coach call sites — the resync readout (scripts/coach.mjs) and the
// interactive chat endpoint (/api/chat in web/vite.config.ts) — build their
// system prompt here. They used to carry two hand-synced copies of the same
// race knowledge, and the copies drifted: the chat prompt still opened with a
// race the athlete had already run.
//
// Nothing about any PARTICULAR race is written in this file. Every race clause
// is assembled from the active folder's race.json (name, date, distance, gain,
// cutoff, elevation, features, and the coach_notes sections verbatim) as it
// reaches the prompt through facts.race; with no race active the same slot is
// filled by the standing goals (PRD §6). A race fact changes in one JSON file
// and both prompts change with it.

import fs from "node:fs";
import path from "node:path";
import { weekdayName } from "./clock.mjs";
import { agentModel } from "./agent-run.mjs";

/**
 * The model both coach prompts spawn against.
 *
 * The literal default lives in scripts/agent-run.mjs — the shared headless
 * runner, which the race intake spawns through too — and this is the single
 * name the two COACH call sites resolve it by, replacing the pair of
 * hand-synced constants they each used to declare. Resolved once at import
 * (TRAIL_COACH_MODEL is read from the environment the process started in),
 * because a dev server that changed models mid-session would produce a
 * readout and a chat answer from different models with no record of it.
 */
export const COACH_MODEL = agentModel();

/* -------- small formatting helpers -------- */

/** Thousands-separated number, or null when the value isn't one — so callers
    can drop the whole clause rather than print "undefined ft". */
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : null);
const numRound = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : null);

/** "key_demands" → "Key demands" — coach_notes keys are free-form snake_case. */
const humanize = (key) => {
  const words = String(key).replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
};

/**
 * Feature flags → prose. [phrase when true, phrase when false]; a null in the
 * second slot means silence — "no night section" is not worth a clause, but
 * "no crew" changes how the race is run and has to be said out loud.
 */
const FEATURE_PHRASES = {
  crew: ["crew access", "no crew access"],
  drop_bags: ["drop bags", "no drop bags"],
  pacers: ["pacers allowed", "no pacers"],
  night: ["a night section", null],
  heat: ["heat", null],
  altitude: ["altitude", null],
  water_crossings: ["water crossings", null],
};

function featureSentences(features) {
  if (!features || typeof features !== "object") return [];
  const present = [];
  const absent = [];
  for (const [key, on] of Object.entries(features)) {
    const [yes, no] = FEATURE_PHRASES[key] ?? [humanize(key).toLowerCase(), null];
    if (on && yes) present.push(yes);
    else if (!on && no) absent.push(no);
  }
  const out = [];
  if (present.length) out.push(`Course features: ${present.join(", ")}.`);
  // Absence is a training demand of its own: with no crew, no drop bags and
  // no pacers the athlete carries the whole day, and the build has to rehearse
  // exactly that.
  if (absent.length) {
    const list = absent.join(", ");
    out.push(`${list[0].toUpperCase()}${list.slice(1)} — what the athlete carries and solves alone is the whole race, so rehearse fuel, gear and problem-solving unsupported.`);
  }
  return out;
}

/** The race-day weekday in the RACE's timezone — "Saturday 2026-09-12" reads
    as a plan; a bare date makes the agent guess which day the taper lands on.
    A race.json with a bad zone must not take the prompt down. */
function raceWeekday(race) {
  if (!race?.date || !race?.timezone) return null;
  try { return weekdayName(race.date, race.timezone); } catch { return null; }
}

/**
 * The tune-up races entered inside this block (PRD-v2 §3), as sentences for
 * the race paragraph.
 *
 * A B-race is not a workout the coach prescribed — it is a date the athlete
 * has already paid for and will run at race effort — so the calendar has to
 * bend around it: a short taper in, a recovery week out, and the week's
 * volume counted with the race in it. Saying that explicitly is the whole
 * point of the list; without it the coach plans a 40-mile week on top of a
 * 50k the athlete is going to race anyway.
 * @param {{slug, name, date, distance_mi, gain_ft, weeks_out}[]} bRaces
 * @returns {string[]}
 */
function bRaceSentences(bRaces) {
  const list = Array.isArray(bRaces) ? bRaces.filter((b) => b && (b.name || b.slug)) : [];
  if (!list.length) return [];
  const when = (b) => {
    if (typeof b.weeks_out !== "number") return "";
    if (b.weeks_out === 0) return ", race week";
    if (b.weeks_out < 0) return `, ${Math.abs(b.weeks_out)} weeks AFTER race day — it is outside this block`;
    return `, ${b.weeks_out} week${b.weeks_out === 1 ? "" : "s"} out`;
  };
  const spec = (b) => [
    num(b.distance_mi) ? `${num(b.distance_mi)} mi` : null,
    numRound(b.gain_ft) ? `${numRound(b.gain_ft)} ft` : null,
  ].filter(Boolean).join(" / ");
  const entries = list.map((b) => {
    const s = spec(b);
    return `${b.name || b.slug} on ${b.date ?? "an unrecorded date"}${when(b)}${s ? ` (${s})` : ""}`;
  });
  return [
    `Tune-up races already entered inside this block: ${entries.join("; ")}.`,
    "These are real race efforts on fixed dates, not sessions you can move. Plan a short taper into each one and a recovery week out of it, count its distance and vert inside that week's volume rather than on top of it, and say in the plan which weeks are shaped by which tune-up. They are in facts.race.b_races.",
  ];
}

/* -------- the two paragraphs -------- */

/**
 * The race paragraph: everything the coach is told about the race itself,
 * built from race.json. Accepts either the raw race.json object or the
 * facts.race projection of it (gain_ft / elevation_ft are the same number
 * under the two names).
 *
 * @param {object|null} race
 * @param {{daysUntil?: number|null}} [opts]
 * @returns {string} "" when there is no race
 */
export function raceParagraph(race, opts = {}) {
  if (!race) return "";
  const daysUntil = opts.daysUntil ?? race.days_until ?? null;
  const gainFt = race.gain_ft ?? race.elevation_ft;
  const spec = [
    num(race.distance_mi) ? `${num(race.distance_mi)} mi` : null,
    numRound(gainFt) ? `${numRound(gainFt)} ft of gain` : null,
  ].filter(Boolean).join(" with ");
  const day = raceWeekday(race);
  const when = race.date
    ? `, on ${day ? `${day} ` : ""}${race.date}${typeof daysUntil === "number" ? ` (${daysUntil} days out)` : ""}`
    : "";
  const where = race.location ? `, at ${race.location}` : "";

  const sentences = [
    `They are training for ${race.name || "an unnamed race"}${spec ? ` — ${spec}` : ""}${when}${where}.`,
  ];
  if (typeof race.cutoff_h === "number") {
    sentences.push(`The overall cutoff is ${race.cutoff_h} h; every plan has to arrive at the start line able to spend that long on the move.`);
  }

  const elev = race.elevation ?? null;
  const lo = numRound(elev?.min_ft);
  const hi = numRound(elev?.max_ft ?? race.max_elev_ft);
  const avg = numRound(elev?.avg_ft);
  if (lo && hi) sentences.push(`The course runs between ${lo} ft and ${hi} ft${avg ? ` (average ${avg} ft)` : ""}.`);
  else if (hi) sentences.push(`The course tops out at ${hi} ft.`);

  sentences.push(...featureSentences(race.features));

  const stations = Array.isArray(race.aid_stations) ? race.aid_stations.length : 0;
  if (stations) {
    sentences.push(`Its ${stations} aid stations — mile, cutoff hour, and crew / drop-bag / pacer access for each — are in facts.race.aid_stations. Plan the race against that table, never against a remembered course.`);
  }

  sentences.push(...bRaceSentences(race.b_races));

  // Altitude is the one feature that changes the CALENDAR, not just the
  // sessions: acclimation and arrival timing have to be decided weeks out,
  // and any pace predicted from home-elevation data is optimistic up there.
  if (elev?.altitude_significant) {
    sentences.push(`ALTITUDE IS A REAL DEMAND HERE — the course spends its time near ${hi || "altitude"}${hi ? " ft" : ""}, high enough to cost the athlete work. Treat acclimation and arrival timing as part of the plan (either arrive early enough to adapt, or late enough to race before the decline sets in), say which you are proposing and when the athlete has to travel, and caveat every projected pace, split and finish time as optimistic — they are extrapolated from training done lower down.`);
  }

  const notes = race.coach_notes && typeof race.coach_notes === "object" ? race.coach_notes : {};
  const sections = Object.entries(notes).filter(([, v]) => typeof v === "string" && v.trim());
  const notesBlock = sections.length
    ? `\n\nCourse notes for this race, authored in its race.json and authoritative (also in facts.race.coach_notes):\n${
      sections.map(([k, v]) => `- ${humanize(k)}: ${v.trim()}`).join("\n")}`
    : "";

  return sentences.join(" ") + notesBlock;
}

/**
 * The goals paragraph: what stands in for the race when none is active
 * (PRD §6). The standing goals are a target the ATHLETE owns — the coach may
 * argue for a change but never assume one.
 * @param {object|null} goals config/goals.json
 * @returns {string}
 */
export function goalsParagraph(goals) {
  const g = goals ?? {};
  const band = g.weekly_volume_band ?? {};
  const range = (pair, unit) =>
    Array.isArray(pair) && pair.length === 2 ? `${num(pair[0])}-${num(pair[1])} ${unit}` : `unset ${unit}`;
  const eventClass = g.event_class || "no named event";
  return `NO RACE IS ACTIVE — there is no date to count down to. They are training toward ${eventClass}${g.horizon ? ` (${g.horizon})` : ""}, currently in a "${g.phase || "unset"}" phase, with a target weekly volume band of ${range(band.dist_mi, "mi")} and ${range(band.vert_ft, "ft")} of vert.${g.notes ? ` Athlete's goals notes: ${g.notes}` : ""} These goals (facts.goals) are the standing target; you may PROPOSE a change to the phase or the band in your summary, but the athlete accepts it in settings — never assume it.`;
}

/**
 * The parts of the prompt that depend on WHAT the athlete is training for.
 *
 * With a race active that is the race, its folder and its block; in generic
 * mode (PRD §6) it is config/goals.json and a rolling window — so the race
 * paragraph becomes a goals paragraph and every "race week 20" style
 * instruction has to go with it.
 */
export function coachFocus(facts) {
  const block = facts?.block ?? {};
  const totalWeeks = block.total_weeks ?? 12;
  const race = facts?.race;

  if (race) {
    const gainFt = race.gain_ft ?? race.elevation_ft;
    const readySpec = [
      num(race.distance_mi) ? `${num(race.distance_mi)} mi` : null,
      numRound(gainFt) ? `${numRound(gainFt)} ft` : null,
    ].filter(Boolean).join(" / ");
    return {
      training_for: raceParagraph(race),
      block_phrase: `their planned ${totalWeeks}-week training block for this race`,
      // wk indexes the RACE BLOCK here (block.mode "race") — see the rolling
      // branch below for the other contract.
      wk_comment: `week number in the active race block, 1..${totalWeeks} (facts.block.mode "race"): wk ${totalWeeks} is race week`,
      plan_horizon: `(or fewer if fewer remain before race week ${totalWeeks})`,
      shape_line: `Reflect race-specific prep: the demands named in the race paragraph above, a taper proportional to the distance, race week = wk ${totalWeeks}.`,
      user_horizon: `for ${race.name}${typeof race.days_until === "number" ? ` (${race.days_until} days out)` : ""}`,
      state_line: `the race (meta, block targets, the current plan_blocks) lives in races/${race.slug || "<slug>"}/`,
      effort_line: `the race is ${typeof race.cutoff_h === "number" ? `up to ~${race.cutoff_h} hours (its cutoff)` : "a long day"} at very low intensity`,
      taper_line: `This governs the BUILD, not the taper: the final ~2-3 weeks before race week (wk ${totalWeeks}) stay genuinely protective.`,
      readiness_target: `arriving at the start line ready for ${readySpec || race.name}`,
    };
  }

  const goals = facts?.goals ?? {};
  const eventClass = goals.event_class || "no named event";
  return {
    training_for: goalsParagraph(goals),
    block_phrase: `a rolling ${totalWeeks}-week training window (facts.block.mode "rolling": wk ${totalWeeks} is the CURRENT week and wk 1 is ${totalWeeks - 1} weeks ago; weekly targets are the coach's own planned weeks where they exist, else the midpoint of the goals band)`,
    wk_comment: `week index in the rolling ${totalWeeks}-week window (facts.block.mode "rolling") — wk ${totalWeeks} is the CURRENT week, so the weeks you plan ahead continue ${totalWeeks + 1}, ${totalWeeks + 2}, …`,
    plan_horizon: "(the window rolls forward one week at a time, so prior plan_blocks were indexed against LAST week's window — re-index them rather than assuming they line up)",
    shape_line: `There is no race week and no taper to build toward. Shape the six weeks to the current phase (${goals.phase || "unset"}) and keep each week inside the goals volume band — if the data justifies stepping outside it, say so explicitly and propose the band change.`,
    user_horizon: `toward ${eventClass}`,
    state_line: "the standing goals live in config/goals.json and the rolling plan_blocks in config/generic-plan.json",
    effort_line: `the event class they are building toward (${eventClass}) is a long, low-intensity effort`,
    taper_line: `This governs BUILD work. There is no race to taper into, so when the goals phase is "taper" or "recovery" the same weeks stay genuinely protective instead.`,
    readiness_target: `holding the standing goals (${eventClass}, phase ${goals.phase || "unset"}) inside the volume band`,
  };
}

/* -------- race state: the planner's own numbers, sent by the client -------- */

/*
 * PRD-v2 §6. The chat endpoint has read access to snapshots and to the facts
 * digest, but NOT to what the athlete is looking at: the projection, the knob
 * settings and the fuel plan live in the browser (web/src/race/useRacePlan.ts),
 * are recomputed on every knob drag, and are never written to disk. So the
 * client sends them with each turn and the prompt renders them.
 *
 * Everything here is PURE: it takes the object the client sent and returns
 * text. Nothing in this section opens a file — the whole point is that this
 * state has no on-disk representation to read, and a renderer that fell back
 * to disk would quietly answer about a different (stale, or merely active)
 * race than the one on the athlete's screen.
 */

/** Hard cap on the race_state JSON the chat endpoint accepts, in bytes.
    8 KB is ~2k tokens of prompt at the chars/4 estimate below — an order of
    magnitude more than a rendered block needs (see the MM100 measurement in
    coach-prompt.test.mjs), so it bounds a buggy or hostile client without
    ever being reachable by an honest one. */
export const RACE_STATE_MAX_BYTES = 8192;

/** Above this many estimated tokens the RENDERED block is logged as a
    warning: the budget it competes for is the coach's reading budget, and a
    block that big means the client started shipping the whole plan. */
export const RACE_STATE_WARN_TOKENS = 600;

/**
 * Rough token count — characters / 4, the usual English-prose approximation.
 * Deliberately not a tokenizer: this guards a prompt-size budget, where being
 * within ~20% is enough and a dependency (or a per-turn tokenizer call) is not
 * worth it. Rounded UP so a budget check never under-reports.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return typeof text === "string" && text.length ? Math.ceil(text.length / 4) : 0;
}

/** A finite number, or null. */
const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** A non-empty string, trimmed and truncated, or null. */
const str = (v, max) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
/** A plain object (not null, not an array), or null. */
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

/** Aid stations the block will render. A 100-miler has ~15; the cap exists so
    a client that sent every course point can't crowd out the prompt. */
const MAX_STATIONS = 40;
/** Knobs the planner actually exposes is a single-digit number. */
const MAX_KNOBS = 24;

/** The fuel/caffeine figures the block knows how to phrase, in render order.
    A key not in this table is dropped rather than printed with no unit —
    "sodium 700" in a coaching prompt is an invitation to misread mg as g. */
const FUEL_FIELDS = [
  ["carb_g_h", (v) => `${v} g carb/h`],
  ["fluid_ml_h", (v) => `${v} ml fluid/h`],
  ["sodium_mg_h", (v) => `${v} mg sodium/h`],
  ["carb_g_total", (v) => `${v} g carb total`],
  ["fluid_l_total", (v) => `${v} L fluid total`],
  ["sodium_mg_total", (v) => `${v} mg sodium total`],
  ["caffeine_mg_total", (v) => `${v} mg caffeine total`],
  ["kcal_total", (v) => `${v} kcal total`],
];

/**
 * Validate and normalize the client's race_state.
 *
 * Unknown keys are DROPPED rather than rejected: the client is the dashboard
 * in the same repo and will grow fields ahead of this renderer, and a 400 for
 * a field the prompt simply has no sentence for would break chat on every
 * such deploy. Wrong-TYPED known keys are dropped for the same reason — the
 * two conditions that do fail the request are a race_state that isn't an
 * object at all and one over the size cap, because both mean the caller is
 * not the dashboard.
 *
 * @param {unknown} raw the request body's race_state
 * @returns {{state: object|null, error?: undefined} | {error: string, state?: undefined}}
 */
export function parseRaceState(raw) {
  if (raw === undefined || raw === null) return { state: null };
  const src = obj(raw);
  if (!src) return { error: "race_state must be an object" };

  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(raw), "utf8"); }
  catch { return { error: "race_state is not serializable" }; }
  if (bytes > RACE_STATE_MAX_BYTES) {
    return { error: `race_state is ${bytes} bytes, over the ${RACE_STATE_MAX_BYTES}-byte limit` };
  }

  // Mode is the one REQUIRED field, and the one that encodes the PRD's rule
  // that generic mode sends no race state at all: there is no "generic" here
  // to accept, so a client that kept sending after the athlete left the race
  // is rejected rather than silently describing a race they are not looking at.
  const mode = str(src.mode, 16);
  if (mode !== "train" && mode !== "view") {
    return { error: 'race_state.mode must be "train" or "view"' };
  }

  const state = { mode };
  const slug = str(src.slug, 120);
  const name = str(src.name, 120);
  if (slug) state.slug = slug;
  if (name) state.name = name;

  const goalSrc = obj(src.goal);
  if (goalSrc) {
    const goal = {};
    const label = str(goalSrc.label, 80);
    const targetH = fin(goalSrc.target_h);
    const projectedH = fin(goalSrc.projected_h);
    const startClock = str(goalSrc.start_clock, 16);
    const finishClock = str(goalSrc.finish_clock, 16);
    if (label) goal.label = label;
    if (targetH != null) goal.target_h = targetH;
    if (projectedH != null) goal.projected_h = projectedH;
    if (startClock) goal.start_clock = startClock;
    if (finishClock) goal.finish_clock = finishClock;
    if (Object.keys(goal).length) state.goal = goal;
  }

  const knobsSrc = obj(src.knobs);
  if (knobsSrc) {
    const knobs = {};
    for (const [k, v] of Object.entries(knobsSrc).slice(0, MAX_KNOBS)) {
      const key = str(k, 40);
      if (!key) continue;
      if (typeof v === "boolean") knobs[key] = v;
      else if (fin(v) != null) knobs[key] = v;
      else {
        const s = str(v, 60);
        if (s) knobs[key] = s;
      }
    }
    if (Object.keys(knobs).length) state.knobs = knobs;
  }

  const fuelSrc = obj(src.fuel);
  if (fuelSrc) {
    const fuel = {};
    for (const [key] of FUEL_FIELDS) {
      const v = fin(fuelSrc[key]);
      if (v != null) fuel[key] = v;
    }
    if (Object.keys(fuel).length) state.fuel = fuel;
  }

  if (Array.isArray(src.stations)) {
    const stations = [];
    for (const entry of src.stations.slice(0, MAX_STATIONS)) {
      const s = obj(entry);
      if (!s) continue;
      const stationName = str(s.name, 60);
      if (!stationName) continue; // an ETA with no station is noise, not context
      const st = { name: stationName };
      const mi = fin(s.mi);
      const clock = str(s.clock, 16);
      const elapsedH = fin(s.elapsed_h);
      const cutoffClock = str(s.cutoff_clock, 16);
      if (mi != null) st.mi = mi;
      if (clock) st.clock = clock;
      if (elapsedH != null) st.elapsed_h = elapsedH;
      if (cutoffClock) st.cutoff_clock = cutoffClock;
      stations.push(st);
    }
    if (stations.length) state.stations = stations;
  }

  const statusSrc = obj(src.status);
  if (statusSrc) {
    const status = {};
    if (typeof statusSrc.block_stale === "boolean") status.block_stale = statusSrc.block_stale;
    if (typeof statusSrc.activated === "boolean") status.activated = statusSrc.activated;
    const unresolved = fin(statusSrc.unresolved);
    if (unresolved != null) status.unresolved = unresolved;
    const activation = str(statusSrc.activation, 40);
    if (activation) status.activation = activation;
    if (Object.keys(status).length) state.status = status;
  }

  const cpSrc = obj(src.checkpoint);
  if (cpSrc) {
    const cp = {};
    const cpName = str(cpSrc.name, 60);
    const clock = str(cpSrc.clock, 16);
    const source = str(cpSrc.source, 16);
    const mi = fin(cpSrc.mi);
    const deltaMin = fin(cpSrc.delta_min);
    const elapsedH = fin(cpSrc.elapsed_h);
    if (cpName) cp.name = cpName;
    if (clock) cp.clock = clock;
    if (source === "tracker" || source === "manual") cp.source = source;
    if (mi != null) cp.mi = mi;
    if (deltaMin != null) cp.delta_min = deltaMin;
    if (elapsedH != null) cp.elapsed_h = elapsedH;
    if (cp.name || cp.clock || cp.mi != null) state.checkpoint = cp;
  }

  return { state };
}

/** "33.27" → "33:16" — hours as a clock the athlete reads on a watch. */
const hoursClock = (h) => {
  const total = Math.round(h * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * Render the normalized race_state as the prompt block.
 *
 * Short on purpose (see the token measurement in the tests): it is the only
 * part of the system prompt that grows with the athlete's plan, and it is
 * re-sent on EVERY turn of the conversation.
 *
 * @param {object|null} state the output of parseRaceState
 * @returns {string} "" when there is no state (generic mode)
 */
export function raceStateBlock(state) {
  if (!state) return "";
  const title = state.name || state.slug || "their race";
  const head = state.mode === "view"
    ? `RACE STATE (from the athlete's own planner) — ${title}, which they are LOOKING AT in the dashboard right now. It is not their active race, so answer about this one only as far as they ask.`
    : `RACE STATE (from the athlete's own planner) — ${title}, the race they are training for and have open in the dashboard.`;

  const lines = [];

  const g = state.goal;
  if (g) {
    const parts = [];
    if (g.projected_h != null) parts.push(`the planner projects ${hoursClock(g.projected_h)} (${g.projected_h} h)`);
    if (g.target_h != null) parts.push(`their target is ${hoursClock(g.target_h)} (${g.target_h} h)`);
    if (g.label) parts.push(`goal "${g.label}"`);
    if (g.start_clock) parts.push(`start ${g.start_clock}`);
    if (g.finish_clock) parts.push(`finishing around ${g.finish_clock}`);
    if (parts.length) lines.push(`- Finish: ${parts.join("; ")}.`);
  }

  if (state.knobs) {
    lines.push(`- Planner knobs as they have them set: ${
      Object.entries(state.knobs).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  }

  if (state.fuel) {
    const parts = FUEL_FIELDS
      .filter(([k]) => state.fuel[k] != null)
      .map(([k, render]) => render(state.fuel[k]));
    if (parts.length) lines.push(`- Fuel plan: ${parts.join(", ")}.`);
  }

  if (state.stations) {
    lines.push(`- Expected arrival at each aid station, on their plan: ${
      state.stations.map((s) => {
        const at = s.clock ?? (s.elapsed_h != null ? `${hoursClock(s.elapsed_h)} elapsed` : "—");
        const cut = s.cutoff_clock ? `, cutoff ${s.cutoff_clock}` : "";
        return `${s.name}${s.mi != null ? ` (mi ${s.mi})` : ""} ${at}${cut}`;
      }).join("; ")}.`);
  }

  const st = state.status;
  if (st) {
    const parts = [];
    if (st.block_stale === true) parts.push("the training block is STALE against this plan (a re-plan is pending)");
    else if (st.block_stale === false) parts.push("the training block is up to date with this plan");
    if (st.unresolved != null) {
      parts.push(st.unresolved === 0
        ? "no unresolved review items"
        : `${st.unresolved} unresolved review item${st.unresolved === 1 ? "" : "s"} they have not answered`);
    }
    if (st.activated === true) parts.push("the plan is activated");
    else if (st.activated === false) parts.push("the plan is NOT activated yet");
    if (st.activation) parts.push(`activation: ${st.activation}`);
    if (parts.length) lines.push(`- Plan status: ${parts.join("; ")}.`);
  }

  const cp = state.checkpoint;
  if (cp) {
    const where = [cp.name, cp.mi != null ? `mile ${cp.mi}` : null].filter(Boolean).join(", ");
    const when = cp.clock ? ` at ${cp.clock}` : cp.elapsed_h != null ? ` at ${hoursClock(cp.elapsed_h)} elapsed` : "";
    const delta = cp.delta_min == null
      ? ""
      : cp.delta_min === 0
        ? ", exactly on plan"
        : `, ${Math.abs(cp.delta_min)} min ${cp.delta_min < 0 ? "AHEAD of" : "BEHIND"} plan`;
    // With no time attached this is a POSITION the athlete stated, not a
    // split — calling it a checkpoint would invite the coach to reason about
    // a pace nobody recorded.
    const label = when || delta ? "Last checkpoint" : "Last reported position";
    lines.push(`- ${label}${cp.source ? ` (${cp.source})` : ""}: ${where || "unnamed"}${when}${delta}.`);
  }

  if (!lines.length) return `${head}\nThe athlete has this race open but the planner has produced no numbers for it yet — do not invent any.`;

  return `${head}
These numbers are the athlete's OWN planner output as of this message — their course model, their knob settings, their fuel plan — and they exist nowhere on disk, so there is no file to check them against. Quote them as theirs and do not recompute or silently replace them; if you think one is wrong, name the knob or assumption that would change it.
${lines.join("\n")}`;
}

/* -------- what the agent may Read -------- */

/**
 * The active race folder's own files, as repo-relative paths (both prompts
 * run with cwd = the project root) — and ONLY the ones that exist. Naming a
 * missing file costs the agent a turn on an ENOENT out of a hard budget and
 * teaches it the prompt is unreliable; build/course.json in particular is
 * generated output that a fresh checkout does not carry.
 * @returns {string[]}
 */
export function raceReadPaths(root, race) {
  const slug = race?.slug;
  if (!root || !slug) return [];
  return [
    path.join("races", slug, "race.json"),
    path.join("races", slug, "build", "course.json"),
  ].filter((rel) => {
    try { return fs.existsSync(path.join(root, rel)); } catch { return false; }
  });
}

/** One sentence naming those files, or "" when there are none. */
function raceReadSentence(paths) {
  if (!paths.length) return "";
  return ` The race folder's own config is readable too: ${paths.join(" and ")}${paths.length > 1 ? " (the built course profile)" : ""} — race.json is the source of every race fact above, so open it only for detail the paragraph and facts.race genuinely lack.`;
}

/* -------- the readout prompt (scripts/coach.mjs) -------- */

/**
 * System prompt for the one-shot JSON readout the resync writes to
 * web/public/coach.json.
 * @param {object} facts   the facts digest (facts.race / facts.goals / facts.block)
 * @param {object} profile config/profile.json
 * @param {{units?: "metric"|"imperial", hasPacing?: boolean, root?: string}} [opts]
 */
export function readoutSystemPrompt(facts, profile = {}, opts = {}) {
  const units = opts.units === "imperial" ? "imperial" : "metric";
  const hasPacing = opts.hasPacing ?? Boolean(facts?.pacing);
  const focus = coachFocus(facts);
  const racePaths = raceReadPaths(opts.root, facts?.race);
  const historyLine = historySentence(facts?.history);

  return `You are the coach inside Trail Almanac, a personal ultra-training dashboard.

The athlete is ${profile.athlete_name}. ${focus.training_for}

They live in ${profile.location}. Local training trails: ${(profile.home_trails || []).join(", ") || "their home mountains"}.

You will be given the path to a JSON facts file built from their Strava activities, Oura ring
data, weather conditions during each run, Google Calendar events (next 14 days under
facts.calendar.upcoming_14d; schedule-shaping events over the full ~30-day window — trips,
races, recurring family commitments like weekend kid sports — under
facts.calendar.upcoming_notable), and ${focus.block_phrase}. You may also read
the underlying snapshots at web/public/strava.json, web/public/cross-train.json,
web/public/oura.json, web/public/google-cal.json, and web/public/state.json for additional
context if useful.${raceReadSentence(racePaths)}${historyLine}

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
cost in a long mountain race: it forfeits the time-on-feet and eccentric-load adaptations
the distance demands.

DURABILITY & RACE-EFFORT SIMULATION — ${focus.effort_line}. The
limiting factor late in a long mountain ultra is musculoskeletal (quads on the long
descents, feet, connective tissue), not aerobic fitness. Build that specific durability:
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
- ${focus.taper_line}

LOST WEEKS & PATH TO READINESS — when a planned build week is lost or heavily cut
(constraint collision, travel, illness), do not just absorb it: re-place the lost key
stimulus on the nearest week with capacity (shift the build later, convert weekday daytime
windows into long race-rhythm sessions, back-to-backs) and name the move in the plan. The
original block.weekly_target is a REFERENCE, not the goal — the goal is
${focus.readiness_target}. Every run, audit the remaining plan against the demands named
above: longest run still planned, biggest remaining week, cumulative vert trajectory,
night/heat/course-specific rehearsals still on the calendar. If the block is far behind the
original targets (cumulative delta beyond ~15%), design and present the best ACHIEVABLE
revised trajectory given the real constraints — say explicitly in the summary what the
revised peak is and what has been given up — rather than measuring shortfall against a dead
plan or quietly accepting a light one. If the remaining plan would leave the athlete
under-prepared (no remaining week near the achievable peak, longest pre-taper run well
under ~6h), flag it in watch_outs with the recovery move.

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
- ${units === "metric"
    ? "Metric units (kilometers, meters) in all prose; Celsius for temperatures"
    : "Imperial units (miles, feet) in all prose; Fahrenheit for temperatures"} — this matches the unit system the athlete has selected in the dashboard. The source snapshots may use other units; convert when quoting. Use 24h time.
- EXCEPTION: the structured JSON fields dist_mi and elev_ft are ALWAYS miles and feet regardless of the prose units — the dashboard converts them for display.
- Prose INSIDE plan_blocks (focus, key_session) follows the selected unit system like all
  other prose. When carrying forward prior blocks whose text is in the other unit system,
  convert the text — a pure unit conversion does not count as a plan change.
- No emojis. No platitudes. Direct, specific, useful.

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
}

/* -------- the chat prompt (/api/chat in web/vite.config.ts) -------- */

/**
 * System prompt for the interactive chat turn. Same race knowledge as the
 * readout, different job: a short conversational answer, a tight read budget,
 * and the CONTEXT_SAVE sentinel the endpoint strips before display.
 * @param {object} facts   the facts digest (facts.race / facts.goals / facts.block)
 * @param {object} profile config/profile.json
 * `opts.raceState` is the CLIENT's state (PRD-v2 §6) — already normalized by
 * parseRaceState — and is the one part of this prompt that does not come from
 * disk. Absent in generic mode, where the block is omitted entirely rather
 * than rendered empty.
 * @param {{factsPath: string, coachPath: string, units?: "metric"|"imperial", hasPacing?: boolean, root?: string, raceState?: object|null}} opts
 */
export function chatSystemPrompt(facts, profile = {}, opts = {}) {
  const units = opts.units === "imperial" ? "imperial" : "metric";
  const hasPacing = opts.hasPacing ?? Boolean(facts?.pacing);
  const focus = coachFocus(facts);
  const athlete = profile.athlete_name || "the athlete";
  const racePaths = raceReadPaths(opts.root, facts?.race);
  const raceFileLines = racePaths.map((p) => `\n  - ${p}${p.endsWith("race.json") ? "   (the race's own config — the source of every race fact above)" : "   (built course profile: aid stations snapped to the track, elevation grid)"}`).join("");
  // The planner block sits directly under the race paragraph, ABOVE the file
  // list: it is the only live state here, and the reading budget below tells
  // the agent to answer from what it already has — which now includes this.
  const stateBlock = raceStateBlock(opts.raceState ?? null);

  return `You are the coach inside Trail Almanac for ${athlete}. ${focus.training_for}

They live in ${profile.location || "their home mountains"}.${profile.home_trails?.length ? ` Local training trails: ${profile.home_trails.join(", ")}.` : ""}${historySentence(facts?.history)}
${stateBlock ? `\n${stateBlock}\n` : ""}
You have full read access to:
  - ${opts.factsPath}      (deterministic facts: block week, ACR, HRV trend, RHR drift, sleep, heat exposure, recent runs w/ temps, plan_blocks, agent_notes from prior sessions${facts?.race ? ", the race and its aid stations" : ", the standing goals"})
  - ${opts.coachPath}      (most recent structured agent readout)
  - web/public/state.json   (persistent athlete state — agent_notes, preferences; ${focus.state_line})
  - web/public/strava.json  (raw Strava snapshot, runs only — distance/elev/HR/dates/titles/start_latlng/weather, with strava_url)
  - web/public/cross-train.json  (non-run Strava activities — rides, hikes, strength, … EXCLUDED from all load metrics, which count runs only; use qualitatively for fatigue/time-on-feet)
  - web/public/oura.json    (Oura snapshot — sleep, readiness, HRV, RHR, tags)
  - web/public/google-cal.json  (Google Calendar — past 7 + next 30 days of events, classified by training relevance)${raceFileLines}

READING BUDGET — you are running headless with a hard turn limit, and if you spend it
reading you will be cut off before you answer, which is worse for the athlete than a
slightly less thorough reply. The facts file is a digest built for exactly this, and it
ALREADY CONTAINS, in full, everything most questions need:
  - recovery.nights — the last 21 nights individually (sleep hours, sleep score,
    readiness, HRV, RHR), plus the d7/d28 aggregates and the tags. Nights with no Oura
    record are OMITTED rather than zeroed, and recovery.nights_recorded_d7 says how many
    of the last 7 actually have sleep data — read a weekly sleep total against that
    count, not against 7.
  - recent_runs — the last 14 runs with distance, vert, HR, pace and weather
  - calendar — the fetched summary plus the next 14 days and anything notable
  - block, load, pacing, plan_blocks, agent_notes, preferences, cross_training${facts?.race ? "\n  - race — the race paragraph above in structured form, plus the full aid-station table\n    (mile, cutoff hour, crew / drop-bag / pacer access) and features" : "\n  - goals — the standing event class, phase and weekly volume band"}
  - history — races already run and archived, with their results
Answer from the digest alone whenever it is sufficient, which is most of the time.
Open a raw snapshot ONLY for detail the digest genuinely lacks — a run older than the
last 14, a night older than 21 days, a calendar event beyond the next fortnight.
oura.json, strava.json and google-cal.json are each thousands of lines and take SEVERAL
reads to page through; when you truly need one, read the slice you need with
offset/limit rather than paging the whole file, and stop as soon as you can answer.
state.json is already reflected in the digest fields above — do not open it. Never open
a file "to check" something you already have. If you find yourself several reads in,
write the answer with what you have and say which data you did not open.

Use the calendar for schedule realism — if the athlete asks about a specific day's session,
check that day's events first. Flag conflicts (travel, races, work blocks).

ATHLETE CONTEXT — facts.preferences.context is athlete-authored and authoritative.
context.sections (about_me, training_preferences, calendar_conventions) are verbatim
background; calendar_conventions DEFINES the semantics of calendar markers and
classifications (childcare markers, recurring commitments, severity by day of week) —
apply it when reading the calendar. context.temporary lists dated items currently in
force; each is a HARD constraint until its expires date (expired items are already
filtered out). When asked about a session on a specific day, cross-check the day's events
against the sections and every temporary item before suggesting timing — work around a
constraint explicitly (e.g. early start before the conflicting event) or move the session.

SAVING CONTEXT — you can persist things the athlete tells you. Append at the VERY END of
your reply, after all prose:
<<<CONTEXT_SAVE
{"items":[{"text":"<dated constraint, athlete voice>","expires":"YYYY-MM-DD"}],
 "section_appends":[{"section":"about_me","text":"<durable fact, athlete voice>"}]}
CONTEXT_SAVE>>>
Routing: DATED, self-expiring facts (a trip, an injury window, a one-off schedule change)
→ items, with a realistic expires (roughly 30 days out if none is implied). DURABLE facts
(background, lasting training preferences, what a calendar pattern means) →
section_appends into exactly one of: about_me, training_preferences,
calendar_conventions. Appends ADD a new paragraph to the section — they can never edit or
remove existing text — so keep each append tight, self-contained, and in the athlete's
voice, UNDER 1000 characters (longer appends are rejected outright; split into multiple
appends instead). Omit either key when it has nothing; include the block ONLY when there is
genuinely something new — never emit an empty one, and never re-save what is already in
context. It is stripped before display and stored in the athlete's editable coach
context. Confirm in your prose exactly what you saved and where (or until when).
If the athlete asks you to interview them to build out their context/profile, ask short
focused questions a few at a time, and at the natural end of the exchange save what you
learned — durable answers via section_appends, dated ones via items.

Load philosophy: recovery signals gate the plan in BOTH directions. Only recommend extra
rest or reduced mileage when a concrete signal in the data justifies it (HRV ratio below
baseline, RHR drift ≥ +3 bpm, readiness falling, sleep debt, ACR > ~1.3) — and quote the
number. When signals are clean, hold or build the planned volume; do not counsel caution
by default. The limiter in a long mountain ultra is leg durability (quads on descents,
feet, time on feet), not aerobic fitness — so when load needs managing, prefer long
very-low-intensity time-on-feet days and race-effort simulation (hiked climbs, relaxed
low-cadence shuffle, fueling practice at race rhythm) over simply cutting volume. Taper
weeks are the exception and stay protective.

plan_blocks contract: wk is the ${focus.wk_comment}. Use that indexing whenever you quote
or propose a week.

${hasPacing
  ? `When estimating how long a run will take, use facts.pacing — a model fit from ${athlete}'s own Strava runs. Pace slows steeply with vert and distance, so never assume flat-road pace on hilly terrain. Read off facts.pacing.reference (distance_mi + vert_ft → pace_min_per_mi, moving_h), interpolate for the proposed session, round up for stops, and carry ±facts.pacing.fit_error_min_per_mi as uncertainty. A hilly long run here is ~11-14 min/mi, not 9.`
  : `facts.pacing is null — no personal pacing model yet (needs at least 8 runs with distance + time data). Estimate durations conservatively from recent runs in the data, flag estimates as rough, and never assume flat-road pace on hilly terrain.`}

Use the Read tool to look up specifics. Ground every claim in the data — quote real numbers (HRV ms, RHR delta, ACR ratio, distance, vert, dates, run temps).

Response rules:
  - Be concise. 1-3 short paragraphs unless the user explicitly asks for more depth.
  - Plain text. No markdown headers, no bullet bloat. Inline bullets ok where natural.
  - ${units === "metric"
      ? "Metric units (kilometers, meters); Celsius for temperatures"
      : "Imperial units (miles, feet); Fahrenheit for temperatures"} — this is the unit system the athlete has selected in the dashboard. Source snapshots may store other units; convert when quoting numbers. 24h time.
  - No emojis. No filler. Direct, specific, useful.
  - When unsure or data missing, say so. Don't fabricate.
  - Address the athlete in second person.
  - Defer to the established plan_blocks and agent_notes from prior sessions — don't propose a re-plan unless the user explicitly asks.`;
}

/**
 * One sentence pointing at facts.history — the races the athlete has already
 * run. Silent when there are none, so a first-race athlete isn't told about an
 * empty array.
 */
function historySentence(history) {
  if (!Array.isArray(history) || history.length === 0) return "";
  const named = history
    .slice(0, 3)
    .map((h) => `${h.name}${h.date ? ` (${h.date}${h.result?.finish_h != null ? `, finished in ${h.result.finish_h} h` : h.result?.status ? `, ${h.result.status}` : ""})` : ""}`)
    .join("; ");
  return ` Races they have already run are in facts.history — ${named}${history.length > 3 ? `, and ${history.length - 3} more` : ""} — each with its result and the notes you wrote about it. Cite that experience when it is relevant; it is this athlete's own evidence.`;
}
