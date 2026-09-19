// .gitignore behavior worth pinning down with a real `git check-ignore`,
// because a text-only ignore file is exactly the kind of thing that looks
// right on a read-through and is wrong in practice (ordering, negation,
// pattern scoping). No fixtures are actually written to disk here beyond
// scratch files under the real races/_fixtures/ tree, always removed in a
// `finally` — this only asks git's own matcher what it thinks, via
// `git check-ignore`, the same tool the review that found this used.
//
// Background: races/_fixtures/** is blanket un-ignored (the opposite of
// personal data — see .gitignore's own comment), but that used to re-include
// races/*/build/, races/*/sources/ and races/*/*.private.json under
// fixtures too, with no guard. Latent today (the harness always copies
// fixtures to a temp root before building) but a helper that ever builds a
// fixture in place would have its generated output staged by a routine
// `git add -A`, unlike every other race folder's build output.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** True when git considers `relPath` ignored, via the real `.gitignore`
    chain — not a re-implementation of the pattern matcher. */
async function isIgnored(relPath) {
  try {
    await execFileAsync("git", ["check-ignore", relPath], { cwd: ROOT });
    return true;
  } catch (e) {
    if (e.code === 1) return false; // git's documented "not ignored" exit
    throw e;
  }
}

/** A real fixture folder already committed under races/_fixtures/, so the
    scratch files below sit inside a tree .gitignore actually has opinions
    about rather than an invented path outside it. */
const FIXTURE_SLUG = "mm-like-100";
const FIXTURE_DIR = path.join(ROOT, "races", "_fixtures", FIXTURE_SLUG);

async function withScratchFile(relUnderFixture, body) {
  const abs = path.join(FIXTURE_DIR, relUnderFixture);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, "{}");
  try {
    await body(path.relative(ROOT, abs));
  } finally {
    await fs.rm(abs, { force: true });
    // Only remove directories this test itself created and left empty —
    // never touch a directory (like the fixture folder root) that was
    // already there.
    const dir = path.dirname(abs);
    if (dir !== FIXTURE_DIR) await fs.rmdir(dir).catch(() => {});
  }
}

test("races/_fixtures' blanket re-inclusion does not re-include build/ output", async () => {
  await withScratchFile(path.join("build", "course.json"), async (rel) => {
    assert.equal(await isIgnored(rel), true, `${rel} must still be ignored under a fixture folder`);
  });
});

test("races/_fixtures' blanket re-inclusion does not re-include sources/ cache", async () => {
  await withScratchFile(path.join("sources", "page.html"), async (rel) => {
    assert.equal(await isIgnored(rel), true, `${rel} must still be ignored under a fixture folder`);
  });
});

test("races/_fixtures' blanket re-inclusion does not re-include *.private.json", async () => {
  await withScratchFile("crew.private.json", async (rel) => {
    assert.equal(await isIgnored(rel), true, `${rel} must still be ignored under a fixture folder`);
  });
});

test("races/_fixtures' own committed files stay trackable — the fix must not over-correct", async () => {
  assert.equal(await isIgnored(path.join("races", "_fixtures", FIXTURE_SLUG, "race.json")), false);
  assert.equal(await isIgnored(path.join("races", "_fixtures", FIXTURE_SLUG, "result.json")), false,
    "an archived fixture race is only worth having WITH its result.json");
});

test("a real (non-fixture) race folder's build/sources/private are still ignored — unaffected by the fixture scoping", async () => {
  // races/mogollon-monster-100-2026/ is the real, committed A-race folder.
  assert.equal(await isIgnored(path.join("races", "mogollon-monster-100-2026", "build", "course.json")), true);
});
