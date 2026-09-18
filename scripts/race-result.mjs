#!/usr/bin/env node
// Results capture: turn a finished race plus its Strava activity into
// races/<slug>/result.json (PRD §10) and retire the folder.
//
// Usage:  node scripts/race-result.mjs --race <slug> --activity <strava id> [--notes "..."]
//
// Two halves, deliberately separated:
//
//   splitsFromStream()  PURE. Given one activity's latlng+time streams and the
//                       course's aid stations (snapped lat/lon from
//                       build/course.json), it answers "when did the runner
//                       first come within 150 m of each station?". No I/O, no
//                       Strava, no clock — scripts/race-result.test.mjs holds
//                       it to the awkward cases (a station the course never
//                       actually reaches, an out-and-back that passes one
//                       station twice).
//
//   archiveRace()       The transaction around it: fetch that ONE activity's
//                       stream (scripts/sync-streams.mjs's cache does the
//                       fetching, so a re-archive costs nothing), refuse an
//                       activity that is not from race day, merge any official
//                       splits over the track-derived ones, write result.json,
//                       flip race.json to "archived", and let the pointer go.
//
// Why the date guard: the picker lists the whole Strava log, and picking the
// wrong row would write a confident, completely fictional set of splits. A run
// more than a day off the race date in RACE-LOCAL time is never the race.

import fs from "node:fs/promises";
import path from "node:path";
import { arg, writeJsonAtomic } from "./lib.mjs";
import { loadRaceFolder, raceDir, readActivePointer, setActivePointer } from "./race-config.mjs";
import { raceLocalParts } from "./clock.mjs";
import { fetchActivityStreams } from "./sync-streams.mjs";

/** result.json's `status` — PRD §10. */
export const RESULT_STATUSES = ["finished", "dnf", "dns"];

/** How close the track has to come to a station's snapped point to count. */
export const DEFAULT_RADIUS_M = 150;

/**
 * How long the track must stay OUTSIDE the radius before a return counts as a
 * second visit rather than a continuation of the first. Aid stations are
 * milled around for minutes at a time and GPS drops a point through the fence
 * regularly; without this, standing at one station would score as four passes
 * and `visit: 2` would resolve to the same arrival.
 */
export const DEFAULT_MIN_GAP_S = 300;

/** Race day ± this many days, in race-local time. */
const DATE_SLACK_DAYS = 1;

const EARTH_R_M = 6371008.8;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Great-circle metres between two [lat, lon] points. */
function haversineM(aLat, aLon, bLat, bLon) {
  const toRad = Math.PI / 180;
  const dLat = (bLat - aLat) * toRad;
  const dLon = (bLon - aLon) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * toRad) * Math.cos(bLat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Per-station arrival times derived from a GPS track.
 *
 * A "pass" is a maximal stretch of track inside `radiusM` of the station; the
 * split is the elapsed time at the FIRST point of that stretch (arrival, not
 * departure — that is the number a split sheet means). Which pass counts is
 * the station's `visit` (default 1), which is how an out-and-back scores the
 * station it touches on the way back rather than the way out.
 *
 * Never within the radius — a station the recorded track skirts, or one with
 * no coordinates at all — is `null`, not a guess.
 *
 * @param {{latlng: [number, number][], time: number[]}} stream seconds from activity start
 * @param {{name: string, lat?: number, lon?: number, visit?: number}[]} stations
 * @param {{radiusM?: number, minGapS?: number}} [opts]
 * @returns {{station: string, elapsed_h: number|null, source: "track"}[]}
 */
export function splitsFromStream(stream, stations, opts = {}) {
  const radiusM = opts.radiusM ?? DEFAULT_RADIUS_M;
  const minGapS = opts.minGapS ?? DEFAULT_MIN_GAP_S;
  const latlng = stream?.latlng ?? [];
  const time = stream?.time ?? [];
  const n = Math.min(latlng.length, time.length);
  const t0 = n > 0 ? time[0] : 0;

  return (stations ?? []).map((s) => {
    const split = { station: s.name, elapsed_h: null, source: "track" };
    if (!isNum(s.lat) || !isNum(s.lon)) return split;

    const wanted = Math.max(1, Math.round(s.visit ?? 1));
    let passes = 0;
    let inside = false;
    let leftAtS = null;
    for (let i = 0; i < n; i++) {
      const p = latlng[i];
      if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1])) continue;
      const near = haversineM(p[0], p[1], s.lat, s.lon) <= radiusM;
      if (near && !inside) {
        inside = true;
        // A re-entry hard on the heels of an exit is the same visit still in
        // progress; only a real departure starts the next one.
        if (leftAtS === null || time[i] - leftAtS >= minGapS) {
          passes += 1;
          if (passes === wanted) {
            split.elapsed_h = +((time[i] - t0) / 3600).toFixed(3);
            return split;
          }
        }
      } else if (!near && inside) {
        inside = false;
        leftAtS = time[i];
      }
    }
    return split;
  });
}

/**
 * Lay official splits over the track-derived ones. A station named by the
 * official results wins outright and is re-tagged `source: "official"`; a
 * station the officials never timed keeps its track split. Official names the
 * course does not know are appended rather than dropped — losing a real
 * recorded split to a spelling difference would be worse than an odd row.
 * @param {{station: string, elapsed_h: number|null, source: string}[]} splits
 * @param {{station: string, elapsed_h: number|null}[]} [official]
 */
export function mergeOfficialSplits(splits, official) {
  if (!Array.isArray(official) || official.length === 0) return splits;
  const byName = new Map(official.filter((o) => o && typeof o.station === "string").map((o) => [o.station, o]));
  const out = splits.map((s) => {
    const o = byName.get(s.station);
    if (!o) return s;
    byName.delete(s.station);
    return { station: s.station, elapsed_h: isNum(o.elapsed_h) ? o.elapsed_h : null, source: "official" };
  });
  for (const o of byName.values()) {
    out.push({ station: o.station, elapsed_h: isNum(o.elapsed_h) ? o.elapsed_h : null, source: "official" });
  }
  return out;
}

const tagged = (code, msg) => Object.assign(new Error(msg), { code });

async function readJsonOptional(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** races/<slug>/result.json, or null when the race has not been archived. */
export async function loadResult(root, slug) {
  return readJsonOptional(path.join(raceDir(root, slug), "result.json"));
}

/**
 * The Strava log row for one activity. The picker chooses from
 * web/public/strava.json, and the server re-reads it rather than trusting the
 * client's idea of when the activity happened — the date guard is only worth
 * something if its input is ours.
 */
export async function findLoggedActivity(root, activityId) {
  const log = await readJsonOptional(path.join(root, "web", "public", "strava.json"));
  if (!log) throw tagged("bad_request", "web/public/strava.json not found — run `npm run sync:strava` first");
  const found = (log.activities ?? []).find((a) => String(a.id) === String(activityId));
  if (!found) throw tagged("bad_request", `activity ${activityId} is not in the Strava log`);
  return found;
}

/** The instant an activity started. `date` is race-local-with-a-Z in the log;
    `start_utc` is the real instant, so it is the one the guard trusts. */
function activityStart(activity) {
  const iso = activity.start_utc ?? activity.date;
  const ms = Date.parse(String(iso));
  if (Number.isNaN(ms)) throw tagged("bad_request", `activity ${activity.id} has no readable start time`);
  return ms;
}

/** Whole days between two YYYY-MM-DD calendar dates. */
function daysBetween(isoA, isoB) {
  const [ya, ma, da] = isoA.split("-").map(Number);
  const [yb, mb, db] = isoB.split("-").map(Number);
  return Math.round((Date.UTC(ya, ma - 1, da) - Date.UTC(yb, mb - 1, db)) / 86400000);
}

/**
 * Archive a race against a Strava activity: derive the splits, write
 * result.json, retire race.json, and release the pointer.
 *
 * @param {object} o
 * @param {string} o.root project root
 * @param {string} o.slug race folder
 * @param {string|number} o.activityId Strava activity to link
 * @param {{finish_h?: number, official_time?: string, placement?: string,
 *          splits?: {station: string, elapsed_h: number|null}[]}} [o.official]
 *        the official results, overriding what the track says
 * @param {string} [o.notes]
 * @param {"finished"|"dnf"|"dns"} [o.status] default: whatever result.json
 *        already said, else "finished"
 * @param {number} [o.radiusM]
 * @param {object} [o.activity] injected log row (tests); otherwise looked up
 * @param {object} [o.streams] injected latlng+time (tests); otherwise fetched
 * @param {object} [o.course] an already-loaded build/course.json — for a
 *        backfill run against a checkout that never built one, and for tests
 * @param {string} [o.now] ISO timestamp for provenance, injectable
 * @returns {Promise<{slug: string, result: object, pointer: {slug: string|null, mode: string}}>}
 */
export async function archiveRace(o) {
  const { root, slug, activityId, official = null, notes, status, radiusM = DEFAULT_RADIUS_M } = o;
  if (!slug) throw tagged("bad_request", "slug required");
  if (activityId === undefined || activityId === null || String(activityId).trim() === "") {
    throw tagged("bad_request", "activity_id required");
  }
  if (status !== undefined && !RESULT_STATUSES.includes(status)) {
    throw tagged("bad_request", `status must be one of ${RESULT_STATUSES.join(" | ")}`);
  }

  let folder;
  try {
    folder = await loadRaceFolder(root, slug);
  } catch (e) {
    throw tagged(/not found$/.test(e.message) ? "not_found" : "bad_request", e.message);
  }
  const race = folder.race;

  // ── race day, in the race's own zone ────────────────────────────────────
  const activity = o.activity ?? (await findLoggedActivity(root, activityId));
  const localIso = raceLocalParts(activityStart(activity), race.timezone).iso;
  const off = daysBetween(localIso, race.date);
  if (Math.abs(off) > DATE_SLACK_DAYS) {
    throw tagged(
      "bad_request",
      `activity ${activityId} is from ${localIso} (${race.timezone}) — ${race.name} was ${race.date}; ` +
        `only an activity within ±${DATE_SLACK_DAYS} day can be its result`,
    );
  }

  // ── splits ──────────────────────────────────────────────────────────────
  // Station coordinates live in the BUILT course, not race.json: they are the
  // GPX-snapped points, which is what a 150 m radius is meaningful against.
  const course = o.course ?? (await readJsonOptional(path.join(raceDir(root, slug), "build", "course.json")));
  if (!course) {
    throw tagged(
      "bad_request",
      `races/${slug}/build/course.json not found — run \`npm run course:build -- --race ${slug}\` ` +
        "first; the station coordinates the splits are measured against come from it",
    );
  }
  const streams = o.streams ?? (await fetchActivityStreams(activityId));
  const splits = mergeOfficialSplits(
    splitsFromStream(streams, course.aid_stations ?? [], { radiusM }),
    official?.splits,
  );

  // ── result.json ─────────────────────────────────────────────────────────
  // Merged onto whatever is already there: a migration wrote MM100's finish
  // and notes long before its activity was linked, and re-archiving to fix a
  // split must not quietly erase the rest.
  const prev = (await loadResult(root, slug)) ?? {};
  const elapsedH = isNum(activity.elapsed_s) ? +(activity.elapsed_s / 3600).toFixed(2) : null;
  const result = {
    status: status ?? prev.status ?? "finished",
    strava_activity_id: String(activityId),
    finish_h: official?.finish_h ?? prev.finish_h ?? elapsedH,
    official_time: official?.official_time ?? prev.official_time ?? null,
    placement: official?.placement ?? prev.placement ?? null,
    splits,
    notes: notes ?? prev.notes ?? null,
  };
  await writeJsonAtomic(path.join(raceDir(root, slug), "result.json"), result);

  // ── retire the folder ───────────────────────────────────────────────────
  if (race.status !== "archived") {
    const at = o.now ?? new Date().toISOString();
    await writeJsonAtomic(path.join(raceDir(root, slug), "race.json"), {
      ...race,
      status: "archived",
      provenance: { ...(race.provenance ?? {}), status: { by: "user", at } },
    });
  }

  // The pointer only has to move if it was TRAINING for this race; a browse
  // (view mode) is left alone — the athlete is looking at the race they just
  // archived, and yanking the page out from under them helps nobody.
  let pointer = await readActivePointer(root);
  if (pointer.slug === slug && pointer.mode === "train") {
    pointer = await setActivePointer(root, { slug: null, mode: "train" });
  }

  return { slug, result, pointer };
}

async function main() {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const slug = arg("race", null);
  const activityId = arg("activity", null);
  if (typeof slug !== "string" || typeof activityId !== "string") {
    console.error("usage: node scripts/race-result.mjs --race <slug> --activity <strava id> [--notes \"...\"]");
    process.exit(2);
  }
  const notesArg = arg("notes", undefined);
  const { result } = await archiveRace({
    root,
    slug,
    activityId,
    notes: typeof notesArg === "string" ? notesArg : undefined,
  });
  const clock = (h) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  console.log(`✓ races/${slug}/result.json — ${result.status}, finish ${result.finish_h} h, activity ${result.strava_activity_id}`);
  for (const s of result.splits) {
    console.log(`  ${s.elapsed_h === null ? "   —  " : clock(s.elapsed_h).padStart(6)}  ${s.station}${s.source === "official" ? " (official)" : ""}`);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  });
}
