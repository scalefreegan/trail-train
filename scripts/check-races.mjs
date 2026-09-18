#!/usr/bin/env node
// The exit test for the modular-races epic (tt-yib.19; PRD §12, §13).
//
// Five sections, each PASS / FAIL / SKIP with a reason. Any FAIL exits 1.
//
//   1. literals  no race name, short code, trailhead town or aid-station name
//                survives in CODE. Comment mentions are history, not coupling,
//                so they are reported as INFO; a short, explicit exception list
//                carries the two deliberate slug constants.
//   2. folders   every folder listRaces() returns validates (draft semantics
//                for drafts), at most one is active, and the block.json /
//                nutrition.json beside each race.json pass their validators.
//   3. mm100     determinism: the archived reference folder, copied to a temp
//                dir with every gpx_wpt and its sun stripped, rebuilds to the
//                same waypoints, the same sunrise/sunset and a monotone course,
//                without touching a single user- or agent-owned field.
//   4. softie    PRD §12's assertions against the San Juan Softie 2027 DRAFT,
//                when that (uncommitted) folder is present. --live additionally
//                re-fetches the sources it cites and reports what has changed.
//   5. harness   `npm run build` and `npm test` in web/.
//
// Usage:  cd web && npm run check:races
//         cd web && npm run check:races -- --live    (network; see README)
//         TRAIL_CHECK_QUIET=1 npm run check:races    (results and summary only)

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listRaces, loadRaceFolder, validateRaceJson, validateSingleActive } from "./race-config.mjs";
import { draftValidationErrors } from "./race-intake.mjs";
import { validateBlockTargets, validateNutrition } from "./race-plan.mjs";
import { normalizeNutrition } from "../web/src/race/nutrition-config.ts";
import { buildRace } from "./race-build.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

async function checkFolders(root) {
  const races = await listRaces(root);
  const errors = [];
  const info = [];
  if (!races.length) {
    return { status: "SKIP", reason: "no race folders under races/", detail: [], info: [] };
  }

  for (const r of races) {
    if (r.error) {
      errors.push(`${r.slug}: ${r.error}`);
      continue;
    }
    // A draft may carry the holes it declared in unresolved[]; an active or
    // archived folder must validate outright.
    const { errors: schema } = r.race.status === "draft"
      ? draftValidationErrors(r.race, r.race.unresolved ?? [])
      : validateRaceJson(r.race);
    for (const e of schema) errors.push(`${r.slug}/race.json: ${e}`);

    const folder = await loadRaceFolder(root, r.slug);
    if (folder.block) {
      const { errors: be } = validateBlockTargets(folder.block.targets, {
        total_weeks: folder.block.total_weeks,
        race: r.race,
      });
      for (const e of be) errors.push(`${r.slug}/block.json: ${e}`);
    }
    if (folder.nutrition) {
      const { errors: ne } = validateNutrition(folder.nutrition, r.race);
      for (const e of ne) errors.push(`${r.slug}/nutrition.json: ${e}`);
      if (!normalizeNutrition(folder.nutrition)) {
        errors.push(`${r.slug}/nutrition.json: the client loader refuses it`);
      }
    }
    info.push(
      `${r.slug}  status ${r.race.status} · ${r.race.aid_stations?.length ?? 0} stations · ` +
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
  };
}

/* ==================== 3. the reference race rebuilds ==================== */

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

/** Minimum aid stations whose gpx_wpt must come back identical, of 15. */
export const REFERENCE_WPT_FLOOR = 14;

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

/* ======================= 4. the PRD §12 draft check ===================== */

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

/* ========================= 5. build and unit tests ====================== */

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

/* =============================== report ================================ */

const SECTIONS = [
  { id: "literals", title: "race literals out of the code", run: checkLiterals },
  { id: "folders", title: "every race folder validates", run: checkFolders },
  { id: "reference", title: `${REFERENCE_SLUG} rebuilds deterministically`, run: checkReferenceRebuild },
  { id: "draft", title: `${DRAFT_SLUG} against PRD §12`, run: checkDraft },
  { id: "harness", title: "npm run build · npm test", run: checkHarness },
];

const MARK = { PASS: "✔", FAIL: "✗", SKIP: "–" };

async function main() {
  const quiet = Boolean(process.env.TRAIL_CHECK_QUIET);
  const live = process.argv.includes("--live");
  const say = (line = "") => console.log(line);

  say(`── Basecamp race harness ──  ${ROOT}`);
  if (live) say("--live: the draft's sources will be re-fetched over the network.");
  say();

  const results = [];
  for (const section of SECTIONS) {
    if (!quiet) say(`▸ ${section.title}`);
    let r;
    try {
      r = await section.run(ROOT, { live });
    } catch (e) {
      r = { status: "FAIL", reason: `threw: ${e.message}`, detail: [String(e.stack ?? e)], info: [] };
    }
    results.push({ ...section, ...r });
    if (quiet) {
      say(`${MARK[r.status]} ${r.status.padEnd(4)} ${section.title} — ${r.reason}`);
      for (const line of r.detail) say(`       ${line}`);
      continue;
    }
    say(`  ${MARK[r.status]} ${r.status}  ${r.reason}`);
    for (const line of r.detail) say(`    ✗ ${line}`);
    for (const line of r.info) say(`    · ${line}`);
    say();
  }

  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  for (const r of results) counts[r.status] += 1;
  say("── summary ──");
  for (const r of results) say(`  ${MARK[r.status]} ${r.status.padEnd(4)} ${r.id.padEnd(10)} ${r.reason}`);
  say(`  ${counts.PASS} passed · ${counts.SKIP} skipped · ${counts.FAIL} failed`);
  process.exitCode = counts.FAIL ? 1 : 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(`✗ ${e.stack ?? e}`);
    process.exit(1);
  });
}
