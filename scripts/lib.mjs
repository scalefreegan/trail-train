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

/**
 * Write JSON atomically (write-temp-then-rename) so a crash or kill
 * mid-write can never leave a truncated file behind — the dashboard
 * reads these files while syncs run. Creates the parent dir if needed.
 */
export async function writeJsonAtomic(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + `.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, p);
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
