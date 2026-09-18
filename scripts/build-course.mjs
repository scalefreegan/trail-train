#!/usr/bin/env node
// Builds ONE race folder's build/course.json — the Race views' source of truth
// — from that folder's course.gpx plus the aid chart / climb windows / sun
// times in its race.json (races/<slug>/, tt-yib.2 — was config/race-course.json).
//
// Usage:  node scripts/build-course.mjs [--race <slug>]
//
//   --race <slug>   build races/<slug>/. Omitted: the active race
//                   (config/active-race.json). With no active race the run
//                   fails and lists the slugs it could have built — building
//                   "whichever race is newest" behind the athlete's back is
//                   how the wrong course.json used to reach the dashboard.
//
// Output is gitignored generated data (races/*/build/), not committed config.
// The dev server serves the active-or-most-recent race's build/course.json and
// build/crew-base.json at /course.json and /crew-base.json (web/vite.config.ts).
//
// Pipeline:
//   1. Regex-scan the GPX for track points (lat/lon/ele; ele is meters) and the
//      aid/crew/water waypoints. No XML dependency — StravaGPX is flat and stable.
//   2. Cumulative haversine distance → per-point (mi, ele_ft).
//   3. smoothProfile() (climb-lib) → clean 0.02 mi grid + hysteresis total gain.
//   4. Resolve each aid station to a GPX waypoint (aid-match.mjs: the authored
//      gpx_wpt when it still names a real waypoint, else name/mile matching),
//      then snap that waypoint to its nearest track point searching only within
//      ±SNAP_WINDOW_MI of its official mile (scaled by measured/official) so an
//      out-and-back spur can't snap the return-leg waypoint to the outbound leg.
//      A station the matcher cannot resolve confidently is NOT fatal: it falls
//      back to a track-distance snap at its charted mile and warns.
//   5. detectClimbs() over the whole course, then match each detected climb to
//      the race.json approx_mi windows by maximum overlap (raw window as
//      fallback). Any number of windows — a 50k with two climbs is as valid as
//      a 100-miler with eight.
//
// Logs measured-vs-official distance & gain and every aid snap so the numbers can
// be sanity-checked; warns on any snap > 1.5 mi off official.

import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./lib.mjs";
import { haversine, smoothProfile, detectClimbs, gainBetween } from "./climb-lib.mjs";
import { getActiveRace, listRaces, loadRaceFolder } from "./race-config.mjs";
import { matchAidStations, LOW_CONFIDENCE } from "./aid-match.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const M_PER_FT = 0.3048;
const OUT_GRID_MI = 0.05; // profile resolution written to course.json

/** ± window, in measured miles, for snapping a waypoint onto the track. */
const SNAP_WINDOW_MI = 5;

// A climb's detected start is extended back toward its authored window when the
// approach is genuinely part of the climb rather than a separate bump: net
// uphill over the approach, with no more than EXTEND_MAX_DRAWDOWN_FT of
// give-back anywhere in it. Generic on purpose — a course whose first climb
// opens with a bench before the wall, and one that starts straight up, both
// want the same rule. Per-climb override: race.json race_climbs[].extend_start
// = false to disable, or a number to set that climb's drawdown budget in feet.
const EXTEND_MAX_DRAWDOWN_FT = 70;

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

/** Index of the track point whose cumulative mile is nearest `mi`. */
function nearestTrackIdx(track, mi) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < track.length; i++) {
    const d = Math.abs(track[i].mi - mi);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
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

/** `--race <slug>` (or `--race=<slug>`); null when the flag is absent. */
function parseRaceArg(argv) {
  const i = argv.indexOf("--race");
  if (i >= 0) {
    const slug = argv[i + 1];
    if (!slug || slug.startsWith("--")) throw new Error("--race needs a race slug (see races/)");
    return slug;
  }
  const eq = argv.find((a) => a.startsWith("--race="));
  return eq ? eq.slice("--race=".length) : null;
}

/** The folder to build: --race, else the active race, else a listing + error. */
async function resolveFolder(argv) {
  const requested = parseRaceArg(argv) ?? (await getActiveRace(ROOT));
  const known = await listRaces(ROOT);
  if (!requested) {
    const slugs = known.map((r) => r.slug);
    throw new Error(
      slugs.length
        ? `no active race — pass --race <slug>. Available: ${slugs.join(", ")}`
        : "no active race and no folders under races/ — nothing to build"
    );
  }
  if (!known.some((r) => r.slug === requested)) {
    const slugs = known.map((r) => r.slug);
    throw new Error(
      `no race folder "${requested}"${slugs.length ? ` — available: ${slugs.join(", ")}` : " — races/ is empty"}`
    );
  }
  return loadRaceFolder(ROOT, requested);
}

async function main() {
  const folder = await resolveFolder(process.argv.slice(2));
  const buildDir = path.join(folder.dir, "build");
  const outPath = path.join(buildDir, "course.json");
  const gpxPath = path.join(folder.dir, "course.gpx");
  const gpx = await fs.readFile(gpxPath, "utf8");
  const race = folder.race;

  const track = cumulativeMiles(parseTrack(gpx));
  const waypoints = parseWaypoints(gpx);
  const measuredDist = track[track.length - 1].mi;

  const { grid, rawGrid, gain_ft: measuredGain } = smoothProfile(
    track.map((p) => ({ mi: p.mi, ele_ft: p.ele_ft }))
  );

  // race.json names these distance_mi / gain_ft; they are still the OFFICIAL
  // chart figures, against which the GPX-measured ones are compared.
  const officialDist = race.distance_mi;
  const officialGain = race.gain_ft;
  const scale = measuredDist / officialDist; // measured miles per official mile

  console.log(`── ${race.name} (${folder.slug}) · course build ──`);
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

  // ── Aid stations: resolve to a waypoint, then snap to the track ─────────
  // The authored gpx_wpt is still authoritative when it names a real waypoint;
  // when it doesn't (a typo, or the organizer re-exported the GPX with new
  // names) aid-match.mjs recovers the station by name and charted mile instead
  // of throwing the way this script used to — an unseen GPX from a race site
  // must never be able to fail the whole build. Anything it can only guess at
  // (below LOW_CONFIDENCE, or no candidate at all) warns and falls back to a
  // plain track-distance snap at the station's charted mile.
  const wptByName = new Map(waypoints.map((w) => [w.name, w]));
  const matches = matchAidStations(race.aid_stations, {
    waypoints: waypoints.map((w) => ({ name: w.name, lat: w.lat, lon: w.lon })),
    track: track.map((p) => ({ lat: p.lat, lon: p.lon, cum_mi: p.mi })),
  }, { scale });
  const lastStationIdx = race.aid_stations.length - 1;
  const aid_stations = race.aid_stations.map((a, i) => {
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
      // optional %-slowdown for technical tread on the segment INTO this
      // station (editable in the folder's race.json; consumed by the race
      // pace projection on top of grade adjustment). Validated loudly: a
      // hand-edited "5%" or negative value would otherwise NaN-poison or
      // silently speed up every ETA downstream.
      tech_pct: (() => {
        const raw = a.tech_pct ?? 0;
        // reject booleans/arrays up front — Number(true) is 1 and would
        // silently become a 1% tech factor instead of failing the build
        const t = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
        if (!Number.isFinite(t) || t < 0 || t > 50) {
          throw new Error(`aid station "${a.name}": tech_pct ${JSON.stringify(a.tech_pct)} must be a number in [0, 50]`);
        }
        return t;
      })(),
    };
    // The last station with no authored waypoint is the finish line, and the
    // finish line is where the track stops — no matching needed, and no GPX
    // ever marks it. (Generic: it is the definition of a course's end.)
    if (!a.gpx_wpt && i === lastStationIdx) {
      const end = track[track.length - 1];
      base.gpx_mi = +measuredDist.toFixed(3);
      base.lat = +end.lat.toFixed(5);
      base.lon = +end.lon.toFixed(5);
      console.log(`  ${a.name.padEnd(16)} official ${a.total_mi.toFixed(1)} → track end ${measuredDist.toFixed(2)} mi (finish)`);
      return base;
    }

    const match = matches[i];
    const resolved = match.confidence >= LOW_CONFIDENCE ? match.gpx_wpt : null;
    if (resolved && resolved !== a.gpx_wpt) {
      console.warn(
        `⚠︎ ${a.name}: gpx_wpt ${a.gpx_wpt ? `"${a.gpx_wpt}" is not in this GPX` : "is unset"} — ` +
          `matched "${resolved}" by ${match.method} (confidence ${match.confidence})`
      );
    }
    const wpt = resolved ? wptByName.get(resolved) : null;
    if (!wpt) {
      // No confident waypoint: put the station where the chart says it is,
      // measured along the track. Lat/lon come from that track point, so the
      // crew sheet's GPS link still lands on the course rather than nowhere.
      const cand = match.candidates?.[0];
      console.warn(
        `⚠︎ ${a.name}: no confident GPX waypoint` +
          `${cand ? ` (best candidate "${cand.wpt}", score ${cand.score})` : ""}` +
          ` — snapping to the charted mile ${a.total_mi.toFixed(1)} along the track`
      );
      const at = track[nearestTrackIdx(track, a.total_mi * scale)];
      base.gpx_mi = +at.mi.toFixed(3);
      base.lat = +at.lat.toFixed(5);
      base.lon = +at.lon.toFixed(5);
      base.gpx_match = { method: match.method, confidence: match.confidence, snapped: "track-distance" };
      console.log(`  ${a.name.padEnd(16)} official ${a.total_mi.toFixed(1)} → track ${at.mi.toFixed(2)} mi (distance snap)`);
      return base;
    }
    if (match.method !== "exact") {
      base.gpx_match = { method: match.method, confidence: match.confidence, wpt: resolved };
    }
    base.lat = +wpt.lat.toFixed(5);
    base.lon = +wpt.lon.toFixed(5);
    const expectedMi = a.total_mi * scale;
    const snap = snapWaypoint(track, wpt, expectedMi, SNAP_WINDOW_MI);
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

  // ── Race climbs: detect, then match to the authored windows ────────────
  const detected = detectClimbs(grid, { minGainFt: 300, minAvgGradePct: 3 });
  console.log(`detected ${detected.length} climbs ≥300 ft / ≥3% over the course`);

  // Extend a matched climb's start back toward its authored window when the
  // approach is genuinely part of the climb — net uphill, and never giving back
  // more than `maxDrawdownFt` anywhere along the way. Detection alone starts a
  // climb at the steep wall, so a climb that opens with a gentler mile and a
  // bench would otherwise be reported shorter and steeper than it runs.
  // See EXTEND_MAX_DRAWDOWN_FT for the default and the per-climb override.
  const extendStart = (startMi, windowLoMi, maxDrawdownFt) => {
    if (!(maxDrawdownFt > 0)) return startMi; // extension disabled for this climb
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
    return net > 0 && drawdown < maxDrawdownFt ? windowLoMi : startMi;
  };

  /** race.json race_climbs[].extend_start: false = off, number = ft budget. */
  const drawdownBudget = (rc) => {
    if (rc.extend_start === false) return 0;
    if (typeof rc.extend_start === "number" && Number.isFinite(rc.extend_start)) {
      return Math.max(0, rc.extend_start);
    }
    return EXTEND_MAX_DRAWDOWN_FT;
  };

  const race_climbs = (race.race_climbs ?? []).map((rc) => {
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
      const startMi = extendStart(match.start_mi, w0, drawdownBudget(rc));
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

  // ── Crew base + drive times → build/crew-base.json ──────────────────────
  // The base is the athlete's race-week lodging: it lives in the race folder's
  // gitignored crew.private.json (or config/profile.json's `race_base`) and the
  // output goes to a separate file, so neither the address nor anything derived
  // from it ends up in course.json.
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
  // tt-yib.2: the crew base and the emergency numbers now live in the race
  // folder's gitignored crew.private.json (race.json must never carry them).
  // config/profile.json race_base stays as the fallback until tt-yib.9 drops it.
  let crewPrivate = null;
  try {
    crewPrivate = JSON.parse(await fs.readFile(path.join(folder.dir, "crew.private.json"), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error(`✗ ${folder.slug}/crew.private.json is present but unreadable: ${e.message}`);
      process.exit(1);
    }
  }
  const emergency = Array.isArray(crewPrivate?.emergency) ? crewPrivate.emergency : [];
  const raceBase = crewPrivate?.base ?? personal?.race_base;
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
    await fs.mkdir(buildDir, { recursive: true });
    await writeJsonAtomic(path.join(buildDir, "crew-base.json"), {
      generated_at: new Date().toISOString(),
      race: folder.slug,
      base,
      drives,
      // The crew sheet's emergency strip reads these from here now that they
      // are out of course.json.
      emergency,
    });
    console.log(`✓ wrote races/${folder.slug}/build/crew-base.json (gitignored — lodging address + emergency numbers)\n`);
  }

  // ── Overview-map polyline: track lat/lon downsampled to ~400 points ─────
  const trackStep = Math.max(1, Math.ceil(track.length / 400));
  const map_track = [];
  for (let i = 0; i < track.length; i += trackStep) {
    map_track.push([+track[i].lat.toFixed(5), +track[i].lon.toFixed(5)]);
  }
  const endPt = track[track.length - 1];
  map_track.push([+endPt.lat.toFixed(5), +endPt.lon.toFixed(5)]);

  // The projection's segment integrals and dwell walk assume ascending
  // gpx_mi — a bad waypoint snap (e.g. onto the wrong side of an
  // out-and-back spur) would corrupt ETAs silently downstream. Fail loudly.
  for (let i = 1; i < aid_stations.length; i++) {
    if (aid_stations[i].gpx_mi < aid_stations[i - 1].gpx_mi) {
      throw new Error(
        `aid stations out of order on the track: "${aid_stations[i].name}" snapped to mi ${aid_stations[i].gpx_mi} ` +
          `before "${aid_stations[i - 1].name}" at mi ${aid_stations[i - 1].gpx_mi} — check the GPX waypoint snap`
      );
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    race: folder.slug,
    race_name: race.name,
    source: `${race.name} — races/${folder.slug}/course.gpx + races/${folder.slug}/race.json`,
    distance_mi: +measuredDist.toFixed(3),
    gain_ft: Math.round(measuredGain),
    official_distance_mi: officialDist,
    official_gain_ft: officialGain,
    // TODO(tt-yib.5): recompute via scripts/race-sun.mjs when rebuilding a folder
    sun: race.sun,
    profile,
    aid_stations,
    race_climbs,
    /** [lat, lon] polyline for the crew-sheet overview map */
    map_track,
    /** crew rules / directions distilled from the official crew manual */
    crew_info: race.crew_info ?? null,
    /** what the aid chart / cutoffs were read from — the crew sheet names the
        document rather than carrying a hard-coded manual year */
    sources: race.sources ?? [],
  };
  await fs.mkdir(buildDir, { recursive: true });
  await writeJsonAtomic(outPath, payload);
  console.log(
    `✓ wrote course.json → races/${folder.slug}/build/course.json\n` +
      `  profile ${profile.length} pts · ${aid_stations.length} aid stations · ${race_climbs.length} climbs`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
