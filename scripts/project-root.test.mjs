// node --test scripts/project-root.test.mjs   (or: cd web && npm test)
//
// The two environment variables the Playwright suite (web/tests/) runs on.
// Both are inert when unset — that is half of what these tests pin — and both
// are a contract other code has to keep honouring:
//
//   TRAIL_PROJECT_ROOT  every script and the dev server read and write under
//                       this root instead of the checkout, so a UI test can
//                       drive the real app against synthetic fixtures without
//                       touching the developer's own gitignored snapshots.
//   TRAIL_FAKE_AGENT    runClaudeJson resolves with this file's contents
//                       instead of spawning the `claude` CLI.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { projectRoot } from "./lib.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECKOUT = path.resolve(SCRIPTS_DIR, "..");

/** Run `fn` with TRAIL_PROJECT_ROOT set to `value`, then put it back. */
async function withRoot(value, fn) {
  const before = process.env.TRAIL_PROJECT_ROOT;
  if (value === undefined) delete process.env.TRAIL_PROJECT_ROOT;
  else process.env.TRAIL_PROJECT_ROOT = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.TRAIL_PROJECT_ROOT;
    else process.env.TRAIL_PROJECT_ROOT = before;
  }
}

/* ------------------------- TRAIL_PROJECT_ROOT -------------------------- */

test("with no TRAIL_PROJECT_ROOT, the root is the checkout scripts/ lives in", async () => {
  await withRoot(undefined, () => {
    assert.equal(projectRoot(), CHECKOUT);
  });
  // An empty or whitespace-only value is the same as unset — a launcher that
  // exports the variable without a value must not silently redirect writes.
  await withRoot("", () => assert.equal(projectRoot(), CHECKOUT));
  await withRoot("   ", () => assert.equal(projectRoot(), CHECKOUT));
});

test("an absolute TRAIL_PROJECT_ROOT replaces the checkout", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "trail-root-"));
  try {
    await withRoot(tmp, () => assert.equal(projectRoot(), path.resolve(tmp)));
    // Normalised, so a trailing slash or a "." segment is the same root.
    await withRoot(`${tmp}/./`, () => assert.equal(projectRoot(), path.resolve(tmp)));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("a relative TRAIL_PROJECT_ROOT is ignored, not resolved against the cwd", async () => {
  // Resolving it would make every read and write depend on where the process
  // happened to start — worse than no override at all.
  await withRoot("some/where", () => assert.equal(projectRoot(), CHECKOUT));
});

test("projectRoot re-reads the variable on every call", async () => {
  // The dev server imports these modules lazily, long after startup; a value
  // cached at module load would pin whatever root was current at first import.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "trail-root-"));
  try {
    await withRoot(tmp, () => assert.equal(projectRoot(), path.resolve(tmp)));
    await withRoot(undefined, () => assert.equal(projectRoot(), CHECKOUT));
    await withRoot(tmp, () => assert.equal(projectRoot(), path.resolve(tmp)));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("every script resolves its root through projectRoot(), not import.meta.url", async () => {
  // The regression this guards: a new script (or a revert) re-deriving the
  // root from its own file location writes into the checkout even when the
  // suite has pointed everything else at a temp root — and the UI test that
  // exercises it then quietly edits the developer's real race folders.
  const files = (await fs.readdir(SCRIPTS_DIR))
    // lib.mjs is where projectRoot() itself lives — the one legitimate
    // place the expression may appear.
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs") && f !== "lib.mjs");
  const offenders = [];
  for (const f of files) {
    const src = await fs.readFile(path.join(SCRIPTS_DIR, f), "utf8");
    if (/path\.resolve\(\s*path\.dirname\((?:new URL\(import\.meta\.url\)\.pathname|fileURLToPath\(import\.meta\.url\))\)\s*,\s*"\.\."\s*\)/.test(src)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [], `these re-derive the project root instead of calling projectRoot(): ${offenders.join(", ")}`);
});

test("web/vite.config.ts resolves the project root once, from the same variable", async () => {
  const src = await fs.readFile(path.join(CHECKOUT, "web", "vite.config.ts"), "utf8");
  assert.match(src, /process\.env\.TRAIL_PROJECT_ROOT/, "vite.config.ts must honour TRAIL_PROJECT_ROOT");
  // publicDir too: the page fetches /strava.json and friends statically, so a
  // dev server whose API followed the variable but whose static files did not
  // would serve the real snapshots into a test run.
  assert.match(src, /publicDir:\s*path\.join\(PROJECT_ROOT/, "publicDir must follow PROJECT_ROOT");
  // No plugin may keep its own copy of the old expression.
  assert.equal(
    /const projectRoot = path\.resolve\(__dirname, '\.\.'\)/.test(src),
    false,
    "a dev-API plugin is still deriving its own project root from __dirname",
  );
  // A malformed override already warned; a VALID one resolved no differently
  // from unset — nothing printed to say the dev server is serving somewhere
  // other than the checkout it lives in. A developer who exports it while
  // debugging a failing Playwright run, forgets to unset it, then runs
  // `npm run dev` in the same shell gets no signal that anything is off.
  const body = /function resolveProjectRoot\(\): string \{(.+?)\n\}/s.exec(src);
  assert.ok(body, "could not find resolveProjectRoot");
  assert.match(
    body[1],
    /console\.log\(.*TRAIL_PROJECT_ROOT.*\$\{resolved\}/,
    "resolveProjectRoot must log the resolved root once when the override is in effect",
  );
});

/* -------------------------- TRAIL_FAKE_AGENT --------------------------- */

test("TRAIL_FAKE_AGENT returns the file's contents instead of spawning claude", async () => {
  const { runClaudeJson } = await import("./agent-run.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "trail-agent-"));
  const file = path.join(dir, "reply.json");
  const body = '{"summary":"canned"}';
  await fs.writeFile(file, `${body}\n`);
  process.env.TRAIL_FAKE_AGENT = file;
  try {
    const res = await runClaudeJson({ prompt: "anything at all" });
    assert.equal(res.text, body);
    assert.equal(res.wrapper.isError, false);
    assert.equal(res.retried, false);
  } finally {
    delete process.env.TRAIL_FAKE_AGENT;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TRAIL_FAKE_AGENT pointing at nothing fails loudly rather than spawning", async () => {
  const { runClaudeJson } = await import("./agent-run.mjs");
  process.env.TRAIL_FAKE_AGENT = path.join(os.tmpdir(), "trail-agent-does-not-exist.json");
  try {
    // A silent fall-through to a real spawn would turn a typo in a test into
    // a live `claude` invocation — slow, non-deterministic, and billable.
    await assert.rejects(
      runClaudeJson({ prompt: "anything at all" }),
      /TRAIL_FAKE_AGENT=.*could not be read/,
    );
  } finally {
    delete process.env.TRAIL_FAKE_AGENT;
  }
});
