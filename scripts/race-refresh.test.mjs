// node --test scripts/race-refresh.test.mjs   (or: cd web && npm test)
//
// Re-intake, end to end, with the two agent turns replaced by canned replies —
// the point of this file is the DISCIPLINE, not the agent: a refresh must be
// able to run all three stages and still leave the race the athlete is
// training for byte-identical until they accept it.
//
// So the assertions are mostly hashes. Every test fingerprints the live race
// folder before the run and again after, and the interesting number is how
// many files changed: zero before Accept, exactly the merged ones after.
//
// Nothing here reaches the network. The fixture race's links.site points at a
// closed loopback port, which fails the way a dead race site does — recorded
// in the manifest, never thrown — and no GPX means stage 2 stops at "no course
// to snap to", which is a state the refresh has to survive anyway.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRaceJson } from "./race-intake.mjs";
import {
  SHADOW,
  acceptRefresh,
  loadShadowRace,
  readRefresh,
  refreshSources,
  rejectRefresh,
  runRefresh,
  sourceStamp,
} from "./race-refresh.mjs";
import { COACH_NOTE_KEYS } from "./race-plan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "scripts", "fixtures", "race-intake-agent-output.json");
const MM100 = "mogollon-monster-100-2026";
const SLUG = "cinder-cone-50k-2027";

/** A site that fails immediately: the discard port on loopback, nothing listening. */
const DEAD_SITE = "http://127.0.0.1:9/cinder-cone";

const readJson = async (p) => JSON.parse(await fs.readFile(p, "utf8"));

/**
 * The stage-1 fixture, with every link pointed at the dead port. The fixture's
 * own links are example.org URLs and a refresh FOLLOWS them — a test that has
 * to reach the network to pass is a test that fails on a plane.
 */
const draft = async (over = {}) => ({
  ...(await readJson(FIXTURE)),
  links: { site: DEAD_SITE, manual: `${DEAD_SITE}/manual-2027.pdf`, gpx: "", tracking: "", results: "", map: "" },
  ...over,
});

/** Everything under `dir`, as path → sha256. `skip` drops a top-level entry. */
async function fingerprint(dir, skip = []) {
  const out = {};
  const walk = async (rel) => {
    const here = path.join(dir, rel);
    for (const ent of await fs.readdir(here, { withFileTypes: true })) {
      const next = rel ? path.join(rel, ent.name) : ent.name;
      if (skip.includes(next)) continue;
      if (ent.isDirectory()) await walk(next);
      else out[next] = crypto.createHash("sha256").update(await fs.readFile(path.join(here, ent.name))).digest("hex");
    }
  };
  await walk("");
  return out;
}

/** The canned stage-1 reply, in the shape runClaudeJson returns. */
const cannedIntake = (body) => async () => ({
  text: JSON.stringify(body),
  wrapper: { numTurns: 4, costUsd: 0.31, durationMs: 9000 },
  retried: false,
});

/** A well-shaped 12-week block, the same one race-plan.test.mjs validates. */
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
  { wk: 12, target_dist: 31.4, target_elev: 5200 },
];

/**
 * The MM100 fuel plan, scaled to the fixture's 50K, as a stage-3 reply. The
 * constants are the real file's — the point is a nutrition.json that passes
 * validatePlanOutput without this test having to reinvent one — but the drop
 * bags and the caffeine schedule are this course's: an 11-hour race with one
 * drop-bag station cannot carry a hundred-miler's nine gels or its four bags.
 */
async function cannedPlan() {
  const n = await readJson(path.join(ROOT, "races", MM100, "nutrition.json"));
  delete n.comment;
  delete n.caffeine_comment;
  n.drop_bag_gear = { Start: ["sunscreen + hat", "arm sleeves"] };
  n.caffeine = { ...n.caffeine, gels: 3 };
  return {
    block: { targets: structuredClone(GOOD_TARGETS) },
    nutrition: n,
    coach_notes: Object.fromEntries(COACH_NOTE_KEYS.map((k) => [k, `Grounded prose about ${k}.`])),
    links: { site: DEAD_SITE },
    visual: { theme_preset: "alpine", accent: "#7fb2d9" },
    unresolved: [],
    review_notes: "re-planned from the 2027 chart",
  };
}

/**
 * A live race folder built from the intake fixture, plus the two files a
 * refresh must never touch and a source cache to be kept alongside the new one.
 * @returns {Promise<{tmp: string, dir: string, race: object}>}
 */
async function fixtureRace(t, { raceOver = {} } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-refresh-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, "races", SLUG);
  await fs.mkdir(path.join(dir, "sources"), { recursive: true });
  await fs.mkdir(path.join(dir, "build"), { recursive: true });

  const race = {
    ...buildRaceJson(await draft(), { slug: SLUG, year: 2027, manifest: [], at: "2026-09-18T00:00:00Z" }),
    status: "active",
    ...raceOver,
  };
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(race, null, 2));
  await fs.writeFile(path.join(dir, "block.json"), JSON.stringify({ start_date: "2027-01-04", total_weeks: 2, targets: [{ wk: 1, target_dist: 30, target_elev: 4000 }, { wk: 2, target_dist: 20, target_elev: 2500 }] }, null, 2));
  await fs.writeFile(path.join(dir, "nutrition.json"), JSON.stringify({ flask_ml: 500, drop_bag_gear: { Start: ["hat"] } }, null, 2));
  // the two files the merge must never reach
  await fs.writeFile(path.join(dir, "plan.json"), JSON.stringify({ plan_blocks: ["the coach's"] }, null, 2));
  await fs.writeFile(path.join(dir, "result.json"), JSON.stringify({ finish_h: 9.5 }, null, 2));
  // the manual the current race.json was read from
  await fs.writeFile(path.join(dir, "sources", "manual-2026.pdf"), "%PDF-1.4 the OLD manual\n");
  await fs.writeFile(path.join(dir, "sources", "manifest.json"), JSON.stringify([{ kind: "pdf", ref: "manual-2026.pdf", file: "manual-2026.pdf" }], null, 2));
  await fs.writeFile(path.join(dir, "build", "course.json"), JSON.stringify({ aid_stations: 4 }, null, 2));
  return { tmp, dir, race };
}

/** The refresh every test runs: stage 1 canned, stage 3 off unless asked. */
async function refresh(tmp, over = {}) {
  return runRefresh({
    root: tmp,
    slug: SLUG,
    skipPlan: true,
    runAgent: cannedIntake(over.agentDraft ?? (await draft())),
    ...over,
    agentDraft: undefined,
  });
}

/* ----------------------------- where to fetch ---------------------------- */

test("refreshSources re-reads the race's own links and manifest, site first", () => {
  const { siteUrl, extraUrls } = refreshSources({
    links: { site: "https://race.example", manual: "https://race.example/manual.pdf", results: "" },
    sources: [
      { kind: "url", ref: "https://race.example" },
      { kind: "pdf", ref: "https://cdn.example/aid-chart.pdf" },
      { kind: "gpx", ref: "not a url" },
    ],
  });
  assert.equal(siteUrl, "https://race.example");
  assert.deepEqual(extraUrls, ["https://race.example/manual.pdf", "https://cdn.example/aid-chart.pdf"]);
});

test("a race with no links.site cannot be refreshed, and says so before any work", async (t) => {
  const { tmp, dir } = await fixtureRace(t, { raceOver: { links: {} } });
  const before = await fingerprint(dir);
  await assert.rejects(refresh(tmp), /no links\.site to refresh from/);
  assert.deepEqual(await fingerprint(dir), before, "a refused refresh writes nothing at all");
});

/* --------------------------- the shadow folder --------------------------- */

test("a refresh writes nothing outside .refresh/", async (t) => {
  const { tmp, dir } = await fixtureRace(t);
  const before = await fingerprint(dir);

  const incoming = await draft();
  incoming.distance_mi = 32.8;
  incoming.aid_stations[1].cutoff_h = 3.5;
  await refresh(tmp, { agentDraft: incoming });

  const after = await fingerprint(dir, [SHADOW]);
  assert.deepEqual(after, before, "the live folder is byte-identical until Accept");
  // …and the shadow is a whole second folder
  assert.ok((await fs.readdir(path.join(dir, SHADOW))).includes("race.json"));
  assert.ok((await fs.readdir(path.join(dir, SHADOW))).includes("diff.json"));
  const shadowRace = await readJson(path.join(dir, SHADOW, "race.json"));
  assert.equal(shadowRace.distance_mi, 32.8);
});

/* ------------------------- loadShadowRace (finding #3) ------------------- */

test("loadShadowRace: no race.json at all reads as null — the ENOENT case runRefresh reports as no diff", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-shadow-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const shadow = path.join(tmp, SHADOW);
  await fs.mkdir(shadow, { recursive: true });
  assert.equal(await loadShadowRace(shadow, SLUG), null);
});

test("loadShadowRace: a race.json that is not valid JSON propagates instead of reading as \"nothing to diff\"", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-shadow-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const shadow = path.join(tmp, SHADOW);
  await fs.mkdir(shadow, { recursive: true });
  await fs.writeFile(path.join(shadow, "race.json"), "{ not json");
  await assert.rejects(loadShadowRace(shadow, SLUG), /race\.json is not valid JSON/);
});

test("the diff names what Accept would change, and nothing else", async (t) => {
  const { tmp, dir } = await fixtureRace(t);
  const incoming = await draft();
  incoming.distance_mi = 32.8;
  incoming.aid_stations[1].cutoff_h = 3.5;

  const { diff } = await refresh(tmp, { agentDraft: incoming });
  const changed = diff.diff.filter((d) => d.file === "race.json").map((d) => `${d.kind}:${d.path}`);
  assert.ok(changed.includes("changed:distance_mi"), changed.join(" | "));
  assert.ok(changed.includes("changed:aid_stations[1].cutoff_h"), changed.join(" | "));
  assert.ok(!changed.some((c) => c.includes("status")), "status is never in a diff");
  assert.ok(!diff.diff.some((d) => /plan\.json|result\.json/.test(d.file)));
  assert.deepEqual(diff.files.sort(), ["race.json"], "stage 3 was skipped, so only race.json has an incoming version");
  // the file on disk is the same thing the call returned
  assert.deepEqual(await readRefresh(tmp, SLUG), diff);
});

test("a hand-typed cutoff is kept, and comes back as a suggestion", async (t) => {
  const { tmp, dir } = await fixtureRace(t);
  const race = await readJson(path.join(dir, "race.json"));
  race.aid_stations[1].cutoff_h = 3.25;
  race.provenance["aid_stations[1].cutoff_h"] = { by: "user", at: "2026-10-01T00:00:00Z" };
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(race, null, 2));

  const incoming = await draft();
  incoming.aid_stations[1].cutoff_h = 3.5;
  const { diff } = await refresh(tmp, { agentDraft: incoming });

  assert.deepEqual(diff.conflicts.map((c) => c.path), ["aid_stations[1].cutoff_h"]);
  assert.equal(diff.conflicts[0].from, 3.25);
  assert.equal(diff.conflicts[0].to, 3.5);

  await acceptRefresh({ root: tmp, slug: SLUG });
  assert.equal((await readJson(path.join(dir, "race.json"))).aid_stations[1].cutoff_h, 3.25);
});

test("stage 3 plans into the shadow, leaving the live block and fuel plan alone", async (t) => {
  const { tmp, dir } = await fixtureRace(t, { raceOver: { date: "2027-08-13" } });
  const before = await fingerprint(dir);
  const plan = await cannedPlan();

  const { diff } = await runRefresh({
    root: tmp,
    slug: SLUG,
    // Tue → week 1 is 2027-05-24 and race week is 12, which is the block the
    // canned reply carries. The clock is injected for exactly this reason.
    today: new Date(2027, 4, 18),
    runAgent: cannedIntake(await draft({ date: "2027-08-13" })),
    runPlanAgent: async () => ({ text: JSON.stringify(plan), wrapper: {}, retried: false }),
  });

  assert.deepEqual(await fingerprint(dir, [SHADOW]), before, "three stages, and the live folder still has not moved");
  const shadowNutrition = await readJson(path.join(dir, SHADOW, "nutrition.json"));
  assert.equal(shadowNutrition.flask_ml, 500);
  assert.deepEqual(Object.keys(shadowNutrition.drop_bag_gear), ["Start"], "the fuel plan came through stage 3");
  assert.equal((await readJson(path.join(dir, SHADOW, "block.json"))).total_weeks, 12);
  assert.deepEqual(diff.files.sort(), ["block.json", "nutrition.json", "race.json"]);
  // the live ones are still what the fixture wrote
  assert.deepEqual(Object.keys(await readJson(path.join(dir, "nutrition.json"))), ["flask_ml", "drop_bag_gear"]);
  assert.equal((await readJson(path.join(dir, "block.json"))).total_weeks, 2);

  await acceptRefresh({ root: tmp, slug: SLUG });
  assert.equal((await readJson(path.join(dir, "block.json"))).total_weeks, 12, "accept applies the new block");
  const liveNutrition = await readJson(path.join(dir, "nutrition.json"));
  assert.equal(liveNutrition.tailwind_flasks, 2, "…and the rest of the new fuel plan with it");
  assert.deepEqual(Object.keys(liveNutrition.drop_bag_gear), ["Start"]);
});

test("a plan that refuses does not cost the owner the re-read chart", async (t) => {
  // The fixture race has no date, which race-plan.mjs refuses before spending
  // an agent turn. Stages 1 and 2 have already done the expensive work.
  const { tmp, dir } = await fixtureRace(t);
  const { diff } = await runRefresh({
    root: tmp,
    slug: SLUG,
    runAgent: cannedIntake(await draft({ distance_mi: 32.8 })),
    runPlanAgent: async () => ({ text: "{}", wrapper: {}, retried: false }),
  });

  assert.deepEqual(diff.files, ["race.json"], "no block or fuel plan came out, so neither is diffed");
  assert.ok(diff.warnings.some((w) => /were not re-planned.*has no date/.test(w)), diff.warnings.join(" | "));
  assert.equal(diff.diff.find((d) => d.path === "distance_mi").to, 32.8, "the re-read chart survived");
  assert.equal(diff.stages.plan, null);
});

/* -------------------------------- accept --------------------------------- */

test("accept applies exactly the merged files and takes the shadow away", async (t) => {
  const { tmp, dir } = await fixtureRace(t);
  const before = await fingerprint(dir);
  const incoming = await draft();
  incoming.distance_mi = 32.8;
  await refresh(tmp, { agentDraft: incoming });

  const out = await acceptRefresh({ root: tmp, slug: SLUG });
  assert.ok(out.wrote.includes(`races/${SLUG}/race.json`));

  const after = await fingerprint(dir);
  const moved = Object.keys(after).filter((f) => after[f] !== before[f]);
  const gone = Object.keys(before).filter((f) => !(f in after));
  assert.deepEqual(gone, [], "accept removes nothing that was there");
  // race.json, and the new dated source cache. Nothing else.
  assert.deepEqual(moved.filter((f) => !f.startsWith("sources/")), ["race.json"], moved.join(" | "));

  const race = await readJson(path.join(dir, "race.json"));
  assert.equal(race.distance_mi, 32.8);
  assert.equal(race.status, "active", "an active race is still active after a refresh");
  assert.equal(race.slug, SLUG);
  await assert.rejects(fs.access(path.join(dir, SHADOW)), /ENOENT/, "the shadow folder is gone");
});

test("accept never touches plan.json or result.json", async (t) => {
  const { tmp, dir } = await fixtureRace(t);
  const plan = await fs.readFile(path.join(dir, "plan.json"), "utf8");
  const result = await fs.readFile(path.join(dir, "result.json"), "utf8");

  await refresh(tmp, { agentDraft: await draft({ distance_mi: 32.8 }) });
  await acceptRefresh({ root: tmp, slug: SLUG });

  assert.equal(await fs.readFile(path.join(dir, "plan.json"), "utf8"), plan);
  assert.equal(await fs.readFile(path.join(dir, "result.json"), "utf8"), result);
});

test("accept keeps the previous manual, under the old name, beside a dated new cache", async (t) => {
  const { tmp, dir } = await fixtureRace(t);
  const { diff } = await refresh(tmp, { agentDraft: await draft() });
  await acceptRefresh({ root: tmp, slug: SLUG });

  const stamp = diff.sources_stamp;
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}-\d{4}$/);
  assert.equal(
    await fs.readFile(path.join(dir, "sources", "manual-2026.pdf"), "utf8"),
    "%PDF-1.4 the OLD manual\n",
    "the manual the current race.json was transcribed from is still there",
  );
  const entries = await fs.readdir(path.join(dir, "sources"));
  assert.ok(entries.includes(stamp), entries.join(" | "));
  assert.ok(entries.includes(`manifest-${stamp}.json`), entries.join(" | "));
  assert.ok(entries.includes("manifest.json"), "the old manifest is not replaced");
});

test("accept with no refresh waiting refuses rather than guessing", async (t) => {
  const { tmp } = await fixtureRace(t);
  await assert.rejects(acceptRefresh({ root: tmp, slug: SLUG }), /no refresh waiting/);
});

/* -------------------------------- reject --------------------------------- */

test("reject leaves the live folder byte-identical", async (t) => {
  const { tmp, dir } = await fixtureRace(t);
  const before = await fingerprint(dir);

  await refresh(tmp, { agentDraft: await draft({ distance_mi: 32.8 }) });
  const out = await rejectRefresh({ root: tmp, slug: SLUG });

  assert.equal(out.removed, true);
  assert.deepEqual(await fingerprint(dir), before, "not one byte, not even the source cache");
  assert.equal(await readRefresh(tmp, SLUG), null);
});

test("reject with nothing pending is not an error", async (t) => {
  const { tmp } = await fixtureRace(t);
  assert.deepEqual(await rejectRefresh({ root: tmp, slug: SLUG }), { slug: SLUG, removed: false });
});

test("a second refresh replaces the first one's shadow", async (t) => {
  const { tmp, dir } = await fixtureRace(t);
  await refresh(tmp, { agentDraft: await draft({ distance_mi: 32.8 }) });
  await refresh(tmp, { agentDraft: await draft({ distance_mi: 33.9 }) });

  const shadowRace = await readJson(path.join(dir, SHADOW, "race.json"));
  assert.equal(shadowRace.distance_mi, 33.9);
  const pending = await readRefresh(tmp, SLUG);
  assert.equal(pending.diff.find((d) => d.path === "distance_mi").to, 33.9);
});

/* ------------------------------ determinism ------------------------------- */

test("re-intaking the same sources yields an empty diff", async (t) => {
  const { tmp, dir } = await fixtureRace(t);
  // the live race IS this draft, so the refresh has nothing to say
  const { diff } = await refresh(tmp, { agentDraft: await draft() });
  const material = diff.diff.filter((d) => d.path !== "sources");
  assert.deepEqual(material, [], material.map((d) => `${d.path}:${d.kind}`).join(" | "));
  assert.deepEqual(diff.conflicts, []);

  await acceptRefresh({ root: tmp, slug: SLUG });
  const race = await readJson(path.join(dir, "race.json"));
  assert.equal(race.distance_mi, 31.4);
  assert.equal(race.status, "active");
});

test("re-intaking the archived MM100 against its own race.json yields an empty diff", async (t) => {
  // The bead's determinism check (PRD §8): the pipeline run twice over the
  // same sources must produce the same folder, provenance timestamps aside.
  // The canned agent reply IS the folder's own agent-owned fields, so what is
  // under test is everything between them and the merge — buildRaceJson's
  // shaping, the provenance stamps, and the merge's idea of "changed".
  const live = await fs.readFile(path.join(ROOT, "races", MM100, "race.json"), "utf8").catch(() => null);
  if (!live) return t.skip(`races/${MM100}/ not in this checkout`);
  const race = JSON.parse(live);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-refresh-mm100-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, "races", MM100);
  await fs.mkdir(dir, { recursive: true });
  // Every URL points at the dead port: the refresh follows the race's own
  // links AND its recorded sources, and a unit test must not go to the network
  // to find the 2026 manual. The source LIST is kept — it is what the "a
  // failed fetch says nothing" rule has to protect.
  const staged = {
    ...race,
    links: { site: DEAD_SITE },
    sources: (race.sources ?? []).map((s) => ({ ...s, ref: DEAD_SITE })),
  };
  await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(staged, null, 2));

  // Everything the intake agent is allowed to write, straight back at it.
  const echo = {
    name: race.name, short: race.short, edition_year: race.edition_year, date: race.date,
    start_time: race.start_time, timezone: race.timezone, location: race.location,
    format: race.format, distance_mi: race.distance_mi, gain_ft: race.gain_ft,
    elevation: race.elevation, cutoff_h: race.cutoff_h, features: race.features,
    aid_stations: race.aid_stations, crew_info: race.crew_info,
    coach_notes: race.coach_notes, links: { site: DEAD_SITE }, visual: race.visual,
  };

  const { diff } = await runRefresh({
    root: tmp,
    slug: MM100,
    skipPlan: true,
    runAgent: cannedIntake(echo),
  });
  assert.deepEqual(diff.diff, [], diff.diff.map((d) => `${d.path}:${d.kind}`).join(" | "));
  assert.deepEqual(diff.conflicts, []);

  // …and the provenance timestamps DID move, which is exactly what must not count
  const shadow = JSON.parse(await fs.readFile(path.join(dir, SHADOW, "race.json"), "utf8"));
  assert.notEqual(shadow.provenance.aid_stations.at, race.provenance.aid_stations.at);
});

test("sourceStamp is sortable and minute-resolution", () => {
  assert.equal(sourceStamp(new Date("2027-08-13T14:05:09Z")), "2027-08-13-1405");
});
