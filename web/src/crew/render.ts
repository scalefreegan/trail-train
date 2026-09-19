import { fmtElapsed, fmtRaceClock, type RaceProjection, type Scenario } from "../race/pacing";
import { raceStart } from "../race/clock";
import type { CrewData, CrewPickup, CrewStation } from "./crewData";
import type { FuelSegment } from "../race/nutrition";
import type { CheckpointResult } from "./checkpoint";

/* ------------------------------------------------------------------ */
/*  The crew page's markup, as a pure string function.                 */
/*                                                                     */
/*  No DOM here on purpose: main.ts does the one innerHTML assignment, */
/*  and everything above it can be unit-tested under `node --test`     */
/*  (scripts/crew-export.test.mjs imports this file type-stripped).    */
/*  That is also why every value is escaped on the way in — the same   */
/*  function has to be safe whether a Document is involved or not.     */
/*                                                                     */
/*  Bead tt-cv1b0.7 shipped the minimum that proved the pipeline. This */
/*  is bead tt-cv1b0.8: the handout itself — header, station table     */
/*  with the three ETAs and the cutoff margins, the emergency strip,   */
/*  what to hand over at each crew stop, the crew rules and per-stop   */
/*  directions, an overview map and an elevation profile drawn as      */
/*  inline SVG, and the checkpoint updater's chrome.                   */
/*                                                                     */
/*  CONTENT PARITY: the model here is CrewSheet.tsx's (the in-app      */
/*  sheet the athlete already prints), re-expressed for a file with no */
/*  React, no units toggle and no network. Two differences are         */
/*  deliberate: every distance is miles (the exported payload carries  */
/*  no unit preference), and no coordinate is a link — a maps URL in a */
/*  canyon is a tap that goes nowhere, so the page prints the numbers  */
/*  and the written directions instead.                                */
/* ------------------------------------------------------------------ */

/** Text → HTML text. Ampersand first, or the other escapes get re-escaped. */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "46m" / "1h 12m" — a drive time as a crew chief says it. */
export function fmtDrive(min: number): string {
  return min < 60 ? `${Math.round(min)}m` : `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
}

/** "4h 20m" for a carry. Same shape as nutrition.ts's fmtCarry, restated
    here because nutrition.ts pulls React in through useNutrition and this
    bundle has no framework in it at all. */
function fmtCarry(h: number): string {
  const mins = Math.round(h * 60);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** "Saturday, September 12, 2026" from a race-local YYYY-MM-DD. Formatted in
    UTC from its own civil fields: the date has no instant in it, and reading
    it in the device's zone is how a race lands on the wrong day. */
function fmtRaceDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

const round = (n: number, digits = 0) => n.toFixed(digits);
const commas = (n: number) => Math.round(n).toLocaleString("en-US");

/** Signed hours as "+1h 12m" / "−0h 08m" — how far off plan something is. */
function fmtSigned(h: number): string {
  const sign = h < 0 ? "−" : "+";
  return `${sign}${fmtElapsed(Math.abs(h))}`;
}

/**
 * The rows the table renders: the embedded stations, with their ETAs replaced
 * by a LIVE projection when one was computed in the page, and by the
 * checkpoint's re-projection once a crew chief has typed a split.
 *
 * The embedded `projection` and a fresh local one agree at export time (the
 * exporter ran the same function on the same inputs), so the first swap is a
 * no-op on open. The second is the whole point of bead 08: after a
 * checkpoint, every ETA below it moves, and the table follows the new
 * projection rather than the frozen one.
 *
 * The goal column deliberately does NOT move. A goal is a decision the
 * athlete made, not a prediction — re-solving it from a bad split would
 * quietly redefine what "on goal pace" means halfway through the race.
 */
export function stationRows(
  data: CrewData,
  live: RaceProjection | null,
  cp: CheckpointResult | null = null,
): CrewStation[] {
  const frozen = data.projection.stations;
  const source = cp ? cp.proj : live;
  if (!source || source.stations.length !== frozen.length) return frozen;
  const shift = cp ? cp.shift_h : 0;
  const start = raceStart(data.race.date, data.race.start_time, data.race.timezone);
  const clock = (h: number) => fmtRaceClock(start, h, data.race.timezone);
  const goalSource = live && live.stations.length === frozen.length ? live.stations : null;
  return frozen.map((row, i) => {
    const s = source.stations[i];
    const eta: Record<Scenario, number> = {
      best: s.eta_h.best + shift,
      avg: s.eta_h.avg + shift,
      worst: s.eta_h.worst + shift,
    };
    const goal = goalSource ? goalSource[i].goal_eta_h : row.goal_eta_h;
    return {
      ...row,
      stop_min: s.stop_min,
      eta_h: eta,
      clock: { best: clock(eta.best), avg: clock(eta.avg), worst: clock(eta.worst) },
      goal_eta_h: goal,
      goal_clock: goal == null ? null : clock(goal),
      cutoff_margin_h: row.cutoff_h == null ? null : row.cutoff_h - eta.avg,
      cutoff_margin_worst_h: row.cutoff_h == null ? null : row.cutoff_h - eta.worst,
    };
  });
}

/** The three finish times, after whatever correction is in force. */
export function finishTimes(
  data: CrewData,
  live: RaceProjection | null,
  cp: CheckpointResult | null,
): Record<Scenario, number> {
  const source = cp ? cp.proj : live;
  const shift = cp ? cp.shift_h : 0;
  if (!source) return data.projection.finish_h;
  return {
    best: source.finish_h.best + shift,
    avg: source.finish_h.avg + shift,
    worst: source.finish_h.worst + shift,
  };
}

/** "crew · drop bag" — how the crew reads a row at a glance. */
function accessLabel(s: CrewStation): string {
  const tags: string[] = [];
  if (s.crew_only) tags.push("crew only · no aid");
  else if (s.crew) tags.push("crew");
  if (s.drop_bag) tags.push("drop bag");
  if (s.pacers) tags.push("pacer");
  if (s.water_only) tags.push("water only");
  return tags.join(" · ");
}

/* ------------------------------------------------------------------ */
/*  sections                                                           */
/* ------------------------------------------------------------------ */

function headerHtml(data: CrewData, finish: Record<Scenario, number>, goalH: number | null): string {
  const race = data.race;
  const start = raceStart(race.date, race.start_time, race.timezone);
  const clock = (h: number) => fmtRaceClock(start, h, race.timezone);
  const course = data.course;
  const base = data.crew_base?.base ?? null;
  const dist = course.official_distance_mi || race.distance_mi;
  const gain = course.official_gain_ft || race.gain_ft;

  return (
    `<header id="sheet-head">` +
    `<h1>${esc(race.name)} — crew sheet</h1>` +
    `<p class="sub">${esc(fmtRaceDate(race.date))} · start <strong>${esc(clock(0))}</strong>` +
    ` (${esc(race.start_time)} ${esc(race.timezone)})` +
    ` · ${esc(round(dist, 1))} mi / ${esc(commas(gain))} ft↑` +
    (race.location ? ` · ${esc(race.location)}` : "") +
    `</p>` +
    `<p class="sub">` +
    (race.cutoff_h != null
      ? `course closes <strong>${esc(clock(race.cutoff_h))}</strong> (${esc(String(race.cutoff_h))}h)`
      : `no posted overall cutoff`) +
    (goalH != null ? ` · goal <strong>${esc(clock(goalH))}</strong> (${esc(fmtElapsed(goalH))})` : "") +
    `</p>` +
    (base
      ? `<p class="sub base">⌂ base: ${esc(base.address)}` +
        (base.drive_to_start_min != null
          ? ` · ${esc(fmtDrive(base.drive_to_start_min))} to the start` +
            (base.drive_to_start_mi != null ? ` (${esc(round(base.drive_to_start_mi, 0))} mi)` : "")
          : "") +
        `</p>`
      : "") +
    (course.crew_info?.start_notes
      ? `<p class="sub">start: ${esc(course.crew_info.start_notes)}</p>`
      : "") +
    `<p class="headline" id="finish-line">` +
    `<span class="best">${esc(clock(finish.best))} best</span>` +
    `<span class="exp">${esc(clock(finish.avg))} expected <em>${esc(fmtElapsed(finish.avg))}</em></span>` +
    `<span class="worst">${esc(clock(finish.worst))} worst</span>` +
    `<span class="stopped">${esc(fmtElapsed(data.projection.stopped_h))} planned in aid stations</span>` +
    `</p>` +
    `<p class="stamp">exported ${esc(data.generated_at.slice(0, 16).replace("T", " "))} UTC` +
    ` · every time on this sheet is ${esc(race.timezone)} wall clock</p>` +
    `</header>`
  );
}

function emergencyHtml(data: CrewData): string {
  const numbers = data.crew_base?.emergency ?? data.course.crew_info?.emergency ?? [];
  if (numbers.length === 0) return "";
  return (
    `<section id="emergency">` +
    `<b class="tag">EMERGENCY</b>` +
    numbers
      .map((e) => `<span class="num">${esc(e.label)} <strong>${esc(e.phone)}</strong></span>`)
      .join("") +
    `</section>`
  );
}

/** The updater's chrome. The status line is written by main.ts, which owns
    the applied checkpoint; everything here is the same on every render. */
function updaterHtml(data: CrewData, cp: CheckpointResult | null, message: string): string {
  const options = data.projection.stations
    .map(
      (s) =>
        `<option value="${esc(s.name)}"${cp?.station === s.name ? " selected" : ""}>` +
        `${esc(s.name)} · mi ${esc(round(s.total_mi, 1))}</option>`,
    )
    .join("");
  return (
    `<section id="updater" class="no-print">` +
    `<h2>where is she now?</h2>` +
    `<form id="checkpoint-form" autocomplete="off">` +
    `<label for="cp-station">passed</label>` +
    `<select id="cp-station" name="station"><option value="">choose a station…</option>${options}</select>` +
    `<label for="cp-clock">at</label>` +
    `<input id="cp-clock" name="clock" type="text" inputmode="numeric" placeholder="HH:MM"` +
    ` pattern="[0-9]{1,2}:[0-9]{2}" maxlength="5" value="${esc(cp?.clock ?? "")}" />` +
    `<button id="cp-apply" type="submit">update</button>` +
    `<button id="cp-clear" type="button"${cp ? "" : " disabled"}>clear</button>` +
    `</form>` +
    `<p id="cp-status" class="${cp ? "applied" : message ? "warn" : "idle"}">${message}</p>` +
    `</section>`
  );
}

/** The sentence the sheet leads with once a split has been typed. */
export function checkpointMessage(cp: CheckpointResult): string {
  const pace =
    Math.abs(cp.delta_h) < 1 / 60
      ? "exactly on plan"
      : `${esc(fmtSigned(cp.delta_h))} ${cp.delta_h > 0 ? "behind" : "ahead of"} plan` +
        ` · pace ×${esc(cp.ratio.toFixed(2))}`;
  return (
    `updated from <strong>${esc(cp.station)}</strong> at <strong>${esc(cp.clock)}</strong>` +
    ` (mi ${esc(round(cp.mile, 1))}, ${esc(fmtElapsed(cp.observed_h))} on the clock) — ${pace}` +
    (cp.clamped
      ? ` <em>· that split is far enough off the model that the pace carried forward is capped —` +
        ` the times below are held to the checkpoint, not extrapolated from it</em>`
      : "") +
    `. Everything below is re-projected; “clear” puts the exported plan back.`
  );
}

/** The first sentence of a station's written directions, capped — the table
    row is a TIMES table on a 390-px phone, and the full paragraph (all of it,
    unabridged) prints under “getting to each stop” a section later. */
function shortDirections(note: string | undefined): string {
  if (!note) return "";
  const first = /^[^.]*\./.exec(note.trim())?.[0] ?? note.trim();
  return first.length <= 96 ? first : `${first.slice(0, 95).trimEnd()}…`;
}

type RowContext = {
  drives: Record<string, { min: number; mi: number }>;
  notes: Record<string, string>;
  /** station coordinates, out of the embedded course — printed as TEXT, never
      as a maps link: the crew reading this has no signal to follow one. */
  coords: Record<string, { lat: number; lon: number }>;
};

function stationRowHtml(s: CrewStation, ctx: RowContext, cp: CheckpointResult | null, i: number): string {
  const crewRow = s.crew || s.crew_only;
  const passed = cp != null && i <= cp.index;
  const at = cp != null && i === cp.index;
  const drive = ctx.drives[s.name];
  const dir = shortDirections(ctx.notes[s.name]);
  const gps = ctx.coords[s.name];
  const margin = s.cutoff_margin_h;
  return (
    `<tr class="station${crewRow ? " crew" : ""}${passed ? " passed" : ""}${at ? " at" : ""}"` +
    ` data-station="${esc(s.name)}">` +
    `<th scope="row">` +
    `<span class="name">${esc(s.name)}</span>` +
    (accessLabel(s) ? `<span class="access">${esc(accessLabel(s))}</span>` : "") +
    (s.stop_min > 0 ? `<span class="stop">${esc(String(s.stop_min))} min stop</span>` : "") +
    (s.notes ? `<span class="note">${esc(s.notes)}</span>` : "") +
    (dir ? `<span class="dir">${esc(dir)}</span>` : "") +
    (gps ? `<span class="gps">${esc(gps.lat.toFixed(4))}, ${esc(gps.lon.toFixed(4))}</span>` : "") +
    `</th>` +
    `<td class="num mi">${esc(round(s.total_mi, 1))}</td>` +
    `<td class="num eta">` +
    `<span class="exp">${esc(s.clock.avg)}</span>` +
    `<span class="elapsed">${esc(fmtElapsed(s.eta_h.avg))}${at ? " · seen" : ""}</span>` +
    `<span class="band">${esc(s.clock.best)}–${esc(s.clock.worst)}</span>` +
    (s.goal_clock ? `<span class="goal">goal ${esc(s.goal_clock)}</span>` : "") +
    `</td>` +
    `<td class="num cut">` +
    (s.cutoff_clock ? `<span class="clock">${esc(s.cutoff_clock)}</span>` : `<span class="clock">—</span>`) +
    (margin != null
      ? `<span class="margin${margin < 0 ? " late" : margin < 1 ? " tight" : ""}">${esc(fmtSigned(margin))}</span>`
      : "") +
    `</td>` +
    `<td class="num drive">` +
    (drive ? `${esc(fmtDrive(drive.min))}<span class="miles">${esc(round(drive.mi, 0))} mi</span>` : "—") +
    `</td>` +
    `</tr>`
  );
}

function stationsHtml(data: CrewData, rows: CrewStation[], cp: CheckpointResult | null): string {
  const coords: Record<string, { lat: number; lon: number }> = {};
  for (const s of data.course.aid_stations) {
    if (s.lat != null && s.lon != null) coords[s.name] = { lat: s.lat, lon: s.lon };
  }
  const ctx: RowContext = {
    drives: data.crew_base?.drives ?? {},
    notes: data.course.crew_info?.station_notes ?? {},
    coords,
  };
  return (
    `<section id="stations-section">` +
    `<h2>stations</h2>` +
    `<table id="stations">` +
    // A fixed layout, because the browser's automatic one gives the name
    // column whatever the prose leaves over — which on a 390-px phone is
    // about eight characters.
    `<colgroup><col class="c-name" /><col class="c-mi" /><col class="c-eta" />` +
    `<col class="c-cut" /><col class="c-drive" /></colgroup>` +
    `<caption>crew stops are shaded · drive times are road estimates from the base` +
    (cp ? ` · rows down to ${esc(cp.station)} have been run` : "") +
    `</caption>` +
    `<thead><tr>` +
    `<th scope="col">station</th><th scope="col">mi</th>` +
    `<th scope="col">expected<span>best–worst</span></th>` +
    `<th scope="col">cutoff<span>margin</span></th>` +
    `<th scope="col">drive</th>` +
    `</tr></thead>` +
    `<tbody>${rows.map((r, i) => stationRowHtml(r, ctx, cp, i)).join("")}</tbody>` +
    `</table>` +
    `</section>`
  );
}

/** What the crew physically hands over at one stop.
 *
 * Not every crew stop is a fuel-plan stop. planFuel builds the NO-CREW plan —
 * drop bags are the only restock it counts on — so a crew station that is not
 * a mix-refill point has no departing leg at all. Saying "nothing on the fuel
 * plan" there and stopping would be useless to the person standing in the
 * parking lot; what they need is the leg she is in the MIDDLE of, so they can
 * see what she left with and how long it still has to last. */
function pickupHtml(p: CrewPickup, ctx: PickupContext): string {
  const seg = p.segment;
  const bag = p.drop_bag;
  const cfgFlask = ctx.flaskMl;
  const covering = seg ? null : ctx.covering(p);
  const isFinish = p.station === ctx.finishName;
  const hand: string[] = [];
  if (seg) {
    if (seg.gels > 0) hand.push(`${seg.gels} gel${seg.gels === 1 ? "" : "s"}`);
    if (seg.bloks > 0) hand.push(`${seg.bloks} blok pack${seg.bloks === 1 ? "" : "s"}`);
    if (seg.flasks > 0) {
      hand.push(
        `${seg.flasks} mix flask${seg.flasks === 1 ? "" : "s"}` +
          (cfgFlask ? ` (${seg.flasks} HCF scoop${seg.flasks === 1 ? "" : "s"}, ${cfgFlask} mL each)` : ""),
      );
    }
    if (seg.water_flasks > 0) hand.push(`${seg.water_flasks} water flask${seg.water_flasks === 1 ? "" : "s"}`);
    if (seg.salt_tabs > 0) hand.push(`${seg.salt_tabs} salt tab${seg.salt_tabs === 1 ? "" : "s"}`);
  }
  return (
    `<article class="pickup" data-station="${esc(p.station)}">` +
    `<h3>${esc(p.station)}<span class="when">mi ${esc(round(p.total_mi, 1))} · expected ${esc(p.clock)}` +
    ` · ${esc(fmtElapsed(p.eta_h))}</span></h3>` +
    (isFinish
      ? ""
      : `<p class="hand"><b>hand over:</b> ` +
        (hand.length > 0
          ? esc(hand.join(" · "))
          : "nothing the plan counts on here — water, ice and whatever she asks for") +
        (seg ? ` · <span class="fill">fill ${esc(seg.fill)}</span>` : "") +
        `</p>`) +
    (seg
      ? `<p class="leg"><b>leg out:</b> ${esc(seg.from)} → ${esc(seg.to)} · ${esc(fmtCarry(seg.carryH))} carry` +
        ` · ${esc(String(seg.carb_g))} g carbs · ${esc((seg.fluid_ml / 1000).toFixed(1))} L` +
        (seg.via.length > 0 ? ` · through ${esc(seg.via.join(", "))} with no resupply` : "") +
        (seg.water_note ? ` · ${esc(seg.water_note)}` : "") +
        (seg.night ? ` · <b class="night">night</b>` : "") +
        (seg.heat ? ` · <b class="heat">heat</b>` : "") +
        seg.preloads
          .map((pl) => ` · drink ${esc(String(pl.ml))} mL at ${esc(pl.at ?? "the aid table")} before leaving`)
          .join("") +
        (seg.ration ? ` · <b class="heat">ration the carry</b>` : "") +
        `</p>`
      : isFinish
        ? `<p class="leg"><b>at the finish:</b> dry clothes, somewhere to sit and real food — no leg out of here.</p>`
        : covering
          ? `<p class="leg"><b>carrying through:</b> she is mid-leg — left ${esc(covering.from)} at` +
            ` ${esc(ctx.clock(covering.departH))} with ${esc(String(covering.gels))} gel` +
            `${covering.gels === 1 ? "" : "s"} and ${esc(covering.fill)}, due into ${esc(covering.to)}` +
            ` around ${esc(ctx.clock(covering.arriveH))} (${esc(fmtCarry(covering.carryH))} carry).</p>`
          : `<p class="leg"><b>leg out:</b> none on the plan — water, a top-up and go.</p>`) +
    (bag
      ? `<p class="bag"><b>drop bag here:</b> ${esc(String(bag.gels))} gel · ${esc(String(bag.bloks))} blok` +
        ` · ${esc(String(bag.hcf_scoops))} HCF scoop · ${esc(String(bag.salt_tabs))} tab` +
        (bag.gear.length > 0 ? ` · ${esc(bag.gear.join(" · "))}` : "") +
        ` <span class="covers">covers ${esc(bag.covers)}</span></p>`
      : "") +
    `</article>`
  );
}

type PickupContext = {
  flaskMl: number | null;
  finishName: string;
  /** race-local wall clock at an elapsed hour */
  clock: (h: number) => string;
  /** the leg in progress at a crew stop that starts none */
  covering: (p: CrewPickup) => FuelSegment | null;
};

function pickupsHtml(data: CrewData): string {
  if (data.crew_pickups.length === 0) return "";
  const start = raceStart(data.race.date, data.race.start_time, data.race.timezone);
  const segments = data.fuel?.segments ?? [];
  const ctx: PickupContext = {
    flaskMl: data.nutrition?.flask_ml ?? null,
    finishName: data.projection.stations[data.projection.stations.length - 1]?.name ?? "",
    clock: (h) => fmtRaceClock(start, h, data.race.timezone),
    covering: (p) =>
      segments.find((sg) => p.eta_h > sg.departH && p.eta_h <= sg.arriveH) ??
      segments.find((sg) => sg.via.includes(p.station)) ??
      null,
  };
  return (
    `<section id="pickups">` +
    `<h2>what she takes from you</h2>` +
    `<p class="lead">One block per crew stop, in course order: what to be holding when she runs in, and the` +
    ` leg it has to cover. The quantities are the fuel plan as exported — which is the NO-CREW plan, where the` +
    ` drop bags are the only restock, so at a stop with no leg of its own you are a bonus rather than the plan.` +
    ` If she is eating more than this, believe her.</p>` +
    data.crew_pickups.map((p) => pickupHtml(p, ctx)).join("") +
    `</section>`
  );
}

function crewNotesHtml(data: CrewData): string {
  const info = data.course.crew_info ?? data.race.crew_info ?? null;
  const stations = data.projection.stations;
  const crewNames = stations.filter((s) => s.crew || s.crew_only).map((s) => s.name);
  const dropNames = stations.filter((s) => s.drop_bag).map((s) => s.name);
  const firstPacer = stations.find((s) => s.pacers);
  const sun = data.course.sun ?? data.race.sun ?? null;
  const cutoffSource = (() => {
    const sources = data.course.sources ?? data.race.sources ?? [];
    const manual = sources.find((s) => /manual|guide|handbook/i.test(s.ref));
    const ref = (manual ?? sources.find((s) => s.kind !== "gpx"))?.ref;
    return ref ? ref.replace(/\s*\([^)]*\)\s*$/, "") : "the official runner manual";
  })();

  return (
    `<section id="crew-notes">` +
    `<h2>crew rules</h2>` +
    `<ul class="facts">` +
    (crewNames.length > 0
      ? `<li><b>crew access:</b> ${esc(crewNames.join(", "))}` +
        (info?.driving ? ` — ${esc(info.driving)}` : "") +
        `</li>`
      : "") +
    (dropNames.length > 0 ? `<li><b>drop bags:</b> ${esc(dropNames.join(", "))}</li>` : "") +
    (firstPacer
      ? `<li><b>pacers:</b> from ${esc(firstPacer.name)} (mi ${esc(round(firstPacer.total_mi, 0))}) onward, one at a time</li>`
      : "") +
    (sun
      ? `<li><b>night:</b> sunset ${esc(sun.sunset)} · sunrise ${esc(sun.sunrise)} — lights and warm layers ride in the bags above</li>`
      : "") +
    (info?.cell_strategy ? `<li><b>cell service:</b> ${esc(info.cell_strategy)}</li>` : "") +
    `<li><b>if she drops:</b> she reports to the aid-station captain in person — nobody leaves the course unreported.</li>` +
    `</ul>` +
    (info?.rules && info.rules.length > 0
      ? `<ol class="rules">${info.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ol>`
      : "") +
    directionsHtml(data) +
    `<p class="fineprint">ETAs are Basecamp's pacing model (best/worst are the fit's ± band); cutoffs are from` +
    ` ${esc(cutoffSource)}. Drive times are road estimates from the base — forest roads vary, so add buffer and` +
    ` trust the official crew guide over this sheet where they disagree.</p>` +
    `</section>`
  );
}

/**
 * The written directions, in full, one paragraph per stop.
 *
 * Every crew-access station gets one whether the manual had prose for it or
 * not, because this section is also where the coordinates and the drive time
 * print: the table's directions line is abridged and its GPS line is
 * screen-only, so this is the copy a crew chief reads off paper.
 */
function directionsHtml(data: CrewData): string {
  const info = data.course.crew_info ?? data.race.crew_info ?? null;
  const notes: Record<string, string> = info?.station_notes ?? {};
  const drives = data.crew_base?.drives ?? {};
  const coords = new Map(
    data.course.aid_stations
      .filter((s) => s.lat != null && s.lon != null)
      .map((s) => [s.name, `${(s.lat as number).toFixed(4)}, ${(s.lon as number).toFixed(4)}`]),
  );
  const crewStops = data.projection.stations.filter((s) => s.crew || s.crew_only).map((s) => s.name);
  const names = [...crewStops, ...Object.keys(notes).filter((n) => !crewStops.includes(n))];
  if (names.length === 0 && !info?.start_notes) return "";
  return (
    `<div id="directions">` +
    `<h3>getting to each stop</h3>` +
    (info?.start_notes ? `<p><b>start / parking.</b> ${esc(info.start_notes)}</p>` : "") +
    names
      .map((name) => {
        const drive = drives[name];
        const gps = coords.get(name);
        return (
          `<p data-station="${esc(name)}"><b>${esc(name)}` +
          (drive ? ` (${esc(fmtDrive(drive.min))} drive · ${esc(round(drive.mi, 0))} mi)` : "") +
          `.</b> ${notes[name] ? `${esc(notes[name])} ` : ""}` +
          (gps ? `<span class="gps">${esc(gps)}</span>` : "") +
          `</p>`
        );
      })
      .join("") +
    `</div>`
  );
}

/* ------------------------------------------------------------------ */
/*  drawings — inline SVG, no library, no tiles                        */
/* ------------------------------------------------------------------ */

/** The overview map: the course polyline with the crew stops called out.
    Equirectangular with a cos(lat) correction, which is exact enough over a
    course that spans a few tens of miles and needs no projection library. */
export function mapSvg(data: CrewData): string {
  const pts = data.course.map_track ?? [];
  if (pts.length < 2) return "";
  const base = data.crew_base?.base ?? null;
  const lats = pts.map((p) => p[0]);
  const lons = pts.map((p) => p[1]);
  if (base) {
    lats.push(base.lat);
    lons.push(base.lon);
  }
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1;
  const W = 700;
  const PAD = 38;
  const spanX = (maxLon - minLon) * kx || 1;
  const spanY = maxLat - minLat || 1;
  const H = Math.max(220, Math.min(900, Math.round(W * (spanY / spanX))));
  const xAt = (lon: number) => PAD + ((lon - minLon) * kx / spanX) * (W - 2 * PAD);
  const yAt = (lat: number) => PAD + ((maxLat - lat) / spanY) * (H - 2 * PAD);
  const path = pts
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(p[1]).toFixed(1)} ${yAt(p[0]).toFixed(1)}`)
    .join(" ");

  const placed = data.course.aid_stations.filter((s) => s.lat != null && s.lon != null);
  const crew = placed
    .filter((s) => s.crew || s.crew_only)
    .sort((a, b) => yAt(a.lat as number) - yAt(b.lat as number));
  // greedy de-collision: a label that would land on a neighbour drops a line
  const labels: string[] = [];
  const taken: { x: number; y: number }[] = [];
  for (const s of crew) {
    const x = xAt(s.lon as number);
    const y = yAt(s.lat as number);
    let ly = y + 4;
    while (taken.some((t) => Math.abs(t.y - ly) < 13 && Math.abs(t.x - x) < 190)) ly += 13;
    taken.push({ x, y: ly });
    const left = x > W * 0.68;
    labels.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" class="crew-dot" />` +
        `<text x="${(left ? x - 8 : x + 8).toFixed(1)}" y="${ly.toFixed(1)}"` +
        ` text-anchor="${left ? "end" : "start"}" class="crew-label">` +
        `${esc(s.name)} · ${esc(round(s.total_mi, 0))} mi</text>`,
    );
  }
  const otherDots = placed
    .filter((s) => !(s.crew || s.crew_only))
    .map(
      (s) =>
        `<circle cx="${xAt(s.lon as number).toFixed(1)}" cy="${yAt(s.lat as number).toFixed(1)}" r="2.6" class="aid-dot" />`,
    )
    .join("");
  const startX = xAt(pts[0][1]);
  const startY = yAt(pts[0][0]);
  const startLeft = startX > W * 0.68;

  return (
    `<svg id="course-map" viewBox="0 0 ${W} ${H + 26}" role="img" aria-label="course overview">` +
    `<path d="${path}" class="track" />` +
    otherDots +
    labels.join("") +
    `<circle cx="${startX.toFixed(1)}" cy="${startY.toFixed(1)}" r="4.5" class="start-dot" />` +
    `<text x="${(startLeft ? startX - 8 : startX + 8).toFixed(1)}" y="${(startY + 4).toFixed(1)}"` +
    ` text-anchor="${startLeft ? "end" : "start"}" class="start-label">START</text>` +
    (base
      ? `<rect x="${(xAt(base.lon) - 5).toFixed(1)}" y="${(yAt(base.lat) - 5).toFixed(1)}" width="10" height="10" class="base-dot" />` +
        `<text x="${(xAt(base.lon) + 9).toFixed(1)}" y="${(yAt(base.lat) + 4).toFixed(1)}" class="base-label">` +
        `⌂ BASE — ${esc(base.address.split(",")[0])}</text>`
      : "") +
    `<text x="${W - 8}" y="${H + 18}" text-anchor="end" class="legend">` +
    `● crew access · ○ runner-only aid · line = course</text>` +
    `</svg>`
  );
}

/** The elevation profile, with a tick per aid station and the crew stops
    named. Drawn in MEASURED (gpx) miles — the profile's own axis. */
export function profileSvg(data: CrewData): string {
  const profile = data.course.profile ?? [];
  if (profile.length < 2) return "";
  const W = 700;
  const H = 190;
  const PAD_L = 42, PAD_R = 10, PAD_T = 14, PAD_B = 46;
  const maxMi = profile[profile.length - 1].mi || 1;
  let minEle = Infinity, maxEle = -Infinity;
  for (const p of profile) {
    if (p.ele_ft < minEle) minEle = p.ele_ft;
    if (p.ele_ft > maxEle) maxEle = p.ele_ft;
  }
  const lo = Math.floor(minEle / 500) * 500;
  const hi = Math.ceil(maxEle / 500) * 500;
  const xAt = (mi: number) => PAD_L + (mi / maxMi) * (W - PAD_L - PAD_R);
  const yAt = (ft: number) => PAD_T + (1 - (ft - lo) / (hi - lo || 1)) * (H - PAD_T - PAD_B);

  // ~1 point per output pixel: 1,700 profile points is more resolution than
  // the drawing has, and the whole file is opened on a phone.
  const step = Math.max(1, Math.ceil(profile.length / (W - PAD_L - PAD_R)));
  const sampled = profile.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== profile[profile.length - 1]) sampled.push(profile[profile.length - 1]);
  const line = sampled
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(p.mi).toFixed(1)} ${yAt(p.ele_ft).toFixed(1)}`)
    .join(" ");
  const area = `${line} L ${xAt(maxMi).toFixed(1)} ${yAt(lo).toFixed(1)} L ${xAt(0).toFixed(1)} ${yAt(lo).toFixed(1)} Z`;

  const gridLines: string[] = [];
  for (let ft = lo; ft <= hi; ft += 1000) {
    gridLines.push(
      `<line x1="${PAD_L}" y1="${yAt(ft).toFixed(1)}" x2="${W - PAD_R}" y2="${yAt(ft).toFixed(1)}" class="grid" />` +
        `<text x="${PAD_L - 6}" y="${(yAt(ft) + 3).toFixed(1)}" text-anchor="end" class="axis">${esc(commas(ft))}</text>`,
    );
  }

  const ticks = data.course.aid_stations
    .map((s, i) => {
      const crew = s.crew || s.crew_only;
      const x = xAt(s.gpx_mi);
      const tick =
        `<line x1="${x.toFixed(1)}" y1="${PAD_T}" x2="${x.toFixed(1)}" y2="${(H - PAD_B).toFixed(1)}"` +
        ` class="tick${crew ? " crew" : ""}" />`;
      if (!crew) return tick;
      // crew names alternate between two baselines so they cannot overprint,
      // and the first/last labels anchor inwards rather than off the edge of
      // the drawing (the finish is always at x = the right margin)
      const y = H - PAD_B + 14 + (i % 2) * 12;
      const anchor = x < PAD_L + 40 ? "start" : x > W - PAD_R - 40 ? "end" : "middle";
      return (
        tick +
        `<text x="${x.toFixed(1)}" y="${y}" text-anchor="${anchor}" class="tick-label">` +
        `${esc(s.name)}</text>`
      );
    })
    .join("");

  return (
    `<svg id="course-profile" viewBox="0 0 ${W} ${H}" role="img" aria-label="elevation profile">` +
    gridLines.join("") +
    `<path d="${area}" class="profile-fill" />` +
    `<path d="${line}" class="profile-line" />` +
    ticks +
    `<text x="${W - PAD_R}" y="${H - 4}" text-anchor="end" class="legend">` +
    `${esc(round(maxMi, 1))} mi · ${esc(commas(lo))}–${esc(commas(hi))} ft · ticks = aid stations, named = crew</text>` +
    `</svg>`
  );
}

function drawingsHtml(data: CrewData): string {
  const map = mapSvg(data);
  const profile = profileSvg(data);
  if (!map && !profile) return "";
  return (
    `<section id="drawings">` +
    (map ? `<h2>the course</h2><div id="map">${map}</div>` : "") +
    (profile ? `<div id="profile">${profile}</div>` : "") +
    `</section>`
  );
}

function footerHtml(data: CrewData): string {
  const k = data.knobs;
  return (
    `<footer>` +
    `<p>fatigue ${esc(String(k.fatiguePctPer10mi))}%/10mi · calibration ${esc(String(k.calibrationPct))}%` +
    ` · restraint ${esc(String(k.restraintPct))}% · aid ${esc(String(k.aidStopMin))}m / crew ${esc(String(k.crewStopMin))}m` +
    (k.altitude ? ` · altitude ${esc(String(k.altitude.pct))}%` : "") +
    `</p>` +
    `<p>${esc(data.projection.grade_basis)}</p>` +
    `<p>This file is self-contained: it needs no network, no app and no signal. Every time on it is race-local` +
    ` wall clock, and the checkpoint updater re-runs the same projection offline.</p>` +
    `</footer>`
  );
}

/**
 * The whole page body. Returned as a string and assigned once by main.ts.
 *
 * @param live the page's own re-projection, or null when it could not be run
 * @param cp the applied checkpoint, or null
 * @param message the updater's status line (already HTML)
 */
export function renderCrewPage(
  data: CrewData,
  live: RaceProjection | null,
  cp: CheckpointResult | null = null,
  message = "",
): string {
  const rows = stationRows(data, live, cp);
  const finish = finishTimes(data, live, cp);
  const goalH = (live ?? cp?.proj)?.goal_h ?? data.projection.goal_h;
  return (
    headerHtml(data, finish, goalH) +
    emergencyHtml(data) +
    updaterHtml(data, cp, message) +
    stationsHtml(data, rows, cp) +
    pickupsHtml(data) +
    crewNotesHtml(data) +
    drawingsHtml(data) +
    footerHtml(data)
  );
}
