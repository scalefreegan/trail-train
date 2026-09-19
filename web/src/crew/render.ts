import { fmtElapsed, fmtRaceClock, type RaceProjection } from "../race/pacing";
import { raceStart } from "../race/clock";
import type { CrewData, CrewStation } from "./crewData";

/* ------------------------------------------------------------------ */
/*  The crew page's markup, as a pure string function.                 */
/*                                                                     */
/*  No DOM here on purpose: main.ts does the one innerHTML assignment, */
/*  and everything above it can be unit-tested under `node --test`     */
/*  (scripts/crew-export.test.mjs imports this file type-stripped).    */
/*  That is also why every value is escaped on the way in — the same   */
/*  function has to be safe whether a Document is involved or not.     */
/*                                                                     */
/*  Bead tt-cv1b0.7 ships the MINIMUM that proves the pipeline: one    */
/*  station table (name, mile, expected ETA, cutoff) rendered from     */
/*  a LOCAL re-projection. Bead 08 fleshes this out into the real      */
/*  handout — drive times, pickups, emergency strip, map, profile —    */
/*  from the same CrewData, which already carries all of it.           */
/* ------------------------------------------------------------------ */

/** Text → HTML text. Ampersand first, or the other escapes get re-escaped. */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The rows the table renders: the embedded stations, with their ETAs replaced
 * by a LIVE projection when one was computed in the page.
 *
 * The embedded `projection` and a fresh local one agree at export time (the
 * exporter ran the same function on the same inputs), so this swap is a no-op
 * on first open. It stops being one the moment bead 08's checkpoint updater
 * re-projects from an observed split — at which point the table must follow
 * the new projection, not the frozen one. Wiring that path now means the page
 * has always been reading a live projection, rather than bead 08 discovering
 * that the table was hard-wired to the snapshot.
 */
export function stationRows(data: CrewData, live: RaceProjection | null): CrewStation[] {
  const frozen = data.projection.stations;
  if (!live || live.stations.length !== frozen.length) return frozen;
  const start = raceStart(data.race.date, data.race.start_time, data.race.timezone);
  const clock = (h: number) => fmtRaceClock(start, h, data.race.timezone);
  return frozen.map((row, i) => {
    const s = live.stations[i];
    return {
      ...row,
      stop_min: s.stop_min,
      eta_h: s.eta_h,
      clock: { best: clock(s.eta_h.best), avg: clock(s.eta_h.avg), worst: clock(s.eta_h.worst) },
      goal_eta_h: s.goal_eta_h,
      goal_clock: s.goal_eta_h == null ? null : clock(s.goal_eta_h),
      cutoff_margin_h: s.cutoff_margin_h,
      cutoff_margin_worst_h: s.cutoff_margin_worst_h,
    };
  });
}

/** "crew · drop bag" — how the crew reads a row at a glance. */
function accessLabel(s: CrewStation): string {
  const tags: string[] = [];
  if (s.crew_only) tags.push("crew only");
  else if (s.crew) tags.push("crew");
  if (s.drop_bag) tags.push("drop bag");
  if (s.pacers) tags.push("pacer");
  if (s.water_only) tags.push("water only");
  return tags.join(" · ");
}

function stationRowHtml(s: CrewStation): string {
  const crewRow = s.crew || s.crew_only;
  return (
    `<tr class="${crewRow ? "crew" : ""}" data-station="${esc(s.name)}">` +
    `<th scope="row">${esc(s.name)}<span class="access">${esc(accessLabel(s))}</span></th>` +
    `<td class="num">${s.total_mi.toFixed(1)}</td>` +
    `<td class="num eta">${esc(s.clock.avg)}<span class="elapsed">${esc(fmtElapsed(s.eta_h.avg))}</span></td>` +
    `<td class="num">${s.cutoff_clock ? esc(s.cutoff_clock) : "—"}</td>` +
    `</tr>`
  );
}

/** The whole page body. Returned as a string and assigned once by main.ts. */
export function renderCrewPage(data: CrewData, live: RaceProjection | null): string {
  const rows = stationRows(data, live);
  const finish = live?.finish_h ?? data.projection.finish_h;
  const start = raceStart(data.race.date, data.race.start_time, data.race.timezone);
  const finishClock = live
    ? fmtRaceClock(start, finish.avg, data.race.timezone)
    : data.projection.finish_clock.avg;
  const goalH = live?.goal_h ?? data.projection.goal_h;

  return (
    `<header>` +
    `<h1>${esc(data.race.name)} — crew sheet</h1>` +
    `<p class="sub">` +
    `${esc(data.race.date)} · start ${esc(data.race.start_time)} ${esc(data.race.timezone)}` +
    ` · ${data.race.distance_mi} mi / ${data.race.gain_ft.toLocaleString("en-US")} ft` +
    `</p>` +
    `<p class="sub">` +
    `expected finish <strong>${esc(fmtElapsed(finish.avg))}</strong> (${esc(finishClock)})` +
    ` · range ${esc(fmtElapsed(finish.best))}–${esc(fmtElapsed(finish.worst))}` +
    (goalH != null ? ` · goal ${esc(fmtElapsed(goalH))}` : "") +
    `</p>` +
    `</header>` +
    `<table id="stations">` +
    `<caption>expected arrival per station — crew stops in bold</caption>` +
    `<thead><tr><th scope="col">station</th><th scope="col">mile</th>` +
    `<th scope="col">expected</th><th scope="col">cutoff</th></tr></thead>` +
    `<tbody>${rows.map(stationRowHtml).join("")}</tbody>` +
    `</table>` +
    `<footer>` +
    `<p>exported ${esc(data.generated_at.slice(0, 16).replace("T", " "))} UTC · ` +
    `fatigue ${data.knobs.fatiguePctPer10mi}%/10mi · calibration ${data.knobs.calibrationPct}% · ` +
    `restraint ${data.knobs.restraintPct}% · aid ${data.knobs.aidStopMin}m / crew ${data.knobs.crewStopMin}m</p>` +
    `<p>${esc(data.projection.grade_basis)}</p>` +
    `<p>This file is self-contained: it needs no network, and every time on it is race-local wall clock.</p>` +
    `</footer>`
  );
}
