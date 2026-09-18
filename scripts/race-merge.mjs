// Re-intake merge (PRD §8): the deterministic half of "Refresh from sources".
//
// A refresh re-runs the whole intake pipeline into a shadow folder and then
// asks THIS module one question per field: the manual moved, but did the
// owner get there first? The answer is the provenance map race-intake.mjs and
// race-plan.mjs stamp as they write:
//
//   by: "user"                    → kept. The incoming value is recorded as a
//                                   suggestion (a conflict) and shown in the
//                                   review, never applied.
//   by: "agent"|"computed"|"matcher" → updated. None of those three is a hand
//                                   edit, and a re-read of the organizer's own
//                                   sources is a better claim than the last one.
//
// Nothing here touches the disk and nothing here calls an agent: a merge the
// owner is about to accept has to be reproducible, so it is a pure function
// over two parsed JSON objects. scripts/race-refresh.mjs owns the shadow
// folder, the ordering and the atomic write.
//
// Two shapes of difference, because a race has two shapes of data:
//
//   scalars and nested objects (date, cutoff_h, coach_notes.terrain,
//     visual.accent) diff by dotted path;
//   keyed arrays (aid_stations by name, block targets by wk) diff by IDENTITY,
//     not by index. Diffing stations positionally would report "every station
//     after mile 30 changed" the moment the organizer inserts one, and the
//     rename case (Pinchot Camp → Pinchot) would read as one station removed
//     and an unrelated one added, throwing away the cutoff the owner typed.
//     A station that vanished from the chart but reappears within
//     RENAME_NEAR_MI of the same mile IS that station, renamed.
//
// Provenance timestamps never count as a change: a re-intake that re-derives
// the same value stamps a new `at`, and merge(current, current-with-new-
// timestamps) must still be an empty diff or the review dialog would ask the
// owner to accept nothing.

import { collectUnresolved } from "./race-intake.mjs";

/**
 * How far a station may have moved and still be the same station under a new
 * name. The Softie's 2027 chart shifts a few stations by a tenth or two when
 * the road crossing moves; a genuinely new station between two old ones is
 * further from both than this.
 */
export const RENAME_NEAR_MI = 1.5;

/**
 * Ours, not the intake's. slug and schema_version are identity, status is the
 * athlete's (an active race stays active across a refresh — PRD §8), and
 * provenance is the merge's own bookkeeping rather than a value to merge.
 */
const NEVER_MERGED = new Set(["schema_version", "slug", "status", "provenance"]);

/** Which top-level arrays have an identity, and what it is. */
const ARRAY_KEYS = {
  "race.json": { aid_stations: { key: "name", near: "total_mi", within: RENAME_NEAR_MI } },
  "block.json": { targets: { key: "wk" } },
  // nutrition.json's drop_bag_gear is an OBJECT keyed by station name, so the
  // per-station diff falls out of the ordinary object walk; `phases` has no
  // identity of its own and is compared whole.
  "nutrition.json": {},
};

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep equality with object key order ignored — a re-serialized file is not a change. */
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
    return out;
  }
  return v;
}
const eq = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/**
 * The provenance keys that can protect `path`, longest first:
 * "aid_stations[3].cutoff_h" → that, "aid_stations[3]", "aid_stations".
 * A user-owned parent protects everything under it, which is how a rewritten
 * `coach_notes` keeps all five of its sections.
 */
function ownerPaths(path) {
  const out = [path];
  let rest = path;
  while (rest) {
    const cut = Math.max(rest.lastIndexOf("."), rest.lastIndexOf("["));
    if (cut <= 0) break;
    rest = rest.slice(0, cut);
    out.push(rest);
  }
  return out;
}

/** Who owns the current value at `path` — "user" is the only one that wins. */
function ownerOf(provenance, path) {
  if (!isObj(provenance)) return null;
  for (const p of ownerPaths(path)) {
    const by = provenance[p]?.by;
    if (typeof by === "string") return by;
  }
  return null;
}

/* ------------------------------ the merge -------------------------------- */

/**
 * Merge one file's incoming version onto the current one.
 *
 * Absence is not removal: a field the incoming file simply does not carry is
 * left alone rather than deleted. Only a KEYED ARRAY can remove — a station
 * missing from the new chart is a station the organizer cut, and that is the
 * one case where the incoming file's silence is a statement.
 *
 * @param {object} current the file on disk (not mutated)
 * @param {object} incoming the same file as the refresh produced it
 * @param {{file?: string, at?: string, arrays?: object}} [opts]
 * @returns {{merged: object, diff: object[], conflicts: object[]}}
 *   diff entries are {file, path, kind, from, to, by, key?}, kind one of
 *   "added" | "changed" | "removed" | "renamed" | "kept"; conflicts is the
 *   "kept" subset — a user field the refresh would have changed.
 */
export function mergeFile(current, incoming, { file = "race.json", at = new Date().toISOString(), arrays = ARRAY_KEYS[file] ?? {} } = {}) {
  if (!isObj(current)) throw new Error(`mergeFile: current ${file} must be an object`);
  if (!isObj(incoming)) throw new Error(`mergeFile: incoming ${file} must be an object`);

  const provenance = current.provenance;
  const diff = [];
  const merged = structuredClone(current);
  /** Top-level fields this merge actually wrote, so provenance follows the value. */
  const written = new Set();

  const record = (e) => { diff.push({ file, ...e }); return e; };
  const owner = (path) => ownerOf(provenance, path);

  /** One leaf (scalar, unkeyed array, or an object facing a non-object). */
  const leaf = (path, top, has, from, to) => {
    if (!has) {
      if (owner(path) === "user") return; // the owner deleted it; a refresh does not put it back
      setAtPath(merged, path, to);
      written.add(top);
      record({ path, kind: "added", from: undefined, to, by: null });
      return;
    }
    if (eq(from, to)) return;
    if (owner(path) === "user") {
      record({ path, kind: "kept", from, to, by: "user" });
      return;
    }
    setAtPath(merged, path, to);
    written.add(top);
    record({ path, kind: "changed", from, to, by: owner(path) });
  };

  const walk = (cur, inc, prefix, top) => {
    for (const key of Object.keys(inc)) {
      if (!prefix && NEVER_MERGED.has(key)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      const topField = top ?? key;
      const to = inc[key];
      const from = isObj(cur) ? cur[key] : undefined;
      const has = isObj(cur) && key in cur;
      const arrayCfg = !prefix ? arrays[key] : null;

      if (arrayCfg && Array.isArray(to) && Array.isArray(from)) {
        mergeKeyedArray({ path, cfg: arrayCfg, from, to, topField });
        continue;
      }
      if (isObj(to) && isObj(from)) {
        walk(from, to, path, topField);
        continue;
      }
      leaf(path, topField, has, from, to);
    }
  };

  /**
   * An array with an identity. Pairs by key, then — for `aid_stations`, which
   * carries `near` — pairs what is left by mile proximity and calls that a
   * rename. The merged array takes the INCOMING order: the new chart is the
   * course's order, and the app's validator requires the miles to climb.
   */
  const mergeKeyedArray = ({ path, cfg, from, to, topField }) => {
    if (owner(path) === "user") {
      // The whole array is hand-authored. Every difference is a suggestion.
      if (!eq(from, to)) record({ path, kind: "kept", from, to, by: "user" });
      return;
    }
    const pairs = pairRows(from, to, cfg);
    const out = [];
    const stationProv = [];

    pairs.forEach(({ ci, ii }) => {
      const row = ii == null ? null : to[ii];
      const cur = ci == null ? null : from[ci];
      const mi = out.length;
      if (row && cur == null) {
        out.push(structuredClone(row));
        stationProv.push({ mi, ii, ci: null });
        record({ path: `${path}[${mi}]`, kind: "added", from: undefined, to: row, by: null, key: rowKey(row, cfg) });
        return;
      }
      if (row == null && cur) {
        // dropped from the new chart — unless the owner authored this row
        if (ownerOf(provenance, `${path}[${ci}]`) === "user") {
          out.push(structuredClone(cur));
          stationProv.push({ mi: out.length - 1, ii: null, ci });
          record({ path: `${path}[${ci}]`, kind: "kept", from: cur, to: undefined, by: "user", key: rowKey(cur, cfg) });
          return;
        }
        record({ path: `${path}[${ci}]`, kind: "removed", from: cur, to: undefined, by: ownerOf(provenance, `${path}[${ci}]`), key: rowKey(cur, cfg) });
        return;
      }
      // matched: merge field by field, under the CURRENT index — that is how
      // race-build.mjs keys a station's provenance ("aid_stations[2].gpx_wpt")
      const rowOut = structuredClone(cur);
      if (cfg.key && !eq(cur[cfg.key], row[cfg.key])) {
        record({ path: `${path}[${ci}].${cfg.key}`, kind: "renamed", from: cur[cfg.key], to: row[cfg.key], by: null, key: rowKey(cur, cfg) });
      }
      for (const k of Object.keys(row)) {
        const fieldPath = `${path}[${ci}].${k}`;
        if (eq(cur[k], row[k])) continue;
        if (ownerOf(provenance, fieldPath) === "user") {
          record({ path: fieldPath, kind: "kept", from: cur[k], to: row[k], by: "user", key: rowKey(cur, cfg) });
          continue;
        }
        rowOut[k] = structuredClone(row[k]);
        if (k !== cfg.key) {
          record({ path: fieldPath, kind: "changed", from: cur[k], to: row[k], by: ownerOf(provenance, fieldPath), key: rowKey(cur, cfg) });
        }
      }
      out.push(rowOut);
      stationProv.push({ mi: out.length - 1, ii, ci });
    });

    if (!eq(from, out)) {
      setAtPath(merged, path, out);
      written.add(topField);
      // Only when rows actually moved: re-stamping an unchanged chart would
      // rewrite every matcher timestamp for no reason.
      rekeyRowProvenance(merged, incoming, provenance, path, stationProv);
    }
  };

  walk(current, incoming, "", null);

  /* Provenance follows the value: a field this merge took from the refresh
     takes the refresh's stamp too, so the NEXT merge knows the agent — not
     the owner — put it there. A field left alone keeps whatever it had. */
  if (isObj(provenance) || isObj(incoming.provenance)) {
    merged.provenance = { ...(merged.provenance ?? {}) };
    for (const field of written) {
      const incomingStamp = incoming.provenance?.[field];
      merged.provenance[field] = isObj(incomingStamp)
        ? { ...incomingStamp }
        : { by: "agent", at, source: "race-refresh" };
    }
  }

  const conflicts = diff.filter((d) => d.kind === "kept");
  return { merged, diff, conflicts };
}

/** The row's identity, for the review's "which station is this" label. */
function rowKey(row, cfg) {
  return cfg.key ? row?.[cfg.key] : null;
}

/**
 * Pair current rows to incoming rows by key, then by proximity, and return
 * them in the incoming file's order with the leftovers (removals) spliced in
 * where they used to sit — so the diff reads down the course.
 * @returns {{ci: number|null, ii: number|null}[]}
 */
function pairRows(from, to, cfg) {
  const norm = (v) => (typeof v === "string" ? v.trim().toLowerCase() : v);
  const byKey = new Map();
  from.forEach((row, ci) => {
    const k = norm(rowKey(row, cfg));
    if (k !== undefined && k !== null && !byKey.has(k)) byKey.set(k, ci);
  });

  const matchedCurrent = new Set();
  const pairs = to.map((row, ii) => {
    const k = norm(rowKey(row, cfg));
    const ci = byKey.has(k) ? byKey.get(k) : null;
    if (ci !== null) matchedCurrent.add(ci);
    return { ci, ii };
  });

  /* Renames: what is left on both sides, paired by how close they are on the
     course. Greedy over the closest pair each round, so a chart that renames
     two adjacent stations does not cross-match them. */
  if (cfg.near) {
    const freeCurrent = from.map((_, ci) => ci).filter((ci) => !matchedCurrent.has(ci));
    const freeIncoming = pairs.filter((p) => p.ci === null);
    while (freeCurrent.length && freeIncoming.length) {
      let best = null;
      for (const ci of freeCurrent) {
        for (const p of freeIncoming) {
          const a = from[ci]?.[cfg.near];
          const b = to[p.ii]?.[cfg.near];
          if (typeof a !== "number" || typeof b !== "number") continue;
          const d = Math.abs(a - b);
          if (d > cfg.within) continue;
          if (!best || d < best.d) best = { ci, p, d };
        }
      }
      if (!best) break;
      best.p.ci = best.ci;
      matchedCurrent.add(best.ci);
      freeCurrent.splice(freeCurrent.indexOf(best.ci), 1);
      freeIncoming.splice(freeIncoming.indexOf(best.p), 1);
    }
  }

  /* Removed rows: keep them next to where they were, so a station cut at mile
     40 is reported between its old neighbours rather than at the end. */
  const out = [];
  let nextPair = 0;
  from.forEach((_, ci) => {
    if (matchedCurrent.has(ci)) {
      const at = pairs.findIndex((p) => p.ci === ci);
      while (nextPair <= at) out.push(pairs[nextPair++]);
    } else {
      out.push({ ci, ii: null });
    }
  });
  while (nextPair < pairs.length) out.push(pairs[nextPair++]);
  return out;
}

/**
 * Rewrite the per-row provenance keys ("aid_stations[2].gpx_wpt") for the
 * merged array's indices. Rows move when the chart inserts or cuts one, and a
 * matcher stamp left on the old index would describe a different station.
 */
function rekeyRowProvenance(merged, incoming, provenance, path, rows) {
  if (!isObj(provenance) && !isObj(incoming.provenance)) return;
  const prefix = `${path}[`;
  const next = {};
  for (const [k, v] of Object.entries(merged.provenance ?? {})) {
    if (!k.startsWith(prefix)) next[k] = v;
  }
  for (const { mi, ii, ci } of rows) {
    const carry = (src, idx) => {
      if (idx == null || !isObj(src)) return;
      for (const [k, v] of Object.entries(src)) {
        if (!k.startsWith(`${path}[${idx}]`)) continue;
        const tail = k.slice(`${path}[${idx}]`.length);
        next[`${path}[${mi}]${tail}`] = v;
      }
    };
    // the refresh's stamps first, then the owner's — the owner's win
    carry(incoming.provenance, ii);
    for (const [k, v] of Object.entries(provenance ?? {})) {
      if (ci == null || !k.startsWith(`${path}[${ci}]`)) continue;
      if (v?.by !== "user") continue;
      next[`${path}[${mi}]${k.slice(`${path}[${ci}]`.length)}`] = v;
    }
  }
  merged.provenance = next;
}

/** Set a dotted/indexed path ("visual.accent", "aid_stations") on an object. */
function setAtPath(obj, path, value) {
  const parts = path.split(".");
  let node = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isObj(node[p])) node[p] = {};
    node = node[p];
  }
  node[parts[parts.length - 1]] = structuredClone(value);
}

/* ------------------------------ per file --------------------------------- */

/**
 * Merge race.json. On top of mergeFile: the unresolved list is RECOMPUTED from
 * the merged race rather than carried over, because a hole the owner filled by
 * hand is not a hole any more even if the refresh left it null again.
 * @returns {{merged: object, diff: object[], conflicts: object[], unresolved: string[]}}
 */
export function mergeRace(current, incoming, opts = {}) {
  const out = mergeFile(current, incoming, { ...opts, file: "race.json" });
  return { ...out, unresolved: collectUnresolved(out.merged) };
}

/** Merge block.json — targets keyed by week number. */
export function mergeBlock(current, incoming, opts = {}) {
  return mergeFile(current, incoming, { ...opts, file: "block.json" });
}

/** Merge nutrition.json — drop_bag_gear is an object, so it diffs per station. */
export function mergeNutrition(current, incoming, opts = {}) {
  return mergeFile(current, incoming, { ...opts, file: "nutrition.json" });
}

/**
 * The whole folder: race.json, block.json and nutrition.json in one pass.
 * A file the refresh did not produce is skipped (no diff, nothing to write);
 * a file the refresh produced that the race did not have yet is taken whole.
 * plan.json and result.json are not in this list and never will be — the
 * coach owns one and a finished race owns the other.
 * @param {{race: object, block: object|null, nutrition: object|null}} current
 * @param {{race: object|null, block: object|null, nutrition: object|null}} incoming
 * @returns {{files: object, diff: object[], conflicts: object[], unresolved: string[]}}
 */
export function mergeRaceFolder(current, incoming, opts = {}) {
  const files = {};
  const diff = [];
  const conflicts = [];
  let unresolved = [];

  const pairs = [
    ["race.json", current.race, incoming.race, mergeRace],
    ["block.json", current.block, incoming.block, mergeBlock],
    ["nutrition.json", current.nutrition, incoming.nutrition, mergeNutrition],
  ];
  for (const [file, cur, inc, fn] of pairs) {
    if (!isObj(inc)) continue;
    if (!isObj(cur)) {
      // new file: the whole thing is an addition, and there is nothing to keep
      files[file] = structuredClone(inc);
      diff.push({ file, path: "", kind: "added", from: undefined, to: inc, by: null });
      if (file === "race.json") unresolved = collectUnresolved(inc);
      continue;
    }
    const out = fn(cur, inc, opts);
    files[file] = out.merged;
    diff.push(...out.diff);
    conflicts.push(...out.conflicts);
    if (file === "race.json") unresolved = out.unresolved;
  }
  return { files, diff, conflicts, unresolved };
}
