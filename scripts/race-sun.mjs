#!/usr/bin/env node
// Computed sunrise / sunset for a race folder.
//
// Why a script of its own: `race.json.sun` drives the night bands in
// web/src/race/pacing.ts and the heat/dark bands in caffeine.ts, and until now
// the two strings were hand-entered per race (the MM100 folder carried 2025
// values). They are derivable — the course GPX gives the start coordinates and
// race.json gives the date and the IANA zone — so compute them, stamp them
// with provenance `by: "computed"`, and let the hand-authored value be the
// thing that has to justify itself.
//
// It is NOT folded into build-course.mjs on purpose: that script is being
// rewritten per-folder by tt-yib.5, and sun times are a property of the race,
// not of the course profile it emits.
//
// Usage:
//   node scripts/race-sun.mjs --race mogollon-monster-100-2026
//   node scripts/race-sun.mjs            (the active race, else the most recent)
//   node scripts/race-sun.mjs --race <slug> --dry-run
//
// Prints old vs new and writes races/<slug>/race.json in place.

import fs from "node:fs/promises";
import path from "node:path";
import { arg, writeJsonAtomic } from "./lib.mjs";
import { parseGpx } from "./aid-match.mjs";
import { sunTimes } from "./sun.mjs";
import { loadRaceFolder, loadRaceOrMostRecent, raceDir } from "./race-config.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** The provenance `source` every sun block this script writes carries. */
export const SUN_SOURCE = "scripts/race-sun.mjs";

/**
 * Sunrise and sunset for a race, in that race's local wall clock.
 *
 * Pure: everything it needs is the parsed race.json plus the start point, so
 * the same call works from a test, from the intake flow, or from the CLI below.
 *
 * @param {{date:string, timezone:string, slug?:string}} race parsed race.json
 * @param {{lat:number, lon:number}} start signed decimal degrees (north/east
 *   positive, so a US longitude is negative) — the race START, not the finish:
 *   a point-to-point course can span enough longitude to move the clock by a
 *   minute, and the start is the point both bands are measured from.
 * @returns {{sunrise: string|null, sunset: string|null}} "HH:MM", or nulls
 *   inside a polar day / polar night
 */
export function computeRaceSun(race, { lat, lon }) {
  if (!race || typeof race !== "object") throw new TypeError("race-sun: race.json object required");
  const { date, timezone } = race;
  if (typeof date !== "string") throw new TypeError("race-sun: race.date (YYYY-MM-DD) required");
  if (typeof timezone !== "string" || !timezone) {
    throw new TypeError("race-sun: race.timezone (IANA zone) required");
  }
  return sunTimes({ lat, lon, date, timeZone: timezone });
}

/** First track point of races/<slug>/course.gpx — the start line. */
async function startPoint(dir) {
  const gpxPath = path.join(dir, "course.gpx");
  let gpx;
  try {
    gpx = await fs.readFile(gpxPath, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`${gpxPath} not found — no course GPX to take the start from`);
    throw e;
  }
  const { track } = parseGpx(gpx);
  if (!track.length) throw new Error(`${gpxPath} has no <trkpt> elements`);
  return { lat: track[0].lat, lon: track[0].lon };
}

async function main() {
  const slugArg = arg("race", null);
  const dryRun = arg("dry-run", false) === true;

  const folder =
    typeof slugArg === "string"
      ? await loadRaceFolder(ROOT, slugArg)
      : await loadRaceOrMostRecent(ROOT);
  if (!folder) throw new Error("no race folders under races/ — nothing to compute");
  const { slug, race } = folder;
  const dir = raceDir(ROOT, slug);

  const start = await startPoint(dir);
  const next = computeRaceSun(race, start);
  const prev = race.sun ?? {};

  const fmt = (v) => (v == null ? "—" : v);
  console.log(`race       ${slug}`);
  console.log(`start      ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)}`);
  console.log(`date       ${race.date} ${race.timezone}`);
  console.log(`sunrise    ${fmt(prev.sunrise)} → ${fmt(next.sunrise)}`);
  console.log(`sunset     ${fmt(prev.sunset)} → ${fmt(next.sunset)}`);

  if (dryRun) {
    console.log("dry run — race.json not written");
    return;
  }
  if (prev.sunrise === next.sunrise && prev.sunset === next.sunset) {
    console.log("unchanged — race.json not written");
    return;
  }

  // Rewrite the parsed object rather than patching text: race.json is written
  // by several scripts and the atomic writer is the one shared path.
  const updated = { ...race, sun: next };
  updated.provenance = {
    ...(race.provenance ?? {}),
    sun: { by: "computed", at: new Date().toISOString(), source: SUN_SOURCE },
  };
  await writeJsonAtomic(path.join(dir, "race.json"), updated);
  console.log(`wrote races/${slug}/race.json`);
}

// Only the CLI path runs on import — the exports above are used by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(`race-sun: ${e.message}`);
    process.exit(1);
  });
}
