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
  bRacesFor,
  getActiveRace,
  getTrainingSlug,
  listRaces,
  loadActiveRace,
  loadActiveRaceFolder,
  groupRaces,
  loadRaceFolder,
  raceKind,
  readActivePointer,
  resolveViewedRace,
  setActivePointer,
  validateActivation,
  validateRaceJson,
  validateSingleActive,
  weeksOut,
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

test("validateRaceJson accepts intake_warnings as an optional array of strings, nothing else", () => {
  assert.equal(validateRaceJson(validRace({ intake_warnings: ["no PDF renderer on this machine"] })).ok, true);
  assert.equal(validateRaceJson(validRace()).ok, true, "absent entirely is fine — most drafts have none");
  assertRejects(validRace({ intake_warnings: "no PDF renderer" }), "intake_warnings: array of strings");
  assertRejects(validRace({ intake_warnings: [{ message: "no PDF renderer" }] }), "intake_warnings: array of strings");
});

test("validateRaceJson accepts tracking as an optional {url, bib, name}", () => {
  assert.equal(validateRaceJson(validRace()).ok, true, "absent entirely is fine — most races have no tracker");
  assert.equal(validateRaceJson(validRace({ tracking: null })).ok, true, "explicitly null is fine too");
  assert.equal(validateRaceJson(validRace({
    tracking: { url: "https://www.opensplittime.org/events/2026-san-juan-softie-100/spread", bib: "999", name: "Aaron Brooks" },
  })).ok, true);
  // intake fills url months before the athlete has a bib
  assert.equal(validateRaceJson(validRace({
    tracking: { url: "https://www.opensplittime.org/events/x/spread", bib: null, name: null },
  })).ok, true);
  assert.equal(validateRaceJson(validRace({ tracking: {} })).ok, true, "an empty object says 'no tracker yet'");

  assertRejects(validRace({ tracking: "https://www.opensplittime.org/events/x" }), "tracking: object");
  assertRejects(validRace({ tracking: { url: "https://x.test/e", bib: 999 } }), "tracking.bib: string or null");
  assertRejects(validRace({ tracking: { url: "https://x.test/e", name: { first: "A" } } }), "tracking.name: string or null");
  // the adapter registry detects by hostname, so a scheme-less URL would
  // only fail on race morning
  assertRejects(validRace({ tracking: { url: "opensplittime.org/events/x/spread" } }), "tracking.url: absolute http(s) URL");
  assertRejects(validRace({ tracking: { url: "ftp://x.test/e" } }), "tracking.url: absolute http(s) URL");
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

test("getActiveRace rejects a malformed but well-formed-JSON pointer", async (t) => {
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

test("a pointer file that is not valid JSON degrades to generic mode with a warning, and is repaired in place", async (t) => {
  // PR #23 review round 1, resilience findings 1 & 2: two activations racing
  // writeJsonAtomic's old per-process temp name could interleave two writes
  // into config/active-race.json, leaving it unparsable — GET /api/races
  // then 500'd forever with no in-app way back. readActivePointer now
  // tolerates exactly this (a JSON syntax error), never a well-formed but
  // wrong SHAPE (still rejected above — that is a real typo to surface).
  const root = await tempRoot(t);
  await writeRaceFolder(root, "san-juan-softie-100-2027", { "race.json": validRace({ status: "active" }) });
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  const p = path.join(root, "config", "active-race.json");
  // The exact corruption shape the bug reports captured: two writers' JSON
  // concatenated.
  await fs.writeFile(p, '{\n  "slug": null,\n  "mode": "train"\n}",\n  "mode": "view"\n}');

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  let pointer;
  try {
    pointer = await readActivePointer(root);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(pointer, { slug: null, mode: "train" });
  assert.ok(warnings.some((w) => w.includes("active-race.json")), warnings.join("\n"));

  // and the file itself is repaired, so the NEXT read doesn't warn again
  assert.deepEqual(JSON.parse(await fs.readFile(p, "utf8")), { slug: null, mode: "train" });
  assert.equal(await getActiveRace(root), null);
  // /api/races' own read (listRaces + readActivePointer) never throws off it
  await assert.doesNotReject(() => loadActiveRace(root));
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

test("validateActivation refuses a tune-up hand-edited to active, and a corrupted double-active", async (t) => {
  const root = await tempRoot(t);
  // A quick-form tune-up whose status was hand-edited to "active" (bug: the
  // PRD invariant "a tune-up is never active" was only enforced at write
  // time — validateKind — never again here, at the one other place a folder
  // becomes the training target).
  await writeRaceFolder(root, "san-juan-softie-100-2027", { "race.json": validRace({ status: "active" }) });
  await writeRaceFolder(root, "jemez-mountain-50k-2027", { "race.json": validBRace({ status: "active" }) });
  // ...and the same for an ORPHANED tune-up — no parent folder on disk at all.
  await writeRaceFolder(root, "orphan-tuneup-2027", {
    "race.json": validBRace({ slug: "orphan-tuneup-2027", parent_slug: "no-such-race-2099", status: "active" }),
  });
  const races = await listRaces(root);

  for (const slug of ["jemez-mountain-50k-2027", "orphan-tuneup-2027"]) {
    const bad = validateActivation({ slug, mode: "train" }, races);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "bad_request");
    assert.match(bad.errors[0], /is a tune-up \(kind "b"\)/);
    // view mode still works — a tune-up can be browsed, just never trained for
    assert.equal(validateActivation({ slug, mode: "view" }, races).ok, true);
  }

  // The A race is unaffected by its tune-ups also (wrongly) reading "active".
  assert.equal(validateActivation({ slug: "san-juan-softie-100-2027", mode: "train" }, races).ok, true);
});

test("validateActivation refuses train mode while two A folders both read active on disk", async (t) => {
  const root = await tempRoot(t);
  await writeRaceFolder(root, "one-100-2026", { "race.json": validRace({ slug: "one-100-2026", status: "active" }) });
  await writeRaceFolder(root, "two-100-2027", { "race.json": validRace({ slug: "two-100-2027", status: "active" }) });
  const races = await listRaces(root);

  // Neither can be trained for while the disk disagrees with itself — the
  // pointer must not silently pick a winner (race-edit.mjs's own
  // draft-to-active transition refuses the same way rather than demoting the
  // other folder).
  for (const slug of ["one-100-2026", "two-100-2027"]) {
    const bad = validateActivation({ slug, mode: "train" }, races);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "bad_request");
    assert.match(bad.errors[0], /more than one active race/);
    // view mode is unaffected — browsing either folder is still fine
    assert.equal(validateActivation({ slug, mode: "view" }, races).ok, true);
  }
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

/* ===================== A-races and their tune-ups (PRD-v2 §3) ===================== */

/** A tune-up hanging off validRace()'s slug. The quick form writes exactly
    this much: no cutoff, no features, one finish line. */
function validBRace(over = {}) {
  return {
    schema_version: 1,
    slug: "jemez-mountain-50k-2027",
    kind: "b",
    parent_slug: "san-juan-softie-100-2027",
    status: "draft",
    name: "Jemez Mountain 50K",
    short: "JM50K",
    date: "2027-05-22",
    start_time: "06:00",
    timezone: "America/Denver",
    distance_mi: 31,
    gain_ft: 5000,
    cutoff_h: null,
    aid_stations: [{ name: "Finish", total_mi: 31, cutoff_h: null }],
    ...over,
  };
}

/** listRaces' shape, for the validator's optional `races` context. */
const rows = (...races) => races.map((race) => ({ slug: race.slug, race, error: null }));

test("kind defaults to a, so every folder written before v2 is unchanged", () => {
  const legacy = validRace();
  assert.equal("kind" in legacy, false);
  assert.equal(raceKind(legacy), "a");
  assert.equal(raceKind({ kind: "b" }), "b");
  assert.equal(raceKind(null), "a");
  assert.equal(validateRaceJson(legacy).ok, true);
});

test("validateRaceJson accepts a tune-up whose parent is an A folder on disk", () => {
  const { ok, errors } = validateRaceJson(validBRace(), { races: rows(validRace()) });
  assert.deepEqual(errors, []);
  assert.equal(ok, true);
});

test("validateRaceJson: a tune-up needs a parent, and it must be an A race that exists", () => {
  const orphan = validBRace();
  delete orphan.parent_slug;
  assertRejects(orphan, "parent_slug");

  // shape alone passes without the folder list — the caller that has not read
  // races/ gets the honest answer, not a guess
  assert.equal(validateRaceJson(validBRace({ parent_slug: "ghost-race-2027" })).ok, true);
  const { ok, errors } = validateRaceJson(validBRace({ parent_slug: "ghost-race-2027" }), { races: rows(validRace()) });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("no race folder races/ghost-race-2027/")), errors.join(" | "));

  // ... and a tune-up cannot hang off another tune-up
  const chained = validBRace({ slug: "second-50k-2027", parent_slug: "jemez-mountain-50k-2027" });
  const nested = validateRaceJson(chained, { races: rows(validRace(), validBRace()) });
  assert.equal(nested.ok, false);
  assert.ok(nested.errors.some((e) => e.includes("is itself a tune-up")), nested.errors.join(" | "));

  assertRejects(validBRace({ parent_slug: "jemez-mountain-50k-2027" }), "cannot be its own parent");
  assertRejects(validBRace({ parent_slug: "Not Kebab" }), "lowercase kebab-case");
  assertRejects(validRace({ parent_slug: "something-2027" }), "only a tune-up");
  assertRejects(validBRace({ kind: "c" }), "kind must be one of");
});

test("validateRaceJson: a tune-up is never active — the A race stays the training target", () => {
  assertRejects(validBRace({ status: "active" }), 'is never "active"');
  for (const status of ["draft", "archived"]) {
    assert.equal(validateRaceJson(validBRace({ status }), { races: rows(validRace()) }).ok, true, status);
  }
});

test("validateRaceJson: a tune-up may carry no course at all, but a course it has must be ordered", () => {
  const noStations = validBRace();
  delete noStations.aid_stations;
  assert.equal(validateRaceJson(noStations, { races: rows(validRace()) }).ok, true);
  assert.equal(validateRaceJson(validBRace({ aid_stations: [] }), { races: rows(validRace()) }).ok, true);

  // the same hole in an A race is still a hole
  const aNoStations = validRace();
  delete aNoStations.aid_stations;
  assertRejects(aNoStations, "aid_stations: non-empty array required");

  // and a station list that IS there gets the full ordering check
  assertRejects(
    validBRace({ aid_stations: [{ name: "Half", total_mi: 20 }, { name: "Finish", total_mi: 10 }] }),
    "is behind the previous station",
  );
});

test("weeksOut counts whole weeks back from race day in the A race's own zone", () => {
  const parent = { date: "2027-08-13", timezone: "America/Denver" };
  assert.equal(weeksOut("2027-08-13", parent), 0, "race week");
  assert.equal(weeksOut("2027-08-06", parent), 1);
  assert.equal(weeksOut("2027-05-22", parent), 12);
  // a 41-day gap rounds to 6 whole weeks — and the DST change between May and
  // August in Denver cannot move it
  assert.equal(weeksOut("2027-07-03", parent), 6);
  // after race day: negative, so a tune-up left behind by a moved A date is
  // visible rather than silently dropped
  assert.equal(weeksOut("2027-08-27", parent), -2);
  assert.equal(weeksOut("not-a-date", parent), null);
  assert.equal(weeksOut("2027-08-06", { date: "2027-08-13", timezone: "Mars/Olympus" }), 1, "a bad zone still counts weeks");
  assert.equal(weeksOut("2027-08-06", null), null);
});

test("bRacesFor lists a race's own tune-ups, oldest first, with weeks_out", () => {
  const a = validRace({ status: "active" });
  const early = validBRace({ slug: "cinder-cone-25k-2027", name: "Cinder Cone 25K", date: "2027-04-10", distance_mi: 15.5, gain_ft: 2200 });
  const late = validBRace();
  const other = validBRace({ slug: "someone-elses-50k-2027", parent_slug: "another-race-2027" });
  const list = bRacesFor(rows(a, late, early, other), { ...a, slug: a.slug });
  assert.deepEqual(list, [
    { slug: "cinder-cone-25k-2027", name: "Cinder Cone 25K", date: "2027-04-10", distance_mi: 15.5, gain_ft: 2200, weeks_out: 18 },
    { slug: "jemez-mountain-50k-2027", name: "Jemez Mountain 50K", date: "2027-05-22", distance_mi: 31, gain_ft: 5000, weeks_out: 12 },
  ]);
  assert.deepEqual(bRacesFor(rows(a), { ...a, slug: a.slug }), []);
  assert.deepEqual(bRacesFor(rows(a, late), null), []);
});

test("groupRaces nests tune-ups under their A race and never loses an orphan", () => {
  const list = [
    { slug: "san-juan-softie-100-2027", kind: "a", parent_slug: null, date: "2027-08-13" },
    { slug: "jemez-mountain-50k-2027", kind: "b", parent_slug: "san-juan-softie-100-2027", date: "2027-05-22" },
    { slug: "cinder-cone-25k-2027", kind: "b", parent_slug: "san-juan-softie-100-2027", date: "2027-04-10" },
    { slug: "stray-50k-2027", kind: "b", parent_slug: "deleted-race-2026", date: "2027-03-01" },
    { slug: "mogollon-monster-100-2026", kind: "a", parent_slug: null, date: "2026-09-12" },
  ];
  const grouped = groupRaces(list);
  assert.deepEqual(grouped.map((g) => g.slug), [
    "san-juan-softie-100-2027",
    // the orphan keeps its place in the flat order rather than vanishing
    "stray-50k-2027",
    "mogollon-monster-100-2026",
  ]);
  assert.deepEqual(grouped[0].b_races.map((b) => b.slug), ["cinder-cone-25k-2027", "jemez-mountain-50k-2027"]);
  assert.deepEqual(grouped[1].b_races, []);
  assert.deepEqual(groupRaces([]), []);
});

test("groupRaces flags an orphan tune-up as parent_missing rather than an ordinary A race", () => {
  const list = [
    { slug: "san-juan-softie-100-2027", kind: "a", parent_slug: null, date: "2027-08-13" },
    { slug: "cinder-cone-25k-2027", kind: "b", parent_slug: "san-juan-softie-100-2027", date: "2027-04-10" },
    { slug: "stray-50k-2027", kind: "b", parent_slug: "deleted-race-2026", date: "2027-03-01" },
  ];
  const grouped = groupRaces(list);
  const [parent, orphan] = grouped;
  assert.equal(parent.slug, "san-juan-softie-100-2027");
  assert.equal("parent_missing" in parent, false, "a real A race must not be flagged");
  assert.equal(orphan.slug, "stray-50k-2027");
  assert.equal(orphan.kind, "b");
  assert.equal(orphan.parent_missing, true);
  assert.deepEqual(orphan.b_races, []);
});

test("validateSingleActive is unaffected by tune-ups", async (t) => {
  const root = await tempRoot(t);
  await writeRaceFolder(root, "san-juan-softie-100-2027", { "race.json": validRace({ status: "active" }) });
  await writeRaceFolder(root, "jemez-mountain-50k-2027", { "race.json": validBRace() });
  const races = await listRaces(root);
  const { ok, active } = validateSingleActive(races);
  assert.equal(ok, true);
  assert.deepEqual(active, ["san-juan-softie-100-2027"]);
});
