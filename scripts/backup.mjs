#!/usr/bin/env node
// Backs up the local-only files the dashboard needs but doesn't commit:
//   - web/public/{strava,oura,coach}.json   (personal training snapshots)
//   - config/profile.json                   (athlete name / location / trails)
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

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEST_ROOT = arg("dest", path.join(os.homedir(), "Documents", "trail-train-backups"));
const KEEP = Number(arg("keep", 10));

const stamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

const SOURCES = [
  { from: path.join(ROOT, "web/public/strava.json"),                 to: "snapshots/strava.json",       optional: true },
  { from: path.join(ROOT, "web/public/oura.json"),                   to: "snapshots/oura.json",         optional: true },
  { from: path.join(ROOT, "web/public/coach.json"),                  to: "snapshots/coach.json",        optional: true },
  { from: path.join(ROOT, "config/profile.json"),                    to: "config/profile.json",         optional: true },
  { from: path.join(os.homedir(), ".config/strava-mcp/config.json"), to: "oauth/strava-mcp.config.json", optional: true, sensitive: true },
  { from: path.join(os.homedir(), ".config/oura/config.json"),       to: "oauth/oura.config.json",       optional: true, sensitive: true },
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

async function main() {
  const dir = path.join(DEST_ROOT, stamp());
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(DEST_ROOT, 0o700).catch(() => {});

  console.log(`• backing up to ${dir}`);
  let total = 0, copied = 0, sensitiveCount = 0;
  for (const s of SOURCES) {
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
    sources: SOURCES.map((s) => s.to),
    note: "Backups directory is mode 0700; OAuth credentials are mode 0600. Do not commit, do not share.",
  };
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  await pruneOld(DEST_ROOT, KEEP);

  console.log(`\n✓ ${copied} files (${(total / 1024).toFixed(1)} KB) → ${dir}`);
  if (sensitiveCount > 0) {
    console.log(`  ${sensitiveCount} files contain OAuth tokens — directory is mode 0700.`);
  }
  console.log(`  Restore with: cp -r '${dir}/snapshots/'* web/public/`);
}

main().catch((e) => { console.error("✗", e.message || e); process.exit(1); });
