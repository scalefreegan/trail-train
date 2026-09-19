#!/usr/bin/env node
// Intake stage 3: plan ONE race folder (PRD §8 step 5).
//
// Stages 1 and 2 answer "what is this race?" — the aid chart, the GPX snap,
// the course profile. This stage answers "what does the athlete do about it?",
// and every artifact it writes was hand-authored for the MM100:
//
//   block.json      N weekly targets working back from race.json.date
//   nutrition.json  today's shape, keyed to THIS race's drop bags and cutoff
//   race.json       coach_notes (the prose the coach model reads verbatim),
//                   links completion, visual.theme_preset + accent
//
// One headless agent call, JSON only — the same contract discipline as stage 1:
// the agent writes judgement (how hard a week, which gear in which bag, what
// this course actually demands) and NOTHING that a script can derive. The
// block's calendar is ours: `start_date` is the next Monday and `total_weeks`
// is counted off the race date here, so the agent can never plan a block that
// starts in the past or ends after the gun.
//
// Two rules the merge never breaks (PRD §8 re-intake):
//   · a field whose provenance says `by: "user"` is left exactly as authored;
//   · every field this stage does write carries {by: "agent", source: "race-plan"}.
//
// config/active-race.json is never read or written: planning a folder says
// nothing about which race the athlete is training for.
//
// Usage:  node scripts/race-plan.mjs --race <slug> [--dry-run]

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arg, writeJsonAtomic } from "./lib.mjs";
import { loadRaceFolder, loadRaceFolderAt, raceDir } from "./race-config.mjs";
import { runClaudeJson, extractJson, agentModel } from "./agent-run.mjs";
import { loadFactsFromRoot } from "./facts.mjs";
import { loadProfileWithWarnings, normalizePhysiology } from "./profile.mjs";
import { weekdayName } from "./clock.mjs";
import { THEME_PRESET_NAMES } from "../web/src/themes/presets.ts";
import { normalizeNutrition } from "../web/src/race/nutrition-config.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The folder whose hand-authored block and nutrition are the style reference. */
export const STYLE_REFERENCE_SLUG = "mogollon-monster-100-2026";

/** Longest block the intake will lay out. A race 18 months away does not get
    an 80-week plan — it gets the last 24 weeks of one, and the weeks before
    that are generic mode's problem (PRD §6). */
export const MAX_BLOCK_WEEKS = 24;

/** Shortest block worth writing. Below this the "block" is race week plus a
    taper and there is nothing to periodize; the folder still gets its
    nutrition and coach notes. */
export const MIN_BLOCK_WEEKS = 3;

/** A week counts as a deload when it drops to this share of the week before
    or lower. A 2% dip is scheduling noise, not a recovery week. */
export const DELOAD_RATIO = 0.95;

/** Taper ceiling: each of the last two TRAINING weeks (race week is the race
    itself) sits at or below this share of the build's peak week. */
export const TAPER_MAX_OF_PEAK = 0.5;

/** The five coach_notes sections, in the order the coach prompt reads them. */
export const COACH_NOTE_KEYS = ["terrain", "climate", "altitude", "key_demands", "race_week"];

/** Prose the coach receives verbatim; past this it is an essay, not a note. */
export const MAX_COACH_NOTE_CHARS = 1200;

/** The link slots race.json carries (PRD §5.1). */
export const LINK_KEYS = ["site", "manual", "gpx", "tracking", "results", "map"];

/** Stamped on every field this stage writes. */
const PROVENANCE_SOURCE = "race-plan";

/* The plan agent reads at most a handful of local files (the folder, the
   style reference) — it is a judgement call, not a research task, so its
   budget is a fraction of stage 1's. */
const PLAN_MAX_TURNS = 12;
const PLAN_TIMEOUT_SEC = 420;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => (isNum(v) ? v.toLocaleString("en-US") : "?");

/* --------------------------- the block window --------------------------- */

/** Local calendar date as YYYY-MM-DD (never UTC — a block that starts "today"
    must mean the athlete's today, not London's). */
function isoDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Parse YYYY-MM-DD as a LOCAL midnight — `new Date("2027-08-13")` is UTC
    midnight, which is the previous day west of Greenwich. */
function parseIso(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * The first Monday strictly after `from`. "Strictly" is the point: a block
 * whose week 1 is the current week is a block whose week 1 is already half
 * spent, and the acceptance criterion is that it is never in the past.
 * @param {Date} [from]
 * @returns {string} YYYY-MM-DD
 */
export function nextMonday(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  // getDay(): 0 = Sunday. Days until the NEXT Monday, 1..7 (never 0).
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  return isoDate(d);
}

/** Monday of the ISO week containing `iso`. */
function mondayOf(iso) {
  const d = parseIso(iso);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/**
 * The calendar the agent plans inside: where week 1 starts, how many weeks
 * there are, and which week is race week.
 *
 * Counted back from the race, not forward from today: race week must be the
 * LAST week, so when the race is further out than MAX_BLOCK_WEEKS the block
 * starts later than next Monday rather than ending early.
 *
 * @param {object} race race.json
 * @param {{today?: Date, maxWeeks?: number}} [opts]
 * @returns {{start_date: string, total_weeks: number, race_week: number,
 *            race_date: string, truncated: boolean}|null}
 *   null when the race has no usable date (the caller marks "block" unresolved)
 */
export function planWindow(race, { today = new Date(), maxWeeks = MAX_BLOCK_WEEKS } = {}) {
  const date = race?.date;
  // A date the review screen still lists as unresolved (an agent guess, not
  // a confirmed one) counts as no date — a block periodized off it would be
  // confidently wrong in a way nothing downstream can tell apart from real.
  if (Array.isArray(race?.unresolved) && race.unresolved.includes("date")) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
  const firstMonday = mondayOf(nextMonday(today));
  const raceMonday = mondayOf(date);
  // Whole weeks between the two Mondays; +1 because race week is week N.
  const span = Math.floor((raceMonday.getTime() - firstMonday.getTime()) / (7 * 86400000)) + 1;
  if (span < 1) return null; // the race is this week or already run
  const total = Math.min(maxWeeks, span);
  if (total < MIN_BLOCK_WEEKS) return null; // race week plus a taper is not a block
  const start = new Date(raceMonday);
  start.setDate(start.getDate() - 7 * (total - 1));
  return {
    start_date: isoDate(start),
    total_weeks: total,
    race_week: total,
    race_date: date,
    truncated: span > maxWeeks,
  };
}

/**
 * Why `planWindow` came back null, in words a human can act on. The three
 * cases are different problems: a missing date is the intake's to finish, a
 * past date means the folder is history, and a race next week is simply too
 * close to periodize.
 * @param {object} race
 * @param {{today?: Date}} [opts]
 * @returns {string|null} null when a block IS plannable
 */
export function blockUnavailableReason(race, { today = new Date() } = {}) {
  const date = race?.date;
  if (Array.isArray(race?.unresolved) && race.unresolved.includes("date")) {
    return `race.json's date (${JSON.stringify(date ?? null)}) is still listed in unresolved — date unconfirmed, the block's weeks are counted back from race day`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return `race.json has no usable date (${JSON.stringify(date ?? null)}) — the block's weeks are counted back from race day`;
  }
  if (planWindow(race, { today })) return null;
  const raceMonday = mondayOf(date);
  const firstMonday = mondayOf(nextMonday(today));
  const span = Math.floor((raceMonday.getTime() - firstMonday.getTime()) / (7 * 86400000)) + 1;
  if (span < 1) return `race day ${date} is not in the future — this folder is history, not a plan`;
  return `race day ${date} is only ${span} full week${span === 1 ? "" : "s"} out; a block needs at least ${MIN_BLOCK_WEEKS}`;
}

/**
 * The week roles the validator and the prompt both reason about.
 *   race week   the last week — its target IS the race
 *   taper       the two training weeks before it
 *   build       everything earlier
 * Short blocks degrade rather than throw: a 3-week window is race week plus
 * two taper weeks and has no build phase at all.
 * @param {number} totalWeeks
 * @returns {{build: number[], taper: number[], raceWeek: number}}
 */
export function weekRoles(totalWeeks) {
  const raceWeek = totalWeeks;
  const taper = [totalWeeks - 2, totalWeeks - 1].filter((w) => w >= 1);
  const build = [];
  for (let w = 1; w <= totalWeeks - 3; w++) build.push(w);
  return { build, taper, raceWeek };
}

/* ---------------------------- block validation -------------------------- */

/**
 * Split the build phase at its peak week and check the shape a periodized
 * block has: loading cycles (the weeks between deloads) climb to the peak and
 * come back down after it.
 *
 * This is deliberately NOT "every week is bigger than the last" — a block with
 * no down weeks is the thing the deload rule exists to reject. It is the CYCLE
 * peaks that move monotonically, which is what the MM100 block does: 52 → 60 →
 * 62 → 78 up to week 11, then 72 → 68 → 58 → 42 into the taper.
 *
 * @param {{wk: number, target_dist: number}[]} rows build-phase weeks, in order
 * @returns {string[]} errors
 */
function cycleShapeErrors(rows) {
  if (rows.length < 2) return [];
  // A cycle starts at week 1 and at every deload week.
  const cycles = [];
  rows.forEach((row, i) => {
    const isDeload = i > 0 && row.target_dist <= rows[i - 1].target_dist * DELOAD_RATIO;
    if (i === 0 || isDeload) cycles.push({ first: row.wk, peak: row.target_dist, peak_wk: row.wk });
    else {
      const c = cycles[cycles.length - 1];
      if (row.target_dist > c.peak) { c.peak = row.target_dist; c.peak_wk = row.wk; }
    }
  });
  if (cycles.length < 2) return [];
  // The biggest cycle is the block's peak; everything before it climbs,
  // everything after it steps down.
  let top = 0;
  cycles.forEach((c, i) => { if (c.peak > cycles[top].peak) top = i; });
  const errors = [];
  for (let i = 1; i <= top; i++) {
    if (cycles[i].peak < cycles[i - 1].peak) {
      errors.push(
        `block.targets: the build is not monotone — cycle peak wk ${cycles[i].peak_wk} (${cycles[i].peak} mi) ` +
          `is below the earlier wk ${cycles[i - 1].peak_wk} (${cycles[i - 1].peak} mi), and the block still climbs after it`
      );
    }
  }
  for (let i = top + 1; i < cycles.length; i++) {
    if (cycles[i].peak > cycles[i - 1].peak) {
      errors.push(
        `block.targets: the block climbs again after its peak — cycle peak wk ${cycles[i].peak_wk} (${cycles[i].peak} mi) ` +
          `is above wk ${cycles[i - 1].peak_wk} (${cycles[i - 1].peak} mi)`
      );
    }
  }
  return errors;
}

/**
 * Every rule the acceptance criteria put on the weekly targets.
 * @param {unknown} targets the agent's array
 * @param {{total_weeks: number, race: object}} ctx
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateBlockTargets(targets, { total_weeks, race = {} }) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(targets) || targets.length === 0) {
    return { errors: ["block.targets: non-empty array required"], warnings };
  }
  if (targets.length !== total_weeks) {
    errors.push(`block.targets: ${total_weeks} weeks required (the block runs to race week), got ${targets.length}`);
  }
  targets.forEach((t, i) => {
    const at = `block.targets[${i}]`;
    if (!isObj(t)) { errors.push(`${at}: object required`); return; }
    if (t.wk !== i + 1) errors.push(`${at}.wk must be ${i + 1} (weeks are 1..N in order, got ${JSON.stringify(t.wk)})`);
    if (!isNum(t.target_dist) || t.target_dist <= 0) errors.push(`${at}.target_dist: positive number required`);
    if (!isNum(t.target_elev) || t.target_elev < 0) errors.push(`${at}.target_elev: non-negative number required`);
  });
  if (errors.length) return { errors, warnings };

  const { build, taper, raceWeek } = weekRoles(targets.length);
  const at = (wk) => targets[wk - 1];
  const buildRows = build.map(at);

  /* ≥ 1 deload every 3-4 weeks: no four consecutive build weeks may all be
     loading weeks. Checked over the build only — the taper is a deload by
     construction and race week is the race. */
  if (buildRows.length >= 4) {
    const isDeload = buildRows.map((row, i) => i > 0 && row.target_dist <= buildRows[i - 1].target_dist * DELOAD_RATIO);
    for (let i = 0; i + 4 <= buildRows.length; i++) {
      if (!isDeload.slice(i, i + 4).some(Boolean)) {
        errors.push(
          `block.targets: weeks ${buildRows[i].wk}-${buildRows[i + 3].wk} have no deload — ` +
            `at least one week in every four must drop to ${Math.round(DELOAD_RATIO * 100)}% of the week before or lower`
        );
        break; // one message is enough; the agent has to redo the shape anyway
      }
    }
  }

  errors.push(...cycleShapeErrors(buildRows));

  /* Taper: the last two TRAINING weeks come down to half the peak or less,
     and they descend. Race week is exempt — its target is the race. */
  if (buildRows.length && taper.length === 2) {
    const peakDist = Math.max(...buildRows.map((r) => r.target_dist));
    const peakElev = Math.max(...buildRows.map((r) => r.target_elev));
    for (const wk of taper) {
      const row = at(wk);
      if (row.target_dist > peakDist * TAPER_MAX_OF_PEAK) {
        errors.push(
          `block.targets: taper week ${wk} is ${row.target_dist} mi — the last two weeks before race week must be ` +
            `≤ ${Math.round(TAPER_MAX_OF_PEAK * 100)}% of the peak week (${peakDist} mi → ${+(peakDist * TAPER_MAX_OF_PEAK).toFixed(1)} mi)`
        );
      }
      if (row.target_elev > peakElev * TAPER_MAX_OF_PEAK) {
        errors.push(
          `block.targets: taper week ${wk} is ${num(row.target_elev)} ft — the last two weeks before race week must be ` +
            `≤ ${Math.round(TAPER_MAX_OF_PEAK * 100)}% of the peak week (${num(peakElev)} ft)`
        );
      }
    }
    if (at(taper[1]).target_dist > at(taper[0]).target_dist) {
      errors.push(`block.targets: the taper goes back up — week ${taper[1]} (${at(taper[1]).target_dist} mi) is above week ${taper[0]} (${at(taper[0]).target_dist} mi)`);
    }
  }

  /* Race week carries the race. A target well under the race distance means
     the agent planned a training week for race week and the trajectory chart
     will end below the finish line. */
  if (isNum(race.distance_mi) && raceWeek >= 1) {
    const row = at(raceWeek);
    if (row.target_dist < race.distance_mi * 0.9) {
      errors.push(
        `block.targets: race week ${raceWeek} is ${row.target_dist} mi but the race is ${race.distance_mi} mi — ` +
          `race week's target is the race itself`
      );
    }
  }
  return { errors, warnings };
}

/* -------------------------- nutrition validation ------------------------ */

/** HH:MM, the same shape web/src/race/nutrition.ts accepts. */
const isHM = (v) => typeof v === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v);
const hmMinutes = (hm) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };

/** Top-level numbers normalizeNutrition requires to be finite and positive. */
const NUTRITION_POSITIVE = [
  "flask_ml", "flask_carb_g", "flask_sodium_mg", "liquid_carb_rate_g_hr",
  "salt_tab_mg", "sodium_mg_hr", "fluid_ml_hr", "fluid_ml_hr_heat",
  "carb_cap_over_h", "carb_cap_g_hr", "long_carry_h", "preload_over_flask_ml",
];

/** Caffeine fields that must be present and positive — body_kg is NOT one of
    them any more: it lives in config/profile.json's physiology (tt-yib.9). */
const CAFFEINE_POSITIVE = ["gel_mg", "min_spacing_h", "half_life_h", "cola_mg", "band_lo_mg_kg", "band_hi_mg_kg"];

/** Caffeine fields that may legitimately be 0 ("plan it caffeine-free"). */
const CAFFEINE_NON_NEGATIVE = ["gels", "pre_race_mg", "pre_race_before_h", "cola_cups", "tail_h"];

/**
 * Check the generated nutrition.json, first against this stage's own rules and
 * then against the app's real loader.
 *
 * The two are not redundant. `normalizeNutrition` REPAIRS a hand-edited file:
 * a missing key, a zero where a divisor belongs, a malformed heat window all
 * fall back to a built-in default and the page renders. That is the right
 * behaviour for a file the owner edits and exactly the wrong one for agent
 * output — a plan that silently reverts to somebody else's carb ladder looks
 * identical to one the agent got right. So every hole is an error here, and
 * the loader runs afterwards as the backstop: whatever this stage writes must
 * also be something the app will load without repairing.
 *
 * @param {unknown} n
 * @param {object} race race.json (features and the aid chart drive the rules)
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateNutrition(n, race = {}) {
  const errors = [];
  const warnings = [];
  if (!isObj(n)) return { errors: ["nutrition: JSON object required"], warnings };

  for (const k of NUTRITION_POSITIVE) {
    if (!isNum(n[k]) || n[k] <= 0) errors.push(`nutrition.${k}: positive number required`);
  }
  if (!isNum(n.tailwind_flasks) || n.tailwind_flasks < 1) errors.push("nutrition.tailwind_flasks: number ≥ 1 required");
  if (!isNum(n.spare_flasks) || n.spare_flasks < 0 || n.spare_flasks > 8) errors.push("nutrition.spare_flasks: number in [0, 8] required");
  for (const k of ["gel", "bloks"]) {
    const spec = n[k];
    if (!isObj(spec)) { errors.push(`nutrition.${k}: { carb_g, sodium_mg, label } required`); continue; }
    if (!isNum(spec.carb_g) || spec.carb_g <= 0) errors.push(`nutrition.${k}.carb_g: positive number required (it divides the unit count)`);
    if (!isNum(spec.sodium_mg) || spec.sodium_mg < 0) errors.push(`nutrition.${k}.sodium_mg: non-negative number required`);
    if (!isStr(spec.label)) errors.push(`nutrition.${k}.label: non-empty string required`);
  }

  /* phases: the carb ladder. It has to cover the whole race, or the last hours
     of a long day fall off the end of the model. */
  if (!Array.isArray(n.phases) || n.phases.length === 0) {
    errors.push("nutrition.phases: non-empty array required");
  } else {
    n.phases.forEach((p, i) => {
      const at = `nutrition.phases[${i}]`;
      if (!isObj(p)) { errors.push(`${at}: object required`); return; }
      if (!isNum(p.until_h) || p.until_h <= 0) errors.push(`${at}.until_h: positive number required`);
      if (!isNum(p.carb_g_hr) || p.carb_g_hr <= 0) errors.push(`${at}.carb_g_hr: positive number required`);
      if (p.bloks_frac !== undefined && (!isNum(p.bloks_frac) || p.bloks_frac < 0 || p.bloks_frac > 1)) {
        errors.push(`${at}.bloks_frac: number in [0, 1] required`);
      }
      if (p.supplement !== undefined && typeof p.supplement !== "string") errors.push(`${at}.supplement: string required`);
    });
    const last = n.phases[n.phases.length - 1];
    if (isNum(race.cutoff_h) && isNum(last?.until_h) && last.until_h < race.cutoff_h) {
      errors.push(
        `nutrition.phases: the last phase ends at ${last.until_h} h but the cutoff is ${race.cutoff_h} h — ` +
          `the ladder must cover the whole race`
      );
    }
  }

  /* heat_window exists only when the course actually has a heat problem
     (features.heat). Present-but-unused would read as a heat plan on a race
     that has none; absent-when-needed silently drops to the default window. */
  const wantsHeat = race.features?.heat === true;
  if (wantsHeat) {
    const hw = n.heat_window;
    if (!isObj(hw) || !isHM(hw.start) || !isHM(hw.end)) {
      errors.push('nutrition.heat_window: { start, end } as "HH:MM" required — features.heat is true');
    } else if (hmMinutes(hw.start) >= hmMinutes(hw.end)) {
      errors.push("nutrition.heat_window: start must be before end (the window cannot wrap midnight)");
    }
  } else if (n.heat_window !== undefined) {
    errors.push("nutrition.heat_window: this race has features.heat false — omit the window rather than planning around heat it does not have");
  }

  /* drop_bag_gear is keyed by THIS race's bags. "Start" is the vest and is
     always allowed; anything else must be a station that actually takes one,
     or the gear list renders on no card at all. */
  const bagStations = (race.aid_stations ?? []).filter((s) => s?.drop_bag === true).map((s) => s.name);
  const allowed = new Set(["Start", ...bagStations]);
  if (!isObj(n.drop_bag_gear)) {
    errors.push("nutrition.drop_bag_gear: object keyed by station name required (use {} when the race has no drop bags)");
  } else {
    for (const [k, v] of Object.entries(n.drop_bag_gear)) {
      if (!allowed.has(k)) {
        errors.push(
          `nutrition.drop_bag_gear["${k}"]: not a drop-bag station on this course — ` +
            `allowed: ${[...allowed].map((s) => `"${s}"`).join(", ")}`
        );
      }
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
        errors.push(`nutrition.drop_bag_gear["${k}"]: array of strings required`);
      }
    }
    for (const s of bagStations) {
      if (!(s in n.drop_bag_gear)) warnings.push(`nutrition.drop_bag_gear: no gear listed for the drop bag at ${s}`);
    }
  }

  // The app's own loader, as the backstop described above. It is only ever
  // reached when the strict checks above passed, so a rejection here means
  // this validator has a hole rather than the agent having one — say so.
  if (!errors.length && normalizeNutrition(n) === null) {
    errors.push("nutrition: web/src/race/nutrition-config.ts rejected the plan outright — the dashboard would fall back to its built-in defaults");
  }

  /* caffeine: the schedule is placed across the race, so its size has to be a
     function of how long the race is. */
  const caf = n.caffeine;
  if (!isObj(caf)) {
    errors.push("nutrition.caffeine: object required");
  } else {
    if ("body_kg" in caf) {
      errors.push("nutrition.caffeine.body_kg: body mass lives in config/profile.json physiology — do not write it here");
    }
    for (const k of CAFFEINE_POSITIVE) {
      if (!isNum(caf[k]) || caf[k] <= 0) errors.push(`nutrition.caffeine.${k}: positive number required`);
    }
    for (const k of CAFFEINE_NON_NEGATIVE) {
      if (!isNum(caf[k]) || caf[k] < 0) errors.push(`nutrition.caffeine.${k}: non-negative number required`);
    }
    if (isNum(caf.band_lo_mg_kg) && isNum(caf.band_hi_mg_kg) && caf.band_hi_mg_kg <= caf.band_lo_mg_kg) {
      errors.push("nutrition.caffeine: band_hi_mg_kg must be above band_lo_mg_kg");
    }
    // Doses are placed from nightfall to tail_h before the finish, never
    // tighter than min_spacing_h — so the whole race is a hard ceiling on how
    // many can fit, whatever the MM100 file happens to say.
    if (isNum(race.cutoff_h) && isNum(caf.gels) && isNum(caf.min_spacing_h) && caf.min_spacing_h > 0) {
      const fits = Math.floor(race.cutoff_h / caf.min_spacing_h);
      if (caf.gels > fits) {
        errors.push(
          `nutrition.caffeine.gels: ${caf.gels} doses cannot fit a ${race.cutoff_h} h race at ${caf.min_spacing_h} h spacing ` +
            `(at most ${fits}) — scale the caffeine plan to this race`
        );
      }
    }
  }
  return { errors, warnings };
}

/* ---------------------------- output contract --------------------------- */

/** An http(s) URL, or "" for a slot the agent could not fill. */
const isLink = (v) => v === "" || (typeof v === "string" && /^https?:\/\/\S+$/i.test(v));

/**
 * Validate the whole agent reply against the stage-3 contract.
 *
 * @param {unknown} out the parsed agent JSON
 * @param {object} race race.json for this folder
 * @param {{window?: ReturnType<typeof planWindow>, today?: Date}} [opts]
 *   `window` is the block calendar this run planned inside; omitted, it is
 *   recomputed from the race date (tests pin it so they do not drift with the
 *   wall clock).
 * @returns {{ok: boolean, errors: string[], warnings: string[],
 *            window: object|null, unresolved: string[]}}
 */
export function validatePlanOutput(out, race, opts = {}) {
  const errors = [];
  const warnings = [];
  const unresolved = [];
  const window = opts.window !== undefined ? opts.window : planWindow(race, { today: opts.today ?? new Date() });
  if (!isObj(out)) {
    return { ok: false, errors: ["agent output must be a JSON object"], warnings, window, unresolved };
  }

  /* block — skipped entirely when the race has no date to work back from. */
  if (!window) {
    unresolved.push("block");
    warnings.push(`no block planned: ${blockUnavailableReason(race, { today: opts.today ?? new Date() }) ?? "no block calendar was given"}`);
    if (isObj(out.block) && out.block.targets !== undefined) {
      warnings.push("the agent returned block targets for a race with no date — ignored");
    }
  } else if (!isObj(out.block)) {
    errors.push("block: object with a `targets` array required");
  } else {
    const r = validateBlockTargets(out.block.targets, { total_weeks: window.total_weeks, race });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    // start_date and total_weeks are ours; an agent that echoes them wrong is
    // a warning, not an error — they are overwritten either way.
    if (out.block.start_date !== undefined && out.block.start_date !== window.start_date) {
      warnings.push(`block.start_date: the agent said ${JSON.stringify(out.block.start_date)}; the block starts ${window.start_date} (the calendar is not the agent's to set)`);
    }
  }

  /* nutrition */
  if (out.nutrition === undefined) errors.push("nutrition: required by the contract");
  else {
    const r = validateNutrition(out.nutrition, race);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }

  /* coach_notes: the prose the coach model reads verbatim */
  if (!isObj(out.coach_notes)) errors.push("coach_notes: object with the five prose sections required");
  else {
    for (const k of COACH_NOTE_KEYS) {
      const v = out.coach_notes[k];
      if (typeof v !== "string") { errors.push(`coach_notes.${k}: string required (empty string when there is nothing grounded to say)`); continue; }
      if (v.length > MAX_COACH_NOTE_CHARS) {
        errors.push(`coach_notes.${k}: ${v.length} chars — the coach reads these verbatim, keep each ≤ ${MAX_COACH_NOTE_CHARS}`);
      }
      if (!v.trim()) unresolved.push(`coach_notes.${k}`);
    }
    for (const k of Object.keys(out.coach_notes)) {
      if (!COACH_NOTE_KEYS.includes(k)) errors.push(`coach_notes.${k}: not a coach_notes section (${COACH_NOTE_KEYS.join(", ")})`);
    }
  }

  /* links: completion only — every value is a real URL or an honest "" */
  if (out.links !== undefined) {
    if (!isObj(out.links)) errors.push("links: object required");
    else for (const [k, v] of Object.entries(out.links)) {
      if (!LINK_KEYS.includes(k)) errors.push(`links.${k}: not a link slot (${LINK_KEYS.join(", ")})`);
      else if (!isLink(v)) errors.push(`links.${k}: an http(s) URL, or "" when there is none`);
    }
  }

  /* visual: a named preset plus one accent. Anything else is a per-token
     override, and that is the review dialog's job, not the agent's. */
  if (!isObj(out.visual)) errors.push("visual: { theme_preset, accent } required");
  else {
    if (!THEME_PRESET_NAMES.includes(out.visual.theme_preset)) {
      errors.push(`visual.theme_preset must be one of ${THEME_PRESET_NAMES.join(" | ")} (got ${JSON.stringify(out.visual.theme_preset)})`);
    }
    if (out.visual.accent !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(out.visual.accent))) {
      errors.push(`visual.accent must be a #rrggbb hex color (got ${JSON.stringify(out.visual.accent)})`);
    }
  }

  if (out.unresolved !== undefined) {
    if (!Array.isArray(out.unresolved) || out.unresolved.some((u) => typeof u !== "string")) {
      errors.push("unresolved: array of field paths required");
    } else unresolved.push(...out.unresolved);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    window,
    unresolved: [...new Set(unresolved)].sort(),
  };
}

/* ------------------------------- the merge ------------------------------ */

/**
 * True when the owner authored this field and the agent may not touch it
 * (PRD §8 re-intake: `provenance.by == "user"` survives).
 * Checks the exact path and every parent of it, so a user-owned `coach_notes`
 * protects `coach_notes.terrain` too.
 */
function userOwned(race, fieldPath) {
  const parts = String(fieldPath).split(".");
  for (let i = parts.length; i > 0; i--) {
    if (race?.provenance?.[parts.slice(0, i).join(".")]?.by === "user") return true;
  }
  return false;
}

/**
 * Apply the agent's race.json updates onto a COPY of the race, stamping
 * provenance on everything written and leaving user-authored fields alone.
 *
 * `links` is completion, not replacement: a slot that already has a URL keeps
 * it. The organizer's own page is the kind of thing the owner pastes in by
 * hand, and an agent's second-best link must not quietly replace it.
 *
 * @param {object} race race.json (not mutated)
 * @param {object} out the validated agent output
 * @param {{at?: string}} [opts]
 * @returns {{race: object, written: string[], skipped: string[]}}
 */
export function mergeRaceUpdates(race, out, { at = new Date().toISOString() } = {}) {
  const next = structuredClone(race);
  next.provenance = next.provenance ?? {};
  const written = [];
  const skipped = [];
  const stamp = (fieldPath) => {
    next.provenance[fieldPath] = { by: "agent", at, source: PROVENANCE_SOURCE };
    written.push(fieldPath);
  };

  /* coach_notes, section by section — the owner may have rewritten one of the
     five and left the rest to the agent. */
  if (isObj(out.coach_notes)) {
    next.coach_notes = isObj(next.coach_notes) ? { ...next.coach_notes } : {};
    for (const k of COACH_NOTE_KEYS) {
      const v = out.coach_notes[k];
      if (typeof v !== "string") continue;
      const field = `coach_notes.${k}`;
      if (userOwned(next, field)) { skipped.push(field); continue; }
      next.coach_notes[k] = v;
      stamp(field);
    }
  }

  if (isObj(out.links)) {
    next.links = isObj(next.links) ? { ...next.links } : {};
    for (const k of LINK_KEYS) {
      const v = out.links[k];
      if (!isStr(v)) continue;
      const field = `links.${k}`;
      if (userOwned(next, field)) { skipped.push(field); continue; }
      // completion only
      if (isStr(next.links[k])) continue;
      next.links[k] = v;
      stamp(field);
    }
  }

  if (isObj(out.visual)) {
    next.visual = isObj(next.visual) ? { ...next.visual } : {};
    for (const k of ["theme_preset", "accent"]) {
      const v = out.visual[k];
      if (!isStr(v)) continue;
      const field = `visual.${k}`;
      if (userOwned(next, field)) { skipped.push(field); continue; }
      next.visual[k] = v;
      stamp(field);
    }
  }

  // review_notes is agent commentary for the human, same as every other
  // agent-written field here — routed through the same userOwned/stamp
  // machinery rather than assigned directly by the caller, so a reviewer who
  // ever hand-edits it (race-edit.mjs, were it ever added to
  // EDITABLE_RACE_KEYS) has that edit protected the next time this runs.
  if (isStr(out.review_notes)) {
    const field = "review_notes";
    if (userOwned(next, field)) skipped.push(field);
    else { next.review_notes = out.review_notes.trim(); stamp(field); }
  }

  return { race: next, written, skipped };
}

/* -------------------------------- prompt -------------------------------- */

export const PLAN_SYSTEM_PROMPT = `You are the race-planning agent inside Basecamp, a personal ultra-training
dashboard. A race folder already exists: its course, aid chart and cutoffs were read from the
organizer's own sources and snapped to the GPX. Your job is the next question — what the
athlete DOES about this race — and you answer it once, as ONE JSON object.

You write three things, and nothing else:

1. THE BLOCK. Weekly distance and vert targets, week 1 to race week. The calendar is given to
you and is not yours to change: you are told the start date, the number of weeks, and that the
last week is race week. Build it like a coach, not like a spreadsheet:
   · loading cycles of 2-3 weeks, each followed by a deload week that drops to 70-85% of the
     week before it. At least one deload in every four weeks — never four straight loading weeks.
   · the cycle peaks climb to ONE peak week, then step down. Do not climb again after the peak.
   · the last two weeks before race week are a taper: each at or below HALF the peak week's
     distance AND vert, and the second lower than the first.
   · race week's target IS the race — its target_dist is the race distance and target_elev the
     race's gain.
   · the athlete's CURRENT load is the floor you build from, not week 1's target from a textbook.
     Week 1 should be recognizable from what they are running now; a block that opens 60% above
     their last four weeks is an injury, not a plan.
   · vert per mile should climb toward what the course actually asks for.

2. THE NUTRITION PLAN. The same file shape the dashboard already reads, tuned to THIS race:
   · the carb phase ladder must cover the whole race — the last phase's until_h is at or beyond
     the overall cutoff.
   · drop_bag_gear is keyed ONLY by this race's drop-bag stations, plus "Start" (which means the
     vest, not a bag). Put the gear where the course needs it: lights before dark, warmth before
     the night's low point, sun gear before the exposed hours, fresh socks after the wet miles.
   · heat_window belongs in the file ONLY when the race's features say heat is real. Omit it
     otherwise — do not plan around heat a high alpine race does not have.
   · the caffeine plan scales with the race: a 38-hour race carries a different dose count than a
     12-hour one, and the doses cannot be packed tighter than min_spacing_h. Never write body_kg
     — the athlete's mass lives in their profile, not in the race folder.

3. THE RACE NOTES. coach_notes (terrain, climate, altitude, key_demands, race_week) is prose the
coach model receives VERBATIM every week. Write it for a runner training for this course, from
the course data you are given: 2-4 sentences each, specific, no filler, at most 1200 characters
each. An empty string is better than a generic one. Also complete "links" with any official URL
already present in the folder's own data, and suggest one theme preset plus an accent color.

THE PRIME RULE, same as the intake: never invent a fact about the race. Judgement about
TRAINING is what you are for — how hard a week, which gear in which bag, what this course
demands — and that judgement must be grounded in the course metrics and the athlete's current
fitness you are given. If a source does not tell you something, say so in "unresolved" rather
than inventing it.

OUTPUT: respond with ONLY the JSON object — no prose outside it, no markdown fences:

{
  "block": { "targets": [ { "wk": 1, "target_dist": 38, "target_elev": 5800 } ] },
  "nutrition": { /* the full nutrition.json, same keys as the style reference */ },
  "coach_notes": { "terrain": "", "climate": "", "altitude": "", "key_demands": "", "race_week": "" },
  "links": { "site": "", "manual": "", "gpx": "", "tracking": "", "results": "", "map": "" },
  "visual": { "theme_preset": "${THEME_PRESET_NAMES[0]}", "accent": "#rrggbb" },
  "unresolved": ["links.manual"],
  "review_notes": "one paragraph for the human reviewer: how the block is phased, what the drop-bag choices assume, what to double-check"
}`;

/** One line per aid station: the spine the gear and the cutoffs hang off. */
function aidTable(race, course) {
  const stations = race.aid_stations ?? [];
  if (!stations.length) return "  (no aid stations in race.json)";
  const snapped = new Map((course?.aid_stations ?? []).map((a) => [a.name, a]));
  const pad = Math.max(12, ...stations.map((s) => String(s.name).length));
  const head = `  ${"station".padEnd(pad)}  ${"mi".padStart(6)}  ${"cutoff".padStart(7)}  access`;
  const rows = stations.map((s) => {
    const snap = snapped.get(s.name);
    const mi = isNum(snap?.gpx_mi) ? snap.gpx_mi : s.total_mi;
    const cut = isNum(s.cutoff_h) ? `${s.cutoff_h} h` : s.cutoff_clock ? String(s.cutoff_clock) : "—";
    const access = [s.crew && "crew", s.drop_bag && "DROP BAG", s.pacers && "pacers", s.water_only && "water only"]
      .filter(Boolean).join(", ") || "—";
    return `  ${String(s.name).padEnd(pad)}  ${String(isNum(mi) ? mi.toFixed(1) : "?").padStart(6)}  ${cut.padStart(7)}  ${access}`;
  });
  return [head, ...rows].join("\n");
}

/** The course build's metrics, or the reason there are none. */
function courseSection(course) {
  if (!course) {
    return "COURSE METRICS: none — races/<slug>/build/course.json has not been built (intake stage 2).\n" +
      "  Plan from race.json's own distance, gain and elevation figures, and say in review_notes\n" +
      "  that the plan predates the course build.";
  }
  const climbs = (course.race_climbs ?? []).map((c) =>
    `    · ${c.label}: mi ${isNum(c.start_mi) ? c.start_mi.toFixed(1) : "?"}–${isNum(c.end_mi) ? c.end_mi.toFixed(1) : "?"}, ` +
    `${num(c.gain_ft)} ft, ${isNum(c.avg_grade_pct) ? `${c.avg_grade_pct}% avg` : "?"}${isNum(c.max_grade_pct) ? ` / ${c.max_grade_pct}% max` : ""}`);
  const eles = (course.profile ?? []).map((p) => p.ele_ft).filter(isNum);
  return [
    "COURSE METRICS (measured from the GPX by the course build):",
    `  track: ${num(course.distance_mi)} mi, ${num(course.gain_ft)} ft gain` +
      (isNum(course.official_distance_mi) ? ` (official ${num(course.official_distance_mi)} mi / ${num(course.official_gain_ft)} ft)` : ""),
    eles.length ? `  elevation: ${num(Math.min(...eles))}–${num(Math.max(...eles))} ft over ${course.profile.length} profile points` : "",
    course.sun ? `  race-local sun: sunrise ${course.sun.sunrise ?? "—"}, sunset ${course.sun.sunset ?? "—"}` : "",
    climbs.length ? `  named climbs (${climbs.length}):\n${climbs.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

/** What the athlete is actually doing right now. Every part is optional: a
    fresh checkout has no Strava snapshot, and the block still has to be
    plannable from the race and the profile alone. */
function fitnessSection(facts) {
  if (!facts) {
    return "CURRENT FITNESS: no snapshot on disk (web/public/strava.json has not been synced).\n" +
      "  Open week 1 conservatively and say in review_notes that the ramp is unanchored.";
  }
  const l = facts.load ?? {};
  const p = facts.pacing;
  const lines = [
    "CURRENT FITNESS (computed from the Strava snapshot — this is the floor the block builds from):",
    `  last 7 days:  ${num(l.d7_dist_mi)} mi / ${num(l.d7_elev_ft)} ft over ${l.sessions_d7 ?? "?"} sessions`,
    `  last 28 days: ${num(l.d28_dist_mi)} mi / ${num(l.d28_elev_ft)} ft  (weekly average ${isNum(l.d28_dist_mi) ? (l.d28_dist_mi / 4).toFixed(1) : "?"} mi / ${isNum(l.d28_elev_ft) ? num(Math.round(l.d28_elev_ft / 4)) : "?"} ft)`,
    `  acute:chronic ratio: ${l.acr_dist ?? "?"} distance, ${l.acr_elev ?? "?"} vert`,
    l.longest_d7
      ? `  longest run in the last 7 days: ${l.longest_d7.distance_mi} mi / ${num(l.longest_d7.elevation_ft)} ft in ${l.longest_d7.moving_h} h (${l.longest_d7.title})`
      : "  longest run in the last 7 days: none recorded",
  ];
  if (facts.block) {
    lines.push(`  current training block: ${facts.block.mode} mode, week ${facts.block.current_week} of ${facts.block.total_weeks}`);
  }
  if (p) {
    lines.push(
      "  pacing model (fit from this athlete's own runs — use it to sanity-check the hours a week costs):",
      `    ${p.model}`,
      `    base ${p.base_pace_min_per_mi} min/mi · +${p.add_min_per_mi_per_100ft_vert_per_mi} min/mi per 100 ft/mi of vert · ` +
        `+${p.add_min_per_mi_per_10mi_distance} min/mi per 10 mi · ±${p.fit_error_min_per_mi} min/mi (${p.basis})`
    );
  } else {
    lines.push("  pacing model: not enough runs on record to fit one");
  }
  if (facts.recovery) {
    lines.push(`  recovery: HRV ${facts.recovery.hrv_d7 ?? "?"} (28-day ${facts.recovery.hrv_d28 ?? "?"}), RHR drift ${facts.recovery.rhr_drift_bpm ?? "?"} bpm, sleep debt ${facts.recovery.sleep_debt_h ?? "?"} h`);
  }
  return lines.join("\n");
}

/** The MM100 block as a compact table — the agent needs its SHAPE, and 20
    rows of pretty-printed JSON is 200 lines of the prompt for 20 numbers. */
function styleSection(style) {
  if (!style) return "STYLE REFERENCE: none in this checkout.\n";
  const out = [`STYLE REFERENCE — the hand-authored ${style.name} plan. Match its shape and its level of`,
    "specificity; do NOT copy its numbers, its stations or its window.", ""];
  if (style.block) {
    out.push(
      `  block.json: ${style.block.total_weeks} weeks from ${style.block.start_date}`,
      `    ${(style.block.targets ?? []).map((t) => `wk${t.wk} ${t.target_dist}mi/${t.target_elev}ft`).join("  ")}`,
      ""
    );
  }
  if (style.nutrition) {
    out.push("  nutrition.json (every key it carries is a key yours must carry too):", JSON.stringify(style.nutrition, null, 2).split("\n").map((l) => `    ${l}`).join("\n"), "");
  }
  if (style.coach_notes) {
    out.push("  coach_notes, for length and register:");
    for (const k of COACH_NOTE_KEYS) {
      const v = style.coach_notes[k];
      if (typeof v === "string" && v.trim()) out.push(`    ${k}: ${v}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * The per-run prompt. Pure: everything it needs is an argument, so the
 * snapshot test can pin it without a clock, a network or a home directory.
 *
 * @param {object} ctx
 * @param {string} ctx.slug
 * @param {object} ctx.race race.json
 * @param {object|null} ctx.course build/course.json, when stage 2 has run
 * @param {object} ctx.profile config/profile.json (or the example)
 * @param {object|null} ctx.facts computeFacts output, when a snapshot exists
 * @param {ReturnType<typeof planWindow>} ctx.window the block calendar, or null
 * @param {string|null} ctx.blockReason why there is no window, when there is none
 * @param {{name: string, block: object|null, nutrition: object|null, coach_notes: object|null}|null} ctx.style
 * @returns {string}
 */
export function buildPlanPrompt({ slug, race, course = null, profile = {}, facts = null, window = null, blockReason = null, style = null }) {
  // normalized here rather than trusted: buildPlanPrompt is called directly by
  // tests and by the dry run with whatever profile object the caller has, and
  // the caffeine band in the prompt must never quote an out-of-range mass.
  const { physiology } = normalizePhysiology(profile?.physiology);
  const tz = race.timezone ?? null;
  const raceDay = race.date && tz ? `${weekdayName(race.date, tz)} ${race.date}` : (race.date ?? "unknown");
  const feat = Object.entries(race.features ?? {}).filter(([, v]) => v === true).map(([k]) => k);
  const bags = (race.aid_stations ?? []).filter((s) => s?.drop_bag === true).map((s) => s.name);

  const blockSection = window
    ? [
        "THE BLOCK CALENDAR (fixed — counted back from race day, not yours to change):",
        `  week 1 starts Monday ${window.start_date}`,
        `  ${window.total_weeks} weeks total; week ${window.race_week} is RACE WEEK and contains ${window.race_date}`,
        window.truncated
          ? `  the race is further out than ${MAX_BLOCK_WEEKS} weeks, so this is the LAST ${window.total_weeks} weeks of the run-up — open week 1 mid-build, not from scratch`
          : "  week 1 is the athlete's next full week — open it from where they are now",
        `  return exactly ${window.total_weeks} target rows, wk 1..${window.total_weeks}, in order`,
      ].join("\n")
    : [
        `THE BLOCK CALENDAR: there is none. ${blockReason ?? blockUnavailableReason(race) ?? "No block calendar was given"}.`,
        "  Do NOT return a block. Leave it out and name \"block\" in unresolved.",
        "  Everything else below still applies: this folder needs its nutrition plan and its coach notes.",
      ].join("\n");

  return `Plan the training block, the race-day nutrition and the coach notes for ${race.name} (races/${slug}/).

THE RACE (from races/${slug}/race.json — these facts are established; do not re-derive them):
  ${race.name}${race.short ? ` (${race.short})` : ""} · ${race.edition_year ?? "?"} edition · status ${race.status}
  ${raceDay}${race.start_time ? `, gun at ${race.start_time}` : ""}${tz ? ` ${tz}` : ""}
  ${num(race.distance_mi)} mi · ${num(race.gain_ft)} ft gain · ${race.format ?? "?"}${isNum(race.cutoff_h) ? ` · ${race.cutoff_h} h overall cutoff` : " · no posted overall cutoff"}
  ${race.location ?? "location unknown"}
  elevation ${num(race.elevation?.min_ft)}–${num(race.elevation?.max_ft)} ft (avg ${num(race.elevation?.avg_ft)})${race.elevation?.altitude_significant ? " — ALTITUDE IS A REAL DEMAND here" : ""}
  features: ${feat.length ? feat.join(", ") : "none flagged"}
  drop bags at: ${bags.length ? bags.join(", ") : "none — drop_bag_gear carries only \"Start\", or is empty"}
  links already known: ${Object.entries(race.links ?? {}).filter(([, v]) => isStr(v)).map(([k, v]) => `${k}=${v}`).join("  ") || "(none)"}

AID CHART:
${aidTable(race, course)}

${courseSection(course)}

THE ATHLETE:
  ${profile.athlete_name ?? "the athlete"} · ${profile.location ?? "unknown home base"}
  home trails: ${(profile.home_trails ?? []).join(", ") || "not recorded"}
  physiology: ${physiology.body_kg} kg body mass, ${physiology.long_run_ref_mi} mi long-run reference
  (body mass is the athlete's, from their profile — it drives the mg/kg caffeine band and
   belongs nowhere in the race folder)

${fitnessSection(facts)}

${blockSection}

${styleSection(style)}
Return the single JSON object per the contract in your system prompt. Anything you could not
ground in what you were given: leave it out and name it in "unresolved".`;
}

/* --------------------------------- run ---------------------------------- */

/** Read a JSON file, or null when it simply isn't there. */
async function readJsonIfPresent(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * The hand-authored folder the agent is shown as a style reference.
 * @param {string} root
 * @param {string} slug
 * @param {{onWarn?: (msg: string) => void}} [opts] called for anything other
 *   than "the archive just isn't there" — a checkout with no MM100 folder is
 *   the expected, silent case; a folder that IS there but unreadable (a
 *   corrupt race.json, a permissions error) is a real problem the caller
 *   should be able to surface, not something to plan around silently.
 */
async function loadStyleReference(root, slug, { onWarn = () => {} } = {}) {
  if (slug === STYLE_REFERENCE_SLUG) return null; // re-planning the reference itself
  try {
    const { race, block, nutrition } = await loadRaceFolder(root, STYLE_REFERENCE_SLUG);
    if (!block && !nutrition) return null;
    // body_kg is the athlete's, not the race's: strip it — along with the two
    // prose comments, which name it — so the reference cannot teach the agent
    // to write it back into a race folder. The comments are boilerplate this
    // module re-attaches on write anyway.
    const ref = nutrition ? structuredClone(nutrition) : null;
    if (ref) {
      delete ref.comment;
      delete ref.caffeine_comment;
      if (ref.caffeine) delete ref.caffeine.body_kg;
    }
    return { name: race?.name ?? STYLE_REFERENCE_SLUG, block, nutrition: ref, coach_notes: race?.coach_notes ?? null };
  } catch (e) {
    // race-config.mjs's readJson throws a plain Error either way; "not found"
    // (no races/mogollon-monster-100-2026/ at all) is the only case this
    // treats as silent — same message-shape idiom race-refresh.mjs's
    // loadShadowRace and race-config.mjs's own listRaces use.
    if (/not found$/.test(e.message ?? "")) return null;
    onWarn(`style reference (races/${STYLE_REFERENCE_SLUG}/) could not be read, planning without it: ${e.message}`);
    return null;
  }
}

/**
 * The nutrition.json this stage writes: the agent's plan, with the two
 * comment strings the hand-authored file carries so the next human to open it
 * knows what the numbers mean.
 */
function nutritionFile(plan) {
  // the agent's own comment keys are dropped: these two strings are this
  // module's boilerplate and say where body mass now lives
  const { caffeine, comment: _c, caffeine_comment: _cc, ...rest } = plan;
  return {
    comment: "Fueling constants for the fuel/drop-bag cards + planner column, written by the race-intake planner (scripts/race-plan.mjs) and free to edit. Demand-driven fills: base = tailwind_flasks of mix; when a leg's fluid shortfall exceeds preload_over_flask_ml, ONE extra flask takes mix, further spares (up to spare_flasks total) take plain water; smaller shortfalls are drunk at the aid before leaving. bloks_frac = share of a phase's carried units taken as Clif Bloks. drop_bag_gear = non-food items per bag ('Start' = the vest).",
    ...rest,
    caffeine_comment: "Caffeinated-gel schedule. Doses are placed from nightfall to tail_h before the projected finish, never tighter than min_spacing_h, and snapped to aid stations where one is close — so the schedule moves with the goal time. Body mass comes from config/profile.json physiology, not from here. Set gels to 0 to plan the race caffeine-free.",
    caffeine,
  };
}

/**
 * Run stage 3 over races/<slug>/.
 *
 * @param {object} opts
 * @param {string} opts.root repo root
 * @param {string} opts.slug
 * @param {string} [opts.dir] the folder to read and write, when it is not
 *   races/<slug>/ — a re-intake plans into races/<slug>/.refresh/ so the live
 *   block and fuel plan survive until the diff is accepted.
 * @param {(e: {step: string, status: string, label?: string, message?: string, stream?: string}) => void} [opts.onProgress]
 * @param {boolean} [opts.dryRun] assemble the prompt, print nothing to disk
 * @param {Date} [opts.today] injectable clock (the block calendar depends on it)
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.timeoutSec]
 * @param {string} [opts.model]
 * @param {boolean} [opts.allowDateless] plan nutrition and notes for a race
 *   with no date (no block); by default a dateless race is refused before
 *   the agent turn is spent
 * @param {typeof runClaudeJson} [opts.runAgent] the headless spawn. Injectable
 *   for one reason: the write path — three files, the provenance stamps and
 *   the user-field merge — is the part most worth testing, and it is the part
 *   locked behind a paid agent turn. Nothing else overrides it.
 * @returns {Promise<{slug: string, dir: string, prompt: string, dryRun: boolean,
 *   wrote: string[], unresolved: string[], warnings: string[], skipped: string[],
 *   block: object|null, nutrition: object|null, race: object|null, agent: object|null}>}
 */
export async function planRace({
  root,
  slug,
  dir = raceDir(root, slug),
  onProgress = () => {},
  dryRun = false,
  today = new Date(),
  maxTurns = PLAN_MAX_TURNS,
  timeoutSec = PLAN_TIMEOUT_SEC,
  model = agentModel(),
  runAgent = runClaudeJson,
  allowDateless = false,
}) {
  if (!root) throw new Error("planRace: root is required");
  if (!slug) throw new Error("planRace: slug is required");
  const step = (id, status, extra = {}) => onProgress({ step: id, status, ...extra });
  const say = (id, message, extra = {}) => onProgress({ step: id, status: "log", message, ...extra });
  const at = new Date().toISOString();
  const warnings = [];

  /* 1. everything the prompt is made of */
  step("load", "start", { label: "reading the race folder, the profile and the athlete's facts" });
  const folder = await loadRaceFolderAt(dir, slug);
  const race = folder.race;
  const course = await readJsonIfPresent(path.join(dir, "build", "course.json"));
  if (!course) {
    warnings.push(`races/${slug}/build/course.json is not there — planning from race.json alone (run stage 2 first for course metrics)`);
    say("load", warnings[warnings.length - 1], { stream: "err" });
  }
  const { profile, warnings: profileWarnings } = await loadProfileWithWarnings(root);
  for (const w of profileWarnings) {
    warnings.push(w);
    say("load", w, { stream: "err" });
  }
  // Probed rather than caught: loadFactsFromRoot bootstraps state.json and
  // config/goals.json on its way to throwing, and a plan run — least of all a
  // dry run — has no business creating the athlete's files as a side effect.
  let facts = null;
  const snapshot = path.join(root, "web", "public", "strava.json");
  if (await fs.access(snapshot).then(() => true, () => false)) {
    try {
      facts = await loadFactsFromRoot(root);
    } catch (e) {
      warnings.push(`fitness snapshot unreadable (${e.message}) — the block's ramp is unanchored`);
      say("load", warnings[warnings.length - 1], { stream: "err" });
    }
  } else {
    warnings.push("no fitness snapshot (web/public/strava.json — run sync:strava) — the block's ramp is unanchored");
    say("load", warnings[warnings.length - 1], { stream: "err" });
  }
  const style = await loadStyleReference(root, slug, {
    onWarn: (m) => { warnings.push(m); say("load", m, { stream: "err" }); },
  });
  if (race.status === "archived") {
    warnings.push(`races/${slug}/ is archived — planning it rewrites a finished race's block and nutrition`);
    say("load", warnings[warnings.length - 1], { stream: "err" });
  }
  const window = planWindow(race, { today });
  if (!window) {
    warnings.push(`no block will be written: ${blockUnavailableReason(race, { today })}`);
    say("load", warnings[warnings.length - 1], { stream: "err" });
  } else if (window.truncated) {
    say("load", `the race is more than ${MAX_BLOCK_WEEKS} weeks out — planning the last ${window.total_weeks} weeks, from ${window.start_date}`);
  }
  // A dateless race gets nutrition and notes but no block — and the caller
  // paid a full agent turn for half a plan (the tt-yib.14 walk hit exactly
  // this). Refuse up front unless the caller opts in; a dry run costs
  // nothing. An agent-GUESSED date the review screen still lists in
  // `unresolved` counts as no date here too: a block confidently periodized
  // off a date nobody has confirmed is worse than no block, and the whole
  // point of `unresolved` surviving onto race.json (see race-intake.mjs's
  // buildRaceJson) is that callers downstream of intake can ask this
  // question instead of trusting whatever string happens to be in `date`.
  const dateUnresolved = Array.isArray(race.unresolved) && race.unresolved.includes("date");
  const hasConfirmedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(race.date)) &&
    !Number.isNaN(Date.parse(`${race.date}T00:00:00Z`)) && !dateUnresolved;
  if (!hasConfirmedDate && !allowDateless && !dryRun) {
    const msg = race.date && dateUnresolved
      ? `races/${slug}/race.json's date (${race.date}) is still listed in unresolved — confirm it in the review screen first (or pass allowDateless to plan nutrition and notes without a block)`
      : `races/${slug}/race.json has no date — fill it in the review screen first (or pass allowDateless to plan nutrition and notes without a block)`;
    step("load", "error", { message: msg });
    throw new Error(msg);
  }
  step("load", "done", { course: Boolean(course), facts: Boolean(facts), weeks: window?.total_weeks ?? null });

  /* 2. the prompt */
  step("prompt", "start", { label: "assembling the plan prompt" });
  const prompt = buildPlanPrompt({
    slug, race, course, profile, facts, window, style,
    blockReason: window ? null : blockUnavailableReason(race, { today }),
  });
  step("prompt", "done", { chars: prompt.length });

  if (dryRun) {
    say("prompt", prompt);
    return {
      slug, dir, prompt, dryRun: true, wrote: [], unresolved: window ? [] : ["block"],
      warnings, skipped: [], block: null, nutrition: null, race: null, agent: null,
    };
  }

  /* 3. the agent — one call, JSON only */
  step("agent", "start", { label: "planning the block with the coach model" });
  const { text, wrapper, retried } = await runAgent({
    prompt,
    systemPrompt: PLAN_SYSTEM_PROMPT,
    // Read only: the folder is already on disk and everything else it needs is
    // in the prompt. No WebFetch — a plan is judgement, not research.
    allowedTools: ["Read"],
    maxTurns,
    timeoutSec,
    cwd: root,
    model,
    retryNudge: "\n\nIMPORTANT: the previous attempt ran out of tool calls before answering. Do NOT read anything else. Return the JSON object NOW from what you already have, naming anything you could not ground in \"unresolved\".",
    retryMaxTurns: 3,
    onNotice: (m) => { warnings.push(m); say("agent", m, { stream: "err" }); },
  });
  say("agent", `agent finished: ${wrapper.numTurns ?? "?"} turns${wrapper.costUsd != null ? ` · $${wrapper.costUsd.toFixed(4)}` : ""}${retried ? " (after one retry)" : ""}`);

  /* 4. validate */
  step("validate", "start", { label: "validating the plan" });
  // A failed/malformed reply is otherwise discarded with no trace — unlike
  // race-intake.mjs, which parks a failing stage-1 draft under
  // sources/agent-output.json before throwing, a bad stage-3 reply here just
  // threw, and the paid turn's raw text went nowhere a human could read it.
  const parkFailedPlan = async (reason) => {
    const outDir = path.join(dir, "build");
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "plan-agent-output.json"), text ?? "");
    await fs.writeFile(path.join(outDir, "plan-agent-output-error.txt"), `${new Date().toISOString()}\n${reason}\n`);
    return `races/${slug}/build/plan-agent-output.json`;
  };
  let out;
  try {
    out = extractJson(text);
  } catch (e) {
    const where = await parkFailedPlan(e.message);
    step("validate", "error", { message: e.message });
    throw new Error(`plan agent did not return JSON: ${e.message}\n(raw agent output saved to ${where})`);
  }
  const check = validatePlanOutput(out, race, { window });
  warnings.push(...check.warnings);
  for (const w of check.warnings) say("validate", w, { stream: "err" });
  if (!check.ok) {
    const where = await parkFailedPlan(check.errors.join("; "));
    step("validate", "error", { message: check.errors.join("; ") });
    throw new Error(`plan agent output failed the contract:\n  · ${check.errors.join("\n  · ")}\n(raw agent output saved to ${where})`);
  }
  step("validate", "done", { unresolved: check.unresolved.length });

  /* 5. write — block, nutrition, then race.json */
  step("write", "start", { label: "writing the folder" });
  const wrote = [];
  let block = null;
  let nutrition = null;
  // block.json carries its own provenance (stamped by race-edit.mjs's
  // applyBlockTargetsEdit when the review dialog's owner hand-edits a week's
  // numbers). That is the same "by: user survives a re-plan" invariant every
  // other field in this app gets — checked here, not on race.provenance,
  // because block.json is the file whose targets are actually at stake.
  const blockTargetsUserOwned = folder.block?.provenance?.targets?.by === "user";
  // Three independent atomic writes, no rollback across them: a failure on
  // the second or third leaves the ones before it landed for real, and the
  // thrown error says exactly which — "race.json failed to write" alone
  // would leave the caller guessing whether block.json/nutrition.json are
  // now stale beside an untouched race.json or freshly written beside it.
  let merged = null;
  try {
    if (window && blockTargetsUserOwned) {
      block = folder.block;
      const proposed = out.block.targets
        .map((t) => `wk${t.wk} ${t.target_dist}mi/${t.target_elev}ft`)
        .join("  ");
      warnings.push(`races/${slug}/block.json targets are user-owned — kept as authored; the agent proposed: ${proposed}`);
      say("write", warnings[warnings.length - 1], { stream: "err" });
    } else if (window) {
      block = {
        start_date: window.start_date,
        total_weeks: window.total_weeks,
        // WeekTarget in web/src/data.ts is exactly these three keys; anything
        // else the agent attached is review-dialog material, not block data.
        targets: out.block.targets.map((t) => ({ wk: t.wk, target_dist: t.target_dist, target_elev: t.target_elev })),
      };
      await writeJsonAtomic(path.join(dir, "block.json"), block);
      wrote.push(`races/${slug}/block.json`);
      say("write", `races/${slug}/block.json — ${block.total_weeks} weeks from ${block.start_date}`);
    } else {
      say("write", "no block.json — the race has no date", { stream: "err" });
    }

    nutrition = nutritionFile(out.nutrition);
    await writeJsonAtomic(path.join(dir, "nutrition.json"), nutrition);
    wrote.push(`races/${slug}/nutrition.json`);
    say("write", `races/${slug}/nutrition.json — ${Object.keys(nutrition.drop_bag_gear ?? {}).length} drop-bag entries`);

    merged = mergeRaceUpdates(race, out, { at });
    await writeJsonAtomic(path.join(dir, "race.json"), merged.race);
    wrote.push(`races/${slug}/race.json`);
  } catch (e) {
    const msg = `writing races/${slug}/ failed after ${wrote.length ? wrote.join(", ") : "nothing"} landed: ${e.message}`;
    step("write", "error", { message: msg, wrote });
    throw new Error(msg);
  }
  say("write", `races/${slug}/race.json — ${merged.written.length} fields stamped${merged.skipped.length ? `, ${merged.skipped.length} left as the owner authored them` : ""}`);
  for (const f of merged.skipped) say("write", `kept user-authored ${f}`);
  step("write", "done", { files: wrote.length });

  return {
    slug,
    dir,
    prompt,
    dryRun: false,
    wrote,
    unresolved: check.unresolved,
    warnings,
    skipped: merged.skipped,
    block,
    nutrition,
    race: merged.race,
    agent: {
      model,
      num_turns: wrapper.numTurns,
      cost_usd: wrapper.costUsd,
      duration_ms: wrapper.durationMs,
      retried,
    },
  };
}

/* -------------------------------- CLI ----------------------------------- */

async function main() {
  const slug = arg("race", null);
  if (typeof slug !== "string") {
    console.error("usage: node scripts/race-plan.mjs --race <slug> [--dry-run]");
    process.exit(2);
  }
  const dryRun = arg("dry-run", false) === true;
  const allowDateless = arg("allow-dateless", false) === true;
  const result = await planRace({
    root: ROOT,
    slug,
    dryRun,
    allowDateless,
    onProgress: (e) => {
      // In a dry run the prompt IS the output, so it is printed whole below
      // rather than streamed as a log line.
      if (dryRun && e.step === "prompt" && e.status === "log") return;
      if (e.status === "start") console.log(`• ${e.label}`);
      else if (e.message) console.log(`  ${e.message}`);
    },
  });
  if (result.dryRun) {
    console.log("");
    console.log(result.prompt);
    console.log("");
    console.log(`— dry run: ${result.prompt.length} chars, nothing written —`);
    for (const w of result.warnings) console.log(`  ⚠ ${w}`);
    return;
  }
  console.log("");
  for (const f of result.wrote) console.log(`✓ ${f}`);
  if (result.unresolved.length) console.log(`  unresolved (${result.unresolved.length}): ${result.unresolved.join(", ")}`);
  for (const w of result.warnings) console.log(`  ⚠ ${w}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error(`✗ ${e.message || e}`);
    process.exit(1);
  });
}
