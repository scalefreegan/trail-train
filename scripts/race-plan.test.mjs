// node --test scripts/race-plan.test.mjs   (or: cd web && npm test)
//
// Intake stage 3. Nothing here spawns an agent and nothing writes into races/:
// the block calendar, the output contract and the merge are pure functions, and
// the only end-to-end path exercised is `planRace`'s dry run over a temp-dir
// copy of the MM100 folder.
//
// The prompt assertions are snapshot-ish in the same sense as
// scripts/coach-prompt.test.mjs: they pin the SENTENCES the agent actually
// reads rather than a byte-exact fixture, because a prompt that silently loses
// the taper rule or the drop-bag list still looks like a prompt. A byte-exact
// snapshot would also break the moment config/profile.example.json gains its
// physiology block (tt-yib.9), which is a change to somebody else's file, not
// a regression in this one.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COACH_NOTE_KEYS,
  DELOAD_RATIO,
  MAX_BLOCK_WEEKS,
  MAX_COACH_NOTE_CHARS,
  blockUnavailableReason,
  buildPlanPrompt,
  mergeRaceUpdates,
  nextMonday,
  planRace,
  planWindow,
  validateBlockTargets,
  validateNutrition,
  validatePlanOutput,
  weekRoles,
} from "./race-plan.mjs";
import { THEME_PRESET_NAMES } from "../web/src/themes/presets.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MM100 = "mogollon-monster-100-2026";

/* The app's own nutrition loader — the pure half nutrition.ts re-exports,
   split out by tt-yib.9 so Node can load it without React. race-plan.mjs runs
   it as a backstop; this file asserts on it directly too, so a change that
   made the two disagree would show up as a test failure rather than as a
   dashboard quietly rendering built-in defaults. */
import { normalizeNutrition } from "../web/src/race/nutrition-config.ts";

const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));

/** The archived MM100 folder, or null when this checkout doesn't carry it. */
async function mm100() {
  try {
    return {
      race: await readJson(path.join(ROOT, "races", MM100, "race.json")),
      block: await readJson(path.join(ROOT, "races", MM100, "block.json")),
      nutrition: await readJson(path.join(ROOT, "races", MM100, "nutrition.json")),
    };
  } catch {
    return null;
  }
}

/* ------------------------- the block calendar --------------------------- */

test("nextMonday is always a Monday, always in the future", () => {
  // every weekday of one week, plus a leap day and a year boundary
  const days = [
    "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17",
    "2026-09-18", "2026-09-19", "2026-09-20",
    "2028-02-29", "2026-12-31",
  ];
  for (const d of days) {
    const [y, m, day] = d.split("-").map(Number);
    const today = new Date(y, m - 1, day);
    const got = nextMonday(today);
    const [gy, gm, gd] = got.split("-").map(Number);
    const asDate = new Date(gy, gm - 1, gd);
    assert.equal(asDate.getDay(), 1, `${d} → ${got} is not a Monday`);
    assert.ok(asDate.getTime() > today.getTime(), `${d} → ${got} is not in the future`);
    assert.ok((asDate - today) / 86400000 <= 7, `${d} → ${got} is more than a week out`);
  }
  // a Monday gets the NEXT Monday, not itself
  assert.equal(nextMonday(new Date(2026, 8, 14)), "2026-09-21");
});

test("planWindow counts back from race day and ends on race week", () => {
  const race = { date: "2027-08-13" }; // a Friday
  const w = planWindow(race, { today: new Date(2027, 5, 1) }); // Tue 2027-06-01
  assert.equal(w.start_date, "2027-06-07"); // the Monday after 06-01
  assert.equal(w.total_weeks, 10);
  assert.equal(w.race_week, 10);
  assert.equal(w.truncated, false);
  // week N contains race day
  const [y, m, d] = w.start_date.split("-").map(Number);
  const raceWeekMonday = new Date(y, m - 1, d + 7 * (w.total_weeks - 1));
  const raceDay = new Date(2027, 7, 13);
  const delta = (raceDay - raceWeekMonday) / 86400000;
  assert.ok(delta >= 0 && delta < 7, `race day sits ${delta} days into week ${w.total_weeks}`);
});

test("planWindow caps at 24 weeks by moving the START, never the finish", () => {
  const race = { date: "2027-08-13" };
  const w = planWindow(race, { today: new Date(2026, 8, 18) }); // ~47 weeks out
  assert.equal(w.total_weeks, MAX_BLOCK_WEEKS);
  assert.equal(w.truncated, true);
  assert.equal(w.race_week, MAX_BLOCK_WEEKS);
  // start is 23 weeks before race week's Monday, and comfortably in the future
  assert.equal(w.start_date, "2027-03-01");
  assert.ok(w.start_date > "2026-09-18");
});

test("no plannable block: no date, a past date, and a race too close", () => {
  const today = new Date(2026, 8, 18);
  assert.equal(planWindow({ date: null }, { today }), null);
  assert.match(blockUnavailableReason({ date: null }, { today }), /no usable date/);

  assert.equal(planWindow({ date: "not-a-date" }, { today }), null);
  assert.equal(planWindow({ date: "2026-02-30" }, { today }), null); // rollover date

  assert.equal(planWindow({ date: "2026-09-12" }, { today }), null);
  assert.match(blockUnavailableReason({ date: "2026-09-12" }, { today }), /not in the future.*history/);

  assert.equal(planWindow({ date: "2026-10-03" }, { today }), null); // 2 weeks out
  assert.match(blockUnavailableReason({ date: "2026-10-03" }, { today }), /only 2 full weeks out/);

  // …and the first week that IS plannable
  assert.equal(planWindow({ date: "2026-10-10" }, { today }).total_weeks, 3);
  assert.equal(blockUnavailableReason({ date: "2026-10-10" }, { today }), null);
});

test("weekRoles: race week last, two taper weeks, the rest build", () => {
  assert.deepEqual(weekRoles(20).build, Array.from({ length: 17 }, (_, i) => i + 1));
  assert.deepEqual(weekRoles(20).taper, [18, 19]);
  assert.equal(weekRoles(20).raceWeek, 20);
  // a three-week window is race week plus a taper and has no build at all
  assert.deepEqual(weekRoles(3), { build: [], taper: [1, 2], raceWeek: 3 });
});

/* --------------------------- block targets ------------------------------ */

/** A well-shaped 12-week block: three loading cycles, deloads, taper, race. */
const GOOD_TARGETS = [
  { wk: 1, target_dist: 30, target_elev: 4000 },
  { wk: 2, target_dist: 36, target_elev: 5000 },
  { wk: 3, target_dist: 42, target_elev: 6000 },
  { wk: 4, target_dist: 28, target_elev: 3600 },
  { wk: 5, target_dist: 46, target_elev: 6800 },
  { wk: 6, target_dist: 52, target_elev: 7800 },
  { wk: 7, target_dist: 34, target_elev: 4400 },
  { wk: 8, target_dist: 56, target_elev: 8600 },
  { wk: 9, target_dist: 60, target_elev: 9200 },
  { wk: 10, target_dist: 28, target_elev: 3800 },
  { wk: 11, target_dist: 18, target_elev: 2200 },
  { wk: 12, target_dist: 104, target_elev: 19000 },
];
const RACE_12 = { distance_mi: 104, gain_ft: 19000, cutoff_h: 38 };

const clone = (v) => structuredClone(v);

test("a well-shaped block passes every rule", () => {
  const { errors } = validateBlockTargets(GOOD_TARGETS, { total_weeks: 12, race: RACE_12 });
  assert.deepEqual(errors, []);
});

test("the hand-authored MM100 block is a legal block", async (t) => {
  const mm = await mm100();
  if (!mm) return t.skip(`races/${MM100}/ not in this checkout`);
  const { errors } = validateBlockTargets(mm.block.targets, {
    total_weeks: mm.block.total_weeks,
    race: mm.race,
  });
  assert.deepEqual(errors, [], "the worked example must satisfy the rules the agent is held to");
});

test("four straight loading weeks is rejected", () => {
  const t = clone(GOOD_TARGETS);
  t[3].target_dist = 44; // wk 4 was the deload
  const { errors } = validateBlockTargets(t, { total_weeks: 12, race: RACE_12 });
  assert.ok(errors.some((e) => /no deload/.test(e)), errors.join(" | "));
});

test("a 4% dip is not a deload", () => {
  const t = clone(GOOD_TARGETS);
  t[3].target_dist = +(t[2].target_dist * 0.97).toFixed(1); // above DELOAD_RATIO
  assert.ok(0.97 > DELOAD_RATIO);
  const { errors } = validateBlockTargets(t, { total_weeks: 12, race: RACE_12 });
  assert.ok(errors.some((e) => /no deload/.test(e)), errors.join(" | "));
});

/** 12 weeks from [dist, vert] pairs — the shape tests read better as tables. */
const mkTargets = (rows) => rows.map(([d, e], i) => ({ wk: i + 1, target_dist: d, target_elev: e }));

test("the build may not sag on its way up", () => {
  //            wk1  2   3  |  4   5  |  6   7   8   9  | taper   | race
  const rows = [30, 36, 42, 28, 30, 20, 40, 50, 60, 28, 18, 104];
  const t = mkTargets(rows.map((d) => [d, Math.round(d * 150)]));
  t[11].target_elev = 19000;
  // cycle peaks 42 → 30 → 60: the block still climbs after the 30, so the 30
  // is a sag in the build, not a step down from the peak
  const { errors } = validateBlockTargets(t, { total_weeks: 12, race: RACE_12 });
  assert.ok(errors.some((e) => /not monotone/.test(e)), errors.join(" | "));
});

test("the build may not climb again after its peak", () => {
  //            wk1  2   3  |  4   5   6  |  7  |  8   9  | taper   | race
  const rows = [30, 36, 42, 28, 55, 70, 36, 30, 50, 28, 18, 104];
  const t = mkTargets(rows.map((d) => [d, Math.round(d * 150)]));
  t[11].target_elev = 19000;
  // cycle peaks 42 → 70 → 36 → 50: the last cycle re-climbs past the one before
  const { errors } = validateBlockTargets(t, { total_weeks: 12, race: RACE_12 });
  assert.ok(errors.some((e) => /climbs again after its peak/.test(e)), errors.join(" | "));
});

test("the taper's two weeks must be at or under half the peak, and descend", () => {
  const over = clone(GOOD_TARGETS);
  over[9].target_dist = 40; // peak is 60 → ceiling 30
  let { errors } = validateBlockTargets(over, { total_weeks: 12, race: RACE_12 });
  assert.ok(errors.some((e) => /taper week 10 is 40 mi/.test(e)), errors.join(" | "));

  const vert = clone(GOOD_TARGETS);
  vert[10].target_elev = 8000; // peak vert 9,200 → ceiling 4,600
  ({ errors } = validateBlockTargets(vert, { total_weeks: 12, race: RACE_12 }));
  assert.ok(errors.some((e) => /taper week 11 is 8,000 ft/.test(e)), errors.join(" | "));

  const up = clone(GOOD_TARGETS);
  up[10].target_dist = 29; // wk 11 above wk 10's 28
  ({ errors } = validateBlockTargets(up, { total_weeks: 12, race: RACE_12 }));
  assert.ok(errors.some((e) => /taper goes back up/.test(e)), errors.join(" | "));
});

test("race week's target is the race", () => {
  const t = clone(GOOD_TARGETS);
  t[11].target_dist = 40;
  const { errors } = validateBlockTargets(t, { total_weeks: 12, race: RACE_12 });
  assert.ok(errors.some((e) => /race week 12 is 40 mi/.test(e)), errors.join(" | "));
});

test("the week count and the week numbering are the calendar's, not the agent's", () => {
  let { errors } = validateBlockTargets(GOOD_TARGETS.slice(0, 11), { total_weeks: 12, race: RACE_12 });
  assert.ok(errors.some((e) => /12 weeks required/.test(e)), errors.join(" | "));

  const shuffled = clone(GOOD_TARGETS);
  shuffled[4].wk = 9;
  ({ errors } = validateBlockTargets(shuffled, { total_weeks: 12, race: RACE_12 }));
  assert.ok(errors.some((e) => /wk must be 5/.test(e)), errors.join(" | "));
});

/* ------------------------------ nutrition -------------------------------- */

/** The MM100 nutrition file as stage 3 would have to emit it: no body_kg. */
async function mm100Nutrition() {
  const mm = await mm100();
  if (!mm) return null;
  const n = clone(mm.nutrition);
  delete n.caffeine.body_kg;
  return n;
}

test("the hand-authored MM100 nutrition plan passes this stage's validator", async (t) => {
  const mm = await mm100();
  const n = await mm100Nutrition();
  if (!n) return t.skip(`races/${MM100}/ not in this checkout`);
  const { errors } = validateNutrition(n, mm.race);
  assert.deepEqual(errors, []);
});

test("…and the app's own loader accepts it too", async (t) => {
  const n = await mm100Nutrition();
  if (!n) return t.skip(`races/${MM100}/ not in this checkout`);
  const merged = normalizeNutrition(n);
  assert.notEqual(merged, null, "normalizeNutrition rejected the plan outright");
  assert.equal(merged.phases.length, n.phases.length);
  assert.deepEqual(Object.keys(merged.drop_bag_gear).sort(), Object.keys(n.drop_bag_gear).sort());
});

test("drop_bag_gear is keyed by THIS race's bags, plus the vest", async (t) => {
  const mm = await mm100();
  const n = await mm100Nutrition();
  if (!n) return t.skip(`races/${MM100}/ not in this checkout`);

  n.drop_bag_gear["Pinchot Cabin"] = ["headlamp"]; // a real station, but no bag there
  let { errors } = validateNutrition(n, mm.race);
  assert.ok(errors.some((e) => /Pinchot Cabin.*not a drop-bag station/.test(e)), errors.join(" | "));

  delete n.drop_bag_gear["Pinchot Cabin"];
  delete n.drop_bag_gear["Geronimo"];
  const r = validateNutrition(n, mm.race);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /no gear listed for the drop bag at Geronimo/.test(w)), r.warnings.join(" | "));
});

test("heat_window only when features.heat", async (t) => {
  const mm = await mm100();
  const n = await mm100Nutrition();
  if (!n) return t.skip(`races/${MM100}/ not in this checkout`);

  const cold = { ...mm.race, features: { ...mm.race.features, heat: false } };
  let { errors } = validateNutrition(n, cold);
  assert.ok(errors.some((e) => /features.heat false — omit the window/.test(e)), errors.join(" | "));

  const noWindow = clone(n);
  delete noWindow.heat_window;
  assert.deepEqual(validateNutrition(noWindow, cold).errors, []);

  ({ errors } = validateNutrition(noWindow, mm.race));
  assert.ok(errors.some((e) => /heat_window.*required/.test(e)), errors.join(" | "));
});

test("the caffeine plan is scaled by cutoff_h, and carries no body mass", async (t) => {
  const mm = await mm100();
  const n = await mm100Nutrition();
  if (!n) return t.skip(`races/${MM100}/ not in this checkout`);

  // MM100's 9 doses on a 12-hour 50k: they cannot be placed at 1.75 h apart
  const short = { ...mm.race, cutoff_h: 12, features: { ...mm.race.features, heat: true } };
  const shortPlan = clone(n);
  shortPlan.phases = [{ until_h: 12, carb_g_hr: 75, bloks_frac: 0.4, supplement: "gels lead" }];
  let { errors } = validateNutrition(shortPlan, short);
  assert.ok(errors.some((e) => /9 doses cannot fit a 12 h race/.test(e)), errors.join(" | "));

  // the phase ladder has to reach the cutoff
  const truncated = clone(n);
  truncated.phases = truncated.phases.slice(0, 2); // ends at 24 h, cutoff is 38 h
  ({ errors } = validateNutrition(truncated, mm.race));
  assert.ok(errors.some((e) => /last phase ends at 24 h but the cutoff is 38 h/.test(e)), errors.join(" | "));

  // body_kg belongs to the athlete, not the race folder
  const withMass = clone(n);
  withMass.caffeine.body_kg = 79.4;
  ({ errors } = validateNutrition(withMass, mm.race));
  assert.ok(errors.some((e) => /body_kg.*profile/.test(e)), errors.join(" | "));
});

/* -------------------------- the output contract -------------------------- */

const OK_NOTES = Object.fromEntries(COACH_NOTE_KEYS.map((k) => [k, `Grounded prose about ${k}.`]));

/** A complete, contract-clean agent reply for the 12-week synthetic race. */
async function goodOutput() {
  const n = await mm100Nutrition();
  return {
    block: { targets: clone(GOOD_TARGETS) },
    nutrition: n,
    coach_notes: { ...OK_NOTES },
    links: { site: "https://example.org/race", manual: "" },
    visual: { theme_preset: "alpine", accent: "#7fb2d9" },
    unresolved: ["links.results"],
    review_notes: "three loading cycles, peak at week 9",
  };
}

/** The MM100 race, re-dated into the future so it has a 12-week window. */
async function race12() {
  const mm = await mm100();
  if (!mm) return null;
  return { ...mm.race, slug: "future-race-2027", status: "draft", date: "2027-08-13", distance_mi: 104, gain_ft: 19000 };
}

const WINDOW_12 = { start_date: "2027-05-24", total_weeks: 12, race_week: 12, race_date: "2027-08-13", truncated: false };

test("a clean plan validates, with the agent's unresolved list carried through", async (t) => {
  const race = await race12();
  if (!race) return t.skip(`races/${MM100}/ not in this checkout`);
  const r = validatePlanOutput(await goodOutput(), race, { window: WINDOW_12 });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.unresolved, ["links.results"]);
});

test("the theme preset must be one the app can actually apply", async (t) => {
  const race = await race12();
  if (!race) return t.skip(`races/${MM100}/ not in this checkout`);
  const out = await goodOutput();
  out.visual.theme_preset = "san-juan";
  const r = validatePlanOutput(out, race, { window: WINDOW_12 });
  assert.ok(r.errors.some((e) => e.includes(THEME_PRESET_NAMES.join(" | "))), r.errors.join(" | "));

  out.visual.theme_preset = "night";
  out.visual.accent = "cornflower";
  assert.ok(validatePlanOutput(out, race, { window: WINDOW_12 }).errors.some((e) => /accent must be a #rrggbb/.test(e)));
});

test("coach notes: all five sections, prose only, capped at 1200 chars", async (t) => {
  const race = await race12();
  if (!race) return t.skip(`races/${MM100}/ not in this checkout`);
  const out = await goodOutput();

  out.coach_notes.terrain = "x".repeat(MAX_COACH_NOTE_CHARS + 1);
  let r = validatePlanOutput(out, race, { window: WINDOW_12 });
  assert.ok(r.errors.some((e) => /coach_notes.terrain: 1201 chars/.test(e)), r.errors.join(" | "));

  out.coach_notes.terrain = "";
  r = validatePlanOutput(out, race, { window: WINDOW_12 });
  assert.deepEqual(r.errors, []);
  assert.ok(r.unresolved.includes("coach_notes.terrain"), "an empty section is an honest hole, and named as one");

  out.coach_notes = { ...OK_NOTES, pacing: "not a section" };
  r = validatePlanOutput(out, race, { window: WINDOW_12 });
  assert.ok(r.errors.some((e) => /coach_notes.pacing: not a coach_notes section/.test(e)), r.errors.join(" | "));

  delete out.coach_notes.pacing;
  delete out.coach_notes.race_week;
  r = validatePlanOutput(out, race, { window: WINDOW_12 });
  assert.ok(r.errors.some((e) => /coach_notes.race_week: string required/.test(e)), r.errors.join(" | "));
});

test("no race date: the block is unresolved, not an error", async (t) => {
  const mm = await mm100();
  if (!mm) return t.skip(`races/${MM100}/ not in this checkout`);
  const race = { ...mm.race, slug: "undated-race-2027", date: null };
  const out = await goodOutput();
  delete out.block;

  const r = validatePlanOutput(out, race, { today: new Date(2026, 8, 18) });
  assert.equal(r.ok, true, r.errors.join(" | "));
  assert.equal(r.window, null);
  assert.ok(r.unresolved.includes("block"));
  assert.ok(r.warnings.some((w) => /no block planned.*no usable date/.test(w)), r.warnings.join(" | "));

  // a block returned anyway is ignored with a warning, never written
  const withBlock = await goodOutput();
  const r2 = validatePlanOutput(withBlock, race, { today: new Date(2026, 8, 18) });
  assert.equal(r2.ok, true, r2.errors.join(" | "));
  assert.ok(r2.warnings.some((w) => /returned block targets for a race with no date/.test(w)));
});

test("links are URLs or an honest empty string, in the slots race.json has", async (t) => {
  const race = await race12();
  if (!race) return t.skip(`races/${MM100}/ not in this checkout`);
  const out = await goodOutput();
  out.links = { site: "aravaiparunning.com", socials: "https://example.org" };
  const r = validatePlanOutput(out, race, { window: WINDOW_12 });
  assert.ok(r.errors.some((e) => /links.site: an http\(s\) URL/.test(e)), r.errors.join(" | "));
  assert.ok(r.errors.some((e) => /links.socials: not a link slot/.test(e)), r.errors.join(" | "));
});

/* ------------------------------- the merge ------------------------------- */

test("every generated field is stamped {by: agent, source: race-plan}", () => {
  const race = {
    slug: "r", coach_notes: { terrain: "", climate: "", altitude: "", key_demands: "", race_week: "" },
    links: {}, visual: { panels: { crew_sheet: true } }, provenance: {},
  };
  const out = {
    coach_notes: { ...OK_NOTES },
    links: { site: "https://example.org", manual: "https://example.org/manual.pdf" },
    visual: { theme_preset: "forest", accent: "#3d7a52" },
  };
  const { race: next, written, skipped } = mergeRaceUpdates(race, out, { at: "2026-09-18T12:00:00.000Z" });

  assert.deepEqual(skipped, []);
  for (const field of [...COACH_NOTE_KEYS.map((k) => `coach_notes.${k}`), "links.site", "links.manual", "visual.theme_preset", "visual.accent"]) {
    assert.ok(written.includes(field), `${field} not written`);
    assert.deepEqual(next.provenance[field], { by: "agent", at: "2026-09-18T12:00:00.000Z", source: "race-plan" });
  }
  assert.equal(next.visual.theme_preset, "forest");
  // untouched keys survive the merge
  assert.deepEqual(next.visual.panels, { crew_sheet: true });
  // the input is not mutated
  assert.equal(race.visual.theme_preset, undefined);
});

test("a field the owner authored is never overwritten", () => {
  const race = {
    slug: "r",
    coach_notes: { terrain: "MY words", climate: "", altitude: "", key_demands: "", race_week: "" },
    links: { site: "https://the-owner-pasted-this.example" },
    visual: { theme_preset: "desert" },
    provenance: {
      "coach_notes.terrain": { by: "user", at: "2026-01-01T00:00:00Z" },
      visual: { by: "user", at: "2026-01-01T00:00:00Z" },
    },
  };
  const out = {
    coach_notes: { ...OK_NOTES },
    links: { site: "https://second-best.example", tracking: "https://live.example" },
    visual: { theme_preset: "night", accent: "#000000" },
  };
  const { race: next, written, skipped } = mergeRaceUpdates(race, out);

  assert.equal(next.coach_notes.terrain, "MY words");
  assert.equal(next.coach_notes.climate, OK_NOTES.climate, "the other four sections still get written");
  // a user stamp on the PARENT protects every child path under it
  assert.equal(next.visual.theme_preset, "desert");
  assert.equal(next.visual.accent, undefined);
  for (const f of ["coach_notes.terrain", "visual.theme_preset", "visual.accent"]) {
    assert.ok(skipped.includes(f), `${f} should have been skipped`);
    assert.ok(!written.includes(f));
  }
  // links are COMPLETED, not replaced: a slot that already has a URL keeps it
  assert.equal(next.links.site, "https://the-owner-pasted-this.example");
  assert.equal(next.links.tracking, "https://live.example");
  assert.ok(written.includes("links.tracking") && !written.includes("links.site"));
});

/* -------------------------------- prompt --------------------------------- */

/** The MM100 folder + the EXAMPLE profile — no personal values anywhere. */
async function promptFixture(overrides = {}) {
  const mm = await mm100();
  if (!mm) return null;
  const profile = await readJson(path.join(ROOT, "config", "profile.example.json"));
  const race = { ...mm.race, slug: MM100 };
  return {
    prompt: buildPlanPrompt({
      slug: MM100,
      race,
      course: null,
      profile,
      facts: null,
      // MM100 ran in the past, so the window is pinned from a date before it
      window: planWindow(race, { today: new Date(2026, 5, 1) }),
      style: null,
      ...overrides,
    }),
    race,
    profile,
  };
}

test("the MM100 prompt carries the race, the aid chart and the block calendar", async (t) => {
  const fx = await promptFixture();
  if (!fx) return t.skip(`races/${MM100}/ not in this checkout`);
  const p = fx.prompt;

  assert.match(p, /^Plan the training block, the race-day nutrition and the coach notes for Mogollon Monster 100 \(races\/mogollon-monster-100-2026\/\)\./);
  assert.match(p, /Mogollon Monster 100 \(MM100\) · 2026 edition/);
  assert.match(p, /Saturday 2026-09-12, gun at 06:00 America\/Phoenix/);
  assert.match(p, /102\.6 mi · 15,900 ft gain · point_to_point · 38 h overall cutoff/);
  assert.match(p, /features: crew, drop_bags, pacers, night, heat, altitude, water_crossings/);
  assert.match(p, /drop bags at: Fish Hatchery, Buck Springs, Geronimo/);
  // the whole aid chart, in course order, with cutoffs and access
  assert.match(p, /Buck Springs +42\.7 +15\.75 h +crew, DROP BAG, pacers/);
  assert.match(p, /Finish +102\.6 +38 h +crew/);
  for (const s of fx.race.aid_stations) assert.ok(p.includes(s.name), `aid station ${s.name} missing`);
  // no course build in a bare checkout — the prompt says so rather than lying
  assert.match(p, /COURSE METRICS: none — races\/<slug>\/build\/course\.json has not been built/);
  // the block calendar, counted back from race day
  assert.match(p, /week 1 starts Monday 2026-06-08/);
  assert.match(p, /14 weeks total; week 14 is RACE WEEK and contains 2026-09-12/);
  assert.match(p, /return exactly 14 target rows, wk 1\.\.14, in order/);
});

test("the prompt carries the EXAMPLE profile and no personal values", async (t) => {
  const fx = await promptFixture();
  if (!fx) return t.skip(`races/${MM100}/ not in this checkout`);
  assert.match(fx.prompt, /the athlete · their home mountains/);
  assert.match(fx.prompt, /home trails: your local long-route trail/);
  // physiology falls back until tt-yib.9 lands; either way it is the example's
  const kg = fx.profile.physiology?.body_kg ?? 75;
  assert.match(fx.prompt, new RegExp(`physiology: ${kg} kg body mass`));
  assert.match(fx.prompt, /belongs nowhere in the race folder/);
  // the personal profile, if this machine has one, must not have leaked in
  const personal = await readJson(path.join(ROOT, "config", "profile.json")).catch(() => null);
  if (personal?.athlete_name) assert.ok(!fx.prompt.includes(personal.athlete_name));
});

test("no fitness snapshot and no course build are stated, not silently dropped", async (t) => {
  const fx = await promptFixture();
  if (!fx) return t.skip(`races/${MM100}/ not in this checkout`);
  assert.match(fx.prompt, /CURRENT FITNESS: no snapshot on disk/);
  assert.match(fx.prompt, /Open week 1 conservatively/);
});

test("with facts and a course build, the prompt carries both", async (t) => {
  const fx = await promptFixture({
    course: {
      distance_mi: 102.31, gain_ft: 15862, official_distance_mi: 102.6, official_gain_ft: 15900,
      sun: { sunrise: "06:05", sunset: "18:35" },
      profile: [{ mi: 0, ele_ft: 5400 }, { mi: 50, ele_ft: 7912 }],
      race_climbs: [{ label: "Geronimo", start_mi: 61.1, end_mi: 66.4, gain_ft: 2100, avg_grade_pct: 7.5, max_grade_pct: 19 }],
      aid_stations: [{ name: "Buck Springs", gpx_mi: 42.61 }],
    },
    facts: {
      load: { d7_dist_mi: 21.4, d28_dist_mi: 96, d7_elev_ft: 3200, d28_elev_ft: 14400, acr_dist: 0.89, acr_elev: 0.89, sessions_d7: 4, longest_d7: null },
      pacing: {
        basis: "fit from 120 runs ≥2mi (Strava moving time)",
        model: "moving_s_per_mi = base + kVert·vert_ft_per_mi + kDist·dist_mi",
        base_pace_min_per_mi: 9.8, add_min_per_mi_per_100ft_vert_per_mi: 0.55,
        add_min_per_mi_per_10mi_distance: 0.4, fit_error_min_per_mi: 1.3,
      },
      block: { mode: "rolling", current_week: 12, total_weeks: 12 },
      recovery: { hrv_d7: 62, hrv_d28: 60, rhr_drift_bpm: -0.4, sleep_debt_h: 3.2 },
    },
  });
  if (!fx) return t.skip(`races/${MM100}/ not in this checkout`);
  const p = fx.prompt;
  assert.match(p, /track: 102\.31 mi, 15,862 ft gain \(official 102\.6 mi \/ 15,900 ft\)/);
  assert.match(p, /race-local sun: sunrise 06:05, sunset 18:35/);
  assert.match(p, /· Geronimo: mi 61\.1–66\.4, 2,100 ft, 7\.5% avg \/ 19% max/);
  // the snapped mile wins over the charted one for a station the build measured
  assert.match(p, /Buck Springs +42\.6/);
  assert.match(p, /last 28 days: 96 mi \/ 14,400 ft {2}\(weekly average 24\.0 mi \/ 3,600 ft\)/);
  assert.match(p, /base 9\.8 min\/mi · \+0\.55 min\/mi per 100 ft\/mi of vert/);
  assert.match(p, /recovery: HRV 62 \(28-day 60\)/);
});

test("the style reference is shown as shape, with the athlete's mass stripped out", async (t) => {
  const mm = await mm100();
  if (!mm) return t.skip(`races/${MM100}/ not in this checkout`);
  // the same scrubbing scripts/race-plan.mjs does when it loads the reference
  const nutrition = clone(mm.nutrition);
  delete nutrition.comment;
  delete nutrition.caffeine_comment;
  delete nutrition.caffeine.body_kg;
  const fx = await promptFixture({
    style: { name: "Mogollon Monster 100", block: mm.block, nutrition, coach_notes: mm.coach_notes },
  });
  const p = fx.prompt;
  assert.match(p, /STYLE REFERENCE — the hand-authored Mogollon Monster 100 plan/);
  assert.match(p, /do NOT copy its numbers, its stations or its window/);
  assert.match(p, /block\.json: 20 weeks from 2026-04-27/);
  assert.match(p, /wk1 38mi\/5800ft {2}wk2 46mi\/7400ft/);
  assert.ok(!/body_kg/.test(p), "the style reference must not teach the agent to write body_kg");
});

test("an undated race is told there is no block, and still asked for the rest", async (t) => {
  const mm = await mm100();
  if (!mm) return t.skip(`races/${MM100}/ not in this checkout`);
  const race = { ...mm.race, slug: "undated-race-2027", date: null };
  const p = buildPlanPrompt({
    slug: "undated-race-2027", race, profile: {}, window: null,
    blockReason: blockUnavailableReason(race, { today: new Date(2026, 8, 18) }),
  });
  assert.match(p, /THE BLOCK CALENDAR: there is none\. race\.json has no usable date \(null\)/);
  assert.match(p, /Do NOT return a block\. Leave it out and name "block" in unresolved\./);
  assert.match(p, /this folder needs its nutrition plan and its coach notes/);
});

/* ------------------------------- dry run --------------------------------- */

test("planRace --dry-run assembles the prompt and writes nothing", async (t) => {
  const mm = await mm100();
  if (!mm) return t.skip(`races/${MM100}/ not in this checkout`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-plan-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const slug = "future-race-2027";
  // the folder under test, plus the style reference the planner reaches for
  await fs.cp(path.join(ROOT, "races", MM100), path.join(tmp, "races", MM100), { recursive: true });
  await fs.cp(path.join(ROOT, "races", MM100), path.join(tmp, "races", slug), { recursive: true });
  const race = { ...mm.race, slug, status: "draft", date: "2027-08-13" };
  await fs.writeFile(path.join(tmp, "races", slug, "race.json"), JSON.stringify(race, null, 2));
  const before = (await fs.readdir(path.join(tmp, "races", slug))).sort();

  const steps = [];
  const result = await planRace({
    root: tmp,
    slug,
    dryRun: true,
    today: new Date(2027, 5, 1),
    onProgress: (e) => { if (e.status === "start") steps.push(e.step); }, allowDateless: true });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.wrote, []);
  assert.deepEqual(steps, ["load", "prompt"], "a dry run must stop before the agent");
  assert.match(result.prompt, /week 1 starts Monday 2027-06-07/);
  assert.match(result.prompt, /10 weeks total; week 10 is RACE WEEK/);
  assert.match(result.prompt, /STYLE REFERENCE — the hand-authored Mogollon Monster 100 plan/);
  // the reference is loaded off disk here, so this is the real scrubbing
  assert.ok(!/body_kg/.test(result.prompt), "the athlete's mass must not reach the prompt through the style reference");
  assert.ok(result.warnings.some((w) => /no fitness snapshot/.test(w)));
  assert.ok(result.warnings.some((w) => /build\/course\.json is not there/.test(w)));

  // nothing created anywhere: not in the folder, not the state/goals files
  // loadFactsFromRoot would have bootstrapped on its way to failing
  assert.deepEqual((await fs.readdir(path.join(tmp, "races", slug))).sort(), before);
  assert.deepEqual(await fs.readdir(tmp), ["races"]);
  // …and the race.json it read is untouched
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(tmp, "races", slug, "race.json"), "utf8")), race);
});

test("a full run writes the three files, stamps them, and keeps the owner's edits", async (t) => {
  const mm = await mm100();
  if (!mm) return t.skip(`races/${MM100}/ not in this checkout`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-plan-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const slug = "future-race-2027";
  const dir = path.join(tmp, "races", slug);
  await fs.cp(path.join(ROOT, "races", MM100), dir, { recursive: true });
  const race = {
    ...mm.race,
    slug,
    status: "draft",
    date: "2027-08-13",
    distance_mi: 104,
    gain_ft: 19000,
    // the owner has already rewritten one note and pasted the official site
    coach_notes: { ...mm.race.coach_notes, terrain: "MY words about the terrain." },
    links: { site: "https://sanjuansoftie.example" },
    provenance: { ...mm.race.provenance, "coach_notes.terrain": { by: "user", at: "2027-01-01T00:00:00Z" } },
  };
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(race, null, 2));

  // A canned agent reply for the 12-week window this clock produces.
  const reply = await goodOutput();
  reply.links = { site: "https://second-best.example", manual: "https://example.org/manual.pdf" };
  const result = await planRace({
    root: tmp,
    slug,
    today: new Date(2027, 4, 18), // Tue → week 1 is 2027-05-24, race week is 12
    runAgent: async () => ({
      text: JSON.stringify(reply),
      wrapper: { numTurns: 3, costUsd: 0.12, durationMs: 4000 },
      retried: false,
    }),
  });

  assert.deepEqual(result.wrote, [
    `races/${slug}/block.json`,
    `races/${slug}/nutrition.json`,
    `races/${slug}/race.json`,
  ]);

  const block = await readJson(path.join(dir, "block.json"));
  assert.equal(block.start_date, "2027-05-24");
  assert.equal(block.total_weeks, 12);
  assert.equal(block.targets.length, 12);
  // WeekTarget is exactly three keys — the app's Block type, nothing extra
  for (const row of block.targets) assert.deepEqual(Object.keys(row), ["wk", "target_dist", "target_elev"]);

  const nutrition = await readJson(path.join(dir, "nutrition.json"));
  assert.notEqual(normalizeNutrition(nutrition), null, "the file the app will load must load");
  assert.ok(!("body_kg" in nutrition.caffeine));
  assert.match(nutrition.caffeine_comment, /Body mass comes from config\/profile\.json/);

  const written = await readJson(path.join(dir, "race.json"));
  assert.equal(written.coach_notes.terrain, "MY words about the terrain.", "a user-authored note survives");
  assert.equal(written.provenance["coach_notes.terrain"].by, "user");
  assert.equal(written.coach_notes.climate, OK_NOTES.climate);
  assert.equal(written.provenance["coach_notes.climate"].source, "race-plan");
  assert.equal(written.provenance["coach_notes.climate"].by, "agent");
  assert.equal(written.links.site, "https://sanjuansoftie.example", "an existing link is completed around, not replaced");
  assert.equal(written.links.manual, "https://example.org/manual.pdf");
  assert.equal(written.visual.theme_preset, "alpine");
  assert.deepEqual(written.visual.panels, mm.race.visual.panels, "unrelated visual keys survive");
  assert.equal(written.review_notes, "three loading cycles, peak at week 9");
  assert.deepEqual(result.skipped, ["coach_notes.terrain"]);
  assert.deepEqual(result.unresolved, ["links.results"]);
});

test("user-owned block targets survive a re-plan — the agent's proposal is a warning, not a write", async (t) => {
  const mm = await mm100();
  if (!mm) return t.skip(`races/${MM100}/ not in this checkout`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-plan-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const slug = "future-race-2027";
  const dir = path.join(tmp, "races", slug);
  await fs.cp(path.join(ROOT, "races", MM100), dir, { recursive: true });
  const race = { ...mm.race, slug, status: "draft", date: "2027-08-13", distance_mi: 104, gain_ft: 19000 };
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(race, null, 2));

  // The owner hand-edited a week's numbers through the review dialog
  // (race-edit.mjs's applyBlockTargetsEdit stamps exactly this shape).
  const handEditedBlock = {
    start_date: "2027-05-24",
    total_weeks: 1,
    targets: [{ wk: 1, target_dist: 999, target_elev: 12345 }],
    provenance: { targets: { by: "user", at: "2027-01-01T00:00:00Z" } },
  };
  await fs.writeFile(path.join(dir, "block.json"), JSON.stringify(handEditedBlock, null, 2));

  const reply = await goodOutput();
  const result = await planRace({
    root: tmp,
    slug,
    today: new Date(2027, 4, 18),
    runAgent: async () => ({ text: JSON.stringify(reply), wrapper: {}, retried: false }),
  });

  // block.json on disk is byte-for-byte what the owner authored.
  const block = await readJson(path.join(dir, "block.json"));
  assert.deepEqual(block, handEditedBlock);
  assert.ok(!result.wrote.includes(`races/${slug}/block.json`), "block.json must not be reported as written");
  assert.deepEqual(result.wrote, [`races/${slug}/nutrition.json`, `races/${slug}/race.json`]);
  assert.ok(
    result.warnings.some((w) => /block\.json targets are user-owned — kept as authored/.test(w) && /wk1 /.test(w)),
    result.warnings.join(" | "),
  );
});

test("a race with no date gets its nutrition and notes, but no block.json", async (t) => {
  const mm = await mm100();
  if (!mm) return t.skip(`races/${MM100}/ not in this checkout`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-plan-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const slug = "undated-race-2027";
  const dir = path.join(tmp, "races", slug);
  await fs.cp(path.join(ROOT, "races", MM100), dir, { recursive: true });
  await fs.rm(path.join(dir, "block.json"));
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify({ ...mm.race, slug, status: "draft", date: null }, null, 2));

  const reply = await goodOutput();
  delete reply.block;
  const result = await planRace({
    allowDateless: true,
    root: tmp,
    slug,
    today: new Date(2026, 8, 18),
    runAgent: async () => ({ text: JSON.stringify(reply), wrapper: {}, retried: false }),
  });

  assert.deepEqual(result.wrote, [`races/${slug}/nutrition.json`, `races/${slug}/race.json`]);
  assert.equal(result.block, null);
  assert.ok(result.unresolved.includes("block"));
  assert.ok(result.warnings.some((w) => /no block will be written.*no usable date/.test(w)), result.warnings.join(" | "));
  await assert.rejects(fs.access(path.join(dir, "block.json")), /ENOENT/);
});

test("output that breaks the contract writes nothing at all", async (t) => {
  const mm = await mm100();
  if (!mm) return t.skip(`races/${MM100}/ not in this checkout`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-plan-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const slug = "future-race-2027";
  const dir = path.join(tmp, "races", slug);
  await fs.cp(path.join(ROOT, "races", MM100), dir, { recursive: true });
  const race = { ...mm.race, slug, status: "draft", date: "2027-08-13", distance_mi: 104, gain_ft: 19000 };
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(race, null, 2));
  const before = await Promise.all(["block.json", "nutrition.json", "race.json"].map((f) => fs.readFile(path.join(dir, f), "utf8")));

  const reply = await goodOutput();
  reply.visual.theme_preset = "san-juan";
  reply.nutrition.caffeine.body_kg = 79.4;
  await assert.rejects(
    planRace({
      root: tmp,
      slug,
      today: new Date(2027, 4, 18),
      runAgent: async () => ({ text: JSON.stringify(reply), wrapper: {}, retried: false }),
    }),
    (e) => /failed the contract/.test(e.message) && /theme_preset/.test(e.message) && /body_kg/.test(e.message),
  );

  const after = await Promise.all(["block.json", "nutrition.json", "race.json"].map((f) => fs.readFile(path.join(dir, f), "utf8")));
  assert.deepEqual(after, before, "a rejected plan must leave the folder byte-identical");
});

test("a dateless race is refused before the agent turn unless the caller opts in", async (t) => {
  const mm = await mm100();
  if (!mm) return t.skip(`races/${MM100}/ not in this checkout`);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-plan-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const slug = "undated-race-2027";
  const dir = path.join(tmp, "races", slug);
  await fs.cp(path.join(ROOT, "races", MM100), dir, { recursive: true });
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify({ ...mm.race, slug, status: "draft", date: null }, null, 2));

  let calls = 0;
  const runAgent = async () => { calls++; return { text: "{}", wrapper: {}, retried: false }; };
  await assert.rejects(planRace({ root: tmp, slug, today: new Date(2026, 8, 18), runAgent }), /has no date/);
  assert.equal(calls, 0, "the agent must not be spawned for a dateless race by default");
  // a dry run never spends, so it is still allowed
  const dry = await planRace({ root: tmp, slug, today: new Date(2026, 8, 18), runAgent, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(calls, 0);
});
