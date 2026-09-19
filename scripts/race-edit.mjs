// The review dialog's write side: what a human is allowed to change about a
// race folder, and when a draft may become the active race.
//
// Stages 1-3 (race-intake, race-build, race-plan) write a folder nobody asked
// to be trained for. This module is the other half of PRD §8's review gate —
// the narrow, validated door between "the agent said so" and "I checked it".
// Two rules shape everything here:
//
//   1. The door is a WHITELIST, not a blacklist. `applyRaceEdit` accepts the
//      handful of fields the review screen actually renders and refuses every
//      other key by name. A review dialog that could PUT `status`, `slug` or
//      `provenance` would be a second, unaudited path to activation.
//   2. Everything written is stamped `{by: "user"}`. That is not decoration:
//      scripts/race-plan.mjs and scripts/race-build.mjs both read provenance
//      and leave user-owned fields alone, so a hand edit here is what survives
//      a re-intake (PRD §8, "Re-intake").
//
// Pure functions, so `node --test` asks them the same questions the dev
// server's PUT /api/races/:slug and POST /api/races/:slug/status do.

import fs from "node:fs/promises";
import path from "node:path";
import { LOW_CONFIDENCE, matchAidStations, parseGpx } from "./aid-match.mjs";
import { RACE_STATUSES, listRaces, raceDir, loadRaceFolder, validateRaceJson } from "./race-config.mjs";
import { collectUnresolved, draftValidationErrors } from "./race-intake.mjs";

/** Per-station fields the review table renders, and therefore the only ones it
    may write. `gpx_wpt` is here because the mapping UI (PRD §14) is its whole
    reason to exist; `lat`/`lon`/`seg_mi`/`seg_gain_ft` are NOT, because they
    are snapped or measured off the GPX and a hand value would silently outrank
    the course build. */
export const EDITABLE_AID_FIELDS = ["name", "total_mi", "cutoff_h", "crew", "drop_bag", "pacers", "gpx_wpt"];

/** Top-level keys PUT /api/races/:slug accepts. Anything else is refused BY
    NAME so the client gets told which field it invented rather than having it
    silently dropped. */
export const EDITABLE_RACE_KEYS = ["aid_stations", "date", "visual", "unresolved_acknowledged", "block_targets", "unresolved_fills"];

/** Roots `unresolved_fills` will never write, whatever the folder declares.
    The first four are the folder's identity and the server's own bookkeeping;
    `aid_stations` is excluded because the table editor above already owns it
    with per-field validation, and a blanket path write would sneak past that. */
const UNFILLABLE_ROOTS = new Set([
  "schema_version", "slug", "status", "provenance", "sources",
  "unresolved", "unresolved_acknowledged", "aid_stations",
]);

/** The only `visual` sub-key the review screen exposes — the preset picker.
    Per-token `overrides` are tt-yib.16's surface, not this one. */
const EDITABLE_VISUAL_KEYS = ["theme_preset"];

/** One row of block.json's `targets`. */
const BLOCK_TARGET_KEYS = ["wk", "target_dist", "target_elev"];

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isInt = (v) => isNum(v) && Number.isInteger(v);

/** Read `a.b[2].c` out of an object; undefined when the path does not exist.
    Same grammar as the paths collectUnresolved emits. */
export function valueAtPath(obj, pathStr) {
  let cur = obj;
  for (const part of String(pathStr).split(".")) {
    const m = /^([A-Za-z0-9_]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    if (!isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = cur[m[1]];
    for (const idx of m[2].match(/\d+/g) ?? []) cur = cur?.[Number(idx)];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** Write `a.b[2].c`, refusing to invent the containers on the way. Returns
    false when the parent does not exist — a fill is for a hole in a shape that
    is already there, not a way to graft new structure onto race.json. */
function setAtPath(obj, pathStr, value) {
  const parts = String(pathStr).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    const m = /^([A-Za-z0-9_]+)((?:\[\d+\])*)$/.exec(parts[i]);
    if (!m) return false;
    const idxs = (m[2].match(/\d+/g) ?? []).map(Number);
    const last = i === parts.length - 1;
    if (!isObj(cur) && !Array.isArray(cur)) return false;
    if (last && idxs.length === 0) { cur[m[1]] = value; return true; }
    let node = cur[m[1]];
    for (let j = 0; j < idxs.length; j++) {
      if (!Array.isArray(node)) return false;
      if (last && j === idxs.length - 1) { node[idxs[j]] = value; return true; }
      node = node[idxs[j]];
    }
    cur = node;
  }
  return false;
}

/** Remove `a.b.c` from an object; a no-op when the parent is not there. */
function deleteAtPath(obj, pathStr) {
  const parts = String(pathStr).split(".");
  const leaf = parts.pop();
  const m = /^([A-Za-z0-9_]+)$/.exec(leaf ?? "");
  if (!m) return false;
  const parent = parts.length ? valueAtPath(obj, parts.join(".")) : obj;
  if (!isObj(parent) || !(m[1] in parent)) return false;
  delete parent[m[1]];
  return true;
}

/**
 * Shape-check a PUT body. Pure and race-independent except for the station
 * count, which bounds `aid_stations[].index`.
 *
 * Collects every problem rather than stopping at the first: the review screen
 * saves a whole table at once and a one-error-at-a-time save is a slot machine.
 *
 * @param {unknown} body
 * @param {{stationCount?: number, unresolved?: string[]}} ctx
 *   unresolved: the folder's CURRENT unresolved list — `unresolved_fills` may
 *   only name a path that is on it, which is what keeps a free-form path write
 *   from being a way around the whitelist.
 * @returns {{ok: boolean, errors: string[], code: "bad_request"|null}}
 */
export function validateRaceEdit(body, { stationCount = 0, unresolved = [] } = {}) {
  const open = (unresolved ?? []).filter((u) => typeof u === "string");
  const errors = [];
  const bad = (m) => errors.push(m);
  const done = () => ({ ok: errors.length === 0, errors, code: errors.length ? "bad_request" : null });

  if (!isObj(body)) { bad("body must be a JSON object"); return done(); }

  for (const k of Object.keys(body)) {
    if (!EDITABLE_RACE_KEYS.includes(k)) {
      // Named refusal, and the three that matter get a reason: they are the
      // ones a caller would most plausibly think this endpoint owns.
      const why = k === "status" ? " — status changes go through POST /api/races/:slug/status"
        : k === "pointer" || k === "mode" ? " — the active-race pointer moves through POST /api/race/activate"
        : k === "provenance" ? " — provenance is stamped by the server, never sent"
        : "";
      bad(`${k}: not an editable field${why} (editable: ${EDITABLE_RACE_KEYS.join(", ")})`);
    }
  }
  if (Object.keys(body).length === 0) bad("nothing to write — send at least one of " + EDITABLE_RACE_KEYS.join(", "));

  if (body.aid_stations !== undefined) {
    if (!Array.isArray(body.aid_stations)) bad("aid_stations: array of {index, …} edits required");
    else body.aid_stations.forEach((row, i) => {
      const at = `aid_stations[${i}]`;
      if (!isObj(row)) { bad(`${at}: object required`); return; }
      if (!isInt(row.index) || row.index < 0 || row.index >= stationCount) {
        bad(`${at}.index: integer 0..${Math.max(0, stationCount - 1)} required (got ${JSON.stringify(row.index)})`);
      }
      for (const k of Object.keys(row)) {
        if (k !== "index" && !EDITABLE_AID_FIELDS.includes(k)) {
          bad(`${at}.${k}: not an editable aid-station field (editable: ${EDITABLE_AID_FIELDS.join(", ")})`);
        }
      }
      if (row.name !== undefined && !isStr(row.name)) bad(`${at}.name: non-empty string required`);
      if (row.total_mi !== undefined && (!isNum(row.total_mi) || row.total_mi < 0)) {
        bad(`${at}.total_mi: non-negative number required`);
      }
      if (row.cutoff_h !== undefined && row.cutoff_h !== null && (!isNum(row.cutoff_h) || row.cutoff_h <= 0)) {
        bad(`${at}.cutoff_h: positive number or null required`);
      }
      for (const k of ["crew", "drop_bag", "pacers"]) {
        if (row[k] !== undefined && typeof row[k] !== "boolean") bad(`${at}.${k}: boolean required`);
      }
      if (row.gpx_wpt !== undefined && row.gpx_wpt !== null && !isStr(row.gpx_wpt)) {
        bad(`${at}.gpx_wpt: non-empty string or null required`);
      }
    });
  }

  if (body.date !== undefined && body.date !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date)) || Number.isNaN(Date.parse(`${body.date}T00:00:00Z`))) {
      bad(`date must be a YYYY-MM-DD calendar date or null (got ${JSON.stringify(body.date)})`);
    }
  }

  if (body.visual !== undefined) {
    if (!isObj(body.visual)) bad("visual: object required");
    else {
      for (const k of Object.keys(body.visual)) {
        if (!EDITABLE_VISUAL_KEYS.includes(k)) {
          bad(`visual.${k}: not an editable field (editable: ${EDITABLE_VISUAL_KEYS.join(", ")})`);
        }
      }
      if (body.visual.theme_preset !== undefined && !isStr(body.visual.theme_preset)) {
        bad("visual.theme_preset: non-empty string required");
      }
    }
  }

  if (body.unresolved_acknowledged !== undefined && typeof body.unresolved_acknowledged !== "boolean") {
    bad("unresolved_acknowledged: boolean required");
  }

  if (body.unresolved_fills !== undefined) {
    if (!isObj(body.unresolved_fills)) bad("unresolved_fills: object keyed by unresolved field path required");
    else for (const [p, v] of Object.entries(body.unresolved_fills)) {
      if (!open.includes(p)) {
        bad(`unresolved_fills["${p}"]: only a field the folder currently lists as unresolved can be filled this way`);
        continue;
      }
      if (UNFILLABLE_ROOTS.has(p.split(/[.[]/)[0])) {
        bad(`unresolved_fills["${p}"]: ${p.split(/[.[]/)[0]} is never filled through this endpoint`);
        continue;
      }
      if (v !== null && typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        bad(`unresolved_fills["${p}"]: a string, number, boolean or null required — the schema check decides which`);
      }
      if (typeof v === "number" && !Number.isFinite(v)) bad(`unresolved_fills["${p}"]: finite number required`);
    }
  }

  if (body.block_targets !== undefined) {
    if (!Array.isArray(body.block_targets)) bad("block_targets: array of {wk, target_dist, target_elev} required");
    else if (body.block_targets.length === 0) bad("block_targets: non-empty array required — send nothing to leave the block alone");
    else {
      const seen = new Set();
      body.block_targets.forEach((t, i) => {
        const at = `block_targets[${i}]`;
        if (!isObj(t)) { bad(`${at}: object required`); return; }
        for (const k of Object.keys(t)) {
          if (!BLOCK_TARGET_KEYS.includes(k)) bad(`${at}.${k}: not a block target field (expected ${BLOCK_TARGET_KEYS.join(", ")})`);
        }
        if (!isInt(t.wk) || t.wk < 1) bad(`${at}.wk: positive integer required`);
        else if (seen.has(t.wk)) bad(`${at}.wk: week ${t.wk} appears twice`);
        else seen.add(t.wk);
        for (const k of ["target_dist", "target_elev"]) {
          if (!isNum(t[k]) || t[k] < 0) bad(`${at}.${k}: non-negative number required`);
        }
      });
    }
  }

  return done();
}

/**
 * Apply a VALIDATED edit to a race.json, stamping `{by: "user", at}` on every
 * field whose value actually changed. Does not mutate its input.
 *
 * Only changed fields are stamped: re-saving the review screen untouched must
 * not quietly convert the agent's whole draft into user-owned data that the
 * next re-intake refuses to update.
 *
 * @param {object} race
 * @param {object} body a body validateRaceEdit accepted
 * @param {{at?: string}} [opts]
 * @returns {{race: object, written: string[], block_targets: object[]|null}}
 */
export function applyRaceEdit(race, body, { at = new Date().toISOString() } = {}) {
  const next = structuredClone(race);
  next.provenance = isObj(next.provenance) ? { ...next.provenance } : {};
  const written = [];
  const stamp = (field) => { next.provenance[field] = { by: "user", at }; written.push(field); };

  for (const row of body.aid_stations ?? []) {
    const station = next.aid_stations?.[row.index];
    if (!isObj(station)) continue;
    for (const k of EDITABLE_AID_FIELDS) {
      if (!(k in row)) continue;
      if (station[k] === row[k]) continue;
      station[k] = row[k];
      stamp(`aid_stations[${row.index}].${k}`);
    }
  }

  if ("date" in body && next.date !== body.date) {
    next.date = body.date;
    stamp("date");
  }

  if (isObj(body.visual)) {
    next.visual = isObj(next.visual) ? { ...next.visual } : {};
    for (const k of EDITABLE_VISUAL_KEYS) {
      if (!(k in body.visual)) continue;
      if (next.visual[k] === body.visual[k]) continue;
      next.visual[k] = body.visual[k];
      stamp(`visual.${k}`);
    }
  }

  if ("unresolved_acknowledged" in body && next.unresolved_acknowledged !== body.unresolved_acknowledged) {
    next.unresolved_acknowledged = body.unresolved_acknowledged;
    stamp("unresolved_acknowledged");
  }

  for (const [p, v] of Object.entries(body.unresolved_fills ?? {})) {
    if (valueAtPath(next, p) === v) continue;
    if (setAtPath(next, p, v)) stamp(p);
  }

  // block.json now stamps its OWN provenance (applyBlockTargetsEdit, below) —
  // race.provenance["block.targets"] used to carry this instead, but nothing
  // ever read it (race-plan.mjs's planRace and race-merge.mjs's mergeBlock
  // both check a field's owner on the file the field actually lives in), so a
  // hand edit here was recorded and then silently clobbered by the next
  // re-plan. `written` still reports the change for the API response; it is
  // no longer a race.provenance key.
  let blockTargets = null;
  if (Array.isArray(body.block_targets)) {
    blockTargets = body.block_targets.map((t) => ({ wk: t.wk, target_dist: t.target_dist, target_elev: t.target_elev }));
    written.push("block.targets");
  }

  return { race: next, written, block_targets: blockTargets };
}

/**
 * Merge a user's edited week targets into block.json, stamping
 * `block.provenance.targets = {by: "user", at}` on the file that actually
 * holds them. race-plan.mjs's planRace and race-merge.mjs's mergeBlock both
 * read a field's ownership off the file it lives in (the same mechanism
 * mergeFile already uses for race.json), so this stamp is what makes a
 * hand-edited block survive the next re-plan or refresh.
 *
 * Pure — the dev server's PUT /api/races/:slug reads block.json, calls this,
 * and writes the result back; `node --test` asks the same question directly.
 *
 * @param {object} block the parsed block.json (not mutated)
 * @param {{wk: number, target_dist: number, target_elev: number}[]} targets
 *   already-validated rows (see BLOCK_TARGET_KEYS above)
 * @param {{at?: string}} [opts]
 * @returns {object} the block.json to write
 */
export function applyBlockTargetsEdit(block, targets, { at = new Date().toISOString() } = {}) {
  const next = isObj(block) ? { ...block } : {};
  next.targets = targets;
  next.provenance = { ...(isObj(next.provenance) ? next.provenance : {}), targets: { by: "user", at } };
  return next;
}

/**
 * The holes that are still holes after an edit.
 *
 * `collectUnresolved` finds every null; this adds the carry-forward rule the
 * review screen needs — an entry a previous stage flagged stays flagged until
 * the field it names actually has a value. Without the carry, a claim the
 * agent made about a non-null field ("this cutoff came off a blurry scan")
 * would vanish on the first save; without the filter, a field the human just
 * filled would stay red forever.
 *
 * @param {object} race
 * @param {string[]} [prior] the folder's previous unresolved[]
 * @returns {string[]} sorted, de-duplicated field paths
 */
export function recomputeUnresolved(race, prior = []) {
  const carried = (Array.isArray(prior) ? prior : [])
    .filter((p) => typeof p === "string" && p.trim())
    .filter((p) => {
      const v = valueAtPath(race, p);
      return v === undefined || v === null || v === "";
    });
  return collectUnresolved(race, carried);
}

/**
 * The aid stations whose GPX waypoint is still a guess, as unresolved paths.
 *
 * scripts/race-build.mjs applies this rule while it writes; the review screen
 * has to apply it while it READS, because a low-confidence match is exactly
 * what build leaves out of race.json. A station whose `gpx_wpt` the owner or
 * the matcher already wrote is settled; the last station needs none (the
 * finish is the end of the track); everything else below the bar is a row the
 * mapping dropdown exists for.
 *
 * @param {object[]} stations race.aid_stations
 * @param {{gpx_wpt: string|null, confidence: number}[]} matches matchAidStations output
 * @param {string[]} waypointNames every waypoint name in the GPX
 * @returns {string[]}
 */
export function unresolvedFromMatches(stations = [], matches = [], waypointNames = []) {
  const known = new Set(waypointNames);
  const lastIdx = stations.length - 1;
  const out = [];
  stations.forEach((station, i) => {
    if (isStr(station?.gpx_wpt) && known.has(station.gpx_wpt)) return;
    if (!isStr(station?.gpx_wpt) && i === lastIdx) return;
    const m = matches[i];
    if (m && m.gpx_wpt && m.confidence >= LOW_CONFIDENCE) return;
    out.push(`aid_stations[${i}].gpx_wpt`);
  });
  return out;
}

/**
 * Drop the acknowledged holes, so they read as "not known" instead of "null".
 *
 * The schema's way of saying a field is unknown is for the key to be ABSENT:
 * `elevation.min_ft` may be a number or missing, and `null` is neither. A
 * draft is allowed to carry the null because the draft is a work in progress
 * with a list of what is still open; an active race is not. So acknowledging a
 * hole and activating records it the way the schema models it — the key goes,
 * and `unresolved` keeps the memory that it was never established.
 *
 * Only null-valued, acknowledged, currently-unresolved paths are touched, and
 * never a root the folder's identity depends on.
 *
 * @param {object} race
 * @param {string[]} unresolved
 * @returns {{race: object, pruned: string[]}}
 */
export function pruneAcknowledgedNulls(race, unresolved = []) {
  const next = structuredClone(race);
  const pruned = [];
  if (next.unresolved_acknowledged !== true) return { race: next, pruned };
  for (const p of unresolved) {
    if (typeof p !== "string" || UNFILLABLE_ROOTS.has(p.split(/[.[]/)[0])) continue;
    if (valueAtPath(next, p) !== null) continue;
    if (deleteAtPath(next, p)) pruned.push(p);
  }
  return { race: next, pruned };
}

/**
 * May this folder's status become `req.status`?
 *
 * The only transition this bead's dialog performs is draft → active, and it is
 * gated on three things, in the order a human would ask them: is the folder a
 * draft, is its race.json actually valid, and has every unresolved field been
 * either filled or explicitly acknowledged. The single-active invariant
 * (race-config's validateSingleActive) is checked here too, since it is the
 * one rule this transition can break.
 *
 * @param {object} race races/<slug>/race.json
 * @param {unknown} req `{status}`
 * @param {{unresolved?: string[], otherActive?: string[]}} [ctx]
 *   otherActive: slugs OTHER than this one whose race.json says "active".
 * @returns {{ok: boolean, errors: string[], code: "bad_request"|null, status: string|null}}
 */
export function validateStatusTransition(race, req, { unresolved = [], otherActive = [] } = {}) {
  const fail = (msg) => ({ ok: false, errors: Array.isArray(msg) ? msg : [msg], code: "bad_request", status: null });
  if (!isObj(req)) return fail('body must be an object with a "status" key');
  const { status } = req;
  if (!RACE_STATUSES.includes(status)) {
    return fail(`status must be one of ${RACE_STATUSES.join(" | ")} (got ${JSON.stringify(status)})`);
  }
  if (status !== "active") {
    // Archiving is tt-yib.17's action and carries a result.json with it;
    // demoting an active race back to a draft is not a thing anybody asked for.
    return fail(`this endpoint only promotes a draft to "active" (got ${JSON.stringify(status)})`);
  }
  if (!isObj(race)) return fail("race.json is unreadable");
  if (race.status !== "draft") {
    return fail(`only a draft can be activated — races/${race.slug ?? "?"}/race.json says "${race.status}"`);
  }
  if (otherActive.length) {
    return fail(
      `${otherActive.join(", ")} ${otherActive.length > 1 ? "are" : "is"} already active — ` +
      "exactly one folder may carry that status; archive it first",
    );
  }

  // The review gate, in the order a human would ask it: is every hole either
  // filled or consciously accepted…
  const open = (unresolved ?? []).filter((u) => typeof u === "string" && u.trim());
  if (open.length && race.unresolved_acknowledged !== true) {
    return fail([
      `${open.length} unresolved field${open.length > 1 ? "s" : ""} — fill them in or acknowledge each one before activating:`,
      ...open,
    ]);
  }

  // …and is what is left a race the app can actually run on? An active race is
  // read by the training views, the coach prompt and every clock in the app,
  // so it has to satisfy the schema outright — the draft excuses
  // (race-intake's draftValidationErrors) stop applying here. Acknowledged
  // nulls are pruned first, since "not known" is an absent key, not a null.
  const { race: pruned } = pruneAcknowledgedNulls(race, unresolved);
  const { ok, errors } = validateRaceJson({ ...pruned, status });
  if (!ok) return fail([`races/${race.slug ?? "?"}/race.json is not valid as an active race:`, ...errors]);

  return { ok: true, errors: [], code: null, status };
}

/**
 * The OTHER folders that already carry status "active" — the argument
 * validateStatusTransition needs to keep the single-active invariant.
 * @param {{slug: string, race: object|null}[]} races output of listRaces
 * @param {string} slug the folder being activated
 * @returns {string[]}
 */
export function otherActiveSlugs(races, slug) {
  return (races ?? []).filter((r) => r.slug !== slug && r.race?.status === "active").map((r) => r.slug);
}

/**
 * Set the status, stamping who did it, and record the acknowledged holes the
 * way the schema records "not known" (see pruneAcknowledgedNulls). Does not
 * mutate its input.
 */
export function applyStatus(race, status, { at = new Date().toISOString(), unresolved = [] } = {}) {
  const { race: next } = pruneAcknowledgedNulls(race, unresolved);
  next.status = status;
  next.provenance = isObj(next.provenance) ? { ...next.provenance } : {};
  next.provenance.status = { by: "user", at };
  return next;
}

/* ----------------------------- folder read ------------------------------ */

/**
 * Whether block.json's weeks were counted back from a race day that is no
 * longer race.json's date. Editing `date` (applyRaceEdit) never touches or
 * deletes block.json — the athlete's targets, hand-edited or not, are a
 * commitment nobody wants to lose because the date moved by a week — but
 * check-races.mjs and the review dialog both need to be able to SAY the
 * block's calendar no longer lines up, rather than silently showing stale
 * week numbers next to the new date.
 * @param {object|null} block
 * @param {object} race
 * @returns {boolean}
 */
export function isBlockStale(block, race) {
  if (!isObj(block) || typeof block.start_date !== "string" || !Number.isInteger(block.total_weeks)) return false;
  // No confirmed date to compare against at all — a separate problem
  // (race-plan.mjs's planWindow already refuses to plan against it), not a
  // staleness question.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(race?.date))) return false;
  const start = Date.parse(`${block.start_date}T00:00:00Z`);
  const raceDate = Date.parse(`${race.date}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(raceDate)) return false;
  // block.start_date is always a Monday (race-plan.mjs's planWindow); any day
  // within race week total_weeks falls in this same floor-divided bucket.
  const weekOfRaceDate = Math.floor((raceDate - start) / (7 * 86400000)) + 1;
  return weekOfRaceDate !== block.total_weeks;
}

/**
 * Everything the review screen needs about one folder, in one read: the four
 * JSON files, the built course profile, the GPX waypoint list, the matcher's
 * ranked candidates per station, and the merged unresolved list.
 *
 * The match is re-run rather than cached because a low-confidence one is by
 * definition NOT in race.json — build deliberately leaves it out — so the only
 * way to show the dropdown its options is to ask the matcher again. It is a
 * local file parse, not a fetch.
 *
 * @param {string} root repo root
 * @param {string} slug
 * @returns {Promise<object>} the GET /api/races/:slug payload
 */
export async function loadReview(root, slug) {
  const dir = raceDir(root, slug);
  const folder = await loadRaceFolder(root, slug);
  const race = folder.race;

  const readOptional = async (p) => {
    try { return JSON.parse(await fs.readFile(p, "utf8")); }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  };
  const course = await readOptional(path.join(dir, "build", "course.json"));

  let waypoints = [];
  let matches = [];
  let gpxUnresolved = [];
  let gpxText = null;
  try { gpxText = await fs.readFile(path.join(dir, "course.gpx"), "utf8"); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  if (gpxText) {
    const gpx = parseGpx(gpxText);
    waypoints = gpx.waypoints.map((w) => w.name).filter(Boolean);
    if (gpx.track.length) {
      const measuredMi = gpx.track.at(-1).cum_mi;
      const scale = isNum(race.distance_mi) && race.distance_mi > 0 ? measuredMi / race.distance_mi : 1;
      matches = matchAidStations(race.aid_stations ?? [], gpx, { scale });
      gpxUnresolved = unresolvedFromMatches(race.aid_stations ?? [], matches, waypoints);
    }
  }

  const unresolved = [...new Set([
    ...recomputeUnresolved(race, race.unresolved ?? []),
    ...gpxUnresolved,
  ])].sort();
  const { errors: schemaErrors } = draftValidationErrors(race, unresolved);
  const otherActive = otherActiveSlugs(await listRaces(root), slug);

  return {
    slug,
    race,
    block: folder.block,
    // Surfaced distinctly from `block` itself: the review dialog can show
    // the athlete's existing targets AND a "these weeks were planned for a
    // different date" notice, without this module ever touching block.json.
    block_stale: isBlockStale(folder.block, race),
    nutrition: folder.nutrition,
    plan: folder.plan,
    course,
    has_gpx: gpxText !== null,
    waypoints,
    matches,
    unresolved,
    unresolved_acknowledged: race.unresolved_acknowledged === true,
    schema_errors: schemaErrors,
    // Whether "Activate" can light up at all, answered by the same function
    // the POST will use — so the button and the server never disagree.
    activation: validateStatusTransition(race, { status: "active" }, { unresolved, otherActive }),
  };
}
