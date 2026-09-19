// The coach's race knowledge, assembled from race.json rather than written
// into the prompt. These are snapshot-ish assertions: they pin the SENTENCES
// the agent actually reads, because a paragraph that silently loses the
// cutoff or the altitude demand still looks like a prompt.
//
// The archived Mogollon Monster folder is loaded as if it were active — the
// real race the literals used to describe, now the proof that they come from
// the file — alongside a fixture race with no crew, no drop bags and no
// pacers, and generic mode with only a goals object.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fsSync from "node:fs";
import { fileURLToPath } from "node:url";
import { loadRaceFolder } from "./race-config.mjs";
import {
  COACH_MODEL,
  RACE_STATE_MAX_BYTES,
  RACE_STATE_WARN_TOKENS,
  chatSystemPrompt,
  coachFocus,
  estimateTokens,
  goalsParagraph,
  parseRaceState,
  raceParagraph,
  raceReadPaths,
  raceStateBlock,
  readoutSystemPrompt,
} from "./coach-prompt.mjs";
import { MODEL_DEFAULT } from "./coach.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MM100 = "mogollon-monster-100-2026";

/** The archived MM100 folder, or null when this checkout doesn't carry it. */
async function mm100() {
  try {
    const { race } = await loadRaceFolder(ROOT, MM100);
    return { ...race, slug: MM100, days_until: 38 };
  } catch {
    return null;
  }
}

const GOALS = {
  event_class: "100 mi mountain race",
  horizon: "next A-race ~Aug 2027",
  phase: "return_to_run",
  weekly_volume_band: { dist_mi: [0, 25], vert_ft: [0, 3000] },
  notes: "shin niggle; reassess 2026-09-23",
};

/* -------- (a) the archived MM100 folder, loaded as if active -------- */

test("MM100: every clause of the race paragraph comes from its race.json", async (t) => {
  const race = await mm100();
  if (!race) return t.skip(`races/${MM100}/ not in this checkout`);
  const p = raceParagraph(race);

  // opening line: name, distance, gain, race-local weekday + date, days out, location
  assert.match(
    p,
    /^They are training for Mogollon Monster 100 — 102\.6 mi with 15,900 ft of gain, on Saturday 2026-09-12 \(38 days out\), at Mogollon Rim · Pine, AZ \(90 min NE of Phoenix\)\./,
  );
  // 2026-09-12 is a Saturday in America/Phoenix — the weekday is derived, not typed
  assert.match(p, /The overall cutoff is 38 h;/);
  assert.match(p, /The course runs between 5,326 ft and 7,912 ft \(average 6,627 ft\)\./);
  assert.match(p, /Course features: crew access, drop bags, pacers allowed, a night section, heat, altitude, water crossings\./);
  assert.match(p, /Its 15 aid stations — mile, cutoff hour, and crew \/ drop-bag \/ pacer access for each — are in facts\.race\.aid_stations\./);
  // every coach_notes section, verbatim and labelled
  for (const [key, text] of Object.entries(race.coach_notes)) {
    const label = key === "key_demands" ? "Key demands" : key === "race_week" ? "Race week" : key[0].toUpperCase() + key.slice(1);
    assert.ok(p.includes(`- ${label}: ${text}`), `coach_notes.${key} missing or reworded`);
  }
  // MM100's altitude_significant is false — the demand sentence must not appear
  assert.doesNotMatch(p, /ALTITUDE IS A REAL DEMAND/);
});

test("MM100 as the active race: the readout prompt carries it and race-block wk semantics", async (t) => {
  const race = await mm100();
  if (!race) return t.skip(`races/${MM100}/ not in this checkout`);
  const facts = { race, block: { mode: "race", total_weeks: 20 }, history: [] };
  const sys = readoutSystemPrompt(facts, { athlete_name: "A", location: "Albuquerque", home_trails: ["Embudito"] }, { root: ROOT });

  assert.match(sys, /training for Mogollon Monster 100 — 102\.6 mi/);
  assert.match(sys, /planned 20-week training block for this race/);
  assert.match(sys, /week number in the active race block, 1\.\.20 .*wk 20 is race week/);
  assert.match(sys, /the race is up to ~38 hours \(its cutoff\) at very low intensity/);
  assert.match(sys, /the goal is\narriving at the start line ready for 102\.6 mi \/ 15,900 ft/);
  assert.match(sys, /races\/mogollon-monster-100-2026\//);
  // the race folder's own config is readable; build/course.json is generated
  // output (gitignored) that is advertised only when it exists on disk — so
  // the expectation follows the checkout instead of assuming a fresh clone.
  assert.match(sys, /races\/mogollon-monster-100-2026\/race\.json/);
  const built = fsSync.existsSync(path.join(ROOT, "races/mogollon-monster-100-2026/build/course.json"));
  if (built) assert.match(sys, /build\/course\.json/);
  else assert.doesNotMatch(sys, /build\/course\.json/);
});

/* -------- (b) the crewless fixture -------- */

test("crewless 50K: the paragraph says what the course withholds", async () => {
  const { race } = await loadRaceFolder(ROOT, "_fixtures/crewless-50k");
  const p = raceParagraph(race, { daysUntil: 240 });

  assert.match(
    p,
    /^They are training for Dry Wash 50K — 31\.4 mi with 4,200 ft of gain, on Saturday 2027-05-15 \(240 days out\), at Invented for tests · nowhere real\./,
  );
  assert.match(p, /The overall cutoff is 9 h;/);
  assert.match(p, /The course runs between 2,100 ft and 4,350 ft \(average 3,100 ft\)\./);
  // heat is the only feature it HAS; the three it lacks get their own sentence
  assert.match(p, /Course features: heat\./);
  assert.match(p, /No crew access, no drop bags, no pacers — what the athlete carries and solves alone is the whole race/);
  assert.match(p, /Its 5 aid stations —/);
  assert.match(p, /- Terrain: Dry desert singletrack with two sustained but short climbs/);
  assert.doesNotMatch(p, /ALTITUDE IS A REAL DEMAND/);
});

test("altitude_significant adds the acclimation demand and the projection caveat", async () => {
  const { race } = await loadRaceFolder(ROOT, "_fixtures/crewless-50k");
  const high = { ...race, elevation: { ...race.elevation, max_ft: 13100, altitude_significant: true } };
  const p = raceParagraph(high);

  assert.match(p, /ALTITUDE IS A REAL DEMAND HERE — the course spends its time near 13,100 ft/);
  assert.match(p, /acclimation and arrival timing as part of the plan/);
  assert.match(p, /caveat every projected pace, split and finish time as optimistic/);
});

/* -------- (b2) tune-up races inside the block (PRD-v2 §3) -------- */

test("two tune-up races: the paragraph names both and says to plan around them", async () => {
  const { race } = await loadRaceFolder(ROOT, "_fixtures/crewless-50k");
  const p = raceParagraph({
    ...race,
    b_races: [
      { slug: "cinder-cone-25k-2027", name: "Cinder Cone 25K", date: "2027-02-27", distance_mi: 15.5, gain_ft: 2200, weeks_out: 11 },
      { slug: "jemez-mountain-50k-2027", name: "Jemez Mountain 50K", date: "2027-05-08", distance_mi: 31, gain_ft: 5000, weeks_out: 1 },
    ],
  }, { daysUntil: 240 });

  assert.match(
    p,
    /Tune-up races already entered inside this block: Cinder Cone 25K on 2027-02-27, 11 weeks out \(15\.5 mi \/ 2,200 ft\); Jemez Mountain 50K on 2027-05-08, 1 week out \(31 mi \/ 5,000 ft\)\./,
  );
  assert.match(p, /real race efforts on fixed dates, not sessions you can move/);
  assert.match(p, /short taper into each one and a recovery week out of it/);
  assert.match(p, /count its distance and vert inside that week's volume rather than on top of it/);
  assert.match(p, /facts\.race\.b_races/);
  // and the race's own sentences are untouched by the addition
  assert.match(p, /Its 5 aid stations —/);
});

test("a tune-up on race week, and one stranded after race day, both read correctly", async () => {
  const { race } = await loadRaceFolder(ROOT, "_fixtures/crewless-50k");
  const p = raceParagraph({
    ...race,
    b_races: [
      { slug: "shakeout-10k-2027", name: "Shakeout 10K", date: "2027-05-15", distance_mi: 6.2, gain_ft: 400, weeks_out: 0 },
      { slug: "late-50k-2027", name: "Late 50K", date: "2027-06-12", distance_mi: 31, gain_ft: 3000, weeks_out: -4 },
    ],
  });
  assert.match(p, /Shakeout 10K on 2027-05-15, race week \(6\.2 mi \/ 400 ft\)/);
  assert.match(p, /Late 50K on 2027-06-12, 4 weeks AFTER race day — it is outside this block/);
});

test("no tune-ups: the paragraph says nothing about them at all", async () => {
  const { race } = await loadRaceFolder(ROOT, "_fixtures/crewless-50k");
  for (const b_races of [undefined, [], null]) {
    assert.doesNotMatch(raceParagraph({ ...race, b_races }), /Tune-up races/);
  }
});

/* -------- (c) generic mode -------- */

test("generic mode: a goals paragraph, a rolling window, no race week", () => {
  const f = coachFocus({ race: null, goals: GOALS, block: { mode: "rolling", total_weeks: 12 } });

  assert.equal(f.training_for, goalsParagraph(GOALS));
  assert.match(f.training_for, /NO RACE IS ACTIVE/);
  assert.match(f.training_for, /100 mi mountain race \(next A-race ~Aug 2027\)/);
  assert.match(f.training_for, /"return_to_run" phase/);
  assert.match(f.training_for, /0-25 mi and 0-3,000 ft of vert/);
  assert.match(f.training_for, /shin niggle/);
  assert.match(f.block_phrase, /rolling 12-week training window/);
  assert.match(f.wk_comment, /wk 12 is the CURRENT week/);
  assert.match(f.shape_line, /no race week/);
  assert.match(f.user_horizon, /toward 100 mi mountain race/);
  // never name a file the athlete's race used to live in
  assert.doesNotMatch(f.state_line, /races\//);
});

test("generic mode with no goals file at all still produces a prompt", () => {
  const f = coachFocus({ race: null, block: { mode: "rolling", total_weeks: 12 } });
  assert.match(f.training_for, /no named event/);
  assert.match(f.training_for, /unset mi and unset ft/);
  assert.match(f.shape_line, /phase \(unset\)/);
  const sys = readoutSystemPrompt({ race: null, block: { mode: "rolling", total_weeks: 12 } }, {}, {});
  assert.match(sys, /rolling 12-week training window/);
  // nothing in generic mode may point at a race week that does not exist
  assert.match(sys, /There is no race week and no taper to build toward\./);
  assert.doesNotMatch(sys, /before race week/);
  assert.doesNotMatch(sys, /race week = wk/);
});

/* -------- history -------- */

test("history reaches both prompts, with the result when there is one", () => {
  const facts = {
    race: null,
    goals: GOALS,
    block: { mode: "rolling", total_weeks: 12 },
    history: [
      { slug: "some-race-2026", name: "Some Race 100", date: "2026-09-12", result: { status: "finished", finish_h: 33.27 }, agent_notes: [] },
    ],
  };
  for (const sys of [
    readoutSystemPrompt(facts, {}, {}),
    chatSystemPrompt(facts, {}, { factsPath: "/tmp/f.json", coachPath: "/tmp/c.json" }),
  ]) {
    assert.match(sys, /facts\.history — Some Race 100 \(2026-09-12, finished in 33\.27 h\)/);
  }
  // a first-race athlete is not told about an empty array
  assert.doesNotMatch(readoutSystemPrompt({ race: null, history: [] }, {}, {}), /facts\.history/);
});

/* -------- the two prompts agree -------- */

test("the chat prompt is built from the same race paragraph as the readout", async (t) => {
  const race = await mm100();
  if (!race) return t.skip(`races/${MM100}/ not in this checkout`);
  const facts = { race, block: { mode: "race", total_weeks: 20 }, history: [] };
  const paragraph = raceParagraph(race);
  const chat = chatSystemPrompt(facts, { athlete_name: "A" }, { factsPath: "/tmp/f.json", coachPath: "/tmp/c.json", root: ROOT });
  const readout = readoutSystemPrompt(facts, { athlete_name: "A" }, { root: ROOT });

  assert.ok(chat.includes(paragraph), "chat prompt lost the shared race paragraph");
  assert.ok(readout.includes(paragraph), "readout prompt lost the shared race paragraph");
  // the chat prompt states the same plan_blocks wk contract
  assert.match(chat, /wk is the week number in the active race block, 1\.\.20/);
  assert.match(chat, /races\/mogollon-monster-100-2026\/race\.json/);
});

test("no race is named in the module itself — every race clause comes from config", async () => {
  const src = await fs.readFile(path.join(ROOT, "scripts", "coach-prompt.mjs"), "utf8");
  assert.doesNotMatch(src, /Mogollon/i);
  assert.doesNotMatch(src, /102\.6|15,900/);
});

test("both coach paths spawn the same model", async () => {
  // the readout script and the module it takes its default from
  assert.equal(MODEL_DEFAULT, COACH_MODEL);
  assert.ok(COACH_MODEL.trim(), "COACH_MODEL must resolve to a model id");
  // the chat endpoint: it can't be imported (TS), so pin that it resolves the
  // model through this module rather than declaring its own literal
  const vite = await fs.readFile(path.join(ROOT, "web", "vite.config.ts"), "utf8");
  assert.match(vite, /coachPrompt\.COACH_MODEL/);
  assert.doesNotMatch(vite, /const COACH_MODEL =/);
  assert.match(vite, /scripts\/coach-prompt\.mjs/);
});

/* -------- the Read allowlist -------- */

test("raceReadPaths names only files that exist", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coach-prompt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "races", "x-100");
  await fs.mkdir(path.join(dir, "build"), { recursive: true });

  assert.deepEqual(raceReadPaths(root, { slug: "x-100" }), []);
  await fs.writeFile(path.join(dir, "race.json"), "{}");
  assert.deepEqual(raceReadPaths(root, { slug: "x-100" }), [path.join("races", "x-100", "race.json")]);
  await fs.writeFile(path.join(dir, "build", "course.json"), "{}");
  assert.deepEqual(raceReadPaths(root, { slug: "x-100" }), [
    path.join("races", "x-100", "race.json"),
    path.join("races", "x-100", "build", "course.json"),
  ]);
  // generic mode has no folder to offer
  assert.deepEqual(raceReadPaths(root, null), []);
});

/* -------- race state: the planner's numbers the client sends (PRD-v2 §6) -------- */

/** A full race_state as the dashboard sends it, with every field populated —
    the worst case for size, and the snapshot the block is pinned against. */
const RACE_STATE = {
  mode: "view",
  slug: "some-race-2026",
  name: "Some Race 100",
  goal: { projected_h: 33.27, target_h: 34, label: "sub-34", start_clock: "05:00", finish_clock: "14:16" },
  knobs: { pace_factor: 1.05, aid_min: 6, night_slowdown_pct: 12, heat_adjust: true },
  fuel: { carb_g_h: 70, fluid_ml_h: 600, sodium_mg_h: 700, caffeine_mg_total: 400 },
  stations: [
    { name: "Geronimo", mi: 12.4, clock: "08:41", cutoff_clock: "10:30" },
    { name: "Washington Park", mi: 43.2, clock: "14:02" },
  ],
  status: { block_stale: false, unresolved: 2, activated: true },
  checkpoint: { name: "Washington Park", mi: 43.2, clock: "14:02", delta_min: -12, source: "tracker" },
};

test("the block renders every part of the planner state, labelled and with units", () => {
  const { state, error } = parseRaceState(RACE_STATE);
  assert.equal(error, undefined);
  const b = raceStateBlock(state);

  assert.match(b, /^RACE STATE \(from the athlete's own planner\) — Some Race 100/);
  // the preamble that makes the provenance explicit — these numbers are the
  // athlete's, not something the agent should recompute or look up
  assert.match(b, /athlete's OWN planner output as of this message/);
  assert.match(b, /they exist nowhere on disk, so there is no file to check them against/);
  assert.match(b, /- Finish: the planner projects 33:16 \(33\.27 h\); their target is 34:00 \(34 h\); goal "sub-34"; start 05:00; finishing around 14:16\./);
  assert.match(b, /- Planner knobs as they have them set: pace_factor 1\.05, aid_min 6, night_slowdown_pct 12, heat_adjust true\./);
  assert.match(b, /- Fuel plan: 70 g carb\/h, 600 ml fluid\/h, 700 mg sodium\/h, 400 mg caffeine total\./);
  assert.match(b, /- Expected arrival at each aid station, on their plan: Geronimo \(mi 12\.4\) 08:41, cutoff 10:30; Washington Park \(mi 43\.2\) 14:02\./);
  assert.match(b, /- Plan status: the training block is up to date with this plan; 2 unresolved review items they have not answered; the plan is activated\./);
  assert.match(b, /- Last checkpoint \(tracker\): Washington Park, mile 43\.2 at 14:02, 12 min AHEAD of plan\./);
});

test("view mode says the race is only being looked at; train mode says it is theirs", () => {
  const view = raceStateBlock(parseRaceState(RACE_STATE).state);
  const train = raceStateBlock(parseRaceState({ ...RACE_STATE, mode: "train" }).state);
  assert.match(view, /which they are LOOKING AT in the dashboard right now\. It is not their active race/);
  assert.match(train, /the race they are training for and have open in the dashboard\./);
  assert.doesNotMatch(train, /LOOKING AT/);
});

test("a stale block, unanswered items and an unactivated plan all read as problems", () => {
  const b = raceStateBlock(parseRaceState({
    mode: "train",
    name: "X",
    status: { block_stale: true, unresolved: 1, activated: false },
  }).state);
  assert.match(b, /the training block is STALE against this plan \(a re-plan is pending\)/);
  assert.match(b, /1 unresolved review item they have not answered/);
  assert.match(b, /the plan is NOT activated yet/);
});

test("a checkpoint behind plan, and one exactly on it, are not phrased the same", () => {
  const behind = raceStateBlock(parseRaceState({ mode: "train", name: "X", checkpoint: { name: "Pinchot", mi: 20, clock: "09:10", delta_min: 18, source: "manual" } }).state);
  const onPlan = raceStateBlock(parseRaceState({ mode: "train", name: "X", checkpoint: { name: "Pinchot", mi: 20, clock: "09:10", delta_min: 0 } }).state);
  assert.match(behind, /- Last checkpoint \(manual\): Pinchot, mile 20 at 09:10, 18 min BEHIND plan\./);
  assert.match(onPlan, /- Last checkpoint: Pinchot, mile 20 at 09:10, exactly on plan\./);
});

test("a race open with no numbers yet says so instead of inviting invention", () => {
  const b = raceStateBlock(parseRaceState({ mode: "train", name: "Fresh 50K" }).state);
  assert.match(b, /the planner has produced no numbers for it yet — do not invent any/);
  assert.doesNotMatch(b, /^- /m);
});

test("no state at all renders nothing — generic mode has no block", () => {
  assert.equal(raceStateBlock(null), "");
  assert.equal(parseRaceState(undefined).state, null);
  assert.equal(parseRaceState(null).state, null);
});

/* -------- validation: what the endpoint accepts -------- */

test("mode is required and only train|view — generic mode has no race_state to send", () => {
  for (const mode of [undefined, null, "", "generic", "Train", 1, {}]) {
    const r = parseRaceState({ mode, name: "X" });
    assert.match(r.error ?? "", /mode must be "train" or "view"/, `mode ${JSON.stringify(mode)} was accepted`);
    assert.equal(r.state, undefined);
  }
  for (const mode of ["train", "view"]) {
    assert.equal(parseRaceState({ mode }).error, undefined);
  }
});

test("a race_state that is not an object is rejected outright", () => {
  for (const raw of ["{}", 7, true, [], [{ mode: "train" }]]) {
    assert.match(parseRaceState(raw).error ?? "", /must be an object/, `${JSON.stringify(raw)} was accepted`);
  }
});

test("over the size cap is rejected, and the message says by how much", () => {
  const fat = {
    mode: "train",
    name: "X",
    stations: Array.from({ length: 300 }, (_, i) => ({ name: `Aid station number ${i} with a long name`, mi: i, clock: "08:41" })),
  };
  const bytes = Buffer.byteLength(JSON.stringify(fat), "utf8");
  assert.ok(bytes > RACE_STATE_MAX_BYTES, "fixture is not actually oversize");
  const r = parseRaceState(fat);
  assert.equal(r.state, undefined);
  assert.match(r.error, new RegExp(`race_state is ${bytes} bytes, over the ${RACE_STATE_MAX_BYTES}-byte limit`));
  // and one just under the cap is accepted
  assert.equal(parseRaceState({ mode: "train", name: "X".repeat(80), stations: fat.stations.slice(0, 20) }).error, undefined);
});

test("unknown keys are dropped, not rejected — the dashboard may run ahead of this renderer", () => {
  const { state, error } = parseRaceState({
    mode: "train",
    name: "X",
    weather_model: { wind: 12 },
    crew: ["someone"],
    knobs: { pace_factor: 1.05 },
    fuel: { carb_g_h: 70, unknown_unit: 9 },
    stations: [{ name: "A", mi: 1, clock: "06:00", surprise: true }],
    status: { block_stale: false, brand_new_flag: "x" },
    checkpoint: { name: "A", clock: "06:00", nonsense: 1 },
  });
  assert.equal(error, undefined);
  assert.deepEqual(Object.keys(state).sort(), ["checkpoint", "fuel", "knobs", "mode", "name", "stations", "status"]);
  assert.deepEqual(state.fuel, { carb_g_h: 70 });
  assert.deepEqual(state.stations, [{ name: "A", mi: 1, clock: "06:00" }]);
  assert.deepEqual(state.status, { block_stale: false });
  assert.deepEqual(state.checkpoint, { name: "A", clock: "06:00" });
  // the dropped keys never reach the prompt
  const b = raceStateBlock(state);
  assert.doesNotMatch(b, /surprise|nonsense|brand_new_flag|unknown_unit|weather_model/);
});

test("wrong-typed known fields are dropped rather than printed as garbage", () => {
  const { state } = parseRaceState({
    mode: "train",
    name: 42,
    goal: { target_h: "34", projected_h: Number.NaN, label: "   " },
    knobs: { pace_factor: {}, aid_min: 6 },
    stations: [{ mi: 4, clock: "07:00" }, "nope", { name: "B", mi: "far" }],
    status: { block_stale: "yes", unresolved: Number.POSITIVE_INFINITY },
    checkpoint: { source: "guess", name: "C" },
  });
  assert.equal(state.name, undefined);
  assert.equal(state.goal, undefined, "a goal whose every field was invalid should not survive as {}");
  assert.deepEqual(state.knobs, { aid_min: 6 });
  assert.deepEqual(state.stations, [{ name: "B" }], "a station with no name is not an ETA");
  assert.equal(state.status, undefined);
  assert.deepEqual(state.checkpoint, { name: "C" }, "an unrecognized checkpoint source is dropped, not echoed");
  const b = raceStateBlock(state);
  assert.doesNotMatch(b, /undefined|NaN|Infinity|\[object Object\]/);
});

test("strings are truncated rather than trusted, and the station list is capped", () => {
  const { state } = parseRaceState({
    mode: "train",
    name: "N".repeat(400),
    stations: Array.from({ length: 90 }, (_, i) => ({ name: `S${i}` })),
  });
  assert.equal(state.name.length, 120);
  assert.equal(state.stations.length, 40);
});

/* -------- the block in the chat prompt, and only there -------- */

const CHAT_OPTS = { factsPath: "/tmp/f.json", coachPath: "/tmp/c.json" };
const GENERIC_FACTS = { race: null, goals: GOALS, block: { mode: "rolling", total_weeks: 12 } };

test("the chat prompt carries the block verbatim when race_state is sent", () => {
  const { state } = parseRaceState(RACE_STATE);
  const sys = chatSystemPrompt(GENERIC_FACTS, { athlete_name: "A" }, { ...CHAT_OPTS, raceState: state });
  assert.ok(sys.includes(raceStateBlock(state)), "chat prompt does not contain the rendered block");
  // it sits above the file list, where the reading-budget instructions can
  // point the agent at what it already has
  assert.ok(sys.indexOf("RACE STATE") < sys.indexOf("You have full read access to:"));
});

test("no race_state means no block anywhere in the prompt", () => {
  for (const opts of [CHAT_OPTS, { ...CHAT_OPTS, raceState: null }, { ...CHAT_OPTS, raceState: undefined }]) {
    const sys = chatSystemPrompt(GENERIC_FACTS, { athlete_name: "A" }, opts);
    assert.doesNotMatch(sys, /RACE STATE/);
    assert.doesNotMatch(sys, /own planner/);
  }
});

test("race_state never touches the readout path — coach.mjs sends none", async () => {
  const { state } = parseRaceState(RACE_STATE);
  const before = readoutSystemPrompt(GENERIC_FACTS, { athlete_name: "A" }, {});
  // the readout prompt takes no such option, so passing one changes nothing
  const after = readoutSystemPrompt(GENERIC_FACTS, { athlete_name: "A" }, { raceState: state });
  assert.equal(before, after);
  assert.doesNotMatch(before, /RACE STATE/);
  // and the readout script does not send one
  const coachSrc = await fs.readFile(path.join(ROOT, "scripts", "coach.mjs"), "utf8");
  assert.doesNotMatch(coachSrc, /raceState|race_state/);
});

test("the block is built from the object alone — it never reads from disk", () => {
  // Called with a root that does not exist and a cwd that has no races/: a
  // renderer that fell back to a file would answer about a different race
  // than the one on the athlete's screen, so prove it cannot.
  const { state } = parseRaceState({ ...RACE_STATE, name: "Not On Disk 100", slug: "not-on-disk-100" });
  const b = raceStateBlock(state);
  assert.match(b, /Not On Disk 100/);
  const sys = chatSystemPrompt({ race: null, block: { mode: "rolling", total_weeks: 12 } }, {}, {
    factsPath: "/tmp/f.json", coachPath: "/tmp/c.json", root: "/nonexistent-root", raceState: state,
  });
  assert.match(sys, /Not On Disk 100/);
  // and the section that implements it touches no filesystem API at all
  const src = fsSync.readFileSync(path.join(ROOT, "scripts", "coach-prompt.mjs"), "utf8");
  const from = src.indexOf("/* -------- race state: the planner's own numbers, sent by the client -------- */");
  const to = src.indexOf("/* -------- what the agent may Read -------- */");
  assert.ok(from > 0 && to > from, "the race-state section moved — this guard needs its new bounds");
  assert.doesNotMatch(src.slice(from, to), /readFileSync|existsSync|readdir|fs\./);
});

/* -------- the token cost, measured -------- */

test("estimateTokens is chars/4, rounded up, and zero for nothing", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens("x".repeat(4000)), 1000);
});

test("a full race_state costs well under the warning threshold", () => {
  const b = raceStateBlock(parseRaceState(RACE_STATE).state);
  const tokens = estimateTokens(b);
  assert.ok(tokens > 0);
  assert.ok(
    tokens < RACE_STATE_WARN_TOKENS,
    `a fully-populated two-station block is ~${tokens} tokens, at or over the ~${RACE_STATE_WARN_TOKENS}-token warning threshold`,
  );
});

test("MM100's real aid-station table fits the cap and stays inside the budget", async (t) => {
  const race = await mm100();
  if (!race) return t.skip(`races/${MM100}/ not in this checkout`);
  // The shape the client sends in view mode: one ETA per real aid station.
  const stations = race.aid_stations.map((a, i) => ({
    name: a.name,
    mi: a.mile,
    clock: `${String(5 + Math.floor(i * 2)).padStart(2, "0")}:15`,
    cutoff_clock: a.cutoff_h != null ? `${String(Math.floor(a.cutoff_h)).padStart(2, "0")}:00` : undefined,
  }));
  const raw = { ...RACE_STATE, mode: "view", slug: MM100, name: race.name, stations };
  const bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  assert.ok(bytes <= RACE_STATE_MAX_BYTES, `MM100 race_state is ${bytes} bytes, over the ${RACE_STATE_MAX_BYTES}-byte cap`);

  const { state, error } = parseRaceState(raw);
  assert.equal(error, undefined);
  assert.equal(state.stations.length, race.aid_stations.length);
  const tokens = estimateTokens(raceStateBlock(state));
  assert.ok(
    tokens < RACE_STATE_WARN_TOKENS,
    `MM100 in view mode renders ~${tokens} tokens, at or over the ~${RACE_STATE_WARN_TOKENS}-token warning threshold`,
  );
  // Recorded so a change in phrasing that doubles the per-turn cost shows up
  // as a failing number rather than a slightly longer prompt nobody measured.
  console.log(`[measured] MM100 view-mode race_state: ${bytes} bytes on the wire, block ~${tokens} tokens (${race.aid_stations.length} stations)`);
});
