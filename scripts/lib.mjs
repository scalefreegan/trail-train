// Shared helpers for the trail-train scripts.

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Read a `--name value` CLI argument. Returns `true` for bare flags
 * (`--auth`), the fallback when the flag is absent.
 */
export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}

// Monotonic per-process counter so two writeJsonAtomic calls in the same
// tick (e.g. two concurrent /api/race/activate requests in one dev-server
// process) never share a temp name. PID alone used to be the whole name
// (PR #23 review round 1, resilience findings 1 & 2): every writer in one
// process raced the SAME `<path>.tmp.<pid>`, and the first `rename` to land
// deleted the file the others were about to rename, so the losers threw a
// raw ENOENT and — worse — a write that lost that race could leave the
// pointer file mid-write-of-someone-else's-content. pid + counter + a random
// suffix (in case the counter ever wraps or two processes share a pid across
// a fork) makes every call's temp file unique, so concurrent writers to the
// same path never collide — they just serialize on the final `rename`.
let writeCounter = 0;

/**
 * Write JSON atomically (write-temp-then-rename) so a crash or kill
 * mid-write can never leave a truncated file behind — the dashboard
 * reads these files while syncs run. Creates the parent dir if needed.
 *
 * Safe to call concurrently on the SAME path from the same process: each
 * call gets its own temp file, so one writer's rename can never unlink
 * another's still-in-flight temp file (see the note on writeCounter above).
 * The last rename to land wins; nothing throws ENOENT along the way, and no
 * temp file survives a call that ran to completion (success or failure).
 */
export async function writeJsonAtomic(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const unique = `${process.pid}.${++writeCounter}.${Math.random().toString(36).slice(2, 8)}`;
  const tmp = `${p}.tmp.${unique}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, p);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * Progress lines for humans running a script ("• bootstrapped …"). Silent
 * inside `node --test` children: stdout from a test child interleaves with
 * the runner's IPC stream and, roughly one run in ten, corrupts its framing
 * ("Unable to deserialize cloned data") — an assertion-free failure in an
 * unrelated test file. Warnings still go through console.warn (stderr).
 */
export const UNDER_TEST = Boolean(process.env.NODE_TEST_CONTEXT);
export function note(...args) {
  if (!UNDER_TEST) console.log(...args);
}
