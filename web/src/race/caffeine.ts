import type { CaffeineConfig, FuelPlan } from "./nutrition";
import type { projectRace } from "./pacing";
import type { Course } from "./types";

/* ------------------------------------------------------------------ */
/*  Caffeine plan — WHEN to take the caffeinated gels, and what that   */
/*  actually does to you.                                             */
/*                                                                    */
/*  Carbs are demand-driven (how long is the carry, how hot is it).   */
/*  Caffeine is not: its schedule is set by darkness and the circadian */
/*  low, so it is planned here rather than inside planFuel. The two    */
/*  meet at the end — each dose is assigned to the fuel segment that   */
/*  must carry it and to the drop bag that supplies it, so the gel     */
/*  counts on the fuel table and the packing lists always reconcile.  */
/*                                                                    */
/*  Placement rule: spread `gels` evenly from nightfall to `tail_h`    */
/*  before the projected finish, never tighter than `min_spacing_h`,   */
/*  then snap each dose to a nearby aid station so the instruction is  */
/*  "take one leaving Buck Springs" and not "take one at 18:07".      */
/*  Because the window is derived from proj.finish_h, moving the goal  */
/*  slider moves the whole schedule.                                  */
/* ------------------------------------------------------------------ */

export type DoseAnchor = "leaving" | "arriving" | null;

export type CaffeineDose = {
  /** 1-based, in time order */
  n: number;
  /** elapsed race hours */
  h: number;
  mg: number;
  /** course mile, interpolated between station ETAs */
  mi: number;
  /** aid station this dose snapped to, or null if it sits mid-leg */
  station: string | null;
  at: DoseAnchor;
  /** index into fuelPlan.segments — the leg that carries this gel */
  segIdx: number;
  /** drop bag that supplies it ("Start" = the vest) */
  bag: string;
  /** taken in darkness */
  night: boolean;
};

export type CaffeinePlan = {
  doses: CaffeineDose[];
  /** gels asked for in config, before any window trimming */
  requested: number;
  /** caffeinated gels per fuel segment — parallel to fuelPlan.segments */
  perSegment: number[];
  /** caffeinated gels per drop bag, keyed by the bag's station name */
  perBag: Record<string, number>;
  /** body load sampled across the race, for the chart */
  curve: Array<{ h: number; mg: number }>;
  peak: { h: number; mg: number; mg_kg: number };
  /** every source: gels + pre-race coffee + aid-station cola */
  total_mg: number;
  gel_mg_total: number;
  at_finish_mg: number;
  /** the ergogenic band converted to absolute mg for this athlete */
  band: { lo_mg: number; hi_mg: number };
  /** peak body load crossed the top of the band */
  over_band: boolean;
  window: { fromH: number; toH: number } | null;
  /** set when fewer gels were placed than requested, or none at all */
  note: string | null;
};

const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const parseHM = (hm: string): number => {
  const m = HM.exec(hm);
  return m ? Number(m[1]) + Number(m[2]) / 60 : 0;
};

/** Caffeine still in the body at `x`, summing one exponential per dose.
    Doses in the future contribute nothing. */
function loadAt(x: number, doses: Array<[number, number]>, k: number): number {
  let s = 0;
  for (const [t, mg] of doses) if (t <= x) s += mg * Math.exp(-k * (x - t));
  return s;
}

export function planCaffeine(
  proj: NonNullable<ReturnType<typeof projectRace>>,
  course: Course,
  fuel: FuelPlan,
  raceStart: Date,
  cfg: CaffeineConfig,
): CaffeinePlan {
  const k = Math.LN2 / cfg.half_life_h;
  const finishH = proj.finish_h.avg;
  const startH = raceStart.getHours() + raceStart.getMinutes() / 60;

  // nightfall in elapsed race hours; a race starting after dark gets the
  // first sunset of the FOLLOWING evening, not a negative hour
  let duskH = parseHM(course.sun.sunset) - startH;
  if (duskH < 0) duskH += 24;
  const setClock = parseHM(course.sun.sunset);
  const riseClock = parseHM(course.sun.sunrise);
  // darkness recurs daily, so test clock-of-day rather than elapsed hours
  const isNight = (h: number) => {
    const clock = (((startH + h) % 24) + 24) % 24;
    return clock >= setClock || clock < riseClock;
  };

  const band = { lo_mg: cfg.band_lo_mg_kg * cfg.body_kg, hi_mg: cfg.band_hi_mg_kg * cfg.body_kg };

  // ---- background doses: race-morning coffee + aid-station cola ----
  const bg: Array<[number, number]> = [];
  if (cfg.pre_race_mg > 0) bg.push([-cfg.pre_race_before_h, cfg.pre_race_mg]);
  if (cfg.cola_mg > 0 && cfg.cola_cups > 0) {
    // cola shows up once real food starts going down — spread the assumed
    // cups evenly across the back half rather than pretending they're free
    const from = finishH / 2;
    const step = (finishH - from) / (cfg.cola_cups + 1);
    for (let i = 1; i <= cfg.cola_cups; i++) bg.push([from + step * i, cfg.cola_mg]);
  }

  // ---- dose window ----
  const fromH = duskH;
  const toH = finishH - cfg.tail_h;
  let note: string | null = null;
  let n = Math.max(0, cfg.gels);

  if (n === 0) {
    note = "caffeine.gels is 0 — planned caffeine-free.";
  } else if (toH <= fromH) {
    note = `no dosing window: the projected finish (${finishH.toFixed(1)} h) lands before nightfall plus the ${cfg.tail_h} h tail.`;
    n = 0;
  } else {
    // Provisional trim so the even-spacing targets start out sane. It is NOT
    // the final count and deliberately does not write `note`: the placement
    // loop below can stop earlier still once snapping perturbs the spacing, so
    // the note is derived from what actually got placed.
    const spacing = n > 1 ? (toH - fromH) / (n - 1) : Infinity;
    if (spacing < cfg.min_spacing_h) n = Math.floor((toH - fromH) / cfg.min_spacing_h) + 1;
  }

  // ---- station events available to snap to ----
  // DEPARTURES only. "Take one leaving Buck Springs" is an instruction you can
  // act on with a gel already in hand; "take one arriving" is ambiguous about
  // whether it comes out of the bag you're standing at or the one you carried.
  type Ev = { h: number; name: string; at: Exclude<DoseAnchor, null>; mi: number };
  const events: Ev[] = [];
  proj.stations.forEach((s, i) => {
    if (i === proj.stations.length - 1) return; // never anchor to the finish line
    events.push({
      h: s.eta_h.avg + s.stop_min / 60,
      name: s.station.name, at: "leaving", mi: s.station.total_mi,
    });
  });

  // mile at an arbitrary elapsed hour, interpolated between station arrivals
  const marks: Array<[number, number]> = [[0, 0], ...proj.stations.map((s) => [s.eta_h.avg, s.station.total_mi] as [number, number])];
  const mileAt = (h: number): number => {
    for (let i = 1; i < marks.length; i++) {
      if (h <= marks[i][0]) {
        const [h0, m0] = marks[i - 1], [h1, m1] = marks[i];
        const f = h1 > h0 ? (h - h0) / (h1 - h0) : 0;
        return m0 + f * (m1 - m0);
      }
    }
    return marks[marks.length - 1][1];
  };

  // ---- place the doses ----
  // Targets are re-derived after every placement: whatever time dose i
  // actually landed on, the doses still to come are spread evenly across the
  // REMAINING window. A dose that snaps early therefore pulls the rest of the
  // chain with it instead of leaving a permanent offset that blocks every
  // later station from being close enough to snap to.
  const placed: Array<{ h: number; station: string | null; at: DoseAnchor }> = [];
  const usedEvents = new Set<Ev>();
  for (let i = 0; i < n; i++) {
    const prev = placed.length ? placed[placed.length - 1].h : null;
    const left = n - 1 - i; // doses after this one
    let target = prev == null ? fromH : (left > 0 ? prev + (toH - prev) / (left + 1) : toH);
    // The up-front trim only guarantees min spacing for the UNPERTURBED plan.
    // Once a dose snaps later than its target the remaining window shrinks, so
    // the re-derived even spacing can fall under the floor — and an unsnapped
    // dose is placed at that target with no further check. Clamp it here, and
    // stop placing when the floor no longer fits: fewer, correctly spaced doses
    // beat a schedule that quietly breaks the interval the config asked for.
    if (prev != null) {
      const floor = prev + cfg.min_spacing_h;
      if (floor > toH + 1e-9) break;
      if (target < floor) target = floor;
    }
    const spacing = prev == null ? (n > 1 ? (toH - fromH) / (n - 1) : 1) : target - prev;
    // snap only when a station sits close AND snapping keeps the gap to the
    // previous dose legal — packing two gels 40 min apart is worse than an
    // unlabelled mid-leg time
    const tol = Math.min(Math.max(spacing / 3, 0.25), 0.75);
    let best: Ev | null = null;
    let bestD = Infinity;
    for (const ev of events) {
      if (usedEvents.has(ev)) continue;
      if (ev.h < 0 || ev.h > toH + tol) continue;
      if (prev != null && ev.h - prev < cfg.min_spacing_h) continue;
      const d = Math.abs(ev.h - target);
      if (d > tol || d >= bestD) continue;
      best = ev; bestD = d;
    }
    if (best) {
      usedEvents.add(best);
      placed.push({ h: best.h, station: best.name, at: best.at });
    } else {
      placed.push({ h: target, station: null, at: null });
    }
  }
  placed.sort((a, b) => a.h - b.h);
  // Report what is actually carried, never the pre-placement estimate — a note
  // promising more gels than the schedule contains is worse than no note.
  if (cfg.gels > 0 && placed.length < cfg.gels) {
    note = `window fits ${placed.length} of ${cfg.gels} gel${cfg.gels === 1 ? "" : "s"} at ${cfg.min_spacing_h} h spacing — carrying ${placed.length}.`;
  }

  // ---- attach each dose to its carrying leg and supplying bag ----
  // Legs do not tile the clock — between a leg's arriveH and the next leg's
  // departH sits the dwell at the aid station, and a dose anchored to a
  // DEPARTURE lands exactly on that boundary. Falling through that gap used to
  // drop the dose on the last leg of the race. Resolve it forward instead: a
  // dose taken while stopped belongs to the leg it is about to fuel.
  const segIdxAt = (h: number): number => {
    const segs = fuel.segments;
    for (let i = 0; i < segs.length; i++) {
      if (h >= segs[i].departH && (h < segs[i].arriveH || i === segs.length - 1)) return i;
      // in the dwell before this leg departs (or before the race starts)
      if (h < segs[i].departH) return i;
    }
    return Math.max(0, segs.length - 1);
  };
  // the bag that packs a leg is the last drop bag reached at or before that
  // leg departs — the same conservative rule planFuel uses to partition legs
  const bagFor = (departH: number): string => {
    let name = fuel.drop_bags.length ? fuel.drop_bags[0].station : "Start";
    for (const b of fuel.drop_bags) if (b.atH <= departH + 1e-9) name = b.station;
    return name;
  };

  const doses: CaffeineDose[] = placed.map((p, i) => {
    const segIdx = segIdxAt(p.h);
    const seg = fuel.segments[segIdx];
    return {
      n: i + 1,
      h: p.h,
      mg: cfg.gel_mg,
      mi: p.station != null ? (events.find((e) => e.name === p.station && e.at === p.at)?.mi ?? mileAt(p.h)) : mileAt(p.h),
      station: p.station,
      at: p.at,
      segIdx,
      bag: seg ? bagFor(seg.departH) : "Start",
      night: isNight(p.h),
    };
  });

  const perSegment = fuel.segments.map(() => 0);
  const perBag: Record<string, number> = {};
  for (const b of fuel.drop_bags) perBag[b.station] = 0;
  for (const d of doses) {
    if (perSegment[d.segIdx] != null) perSegment[d.segIdx]++;
    perBag[d.bag] = (perBag[d.bag] ?? 0) + 1;
  }

  // ---- pharmacokinetics ----
  const all: Array<[number, number]> = [...bg, ...doses.map((d) => [d.h, d.mg] as [number, number])];
  const curve: Array<{ h: number; mg: number }> = [];
  const from = Math.min(-cfg.pre_race_before_h - 0.5, -0.5);
  const to = finishH + 0.5;
  const STEP = 0.05;
  let peak = { h: 0, mg: 0, mg_kg: 0 };
  for (let x = from; x <= to + 1e-9; x += STEP) {
    const mg = loadAt(x, all, k);
    curve.push({ h: x, mg });
    if (mg > peak.mg) peak = { h: x, mg, mg_kg: mg / cfg.body_kg };
  }

  const gel_mg_total = doses.reduce((a, d) => a + d.mg, 0);
  return {
    doses, requested: cfg.gels, perSegment, perBag, curve, peak,
    total_mg: gel_mg_total + bg.reduce((a, b) => a + b[1], 0),
    gel_mg_total,
    at_finish_mg: loadAt(finishH, all, k),
    band,
    over_band: peak.mg > band.hi_mg,
    window: n > 0 ? { fromH, toH } : null,
    note,
  };
}

/** Sunrise in elapsed race hours — exported for the chart's night band. */
export function sunBounds(course: Course, raceStart: Date, horizonH: number) {
  const startH = raceStart.getHours() + raceStart.getMinutes() / 60;
  const set = parseHM(course.sun.sunset);
  const rise = parseHM(course.sun.sunrise);
  const out: Array<[number, number]> = [];
  let s = set - startH;
  if (s < 0) s += 24;
  for (; s < horizonH; s += 24) out.push([Math.max(0, s), Math.min(horizonH, s + (24 - set + rise))]);
  // a pre-dawn start runs in the dark before the first sunrise
  if (startH < rise) out.unshift([0, Math.min(horizonH, rise - startH)]);
  return out;
}

/** Heat windows in elapsed race hours, one per race day. */
export function heatBands(startClock: number, from: string, to: string, horizonH: number) {
  const a = parseHM(from) - startClock;
  const b = parseHM(to) - startClock;
  const out: Array<[number, number]> = [];
  for (let d = Math.floor(-a / 24) * 24; d + a < horizonH; d += 24) {
    const s = Math.max(0, d + a), e = Math.min(horizonH, d + b);
    if (e > s) out.push([s, e]);
  }
  return out;
}
