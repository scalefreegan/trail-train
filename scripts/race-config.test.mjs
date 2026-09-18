// Unit tests for the race-folder loader. Run with `npm test` from web/
// (node --test, no dependencies). Every fixture is synthetic and written to
// a temp dir — the one exception is the last test, which READS the committed
// races/ folders so a hand-edit that breaks the schema fails CI.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getActiveRace,
  getTrainingSlug,
  listRaces,
  loadActiveRace,
  loadActiveRaceFolder,
  loadRaceFolder,
  readActivePointer,
  resolveViewedRace,
  setActivePointer,
  validateActivation,
  validateRaceJson,
  validateSingleActive,
} from "./race-config.mjs";
import { draftValidationErrors } from "./race-intake.mjs";

/** A minimal race.json that validates — tests mutate a copy of it. */
function validRace(over = {}) {
  return {
    schema_version: 1,
    slug: "san-juan-softie-100-2027",
    status: "draft",
    name: "San Juan Softie 100",
    short: "SJS100",
    edition_year: 2027,
    date: "2027-08-13",
    start_time: "06:00",
    timezone: "America/Denver",
    location: "Durango, CO",
    format: "point_to_point",
    distance_mi: 104,
    gain_ft: 19000,
    elevation: { min_ft: 8770, max_ft: 12438, avg_ft: 10282, altitude_significant: true },
    cutoff_h: 38,
    features: { crew: true, drop_bags: true, pacers: true, night: true, heat: false, altitude: true },
    aid_stations: [
      { name: "Kennebec", total_mi: 12.4, cutoff_h: null, crew: false, drop_bag: false, menu: "basic" },
      { name: "Cross Mountain", total_mi: 45.8, cutoff_h: 14, crew: true, drop_bag: true, menu: "full" },
      { name: "Finish", total_mi: 104, cutoff_h: 38, crew: true, drop_bag: false, menu: "full" },
    ],
    coach_notes: { terrain: "high and rocky", climate: "", altitude: "", key_demands: "", race_week: "" },
    visual: { theme_preset: "alpine", accent: "#4b7f9e" },
    provenance: { date: { by: "user", at: "2026-09-18T00:00:00Z" } },
    sources: [{ kind: "url", ref: "https://sanjuansoftie.com", fetched_at: "2026-09-18T00:00:00Z" }],
    ...over,
  };
}

/** Fresh temp project root; caller writes whatever folders the test needs. */
async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "race-config-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRaceFolder(root, slug, files) {
  const dir = path.join(root, "races", slug);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

/** Assert the validator failed, and that one message mentions `needle`. */
function assertRejects(race, needle) {
  const { ok, errors } = validateRaceJson(race);
  assert.equal(ok, false, `expected a rejection mentioning ${needle}`);
  assert.ok(errors.some((e) => e.includes(needle)), `errors ${JSON.stringify(errors)} mention none of "${needle}"`);
}

test("validateRaceJson accepts a complete race", () => {
  const { ok, errors } = validateRaceJson(validRace());
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test("validateRaceJson rejects a missing or non-IANA timezone", () => {
  const missing = validRace();
  delete missing.timezone;
  assertRejects(missing, "timezone");
  assertRejects(validRace({ timezone: "Mountain Time" }), "not an IANA zone name");
  // a plain UTC offset is not a zone — DST rules are the whole point
  assertRejects(validRace({ timezone: "-06:00" }), "not an IANA zone name");
  assert.equal(validateRaceJson(validRace({ timezone: "UTC" })).ok, true);
});

test("validateRaceJson rejects non-monotonic aid miles", () => {
  const race = validRace();
  race.aid_stations[1].total_mi = 8; // behind Kennebec at 12.4
  assertRejects(race, "is behind the previous station");
});

test("validateRaceJson rejects non-monotonic cutoffs among non-null values", () => {
  const race = validRace();
  race.aid_stations[2].cutoff_h = 9; // earlier than Cross Mountain's 14
  assertRejects(race, "is earlier than the previous cutoff");
  // nulls in between are fine — most stations post no cutoff
  const gapped = validRace();
  gapped.aid_stations[1].cutoff_h = null;
  assert.equal(validateRaceJson(gapped).ok, true);
});

test("validateRaceJson rejects a status outside the enum", () => {
  assertRejects(validRace({ status: "retired" }), "status must be one of");
  assertRejects(validRace({ status: undefined }), "status must be one of");
  for (const status of ["draft", "active", "archived"]) {
    assert.equal(validateRaceJson(validRace({ status })).ok, true, status);
  }
});

test("validateRaceJson rejects a wrong schema_version", () => {
  assertRejects(validRace({ schema_version: 2 }), "schema_version must be 1");
  assertRejects(validRace({ schema_version: undefined }), "schema_version must be 1");
});

test("validateRaceJson collects the other shape errors", () => {
  assertRejects(null, "race.json must be a JSON object");
  assertRejects([validRace()], "race.json must be a JSON object");
  assertRejects(validRace({ aid_stations: [] }), "aid_stations: non-empty array required");
  assertRejects(validRace({ slug: "San Juan 2027" }), "kebab-case");
  assertRejects(validRace({ distance_mi: 0 }), "distance_mi");
  assertRejects(validRace({ date: "Aug 13 2027" }), "date must be");
  assertRejects(validRace({ cutoff_h: -1 }), "cutoff_h");
  assertRejects(validRace({ features: { crew: "yes" } }), "features.crew: boolean required");
  assertRejects(validRace({ sources: [{ kind: "tweet", ref: "x" }] }), "sources[0].kind");
});

test("listRaces returns [] when races/ is missing and skips non-races", async (t) => {
  const root = await tempRoot(t);
  assert.deepEqual(await listRaces(root), []);

  await writeRaceFolder(root, "san-juan-softie-100-2027", { "race.json": validRace() });
  await writeRaceFolder(root, "_template", { "race.json": validRace({ slug: "_template" }) });
  await fs.mkdir(path.join(root, "races", "notes"), { recursive: true }); // no race.json
  await fs.writeFile(path.join(root, "races", "README.md"), "not a folder\n");

  const races = await listRaces(root);
  assert.deepEqual(races.map((r) => r.slug), ["san-juan-softie-100-2027"]);
  assert.equal(races[0].race.name, "San Juan Softie 100");
  assert.equal(races[0].error, null);
});

test("listRaces surfaces an unparseable race.json instead of dropping it", async (t) => {
  const root = await tempRoot(t);
  await writeRaceFolder(root, "broken-100-2027", { "race.json": "{ not json" });
  const [entry] = await listRaces(root);
  assert.equal(entry.slug, "broken-100-2027");
  assert.equal(entry.race, null);
  assert.match(entry.error, /not valid JSON/);
});

test("validateSingleActive flags more than one active folder", async (t) => {
  const root = await tempRoot(t);
  await writeRaceFolder(root, "one-100-2026", { "race.json": validRace({ slug: "one-100-2026", status: "active" }) });
  await writeRaceFolder(root, "two-100-2027", { "race.json": validRace({ slug: "two-100-2027", status: "active" }) });
  await writeRaceFolder(root, "three-50k-2028", { "race.json": validRace({ slug: "three-50k-2028", status: "draft" }) });

  const races = await listRaces(root);
  const { ok, errors, active } = validateSingleActive(races);
  assert.equal(ok, false);
  assert.deepEqual(active, ["one-100-2026", "two-100-2027"]);
  assert.match(errors[0], /more than one active race/);

  // and one active is fine
  await fs.writeFile(
    path.join(root, "races", "two-100-2027", "race.json"),
    JSON.stringify(validRace({ slug: "two-100-2027", status: "archived" }), null, 2),
  );
  assert.equal(validateSingleActive(await listRaces(root)).ok, true);
});

test("getActiveRace bootstraps the pointer to null, never to a race", async (t) => {
  const root = await tempRoot(t);
  await writeRaceFolder(root, "san-juan-softie-100-2027", { "race.json": validRace({ status: "active" }) });

  assert.equal(await getActiveRace(root), null);
  const written = JSON.parse(await fs.readFile(path.join(root, "config", "active-race.json"), "utf8"));
  assert.deepEqual(written, { slug: null, mode: "train" });
  assert.deepEqual(await loadActiveRace(root), { active: null });

  // a pointer that names a race is read back verbatim
  await fs.writeFile(
    path.join(root, "config", "active-race.json"),
    JSON.stringify({ slug: "san-juan-softie-100-2027" }),
  );
  assert.equal(await getActiveRace(root), "san-juan-softie-100-2027");
});

test("getActiveRace rejects a malformed pointer", async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  const p = path.join(root, "config", "active-race.json");
  await fs.writeFile(p, JSON.stringify({ race: "san-juan" }));
  await assert.rejects(() => getActiveRace(root), /slug/);
  await fs.writeFile(p, JSON.stringify({ slug: "" }));
  await assert.rejects(() => getActiveRace(root), /non-empty string or null/);
  await fs.writeFile(p, JSON.stringify({ slug: "san-juan", mode: "edit" }));
  await assert.rejects(() => getActiveRace(root), /mode must be one of/);
});

/* --------------------- the pointer's train/view mode -------------------- */

test("a pointer written before modes existed reads as train mode", async (t) => {
  const root = await tempRoot(t);
  await writeRaceFolder(root, "san-juan-softie-100-2027", { "race.json": validRace({ status: "active" }) });
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(
    path.join(root, "config", "active-race.json"),
    JSON.stringify({ slug: "san-juan-softie-100-2027" }),
  );

  assert.deepEqual(await readActivePointer(root), { slug: "san-juan-softie-100-2027", mode: "train" });
  assert.equal(await getTrainingSlug(root), "san-juan-softie-100-2027");
  assert.equal((await loadActiveRaceFolder(root))?.slug, "san-juan-softie-100-2027");
});

test("view mode is on screen but is not the training target", async (t) => {
  const root = await tempRoot(t);
  await writeRaceFolder(root, "mogollon-monster-100-2026", {
    "race.json": validRace({ slug: "mogollon-monster-100-2026", status: "archived" }),
  });
  await setActivePointer(root, { slug: "mogollon-monster-100-2026", mode: "view" });

  const viewed = await resolveViewedRace(root);
  assert.equal(viewed.slug, "mogollon-monster-100-2026");
  assert.equal(viewed.mode, "view");
  assert.equal(viewed.training, false);
  assert.equal(viewed.folder.race.status, "archived");
  // the coach's two questions both answer "generic mode"
  assert.equal(await loadActiveRaceFolder(root), null);
  assert.equal(await getTrainingSlug(root), null);
  // but the pointer still names the folder on screen
  assert.equal(await getActiveRace(root), "mogollon-monster-100-2026");
});

test("validateActivation: train needs an active folder, view does not", async (t) => {
  const root = await tempRoot(t);
  await writeRaceFolder(root, "one-100-2026", { "race.json": validRace({ slug: "one-100-2026", status: "archived" }) });
  await writeRaceFolder(root, "two-100-2027", { "race.json": validRace({ slug: "two-100-2027", status: "active" }) });
  await writeRaceFolder(root, "three-50k-2028", { "race.json": validRace({ slug: "three-50k-2028", status: "draft" }) });
  const races = await listRaces(root);

  // the one race that may be trained for
  assert.deepEqual(validateActivation({ slug: "two-100-2027", mode: "train" }, races).pointer,
    { slug: "two-100-2027", mode: "train" });
  // ...and the two that may not
  for (const slug of ["one-100-2026", "three-50k-2028"]) {
    const bad = validateActivation({ slug, mode: "train" }, races);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "bad_request");
    assert.match(bad.errors[0], /only an "active" race can be trained for/);
    // the same folder in view mode is fine
    assert.equal(validateActivation({ slug, mode: "view" }, races).ok, true);
  }

  // generic mode: mode is meaningless without a race, so it normalizes away
  assert.deepEqual(validateActivation({ slug: null, mode: "view" }, races).pointer, { slug: null, mode: "train" });
  assert.deepEqual(validateActivation({ slug: null }, races).pointer, { slug: null, mode: "train" });

  // and the refusals the endpoint turns into 404 / 400
  assert.equal(validateActivation({ slug: "nope-100-2029", mode: "view" }, races).code, "not_found");
  assert.equal(validateActivation({ slug: "two-100-2027", mode: "sideways" }, races).code, "bad_request");
  assert.equal(validateActivation({ slug: 7 }, races).code, "bad_request");
  assert.equal(validateActivation({}, races).code, "bad_request");
  assert.equal(validateActivation(null, races).code, "bad_request");
  assert.equal(validateActivation([], races).code, "bad_request");
});

test("setActivePointer writes only what validateActivation allows", async (t) => {
  const root = await tempRoot(t);
  await writeRaceFolder(root, "one-100-2026", { "race.json": validRace({ slug: "one-100-2026", status: "archived" }) });
  const pointerFile = path.join(root, "config", "active-race.json");

  assert.deepEqual(await setActivePointer(root, { slug: "one-100-2026", mode: "view" }),
    { slug: "one-100-2026", mode: "view" });
  assert.deepEqual(JSON.parse(await fs.readFile(pointerFile, "utf8")), { slug: "one-100-2026", mode: "view" });

  await assert.rejects(
    () => setActivePointer(root, { slug: "one-100-2026", mode: "train" }),
    (e) => e.code === "bad_request" && /only an "active" race/.test(e.message),
  );
  await assert.rejects(
    () => setActivePointer(root, { slug: "ghost-100-2030", mode: "view" }),
    (e) => e.code === "not_found",
  );
  // a refused activation leaves the pointer exactly as it was
  assert.deepEqual(JSON.parse(await fs.readFile(pointerFile, "utf8")), { slug: "one-100-2026", mode: "view" });

  assert.deepEqual(await setActivePointer(root, { slug: null }), { slug: null, mode: "train" });
  assert.equal(await getActiveRace(root), null);
});

test("loadRaceFolder round-trips a folder, optional files as null", async (t) => {
  const root = await tempRoot(t);
  const race = validRace({ status: "active" });
  const block = { start_date: "2027-03-29", total_weeks: 20, targets: [{ wk: 1, target_dist: 38, target_elev: 5800 }] };
  await writeRaceFolder(root, race.slug, { "race.json": race, "block.json": block });

  const loaded = await loadRaceFolder(root, race.slug);
  assert.deepEqual(loaded.race, race);
  assert.deepEqual(loaded.block, block);
  assert.equal(loaded.plan, null);
  assert.equal(loaded.nutrition, null);
  assert.equal(loaded.slug, race.slug);
  assert.equal(validateRaceJson(loaded.race).ok, true);

  // and the merged /api/race/active payload for the same folder
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "active-race.json"), JSON.stringify({ slug: race.slug }));
  const payload = await loadActiveRace(root);
  assert.equal(payload.active, race.slug);
  assert.deepEqual(payload.race, race);
  assert.deepEqual(payload.block, block);
  assert.equal(payload.nutrition, null);
});

test("loadRaceFolder throws for a folder that is not there", async (t) => {
  const root = await tempRoot(t);
  await assert.rejects(() => loadRaceFolder(root, "nope-100-2027"), /race\.json not found/);
});

// The committed race folders are the schema's only real-world instances, so
// they are part of the test surface: a hand-edit that breaks race.json (or a
// second folder marked "active") has to fail here rather than at load time in
// the dashboard.
test("the committed race folders validate", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const races = await listRaces(root);
  assert.ok(races.length > 0, "expected at least one committed race folder");
  for (const r of races) {
    assert.equal(r.error, null, `${r.slug}: ${r.error}`);
    // A draft may carry known unknowns (null + named in unresolved[]) until the
    // review dialog fills them; archived/active folders must validate outright.
    const { errors } = r.race.status === "draft"
      ? draftValidationErrors(r.race, r.race.unresolved ?? [])
      : validateRaceJson(r.race);
    assert.equal(errors.length, 0, `${r.slug}/race.json: ${errors.join("; ")}`);
  }
  assert.equal(validateSingleActive(races).ok, true);
  assert.ok(races.some((r) => r.slug === "mogollon-monster-100-2026"), "MM100 folder is missing");

  // block.json and nutrition.json are committed alongside race.json; plan.json
  // and result.json are gitignored, so they are absent in a fresh checkout.
  const mm100 = await loadRaceFolder(root, "mogollon-monster-100-2026");
  assert.equal(mm100.block.total_weeks, 20);
  assert.equal(mm100.race.status, "archived");
  assert.equal(mm100.race.timezone, "America/Phoenix");
  assert.equal(mm100.race.aid_stations.length, 15);
  assert.ok(mm100.nutrition.caffeine, "nutrition.json should carry the caffeine block");
});
