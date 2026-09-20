#!/usr/bin/env node
// The exit test for the race pipeline — the modular-races epic (tt-yib.19;
// PRD §12, §13) and everything v2 added on top of it (PRD-v2 §2-§7).
//
// Ten sections, each PASS / FAIL / SKIP with a reason. Any FAIL exits 1.
//
//   1. literals  no race name, short code, trailhead town or aid-station name
//                survives in CODE. Comment mentions are history, not coupling,
//                so they are reported as INFO; a short, explicit exception list
//                carries the two deliberate slug constants.
//   2. folders   every folder listRaces() returns validates (draft semantics
//                for drafts), at most one is active, and the block.json /
//                nutrition.json beside each race.json pass their validators.
//   3. altitude  the pacing penalty curve (PRD-v2 §2): monotone in all three
//                inputs, still on its published pinned points, and identical
//                in the .mjs and .ts twins the scripts and the bundle use.
//   4. tuneups   PRD-v2 §3's B-race rules, exercised over races/_fixtures:
//                a tune-up validates with no block or nutrition, is never
//                "active", needs a real A-race parent, cannot chain, and
//                lands under that parent with the right weeks_out.
//   5. trackers  every committed page under scripts/fixtures/trackers/ still
//                parses through the registry, with an INJECTED fetch, to the
//                checkpoint it is saved for. A documented stub (MAProgress)
//                has to say so; an adapter with neither fails the section.
//   6. reference determinism: the archived reference folder, copied to a temp
//                dir with every gpx_wpt and its sun stripped, rebuilds to the
//                same waypoints, the same sunrise/sunset and a monotone course,
//                without touching a single user- or agent-owned field.
//   7. draft     PRD §12's assertions against the San Juan Softie 2027 DRAFT,
//                when that (uncommitted) folder is present. --live additionally
//                re-fetches the sources it cites and reports what has changed.
//   8. crew      the static crew handout (PRD-v2 §5), rendered from a fixture
//                race: zero asset references, every http(s) string inside the
//                embedded data, and under the 2 MB budget.
//   9. harness   `npm run build` and `npm test` in web/.
//  10. ui        `npm run test:ui` — the Playwright flows (web/tests/). The one
//                section that drives a browser, so it is also the one that can
//                be turned off: `--no-ui` or TRAIL_CHECK_NO_UI=1 skips it with
//                that as its stated reason rather than silently. Its wall time
//                is reported either way, as is the whole run's.
//
// Usage:  cd web && npm run check:races
//         cd web && npm run check:races -- --live    (network; see README)
//         cd web && npm run check:races -- --no-ui   (skip the browser flows)
//         TRAIL_CHECK_QUIET=1 npm run check:races    (results and summary only)
//         TRAIL_CHECK_NO_UI=1 npm run check:races    (same as --no-ui)

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as altitudeMjs from "./altitude.mjs";
import * as altitudeTs from "../web/src/race/altitude.ts";
import * as trackers from "./trackers/index.mjs";
import {
  bRacesFor, listRaces, loadRaceFolder, raceKind,
  validateRaceJson, validateSingleActive,
} from "./race-config.mjs";
import { draftValidationErrors } from "./race-intake.mjs";
import { validateBlockTargets, validateNutrition } from "./race-plan.mjs";
import { isBlockStale } from "./race-edit.mjs";
import { normalizeNutrition } from "../web/src/race/nutrition-config.ts";
import { MAX_EXPORT_BYTES, assetRefs, crewExport } from "./crew-export.mjs";
import { buildRace } from "./race-build.mjs";
import { projectRoot } from "./lib.mjs";
import { buildCrewShell, makeProjectRoot } from "../web/tests/launch.mjs";

const ROOT = projectRoot();

/** The reference folder every determinism assertion is made against. */
export const REFERENCE_SLUG = "mogollon-monster-100-2026";

/** The validation case from PRD §12. Uncommitted: the check skips without it. */
export const DRAFT_SLUG = "san-juan-softie-100-2027";

/* ===================== 1. the race-literal grep gate ===================== */

/**
 * The retired race's name, short code, its trailhead towns and the aid-station
 * names that were once spelled out in pacing, nutrition and prompt code. None
 * of them may appear in code again: a race is a folder, and anything that has
 * to name one names it through `races/<slug>/`.
 *
 * Case-insensitive, and deliberately not anchored — `MM100Projection` and
 * "Pine, AZ" both have to be caught.
 */
export const RACE_LITERAL_RE =
  /mogollon|MM100|pine, az|rim 6|horton|buck springs|fish hatchery|two-sixty|old pine/i;

/** Where the gate looks. Everything else is data (`races/`) or docs. */
export const SCAN_TARGETS = [
  "scripts",
  "web/src",
  "web/vite.config.ts",
  "macos",
  "README.md",
  "web/index.html",
];

/** Never walked into, whatever the target list says. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage"]);

/** Nothing text-scannable lives in these. */
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".pdf", ".gpx", ".icns"]);

/**
 * Files the gate does not read: the tests (which name the reference race on
 * purpose — it is their fixture) and this checker plus its own test, which
 * carry the pattern itself.
 */
export function isExcludedFromScan(rel) {
  const base = path.basename(rel);
  return base.endsWith(".test.mjs") || base === "check-races.mjs";
}

/**
 * The two race literals that stay in code, each because it names a MIGRATION
 * TARGET rather than a coupling — code that would have to name this exact
 * folder however the epic had gone. Anything not on this list fails the gate.
 */
export const ALLOWED_EXCEPTIONS = [
  {
    file: "web/src/race/useRacePlan.ts",
    match: /LEGACY_KNOB_SLUG/,
    why: "one-time localStorage migration: pacing knobs saved before knobs were per-race can only have belonged to this race (tt-yib.6)",
  },
  {
    file: "scripts/race-plan.mjs",
    match: /STYLE_REFERENCE_SLUG/,
    why: "the one hand-authored block + nutrition pair the stage-3 planner shows its agent as a style reference (tt-yib.13)",
  },
];

/** Which comment syntax a file is read with. Markdown and JSON have none. */
export function commentStyle(rel) {
  const ext = path.extname(rel).toLowerCase();
  if ([".mjs", ".js", ".cjs", ".ts", ".tsx", ".jsx", ".c", ".h", ".css"].includes(ext)) return "c";
  if ([".html", ".svg", ".xml"].includes(ext)) return "html";
  if ([".sh", ".bash", ".zsh"].includes(ext)) return "hash";
  if (ext === ".applescript") return "applescript";
  return "none";
}

/**
 * Split a file into lines, marking each as comment or code.
 *
 * A comment is a line whose first non-space characters open or continue a
 * comment (`//`, `/*`, `*`, `<!--`, `#`, `--`), or a line inside an open block.
 * A line that closes a block and then carries code is code again. Everything
 * else — including a literal hiding in a string on a line that merely ends in
 * a comment — is code, which is the conservative direction for a gate.
 *
 * @param {string} text
 * @param {"c"|"html"|"hash"|"applescript"|"none"} style
 * @returns {{line: number, text: string, comment: boolean}[]}
 */
export function classifyLines(text, style = "none") {
  let inBlock = false;
  return text.split("\n").map((raw, i) => {
    const t = raw.trim();
    let comment = false;
    if (style === "c") {
      if (inBlock) {
        comment = true;
        const close = t.lastIndexOf("*/");
        if (close >= 0) {
          inBlock = false;
          if (t.slice(close + 2).trim()) comment = false;
        }
      } else if (t.startsWith("//") || t.startsWith("*")) {
        comment = true;
      } else if (t.startsWith("/*")) {
        comment = true;
        const close = t.lastIndexOf("*/");
        if (close < 0) inBlock = true;
        else if (t.slice(close + 2).trim()) comment = false;
      }
    } else if (style === "html") {
      if (inBlock) {
        comment = true;
        const close = t.lastIndexOf("-->");
        if (close >= 0) {
          inBlock = false;
          if (t.slice(close + 3).trim()) comment = false;
        }
      } else if (t.startsWith("<!--")) {
        comment = true;
        const close = t.lastIndexOf("-->");
        if (close < 0) inBlock = true;
        else if (t.slice(close + 3).trim()) comment = false;
      }
    } else if (style === "hash") {
      comment = t.startsWith("#");
    } else if (style === "applescript") {
      comment = t.startsWith("--") || t.startsWith("#");
    }
    return { line: i + 1, text: raw, comment };
  });
}

/**
 * Every race-literal hit in one file, classified.
 * @returns {{file: string, line: number, text: string, kind: "code"|"comment"|"allowed", why: string|null}[]}
 */
export function scanText(rel, text) {
  const hits = [];
  for (const { line, text: raw, comment } of classifyLines(text, commentStyle(rel))) {
    if (!RACE_LITERAL_RE.test(raw)) continue;
    const allowed = comment
      ? null
      : ALLOWED_EXCEPTIONS.find((e) => e.file === rel && e.match.test(raw));
    hits.push({
      file: rel,
      line,
      text: raw.trim(),
      kind: comment ? "comment" : allowed ? "allowed" : "code",
      why: allowed?.why ?? null,
    });
  }
  return hits;
}

/** Every scannable file under one target, repo-relative. */
async function filesUnder(root, target) {
  const abs = path.join(root, target);
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return [target];
  const out = [];
  const walk = async (dirRel) => {
    const entries = await fs.readdir(path.join(root, dirRel), { withFileTypes: true });
    for (const ent of entries) {
      const rel = path.posix.join(dirRel, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        await walk(rel);
      } else if (ent.isFile() && !BINARY_EXT.has(path.extname(ent.name).toLowerCase())) {
        out.push(rel);
      }
    }
  };
  await walk(target);
  return out.sort();
}

async function checkLiterals(root) {
  const hits = [];
  let scanned = 0;
  for (const target of SCAN_TARGETS) {
    for (const rel of await filesUnder(root, target)) {
      if (isExcludedFromScan(rel)) continue;
      scanned += 1;
      hits.push(...scanText(rel, await fs.readFile(path.join(root, rel), "utf8")));
    }
  }
  const code = hits.filter((h) => h.kind === "code");
  const allowed = hits.filter((h) => h.kind === "allowed");
  const comments = hits.filter((h) => h.kind === "comment");
  return {
    status: code.length ? "FAIL" : "PASS",
    reason: code.length
      ? `${code.length} race literal${code.length === 1 ? "" : "s"} in code across ${scanned} files`
      : `no race literals in code across ${scanned} files ` +
        `(${allowed.length} listed exception${allowed.length === 1 ? "" : "s"}, ${comments.length} comment mentions)`,
    detail: code.map((h) => `${h.file}:${h.line}  ${h.text.slice(0, 110)}`),
    info: [
      ...allowed.map((h) => `allowed  ${h.file}:${h.line} — ${h.why}`),
      ...comments.map((h) => `comment  ${h.file}:${h.line}  ${h.text.slice(0, 90)}`),
    ],
  };
}

/* ======================= 2. every folder validates ======================= */

export async function checkFolders(root) {
  const races = await listRaces(root);
  const errors = [];
  const info = [];
  const warnings = [];
  if (!races.length) {
    return { status: "SKIP", reason: "no race folders under races/", detail: [], info: [], warnings: [] };
  }

  for (const r of races) {
    if (r.error) {
      errors.push(`${r.slug}: ${r.error}`);
      continue;
    }
    // A draft may carry the holes it declared in unresolved[]; an active or
    // archived folder must validate outright.
    // `races` in both branches: a B folder's parent_slug is checked against
    // the folders actually on disk here — this gate is the one caller that
    // has read all of them (PRD-v2 §3).
    const { errors: schema } = r.race.status === "draft"
      ? draftValidationErrors(r.race, r.race.unresolved ?? [], { races })
      : validateRaceJson(r.race, { races });
    for (const e of schema) errors.push(`${r.slug}/race.json: ${e}`);

    const folder = await loadRaceFolder(root, r.slug);
    if (folder.block) {
      const { errors: be } = validateBlockTargets(folder.block.targets, {
        total_weeks: folder.block.total_weeks,
        race: r.race,
      });
      for (const e of be) errors.push(`${r.slug}/block.json: ${e}`);

      // The block's calendar was counted back from a race date this folder
      // no longer has (race-edit.mjs's isBlockStale — the same check
      // loadReview surfaces to the review dialog as block_stale). A draft's
      // block is worked on right alongside a date that may still move, so
      // this warns rather than failing the gate for one; an ACTIVE race
      // training the athlete against a stale calendar is a real defect and
      // fails it outright.
      if (isBlockStale(folder.block, r.race)) {
        const msg = `${r.slug}/block.json: block counted back from a race date this folder no longer has ` +
          `(block.start_date ${folder.block.start_date}, ${folder.block.total_weeks} weeks vs race.json's date ${JSON.stringify(r.race.date)})`;
        if (r.race.status === "draft") warnings.push(msg);
        else errors.push(msg);
      }
    }
    if (folder.nutrition) {
      const { errors: ne } = validateNutrition(folder.nutrition, r.race);
      for (const e of ne) errors.push(`${r.slug}/nutrition.json: ${e}`);
      if (!normalizeNutrition(folder.nutrition)) {
        errors.push(`${r.slug}/nutrition.json: the client loader refuses it`);
      }
    }
    // A B folder carries none of the planning files by design (PRD-v2 §3:
    // race.json and optionally a course), so its "—"s are the expected shape
    // rather than something missing — say which kind it is on the line.
    const kind = raceKind(r.race);
    info.push(
      `${r.slug}  ${kind === "b" ? `tune-up of ${r.race.parent_slug}` : "A race"} · status ${r.race.status} · ` +
        `${r.race.aid_stations?.length ?? 0} stations · ` +
        `block ${folder.block ? `${folder.block.total_weeks} wk` : "—"} · nutrition ${folder.nutrition ? "ok" : "—"}`
    );
  }

  const single = validateSingleActive(races);
  errors.push(...single.errors);

  return {
    status: errors.length ? "FAIL" : "PASS",
    reason: errors.length
      ? `${errors.length} validation error${errors.length === 1 ? "" : "s"} across ${races.length} folders`
      : `${races.length === 1 ? "1 folder validates" : `${races.length} folders validate`} · active: ${single.active[0] ?? "none"}`,
    detail: errors,
    info,
    warnings,
  };
}

/* ================== 3. the altitude curve holds its shape ================ */

/**
 * The altitude model's pinned points, as a list so the report can name the
 * one that moved rather than just failing.
 *
 * These are the same assertions scripts/altitude.test.mjs makes, and that is
 * deliberate: the unit test is what a developer runs, and THIS is what the
 * exit gate runs against whatever is on disk at release time. The numbers
 * reach the athlete as minutes on a race plan (PRD-v2 §2), so a re-tuning
 * should have to walk past a failing line in both places.
 *
 * Pure, and parameterised over the module, so both twins go through it.
 *
 * @param {typeof import("./altitude.mjs")} A either twin
 * @returns {{name: string, ok: boolean, detail: string}[]}
 */
export function altitudeChecks(A) {
  const out = [];
  const check = (name, ok, detail) => out.push({ name, ok: Boolean(ok), detail });
  const near = (x, y, eps = 1e-12) => Math.abs(x - y) <= eps;
  const at = (elevationFt, acclimationDays = 0, homeElevationFt = null) =>
    A.altitudeSlowdown({ elevationFt, homeElevationFt, acclimationDays });
  const pct = (v) => `${(v * 100).toFixed(2)} %`;

  /* --- the threshold, and what an unusable input does at it --- */
  const charged = [-300, 0, 1000, 4000, 4999, A.ALTITUDE_THRESHOLD_FT].filter((e) => at(e) !== 0);
  const freeloaders = [A.altitudeSlowdown(), A.altitudeSlowdown({}), at(NaN)].filter((v) => v !== 0);
  check(
    `nothing is charged at or below ${A.ALTITUDE_THRESHOLD_FT.toLocaleString("en-US")} ft`,
    charged.length === 0 && freeloaders.length === 0,
    charged.length
      ? `charged at ${charged.join(", ")} ft`
      : freeloaders.length
        ? "a missing or NaN elevation is not free"
        : "0 up to the threshold, and for a missing elevation"
  );

  /* --- the per-1,000 ft cost --- */
  check("8,000 ft unacclimated costs 5.4 %", near(at(8000), 0.054), pct(at(8000)));
  check("12,000 ft unacclimated costs 12.6 %", near(at(12000), 0.126), pct(at(12000)));
  check(
    "linear in the excess above the threshold",
    near(at(12000) - at(11000), A.PACE_PENALTY_PER_1000FT),
    `${pct(at(12000) - at(11000))} per 1,000 ft`
  );

  /* --- the two published acclimatization anchors --- */
  const half = A.acclimationFraction(A.ACCLIMATION_HALF_DAYS);
  const nearDay = A.acclimationFraction(A.ACCLIMATION_NEAR_DAYS);
  check(`half the available benefit by day ${A.ACCLIMATION_HALF_DAYS}`, near(half, 0.5, 1e-9), half.toFixed(4));
  check(
    `${(A.ACCLIMATION_NEAR_FRACTION * 100).toFixed(0)} % of it by day ${A.ACCLIMATION_NEAR_DAYS}`,
    near(nearDay, A.ACCLIMATION_NEAR_FRACTION, 1e-9),
    nearDay.toFixed(4)
  );
  check(
    "arrival day and a negative stay both buy nothing",
    A.acclimationFraction(0) === 0 && A.acclimationFraction(-5) === 0,
    `day 0 → ${A.acclimationFraction(0)} · day −5 → ${A.acclimationFraction(-5)}`
  );
  check("12,000 ft after 3 days costs 9.45 %", near(at(12000, 3), 0.0945), pct(at(12000, 3)));
  check("12,000 ft after 14 days costs 6.93 %", near(at(12000, 14), 0.0693), pct(at(12000, 14)));

  /* --- acclimation is partial, however long the stay --- */
  const raw = at(12000);
  const floor = raw * (1 - A.ACCLIMATION_MAX_RELIEF);
  const belowFloor = [30, 365, 10000].filter((d) => at(12000, d) < floor - 1e-12 || at(12000, d) >= raw);
  check(
    `acclimation never gives back more than ${(A.ACCLIMATION_MAX_RELIEF * 100).toFixed(0)} %`,
    belowFloor.length === 0 && near(at(12000, 1e9), floor, 1e-9),
    `12,000 ft floors at ${pct(floor)} (raw ${pct(raw)})`
  );

  /* --- the athlete's own elevation raises the threshold, never lowers it --- */
  check(
    "a home elevation raises the threshold and never lowers it",
    near(at(10000, 0, 7000), 3 * A.PACE_PENALTY_PER_1000FT) &&
      at(5000, 0, 3000) === 0 &&
      at(8000, 0, 3000) === at(8000) &&
      at(6000, 0, 9000) === 0,
    `10,000 ft from 7,000 ft → ${pct(at(10000, 0, 7000))}; living higher than the race is no bonus`
  );

  /* --- monotone in all three inputs, and in the curve itself --- */
  const notMonotone = [];
  let prev = -1;
  for (let ele = 0; ele <= 15000; ele += 250) {
    const v = at(ele, 2, 5280);
    if (v < prev || v < 0) notMonotone.push(`penalty fell or went negative at ${ele} ft`);
    prev = v;
  }
  prev = Infinity;
  for (let d = 0; d <= 60; d += 0.5) {
    const v = at(11000, d);
    if (v > prev) notMonotone.push(`another day at altitude cost MORE (day ${d})`);
    prev = v;
  }
  prev = Infinity;
  for (let home = 0; home <= 11000; home += 250) {
    const v = at(11000, 0, home);
    if (v > prev) notMonotone.push(`a higher home elevation cost more (${home} ft)`);
    prev = v;
  }
  prev = -1;
  for (let d = 0; d <= 60; d += 0.25) {
    const v = A.acclimationFraction(d);
    if (v < prev || v > 1) notMonotone.push(`acclimationFraction is not monotone/bounded at day ${d}`);
    prev = v;
  }
  check(
    "monotone in elevation, in days at altitude and in home elevation",
    notMonotone.length === 0,
    notMonotone.length ? notMonotone.slice(0, 3).join(" · ") : "121 elevations, 121 days, 45 home elevations"
  );

  return out;
}

/** The constants the two twins must agree on, name by name. */
export const ALTITUDE_CONSTANTS = [
  "ALTITUDE_THRESHOLD_FT", "PACE_PENALTY_PER_1000FT", "ACCLIMATION_MAX_RELIEF",
  "ACCLIMATION_HALF_DAYS", "ACCLIMATION_NEAR_DAYS", "ACCLIMATION_NEAR_FRACTION",
];

/**
 * Where scripts/altitude.mjs and web/src/race/altitude.ts disagree — empty
 * when they are the same model.
 *
 * The scripts and the Vite bundle share no module graph, so the curve exists
 * twice on purpose (see the header of either file). A change mirrored in only
 * one of them would give the planner and the crew sheet two different races,
 * and nothing else in the app would notice.
 *
 * @returns {string[]}
 */
export function altitudeTwinDiffs(a, b) {
  const diffs = [];
  for (const key of ALTITUDE_CONSTANTS) {
    if (typeof a[key] !== "number") diffs.push(`${key} is missing from scripts/altitude.mjs`);
    else if (b[key] !== a[key]) diffs.push(`${key}: ${a[key]} in the .mjs twin, ${b[key]} in the .ts twin`);
  }
  for (const elevationFt of [-200, 0, 4999, 5000, 6500, 8000, 10300, 12000, 14100]) {
    for (const homeElevationFt of [null, 0, 3000, 5280, 7000]) {
      for (const acclimationDays of [0, 1, 3, 7, 14, 30]) {
        const args = { elevationFt, homeElevationFt, acclimationDays };
        if (Math.abs(a.altitudeSlowdown(args) - b.altitudeSlowdown(args)) > 1e-9) {
          diffs.push(`altitudeSlowdown disagrees at ${JSON.stringify(args)}`);
        }
      }
    }
  }
  for (const d of [0, 0.5, 3, 14, 100]) {
    if (Math.abs(a.acclimationFraction(d) - b.acclimationFraction(d)) > 1e-9) {
      diffs.push(`acclimationFraction disagrees at day ${d}`);
    }
  }
  return diffs.slice(0, 12);
}

/** Both copies of the model, named the way the report should name them. */
const ALTITUDE_TWINS = [
  ["scripts/altitude.mjs", altitudeMjs],
  ["web/src/race/altitude.ts", altitudeTs],
];

async function checkAltitude() {
  const errors = [];
  const info = [];

  // The .mjs twin's results carry the numbers into the report; the .ts twin
  // runs the identical set silently and only speaks up when it fails, so the
  // section stays readable instead of printing everything twice.
  for (const r of altitudeChecks(altitudeMjs)) {
    if (r.ok) info.push(`${r.name} — ${r.detail}`);
    else errors.push(`scripts/altitude.mjs — ${r.name}: got ${r.detail}`);
  }
  for (const [name, A] of ALTITUDE_TWINS.slice(1)) {
    for (const r of altitudeChecks(A)) {
      if (!r.ok) errors.push(`${name} — ${r.name}: got ${r.detail}`);
    }
  }

  const diffs = altitudeTwinDiffs(altitudeMjs, altitudeTs);
  errors.push(...diffs);
  if (!diffs.length) {
    info.push(
      `the .mjs and .ts twins agree on ${ALTITUDE_CONSTANTS.length} constants and 270 sampled inputs`
    );
  }

  return {
    status: errors.length ? "FAIL" : "PASS",
    reason: errors.length
      ? `${errors.length} altitude assertion${errors.length === 1 ? "" : "s"} failed`
      : "the curve is monotone, hits its pinned points, and both twins agree",
    detail: errors,
    info,
  };
}

/* =========== 4. tune-up (B) folders, over races/_fixtures ============= */

/** The synthetic race folders the UI suite owns. They are the only A races
    this checkout is guaranteed to have (the reference race is archived-in-
    place and the draft is never committed), which is what makes them the
    right parents to hang a test tune-up off. */
export const FIXTURE_RACES_REL = path.posix.join("races", "_fixtures");

/** YYYY-MM-DD, `days` earlier. Whole calendar days, so UTC arithmetic gives
    the same answer any zone would. */
export function isoDaysBefore(iso, days) {
  const [y, m, d] = String(iso).split("-").map(Number);
  const out = new Date(Date.UTC(y, m - 1, d) - days * 86_400_000);
  const p2 = (n) => String(n).padStart(2, "0");
  return `${out.getUTCFullYear()}-${p2(out.getUTCMonth() + 1)}-${p2(out.getUTCDate())}`;
}

/**
 * A tune-up hanging off `parent`, written the way POST /api/races writes one:
 * race.json alone, no block, no nutrition, no plan (PRD-v2 §3).
 * @param {{slug: string, date: string, timezone: string}} parent the A race
 * @param {{weeksBefore?: number, over?: object}} [opts]
 */
export function tuneUpFixture(parent, { weeksBefore = 8, over = {} } = {}) {
  return {
    schema_version: 1,
    slug: "harness-tune-up-25k",
    kind: "b",
    parent_slug: parent.slug,
    status: "draft",
    name: "Harness Tune-up 25K",
    short: "HTU25K",
    date: isoDaysBefore(parent.date, weeksBefore * 7),
    start_time: "07:00",
    timezone: parent.timezone,
    distance_mi: 15.5,
    gain_ft: 2200,
    cutoff_h: null,
    unresolved: [],
    aid_stations: [
      { name: "Finish", total_mi: 15.5, cutoff_h: null, crew: false, drop_bag: false },
    ],
    ...over,
  };
}

/**
 * Every way a tune-up folder may be wrong, and the message that has to catch
 * it. PRD-v2 §3's rules are enforced in one function (race-config.mjs's
 * validateKind) and read by four callers; this is the list that says the
 * rules are still there at all.
 *
 * Pure: `parent` is the A race the good case hangs off, and the returned
 * `race` objects are what the caller validates.
 *
 * @param {{slug: string, date: string, timezone: string}} parent
 * @returns {{name: string, race: object, expect: RegExp|null}[]} `expect`
 *   null means the folder must validate cleanly.
 */
export function tuneUpCases(parent) {
  const good = tuneUpFixture(parent);
  const mutate = (over) => tuneUpFixture(parent, { over });
  return [
    { name: "a tune-up beside its A race validates with no block or nutrition", race: good, expect: null },
    {
      name: 'a tune-up is never "active" — the A race is the training target',
      race: mutate({ status: "active" }),
      expect: /never "active"/,
    },
    {
      name: "a tune-up without a parent is refused",
      race: mutate({ parent_slug: null }),
      expect: /parent_slug: non-empty slug/,
    },
    {
      name: "a parent that is not a folder on disk is caught",
      race: mutate({ parent_slug: "no-such-race-2027" }),
      expect: /no race folder races\/no-such-race-2027\//,
    },
    {
      name: "a tune-up cannot be its own parent",
      race: mutate({ parent_slug: good.slug }),
      expect: /its own parent/,
    },
    {
      name: "tune-ups cannot chain — a B race hangs off an A race",
      race: tuneUpFixture(parent, { over: { slug: "harness-tune-up-10k", parent_slug: good.slug } }),
      expect: /itself a tune-up/,
    },
    {
      name: "an A race carries no parent_slug",
      race: mutate({ kind: "a" }),
      expect: /only a tune-up/,
    },
  ];
}

/** checkFolders' own branch: a draft may carry the holes it declared. */
function raceErrors(race, races) {
  return race.status === "draft"
    ? draftValidationErrors(race, race.unresolved ?? [], { races }).errors
    : validateRaceJson(race, { races }).errors;
}

async function checkTuneUps(root) {
  const src = path.join(root, "races", "_fixtures");
  let names;
  try {
    names = (await fs.readdir(src, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    names = [];
  }
  if (!names.length) {
    return { status: "SKIP", reason: `${FIXTURE_RACES_REL}/ is not in this checkout`, detail: [], info: [] };
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-check-races-b-"));
  try {
    // listRaces skips `_`-prefixed folders, which is exactly why the fixtures
    // are never a race the app can open — so they are copied out to a root
    // where they ARE the races, and the real loader reads them.
    await fs.cp(src, path.join(tmp, "races"), { recursive: true });
    const fixtures = await listRaces(tmp);
    const errors = [];
    const info = [];

    for (const r of fixtures) {
      if (r.error) errors.push(`${FIXTURE_RACES_REL}/${r.slug}: ${r.error}`);
    }
    const aRaces = fixtures.filter((r) => r.race && raceKind(r.race) === "a");
    const parentRow = aRaces.find((r) => r.race.status === "active") ?? aRaces[0];
    if (!parentRow) {
      return {
        status: "FAIL",
        reason: `no A race among the ${fixtures.length} fixture folders to hang a tune-up off`,
        detail: errors,
        info,
      };
    }
    const parent = parentRow.race;
    info.push(`${fixtures.length} fixture folders read · parent: ${parent.slug} (${parent.date}, ${parent.timezone})`);

    /* Each rule, against the real folders. The `races` list handed to the
       validator is the fixtures PLUS the candidate itself, which is what
       checkFolders does — a parent_slug is checked against the folders
       actually on disk, so a case that names a missing one really is
       missing. */
    const good = tuneUpFixture(parent);
    for (const c of tuneUpCases(parent)) {
      /* The good tune-up is always in the list, so the chaining case has a B
         race to point at; the candidate joins it unless it IS that one. */
      const races = [...fixtures, { slug: good.slug, race: good }];
      if (c.race.slug !== good.slug) races.push({ slug: c.race.slug, race: c.race });
      const got = raceErrors(c.race, races);
      if (c.expect === null) {
        if (got.length) errors.push(`${c.name}: ${got.join(" · ")}`);
        else info.push(`${c.name} — clean`);
      } else if (got.some((e) => c.expect.test(e))) {
        info.push(`${c.name} — refused`);
      } else {
        errors.push(`${c.name}: expected ${c.expect} · got ${got.length ? got.join(" · ") : "no error at all"}`);
      }
    }

    /* And the whole folder path, not just the validator: a tune-up written
       into races/ has to pass the same gate section 2 applies to every
       folder, and then appear under its A race with the week count the coach
       plans a taper around. */
    const dir = path.join(tmp, "races", good.slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(good, null, 2));

    const folders = await checkFolders(tmp);
    if (folders.status !== "PASS") {
      errors.push(`a tune-up folder beside the fixtures failed the folder gate: ${folders.detail.join(" · ")}`);
    }
    const single = validateSingleActive(await listRaces(tmp));
    if (single.active.length !== 1 || single.active[0] === good.slug) {
      errors.push(`a tune-up must not take the active pointer (active: ${JSON.stringify(single.active)})`);
    }

    const listed = bRacesFor(await listRaces(tmp), parent);
    const mine = listed.find((b) => b.slug === good.slug);
    if (!mine) {
      errors.push(`${good.slug} does not appear among ${parent.slug}'s b_races`);
    } else if (mine.weeks_out !== 8) {
      errors.push(`weeks_out is ${mine.weeks_out}, expected 8 (${good.date} → ${parent.date}, ${parent.timezone})`);
    } else {
      info.push(`b_races: ${good.slug} sits ${mine.weeks_out} weeks out from ${parent.slug}, and the A race keeps the active pointer`);
    }

    return {
      status: errors.length ? "FAIL" : "PASS",
      reason: errors.length
        ? `${errors.length} tune-up rule${errors.length === 1 ? "" : "s"} broken`
        : `${tuneUpCases(parent).length} tune-up rules hold over ${fixtures.length} fixture folders`,
      detail: errors,
      info,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/* ============ 5. the committed tracker fixtures still parse ============= */

/**
 * The saved tracker pages, what each one is a page OF, and the checkpoint the
 * adapter has to find in it.
 *
 * The point of the fixtures is that no test in this repo may fetch a tracker
 * (scripts/fixtures/trackers/README.md), so the fetch is injected here too —
 * the assertion below includes "the adapter called our fetch, once, with the
 * configured URL", which is what would catch an adapter that grew a real
 * network call of its own.
 */
export const TRACKER_FIXTURES = [
  {
    file: "opensplittime-spread.html",
    adapter: "opensplittime",
    url: "https://www.opensplittime.org/events/2026-san-juan-softie-100/spread",
    bib: "999",
    expect: { checkpoint: "Burnett #7", clock: "21:22" },
    why: "the scrubbed spread table — TEST RUNNER, bib 999, mid-race",
  },
];

/**
 * Registered adapters that deliberately have no fixture, and why. A stub is a
 * documented answer ("this platform cannot be read"), not a gap, so it is
 * listed rather than excused — and it still has to CLAIM its host, or the
 * endpoint would 404 with the wrong message.
 */
export const TRACKER_STUBS = [
  {
    id: "maprogress",
    url: "https://app.maprogress.com/emap/1234",
    why: "its event pages render from a SignalR websocket after load, so the first response carries no checkpoint — there is nothing static to save",
  },
];

/** A fetch that answers with `body` and remembers what it was asked for. */
function fixtureFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return { ok, status, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

async function checkTrackers(root) {
  const errors = [];
  const info = [];

  for (const fx of TRACKER_FIXTURES) {
    const file = path.join(root, "scripts", "fixtures", "trackers", fx.file);
    let html;
    try {
      html = await fs.readFile(file, "utf8");
    } catch (e) {
      errors.push(`${fx.file}: ${e.code === "ENOENT" ? "not in this checkout" : e.message}`);
      continue;
    }
    const adapter = trackers.detect(fx.url);
    if (adapter?.id !== fx.adapter) {
      errors.push(`${fx.url} is claimed by ${JSON.stringify(adapter?.id ?? null)}, expected ${fx.adapter}`);
      continue;
    }
    const impl = fixtureFetch(html);
    let hit;
    try {
      hit = await trackers.fetchLastCheckpoint(
        { url: fx.url, bib: fx.bib, stations: [], at: "2026-08-15T03:00:00.000Z" },
        impl,
      );
    } catch (e) {
      errors.push(`${fx.file}: the ${fx.adapter} adapter threw — ${e.message}`);
      continue;
    }
    // A miss is now a reason-tagged {tracker: null, reason} rather than a
    // bare null (scripts/trackers/opensplittime.mjs) — either shape means
    // the fixture's bib no longer matches a real checkpoint row.
    if (!hit || !hit.station) {
      errors.push(`${fx.file}: bib ${fx.bib} is no longer found on the page`);
      continue;
    }
    for (const [k, want] of Object.entries(fx.expect)) {
      if (hit[k] !== want) errors.push(`${fx.file}: ${k} is ${JSON.stringify(hit[k])}, expected ${JSON.stringify(want)}`);
    }
    if (hit.source !== fx.adapter) {
      errors.push(`${fx.file}: source is ${JSON.stringify(hit.source)}, expected ${JSON.stringify(fx.adapter)}`);
    }
    if (impl.calls.length !== 1 || impl.calls[0] !== fx.url) {
      errors.push(`${fx.file}: the adapter made ${impl.calls.length} call(s) — ${JSON.stringify(impl.calls)} — instead of one, to the injected fetch`);
    }
    info.push(`${fx.file} → ${fx.adapter}: ${hit.checkpoint} at ${hit.clock} (${fx.why})`);
  }

  for (const stub of TRACKER_STUBS) {
    const adapter = trackers.detect(stub.url);
    if (adapter?.id !== stub.id) {
      errors.push(`${stub.url} is claimed by ${JSON.stringify(adapter?.id ?? null)}, expected the ${stub.id} stub`);
      continue;
    }
    if (adapter.supported !== false) {
      errors.push(`${stub.id} no longer marks itself \`supported: false\` — give it a fixture and move it to TRACKER_FIXTURES`);
      continue;
    }
    const impl = fixtureFetch("");
    let code = null;
    try {
      await trackers.fetchLastCheckpoint({ url: stub.url }, impl);
    } catch (e) {
      code = e.code ?? null;
    }
    if (code !== "unsupported") {
      errors.push(`${stub.id} answered with ${JSON.stringify(code)} rather than a tagged \`unsupported\``);
    }
    if (impl.calls.length) errors.push(`${stub.id} fetched ${impl.calls.join(", ")} before saying it is a stub`);
    info.push(`${stub.id}: stub, no fixture — ${stub.why}`);
  }

  /* Coverage: a new adapter with neither a fixture nor a stated reason is the
     failure this catches. The test-only fixture adapter is excluded by name —
     it is registered only under TRAIL_TEST_FIXTURES=1 and its whole job is to
     re-use another adapter's parser. */
  const covered = new Set([...TRACKER_FIXTURES.map((f) => f.adapter), ...TRACKER_STUBS.map((s) => s.id), "fixture"]);
  for (const a of trackers.ADAPTERS) {
    if (!covered.has(a.id)) {
      errors.push(`tracker adapter "${a.id}" has neither a committed fixture nor a listed reason for having none`);
    }
  }

  return {
    status: errors.length ? "FAIL" : "PASS",
    reason: errors.length
      ? `${errors.length} tracker problem${errors.length === 1 ? "" : "s"}`
      : `${TRACKER_FIXTURES.length} fixture page${TRACKER_FIXTURES.length === 1 ? " parses" : "s parse"} and ` +
        `${TRACKER_STUBS.length} stub${TRACKER_STUBS.length === 1 ? " says" : "s say"} so, with no network`,
    detail: errors,
    info,
  };
}

/* ==================== 6. the reference race rebuilds ==================== */

/** "HH:MM" → minutes since midnight; null when it is not a clock time. */
export function clockMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Sunrise and sunset agree with the committed pair to within `tol` minutes. */
export function sunWithin(committed, rebuilt, tol = 5) {
  const out = [];
  for (const k of ["sunrise", "sunset"]) {
    const a = clockMinutes(committed?.[k]);
    const b = clockMinutes(rebuilt?.[k]);
    if (a === null || b === null) {
      out.push(`sun.${k}: ${JSON.stringify(committed?.[k])} vs recomputed ${JSON.stringify(rebuilt?.[k])}`);
      continue;
    }
    const delta = Math.abs(a - b);
    if (delta > tol) out.push(`sun.${k}: recomputed ${rebuilt[k]} is ${delta} min from the committed ${committed[k]} (tol ${tol})`);
  }
  return out;
}

/** The user- and agent-owned provenance entries, which a rebuild must not touch. */
export function ownedProvenance(race) {
  return Object.fromEntries(
    Object.entries(race.provenance ?? {}).filter(([, v]) => v?.by === "user" || v?.by === "agent")
  );
}

/** Minimum aid stations whose gpx_wpt must come back identical, of 15.
    PRD §15 states 15/15; the matcher reproduces exactly that today
    (verified: `node scripts/check-races.mjs` → "waypoints reproduced from
    names alone: 15/15"), so 14 was a stale slack floor from before the
    matcher cleared the last one — a real regression to 14/15 should fail
    this check, not pass it silently under the old floor. */
export const REFERENCE_WPT_FLOOR = 15;

async function checkReferenceRebuild(root) {
  const src = path.join(root, "races", REFERENCE_SLUG);
  try {
    await fs.access(path.join(src, "course.gpx"));
  } catch {
    return {
      status: "SKIP",
      reason: `races/${REFERENCE_SLUG}/ is not in this checkout`,
      detail: [],
      info: [],
    };
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-check-races-"));
  try {
    const dir = path.join(tmp, "races", REFERENCE_SLUG);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(path.join(src, "course.gpx"), path.join(dir, "course.gpx"));
    const committed = JSON.parse(await fs.readFile(path.join(src, "race.json"), "utf8"));

    // Strip exactly what stage 2 is supposed to be able to re-derive: every
    // matched waypoint, and the computed sun (with its stamp, or race-build
    // leaves a stamped value alone).
    const stripped = structuredClone(committed);
    stripped.aid_stations = stripped.aid_stations.map((s) => ({ ...s, gpx_wpt: null }));
    stripped.sun = null;
    delete stripped.provenance?.sun;
    await fs.writeFile(path.join(dir, "race.json"), JSON.stringify(stripped, null, 2));

    const built = await buildRace({ root: tmp, slug: REFERENCE_SLUG });
    const rebuilt = JSON.parse(await fs.readFile(path.join(dir, "race.json"), "utf8"));
    const errors = [];
    const info = [];

    const total = committed.aid_stations.length;
    const reproduced = committed.aid_stations.filter(
      (s, i) => (s.gpx_wpt ?? null) === (rebuilt.aid_stations[i]?.gpx_wpt ?? null)
    ).length;
    if (reproduced < REFERENCE_WPT_FLOOR) {
      errors.push(`gpx_wpt: ${reproduced}/${total} reproduced, floor is ${REFERENCE_WPT_FLOOR}`);
      for (const [i, s] of committed.aid_stations.entries()) {
        const got = rebuilt.aid_stations[i]?.gpx_wpt ?? null;
        if ((s.gpx_wpt ?? null) !== got) errors.push(`  ${s.name}: "${s.gpx_wpt}" → ${JSON.stringify(got)}`);
      }
    }
    info.push(`waypoints reproduced from names alone: ${reproduced}/${total}`);

    // course.json is the artefact the Race views actually read: the snapped
    // mile of every station has to walk forwards.
    const courseJson = JSON.parse(await fs.readFile(path.join(dir, "build", "course.json"), "utf8"));
    let prev = -Infinity;
    for (const s of courseJson.aid_stations ?? []) {
      if (!Number.isFinite(s.gpx_mi)) {
        errors.push(`course.json ${s.name}: gpx_mi is ${JSON.stringify(s.gpx_mi)}`);
        continue;
      }
      if (s.gpx_mi < prev) errors.push(`course.json ${s.name}: gpx_mi ${s.gpx_mi} is behind the previous ${prev}`);
      prev = Math.max(prev, s.gpx_mi);
    }
    info.push(`course.json: ${courseJson.aid_stations?.length ?? 0} stations, gpx_mi 0 → ${prev.toFixed(2)}`);

    errors.push(...sunWithin(committed.sun, rebuilt.sun));
    info.push(`sun: committed ${committed.sun?.sunrise}/${committed.sun?.sunset} · recomputed ${rebuilt.sun?.sunrise}/${rebuilt.sun?.sunset}`);
    if (rebuilt.provenance?.sun?.by !== "computed") {
      errors.push(`provenance.sun.by should be "computed", got ${JSON.stringify(rebuilt.provenance?.sun?.by)}`);
    }

    const before = ownedProvenance(committed);
    const after = ownedProvenance(rebuilt);
    for (const [k, v] of Object.entries(before)) {
      if (JSON.stringify(after[k]) !== JSON.stringify(v)) {
        errors.push(`provenance.${k}: a rebuild rewrote a ${v.by}-owned field's stamp`);
      }
    }
    info.push(`provenance: ${Object.keys(before).length} user/agent stamps unchanged`);
    if (built.unresolved.length) errors.push(`unresolved after rebuild: ${built.unresolved.join(", ")}`);

    return {
      status: errors.length ? "FAIL" : "PASS",
      reason: errors.length
        ? `${errors.length} difference${errors.length === 1 ? "" : "s"} against the archived folder`
        : `${reproduced}/${total} waypoints, monotone course, sun within 5 min, provenance intact`,
      detail: errors,
      info,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/* ======================= 7. the PRD §12 draft check ===================== */

/**
 * Every expectation PRD §12 puts on the San Juan Softie 2027 DRAFT, as a list
 * so the report can name the one that moved. Pure: the fixture in
 * check-races.test.mjs exercises it without the folder being present.
 * @param {object} race a draft race.json
 * @returns {{name: string, ok: boolean, detail: string}[]}
 */
export function softieChecks(race) {
  const stations = Array.isArray(race.aid_stations) ? race.aid_stations : [];
  // The chart numbers its aid stations #1..#11; the start and the finish are
  // rows on the same table but are not aid.
  const numbered = stations.filter((s) => /#\d+\s*$/.test(String(s?.name ?? "").trim()));
  const firstCrew = stations.find((s) => s?.crew === true && Number(s?.total_mi) > 0);
  const f = race.features ?? {};
  // Three ways the image-only aid chart's transcription can still be in front
  // of a human: holes nobody has filled, the review dialog's acknowledgement of
  // them (tt-yib.14 — acknowledging PRUNES the key, so unresolved[] shrinks as
  // the draft is worked), or the intake's own prose about what it could not
  // corroborate. Any one of them is enough; requiring unresolved[] to stay
  // non-empty would make finishing the review look like a regression.
  const flagged =
    (Array.isArray(race.unresolved) && race.unresolved.length > 0) ||
    race.unresolved_acknowledged === true ||
    (typeof race.review_notes === "string" && race.review_notes.trim().length > 0);
  const check = (name, ok, detail) => ({ name, ok: Boolean(ok), detail });

  return [
    check("status is a draft", race.status === "draft", String(race.status)),
    check("11 numbered aid stations", numbered.length === 11, `${numbered.length}`),
    check("13 chart rows incl. start and finish", stations.length === 13, `${stations.length}`),
    check("timezone America/Denver", race.timezone === "America/Denver", String(race.timezone)),
    check("cutoff 38 h", race.cutoff_h === 38, String(race.cutoff_h)),
    check("crew, pacers and drop bags", f.crew === true && f.pacers === true && f.drop_bags === true,
      `crew ${f.crew} · pacers ${f.pacers} · drop_bags ${f.drop_bags}`),
    check("no heat flag", f.heat === false, String(f.heat)),
    check("high point 12,438 ft", race.elevation?.max_ft === 12438, String(race.elevation?.max_ft)),
    check("first crew access at mi 45.8", firstCrew?.total_mi === 45.8,
      firstCrew ? `${firstCrew.name} at ${firstCrew.total_mi}` : "no crew station"),
    check("results on OpenSplitTime", /opensplittime/i.test(String(race.links?.results ?? "")),
      String(race.links?.results)),
    check("image-chart transcription flagged for review", flagged,
      `unresolved ${Array.isArray(race.unresolved) ? race.unresolved.length : 0} · ` +
      `acknowledged ${race.unresolved_acknowledged === true} · review_notes ${race.review_notes ? "present" : "absent"}`),
  ];
}

/** sha256 of a buffer, short form, for the --live source diff. */
const digest = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);

/**
 * Re-fetch every source the draft cites and compare it with the cached copy in
 * `sources/`. This is what `--live` adds: not a re-run of the agent (that is an
 * intake, and it costs a model call), but the question the agent's answer
 * depends on — has the organizer changed the manual, the chart or the GPX since
 * the draft was taken?
 */
async function liveSourceDiff(dir, race) {
  const out = [];
  for (const s of race.sources ?? []) {
    if (s.kind === "pdf" && !/^https?:/i.test(String(s.ref))) {
      out.push(`skipped  ${s.ref} (uploaded by hand, no URL to re-fetch)`);
      continue;
    }
    let cached = null;
    if (s.file) {
      try {
        cached = digest(await fs.readFile(path.join(dir, "sources", s.file)));
      } catch {
        cached = null;
      }
    }
    try {
      const res = await fetch(s.ref, {
        redirect: "follow",
        signal: AbortSignal.timeout(25_000),
        headers: { "user-agent": "Mozilla/5.0 (Macintosh) Basecamp-race-intake/1" },
      });
      if (!res.ok) {
        out.push(`HTTP ${res.status}  ${s.ref}`);
        continue;
      }
      const live = digest(Buffer.from(await res.arrayBuffer()));
      if (cached === null) out.push(`fetched  ${s.ref} (no cached copy to compare)`);
      else if (cached === live) out.push(`same     ${s.ref}`);
      else out.push(`CHANGED  ${s.ref} (cached ${cached} → live ${live})`);
    } catch (e) {
      out.push(`failed   ${s.ref}: ${e.message}`);
    }
  }
  return out;
}

async function checkDraft(root, { live = false } = {}) {
  const dir = path.join(root, "races", DRAFT_SLUG);
  let race;
  try {
    race = JSON.parse(await fs.readFile(path.join(dir, "race.json"), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return {
      status: "SKIP",
      reason: `races/${DRAFT_SLUG}/race.json is not in this checkout (the draft is never committed)`,
      detail: [],
      info: [],
    };
  }

  const results = softieChecks(race);
  const errors = results.filter((r) => !r.ok).map((r) => `${r.name}: got ${r.detail}`);
  const { errors: schema } = draftValidationErrors(race, race.unresolved ?? []);
  for (const e of schema) errors.push(`race.json: ${e}`);

  const info = results.filter((r) => r.ok).map((r) => `${r.name} — ${r.detail}`);
  info.push(`draft validation: ${schema.length ? `${schema.length} errors` : "clean"}`);
  if (live) info.push(...(await liveSourceDiff(dir, race)));
  else info.push("live source re-check: off (pass --live)");

  return {
    status: errors.length ? "FAIL" : "PASS",
    reason: errors.length
      ? `${errors.length} of ${results.length + 1} PRD §12 expectations missed`
      : `${results.length} PRD §12 expectations hold and the draft validates`,
    detail: errors,
    info,
  };
}

/* ========== 8. the crew export is one self-contained file ============== */

/** The fixture race the export is rendered from: a full aid chart, crew
    stops, a built course and night — the widest sheet the exporter makes. */
export const CREW_EXPORT_SLUG = "mm-like-100";

/**
 * Render the crew handout and check the one property nobody else will notice
 * breaking: it points at nothing.
 *
 * The file is opened once, on a phone, in a canyon, by someone who cannot
 * debug it (PRD-v2 §5). A stylesheet left on a CDN or a font left on Google
 * is invisible on the laptop that made the export and fatal where it is read,
 * so this asserts on what the document REFERENCES rather than on how it
 * looks — `assetRefs` is the exporter's own predicate, shared with
 * scripts/crew-export.test.mjs.
 *
 * It runs against the UI suite's throwaway project root, which is the only
 * thing in the repo that can produce a real export without touching the
 * developer's data: fixture race folders with their courses built, and
 * synthetic Strava behind the pacing fit.
 */
async function checkCrewExport() {
  const previousShell = process.env.TRAIL_CREW_SHELL;
  let root = null;
  try {
    root = await makeProjectRoot();
    /* crewExport resolves the single-file shell under ITS root, and a temp
       root has no web/, no crew.html and no node_modules to build one in. The
       shell is code, not data, so it is built once from this checkout and
       handed over through the variable that exists for exactly that. */
    process.env.TRAIL_CREW_SHELL = await buildCrewShell();

    const { html, bytes, data } = await crewExport(root, CREW_EXPORT_SLUG, { write: false });
    const errors = [];
    const info = [];

    const refs = assetRefs(html);
    if (refs.length) {
      errors.push(
        `the export references ${refs.length} thing${refs.length === 1 ? "" : "s"} outside itself: ` +
          [...new Set(refs)].slice(0, 5).join(", ")
      );
    }
    if (bytes >= MAX_EXPORT_BYTES) {
      errors.push(`the export is ${(bytes / 1024 / 1024).toFixed(2)} MB, over the ${MAX_EXPORT_BYTES / 1024 / 1024} MB budget`);
    }

    /* The race's own web address, the organizer's manual and the results host
       ARE in the file — as text, inside the embedded JSON. Outside it, an
       http(s) string is markup pointing at the internet. */
    const block = /<script\b[^>]*id="crew-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!block) {
      errors.push('the <script id="crew-data"> block did not survive the render');
    } else {
      const outsideData = html.slice(0, block.index) + html.slice(block.index + block[0].length);
      const stray = [...new Set(outsideData.match(/https?:\/\/[^\s"'<>]+/g) ?? [])];
      if (stray.length) errors.push(`${stray.length} http(s) URL(s) in the markup rather than the data: ${stray.slice(0, 3).join(", ")}`);
    }

    info.push(
      `${CREW_EXPORT_SLUG}: ${(bytes / 1024).toFixed(0)} KB of ${MAX_EXPORT_BYTES / 1024} KB · ` +
        `${data.projection.stations.length} stations · ${data.crew_pickups.length} crew stops`
    );
    info.push(`asset references: ${refs.length} · the shell and its data are one file`);

    return {
      status: errors.length ? "FAIL" : "PASS",
      reason: errors.length
        ? `${errors.length} problem${errors.length === 1 ? "" : "s"} with the exported handout`
        : `one file, ${(bytes / 1024).toFixed(0)} KB, pointing at nothing`,
      detail: errors,
      info,
    };
  } finally {
    if (previousShell === undefined) delete process.env.TRAIL_CREW_SHELL;
    else process.env.TRAIL_CREW_SHELL = previousShell;
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
}

/* ========================= 9. build and unit tests ====================== */

/** Run one npm script in web/, capturing its combined output. */
function runNpm(root, script) {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", script], {
      cwd: path.join(root, "web"),
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; });
    child.stderr.on("data", (d) => { buf += d; });
    child.on("error", (e) => resolve({ code: -1, output: `${buf}\nspawn failed: ${e.message}` }));
    child.on("close", (code) => resolve({ code, output: buf }));
  });
}

/** The last `n` non-blank lines — what a human wants to see of a long run. */
export function tail(output, n = 12) {
  return output.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-n);
}

async function checkHarness(root) {
  const detail = [];
  const info = [];
  let failed = 0;
  for (const script of ["build", "test"]) {
    const { code, output } = await runNpm(root, script);
    const lines = tail(output).map((l) => `  ${l}`);
    if (code === 0) {
      info.push(`npm run ${script} — exit 0`, ...lines);
    } else {
      failed += 1;
      detail.push(`npm run ${script} — exit ${code}`, ...lines);
    }
  }
  return {
    status: failed ? "FAIL" : "PASS",
    reason: failed ? `${failed} of 2 npm scripts failed` : "npm run build and npm test both exit 0",
    detail,
    info,
  };
}

/* ======================== 10. the browser flows ========================= */

/**
 * Why the UI section is being skipped, or null to run it.
 *
 * Two ways to say so, because they are asked in two places: `--no-ui` from a
 * developer running the gate by hand, and TRAIL_CHECK_NO_UI=1 from a machine
 * (a container with no browser, a hook that must stay fast) where nobody is
 * there to pass a flag. Either way the section reports SKIP with the reason
 * on it — a check that quietly does not run is worse than one that fails.
 *
 * @param {string[]} [argv]
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
export function uiSkipReason(argv = process.argv, env = process.env) {
  if (argv.includes("--no-ui")) return "--no-ui";
  if ((env.TRAIL_CHECK_NO_UI ?? "").trim()) return "TRAIL_CHECK_NO_UI=1";
  return null;
}

/** "48s" / "1m 12s" — a duration a human reads, not a millisecond count. */
export function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, "0")}s`;
}

/**
 * The Playwright suite, as its own section.
 *
 * It is the slowest thing the gate does and the only part that needs a
 * browser, so its wall time is always reported — a suite that has crept from
 * thirty seconds to four minutes is a finding, and nobody notices it inside a
 * single PASS line.
 */
async function checkUi(root, { ui = true, skipReason = null } = {}) {
  if (!ui) {
    return {
      status: "SKIP",
      reason: `browser flows not run (${skipReason ?? "disabled"})`,
      detail: [],
      info: ["web/tests/ — run `cd web && npm run test:ui` to drive them"],
    };
  }
  const started = Date.now();
  const { code, output } = await runNpm(root, "test:ui");
  const took = formatDuration(Date.now() - started);
  const lines = tail(output).map((l) => `  ${l}`);
  if (code !== 0) {
    return {
      status: "FAIL",
      reason: `npm run test:ui — exit ${code} after ${took}`,
      detail: [`npm run test:ui — exit ${code}`, ...lines],
      info: [],
    };
  }
  return {
    status: "PASS",
    reason: `the browser flows pass in ${took}`,
    detail: [],
    info: [`npm run test:ui — exit 0 in ${took}`, ...lines],
  };
}

/* =============================== report ================================ */

export const SECTIONS = [
  { id: "literals", title: "race literals out of the code", run: checkLiterals },
  { id: "folders", title: "every race folder validates", run: checkFolders },
  { id: "altitude", title: "the altitude curve holds its shape", run: checkAltitude },
  { id: "tuneups", title: "tune-up folders obey PRD-v2 §3", run: checkTuneUps },
  { id: "trackers", title: "the committed tracker fixtures parse", run: checkTrackers },
  { id: "reference", title: `${REFERENCE_SLUG} rebuilds deterministically`, run: checkReferenceRebuild },
  { id: "draft", title: `${DRAFT_SLUG} against PRD §12`, run: checkDraft },
  { id: "crew", title: "the crew export is one self-contained file", run: checkCrewExport },
  { id: "harness", title: "npm run build · npm test", run: checkHarness },
  { id: "ui", title: "npm run test:ui — the browser flows", run: checkUi },
];

const MARK = { PASS: "✔", FAIL: "✗", SKIP: "–" };

async function main() {
  const startedAt = Date.now();
  const quiet = Boolean(process.env.TRAIL_CHECK_QUIET);
  const live = process.argv.includes("--live");
  const skipReason = uiSkipReason();
  const ui = skipReason === null;
  const say = (line = "") => console.log(line);

  say(`── Basecamp race harness ──  ${ROOT}`);
  if (live) say("--live: the draft's sources will be re-fetched over the network.");
  if (!ui) say(`${skipReason}: the browser flows will be skipped.`);
  say();

  const results = [];
  for (const section of SECTIONS) {
    if (!quiet) say(`▸ ${section.title}`);
    let r;
    try {
      r = await section.run(ROOT, { live, ui, skipReason });
    } catch (e) {
      r = { status: "FAIL", reason: `threw: ${e.message}`, detail: [String(e.stack ?? e)], info: [] };
    }
    results.push({ ...section, ...r });
    // `warnings` — currently only checkFolders sets it (a draft's stale
    // block) — is a fact worth acting on but never fails the gate the way
    // `detail`/errors do, so it is printed distinctly in BOTH modes rather
    // than folded into `info`, which quiet mode already drops entirely.
    if (quiet) {
      say(`${MARK[r.status]} ${r.status.padEnd(4)} ${section.title} — ${r.reason}`);
      for (const line of r.detail) say(`       ${line}`);
      for (const line of r.warnings ?? []) say(`       ⚠ ${line}`);
      continue;
    }
    say(`  ${MARK[r.status]} ${r.status}  ${r.reason}`);
    for (const line of r.detail) say(`    ✗ ${line}`);
    for (const line of r.warnings ?? []) say(`    ⚠ ${line}`);
    for (const line of r.info) say(`    · ${line}`);
    say();
  }

  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const r of results) counts[r.status] += 1;
  say("── summary ──");
  for (const r of results) say(`  ${MARK[r.status]} ${r.status.padEnd(4)} ${r.id.padEnd(10)} ${r.reason}`);
  say(`  ${counts.PASS} passed · ${counts.SKIP} skipped · ${counts.FAIL} failed`);
  say(`  in ${formatDuration(Date.now() - startedAt)}`);
  process.exitCode = counts.FAIL ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(`✗ ${e.stack ?? e}`);
    process.exit(1);
  });
}
