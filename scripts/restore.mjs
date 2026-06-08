#!/usr/bin/env node
// Restores a previously-saved backup into the working tree.
// By default picks the most recent backup in ~/Documents/trail-train-backups/.
//
// Usage:
//   node scripts/restore.mjs                       # latest backup
//   node scripts/restore.mjs --from 2026-05-27-1430
//   node scripts/restore.mjs --list                # show backups, exit
//   node scripts/restore.mjs --oauth               # also restore OAuth tokens
//
// By default OAuth tokens are NOT restored — they're sensitive and you
// usually don't want to overwrite what's currently active. Pass --oauth
// to opt in.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEST_ROOT = arg("dest", path.join(os.homedir(), "Documents", "trail-train-backups"));
const FROM = arg("from", null);
const LIST = !!arg("list", false);
const INCLUDE_OAUTH = !!arg("oauth", false);

async function listBackups() {
  const entries = await fs.readdir(DEST_ROOT, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
}

async function copyIfExists(from, to) {
  try {
    const buf = await fs.readFile(from);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, buf);
    return buf.length;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function main() {
  const backups = await listBackups();
  if (LIST) {
    if (backups.length === 0) {
      console.log(`(no backups at ${DEST_ROOT})`);
    } else {
      console.log(`backups in ${DEST_ROOT}:`);
      for (const b of backups) console.log(`  ${b}`);
    }
    return;
  }
  if (backups.length === 0) {
    console.error(`✗ no backups at ${DEST_ROOT}. Run scripts/backup.mjs first.`);
    process.exit(2);
  }

  const which = FROM || backups[0];
  const src = path.join(DEST_ROOT, which);
  try { await fs.access(src); }
  catch { console.error(`✗ ${src} not found. Available: ${backups.join(", ")}`); process.exit(2); }

  console.log(`• restoring from ${src}`);
  const mapping = [
    { from: "snapshots/strava.json",    to: path.join(ROOT, "web/public/strava.json") },
    { from: "snapshots/oura.json",      to: path.join(ROOT, "web/public/oura.json") },
    { from: "snapshots/coach.json",     to: path.join(ROOT, "web/public/coach.json") },
    { from: "snapshots/state.json",     to: path.join(ROOT, "web/public/state.json") },
    { from: "snapshots/google-cal.json", to: path.join(ROOT, "web/public/google-cal.json") },
    { from: "config/profile.json",      to: path.join(ROOT, "config/profile.json") },
  ];
  if (INCLUDE_OAUTH) {
    mapping.push(
      { from: "oauth/strava-mcp.config.json", to: path.join(os.homedir(), ".config/strava-mcp/config.json") },
      { from: "oauth/oura.config.json",       to: path.join(os.homedir(), ".config/oura/config.json") },
      { from: "oauth/google.tokens.json",     to: path.join(os.homedir(), ".config/google/tokens.json") },
    );
  }

  let restored = 0;
  for (const m of mapping) {
    const size = await copyIfExists(path.join(src, m.from), m.to);
    if (size != null) {
      restored += 1;
      console.log(`  ✓ ${m.from.padEnd(36)} → ${path.relative(ROOT, m.to) || m.to}`);
    } else {
      console.log(`  · ${m.from.padEnd(36)} not in this backup, skipped`);
    }
  }
  console.log(`\n✓ restored ${restored} files from ${which}`);
  if (!INCLUDE_OAUTH) {
    console.log(`  OAuth tokens not restored (pass --oauth to include them).`);
  }
}

main().catch((e) => { console.error("✗", e.message || e); process.exit(1); });
