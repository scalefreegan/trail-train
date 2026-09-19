// Unit tests for the athlete profile loader. Run with `npm test` from web/
// (node --test, no dependencies). Fixtures live in a temp dir — except the
// last two tests, which read the committed config/profile.example.json and
// web/vite.config.ts so a hand-edit that breaks the schema, or that lets the
// settings PUT and the loader disagree about the bounds, fails CI.
//
// What's worth pinning down here is the FALLBACK behavior. A profile with no
// physiology still has to produce a plan, and the numbers it produces it with
// are not the athlete's — so the contract is "documented default, announced",
// and a silent default is the bug this file exists to catch.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_BODY_KG,
  DEFAULT_LONG_RUN_REF_MI,
  PHYSIOLOGY_FIELDS,
  loadProfile,
  loadProfileWithWarnings,
  normalizePhysiology,
  profilePath,
  resetProfileWarnings,
} from "./profile.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "profile-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeConfig(root, name, contents) {
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(
    path.join(root, "config", name),
    typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
  );
}

/** Run `fn` with console.warn captured, returning what it printed. */
async function captureWarn(fn) {
  const lines = [];
  const orig = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  try {
    const value = await fn();
    return { value, lines };
  } finally {
    console.warn = orig;
  }
}

/* ---------------- normalizePhysiology ---------------- */

test("a complete physiology block passes through untouched and silently", () => {
  const { physiology, warnings } = normalizePhysiology({ body_kg: 68.2, long_run_ref_mi: 26 });
  assert.deepEqual(physiology, { body_kg: 68.2, long_run_ref_mi: 26 });
  assert.deepEqual(warnings, []);
});

test("a missing block gets both defaults, and says so for each", () => {
  const { physiology, warnings } = normalizePhysiology(undefined);
  assert.equal(physiology.body_kg, DEFAULT_BODY_KG);
  assert.equal(physiology.long_run_ref_mi, DEFAULT_LONG_RUN_REF_MI);
  assert.equal(warnings.length, 2, "one warning per substituted field");
  assert.ok(warnings.some((w) => w.includes("body_kg")));
  assert.ok(warnings.some((w) => w.includes("long_run_ref_mi")));
});

test("a partial block keeps what it has and defaults only the rest", () => {
  const { physiology, warnings } = normalizePhysiology({ body_kg: 61 });
  assert.equal(physiology.body_kg, 61);
  assert.equal(physiology.long_run_ref_mi, DEFAULT_LONG_RUN_REF_MI);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("long_run_ref_mi"));
});

test("out-of-band, non-finite and non-numeric values fall back with a warning", () => {
  for (const bad of [0, -5, 29, 201, "75", null, NaN, Infinity, { kg: 75 }]) {
    const { physiology, warnings } = normalizePhysiology({ body_kg: bad, long_run_ref_mi: 20 });
    assert.equal(physiology.body_kg, DEFAULT_BODY_KG, `body_kg ${JSON.stringify(bad)}`);
    assert.equal(warnings.length, 1, `body_kg ${JSON.stringify(bad)} should warn once`);
  }
  // the bounds are the ones the settings PUT enforces — inclusive at both ends
  assert.equal(normalizePhysiology({ body_kg: 30, long_run_ref_mi: 5 }).warnings.length, 0);
  assert.equal(normalizePhysiology({ body_kg: 200, long_run_ref_mi: 50 }).warnings.length, 0);
  assert.equal(normalizePhysiology({ body_kg: 75, long_run_ref_mi: 51 }).physiology.long_run_ref_mi,
    DEFAULT_LONG_RUN_REF_MI);
});

test("a physiology that isn't an object is reported, not spread", () => {
  const { physiology, warnings } = normalizePhysiology("70");
  assert.deepEqual(physiology, { body_kg: DEFAULT_BODY_KG, long_run_ref_mi: DEFAULT_LONG_RUN_REF_MI });
  assert.ok(warnings.some((w) => w.includes("not an object")));
});

test("the defaults are impersonal round numbers, not anyone's real values", () => {
  // The whole point of the move: the committed fallbacks must not be a body
  // weight someone actually has. A fractional default would be a leak.
  assert.equal(DEFAULT_BODY_KG, Math.round(DEFAULT_BODY_KG));
  assert.equal(DEFAULT_LONG_RUN_REF_MI, Math.round(DEFAULT_LONG_RUN_REF_MI));
});

/* ---------------- loadProfile ---------------- */

test("loadProfile reads config/profile.json and normalizes its physiology", async (t) => {
  const root = await tempRoot(t);
  await writeConfig(root, "profile.json", {
    athlete_name: "test runner",
    physiology: { body_kg: 58.5, long_run_ref_mi: 15 },
  });

  const { profile, warnings } = await loadProfileWithWarnings(root);
  assert.equal(profile.athlete_name, "test runner");
  assert.deepEqual(profile.physiology, { body_kg: 58.5, long_run_ref_mi: 15 });
  assert.deepEqual(warnings, []);
});

test("a profile written before physiology existed gets defaults AND a console warning", async (t) => {
  const root = await tempRoot(t);
  await writeConfig(root, "profile.json", { athlete_name: "legacy", home_trails: ["a ridge"] });

  resetProfileWarnings();
  const { value: profile, lines } = await captureWarn(() => loadProfile(root));
  // backward compatible: everything it did carry survives
  assert.equal(profile.athlete_name, "legacy");
  assert.deepEqual(profile.home_trails, ["a ridge"]);
  // …and the two it didn't are filled in, out loud
  assert.deepEqual(profile.physiology, {
    body_kg: DEFAULT_BODY_KG,
    long_run_ref_mi: DEFAULT_LONG_RUN_REF_MI,
  });
  assert.equal(lines.length, 2, `expected two warnings, got: ${lines.join(" | ")}`);
  assert.ok(lines.every((l) => l.includes("profile.json")));
});

test("the same warning is printed once per process, not once per read", async (t) => {
  // loadFactsFromRoot runs many times in one process (the chat endpoint, the
  // test suite). Repeating the substitution notice on every read is noise —
  // and enough interleaved child-process output to destabilize node --test.
  const root = await tempRoot(t);
  await writeConfig(root, "profile.json", { athlete_name: "legacy" });

  resetProfileWarnings();
  const first = await captureWarn(() => loadProfile(root));
  assert.equal(first.lines.length, 2);
  const second = await captureWarn(() => loadProfile(root));
  assert.deepEqual(second.lines, [], "the second read says nothing new");
  // …but the values are still there, every time
  assert.equal(second.value.physiology.body_kg, DEFAULT_BODY_KG);
});

test("no profile.json falls back to the example file", async (t) => {
  const root = await tempRoot(t);
  await writeConfig(root, "profile.example.json", {
    athlete_name: "the athlete",
    physiology: { body_kg: 75, long_run_ref_mi: 20 },
  });

  const { profile, warnings } = await loadProfileWithWarnings(root);
  assert.equal(profile.athlete_name, "the athlete");
  assert.equal(profile.physiology.body_kg, 75);
  assert.deepEqual(warnings, []);
});

test("profile.json wins over the example when both exist", async (t) => {
  const root = await tempRoot(t);
  await writeConfig(root, "profile.example.json", { athlete_name: "the athlete" });
  await writeConfig(root, "profile.json", { athlete_name: "mine", physiology: { body_kg: 80, long_run_ref_mi: 22 } });

  const { profile } = await loadProfileWithWarnings(root);
  assert.equal(profile.athlete_name, "mine");
  assert.equal(profile.physiology.body_kg, 80);
});

test("a corrupt profile.json falls through to the example rather than throwing — loudly, not silently", async (t) => {
  const root = await tempRoot(t);
  await writeConfig(root, "profile.json", "{ nope, not json ");
  await writeConfig(root, "profile.example.json", { athlete_name: "the athlete" });

  const { profile, warnings } = await loadProfileWithWarnings(root);
  assert.equal(profile.athlete_name, "the athlete");
  // the example carries no physiology in this fixture, so the defaults apply
  assert.equal(profile.physiology.body_kg, DEFAULT_BODY_KG);
  // the corrupt-file warning, PLUS the two physiology defaults — not just 2:
  // a corrupt file being silently treated the same as a missing one is
  // exactly the bug this test guards against.
  assert.equal(warnings.length, 3, `expected 3 warnings, got: ${JSON.stringify(warnings)}`);
  const corruptWarning = warnings.find((w) => w.includes(profilePath(root)));
  assert.ok(corruptWarning, `expected a warning naming ${profilePath(root)}, got: ${JSON.stringify(warnings)}`);
  assert.ok(/failed to parse/i.test(corruptWarning), "names the parse failure, not just the file");
  assert.ok(corruptWarning.includes("JSON"), "carries JSON.parse's own message, not a generic one");
});

test("a corrupt profile.json prints a console.warn naming the file and the parse error", async (t) => {
  const root = await tempRoot(t);
  await writeConfig(root, "profile.json", "{ nope, not json ");

  resetProfileWarnings();
  const { value: profile, lines } = await captureWarn(() => loadProfile(root));
  // still degrades to a usable profile — this is about visibility, not throwing
  assert.equal(profile.athlete_name, "the athlete");
  assert.ok(
    lines.some((l) => l.includes(profilePath(root)) && /failed to parse/i.test(l)),
    `expected a console.warn naming ${profilePath(root)} and the parse failure, got: ${JSON.stringify(lines)}`,
  );
});

test("an empty project still yields a usable, complete profile", async (t) => {
  const root = await tempRoot(t);
  const { profile } = await loadProfileWithWarnings(root);
  assert.equal(typeof profile.athlete_name, "string");
  assert.equal(profile.physiology.body_kg, DEFAULT_BODY_KG);
  assert.equal(profile.physiology.long_run_ref_mi, DEFAULT_LONG_RUN_REF_MI);
});

/* ---------------- the committed files ---------------- */

test("the committed profile.example.json is complete, impersonal and race_base-free", async () => {
  const example = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, "config", "profile.example.json"), "utf8"),
  );
  const { physiology, warnings } = normalizePhysiology(example.physiology);
  assert.deepEqual(warnings, [], "the example must validate on its own terms");
  assert.equal(physiology.body_kg, DEFAULT_BODY_KG, "the example must carry the impersonal default");
  assert.equal(physiology.long_run_ref_mi, DEFAULT_LONG_RUN_REF_MI);
  // tt-yib.9: the crew base moved to races/<slug>/crew.private.json, and a
  // lodging address has no business in a committed file anyway.
  assert.equal(example.race_base, undefined, "race_base must be gone from the example profile");
});

test("the settings PUT bounds match the loader's (KEEP IN SYNC comment, enforced)", async () => {
  // vite.config.ts can't import from scripts/, so the bounds are typed twice.
  // A silent drift means the dialog saves a value the loader then rejects and
  // replaces with a default — the exact silent-substitution this bead removed.
  const vite = await fs.readFile(path.join(PROJECT_ROOT, "web", "vite.config.ts"), "utf8");
  for (const [key, spec] of Object.entries(PHYSIOLOGY_FIELDS)) {
    assert.ok(
      vite.includes(`${key}: [${spec.lo}, ${spec.hi}]`),
      `web/vite.config.ts PHYSIOLOGY_BOUNDS is missing "${key}: [${spec.lo}, ${spec.hi}]"`,
    );
  }
});
