// node --test scripts/race-merge.test.mjs   (or: cd web && npm test)
//
// The re-intake merge (PRD §8). Everything here is pure: two parsed objects in,
// {merged, diff, conflicts} out, no disk and no agent. The shadow-folder half
// of the refresh — what may be written and when — is scripts/race-refresh.test.mjs.
//
// The fixtures are deliberately small rather than a copy of the MM100 folder:
// the questions this module answers are "who owns this field" and "is this the
// same station", and a four-station chart asks both without 100 miles of noise.

import test from "node:test";
import assert from "node:assert/strict";

import {
  RENAME_NEAR_MI,
  mergeBlock,
  mergeFile,
  mergeNutrition,
  mergeRace,
  mergeRaceFolder,
} from "./race-merge.mjs";

const AT = "2026-09-18T00:00:00Z";
const agent = (source = "race-intake") => ({ by: "agent", at: AT, source });

/** A four-station race, all of it the agent's work. */
function baseRace(over = {}) {
  return {
    schema_version: 1,
    slug: "san-juan-softie-100-2027",
    status: "active",
    name: "San Juan Softie 100",
    short: "Softie",
    edition_year: 2027,
    date: "2027-08-13",
    start_time: "06:00",
    timezone: "America/Denver",
    distance_mi: 100.2,
    gain_ft: 21000,
    cutoff_h: 40,
    coach_notes: { terrain: "rocky", climate: "dry" },
    links: { site: "https://sanjuansoftie.example" },
    visual: { theme_preset: "alpine", accent: "#3d7f6b" },
    aid_stations: [
      { name: "Silverton", total_mi: 0, cutoff_h: null, crew: true },
      { name: "Kendall", total_mi: 12.4, cutoff_h: 4, crew: false },
      { name: "Pinchot Camp", total_mi: 38.1, cutoff_h: 12, crew: true },
      { name: "Molas", total_mi: 71.6, cutoff_h: 26, crew: true },
    ],
    provenance: {
      name: agent(), date: agent(), distance_mi: agent(), gain_ft: agent(),
      cutoff_h: agent(), coach_notes: agent(), links: agent(), visual: agent(),
      aid_stations: agent(),
    },
    ...over,
  };
}

const paths = (diff) => diff.map((d) => `${d.kind}:${d.path}`).sort();
const at = (diff, path) => diff.find((d) => d.path === path);

/* ------------------------------ no change -------------------------------- */

test("merge(current, current) is an empty diff", () => {
  const race = baseRace();
  const { merged, diff, conflicts } = mergeRace(race, structuredClone(race));
  assert.deepEqual(diff, []);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(merged, race, "an empty diff must leave the file byte-identical");
});

test("a re-serialized file with different key order is not a change", () => {
  const race = baseRace();
  const reordered = JSON.parse(JSON.stringify({
    ...race,
    visual: { accent: race.visual.accent, theme_preset: race.visual.theme_preset },
  }));
  assert.deepEqual(mergeRace(race, reordered).diff, []);
});

test("provenance timestamps alone produce no diff", () => {
  const race = baseRace();
  const incoming = structuredClone(race);
  for (const k of Object.keys(incoming.provenance)) {
    incoming.provenance[k] = { ...incoming.provenance[k], at: "2027-01-02T03:04:05Z" };
  }
  const { diff, conflicts } = mergeRace(race, incoming);
  assert.deepEqual(diff, [], "a re-stamped but unchanged race must not ask the owner to accept anything");
  assert.deepEqual(conflicts, []);
});

/* -------------------------- who owns the field --------------------------- */

test("an agent field is updated", () => {
  const race = baseRace();
  const incoming = structuredClone(race);
  incoming.distance_mi = 101.4;
  incoming.coach_notes.terrain = "rockier than the map suggests";

  const { merged, diff, conflicts } = mergeRace(race, incoming);
  assert.equal(merged.distance_mi, 101.4);
  assert.equal(merged.coach_notes.terrain, "rockier than the map suggests");
  assert.deepEqual(conflicts, []);
  assert.deepEqual(paths(diff), ["changed:coach_notes.terrain", "changed:distance_mi"]);
  assert.deepEqual(at(diff, "distance_mi"), {
    file: "race.json", path: "distance_mi", kind: "changed", from: 100.2, to: 101.4, by: "agent",
  });
});

test("a user field is preserved and the incoming value comes back as a suggestion", () => {
  const race = baseRace();
  race.cutoff_h = 42;
  race.provenance.cutoff_h = { by: "user", at: AT };
  const incoming = structuredClone(baseRace());
  incoming.cutoff_h = 38;

  const { merged, diff, conflicts } = mergeRace(race, incoming);
  assert.equal(merged.cutoff_h, 42, "the owner's cutoff survives the refresh");
  assert.deepEqual(merged.provenance.cutoff_h, { by: "user", at: AT }, "and keeps its provenance");
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], {
    file: "race.json", path: "cutoff_h", kind: "kept", from: 42, to: 38, by: "user",
  });
  assert.deepEqual(diff, conflicts);
});

test("a user-owned parent protects every field under it", () => {
  const race = baseRace();
  race.coach_notes = { terrain: "MY words", climate: "MY climate" };
  race.provenance.coach_notes = { by: "user", at: AT };
  const incoming = structuredClone(baseRace());
  incoming.coach_notes = { terrain: "agent terrain", climate: "agent climate" };

  const { merged, conflicts } = mergeRace(race, incoming);
  assert.deepEqual(merged.coach_notes, { terrain: "MY words", climate: "MY climate" });
  assert.deepEqual(paths(conflicts), ["kept:coach_notes.climate", "kept:coach_notes.terrain"]);
});

test("computed and matcher fields are not protected — only \"user\" is", () => {
  const race = baseRace();
  race.provenance.gain_ft = { by: "computed", at: AT, source: "race-build" };
  const incoming = structuredClone(baseRace());
  incoming.gain_ft = 21900;

  const { merged, diff } = mergeRace(race, incoming);
  assert.equal(merged.gain_ft, 21900);
  assert.equal(at(diff, "gain_ft").by, "computed");
});

test("identity and status are never merged", () => {
  const race = baseRace();
  const incoming = structuredClone(race);
  incoming.slug = "somebody-else-2027";
  incoming.status = "draft";
  incoming.schema_version = 99;

  const { merged, diff } = mergeRace(race, incoming);
  assert.equal(merged.slug, "san-juan-softie-100-2027");
  assert.equal(merged.status, "active", "an active race stays active across a refresh");
  assert.equal(merged.schema_version, 1);
  assert.deepEqual(diff, []);
});

test("a field the refresh does not carry is left alone, not deleted", () => {
  const race = baseRace();
  const incoming = structuredClone(race);
  delete incoming.links;
  delete incoming.visual;

  const { merged, diff } = mergeRace(race, incoming);
  assert.deepEqual(merged.links, race.links);
  assert.deepEqual(merged.visual, race.visual);
  assert.deepEqual(diff, []);
});

test("a field the refresh adds is added and stamped from the incoming provenance", () => {
  const race = baseRace();
  delete race.location;
  const incoming = structuredClone(race);
  incoming.location = "Silverton, CO";
  incoming.provenance.location = agent("the organizer's site");

  const { merged, diff } = mergeRace(race, incoming);
  assert.equal(merged.location, "Silverton, CO");
  assert.deepEqual(at(diff, "location"), {
    file: "race.json", path: "location", kind: "added", from: undefined, to: "Silverton, CO", by: null,
  });
  assert.deepEqual(merged.provenance.location, agent("the organizer's site"));
});

/* ---------------------------- aid stations ------------------------------- */

test("a station added to the chart lands in the merged array", () => {
  const race = baseRace();
  const incoming = structuredClone(race);
  incoming.aid_stations.splice(2, 0, { name: "Highland Mary", total_mi: 24.8, cutoff_h: 8, crew: false });

  const { merged, diff } = mergeRace(race, incoming);
  assert.deepEqual(merged.aid_stations.map((s) => s.name),
    ["Silverton", "Kendall", "Highland Mary", "Pinchot Camp", "Molas"]);
  const added = diff.find((d) => d.kind === "added");
  assert.equal(added.key, "Highland Mary");
  assert.equal(added.path, "aid_stations[2]");
});

test("a station cut from the chart is removed, and reported where it used to be", () => {
  const race = baseRace();
  const incoming = structuredClone(race);
  incoming.aid_stations.splice(1, 1); // Kendall is gone

  const { merged, diff } = mergeRace(race, incoming);
  assert.deepEqual(merged.aid_stations.map((s) => s.name), ["Silverton", "Pinchot Camp", "Molas"]);
  const removed = diff.find((d) => d.kind === "removed");
  assert.equal(removed.key, "Kendall");
  assert.equal(removed.path, "aid_stations[1]");
  assert.equal(removed.to, undefined);
});

test("a renamed station is recognised by its mile, and its other fields merge", () => {
  const race = baseRace();
  const incoming = structuredClone(race);
  incoming.aid_stations[2] = { name: "Pinchot", total_mi: 38.4, cutoff_h: 13, crew: true };

  const { merged, diff } = mergeRace(race, incoming);
  assert.equal(merged.aid_stations.length, 4, "a rename is not a remove plus an add");
  assert.equal(merged.aid_stations[2].name, "Pinchot");
  assert.equal(merged.aid_stations[2].cutoff_h, 13);
  assert.deepEqual(at(diff, "aid_stations[2].name"), {
    file: "race.json", path: "aid_stations[2].name", kind: "renamed",
    from: "Pinchot Camp", to: "Pinchot", by: null, key: "Pinchot Camp",
  });
  assert.equal(at(diff, "aid_stations[2].cutoff_h").kind, "changed");
});

test("a station further than RENAME_NEAR_MI away is a different station", () => {
  const race = baseRace();
  const incoming = structuredClone(race);
  incoming.aid_stations[2] = {
    name: "Pinchot", total_mi: 38.1 + RENAME_NEAR_MI + 0.5, cutoff_h: 13, crew: true,
  };

  const { diff } = mergeRace(race, incoming);
  assert.ok(diff.some((d) => d.kind === "removed" && d.key === "Pinchot Camp"));
  assert.ok(diff.some((d) => d.kind === "added" && d.key === "Pinchot"));
  assert.ok(!diff.some((d) => d.kind === "renamed"));
});

test("a hand-typed station cutoff survives a re-read of the chart", () => {
  const race = baseRace();
  race.aid_stations[1].cutoff_h = 4.5;
  race.provenance["aid_stations[1].cutoff_h"] = { by: "user", at: AT };
  const incoming = structuredClone(baseRace());
  incoming.aid_stations[1].cutoff_h = 4;
  incoming.aid_stations[1].crew = true;

  const { merged, conflicts } = mergeRace(race, incoming);
  assert.equal(merged.aid_stations[1].cutoff_h, 4.5);
  assert.equal(merged.aid_stations[1].crew, true, "the rest of the station still updates");
  assert.deepEqual(conflicts.map((c) => c.path), ["aid_stations[1].cutoff_h"]);
  assert.equal(conflicts[0].key, "Kendall");
});

test("an inserted station carries the per-station provenance to its new index", () => {
  const race = baseRace();
  race.aid_stations[2].gpx_wpt = "PINCHOT";
  race.provenance["aid_stations[2].gpx_wpt"] = { by: "user", at: AT };
  const incoming = structuredClone(baseRace());
  incoming.aid_stations.splice(1, 0, { name: "Little Giant", total_mi: 6.2, cutoff_h: 2, crew: false });
  incoming.aid_stations[3].gpx_wpt = "PINCHOT CAMP";

  const { merged } = mergeRace(race, incoming);
  assert.equal(merged.aid_stations[3].name, "Pinchot Camp");
  assert.equal(merged.aid_stations[3].gpx_wpt, "PINCHOT", "the owner's waypoint pick is not re-matched away");
  assert.deepEqual(merged.provenance["aid_stations[3].gpx_wpt"], { by: "user", at: AT });
  assert.equal(merged.provenance["aid_stations[2].gpx_wpt"], undefined, "the stale index is gone");
});

test("a station dropped from the new chart is kept when the owner hand-edited even one of its fields", () => {
  const race = baseRace();
  race.aid_stations[1].cutoff_h = 4.5; // Kendall
  race.provenance["aid_stations[1].cutoff_h"] = { by: "user", at: AT };
  const incoming = structuredClone(baseRace());
  incoming.aid_stations.splice(1, 1); // the new chart drops Kendall entirely

  const { merged, diff, conflicts } = mergeRace(race, incoming);
  assert.deepEqual(merged.aid_stations.map((s) => s.name), ["Silverton", "Kendall", "Pinchot Camp", "Molas"]);
  assert.equal(merged.aid_stations[1].cutoff_h, 4.5);
  assert.ok(!diff.some((d) => d.kind === "removed"), "no field ownership means no field is safe to erase by dropping the row");
  const kept = diff.find((d) => d.path === "aid_stations[1]" && d.kind === "kept");
  assert.ok(kept, diff.map((d) => `${d.kind}:${d.path}`).join(" | "));
  assert.equal(kept.key, "Kendall");
  assert.ok(conflicts.includes(kept));
});

test("a renamed station whose name the owner claimed does not also get a misattributed 'renamed' entry", () => {
  const race = baseRace();
  race.provenance["aid_stations[2].name"] = { by: "user", at: AT }; // Pinchot Camp
  const incoming = structuredClone(baseRace());
  incoming.aid_stations[2] = { name: "Pinchot", total_mi: 38.4, cutoff_h: 13, crew: true };

  const { merged, diff } = mergeRace(race, incoming);
  assert.equal(merged.aid_stations[2].name, "Pinchot Camp", "the owner's name wins");
  const entriesForName = diff.filter((d) => d.path === "aid_stations[2].name");
  assert.equal(entriesForName.length, 1, diff.map((d) => `${d.kind}:${d.path}`).join(" | "));
  assert.equal(entriesForName[0].kind, "kept");
  // the rest of the row still merges normally
  assert.equal(merged.aid_stations[2].cutoff_h, 13);
});

test("a user-owned aid_stations array is kept whole", () => {
  const race = baseRace();
  race.provenance.aid_stations = { by: "user", at: AT };
  const incoming = structuredClone(baseRace());
  incoming.aid_stations.push({ name: "Molas Deux", total_mi: 88, cutoff_h: 33, crew: false });

  const { merged, conflicts } = mergeRace(race, incoming);
  assert.deepEqual(merged.aid_stations, race.aid_stations);
  assert.deepEqual(conflicts.map((c) => c.path), ["aid_stations"]);
  assert.equal(conflicts[0].to.length, 5, "the whole proposed chart is the suggestion");
});

test("a refresh that fetched nothing does not erase the source list", () => {
  const race = baseRace();
  race.sources = [{ kind: "pdf", ref: "manual-2026.pdf", file: "manual-2026.pdf" }];
  const incoming = structuredClone(race);
  incoming.sources = [];

  const { merged, diff } = mergeRace(race, incoming);
  assert.deepEqual(merged.sources, race.sources);
  assert.deepEqual(diff, [], "a failed fetch is not a statement about where the race came from");

  // …but a cache that DID fetch something replaces it
  const fetched = structuredClone(race);
  fetched.sources = [{ kind: "pdf", ref: "manual-2027.pdf", file: "manual-2027.pdf" }];
  assert.deepEqual(mergeRace(race, fetched).merged.sources, fetched.sources);
});

/* ------------------------- unresolved recompute --------------------------- */

test("unresolved is recomputed from the merged race, not carried over", () => {
  const race = baseRace();
  race.location = "Silverton, CO";
  race.provenance.location = { by: "user", at: AT };
  const incoming = structuredClone(baseRace());
  incoming.location = null;         // the refresh could not find it again
  incoming.cutoff_h = null;         // …nor this, and nobody has claimed it

  const { merged, unresolved } = mergeRace(race, incoming);
  assert.equal(merged.location, "Silverton, CO");
  assert.ok(!unresolved.includes("location"), "a hole the owner filled is not a hole");
  assert.ok(unresolved.includes("cutoff_h"));
});

/* ------------------------------ block.json -------------------------------- */

const baseBlock = () => ({
  start_date: "2027-04-05",
  total_weeks: 4,
  targets: [
    { wk: 1, target_dist: 38, target_elev: 5800 },
    { wk: 2, target_dist: 46, target_elev: 7400 },
    { wk: 3, target_dist: 52, target_elev: 8900 },
    { wk: 4, target_dist: 36, target_elev: 5400 },
  ],
});

test("a target row is diffed by week, not by position", () => {
  const block = baseBlock();
  const incoming = structuredClone(block);
  incoming.targets.unshift({ wk: 0, target_dist: 30, target_elev: 4000 });
  incoming.targets.find((t) => t.wk === 3).target_dist = 55;

  const { merged, diff } = mergeBlock(block, incoming);
  assert.equal(merged.targets.length, 5);
  assert.deepEqual(paths(diff).filter((p) => p.startsWith("changed")), ["changed:targets[2].target_dist"]);
  assert.equal(at(diff, "targets[2].target_dist").key, 3, "reported against the WEEK, not the row index");
  assert.equal(merged.targets.find((t) => t.wk === 3).target_dist, 55);
});

test("block.json gains no provenance object just by being merged", () => {
  const block = baseBlock();
  const incoming = structuredClone(block);
  incoming.total_weeks = 5;
  const { merged } = mergeBlock(block, incoming);
  assert.equal(merged.total_weeks, 5);
  assert.ok(!("provenance" in merged), "a file that never had provenance does not grow one");
});

test("hand-edited block.json targets survive a refresh merge — the incoming set is a kept diff entry", () => {
  // The shape race-edit.mjs's applyBlockTargetsEdit stamps: block.json owns
  // its own provenance, not race.provenance["block.targets"] (nothing reads
  // that any more — see race-plan.test.mjs and race-edit.test.mjs).
  const block = { ...baseBlock(), provenance: { targets: { by: "user", at: "2027-01-01T00:00:00Z" } } };
  const incoming = structuredClone(block);
  delete incoming.provenance;
  incoming.targets = incoming.targets.map((t) => ({ ...t, target_dist: t.target_dist + 1 }));

  const { merged, diff, conflicts } = mergeBlock(block, incoming);
  assert.deepEqual(merged.targets, block.targets, "the owner's numbers are untouched");
  assert.deepEqual(paths(diff), ["kept:targets"]);
  assert.deepEqual(conflicts, diff, "the whole diff is a conflict — the owner should see the agent's proposal");
  assert.deepEqual(merged.provenance, { targets: { by: "user", at: "2027-01-01T00:00:00Z" } }, "ownership itself is untouched");
});

/* ---------------------------- nutrition.json ------------------------------ */

const baseNutrition = () => ({
  flask_ml: 500,
  sodium_mg_hr: 650,
  phases: [{ until_h: 12, carb_g_hr: 75 }],
  drop_bag_gear: {
    Start: ["sunscreen", "hat"],
    Kendall: ["headlamp"],
  },
});

test("drop_bag_gear diffs per station", () => {
  const n = baseNutrition();
  const incoming = structuredClone(n);
  incoming.drop_bag_gear.Kendall = ["headlamp", "spare battery"];
  incoming.drop_bag_gear.Molas = ["fresh socks"];

  const { merged, diff } = mergeNutrition(n, incoming);
  assert.deepEqual(paths(diff), ["added:drop_bag_gear.Molas", "changed:drop_bag_gear.Kendall"]);
  assert.deepEqual(merged.drop_bag_gear.Start, ["sunscreen", "hat"]);
  assert.deepEqual(merged.drop_bag_gear.Molas, ["fresh socks"]);
});

test("a user-owned drop bag keeps its gear", () => {
  const n = baseNutrition();
  n.provenance = { "drop_bag_gear.Kendall": { by: "user", at: AT } };
  const incoming = structuredClone(baseNutrition());
  incoming.drop_bag_gear.Kendall = ["nothing at all"];

  const { merged, conflicts } = mergeNutrition(n, incoming);
  assert.deepEqual(merged.drop_bag_gear.Kendall, ["headlamp"]);
  assert.deepEqual(conflicts.map((c) => c.path), ["drop_bag_gear.Kendall"]);
});

/* ------------------------------ the folder -------------------------------- */

test("mergeRaceFolder groups the diff by file and skips what the refresh did not produce", () => {
  const current = { race: baseRace(), block: baseBlock(), nutrition: baseNutrition() };
  const incoming = {
    race: (() => { const r = structuredClone(baseRace()); r.distance_mi = 101; return r; })(),
    block: (() => { const b = structuredClone(baseBlock()); b.targets[0].target_dist = 40; return b; })(),
    nutrition: null,
  };

  const { files, diff } = mergeRaceFolder(current, incoming);
  assert.deepEqual(Object.keys(files).sort(), ["block.json", "race.json"]);
  assert.deepEqual([...new Set(diff.map((d) => d.file))].sort(), ["block.json", "race.json"]);
  assert.equal(files["race.json"].distance_mi, 101);
});

test("a file the race did not have yet is taken whole", () => {
  const current = { race: baseRace(), block: null, nutrition: null };
  const incoming = { race: structuredClone(baseRace()), block: baseBlock(), nutrition: null };

  const { files, diff } = mergeRaceFolder(current, incoming);
  assert.deepEqual(files["block.json"], baseBlock());
  assert.deepEqual(diff.map((d) => `${d.file}:${d.kind}`), ["block.json:added"]);
});

/* ------------------------------- guards ----------------------------------- */

test("mergeFile refuses anything that is not a pair of objects", () => {
  assert.throws(() => mergeFile(null, {}), /current race\.json must be an object/);
  assert.throws(() => mergeFile({}, [1]), /incoming race\.json must be an object/);
});
