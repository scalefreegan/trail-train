// Race folders: the single entry point every script and the dev server use to
// answer "which race, and what is in it?".
//
// A race lives in races/<slug>/ (race.json + optional block.json, plan.json,
// nutrition.json — see docs/PRD-modular-races.md §5). config/active-race.json
// is a LOCAL pointer at one of them: { "slug": "..." | null }. null means
// generic mode, and that is the only state this module ever bootstraps to —
// a fresh checkout must never silently adopt somebody else's race.

import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./lib.mjs";

/** Bump only with a migration; validateRaceJson rejects anything else. */
export const RACE_SCHEMA_VERSION = 1;

/** At most one folder may be "active" — see validateSingleActive. */
export const RACE_STATUSES = ["draft", "active", "archived"];

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
 * Read the active-race pointer, creating it as { "slug": null } when absent.
 * Never bootstraps to a race: with no pointer the app is in generic mode.
 * @returns {Promise<string|null>} the active slug, or null for generic mode
 */
export async function getActiveRace(root) {
  const p = activeRacePointerPath(root);
  const pointer = await readJson(p, { optional: true });
  if (pointer === null) {
    await writeJsonAtomic(p, { slug: null });
    return null;
  }
  if (typeof pointer !== "object" || Array.isArray(pointer) || !("slug" in pointer)) {
    throw new Error(`${p} must be an object with a "slug" key`);
  }
  const { slug } = pointer;
  if (slug === null) return null;
  if (typeof slug !== "string" || !slug.trim()) {
    throw new Error(`${p}: slug must be a non-empty string or null`);
  }
  return slug;
}

/**
 * Load one race folder. race.json is required; block.json, plan.json and
 * nutrition.json are optional and come back as null when the folder does not
 * carry them (a draft race has no plan yet).
 * @returns {Promise<{slug: string, dir: string, race: object, block: object|null, plan: object|null, nutrition: object|null}>}
 */
export async function loadRaceFolder(root, slug) {
  const dir = raceDir(root, slug);
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
  if (obj.visual !== undefined && !isObj(obj.visual)) bad("visual: object required");
  if (obj.provenance !== undefined) {
    if (!isObj(obj.provenance)) bad("provenance: object keyed by field name required");
    else for (const [k, v] of Object.entries(obj.provenance)) {
      if (!isObj(v)) { bad(`provenance.${k}: object required`); continue; }
      if (v.by !== "user" && v.by !== "agent") bad(`provenance.${k}.by must be "user" or "agent"`);
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
