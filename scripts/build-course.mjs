#!/usr/bin/env node
// Builds web/public/course.json — the Race views' source of truth — from the
// committed race GPX (config/mogollon-monster-100.gpx) plus the hand-authored
// aid chart / climb windows / sun times (config/race-course.json).
//
// Usage:  node scripts/build-course.mjs      (run manually; output is committed)
//
// Pipeline:
//   1. Regex-scan the GPX for track points (lat/lon/ele; ele is meters) and the
//      aid/crew/water waypoints. No XML dependency — StravaGPX is flat and stable.
//   2. Cumulative haversine distance → per-point (mi, ele_ft).
//   3. smoothProfile() (climb-lib) → clean 0.02 mi grid + hysteresis total gain.
//   4. Snap each aid waypoint to its nearest track point, but search only within
//      ±5 mi of its official mile (scaled by measured/official) so the Horton
//      out-and-back can't snap the return-leg waypoint to the outbound leg.
//   5. detectClimbs() over the whole course, then match each detected climb to the
//      six approx_mi windows by maximum overlap (raw window as fallback).
//
// Logs measured-vs-official distance & gain and every aid snap so the numbers can
// be sanity-checked; warns on any snap > 1.5 mi off official.

import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./lib.mjs";
import { haversine, smoothProfile, detectClimbs, gainBetween } from "./climb-lib.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const GPX_PATH = path.join(ROOT, "config", "mogollon-monster-100.gpx");
const RACE_PATH = path.join(ROOT, "config", "race-course.json");
const OUT_PATH = path.join(ROOT, "web", "public", "course.json");

const M_PER_FT = 0.3048;
const OUT_GRID_MI = 0.05; // profile resolution written to course.json

/** Parse GPX track points. ele is meters; carried forward if a point omits it. */
function parseTrack(gpx) {
  const pts = [];
  const re = /<trkpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"\s*>([\s\S]*?)<\/trkpt>/g;
  let m;
  let lastEleM = 0;
  while ((m = re.exec(gpx)) !== null) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    const eleMatch = /<ele>([-\d.]+)<\/ele>/.exec(m[3]);
    const eleM = eleMatch ? parseFloat(eleMatch[1]) : lastEleM;
    lastEleM = eleM;
    pts.push({ lat, lon, ele_ft: eleM / M_PER_FT });
  }
  return pts;
}

/** Parse GPX waypoints (aid/crew/water markers). */
function parseWaypoints(gpx) {
  const out = [];
  const re = /<wpt\s+lat="([-\d.]+)"\s+lon="([-\d.]+)"\s*>([\s\S]*?)<\/wpt>/g;
  let m;
  while ((m = re.exec(gpx)) !== null) {
    const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(m[3]);
    out.push({
      lat: parseFloat(m[1]),
      lon: parseFloat(m[2]),
      name: nameMatch ? nameMatch[1].trim() : "",
    });
  }
  return out;
}

/** Cumulative haversine miles along the track; attach `mi` to each point. */
function cumulativeMiles(pts) {
  let mi = 0;
  pts[0].mi = 0;
  for (let i = 1; i < pts.length; i++) {
    mi += haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    pts[i].mi = mi;
  }
  return pts;
}

/**
 * Snap a waypoint to the nearest track point by great-circle distance, searching
 * only points whose cumulative mile is within ±windowMi of the expected mile.
 */
function snapWaypoint(pts, wpt, expectedMi, windowMi) {
  let best = null;
  for (const p of pts) {
    if (Math.abs(p.mi - expectedMi) > windowMi) continue;
    const d = haversine(wpt.lat, wpt.lon, p.lat, p.lon);
    if (!best || d < best.d) best = { d, mi: p.mi };
  }
  // Fallback: if nothing fell in the window, snap globally.
  if (!best) {
    for (const p of pts) {
      const d = haversine(wpt.lat, wpt.lon, p.lat, p.lon);
      if (!best || d < best.d) best = { d, mi: p.mi };
    }
  }
  return best; // { d: miles from waypoint to track, mi: cumulative mile }
}

/** Downsample a grid slice to ~targetPts evenly-spaced points (keeps endpoints). */
function downsample(slice, targetPts) {
  if (slice.length <= targetPts) {
    return slice.map((p) => ({
      mi: +p.mi.toFixed(4),
      ele_ft: Math.round(p.ele_ft),
      grade_pct: +p.grade_pct.toFixed(2),
    }));
  }
  const out = [];
  const stepN = (slice.length - 1) / (targetPts - 1);
  for (let k = 0; k < targetPts; k++) {
    const p = slice[Math.round(k * stepN)];
    out.push({
      mi: +p.mi.toFixed(4),
      ele_ft: Math.round(p.ele_ft),
      grade_pct: +p.grade_pct.toFixed(2),
    });
  }
  return out;
}

/** Index of the grid point nearest a given mile. */
function nearestGridIdx(grid, mi) {
  let lo = 0;
  let hi = grid.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (grid[mid].mi < mi) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(grid[lo - 1].mi - mi) < Math.abs(grid[lo].mi - mi)) return lo - 1;
  return lo;
}

/** Overlap length (mi) between [a0,a1] and [b0,b1]. */
function overlap(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Driving route via the public OSRM demo server → { min, mi }. */
async function osrmDrive(from, to) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`osrm HTTP ${r.status}`);
  const d = await r.json();
  if (d.code !== "Ok" || !d.routes?.[0]) throw new Error(`osrm ${d.code}`);
  return {
    min: Math.round(d.routes[0].duration / 60),
    mi: +(d.routes[0].distance / 1609.34).toFixed(1),
  };
}

async function main() {
  const gpx = await fs.readFile(GPX_PATH, "utf8");
  const race = JSON.parse(await fs.readFile(RACE_PATH, "utf8"));

  const track = cumulativeMiles(parseTrack(gpx));
  const waypoints = parseWaypoints(gpx);
  const measuredDist = track[track.length - 1].mi;

  const { grid, rawGrid, gain_ft: measuredGain } = smoothProfile(
    track.map((p) => ({ mi: p.mi, ele_ft: p.ele_ft }))
  );

  const officialDist = race.official_distance_mi;
  const officialGain = race.official_gain_ft;
  const scale = measuredDist / officialDist; // measured miles per official mile

  console.log("── Mogollon Monster 100 · course build ──");
  console.log(
    `distance: measured ${measuredDist.toFixed(2)} mi vs official ${officialDist} mi ` +
      `(${((measuredDist / officialDist - 1) * 100).toFixed(1)}%)`
  );
  console.log(
    `gain:     measured ${Math.round(measuredGain).toLocaleString()} ft vs official ` +
      `${officialGain.toLocaleString()} ft (${((measuredGain / officialGain - 1) * 100).toFixed(1)}%)`
  );
  console.log(`track points: ${track.length} · grid points: ${grid.length}`);
  console.log("");

  // ── Aid stations: snap each to the track ────────────────────────────────
  const wptByName = new Map(waypoints.map((w) => [w.name, w]));
  const aid_stations = race.aid_stations.map((a) => {
    const base = {
      name: a.name,
      total_mi: a.total_mi,
      seg_mi: a.seg_mi,
      seg_gain_ft: a.seg_gain_ft,
      cutoff_h: a.cutoff_h,
      crew: a.crew,
      crew_only: a.crew_only,
      drop_bag: a.drop_bag,
      pacers: a.pacers,
      water_only: a.water_only,
      notes: a.notes,
    };
    if (!a.gpx_wpt) {
      // Finish: no waypoint — track end is the finish line.
      const end = track[track.length - 1];
      base.gpx_mi = +measuredDist.toFixed(3);
      base.lat = +end.lat.toFixed(5);
      base.lon = +end.lon.toFixed(5);
      console.log(`  ${a.name.padEnd(16)} official ${a.total_mi.toFixed(1)} → track end ${measuredDist.toFixed(2)} mi (finish)`);
      return base;
    }
    const wpt = wptByName.get(a.gpx_wpt);
    if (!wpt) throw new Error(`GPX waypoint not found: "${a.gpx_wpt}" for ${a.name}`);
    base.lat = +wpt.lat.toFixed(5);
    base.lon = +wpt.lon.toFixed(5);
    const expectedMi = a.total_mi * scale;
    const snap = snapWaypoint(track, wpt, expectedMi, 5);
    base.gpx_mi = +snap.mi.toFixed(3);
    // Report delta against official, in official-mile space.
    const officialMi = snap.mi / scale;
    const delta = officialMi - a.total_mi;
    const flag = Math.abs(delta) > 1.5 ? "  ⚠︎ >1.5 mi off" : "";
    console.log(
      `  ${a.name.padEnd(16)} official ${a.total_mi.toFixed(1)} → gpx ${snap.mi.toFixed(2)} mi ` +
        `(≈${officialMi.toFixed(1)} official, Δ${delta >= 0 ? "+" : ""}${delta.toFixed(2)} mi, ` +
        `snap ${(snap.d * 5280).toFixed(0)} ft)${flag}`
    );
    return base;
  });
  console.log("");

  // ── Race climbs: detect, then match to the six windows ──────────────────
  const detected = detectClimbs(grid, { minGainFt: 300, minAvgGradePct: 3 });
  console.log(`detected ${detected.length} climbs ≥300 ft / ≥3% over the course`);

  // Extend a matched climb's start back toward its manual window when the
  // approach is genuinely part of the climb — net uphill with < 70 ft of
  // drawdown. (The start climb gains ~250 ft in its first mile, sits on a
  // ~0.6 mi bench, then climbs the wall; plain detection starts at the wall.)
  const extendStart = (startMi, windowLoMi) => {
    if (windowLoMi >= startMi) return startMi;
    const seg = rawGrid.filter((p) => p.mi >= windowLoMi && p.mi <= startMi);
    if (seg.length < 2) return startMi;
    const net = seg[seg.length - 1].ele_ft - seg[0].ele_ft;
    let maxE = -Infinity;
    let drawdown = 0;
    for (const p of seg) {
      maxE = Math.max(maxE, p.ele_ft);
      drawdown = Math.max(drawdown, maxE - p.ele_ft);
    }
    return net > 0 && drawdown < 70 ? windowLoMi : startMi;
  };

  const race_climbs = race.race_climbs.map((rc) => {
    // Windows in config are official miles; scale to measured space.
    const w0 = rc.approx_mi[0] * scale;
    const w1 = rc.approx_mi[1] * scale;
    let match = null;
    let bestOv = 0;
    for (const c of detected) {
      const ov = overlap(c.start_mi, c.end_mi, w0, w1);
      if (ov > bestOv) {
        bestOv = ov;
        match = c;
      }
    }

    let s;
    let p;
    let stats;
    if (match) {
      const startMi = extendStart(match.start_mi, w0);
      s = nearestGridIdx(grid, startMi);
      p = match.peakIdx;
      const lengthMi = match.end_mi - startMi;
      // Gain from the un-averaged series: display smoothing clips switchback
      // relief; the ±10 ft hysteresis alone handles noise (see climb-lib).
      const gain = gainBetween(rawGrid, startMi, match.end_mi);
      if (startMi < match.start_mi) {
        console.log(`    ↳ ${rc.label}: start extended ${match.start_mi.toFixed(2)} → ${startMi.toFixed(2)} mi (uphill approach)`);
      }
      stats = {
        start_mi: +startMi.toFixed(3),
        end_mi: +match.end_mi.toFixed(3),
        length_mi: +lengthMi.toFixed(3),
        gain_ft: Math.round(gain),
        avg_grade_pct: +((gain / (lengthMi * 5280)) * 100).toFixed(2),
        max_grade_pct: +match.max_grade_pct.toFixed(2),
      };
    } else {
      // Fallback: raw window straight off the grid.
      s = nearestGridIdx(grid, w0);
      p = nearestGridIdx(grid, w1);
      const gain = gainBetween(rawGrid, grid[s].mi, grid[p].mi);
      const length_mi = grid[p].mi - grid[s].mi;
      let maxG = 0;
      for (let i = s; i <= p; i++) maxG = Math.max(maxG, grid[i].grade_pct);
      stats = {
        start_mi: +grid[s].mi.toFixed(3),
        end_mi: +grid[p].mi.toFixed(3),
        length_mi: +length_mi.toFixed(3),
        gain_ft: Math.round(gain),
        avg_grade_pct: length_mi > 0 ? +((gain / (length_mi * 5280)) * 100).toFixed(2) : 0,
        max_grade_pct: +maxG.toFixed(2),
      };
    }

    const profile = downsample(grid.slice(s, p + 1), 80);
    console.log(
      `  ${rc.label.padEnd(15)} ${match ? "matched" : "FALLBACK"} ` +
        `${stats.start_mi.toFixed(1)}–${stats.end_mi.toFixed(1)} mi · ` +
        `${stats.gain_ft} ft · ${stats.avg_grade_pct}% avg · ${stats.max_grade_pct}% max`
    );

    return { id: rc.id, label: rc.label, ...stats, profile };
  });
  console.log("");

  // ── Course profile at ~0.05 mi grid ─────────────────────────────────────
  const everyN = Math.max(1, Math.round(OUT_GRID_MI / (grid[1].mi - grid[0].mi)));
  const profile = [];
  for (let i = 0; i < grid.length; i += everyN) {
    profile.push({
      mi: +grid[i].mi.toFixed(3),
      ele_ft: Math.round(grid[i].ele_ft),
      grade_pct: +grid[i].grade_pct.toFixed(2),
    });
  }
  // Always include the final point.
  const last = grid[grid.length - 1];
  if (profile[profile.length - 1].mi !== +last.mi.toFixed(3)) {
    profile.push({
      mi: +last.mi.toFixed(3),
      ele_ft: Math.round(last.ele_ft),
      grade_pct: +last.grade_pct.toFixed(2),
    });
  }

  // ── Crew base + drive times → gitignored crew-base.json ─────────────────
  // The base is the athlete's race-week lodging: it lives in the gitignored
  // config/profile.json (key `race_base`) and the output goes to a separate
  // gitignored snapshot, so neither the address nor anything derived from it
  // ends up in the committed course.json of this public repo.
  let personal = null;
  try {
    personal = JSON.parse(await fs.readFile(path.join(ROOT, "config", "profile.json"), "utf8"));
  } catch (e) {
    // Fresh checkout: no personal profile — crew-base.json just isn't written.
    // But a hand-edited profile.json with bad JSON (e.g. a trailing comma) must
    // NOT be swallowed, or crew-base.json silently keeps stale data. Fail loud.
    if (e.code !== "ENOENT") {
      console.error(`✗ config/profile.json is present but unreadable: ${e.message}`);
      process.exit(1);
    }
  }
  const raceBase = personal?.race_base;
  if (raceBase && !(
    Number.isFinite(raceBase.lat) &&
    Number.isFinite(raceBase.lon) &&
    typeof raceBase.label === "string" &&
    raceBase.label.trim() !== ""
  )) {
    // Present but malformed: writing it would give CourseMap NaN geometry and
    // fire OSRM fetches with `undefined` in the URL. Warn and skip, same as absent.
    console.warn(
      "⚠︎ config/profile.json race_base missing/invalid finite lat, lon, or non-empty " +
        "label — skipping crew-base.json"
    );
  } else if (raceBase) {
    const base = { ...raceBase, drive_to_start_min: null, drive_to_start_mi: null };
    const drives = {};
    const startPt = { lat: track[0].lat, lon: track[0].lon };
    try {
      const d = await osrmDrive(base, startPt);
      base.drive_to_start_min = d.min;
      base.drive_to_start_mi = d.mi;
      console.log(`drive base → start: ${d.min} min · ${d.mi} mi`);
    } catch (e) {
      console.warn(`⚠︎ drive base → start failed: ${e.message}`);
    }
    for (const s of aid_stations) {
      if (!(s.crew || s.crew_only) || s.lat == null) continue;
      try {
        await new Promise((r) => setTimeout(r, 300));
        const d = await osrmDrive(base, s);
        drives[s.name] = { min: d.min, mi: d.mi };
        console.log(`drive base → ${s.name}: ${d.min} min · ${d.mi} mi`);
      } catch (e) {
        console.warn(`⚠︎ drive base → ${s.name} failed: ${e.message}`);
      }
    }
    await writeJsonAtomic(path.join(ROOT, "web", "public", "crew-base.json"), {
      generated_at: new Date().toISOString(),
      base,
      drives,
    });
    console.log("✓ wrote crew-base.json (gitignored — contains the lodging address)\n");
  }

  // ── Overview-map polyline: track lat/lon downsampled to ~400 points ─────
  const trackStep = Math.max(1, Math.ceil(track.length / 400));
  const map_track = [];
  for (let i = 0; i < track.length; i += trackStep) {
    map_track.push([+track[i].lat.toFixed(5), +track[i].lon.toFixed(5)]);
  }
  const endPt = track[track.length - 1];
  map_track.push([+endPt.lat.toFixed(5), +endPt.lon.toFixed(5)]);

  const payload = {
    generated_at: new Date().toISOString(),
    source: "config/mogollon-monster-100.gpx + config/race-course.json",
    distance_mi: +measuredDist.toFixed(3),
    gain_ft: Math.round(measuredGain),
    official_distance_mi: officialDist,
    official_gain_ft: officialGain,
    sun: race.sun,
    profile,
    aid_stations,
    race_climbs,
    /** [lat, lon] polyline for the crew-sheet overview map */
    map_track,
    /** crew rules / directions distilled from the official crew manual */
    crew_info: race.crew_info ?? null,
  };
  await writeJsonAtomic(OUT_PATH, payload);
  console.log(
    `✓ wrote course.json → ${OUT_PATH}\n` +
      `  profile ${profile.length} pts · ${aid_stations.length} aid stations · ${race_climbs.length} climbs`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
