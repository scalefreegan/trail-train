// Race folders: the single entry point every script and the dev server use to
// answer "which race, and what is in it?".
//
// A race lives in races/<slug>/ (race.json + optional block.json, plan.json,
// nutrition.json — see docs/PRD-modular-races.md §5). config/active-race.json
// is a LOCAL pointer at one of them:
//     { "slug": "..." | null, "mode": "train" | "view" }
// null means generic mode, and that is the only state this module ever
// bootstraps to — a fresh checkout must never silently adopt somebody else's
// race.
//
// The mode is what separates "what am I training for" from "what am I
// looking at" (PRD §4, §7). `train` is the training target and is only legal
// for a folder whose race.json status is "active"; `view` is read-only
// browsing and is how an archived or draft folder gets on screen without the
// coach adopting it. Everything that answers "what is the athlete training
// for" — facts.mjs, the coach prompt, the plan file — goes through
// loadActiveRaceFolder/getTrainingSlug, which require train mode; everything
// that answers "which folder is on screen" goes through resolveViewedRace.

import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./lib.mjs";
// The theme sources are TypeScript and node strips the types on import; the
// same trick scripts/race-plan.mjs already uses for THEME_PRESET_NAMES.
import { visualErrors } from "../web/src/themes/visual.ts";

/** Bump only with a migration; validateRaceJson rejects anything else. */
export const RACE_SCHEMA_VERSION = 1;

/** At most one folder may be "active" — see validateSingleActive. */
export const RACE_STATUSES = ["draft", "active", "archived"];

/** config/active-race.json's `mode` — see the header. */
export const ACTIVE_MODES = ["train", "view"];

/**
 * Who last set a field. "computed" and "matcher" are third parties alongside
 * the human and the intake agent: scripts/race-sun.mjs derives `sun` from the
 * course coordinates, and scripts/race-build.mjs's aid-station matcher picks a
 * station's `gpx_wpt` out of the GPX — neither is a hand edit nor an agent
 * claim, and only "user" is protected from a re-intake merge. They are kept
 * apart because a matcher entry also carries its confidence and method, which
 * a re-match is allowed to overwrite; a computed one has no such gradient.
 */
export const PROVENANCE_BY = ["user", "agent", "computed", "matcher"];

/** Folders whose name starts with "_" are scratch/templates, never races. */
const SKIP_PREFIXES = ["_", "."];

/** IANA zone set, computed once. UTC is added explicitly — it is not in every
    ICU build's supportedValuesOf list but is always a legal zone. */
let TIMEZONES = null;
function timezones() {
  if (!TIMEZONES) TIMEZONES = new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
  return TIMEZONES;
}

/** races/ — absent in a fresh checkout with no race yet. */
export function racesDir(root) {
  return path.join(root, "races");
}

/** races/<slug>/ */
export function raceDir(root, slug) {
  return path.join(root, "races", slug);
}

/** config/active-race.json — gitignored; it is a per-machine choice. */
export function activeRacePointerPath(root) {
  return path.join(root, "config", "active-race.json");
}

// ENOENT is the only absence we tolerate; a truncated or hand-broken file is
// an error the caller must see, never an empty race.
async function readJson(p, { optional = false } = {}) {
  let text;
  try {
    text = await fs.readFile(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT" && optional) return null;
    if (e.code === "ENOENT") throw new Error(`${p} not found`);
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${p} is not valid JSON: ${e.message}`);
  }
}

/**
 * List the race folders under races/, newest-irrelevant, sorted by slug.
 * Returns [] when races/ does not exist. A folder without race.json is not a
 * race and is skipped; a folder whose race.json is unreadable is returned
 * with `race: null` and `error` set so callers can surface it instead of
 * pretending the race vanished.
 * @returns {Promise<{slug: string, dir: string, race: object|null, error: string|null}[]>}
 */
export async function listRaces(root) {
  let entries;
  try {
    entries = await fs.readdir(racesDir(root), { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (SKIP_PREFIXES.some((p) => ent.name.startsWith(p))) continue;
    const dir = raceDir(root, ent.name);
    try {
      const race = await readJson(path.join(dir, "race.json"));
      out.push({ slug: ent.name, dir, race, error: null });
    } catch (e) {
      // no race.json at all = not a race folder; anything else = broken race
      if (/not found$/.test(e.message)) continue;
      out.push({ slug: ent.name, dir, race: null, error: e.message });
    }
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Read the active-race pointer, creating it as { slug: null, mode: "train" }
 * when absent. Never bootstraps to a race: with no pointer the app is in
 * generic mode.
 *
 * A pointer written before modes existed ({ slug } alone) reads as train
 * mode — that is what it meant, and it is the only mode the old writer could
 * produce. A null slug always normalizes to train: "no race" is not something
 * you can be browsing.
 * @returns {Promise<{slug: string|null, mode: "train"|"view"}>}
 */
export async function readActivePointer(root) {
  const p = activeRacePointerPath(root);
  const pointer = await readJson(p, { optional: true });
  if (pointer === null) {
    const fresh = { slug: null, mode: "train" };
    await writeJsonAtomic(p, fresh);
    return fresh;
  }
  if (typeof pointer !== "object" || Array.isArray(pointer) || !("slug" in pointer)) {
    throw new Error(`${p} must be an object with a "slug" key`);
  }
  const { slug, mode = "train" } = pointer;
  if (!ACTIVE_MODES.includes(mode)) {
    throw new Error(`${p}: mode must be one of ${ACTIVE_MODES.join(" | ")} (got ${JSON.stringify(mode)})`);
  }
  if (slug === null) return { slug: null, mode: "train" };
  if (typeof slug !== "string" || !slug.trim()) {
    throw new Error(`${p}: slug must be a non-empty string or null`);
  }
  return { slug, mode };
}

/**
 * The slug the pointer NAMES, whatever the mode — "which folder is the app
 * pointed at?". Callers that mean "which race is the athlete training for"
 * want getTrainingSlug or loadActiveRaceFolder instead.
 * @returns {Promise<string|null>} the pointed-at slug, or null for generic mode
 */
export async function getActiveRace(root) {
  return (await readActivePointer(root)).slug;
}

/**
 * The slug whose folder OWNS the athlete's training — the pointer's slug in
 * train mode, null in view mode. This is the question state.mjs's
 * planBlocksPath asks: a coach run while the athlete is browsing an archived
 * race must write its plan_blocks to config/generic-plan.json, not into the
 * finished race's plan.json.
 *
 * Status is deliberately NOT checked here: a pointer on a folder that is not
 * yet (or no longer) "active" can only be hand-made — setActivePointer
 * refuses it — and for the plan file the pointer is still the better answer
 * than silently splitting a race's plan across two files mid-status-change.
 * loadActiveRaceFolder is where status gates the coach.
 * @returns {Promise<string|null>}
 */
export async function getTrainingSlug(root) {
  const { slug, mode } = await readActivePointer(root);
  return mode === "train" ? slug : null;
}

/**
 * Load one race folder. race.json is required; block.json, plan.json and
 * nutrition.json are optional and come back as null when the folder does not
 * carry them (a draft race has no plan yet).
 * @returns {Promise<{slug: string, dir: string, race: object, block: object|null, plan: object|null, nutrition: object|null}>}
 */
export async function loadRaceFolder(root, slug) {
  return loadRaceFolderAt(raceDir(root, slug), slug);
}

/**
 * The same read, against an explicit directory rather than races/<slug>/.
 *
 * This is the seam a re-intake runs through (scripts/race-refresh.mjs): the
 * three intake stages are pointed at races/<slug>/.refresh/ so they produce a
 * whole second copy of the folder without touching the one the app is reading.
 * `slug` is carried through for the messages only — the directory decides what
 * is read.
 * @returns {Promise<{slug: string, dir: string, race: object, block: object|null, plan: object|null, nutrition: object|null}>}
 */
export async function loadRaceFolderAt(dir, slug) {
  const race = await readJson(path.join(dir, "race.json"));
  const [block, plan, nutrition] = await Promise.all([
    readJson(path.join(dir, "block.json"), { optional: true }),
    readJson(path.join(dir, "plan.json"), { optional: true }),
    readJson(path.join(dir, "nutrition.json"), { optional: true }),
  ]);
  return { slug, dir, race, block, plan, nutrition };
}

/**
 * The payload behind GET /api/race/active: { active: null } in generic mode,
 * otherwise the pointed-at folder merged into one object. Throws if the
 * pointer names a folder that isn't there — a dangling pointer is a bug to
 * surface, not a silent fall back to generic mode.
 */
export async function loadActiveRace(root) {
  const slug = await getActiveRace(root);
  if (!slug) return { active: null };
  const { race, block, plan, nutrition } = await loadRaceFolder(root, slug);
  return { active: slug, race, block, plan, nutrition };
}

/**
 * The TRAINING TARGET's folder, or null when the app is in generic mode.
 *
 * Three things have to agree: the pointer names a folder, it is in train
 * mode, and that folder's race.json carries status "active". A pointer left
 * on a draft, on the race the athlete just finished and archived, or on a
 * folder merely being browsed is generic mode — an archived race must not
 * keep coaching anybody past its finish line.
 * @returns {Promise<{slug, dir, race, block, plan, nutrition}|null>}
 */
export async function loadActiveRaceFolder(root) {
  const { folder, training } = await resolveViewedRace(root);
  return training ? folder : null;
}

/**
 * What the app is LOOKING AT: the pointed-at folder, the mode it is pointed
 * at in, and whether that combination is the training target.
 *
 * This is the read behind GET /api/race/active (scripts/race-payload.mjs) and
 * the one place the pointer's two halves are put together. Throws if the
 * pointer names a folder that isn't there — a dangling pointer is a bug to
 * surface, not a silent fall back to generic mode; the payload catches it and
 * degrades with a warning.
 * @returns {Promise<{slug: string|null, mode: "train"|"view", folder: object|null, training: boolean}>}
 */
export async function resolveViewedRace(root) {
  const { slug, mode } = await readActivePointer(root);
  if (!slug) return { slug: null, mode: "train", folder: null, training: false };
  const folder = await loadRaceFolder(root, slug);
  return { slug, mode, folder, training: mode === "train" && folder.race?.status === "active" };
}

/**
 * Can the pointer be moved to this {slug, mode}? Pure, so the dev server's
 * POST /api/race/activate and `node --test` ask it the same question.
 *
 * `code` tells the endpoint which HTTP status the refusal deserves:
 * "not_found" for a slug with no folder, "bad_request" for everything else
 * (a malformed body, or train mode on a race that is not active).
 * @param {{slug: string|null, mode?: string}} req
 * @param {{slug: string, race: object|null}[]} races output of listRaces
 * @returns {{ok: boolean, errors: string[], code: string|null, pointer: {slug: string|null, mode: string}|null}}
 */
export function validateActivation(req, races) {
  const fail = (code, msg) => ({ ok: false, errors: [msg], code, pointer: null });
  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    return fail("bad_request", "body must be an object with a \"slug\" key");
  }
  const { slug = undefined, mode = "train" } = req;
  if (!ACTIVE_MODES.includes(mode)) {
    return fail("bad_request", `mode must be one of ${ACTIVE_MODES.join(" | ")} (got ${JSON.stringify(mode)})`);
  }
  // Generic mode. The mode field is meaningless without a race, so it is
  // normalized away rather than refused — "no race, view" is a typo, not a
  // request the athlete could have meant differently.
  if (slug === null) return { ok: true, errors: [], code: null, pointer: { slug: null, mode: "train" } };
  if (typeof slug !== "string" || !slug.trim()) {
    return fail("bad_request", "slug: non-empty string or null required");
  }
  const found = races.find((r) => r.slug === slug);
  if (!found) return fail("not_found", `no race folder races/${slug}/`);
  if (!found.race) {
    return fail("bad_request", `races/${slug}/race.json is unreadable${found.error ? ` (${found.error})` : ""}`);
  }
  if (mode === "train" && found.race.status !== "active") {
    // The fix is to activate the FOLDER (its race.json status), which is the
    // archive/activate bead's job — the pointer must not be able to promote a
    // draft behind the schema's back.
    return fail(
      "bad_request",
      `${slug} has status "${found.race.status}" — only an "active" race can be trained for; open it in view mode instead`,
    );
  }
  return { ok: true, errors: [], code: null, pointer: { slug, mode } };
}

/**
 * Move the pointer. Validates against the folders on disk (see
 * validateActivation) and writes atomically; the error it throws carries the
 * validator's `code` so the caller can pick a status.
 * @param {{slug: string|null, mode?: string}} req
 * @returns {Promise<{slug: string|null, mode: string}>} the pointer written
 */
export async function setActivePointer(root, req) {
  const { ok, errors, code, pointer } = validateActivation(req, await listRaces(root));
  if (!ok) throw Object.assign(new Error(errors.join("; ")), { code });
  await writeJsonAtomic(activeRacePointerPath(root), pointer);
  return pointer;
}

/**
 * TODO(tt-yib.5): replaced by goals/generic mode.
 * The active race, or — when no race is active — the most recent one by date.
 * Scripts written before generic mode existed (build-course.mjs, the dev
 * server's /nutrition.json) assume there IS a race; routing them through
 * here keeps them working off the most recent archived race folder. facts.mjs
 * no longer uses it — since tt-yib.3 it is generic mode or nothing.
 * @returns {Promise<{slug, dir, race, block, plan, nutrition}|null>} null when
 *   there are no race folders at all
 */
export async function loadRaceOrMostRecent(root) {
  const slug = await getActiveRace(root);
  if (slug) return loadRaceFolder(root, slug);
  const usable = (await listRaces(root)).filter((r) => r.race);
  if (usable.length === 0) return null;
  // Newest edition first; slug breaks ties so the choice is deterministic.
  usable.sort((a, b) =>
    String(b.race.date ?? "").localeCompare(String(a.race.date ?? "")) || a.slug.localeCompare(b.slug));
  return loadRaceFolder(root, usable[0].slug);
}

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Validate a parsed race.json against the PRD §5.1 schema.
 * Collects every problem rather than throwing on the first — the intake
 * review dialog shows the whole list.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateRaceJson(obj) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!isObj(obj)) return { ok: false, errors: ["race.json must be a JSON object"] };

  if (obj.schema_version !== RACE_SCHEMA_VERSION) {
    bad(`schema_version must be ${RACE_SCHEMA_VERSION} (got ${JSON.stringify(obj.schema_version)})`);
  }
  if (!isStr(obj.slug)) bad("slug: non-empty string required");
  else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(obj.slug)) bad(`slug: "${obj.slug}" must be lowercase kebab-case`);
  if (!RACE_STATUSES.includes(obj.status)) {
    bad(`status must be one of ${RACE_STATUSES.join(" | ")} (got ${JSON.stringify(obj.status)})`);
  }
  if (!isStr(obj.name)) bad("name: non-empty string required");
  if (!isStr(obj.short)) bad("short: non-empty string required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(obj.date)) || Number.isNaN(Date.parse(`${obj.date}T00:00:00Z`))) {
    bad(`date must be a YYYY-MM-DD calendar date (got ${JSON.stringify(obj.date)})`);
  }
  if (!/^\d{2}:\d{2}$/.test(String(obj.start_time))) {
    bad(`start_time must be HH:MM (got ${JSON.stringify(obj.start_time)})`);
  }

  // Timezone is load-bearing: every race-local clock (countdown, night bands,
  // race week, crew ETAs) derives from it, so a typo has to fail here.
  if (!isStr(obj.timezone)) bad("timezone: IANA zone name required (e.g. America/Denver)");
  else if (!timezones().has(obj.timezone)) bad(`timezone: "${obj.timezone}" is not an IANA zone name`);

  if (!isNum(obj.distance_mi) || obj.distance_mi <= 0) bad("distance_mi: positive number required");
  if (!isNum(obj.gain_ft) || obj.gain_ft < 0) bad("gain_ft: non-negative number required");
  if (obj.cutoff_h !== null && (!isNum(obj.cutoff_h) || obj.cutoff_h <= 0)) {
    bad("cutoff_h: positive number or null required");
  }
  if (obj.elevation !== undefined) {
    if (!isObj(obj.elevation)) bad("elevation: object required");
    else {
      for (const k of ["min_ft", "max_ft", "avg_ft"]) {
        if (obj.elevation[k] !== undefined && !isNum(obj.elevation[k])) bad(`elevation.${k}: number required`);
      }
      if (obj.elevation.altitude_significant !== undefined && typeof obj.elevation.altitude_significant !== "boolean") {
        bad("elevation.altitude_significant: boolean required");
      }
      if (isNum(obj.elevation.min_ft) && isNum(obj.elevation.max_ft) && obj.elevation.min_ft > obj.elevation.max_ft) {
        bad("elevation: min_ft is above max_ft");
      }
    }
  }
  if (obj.features !== undefined) {
    if (!isObj(obj.features)) bad("features: object of booleans required");
    else for (const [k, v] of Object.entries(obj.features)) {
      if (typeof v !== "boolean") bad(`features.${k}: boolean required`);
    }
  }
  if (obj.coach_notes !== undefined) {
    if (!isObj(obj.coach_notes)) bad("coach_notes: object of prose strings required");
    else for (const [k, v] of Object.entries(obj.coach_notes)) {
      if (typeof v !== "string") bad(`coach_notes.${k}: string required`);
    }
  }
  // visual: preset, accent, hero, panels and per-token overrides. The rules
  // (and the readability floor on the accent) live in web/src/themes/visual.ts
  // so the intake preview, the theme hook and this write path cannot drift.
  if (obj.visual !== undefined) {
    if (!isObj(obj.visual)) bad("visual: object required");
    else for (const e of visualErrors(obj.visual)) bad(e);
  }
  if (obj.provenance !== undefined) {
    if (!isObj(obj.provenance)) bad("provenance: object keyed by field name required");
    else for (const [k, v] of Object.entries(obj.provenance)) {
      if (!isObj(v)) { bad(`provenance.${k}: object required`); continue; }
      if (!PROVENANCE_BY.includes(v.by)) bad(`provenance.${k}.by must be one of ${PROVENANCE_BY.join(" | ")}`);
    }
  }
  if (obj.sources !== undefined) {
    if (!Array.isArray(obj.sources)) bad("sources: array required");
    else obj.sources.forEach((s, i) => {
      if (!isObj(s)) { bad(`sources[${i}]: object required`); return; }
      if (!["url", "pdf", "gpx"].includes(s.kind)) bad(`sources[${i}].kind must be url | pdf | gpx`);
      if (!isStr(s.ref)) bad(`sources[${i}].ref: non-empty string required`);
    });
  }
  if (obj.race_climbs !== undefined) {
    if (!Array.isArray(obj.race_climbs)) bad("race_climbs: array required");
    else obj.race_climbs.forEach((c, i) => {
      if (!isObj(c)) { bad(`race_climbs[${i}]: object required`); return; }
      if (!isStr(c.id)) bad(`race_climbs[${i}].id: non-empty string required`);
      if (!isStr(c.label)) bad(`race_climbs[${i}].label: non-empty string required`);
      // build-course.mjs scales and snaps this window directly onto the
      // track; a reversed or out-of-range one produced negative length_mi
      // and garbage gain with no error (see build-course.mjs's own guard).
      const [a, b] = Array.isArray(c.approx_mi) ? c.approx_mi : [];
      if (!Array.isArray(c.approx_mi) || c.approx_mi.length !== 2 || !isNum(a) || !isNum(b) || a < 0 || a >= b) {
        bad(`race_climbs[${i}].approx_mi: [start, end] with 0 <= start < end required (got ${JSON.stringify(c.approx_mi)})`);
      }
    });
  }
  // A durable record of what intake couldn't read cleanly (a PDF chart with
  // no renderer available, a GPX that failed to parse) — see race-intake.mjs.
  // Distinct from `unresolved` (fields the schema still needs) because these
  // are readable/not-readable facts about a SOURCE, not a hole in the race.
  if (obj.intake_warnings !== undefined) {
    if (!Array.isArray(obj.intake_warnings) || obj.intake_warnings.some((w) => typeof w !== "string")) {
      bad("intake_warnings: array of strings required");
    }
  }

  validateAidStations(obj.aid_stations, bad);
  return { ok: errors.length === 0, errors };
}

// Aid stations are the course's spine: every projection, cutoff margin and
// crew ETA walks them in order, so a mile or cutoff that goes backwards would
// silently produce negative segments downstream.
function validateAidStations(stations, bad) {
  if (!Array.isArray(stations) || stations.length === 0) {
    bad("aid_stations: non-empty array required");
    return;
  }
  let prevMi = -Infinity;
  let prevCutoff = -Infinity;
  stations.forEach((s, i) => {
    const at = `aid_stations[${i}]`;
    if (!isObj(s)) { bad(`${at}: object required`); return; }
    if (!isStr(s.name)) bad(`${at}.name: non-empty string required`);
    if (!isNum(s.total_mi) || s.total_mi < 0) {
      bad(`${at}.total_mi: non-negative number required`);
    } else {
      if (s.total_mi < prevMi) bad(`${at} (${s.name}): total_mi ${s.total_mi} is behind the previous station's ${prevMi}`);
      prevMi = Math.max(prevMi, s.total_mi);
    }
    if (s.cutoff_h !== undefined && s.cutoff_h !== null) {
      if (!isNum(s.cutoff_h) || s.cutoff_h <= 0) {
        bad(`${at}.cutoff_h: positive number or null required`);
      } else {
        if (s.cutoff_h < prevCutoff) bad(`${at} (${s.name}): cutoff_h ${s.cutoff_h} is earlier than the previous cutoff ${prevCutoff}`);
        prevCutoff = Math.max(prevCutoff, s.cutoff_h);
      }
    }
    for (const k of ["crew", "crew_only", "drop_bag", "pacers", "water_only"]) {
      if (s[k] !== undefined && typeof s[k] !== "boolean") bad(`${at}.${k}: boolean required`);
    }
    if (s.menu !== undefined && !["full", "basic", "backcountry"].includes(s.menu)) {
      bad(`${at}.menu must be full | basic | backcountry`);
    }
  });
}

/**
 * At most one race folder may carry status "active" — two would make the
 * pointer's answer and the folders' answer disagree.
 * @param {{slug: string, race: object|null}[]} races output of listRaces
 * @returns {{ok: boolean, errors: string[], active: string[]}}
 */
export function validateSingleActive(races) {
  const active = races.filter((r) => r.race?.status === "active").map((r) => r.slug);
  const errors = active.length > 1
    ? [`more than one active race: ${active.join(", ")} — exactly one folder may have status "active"`]
    : [];
  return { ok: errors.length === 0, errors, active };
}
