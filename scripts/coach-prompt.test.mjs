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
  chatSystemPrompt,
  coachFocus,
  goalsParagraph,
  raceParagraph,
  raceReadPaths,
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
