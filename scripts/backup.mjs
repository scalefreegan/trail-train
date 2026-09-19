#!/usr/bin/env node
// Backs up the local-only files the dashboard needs but doesn't commit:
//   - web/public/{strava,oura,coach}.json   (personal training snapshots)
//   - config/profile.json                   (athlete name / location / trails)
//   - config/{active-race,goals}.json       (which race, or the generic goals)
//   - races/**/{plan,result}.json, *.private.json  (per-race local files)
//   - ~/.config/strava-mcp/config.json      (OAuth tokens — SENSITIVE)
//   - ~/.config/oura/config.json            (OAuth tokens — SENSITIVE)
//
// Writes to ~/Documents/trail-train-backups/<YYYY-MM-DD-HHmm>/
// and keeps the last N (default 10) automatically. Run before risky changes
// or on a cron / launchd schedule.
//
// Usage:  node scripts/backup.mjs [--dest ~/path/dir] [--keep 10]

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { arg, projectRoot } from "./lib.mjs";

const ROOT = projectRoot();
const DEST_ROOT = arg("dest", path.join(os.homedir(), "Documents", "trail-train-backups"));
const KEEP = Number(arg("keep", 10));

const stamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

const SOURCES = [
  { from: path.join(ROOT, "web/public/strava.json"),                 to: "snapshots/strava.json",       optional: true },
  { from: path.join(ROOT, "web/public/cross-train.json"),            to: "snapshots/cross-train.json",  optional: true },
  { from: path.join(ROOT, "web/public/oura.json"),                   to: "snapshots/oura.json",         optional: true },
  { from: path.join(ROOT, "web/public/coach.json"),                  to: "snapshots/coach.json",        optional: true },
  { from: path.join(ROOT, "web/public/state.json"),                  to: "snapshots/state.json",        optional: true },
  { from: path.join(ROOT, "web/public/google-cal.json"),             to: "snapshots/google-cal.json",   optional: true },
  { from: path.join(ROOT, "config/profile.json"),                    to: "config/profile.json",         optional: true },
  // Gitignored per-machine/per-race config. goals.json does not exist until
  // generic mode lands (tt-yib.3), which is why everything here is optional.
  { from: path.join(ROOT, "config/active-race.json"),                to: "config/active-race.json",     optional: true },
  { from: path.join(ROOT, "config/goals.json"),                      to: "config/goals.json",           optional: true },
  { from: path.join(ROOT, "config/generic-plan.json"),               to: "config/generic-plan.json",    optional: true },
  { from: path.join(os.homedir(), ".config/strava-mcp/config.json"), to: "oauth/strava-mcp.config.json", optional: true, sensitive: true },
  { from: path.join(os.homedir(), ".config/oura/config.json"),       to: "oauth/oura.config.json",       optional: true, sensitive: true },
  { from: path.join(os.homedir(), ".config/google/tokens.json"),     to: "oauth/google.tokens.json",     optional: true, sensitive: true },
  { from: path.join(os.homedir(), ".config/google/config.json"),     to: "oauth/google.config.json",     optional: true, sensitive: true },
];

async function copyIfExists(from, dest) {
  try {
    const buf = await fs.readFile(from);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf, { mode: 0o600 });
    return buf.length;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

async function pruneOld(root, keep) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  for (const stale of dirs.slice(keep)) {
    await fs.rm(path.join(root, stale), { recursive: true, force: true });
    console.log(`• pruned old backup ${stale}`);
  }
}

/**
 * The gitignored files inside races/ — plan.json, result.json and every
 * *.private.json. Enumerated at run time because the set of races grows, and
 * a race whose private file is missing from a backup is a race whose crew
 * sheet cannot be rebuilt.
 * @returns {Promise<{from: string, to: string, optional: boolean, sensitive: boolean}[]>}
 */
async function raceSources() {
  const out = [];
  const entries = await fs.readdir(path.join(ROOT, "races"), { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const names = await fs.readdir(path.join(ROOT, "races", ent.name)).catch(() => []);
    for (const name of names) {
      if (name !== "plan.json" && name !== "result.json" && !name.endsWith(".private.json")) continue;
      out.push({
        from: path.join(ROOT, "races", ent.name, name),
        to: `races/${ent.name}/${name}`,
        optional: true,
        // crew.private.json carries the lodging address and phone numbers
        sensitive: name.endsWith(".private.json"),
      });
    }
  }
  return out;
}

async function main() {
  const dir = path.join(DEST_ROOT, stamp());
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(DEST_ROOT, 0o700).catch(() => {});

  console.log(`• backing up to ${dir}`);
  let total = 0, copied = 0, sensitiveCount = 0;
  const sources = [...SOURCES, ...(await raceSources())];
  for (const s of sources) {
    const size = await copyIfExists(s.from, path.join(dir, s.to));
    if (size != null) {
      copied += 1;
      total += size;
      if (s.sensitive) sensitiveCount += 1;
      console.log(`  ✓ ${s.to.padEnd(36)} (${(size / 1024).toFixed(1)} KB)`);
    } else if (!s.optional) {
      console.warn(`  ✗ missing required ${s.from}`);
    } else {
      console.log(`  · ${s.to.padEnd(36)} not present, skipped`);
    }
  }

  // Write a small manifest so a future you knows what's in each backup
  const manifest = {
    created_at: new Date().toISOString(),
    project_root: ROOT,
    sources: sources.map((s) => s.to),
    note: "Backups directory is mode 0700; OAuth credentials are mode 0600. Do not commit, do not share.",
  };
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  await pruneOld(DEST_ROOT, KEEP);

  console.log(`\n✓ ${copied} files (${(total / 1024).toFixed(1)} KB) → ${dir}`);
  if (sensitiveCount > 0) {
    console.log(`  ${sensitiveCount} files hold OAuth tokens or crew addresses — directory is mode 0700.`);
  }
  console.log(`  Restore with: cp -r '${dir}/snapshots/'* web/public/`);
}

main().catch((e) => { console.error("✗", e.message || e); process.exit(1); });
