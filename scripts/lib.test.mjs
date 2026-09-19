// Unit tests for scripts/lib.mjs's writeJsonAtomic — specifically the
// concurrent-write repair from PR #23 review round 1 (resilience findings 1
// & 2): two writers racing the same path used to share one `.tmp.<pid>` name,
// so the first `rename` to land deleted the file the other was about to
// rename, throwing a raw ENOENT and, worse, sometimes leaving the target file
// itself interleaved and unparsable (the exact `config/active-race.json`
// corruption the bug reports reproduced). Run with `npm test` from web/
// (node --test, no dependencies); everything here is a temp file.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "./lib.mjs";

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lib-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("writeJsonAtomic writes and reads back the value", async (t) => {
  const dir = await tempDir(t);
  const p = path.join(dir, "config", "active-race.json");
  await writeJsonAtomic(p, { slug: "san-juan-softie-100-2027", mode: "train" });
  assert.deepEqual(JSON.parse(await fs.readFile(p, "utf8")), { slug: "san-juan-softie-100-2027", mode: "train" });
});

test("20 concurrent writeJsonAtomic calls to ONE path leave valid JSON and no stray temp files", async (t) => {
  const dir = await tempDir(t);
  const p = path.join(dir, "config", "active-race.json");

  const calls = Array.from({ length: 20 }, (_, i) =>
    writeJsonAtomic(p, { slug: `race-${i}`, mode: "train" }));
  // None may reject — the old per-process temp name meant the losers of the
  // rename race threw ENOENT (this is the exact 500 the bug reports saw from
  // POST /api/race/activate under a double click).
  const results = await Promise.allSettled(calls);
  const rejected = results.filter((r) => r.status === "rejected");
  assert.deepEqual(rejected, [], rejected.map((r) => r.reason?.message).join("; "));

  // The file is valid JSON — one of the 20 writes, whichever landed last —
  // never a truncated or interleaved mix of two writers' content.
  const text = await fs.readFile(p, "utf8");
  const parsed = JSON.parse(text);
  assert.match(parsed.slug, /^race-\d+$/);
  assert.equal(parsed.mode, "train");

  // No `<path>.tmp.*` survives a call that ran to completion.
  const entries = await fs.readdir(path.dirname(p));
  const stray = entries.filter((e) => e.includes(".tmp."));
  assert.deepEqual(stray, [], `stray temp files: ${stray.join(", ")}`);
});

test("50 concurrent writeJsonAtomic calls across 5 different paths never cross-contaminate", async (t) => {
  const dir = await tempDir(t);
  const paths = Array.from({ length: 5 }, (_, i) => path.join(dir, `race-${i}.json`));
  const calls = [];
  for (let round = 0; round < 10; round++) {
    for (const p of paths) calls.push(writeJsonAtomic(p, { path: p, round }));
  }
  await Promise.all(calls);
  for (const p of paths) {
    const parsed = JSON.parse(await fs.readFile(p, "utf8"));
    assert.equal(parsed.path, p, "each file must end up holding ITS OWN content, never another path's");
  }
  const stray = (await fs.readdir(dir)).filter((e) => e.includes(".tmp."));
  assert.deepEqual(stray, []);
});
