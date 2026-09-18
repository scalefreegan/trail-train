// Persistent agentic state for Trail Almanac.
//
// One JSON file at web/public/state.json holds what is true about the ATHLETE
// and survives across syncs, server restarts and races:
//   - agent's persistent notes (observations the coach has made and wants
//     to remember between sessions)
//   - athlete-set preferences (training philosophy, coach context)
//
// What is true about a RACE does not live here (v3, PRD §5.5): race meta,
// block targets and the agent's plan_blocks moved into races/<slug>/ as
// race.json, block.json and plan.json — see scripts/race-config.mjs. In
// generic mode (no active race) the plan lands in config/generic-plan.json.
//
// On first run, bootstrapped from DEFAULT_STATE. The coach reads this,
// passes it to the agent as context, and MERGES the agent's response back
// (plan blocks + new notes) — the agent never overwrites the whole file,
// which prevents accidental data loss if it returns malformed output.

import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./lib.mjs";
import { RACE_SCHEMA_VERSION, getActiveRace, raceDir } from "./race-config.mjs";

export const STATE_VERSION = 3;

/** Written beside state.json before the v2→v3 split, once and never again —
    it is the only copy of race/block/plan_blocks if the split goes wrong. */
export const STATE_BACKUP_NAME = "state.v2.backup.json";

// Calendar/childcare semantics live in
// preferences.context.sections.calendar_conventions — athlete-voice prose in
// the athlete's own state.json. Both coach prompts point the agent at that
// section, so editing it in the settings dialog is what changes agent
// behavior; there is no other copy.
//
// The DEFAULT is empty (tt-yib.5): one athlete's family markers are not a
// sensible starting point for anybody else, so a fresh state.json starts this
// section blank and the settings dialog invites the athlete to fill it in.
export const DEFAULT_CALENDAR_CONVENTIONS = "";

// The prose this constant used to hold. Kept ONLY so the v1→v2 migration —
// which is where this section is created, for a file that predates coach
// context — still moves it into the athlete's own state.json. It is never
// written over a section the file already carries (the spread below wins) and
// never reaches a freshly bootstrapped file, which starts blank. Nothing else
// in the app reads it.
const LEGACY_CALENDAR_CONVENTIONS = `All-day marker events on the family calendars flag childcare days: "Em" / "M" / "Emerson" = Em is away and I have SOLO kid duty; "H" markers ("H no school", "Pick up H") = Hawthorne is home and needs coverage. Severity depends on the day of week. WEEKDAY (Mon-Fri) childcare days: I can still train during work hours (~08:00-16:00) — plan them as near-normal training days and note the window. WEEKEND childcare days are the genuinely hard ones, worst when an "Em" marker covers a weekend (solo duty, no daycare backup): default those to rest or a short pre-dawn run (start ~05:30, done by 08:00), and plan the week's long runs to AVOID Em weekends entirely — use a clear weekend day or a weekday daytime window, naming the swap. Saturday "Hawthorn soccer" (09:00) caps any Saturday session: finished and home by 08:30.`;

// Defaults used to bootstrap a fresh state.json. Editable in the file once
// it's been created — the file becomes the source of truth.
export const DEFAULT_STATE = {
  version: STATE_VERSION,
  last_updated: null,
  // Agent-managed: a running list of observations the coach has made and
  // wants to remember (e.g. "heat block needs to start by wk 10").
  // Capped at 30 most recent on save.
  agent_notes: [],
  // Athlete-set, edited in the dashboard's coach settings dialog (gear icon
  // in the coach rail). The agent reads these but can only APPEND temporary
  // context items via new_context_items (see mergeAgentUpdate).
  preferences: {
    training_philosophy: "polarized — easy aerobic + occasional hard, minimize tempo",
    weekly_rest_day: "Mon",
    nutrition_target_kcal_per_hour: 300,
    heat_threshold_c: 24,
    // Free-form coach context. sections go to the agent verbatim;
    // temporary items are dated constraints the agent respects until their
    // expires date (expired items are filtered out of the agent's facts but
    // stay in the file until deleted in the dialog).
    context: {
      sections: {
        about_me: "",
        calendar_conventions: DEFAULT_CALENDAR_CONVENTIONS,
        training_preferences: "",
      },
      temporary: [],
    },
  },
};

function statePath(projectRoot) {
  return path.join(projectRoot, "web", "public", "state.json");
}

/* ---------------------- coach context helpers ---------------------- */

const EMPTY_SECTIONS = { about_me: "", calendar_conventions: "", training_preferences: "" };

// Agent-sourced temporary items are capped so a chatty agent can't grow the
// context without bound; user items are only ever removed in the dialog.
const AGENT_CONTEXT_CAP = 20;

// Local calendar date, not UTC — expiry is "through the end of that day
// where the athlete lives", so every today/added/expires computation must
// use the same local clock (a UTC date is tomorrow from ~17:00 MT onward).
export function isoDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Round-trip check: rejects rollover dates like "2026-02-30" that
// Date.parse's legacy parser quietly accepts as Mar 1.
export function isValidIsoDate(s) {
  if (typeof s !== "string" || !ISO_DATE_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00`);
  return !Number.isNaN(d.getTime()) && isoDate(d) === s;
}

function plusDays(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

export function newContextId() {
  return `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Project preferences for the agent: same object, but context.temporary
 * filtered to items still in force (expires >= today, inclusive — an item
 * stays active through the end of its expires day). An item whose expires
 * is missing or malformed (hand-edit) counts as ACTIVE, matching how the
 * dialog renders it — better the agent sees a stale constraint than
 * silently never sees one the UI shows as live. Tolerates a missing or
 * partial context.
 */
export function activeContext(preferences, todayIso) {
  const prefs = preferences ?? {};
  const ctx = prefs.context ?? {};
  return {
    ...prefs,
    context: {
      sections: { ...EMPTY_SECTIONS, ...(ctx.sections ?? {}) },
      temporary: (Array.isArray(ctx.temporary) ? ctx.temporary : [])
        .filter((t) => !isValidIsoDate(t?.expires) || t.expires >= todayIso),
    },
  };
}

/**
 * Append agent-proposed context items ({text, expires}) to
 * preferences.context.temporary as source:"agent" entries. Shared by the
 * readout merge (new_context_items) and the chat sentinel path so both
 * validate identically: text required (≤500 chars), expires must be a real
 * YYYY-MM-DD date else defaults to today+30d. Returns the next state plus
 * the entries actually added (for surfacing to the user).
 */
export function appendContextItems(state, items, todayIso = isoDate(new Date())) {
  const added = [];
  const dropped = [];
  if (!Array.isArray(items) || items.length === 0) return { state, added, dropped };
  const prefs = state.preferences ?? {};
  const ctx = prefs.context ?? {};
  let temporary = Array.isArray(ctx.temporary) ? [...ctx.temporary] : [];
  for (const item of items) {
    const text = typeof item?.text === "string" ? item.text.trim().slice(0, 500) : "";
    if (!text) {
      dropped.push(item);
      console.warn(`• context item rejected (empty/non-string text): ${JSON.stringify(item).slice(0, 120)}`);
      continue;
    }
    const expires = isValidIsoDate(item?.expires) ? item.expires : plusDays(todayIso, 30);
    const entry = { id: newContextId(), text, added: todayIso, expires, source: "agent" };
    temporary.push(entry);
    added.push(entry);
  }
  if (added.length === 0) return { state, added, dropped };
  const agentItems = temporary.filter((t) => t.source === "agent");
  if (agentItems.length > AGENT_CONTEXT_CAP) {
    const keep = new Set(
      [...agentItems]
        .sort((a, b) => (a.added === b.added ? 0 : a.added < b.added ? 1 : -1))
        .slice(0, AGENT_CONTEXT_CAP)
        .map((t) => t.id),
    );
    for (const t of temporary) {
      if (t.source === "agent" && !keep.has(t.id)) {
        console.warn(`• context cap (${AGENT_CONTEXT_CAP} agent items): evicted "${t.text.slice(0, 60)}" (expires ${t.expires})`);
      }
    }
    temporary = temporary.filter((t) => t.source !== "agent" || keep.has(t.id));
  }
  return {
    state: {
      ...state,
      preferences: {
        ...prefs,
        context: { sections: { ...EMPTY_SECTIONS, ...(ctx.sections ?? {}) }, temporary },
      },
    },
    added,
    dropped,
  };
}

// Per-append and per-section caps for agent section appends. The section
// total matches the settings dialog / PUT edit limit — an append must never
// push a section past what the dialog can save back.
const SECTION_APPEND_MAX = 1000;
const SECTION_TOTAL_MAX = 4000;

/**
 * Append agent-authored paragraphs to the free-text context sections.
 * APPEND-ONLY by design: the agent can add a paragraph but can never edit
 * or remove athlete-written prose. Invalid appends (unknown section, empty
 * or oversized text, section already at capacity) are dropped with a warn
 * and reported via `dropped` so the chat UI can surface them.
 */
export function appendSectionText(state, appends) {
  const added = [];
  const dropped = [];
  if (!Array.isArray(appends) || appends.length === 0) return { state, added, dropped };
  const prefs = state.preferences ?? {};
  const ctx = prefs.context ?? {};
  const sections = { ...EMPTY_SECTIONS, ...(ctx.sections ?? {}) };
  for (const a of appends) {
    const section = a?.section;
    const text = typeof a?.text === "string" ? a.text.trim() : "";
    // typeof guard matters: Object.hasOwn coerces property keys, so
    // ["about_me"] would pass it and then leak a non-string into `added`
    if (typeof section !== "string" || !Object.hasOwn(EMPTY_SECTIONS, section)) {
      dropped.push({ ...a, reason: "unknown section" });
      console.warn(`• section append rejected (unknown section): ${JSON.stringify(a).slice(0, 120)}`);
      continue;
    }
    if (!text || text.length > SECTION_APPEND_MAX) {
      dropped.push({ ...a, reason: "empty or over " + SECTION_APPEND_MAX + " chars" });
      console.warn(`• section append rejected (empty/oversized text) for ${section}`);
      continue;
    }
    const next = sections[section] ? `${sections[section]}\n\n${text}` : text;
    if (next.length > SECTION_TOTAL_MAX) {
      dropped.push({ ...a, reason: "section full" });
      console.warn(`• section append rejected: ${section} would exceed ${SECTION_TOTAL_MAX} chars — trim it in the settings dialog`);
      continue;
    }
    sections[section] = next;
    added.push({ section, text });
  }
  if (added.length === 0) return { state, added, dropped };
  return {
    state: {
      ...state,
      preferences: {
        ...prefs,
        context: { sections, temporary: Array.isArray(ctx.temporary) ? [...ctx.temporary] : [] },
      },
    },
    added,
    dropped,
  };
}

// Matches "Jun 29 - Jul 8, 2026" / "March 3-9, 2027" style ranges inside a
// prose constraint; the range END becomes the migrated item's expires date.
const DATE_RANGE_RE =
  /([A-Z][a-z]{2,8})\.?\s+(\d{1,2})\s*[-–]\s*(?:([A-Z][a-z]{2,8})\.?\s+)?(\d{1,2}),?\s*(\d{4})/;

/**
 * v1 → v2: preferences.personal_constraints (prose strings) becomes
 * preferences.context. Each constraint routes to:
 *   - a temporary item when it contains a parseable date range (expires =
 *     range end — possibly already past, in which case the agent stops
 *     seeing it but it stays visible in the dialog until deleted),
 *   - the calendar_conventions section when it reads calendar-shaped,
 *   - the training_preferences section otherwise.
 * calendar_conventions is seeded with LEGACY_CALENDAR_CONVENTIONS (the prose
 * this migration removes from the system prompts). Idempotent: keyed off
 * version < 2 in loadState.
 */
export function migrateToV2(state) {
  const prefs = { ...(state.preferences ?? {}) };
  // tolerate a hand-edited scalar; v1 docs called this "plain-English rules"
  const rawConstraints = prefs.personal_constraints;
  const constraints = Array.isArray(rawConstraints)
    ? rawConstraints
    : typeof rawConstraints === "string" && rawConstraints.trim()
      ? [rawConstraints]
      : [];
  if (rawConstraints !== undefined && !Array.isArray(rawConstraints) && constraints.length === 0) {
    console.warn(`• migration: personal_constraints had unexpected shape, dropping: ${JSON.stringify(rawConstraints).slice(0, 200)}`);
  }
  const sections = {
    ...EMPTY_SECTIONS,
    calendar_conventions: LEGACY_CALENDAR_CONVENTIONS,
    ...(prefs.context?.sections ?? {}),
  };
  const temporary = Array.isArray(prefs.context?.temporary) ? [...prefs.context.temporary] : [];
  const todayIso = isoDate(new Date());
  const appendTo = (key, text) => {
    sections[key] = sections[key] ? `${sections[key]}\n\n${text}` : text;
  };
  for (const raw of constraints) {
    if (typeof raw !== "string" || !raw.trim()) {
      console.warn(`• migration: dropping non-string constraint: ${JSON.stringify(raw).slice(0, 200)}`);
      continue;
    }
    const text = raw.trim();
    const m = text.match(DATE_RANGE_RE);
    if (m) {
      const end = new Date(`${m[3] ?? m[1]} ${m[4]}, ${m[5]}`);
      if (!Number.isNaN(end.getTime())) {
        temporary.push({ id: newContextId(), text, added: todayIso, expires: isoDate(end), source: "user" });
        console.log(`• migration: "${text.slice(0, 50)}…" → temporary (expires ${isoDate(end)})`);
        continue;
      }
    }
    const dest = /childcare|calendar|marker|soccer/i.test(text) ? "calendar_conventions" : "training_preferences";
    appendTo(dest, text);
    console.log(`• migration: "${text.slice(0, 50)}…" → ${dest}`);
  }
  delete prefs.personal_constraints;
  prefs.context = { sections, temporary };
  // Pinned to 2, not STATE_VERSION: a v1 file has to pass through the v3
  // split too, and claiming the current version here would skip it.
  return { ...state, version: 2, preferences: prefs };
}

/**
 * Load state.json from web/public/, bootstrapping it from DEFAULT_STATE
 * the first time. Always returns a valid state object.
 */
/* ------------------------- v2 → v3 split ------------------------- */

/** races/<slug> for a legacy state.race: "<name>-<race year>", kebab-cased. */
function legacyRaceSlug(race) {
  const name = String(race?.name ?? "race")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const year = /^\d{4}/.exec(String(race?.date ?? ""))?.[0];
  return year ? `${name}-${year}` : name;
}

/**
 * Best-effort race.json from a v2 state.race. The v2 shape carries less than
 * the folder schema wants (no timezone, no per-station detail), so the gaps
 * are filled from the machine's zone and flagged in provenance for the user
 * to correct — a migrated race is a starting point, not an intake result.
 * The real race folder was written by hand in tt-yib.2; this path exists for
 * any other v2 file (a clone, a restored backup, a test fixture).
 */
function raceJsonFromLegacy(race, slug, todayIso) {
  const aid = Array.isArray(race.aid_stations) ? race.aid_stations : [];
  const at = new Date().toISOString();
  const source = "state.json v2→v3 migration";
  return {
    schema_version: RACE_SCHEMA_VERSION,
    slug,
    // A race already run is history; one still ahead is the live one.
    status: String(race.date ?? "") < todayIso ? "archived" : "active",
    name: race.name ?? "Race",
    short: race.short ?? String(race.name ?? "Race").slice(0, 8),
    date: race.date ?? todayIso,
    start_time: race.start_time ?? "06:00",
    // v2 had no timezone. The machine's zone is the best guess available and
    // is almost always right for a race the athlete actually travelled to.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    location: race.location ?? "",
    distance_mi: race.distance_mi ?? 0,
    gain_ft: race.elevation_ft ?? 0,
    elevation: race.max_elev_ft != null ? { max_ft: race.max_elev_ft } : undefined,
    cutoff_h: race.cutoff_h ?? null,
    aid_stations: aid.map((a) => ({ name: a.name, total_mi: a.mi ?? a.total_mi ?? 0 })),
    coach_notes: race.notes ? { terrain: race.notes } : undefined,
    provenance: {
      timezone: { by: "agent", at, source: `${source} — guessed from the machine's zone, CHECK IT` },
      aid_stations: { by: "agent", at, source: `${source} — miles only; the official chart has more` },
      status: { by: "agent", at, source },
    },
  };
}

// Never clobber a folder that already carries the file: the hand-authored
// race.json is richer than anything this migration can synthesize.
async function writeIfAbsent(p, data) {
  try {
    await fs.access(p);
    console.log(`• ${p} already exists — keeping it`);
    return false;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await writeJsonAtomic(p, data);
  console.log(`• wrote ${p}`);
  return true;
}

/**
 * v2 → v3: race, block and plan_blocks leave state.json for races/<slug>/
 * (PRD §5.5). Writes web/public/state.v2.backup.json FIRST and REFUSES to
 * migrate if that backup cannot be written — the v2 file is the only copy of
 * what is being moved. Idempotent: loadState only calls it while the file
 * still carries a v2 marker, the backup is created with "wx" so a second run
 * cannot overwrite the first, and an existing folder file is never replaced.
 * @returns {Promise<object>} the v3 state (race/block/plan_blocks removed)
 */
export async function migrateToV3(projectRoot, state) {
  const backupPath = path.join(projectRoot, "web", "public", STATE_BACKUP_NAME);
  try {
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, JSON.stringify(state, null, 2) + "\n", { flag: "wx" });
    console.log(`• backed up the v2 state to ${backupPath}`);
  } catch (e) {
    // EEXIST is the good case — a previous run already backed the v2 file up,
    // and that first copy is the one worth keeping. Anything else (no space,
    // read-only mount, a DIRECTORY sitting on the path) means there is no
    // backup, so the split must not happen.
    const existing = e.code === "EEXIST" ? await fs.stat(backupPath).catch(() => null) : null;
    if (!existing?.isFile()) {
      throw new Error(
        `refusing to split state.json to v3: cannot write the backup at ${backupPath} ` +
          `(${e.code === "EEXIST" ? "the path exists but is not a file" : e.message}). ` +
          "Nothing has been changed — fix it and re-run.",
      );
    }
    console.log(`• ${STATE_BACKUP_NAME} already exists — kept the original backup`);
  }

  const todayIso = isoDate(new Date());
  const planBlocks = Array.isArray(state.plan_blocks) ? state.plan_blocks : [];
  if (state.race) {
    const slug = legacyRaceSlug(state.race);
    const dir = raceDir(projectRoot, slug);
    await fs.mkdir(dir, { recursive: true });
    await writeIfAbsent(path.join(dir, "race.json"), raceJsonFromLegacy(state.race, slug, todayIso));
    if (state.block) await writeIfAbsent(path.join(dir, "block.json"), state.block);
    if (planBlocks.length > 0) await writeIfAbsent(path.join(dir, "plan.json"), { plan_blocks: planBlocks });
  } else if (planBlocks.length > 0) {
    // No race in this file at all: the plan is already a generic-mode plan.
    await writeIfAbsent(genericPlanPath(projectRoot), { plan_blocks: planBlocks });
  }

  const next = { ...state, version: STATE_VERSION };
  delete next.race;
  delete next.block;
  delete next.plan_blocks;
  return next;
}

/* --------------------- where plan_blocks live now --------------------- */

/** config/generic-plan.json — the plan when no race is active (PRD §6). */
function genericPlanPath(projectRoot) {
  return path.join(projectRoot, "config", "generic-plan.json");
}

/**
 * The file the agent's plan_blocks belong in right now: the active race's
 * plan.json, or config/generic-plan.json in generic mode.
 * @returns {Promise<string>} absolute path (the file may not exist yet)
 */
export async function planBlocksPath(projectRoot) {
  const slug = await getActiveRace(projectRoot);
  return slug ? path.join(raceDir(projectRoot, slug), "plan.json") : genericPlanPath(projectRoot);
}

/**
 * Read the current plan_blocks from wherever they live. Missing file or
 * malformed contents read as [] — an absent plan is normal (a fresh race
 * folder has none) and must not break a sync.
 * @returns {Promise<{path: string, plan_blocks: object[]}>}
 */
export async function loadPlanBlocks(projectRoot) {
  const p = await planBlocksPath(projectRoot);
  try {
    const parsed = JSON.parse(await fs.readFile(p, "utf8"));
    return { path: p, plan_blocks: Array.isArray(parsed?.plan_blocks) ? parsed.plan_blocks : [] };
  } catch (e) {
    if (e.code !== "ENOENT") console.warn(`• ${p} unreadable (${e.message}) — treating the plan as empty`);
    return { path: p, plan_blocks: [] };
  }
}

/**
 * Replace the plan_blocks in the active race's plan.json (or the generic
 * plan). The file holds nothing else, so a whole-file write is the update.
 * @returns {Promise<string>} the path written
 */
export async function savePlanBlocks(projectRoot, planBlocks) {
  const p = await planBlocksPath(projectRoot);
  await writeJsonAtomic(p, { plan_blocks: planBlocks });
  return p;
}

export async function loadState(projectRoot) {
  const p = statePath(projectRoot);
  try {
    const buf = await fs.readFile(p, "utf8");
    let state = JSON.parse(buf);
    let migrated = false;
    if ((state.version ?? 0) < 2 || !state.preferences?.context) {
      state = migrateToV2(state);
      migrated = true;
      console.log("• migrated state.json to v2 (coach context)");
    }
    // Key presence, not the version number alone: a file hand-edited back to
    // carrying a race must still be split rather than left half-migrated.
    if ((state.version ?? 0) < 3 || "race" in state || "block" in state || "plan_blocks" in state) {
      state = await migrateToV3(projectRoot, state);
      migrated = true;
      console.log("• migrated state.json to v3 (race/block/plan → races/<slug>/)");
    } else if (state.version !== STATE_VERSION) {
      console.warn(`• state.json version ${state.version} ≠ ${STATE_VERSION}; using as-is`);
    }
    if (migrated) await writeJsonAtomic(p, state);
    return state;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  // bootstrap
  const fresh = { ...DEFAULT_STATE, last_updated: new Date().toISOString() };
  await writeJsonAtomic(p, fresh);
  console.log(`• bootstrapped ${p} from defaults`);
  return fresh;
}

/**
 * Save state.json atomically (write-then-rename to avoid corruption mid-write).
 */
export async function saveState(projectRoot, state) {
  const p = statePath(projectRoot);
  const next = { ...state, last_updated: new Date().toISOString() };
  // cap agent_notes to last 30
  if (Array.isArray(next.agent_notes) && next.agent_notes.length > 30) {
    next.agent_notes = next.agent_notes.slice(-30);
  }
  await writeJsonAtomic(p, next);
  return next;
}

/**
 * Merge an agent's update into the loaded state.
 * - plan_blocks: written to the active race's plan.json (or the generic
 *   plan) when non-empty — since v3 they are NOT part of state.json
 * - agent_notes: append the agent's new notes (with timestamps)
 * - new_context_items: append as source:"agent" temporary context items
 * - everything else: untouched (agent can't accidentally clobber)
 * @returns {Promise<{state: object, plan: {path: string, previous_count: number, count: number, written: boolean}}>}
 */
export async function mergeAgentUpdate(projectRoot, state, update) {
  let next = { ...state };
  const before = await loadPlanBlocks(projectRoot);
  const plan = { path: before.path, previous_count: before.plan_blocks.length, count: before.plan_blocks.length, written: false };
  if (Array.isArray(update?.plan_blocks) && update.plan_blocks.length > 0) {
    plan.path = await savePlanBlocks(projectRoot, update.plan_blocks);
    plan.count = update.plan_blocks.length;
    plan.written = true;
  }
  if (Array.isArray(update?.new_notes) && update.new_notes.length > 0) {
    const ts = new Date().toISOString();
    const dated = update.new_notes
      .filter((n) => typeof n === "string" && n.trim())
      .map((note) => ({ at: ts, note: note.trim() }));
    next.agent_notes = [...(state.agent_notes ?? []), ...dated];
  }
  if (Array.isArray(update?.new_context_items) && update.new_context_items.length > 0) {
    next = appendContextItems(next, update.new_context_items).state;
  }
  return { state: next, plan };
}
