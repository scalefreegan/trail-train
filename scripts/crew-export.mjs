#!/usr/bin/env node
// Static crew export (PRD v2 §5, bead tt-cv1b0.7).
//
// Writes races/<slug>/build/crew-<date>.html: ONE self-contained file the crew
// opens from a phone in a canyon with no signal. No network, no fonts, no
// sibling assets — web/vite.crew.config.ts builds web/crew.html into a single
// inlined shell (see inlineSingleFile in web/vite.config.ts) and this script
// injects the race's data into the <script id="crew-data"> block in it.
//
// The numbers are computed HERE, in Node, by importing the very .ts modules
// the client bundles — projectRace/fitPacing from web/src/race/pacing.ts and
// planFuel from nutrition.ts, type-stripped by Node (>= 22.18), the same trick
// scripts/features.test.mjs uses. There is deliberately no server-side copy of
// the pacing model to drift from the planner's.
//
// Type stripping does NOT resolve extensionless relative imports, and the
// client sources are written for a bundler ("./clock", not "./clock.ts"), so a
// small in-process resolve hook (registerHooks, no CLI flag needed) supplies
// the extension for specifiers under web/src. Nothing outside web/src is
// touched by it.
//
// Usage:
//   node scripts/crew-export.mjs --race <slug> [--knobs knobs.json] [--out path]
//
//   --knobs  a JSON file of planner knobs (the shape POST /api/races/:slug/
//            crew-export takes in its body). Anything absent falls back to the
//            planner's own defaults — see DEFAULT_CREW_KNOBS.
//   --out    write somewhere other than the race folder's build/.
//
// The dev server's POST /api/races/:slug/crew-export calls crewExport() below
// with the planner's live knobs and streams the same bytes back as a download.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import { arg } from "./lib.mjs";
import { loadRaceFolder } from "./race-config.mjs";
import { raceLocalParts, raceStart } from "./clock.mjs";
import { DEFAULT_LONG_RUN_REF_MI, loadProfile } from "./profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Strava's snapshot is metric; the pacing fit is imperial. Same constants as
    web/src/providers.tsx and scripts/facts.mjs — the fit must be given exactly
    the rows the browser would have given it. */
const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;

/** A crew sheet is text, a course profile and a track — anything this size is
    a bug, not a handout. The acceptance bound for the bead is 2 MB. */
export const MAX_EXPORT_BYTES = 2 * 1024 * 1024;

/* ---------------- type-stripped client imports ---------------- */

let hooksRegistered = false;
/**
 * Teach Node's resolver the bundler's extensionless relative imports, but
 * ONLY for files under web/src. A process-wide hook that guessed extensions
 * everywhere would quietly change how unrelated modules resolve; this one
 * cannot fire outside the client source tree, and falls straight through
 * when no .ts/.tsx sits at the guessed path.
 */
function registerClientResolver() {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const clientSrc = path.join(ROOT, "web", "src") + path.sep;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (
        parent?.startsWith("file:") &&
        specifier.startsWith(".") &&
        !/\.[cm]?[jt]sx?$/i.test(specifier) &&
        fileURLToPath(parent).startsWith(clientSrc)
      ) {
        for (const ext of [".ts", ".tsx"]) {
          const candidate = new URL(specifier + ext, parent);
          if (existsSync(fileURLToPath(candidate))) return nextResolve(specifier + ext, context);
        }
      }
      return nextResolve(specifier, context);
    },
  });
}

/** The client modules the export computes with, imported once per process. */
let clientModules = null;
async function client() {
  if (clientModules) return clientModules;
  registerClientResolver();
  const src = path.join(ROOT, "web", "src");
  const [pacing, nutrition, nutritionConfig, features, crewData] = await Promise.all([
    import(path.join(src, "race", "pacing.ts")),
    import(path.join(src, "race", "nutrition.ts")),
    import(path.join(src, "race", "nutrition-config.ts")),
    import(path.join(src, "race", "features.ts")),
    import(path.join(src, "crew", "crewData.ts")),
  ]);
  clientModules = { pacing, nutrition, nutritionConfig, features, crewData };
  return clientModules;
}

/* ---------------- the shell ---------------- */

export const SHELL_DIR = "dist-crew";
export const SHELL_FILE = "crew.html";

/** Newest mtime under a directory tree, ms. Missing tree → 0. */
async function newestMtime(dir, exts) {
  let newest = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, await newestMtime(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) {
      const st = await fs.stat(p).catch(() => null);
      if (st) newest = Math.max(newest, st.mtimeMs);
    }
  }
  return newest;
}

/**
 * Path of the built single-file shell, building it first when it is missing or
 * older than any source it is built from.
 *
 * The staleness check is what keeps an export honest without paying for a Vite
 * build every time: edit pacing.ts and the next export rebuilds; export twice
 * in a row and the second one is a file read. `TRAIL_CREW_SHELL` short-circuits
 * the whole thing with a prebuilt shell (the dev server can be pointed at one,
 * and it keeps a test from shelling out).
 */
export async function ensureShell(root = ROOT, { rebuild = false } = {}) {
  if (process.env.TRAIL_CREW_SHELL) return process.env.TRAIL_CREW_SHELL;
  const web = path.join(root, "web");
  const shell = path.join(web, SHELL_DIR, SHELL_FILE);
  const built = await fs.stat(shell).catch(() => null);
  if (built && !rebuild) {
    const newest = Math.max(
      await newestMtime(path.join(web, "src"), [".ts", ".tsx", ".css"]),
      ...(await Promise.all(
        [path.join(web, "crew.html"), path.join(web, "vite.crew.config.ts"), path.join(web, "vite.config.ts")]
          .map((p) => fs.stat(p).then((s) => s.mtimeMs, () => 0)),
      )),
    );
    if (built.mtimeMs >= newest) return shell;
  }
  await buildShell(web);
  return shell;
}

/** `vite build` for the crew entry only, into web/dist-crew/. */
function buildShell(webDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(webDir, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "vite.crew.config.ts"],
      { cwd: webDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    child.stdout.on("data", () => {});
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(fail("shell_build", `crew shell build failed (exit ${code})\n${err.trim()}`));
    });
  });
}

/* ---------------- data assembly ---------------- */

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function readJsonIfPresent(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw fail("bad_json", `${p}: ${e.message}`);
  }
}

/**
 * The rows fitPacing wants, out of web/public/strava.json. Identical to what
 * providers.tsx hands the browser's fit: the same filter happens inside
 * fitPacing, so only the unit conversion belongs here.
 */
function fitRows(strava) {
  return (strava?.activities ?? [])
    .filter((a) => a.sport === "Run" || a.sport == null)
    .map((a) => ({
      distance_mi: (a.distance_m ?? 0) / M_PER_MI,
      elevation_ft: (a.elevation_m ?? 0) / M_PER_FT,
      moving_s: a.moving_s ?? 0,
      date: a.date,
      avg_hr: a.avg_hr ?? null,
    }));
}

/** race.json's crew-facing subset — see CrewRace in web/src/crew/crewData.ts. */
function crewRace(race) {
  return {
    slug: race.slug,
    name: race.name,
    short: race.short,
    date: race.date,
    start_time: race.start_time,
    timezone: race.timezone,
    location: race.location,
    distance_mi: race.distance_mi,
    gain_ft: race.gain_ft,
    cutoff_h: race.cutoff_h ?? null,
    sun: race.sun ?? null,
    links: race.links ?? {},
    crew_info: race.crew_info ?? null,
    features: race.features ?? null,
    sources: race.sources ?? [],
  };
}

/**
 * Build the CrewData payload for one race folder: everything the exported page
 * renders, plus the inputs it needs to re-project locally.
 *
 * @param {string} root     project root
 * @param {string} slug     race folder
 * @param {object} [opts]
 * @param {object} [opts.knobs] planner knobs (partial; defaults fill the rest)
 * @param {Date}   [opts.now]   export instant — injected so tests are stable
 */
export async function buildCrewData(root, slug, { knobs = {}, now = new Date() } = {}) {
  const { pacing, nutrition, nutritionConfig, features, crewData } = await client();
  const folder = await loadRaceFolder(root, slug).catch(() => {
    throw fail("not_found", `races/${slug}/race.json not found`);
  });
  const race = folder.race;

  const buildDir = path.join(folder.dir, "build");
  const course = await readJsonIfPresent(path.join(buildDir, "course.json"));
  if (!course) {
    throw fail("no_course", `races/${slug}/build/course.json not found — run the course build first`);
  }
  const crewBase = await readJsonIfPresent(path.join(buildDir, "crew-base.json"));

  const [strava, paceGrade, profile] = await Promise.all([
    readJsonIfPresent(path.join(root, "web", "public", "strava.json")),
    readJsonIfPresent(path.join(root, "web", "public", "pace-grade.json")),
    loadProfile(root).catch(() => null),
  ]);

  const dRefMi = profile?.physiology?.long_run_ref_mi ?? DEFAULT_LONG_RUN_REF_MI;
  const fit = pacing.fitPacing(fitRows(strava), now.getTime(), dRefMi);
  if (!fit) {
    throw fail(
      "no_fit",
      "no pacing fit — web/public/strava.json has fewer than 8 usable runs. Run `npm run sync:strava` first.",
    );
  }
  // The fitted curve is optional: projectRace falls back to the kVert anchor,
  // and it must be the SAME object the client would have passed (the whole
  // payload, not just the points) so the basis string matches the planner's.
  const gradeCurve = Array.isArray(paceGrade?.curve) && paceGrade.curve.length > 0 ? paceGrade : null;

  // The altitude term (PRD v2 §2) is resolved the way useRacePlan resolves it:
  // the per-slug knob, the athlete's acclimated elevation, and the feature
  // gate — a race that declares `features.altitude: false` gets no term at
  // all rather than a hidden penalty. A caller that already resolved it (the
  // planner's button) wins, so the sheet matches the table on screen.
  const altitudeDefault = features.resolveFeatures(race).altitude
    ? {
        pct: crewData.DEFAULT_ALTITUDE_PCT,
        homeElevationFt: profile?.physiology?.home_elevation_ft ?? null,
        acclimationDays: 0,
      }
    : null;
  const resolved = {
    ...crewData.DEFAULT_CREW_KNOBS,
    goalH: crewData.defaultGoalH(race.cutoff_h),
    altitude: altitudeDefault,
    ...sanitizeKnobs(knobs),
  };
  const proj = pacing.projectRace(course, fit, {
    fatiguePctPer10mi: resolved.fatiguePctPer10mi,
    calibrationPct: resolved.calibrationPct,
    restraintPct: resolved.restraintPct,
    gradeCurve,
    goalH: resolved.goalH != null && resolved.goalH > 0 ? resolved.goalH : null,
    aidStopMin: resolved.aidStopMin,
    crewStopMin: resolved.crewStopMin,
    stopOverridesMin: resolved.stopOverridesMin,
    altitude: resolved.altitude,
  });

  // The start INSTANT comes from scripts/clock.mjs, the Node twin of the
  // client's clock.ts (same API, shared test) — and every wall clock printed
  // into the payload comes from the client's own fmtRaceClock, so the crew
  // sheet reads the race's zone exactly as the planner does.
  const startInstant = raceStart(race.date, race.start_time, race.timezone);
  const clock = (h) => pacing.fmtRaceClock(startInstant, h, race.timezone);

  const stations = proj.stations.map((s) => ({
    name: s.station.name,
    total_mi: s.station.total_mi,
    gpx_mi: s.station.gpx_mi,
    crew: !!s.station.crew,
    crew_only: !!s.station.crew_only,
    drop_bag: !!s.station.drop_bag,
    pacers: !!s.station.pacers,
    water_only: !!s.station.water_only,
    notes: s.station.notes ?? "",
    cutoff_h: s.station.cutoff_h ?? null,
    cutoff_clock: s.station.cutoff_h == null ? null : clock(s.station.cutoff_h),
    seg_mi: s.seg_mi,
    seg_gain_ft: s.seg_gain_ft,
    stop_min: s.stop_min,
    eta_h: s.eta_h,
    clock: { best: clock(s.eta_h.best), avg: clock(s.eta_h.avg), worst: clock(s.eta_h.worst) },
    goal_eta_h: s.goal_eta_h,
    goal_clock: s.goal_eta_h == null ? null : clock(s.goal_eta_h),
    cutoff_margin_h: s.cutoff_margin_h,
    cutoff_margin_worst_h: s.cutoff_margin_worst_h,
  }));

  // Fuel: the same planFuel the fuel page runs, over the same projection.
  // A folder with no nutrition.json is not an error — the impersonal defaults
  // are what the app itself falls back to, and a crew sheet without a fuel
  // plan is still a crew sheet.
  const cfg =
    nutritionConfig.normalizeNutrition(folder.nutrition) ?? nutritionConfig.DEFAULT_NUTRITION;
  const sun = course.sun ?? race.sun ?? null;
  let fuel = null;
  try {
    fuel = nutrition.planFuel(proj, sun, startInstant, cfg, race.timezone);
  } catch (e) {
    // Never let the fueling model take the ETAs down with it: the crew's
    // first job is knowing when she arrives.
    fuel = null;
    process.emitWarning(`fuel plan skipped: ${e.message}`);
  }

  return {
    schema_version: crewData.CREW_DATA_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    slug,
    race: crewRace(race),
    course,
    crew_base: crewBase,
    knobs: resolved,
    fit,
    grade_curve: gradeCurve,
    projection: {
      finish_h: proj.finish_h,
      finish_clock: {
        best: clock(proj.finish_h.best),
        avg: clock(proj.finish_h.avg),
        worst: clock(proj.finish_h.worst),
      },
      stopped_h: proj.stopped_h,
      goal_h: proj.goal_h,
      grade_basis: proj.grade_basis,
      stations,
    },
    fuel,
    crew_pickups: crewPickups(stations, fuel),
    nutrition: cfg,
  };
}

/**
 * The fuel plan sliced by CREW-access station: what the crew should be holding
 * when she runs in. One entry per station the crew can reach, carrying the leg
 * she leaves on (the fuel segment departing there) and the drop bag waiting.
 */
export function crewPickups(stations, fuel) {
  const byFrom = new Map();
  for (const seg of fuel?.segments ?? []) byFrom.set(seg.from, seg);
  const bags = new Map((fuel?.drop_bags ?? []).map((b) => [b.station, b]));
  return stations
    .filter((s) => s.crew || s.crew_only)
    .map((s) => ({
      station: s.name,
      total_mi: s.total_mi,
      eta_h: s.eta_h.avg,
      clock: s.clock.avg,
      segment: byFrom.get(s.name) ?? null,
      drop_bag: bags.get(s.name) ?? null,
    }));
}

/** Keep only knobs we recognise, and only as finite numbers — the body of a
    POST is caller input, and a NaN knob silently collapses every ETA. */
export function sanitizeKnobs(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const k of ["fatiguePctPer10mi", "calibrationPct", "restraintPct", "aidStopMin", "crewStopMin"]) {
    if (Number.isFinite(raw[k])) out[k] = raw[k];
  }
  if (raw.goalH === null || Number.isFinite(raw.goalH)) out.goalH = raw.goalH;
  if (raw.altitude === null) out.altitude = null;
  else if (raw.altitude && typeof raw.altitude === "object" && Number.isFinite(raw.altitude.pct)) {
    const home = raw.altitude.homeElevationFt;
    out.altitude = {
      pct: raw.altitude.pct,
      homeElevationFt: Number.isFinite(home) ? home : null,
      acclimationDays: Number.isFinite(raw.altitude.acclimationDays)
        ? Math.max(0, raw.altitude.acclimationDays)
        : 0,
    };
  }
  if (raw.stopOverridesMin && typeof raw.stopOverridesMin === "object") {
    const stops = {};
    for (const [name, min] of Object.entries(raw.stopOverridesMin)) {
      if (typeof name === "string" && Number.isFinite(min) && min >= 0) stops[name] = min;
    }
    out.stopOverridesMin = stops;
  }
  return out;
}

/* ---------------- rendering ---------------- */

/**
 * Put `data` into the shell's <script id="crew-data"> block.
 *
 * `<` is escaped to < throughout — valid JSON, and it makes a "</script>"
 * inside any embedded prose (a crew rule quoting HTML, a race URL) incapable
 * of closing the block early. That is the one injection this file can suffer:
 * the data is the athlete's own, but it comes from race.json and a fetched
 * crew manual, and neither is under this script's control.
 */
export function renderCrewHtml(shellHtml, data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const block = /(<script\b[^>]*\bid=["']crew-data["'][^>]*>)([\s\S]*?)(<\/script>)/i;
  if (!block.test(shellHtml)) {
    throw fail("bad_shell", "crew shell has no <script id=\"crew-data\"> block — rebuild web/dist-crew");
  }
  return shellHtml.replace(block, (_m, open, _body, close) => `${open}${json}${close}`);
}

/* ---------------- the export ---------------- */

/**
 * Render one race folder's crew page and write it into the folder's build/.
 *
 * @returns {{html: string, outPath: string, bytes: number, filename: string, data: object}}
 */
export async function crewExport(root, slug, { knobs = {}, now = new Date(), out = null, write = true } = {}) {
  const data = await buildCrewData(root, slug, { knobs, now });
  const shellPath = await ensureShell(root);
  const shell = await fs.readFile(shellPath, "utf8");
  const html = renderCrewHtml(shell, data);

  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_EXPORT_BYTES) {
    throw fail(
      "too_big",
      `crew export is ${(bytes / 1024 / 1024).toFixed(2)} MB, over the ${MAX_EXPORT_BYTES / 1024 / 1024} MB budget`,
    );
  }

  // Dated on the RACE's calendar, not the exporter's: "crew-2026-09-12.html"
  // should mean the sheet as it stood on that race-local day, whichever time
  // zone the laptop that made it was sitting in.
  const { iso: date } = raceLocalParts(now, data.race.timezone);
  const filename = `crew-${date}.html`;
  const outPath = out ?? path.join(root, "races", slug, "build", filename);
  if (write) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, html, "utf8");
  }
  return { html, outPath, bytes, filename, data };
}

/* ---------------- CLI ---------------- */

async function main() {
  const slug = arg("race");
  if (!slug) {
    console.error("usage: node scripts/crew-export.mjs --race <slug> [--knobs knobs.json] [--out path]");
    process.exit(2);
  }
  const knobsPath = arg("knobs");
  const knobs = knobsPath ? JSON.parse(await fs.readFile(knobsPath, "utf8")) : {};
  const { outPath, bytes, data } = await crewExport(ROOT, slug, { knobs, out: arg("out") ?? null });
  console.log(
    `✓ wrote ${path.relative(ROOT, outPath)} (${(bytes / 1024).toFixed(0)} KB, ` +
      `${data.projection.stations.length} stations, ${data.crew_pickups.length} crew stops)`,
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
