#!/usr/bin/env node
// Intake stage 2: validate and build ONE race folder (PRD §8 steps 3–4).
//
// Stage 1 (scripts/race-intake.mjs) leaves races/<slug>/race.json as a draft
// with known unknowns. Everything after that is deterministic — no agent turn,
// no judgement call — and it is this module:
//
//   1. validate  race.json against the §5.1 schema. A draft is allowed to carry
//                the holes it declared in unresolved[]; anything else aborts.
//   2. gpx       find course.gpx, or fetch it from race.json links.gpx. No GPX
//                and no link is NOT an error: it is an unresolved field, and
//                the review dialog is where the owner drops the file in.
//   3. match     aid stations ↔ GPX waypoints (scripts/aid-match.mjs), writing
//                the chosen `gpx_wpt` back into race.json with provenance
//                `by: "matcher"`. Below aid-match's LOW_CONFIDENCE nothing is
//                written — a mile-only guess becomes an unresolved field a
//                human confirms, because a wrong waypoint moves every crew ETA.
//   4. course    build/course.json + build/crew-base.json (build-course.mjs).
//   5. sun       sunrise/sunset from the start coordinates (race-sun.mjs) when
//                race.json has none, or has one nobody stamped.
//
// race.json is written ONCE, atomically, before the course build — the builder
// reads the folder off disk, so the matched waypoints and the computed sun have
// to be there first. A second run over the same folder writes nothing at all:
// every station now resolves exactly and `sun` carries provenance.
//
// config/active-race.json is never read or written here. Building a folder says
// nothing about which race the athlete is training for.
//
// Usage:  node scripts/race-build.mjs --race <slug>

import fs from "node:fs/promises";
import path from "node:path";
import { arg, writeJsonAtomic } from "./lib.mjs";
import { LOW_CONFIDENCE, matchAidStations, parseGpx } from "./aid-match.mjs";
import { loadRaceFolderAt, raceDir, validateRaceJson } from "./race-config.mjs";
import { collectUnresolved, draftValidationErrors, kebab } from "./race-intake.mjs";
import { buildCourse } from "./build-course.mjs";
import { computeRaceSun, SUN_SOURCE } from "./race-sun.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** A race site that hasn't answered in this long isn't going to. */
const GPX_TIMEOUT_MS = 25_000;

/** A course GPX is a few hundred KB; anything this size is not one. */
const MAX_GPX_BYTES = 32 * 1024 * 1024;

/** Read a file, or null when it simply isn't there. */
async function readIfPresent(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Cache name for a fetched GPX, same shape the intake gives its cached sources
 * (scripts/race-intake.mjs cacheName) so races/<slug>/sources/ stays one kind
 * of thing whichever stage filled it.
 */
function gpxCacheName(url) {
  const u = new URL(url);
  const base = kebab(`${u.hostname}${u.pathname}`) || "course";
  return `${base.slice(0, 80)}.gpx`;
}

/**
 * Download the course GPX named by race.json links.gpx.
 * Never throws: a dead organizer link is a fact to report, not a build failure.
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
async function fetchGpx(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(GPX_TIMEOUT_MS),
      // Same UA the intake fetch uses — some race sites 403 a bare fetch.
      headers: { "user-agent": "Mozilla/5.0 (Macintosh) Basecamp-race-intake/1" },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_GPX_BYTES) return { ok: false, error: `larger than ${MAX_GPX_BYTES} bytes` };
    const text = buf.toString("utf8");
    if (!/<trkpt|<wpt/i.test(text)) return { ok: false, error: "the response has no GPX track or waypoints" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.name === "TimeoutError" ? `timed out after ${GPX_TIMEOUT_MS / 1000}s` : e.message };
  }
}

/**
 * Validate one folder's race.json, with draft semantics when it is a draft.
 * @returns {{unresolved: Set<string>, excused: string[]}}
 * @throws when a non-draft fails the schema, or a draft fails it somewhere it
 *   never admitted to — a draft with a malformed date is a bug, a draft with
 *   no date is a known unknown (see race-intake draftValidationErrors).
 */
function validateForBuild(slug, race) {
  if (race.status === "draft") {
    const unresolved = new Set(collectUnresolved(race));
    const { errors, excused } = draftValidationErrors(race, [...unresolved]);
    if (errors.length) {
      throw new Error(`races/${slug}/race.json failed validation:\n  · ${errors.join("\n  · ")}`);
    }
    return { unresolved, excused };
  }
  const { ok, errors } = validateRaceJson(race);
  if (!ok) throw new Error(`races/${slug}/race.json failed validation:\n  · ${errors.join("\n  · ")}`);
  return { unresolved: new Set(), excused: [] };
}

/**
 * Resolve every aid station to a GPX waypoint, mutating `race` (already a copy)
 * where the matcher is confident enough to commit.
 *
 * @param {object} race a structuredClone of race.json — mutated in place
 * @param {ReturnType<typeof parseGpx>} gpx
 * @param {Set<string>} unresolved added to / removed from in place
 * @param {string[]} warnings appended to
 * @param {string} at ISO timestamp shared by everything this run writes
 * @returns {{matched: object[], changed: boolean}}
 */
function matchStations(race, gpx, unresolved, warnings, at) {
  const stations = race.aid_stations ?? [];
  const measuredMi = gpx.track.at(-1).cum_mi;
  // The GPX routinely runs a percent or two long/short against the official
  // chart; aid-match wants that ratio to read charted miles in track space.
  const scale = Number.isFinite(race.distance_mi) && race.distance_mi > 0
    ? measuredMi / race.distance_mi
    : 1;
  const matches = matchAidStations(stations, gpx, { scale });
  const known = new Set(gpx.waypoints.map((w) => w.name));
  const lastIdx = stations.length - 1;
  const matched = [];
  let changed = false;

  stations.forEach((station, i) => {
    const field = `aid_stations[${i}].gpx_wpt`;
    const add = (over) => matched.push({ index: i, name: station.name, gpx_wpt: null, method: null, confidence: 0, written: false, ...over });

    // Already authored AND still real: nothing to decide. This is what makes a
    // second run a no-op, and what keeps a hand-mapped folder hand-mapped.
    if (station.gpx_wpt && known.has(station.gpx_wpt)) {
      unresolved.delete(field);
      add({ gpx_wpt: station.gpx_wpt, method: "exact", confidence: 1 });
      return;
    }

    // The last station with no waypoint is the finish line, and the finish line
    // is where the track stops — no GPX marks it and build-course.mjs already
    // reads it off the track end. Listing it unresolved would be noise.
    if (!station.gpx_wpt && i === lastIdx) {
      unresolved.delete(field);
      add({ method: "finish", confidence: 1 });
      return;
    }

    // A value the OWNER set is not the matcher's to overwrite (PRD §8: user
    // provenance survives a re-intake). If it has gone stale the human has to
    // be the one to fix it, so say so instead of quietly picking another point.
    if (race.provenance?.[field]?.by === "user") {
      unresolved.add(field);
      warnings.push(
        `${station.name}: user-set gpx_wpt "${station.gpx_wpt}" is not in this GPX — left as authored, resolve it by hand`
      );
      add({ gpx_wpt: station.gpx_wpt ?? null, method: null, confidence: 0 });
      return;
    }

    const m = matches[i];
    if (m.gpx_wpt && m.confidence >= LOW_CONFIDENCE) {
      station.gpx_wpt = m.gpx_wpt;
      race.provenance = race.provenance ?? {};
      race.provenance[field] = { by: "matcher", at, confidence: m.confidence, method: m.method };
      unresolved.delete(field);
      changed = true;
      add({ gpx_wpt: m.gpx_wpt, method: m.method, confidence: m.confidence, written: true });
      return;
    }

    // Below the bar: leave race.json alone and hand it to the review dialog.
    const best = m.candidates?.[0];
    unresolved.add(field);
    warnings.push(
      `${station.name} (mi ${station.total_mi}): no confident GPX waypoint` +
        (best ? ` — best candidate "${best.wpt}" (score ${best.score})` : " — no candidates in this GPX")
    );
    add({ method: m.method, confidence: m.confidence, candidates: m.candidates });
  });

  return { matched, changed };
}

/**
 * Run stage 2 over races/<slug>/ — or over `dir`, when a re-intake is building
 * a shadow copy of the folder (scripts/race-refresh.mjs). `root` still points
 * at the repo either way; only the folder being written moves.
 *
 * @param {{root: string, slug: string, dir?: string,
 *          onProgress?: (e: {step: string, status: string, label?: string,
 *                            message?: string, stream?: string}) => void}} opts
 * @returns {Promise<{slug: string, dir: string, unresolved: string[],
 *                    warnings: string[], matched: object[],
 *                    course: object|null, sun: object|null}>}
 *   `unresolved` is what still needs a human after this stage; `matched` has one
 *   row per aid station (`written` marks the ones the matcher committed).
 */
export async function buildRace({ root, slug, dir = raceDir(root, slug), onProgress = () => {} }) {
  if (!root) throw new Error("buildRace: root is required");
  if (!slug) throw new Error("buildRace: slug is required");
  const step = (id, status, extra = {}) => onProgress({ step: id, status, ...extra });
  const say = (id, message, extra = {}) => onProgress({ step: id, status: "log", message, ...extra });
  const at = new Date().toISOString();
  const warnings = [];

  /* 1. validate */
  step("validate", "start", { label: "validating race.json" });
  const folder = await loadRaceFolderAt(dir, slug);
  const race = structuredClone(folder.race);
  const { unresolved, excused } = validateForBuild(slug, race);
  for (const e of excused) say("validate", `known gap (listed unresolved): ${e}`);
  step("validate", "done", { unresolved: unresolved.size });

  /* 2. the course GPX */
  step("gpx", "start", { label: "locating course.gpx" });
  const gpxPath = path.join(dir, "course.gpx");
  let gpxText = await readIfPresent(gpxPath);
  const stop = (message) => {
    unresolved.add("course.gpx");
    warnings.push(message);
    say("gpx", message, { stream: "err" });
    step("gpx", "done", { found: false });
    return {
      slug, dir, unresolved: [...unresolved].sort(), warnings,
      matched: [], course: null, sun: race.sun ?? null,
    };
  };
  if (gpxText === null) {
    const link = typeof race.links?.gpx === "string" ? race.links.gpx.trim() : "";
    if (!/^https?:\/\/\S+$/i.test(link)) {
      return stop("no course.gpx in the folder and no http(s) links.gpx to fetch one from");
    }
    say("gpx", `fetching ${link}`);
    const got = await fetchGpx(link);
    if (!got.ok) return stop(`no course.gpx — fetching ${link} failed: ${got.error}`);
    // Two copies on purpose: course.gpx is what the build reads, sources/ is
    // the cache a re-intake diffs against (same rule as the stage-1 sources).
    await fs.mkdir(path.join(dir, "sources"), { recursive: true });
    await fs.writeFile(path.join(dir, "sources", gpxCacheName(link)), got.text);
    await fs.writeFile(gpxPath, got.text);
    gpxText = got.text;
    say("gpx", `saved races/${slug}/course.gpx (${(got.text.length / 1024).toFixed(0)} KB)`);
  }
  const gpx = parseGpx(gpxText);
  if (!gpx.track.length) return stop("races/" + slug + "/course.gpx has no <trkpt> track to build from");
  step("gpx", "done", {
    found: true, waypoints: gpx.waypoints.length, track_points: gpx.track.length,
  });

  /* 3. aid stations ↔ waypoints */
  step("match", "start", { label: "matching aid stations to GPX waypoints" });
  const { matched, changed } = matchStations(race, gpx, unresolved, warnings, at);
  for (const m of matched) {
    say("match", `${m.name}: ${m.gpx_wpt ? `"${m.gpx_wpt}"` : "—"} (${m.method ?? "no match"}${m.confidence ? `, ${m.confidence}` : ""})${m.written ? " ← written" : ""}`);
  }
  step("match", "done", { written: matched.filter((m) => m.written).length });

  /* 4. sun — only when nobody has stamped one (a hand-entered value with
        provenance stays; an unstamped one is a transcription to replace) */
  let sunChanged = false;
  if (race.sun == null || !race.provenance?.sun) {
    step("sun", "start", { label: "computing sunrise / sunset" });
    try {
      race.sun = computeRaceSun(race, { lat: gpx.track[0].lat, lon: gpx.track[0].lon });
      race.provenance = race.provenance ?? {};
      race.provenance.sun = { by: "computed", at, source: SUN_SOURCE };
      unresolved.delete("sun");
      sunChanged = true;
      say("sun", `sunrise ${race.sun.sunrise ?? "—"} · sunset ${race.sun.sunset ?? "—"}`);
    } catch (e) {
      // Missing date or timezone: a draft is allowed not to know them yet.
      warnings.push(`sun not computed: ${e.message}`);
      say("sun", `sun not computed: ${e.message}`, { stream: "err" });
    }
    step("sun", "done", { computed: sunChanged });
  }

  // One atomic write, and only when something actually changed — that is what
  // makes a re-run leave race.json byte-identical.
  if (changed || sunChanged) {
    await writeJsonAtomic(path.join(dir, "race.json"), race);
    say("match", `wrote races/${slug}/race.json`);
  }

  /* 5. the course build */
  step("build", "start", { label: "building course.json" });
  const course = await buildCourse(root, slug, {
    dir,
    log: (line) => say("build", line),
    warn: (line) => say("build", line, { stream: "err" }),
  });
  step("build", "done", { aid_stations: course.aid_stations, race_climbs: course.race_climbs });

  return {
    slug, dir, unresolved: [...unresolved].sort(), warnings, matched, course,
    sun: race.sun ?? null,
  };
}

/* -------------------------------- CLI ---------------------------------- */

/** The per-station match table the acceptance criteria ask the CLI to print. */
function printMatches(matched) {
  if (!matched.length) return;
  const pad = Math.max(16, ...matched.map((m) => m.name.length));
  console.log(`  ${"station".padEnd(pad)}  ${"gpx_wpt".padEnd(26)} method    conf  `);
  for (const m of matched) {
    console.log(
      `  ${m.name.padEnd(pad)}  ${(m.gpx_wpt ?? "—").padEnd(26)} ` +
        `${String(m.method ?? "none").padEnd(9)} ${m.confidence.toFixed(2)}${m.written ? "  ← written" : ""}`
    );
  }
}

async function main() {
  const slug = arg("race", null);
  if (typeof slug !== "string") {
    console.error("usage: node scripts/race-build.mjs --race <slug>");
    process.exit(2);
  }
  const result = await buildRace({
    root: ROOT,
    slug,
    onProgress: (e) => {
      // The match table is printed whole below; the course build's own lines
      // are worth streaming as they happen, the way the CLI always showed them.
      if (e.status === "start") console.log(`• ${e.label}`);
      else if (e.status === "log" && e.step === "build") console.log(e.message);
    },
  });
  console.log("");
  printMatches(result.matched);
  console.log("");
  if (result.unresolved.length) {
    console.log(`unresolved (${result.unresolved.length}):`);
    for (const u of result.unresolved) console.log(`  · ${u}`);
  } else {
    console.log("unresolved: none");
  }
  for (const w of result.warnings) console.log(`  ⚠ ${w}`);
}

// Only the CLI path runs on import — buildRace above is what the API calls.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  });
}
