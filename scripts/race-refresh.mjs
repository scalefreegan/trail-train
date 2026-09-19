#!/usr/bin/env node
// Re-intake: "Refresh from sources" on a race that already exists (PRD §8).
//
// The Softie's 2027 manual lands months after the first intake, and by then
// the folder carries hand edits — a cutoff typed off the posted clock times, a
// crew note, a drop bag the owner re-packed. So a refresh never writes over
// the race. It builds a SECOND copy of the folder in a shadow directory and
// hands back a diff:
//
//   races/<slug>/               the live race — untouched until Accept
//   races/<slug>/.refresh/      stages 1-3 again, top to bottom
//   races/<slug>/.refresh/diff.json   what Accept would change, field by field
//
// Three calls, in the order the review dialog makes them:
//
//   runRefresh    fetch → agent → build → plan into .refresh/, then merge the
//                 three files against the live ones and write diff.json.
//   acceptRefresh apply the merge to the live folder and delete .refresh/.
//   rejectRefresh delete .refresh/. The live folder was never touched.
//
// What a refresh may NOT do, and the tests that hold it to it
// (scripts/race-refresh.test.mjs):
//   · nothing outside .refresh/ changes before Accept — not race.json, not
//     course.gpx, not build/, and above all not the sources cache the NEXT
//     refresh would diff against;
//   · plan.json and result.json are never touched, by anything here. The coach
//     owns one and a finished race owns the other, and neither is intake output;
//   · status and config/active-race.json are never touched: the race the
//     athlete is training for stays the race the athlete is training for, all
//     the way through a refresh (PRD §8);
//   · the merge is deterministic and agent-free — scripts/race-merge.mjs.
//
// The new source cache is promoted into races/<slug>/sources/ only on Accept,
// and it lands under a DATED name (sources/<stamp>/ plus a manifest-<stamp>.json)
// so the manual the current race.json was read from is still there to compare
// against. The cache is gitignored either way.
//
// Usage:  node scripts/race-refresh.mjs --race <slug> [--accept|--reject]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { arg, note, projectRoot, writeJsonAtomic } from "./lib.mjs";
import { APPLYING_MARKER, SHADOW, applyingPath, diffPath, loadRaceFolder, loadRaceFolderAt, raceDir, shadowDir } from "./race-config.mjs";
import { runIntake } from "./race-intake.mjs";
import { buildRace } from "./race-build.mjs";
import { planRace } from "./race-plan.mjs";
import { mergeRaceFolder } from "./race-merge.mjs";

// SHADOW/shadowDir/diffPath/APPLYING_MARKER/applyingPath now live in
// race-config.mjs (a leaf module) rather than here — scripts/race-edit.mjs
// needs applyingPath too, and race-edit.mjs importing THIS file directly
// would be a cycle (this file imports race-merge.mjs, which imports
// race-edit.mjs for recomputeUnresolved). Re-exported so every existing
// `from "./race-refresh.mjs"` import (this file's own CLI, tests) keeps
// working unchanged.
export { SHADOW, shadowDir, diffPath, APPLYING_MARKER, applyingPath };

const ROOT = projectRoot();

/** The files a refresh may ever rewrite. plan.json and result.json are not
    here and are not an oversight — see the header. */
export const MERGED_FILES = ["race.json", "block.json", "nutrition.json"];

const GPX_RE = /\.gpx(?:[?#]|$)/i;

async function readJsonIfPresent(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * The shadow's race.json, or null when stage 1-3 never wrote one — the ONLY
 * case that should read as "nothing to diff". race-config.mjs's readJson has
 * no error code to distinguish that from a truncated write or a race.json
 * that is not valid JSON (it throws a plain Error either way), so this keys
 * off the message shape listRaces (race-config.mjs) already uses for the same
 * distinction. A parse or schema error must propagate: swallowing it here
 * would report the misleading "the refresh produced no race.json to diff"
 * for what is actually a broken shadow folder the owner needs to see.
 * @returns {Promise<{slug: string, dir: string, race: object, block: object|null, plan: object|null, nutrition: object|null}|null>}
 */
export async function loadShadowRace(shadow, slug) {
  return loadRaceFolderAt(shadow, slug).catch((e) => {
    if (/not found$/.test(e.message)) return null;
    throw e;
  });
}

/** YYYY-MM-DD-HHMM, the dated name the promoted source cache takes. */
export function sourceStamp(at = new Date()) {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/**
 * Where this refresh should re-fetch from: the race's own links and source
 * manifest, because "refresh from sources" means the sources the race was
 * built from, not a form the owner fills in again.
 *
 * links.site is the anchor. Everything else the first intake followed is
 * offered as an extra URL so the manual and the GPX are re-fetched even when
 * the site's own navigation has since changed.
 * @returns {{siteUrl: string|null, extraUrls: string[]}}
 */
export function refreshSources(race) {
  const isUrl = (v) => typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim());
  const site = isUrl(race?.links?.site) ? race.links.site.trim() : null;
  const extras = [];
  for (const k of ["manual", "gpx", "map", "results", "tracking"]) {
    const v = race?.links?.[k];
    if (isUrl(v) && v.trim() !== site) extras.push(v.trim());
  }
  for (const s of race?.sources ?? []) {
    if (isUrl(s?.ref) && s.ref.trim() !== site && !extras.includes(s.ref.trim())) extras.push(s.ref.trim());
  }
  return { siteUrl: site, extraUrls: extras };
}

/* ------------------------------ the run --------------------------------- */

/**
 * Re-run the intake into races/<slug>/.refresh/ and diff the result.
 *
 * @param {object} opts
 * @param {string} opts.root repo root
 * @param {string} opts.slug the race to refresh — must already exist
 * @param {string} [opts.siteUrl] override the race's own links.site
 * @param {string[]} [opts.extraUrls] extra pages to follow, on top of the race's
 * @param {{name: string, path: string}[]} [opts.uploads] a newly posted manual
 * @param {string} [opts.notes] "what matters to me", for the agent
 * @param {(e: {step: string, status: string, label?: string, message?: string, stream?: string}) => void} [opts.onProgress]
 * @param {boolean} [opts.skipPlan] stop after stage 2 — block.json and
 *   nutrition.json then have nothing incoming and simply do not diff
 * @param {typeof import("./agent-run.mjs").runClaudeJson} [opts.runAgent] stage 1's spawn (injected by the tests)
 * @param {typeof import("./agent-run.mjs").runClaudeJson} [opts.runPlanAgent] stage 3's spawn (injected by the tests)
 * @param {Date} [opts.today] injectable clock for the block calendar
 * @returns {Promise<{slug: string, dir: string, shadow: string, diff: object}>}
 */
export async function runRefresh({
  root,
  slug,
  siteUrl = null,
  extraUrls = [],
  uploads = [],
  notes = "",
  onProgress = () => {},
  skipPlan = false,
  runAgent = undefined,
  runPlanAgent = undefined,
  today = new Date(),
}) {
  if (!root) throw new Error("runRefresh: root is required");
  if (!slug) throw new Error("runRefresh: slug is required");
  const step = (id, status, extra = {}) => onProgress({ step: id, status, ...extra });
  const say = (id, message, extra = {}) => onProgress({ step: id, status: "log", message, ...extra });
  const warnings = [];
  const at = new Date().toISOString();

  // The live folder, read once and never written by this function.
  const current = await loadRaceFolder(root, slug);
  const dir = current.dir;
  const shadow = path.join(dir, SHADOW);

  const sources = refreshSources(current.race);
  const site = siteUrl ?? sources.siteUrl;
  if (!site) {
    throw new Error(`races/${slug}/race.json has no links.site to refresh from — add one, or pass a site URL`);
  }
  const year = current.race.edition_year ?? String(current.race.date ?? "").slice(0, 4);
  if (!/^\d{4}$/.test(String(year))) {
    throw new Error(`races/${slug}/race.json has no edition_year (or date) to re-intake against`);
  }

  // A previous refresh's shadow is scratch, not evidence: replaced, never merged.
  await fs.rm(shadow, { recursive: true, force: true });
  await fs.mkdir(shadow, { recursive: true });

  /* 1. sources → draft, into the shadow */
  step("intake", "start", { label: `re-reading ${site}` });
  const intake = await runIntake({
    root,
    siteUrl: site,
    extraUrls: [...new Set([...sources.extraUrls, ...extraUrls])],
    year: String(year),
    uploads,
    notes,
    // The folder's identity is the caller's, not the agent's: a refresh of
    // this race writes THIS race's shadow whatever the new manual calls it.
    slugHint: slug,
    refresh: true,
    outDir: shadow,
    onProgress,
    ...(runAgent ? { runAgent } : {}),
  });
  warnings.push(...intake.warnings);
  step("intake", "done", { unresolved: intake.unresolved.length });

  /* The shadow needs a course.gpx of its own before stage 2 can snap anything
     to it. A GPX that came down with this fetch IS the new course; without
     one, buildRace falls back to fetching links.gpx exactly as a first intake
     does. The live course.gpx is deliberately not copied in — a refresh that
     could not get the track should say so rather than quietly re-measure the
     old one and report no change. */
  const gpxEntry = (intake.manifest ?? []).find((m) => m.file && (m.kind === "gpx" || GPX_RE.test(m.file)));
  if (gpxEntry) {
    await fs.copyFile(path.join(shadow, "sources", gpxEntry.file), path.join(shadow, "course.gpx"));
    say("intake", `course.gpx from ${gpxEntry.ref}`);
  }

  /* 2. course */
  step("build", "start", { label: "snapping the new chart to the track" });
  const build = await buildRace({ root, slug, dir: shadow, onProgress });
  warnings.push(...build.warnings);
  step("build", "done", { course: Boolean(build.course) });

  /* 3. block + fuel */
  let plan = null;
  if (skipPlan) {
    say("plan", "skipped — block.json and nutrition.json will not be diffed");
    step("plan", "done", { skipped: true });
  } else {
    step("plan", "start", { label: "re-planning the block and the fuel plan" });
    try {
      plan = await planRace({
        root,
        slug,
        dir: shadow,
        today,
        onProgress,
        ...(runPlanAgent ? { runAgent: runPlanAgent } : {}),
      });
      warnings.push(...plan.warnings);
      step("plan", "done", { wrote: plan.wrote.length });
    } catch (e) {
      /* A failed plan does not fail the refresh. Stages 1 and 2 have already
         re-read the chart and re-snapped the course — the expensive half — and
         throwing that away because the block could not be planned (a draft
         with no date is the common one) would make the owner pay for it twice.
         block.json and nutrition.json then simply have no incoming version, so
         they do not appear in the diff and Accept leaves them alone. */
      warnings.push(`the block and fuel plan were not re-planned: ${e.message}`);
      say("plan", warnings[warnings.length - 1], { stream: "err" });
      step("plan", "error", { message: e.message });
    }
  }

  /* 4. the merge — deterministic, no agent, nothing written to the live folder */
  step("merge", "start", { label: "diffing against the race on disk" });
  const incoming = await loadShadowRace(shadow, slug);
  if (!incoming) throw new Error(`the refresh produced no ${SHADOW}/race.json to diff`);
  const merged = mergeRaceFolder(
    { race: current.race, block: current.block, nutrition: current.nutrition },
    { race: incoming.race, block: incoming.block, nutrition: incoming.nutrition },
    { at },
  );

  const diff = {
    slug,
    at,
    site,
    files: Object.keys(merged.files),
    diff: merged.diff,
    conflicts: merged.conflicts,
    unresolved: merged.unresolved,
    warnings,
    /* What Accept would promote alongside the files. */
    sources_stamp: sourceStamp(new Date(at)),
    stages: {
      intake: { unresolved: intake.unresolved.length, agent: intake.agent ?? null },
      build: { course: Boolean(build.course), matched: build.matched?.length ?? 0 },
      plan: plan ? { wrote: plan.wrote, agent: plan.agent ?? null } : null,
    },
  };
  await writeJsonAtomic(diffPath(root, slug), diff);
  step("merge", "done", { changes: merged.diff.length, conflicts: merged.conflicts.length });

  return { slug, dir, shadow, diff };
}

/**
 * The pending diff for a race, or null when there is no refresh waiting.
 * @returns {Promise<object|null>}
 */
export async function readRefresh(root, slug) {
  return readJsonIfPresent(diffPath(root, slug));
}

/**
 * Apply the refresh. The merge is recomputed here rather than replayed from
 * diff.json on purpose: if the owner edited the race while the refresh sat
 * waiting, THAT edit is the newer claim and the merge has to see it — the
 * alternative is a stale "merged" blob quietly reverting a hand edit made five
 * minutes ago. The diff the owner accepted is still the diff they get, unless
 * they themselves changed something underneath it.
 *
 * Every file is written atomically (temp + rename, scripts/lib.mjs). The three
 * renames are not one transaction; a crash between them leaves a folder with
 * one file refreshed and the rest not, which validates and reads fine — the
 * alternative (a folder-level swap) would have to move plan.json and
 * result.json, which this must never touch.
 *
 * @returns {Promise<{slug: string, wrote: string[], sources: string|null, conflicts: object[]}>}
 */
export async function acceptRefresh({ root, slug, onProgress = () => {} }) {
  const say = (message) => onProgress({ step: "accept", status: "log", message });
  const shadow = shadowDir(root, slug);
  const pending = await readRefresh(root, slug);
  if (!pending) throw new Error(`no refresh waiting for ${slug} — races/${slug}/${SHADOW}/diff.json is not there`);

  // Set before any of the merge/copy/write work below, removed only by the
  // `.refresh/` cleanup at the very end — see APPLYING_MARKER above.
  await fs.writeFile(applyingPath(root, slug), new Date().toISOString());

  const current = await loadRaceFolder(root, slug);
  const incoming = await loadRaceFolderAt(shadow, slug);
  const merged = mergeRaceFolder(
    { race: current.race, block: current.block, nutrition: current.nutrition },
    { race: incoming.race, block: incoming.block, nutrition: incoming.nutrition },
    { at: new Date().toISOString() },
  );

  const wrote = [];

  /* The course the new chart was snapped to, and the build that came off it,
     copied BEFORE the merged JSON below. Both are generated and gitignored,
     and a crash partway through this function must not leave a refreshed aid
     table sitting beside a stale course (a mismatch nothing would flag). This
     order does not make a crash impossible — it makes it repairable: .refresh/
     is not removed until the very last line, so a re-run of acceptRefresh
     recomputes the same merge and finishes whichever half did not land. */
  for (const asset of ["course.gpx", path.join("build", "course.json")]) {
    const from = path.join(shadow, asset);
    if (!(await fs.access(from).then(() => true, () => false))) continue;
    const to = path.join(current.dir, asset);
    // A raw fs.copyFile onto the live path is not atomic — a crash mid-copy
    // leaves a truncated file there, which is exactly the kind of half-write
    // the reordering above this loop exists to avoid. Temp file + rename,
    // same guarantee writeJsonAtomic (scripts/lib.mjs) gives every JSON
    // write in this app; course.gpx is text, so this copies bytes rather
    // than round-tripping through JSON.parse/stringify.
    await fs.mkdir(path.dirname(to), { recursive: true });
    const tmp = `${to}.tmp.${process.pid}`;
    await fs.copyFile(from, tmp);
    await fs.rename(tmp, to);
    wrote.push(`races/${slug}/${asset}`);
    say(`races/${slug}/${asset}`);
  }

  for (const file of MERGED_FILES) {
    const next = merged.files[file];
    if (!next) continue;
    await writeJsonAtomic(path.join(current.dir, file), next);
    wrote.push(`races/${slug}/${file}`);
    say(`races/${slug}/${file}`);
  }

  /* The source cache, under a dated name so the manual the CURRENT race.json
     was transcribed from survives its own replacement. */
  const stamp = typeof pending.sources_stamp === "string" ? pending.sources_stamp : sourceStamp();
  let sources = null;
  const shadowSources = path.join(shadow, "sources");
  if (await fs.access(shadowSources).then(() => true, () => false)) {
    const dest = path.join(current.dir, "sources", stamp);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(shadowSources, dest, { recursive: true });
    const manifest = await readJsonIfPresent(path.join(shadowSources, "manifest.json"));
    if (manifest) await writeJsonAtomic(path.join(current.dir, "sources", `manifest-${stamp}.json`), manifest);
    sources = `races/${slug}/sources/${stamp}/`;
    say(`sources cached under ${stamp}/ — the previous manual is still there`);
  }

  await fs.rm(shadow, { recursive: true, force: true });
  return { slug, wrote, sources, conflicts: merged.conflicts };
}

/**
 * Throw the refresh away. The live folder was never written, so this is only
 * ever a directory removal — there is nothing to roll back.
 * @returns {Promise<{slug: string, removed: boolean}>}
 */
export async function rejectRefresh({ root, slug }) {
  const shadow = shadowDir(root, slug);
  const removed = await fs.access(shadow).then(() => true, () => false);
  await fs.rm(shadow, { recursive: true, force: true });
  return { slug, removed };
}

/* -------------------------------- CLI ----------------------------------- */

async function main() {
  const slug = arg("race", null);
  if (typeof slug !== "string") {
    console.error("usage: node scripts/race-refresh.mjs --race <slug> [--accept|--reject]");
    process.exit(1);
  }
  if (arg("accept", false) === true) {
    const out = await acceptRefresh({ root: ROOT, slug, onProgress: (e) => note(`• ${e.message}`) });
    note(`accepted: ${out.wrote.join(", ")}`);
    for (const c of out.conflicts) note(`  kept your ${c.path} (the refresh suggested ${JSON.stringify(c.to)})`);
    return;
  }
  if (arg("reject", false) === true) {
    const out = await rejectRefresh({ root: ROOT, slug });
    note(out.removed ? `discarded races/${slug}/${SHADOW}/` : `nothing to discard for ${slug}`);
    return;
  }
  const { diff } = await runRefresh({
    root: ROOT,
    slug,
    onProgress: (e) => {
      if (e.status === "log") note(`  ${e.message}`);
      else if (e.status === "start") note(`• ${e.label ?? e.step}`);
    },
  });
  note("");
  note(`${diff.diff.length} change(s), ${diff.conflicts.length} kept as you authored them`);
  for (const d of diff.diff) {
    note(`  ${d.file} ${d.path} — ${d.kind}: ${JSON.stringify(d.from)} → ${JSON.stringify(d.to)}`);
  }
  note("");
  note(`review races/${slug}/${SHADOW}/diff.json, then --accept or --reject`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
