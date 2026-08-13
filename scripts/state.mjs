// Persistent agentic state for Trail Almanac.
//
// One JSON file at web/public/state.json is the source of truth for everything
// that should survive across syncs and server restarts:
//   - race meta (name, date, distance, elevation, location)
//   - 20-week block targets (planned weekly miles + vert)
//   - the agent's current plan_blocks (6 upcoming weeks of focus + key sessions)
//   - agent's persistent notes (observations the coach has made and wants
//     to remember between sessions)
//   - athlete-set preferences (training philosophy, constraints)
//
// On first run, bootstrapped from DEFAULT_STATE. The coach reads this,
// passes it to the agent as context, and MERGES the agent's response back
// (plan_blocks + new notes) — the agent never overwrites the whole file,
// which prevents accidental data loss if it returns malformed output.

import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./lib.mjs";

export const STATE_VERSION = 2;

// Calendar/childcare semantics as athlete-voice data. Lives in
// preferences.context.sections.calendar_conventions (seeded here on
// bootstrap and by the v1→v2 migration); both coach prompts point the agent
// at that section, so editing it in the settings dialog is what changes
// agent behavior — there is no other copy.
export const DEFAULT_CALENDAR_CONVENTIONS = `All-day marker events on the family calendars flag childcare days: "Em" / "M" / "Emerson" = Em is away and I have SOLO kid duty; "H" markers ("H no school", "Pick up H") = Hawthorne is home and needs coverage. Severity depends on the day of week. WEEKDAY (Mon-Fri) childcare days: I can still train during work hours (~08:00-16:00) — plan them as near-normal training days and note the window. WEEKEND childcare days are the genuinely hard ones, worst when an "Em" marker covers a weekend (solo duty, no daycare backup): default those to rest or a short pre-dawn run (start ~05:30, done by 08:00), and plan the week's long runs to AVOID Em weekends entirely — use a clear weekend day or a weekday daytime window, naming the swap. Saturday "Hawthorn soccer" (09:00) caps any Saturday session: finished and home by 08:30.`;

// Defaults used to bootstrap a fresh state.json. Editable in the file once
// it's been created — the file becomes the source of truth.
export const DEFAULT_STATE = {
  version: STATE_VERSION,
  last_updated: null,
  race: {
    name: "Mogollon Monster 100",
    short: "MM100",
    date: "2026-09-12",
    start_time: "06:00",
    distance_mi: 102.3,
    elevation_ft: 15900,
    max_elev_ft: 7912,
    cutoff_h: 38,
    location: "Mogollon Rim · Pine, AZ (90 min NE of Phoenix)",
    notes: "Climbs the rim 6×. Technical sections on Highline / Donahue / Myrtle / Promontory. September can run 80°F+ in the canyons.",
    aid_stations: [
      { mi: 11.1, name: "See Canyon" },
      { mi: 21.5, name: "Horton" },
      { mi: 26.8, name: "Fish Hatchery" },
      { mi: 39.2, name: "Myrtle" },
      { mi: 42.8, name: "Buck Springs" },
      { mi: 52.4, name: "Pinchot Cabin" },
      { mi: 58.7, name: "General Springs · Crew" },
      { mi: 61.1, name: "Washington Park" },
      { mi: 72.3, name: "Geronimo" },
      { mi: 81.8, name: "Donahue" },
      { mi: 85.6, name: "Dickerson Flat" },
      { mi: 90.5, name: "Pine Canyon" },
      { mi: 101.1, name: "Pine TH · Finish" },
    ],
  },
  block: {
    start_date: "2026-04-27",
    total_weeks: 20,
    targets: [
      { wk: 1,  target_dist: 38, target_elev: 5800 },
      { wk: 2,  target_dist: 46, target_elev: 7400 },
      { wk: 3,  target_dist: 52, target_elev: 8900 },
      { wk: 4,  target_dist: 36, target_elev: 5400 },
      { wk: 5,  target_dist: 54, target_elev: 9500 },
      { wk: 6,  target_dist: 60, target_elev: 10800 },
      { wk: 7,  target_dist: 55, target_elev: 9800 },
      { wk: 8,  target_dist: 62, target_elev: 11200 },
      { wk: 9,  target_dist: 38, target_elev: 5800 },
      { wk: 10, target_dist: 70, target_elev: 13400 },
      { wk: 11, target_dist: 78, target_elev: 14600 },
      { wk: 12, target_dist: 72, target_elev: 13200 },
      { wk: 13, target_dist: 42, target_elev: 6100 },
      { wk: 14, target_dist: 68, target_elev: 12400 },
      { wk: 15, target_dist: 58, target_elev: 9400 },
      { wk: 16, target_dist: 52, target_elev: 8200 },
      { wk: 17, target_dist: 42, target_elev: 6200 },
      { wk: 18, target_dist: 30, target_elev: 4200 },
      { wk: 19, target_dist: 18, target_elev: 2400 },
      { wk: 20, target_dist: 102.3, target_elev: 15900 },
    ],
  },
  // Agent-managed: current 6-week plan with focus + key session for each
  // upcoming week. Reset only when the block restructure justifies it.
  plan_blocks: [],
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
 * calendar_conventions is seeded with DEFAULT_CALENDAR_CONVENTIONS (the
 * prose this migration removes from the system prompts). Idempotent: keyed
 * off version < 2 in loadState.
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
    calendar_conventions: DEFAULT_CALENDAR_CONVENTIONS,
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
  return { ...state, version: STATE_VERSION, preferences: prefs };
}

/**
 * Load state.json from web/public/, bootstrapping it from DEFAULT_STATE
 * the first time. Always returns a valid state object.
 */
export async function loadState(projectRoot) {
  const p = statePath(projectRoot);
  try {
    const buf = await fs.readFile(p, "utf8");
    let state = JSON.parse(buf);
    if ((state.version ?? 0) < 2 || !state.preferences?.context) {
      state = migrateToV2(state);
      await writeJsonAtomic(p, state);
      console.log(`• migrated state.json to v${STATE_VERSION} (coach context)`);
    } else if (state.version !== STATE_VERSION) {
      console.warn(`• state.json version ${state.version} ≠ ${STATE_VERSION}; using as-is`);
    }
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
 * - plan_blocks: replace with agent's version if non-empty
 * - agent_notes: append the agent's new notes (with timestamps)
 * - new_context_items: append as source:"agent" temporary context items
 * - everything else: untouched (agent can't accidentally clobber)
 */
export function mergeAgentUpdate(state, update) {
  let next = { ...state };
  if (Array.isArray(update?.plan_blocks) && update.plan_blocks.length > 0) {
    next.plan_blocks = update.plan_blocks;
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
  return next;
}
