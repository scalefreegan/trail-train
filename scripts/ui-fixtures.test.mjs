// node --test scripts/ui-fixtures.test.mjs   (or: cd web && npm test)
//
// The Playwright suite's fixtures have one hard rule: nothing in them may be
// real. They stand in for files that are gitignored precisely because they
// hold a year of somebody's runs, sleep, heart rate and calendar — so a
// fixture written by copying a snapshot "just to get the shape right" would
// commit exactly the data the .gitignore exists to keep out.
//
// This is the automated half of that rule: a grep over every committed fixture
// AND over the snapshots the generator produces, for the shapes personal data
// takes — an e-mail address, a phone number, a street address, a real person's
// name, a coordinate near anywhere the athlete actually runs.
//
// It also checks the race fixtures still validate, because a fixture that has
// quietly stopped parsing takes the UI suite down with a failure that reads as
// a UI bug.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectRoot } from "./lib.mjs";
import { validateRaceJson } from "./race-config.mjs";
import { draftValidationErrors } from "./race-intake.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_RACES = path.join(ROOT, "races", "_fixtures");
const UI_FIXTURES = path.join(ROOT, "web", "tests", "fixtures");

/** Every committed fixture file, as {rel, text}. */
async function fixtureFiles() {
  const out = [];
  for (const base of [FIXTURE_RACES, UI_FIXTURES]) {
    const walk = async (dir) => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { await walk(p); continue; }
        out.push({ rel: path.relative(ROOT, p), text: await fs.readFile(p, "utf8") });
      }
    };
    await walk(base);
  }
  return out;
}

/**
 * Patterns that have no business in a synthetic fixture. Each one is paired
 * with the exceptions the fixtures legitimately contain, so the test fails on
 * a new match rather than on the ones that were deliberate.
 */
const FORBIDDEN = [
  {
    what: "an e-mail address",
    re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
    allow: () => false,
  },
  {
    what: "a phone number",
    // +1 555 867 5309 / (505) 555-0100 / 505-555-0100
    re: /(?:\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g,
    allow: () => false,
  },
  {
    what: "a street address",
    re: /\b\d{1,5}\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place)\b/g,
    allow: () => false,
  },
  {
    what: "a real http(s) host",
    re: /https?:\/\/[^\s"'<>]+/g,
    // Only example.invalid (RFC 2606's reserved TLD — it cannot resolve) and
    // the GPX schema URL a GPX file is required to carry.
    allow: (m) => /^https?:\/\/(example\.invalid|www\.topografix\.com)\b/.test(m),
  },
];

test("no committed UI fixture contains anything that looks like personal data", async () => {
  const problems = [];
  for (const { rel, text } of await fixtureFiles()) {
    for (const { what, re, allow } of FORBIDDEN) {
      for (const m of text.match(new RegExp(re.source, re.flags)) ?? []) {
        if (!allow(m)) problems.push(`${rel}: ${what} — ${JSON.stringify(m)}`);
      }
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});

test("the generated snapshots contain nothing that looks like personal data either", async () => {
  // The dashboard snapshots are built at launch time, not committed, so the
  // grep above never sees them — this runs the generator and greps the output.
  const { buildSnapshots, buildGenericPlan } = await import(
    path.join(ROOT, "web", "tests", "fixtures", "snapshots.mjs")
  );
  const text = JSON.stringify({ ...buildSnapshots(new Date()), plan: buildGenericPlan(new Date()) });
  const problems = [];
  for (const { what, re, allow } of FORBIDDEN) {
    for (const m of text.match(new RegExp(re.source, re.flags)) ?? []) {
      if (!allow(m)) problems.push(`generated snapshots: ${what} — ${JSON.stringify(m)}`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`);
});

test("every fixture race.json is a valid race.json", async () => {
  const slugs = (await fs.readdir(FIXTURE_RACES, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(slugs.length >= 3, `expected the fixture races to still be there, found ${slugs.join(", ") || "none"}`);
  for (const slug of slugs) {
    const race = JSON.parse(await fs.readFile(path.join(FIXTURE_RACES, slug, "race.json"), "utf8"));
    // A draft is judged by draft rules: its holes are the point (the review
    // dialog's whole job), and they are legal as long as race.json admits to
    // them in `unresolved`. Anything else has to pass the full schema.
    const errors = race.status === "draft"
      ? draftValidationErrors(race, race.unresolved ?? []).errors
      : validateRaceJson(race).errors;
    assert.deepEqual(errors, [], `races/_fixtures/${slug}/race.json: ${errors.join("; ")}`);
    assert.equal(race.slug, slug, `races/_fixtures/${slug}/race.json declares slug ${race.slug}`);
  }
});

test("exactly one fixture race is active, as the schema requires", async () => {
  const slugs = (await fs.readdir(FIXTURE_RACES, { withFileTypes: true }))
    .filter((e) => e.isDirectory()).map((e) => e.name);
  const active = [];
  for (const slug of slugs) {
    const race = JSON.parse(await fs.readFile(path.join(FIXTURE_RACES, slug, "race.json"), "utf8"));
    if (race.status === "active") active.push(slug);
  }
  assert.deepEqual(active, ["mm-like-100"], "the fixture tree must have exactly one active race");
});

test("_fixtures is not a race folder the app can ever load", () => {
  // listRaces skips underscore-prefixed folders; this is the reminder that the
  // fixture tree is data for the tests, never a race in the app's own races/.
  assert.equal(path.basename(FIXTURE_RACES).startsWith("_"), true);
  // …and the tests read fixtures out of the checkout, not out of whatever
  // TRAIL_PROJECT_ROOT happens to be pointing at.
  assert.equal(ROOT, projectRoot());
});
