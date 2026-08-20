import { useEffect, useState } from "react";
import { useRefresh } from "../data";
import type { projectRace } from "./pacing";
import type { Course } from "./types";

/* ------------------------------------------------------------------ */
/*  Fueling model — per-segment carb / sodium / fluid plan derived     */
/*  from the pacing projection's EXPECTED splits. Constants come from  */
/*  web/public/nutrition.json (user-editable) with DEFAULTS below as   */
/*  the fallback. All math is departure-oriented: a FuelSegment is     */
/*  what you carry OUT of `from` to reach `to`.                        */
/* ------------------------------------------------------------------ */

export type NutritionConfig = {
  flask_ml: number;
  tailwind_flasks: number;
  /** carbs per filled Tailwind flask (base mix + high-carb scoop), grams */
  flask_carb_g: number;
  flask_sodium_mg: number;
  water_flask_ml: number;
  /** plain water the runner always keeps in hand — never budgeted as intake */
  water_reserve_ml: number;
  /** 5th flask carried empty; filled with PLAIN WATER on 5F legs (no scoop) */
  spare_flask_ml: number;
  /** how fast the drink mix is actually consumed, g carb per hour */
  liquid_carb_rate_g_hr: number;
  gel: { carb_g: number; sodium_mg: number; label: string };
  bloks: { carb_g: number; sodium_mg: number; label: string };
  salt_tab_mg: number;
  /** bloks_frac: share of the phase's carried units taken as bloks, 0..1 */
  phases: { until_h: number; carb_g_hr: number; bloks_frac?: number; supplement: string }[];
  /** realized-intake ceiling on long carries — nobody holds the paper target
      through a 4-hour climb, so cap what the plan asks you to carry */
  carb_cap_over_h: number;
  carb_cap_g_hr: number;
  sodium_mg_hr: number;
  fluid_ml_hr: number;
  fluid_ml_hr_heat: number;
  heat_window: { start: string; end: string };
  long_carry_h: number;
};

export const DEFAULT_NUTRITION: NutritionConfig = {
  flask_ml: 500,
  tailwind_flasks: 2,
  flask_carb_g: 55,
  flask_sodium_mg: 537,
  water_flask_ml: 500,
  water_reserve_ml: 250,
  spare_flask_ml: 500,
  liquid_carb_rate_g_hr: 55,
  gel: { carb_g: 25, sodium_mg: 20, label: "Maurten 100" },
  bloks: { carb_g: 24, sodium_mg: 50, label: "3 Clif Bloks" },
  salt_tab_mg: 250,
  phases: [
    { until_h: 12, carb_g_hr: 75, bloks_frac: 0, supplement: "gel hourly" },
    { until_h: 24, carb_g_hr: 70, bloks_frac: 0.5, supplement: "gel or bloks" },
    { until_h: 48, carb_g_hr: 62, bloks_frac: 0.5, supplement: "coke + broth at aid" },
  ],
  carb_cap_over_h: 3,
  carb_cap_g_hr: 70,
  sodium_mg_hr: 650,
  fluid_ml_hr: 500,
  fluid_ml_hr_heat: 650,
  heat_window: { start: "10:00", end: "17:00" },
  long_carry_h: 2.5,
};

/** Same failure semantics as the useRaceData hooks, except a 404 silently
    falls back to DEFAULT_NUTRITION — the file is optional tuning, not data. */
export function useNutrition() {
  const { key: refreshKey } = useRefresh();
  const [cfg, setCfg] = useState<NutritionConfig>(DEFAULT_NUTRITION);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    fetch(`/nutrition.json?t=${Date.now()}`)
      .then(async (r) => {
        if (stale) return;
        if (r.status === 404) { setCfg(DEFAULT_NUTRITION); setError(null); return; }
        if (!r.ok) { setError(`nutrition.json failed to load (HTTP ${r.status})`); return; }
        const d = await r.json().catch(() => { throw new Error("parse"); });
        const valid = d && Number.isFinite(d.flask_carb_g) && Array.isArray(d.phases) && d.phases.length > 0 &&
          d.phases.every((p: { until_h: unknown; carb_g_hr: unknown }) => Number.isFinite(p.until_h) && Number.isFinite(p.carb_g_hr));
        if (!valid) { if (!stale) setError("nutrition.json invalid — using previous config or defaults"); return; }
        if (stale) return;
        setCfg({ ...DEFAULT_NUTRITION, ...d, gel: { ...DEFAULT_NUTRITION.gel, ...d.gel }, bloks: { ...DEFAULT_NUTRITION.bloks, ...d.bloks } });
        setError(null);
      })
      .catch(() => { if (!stale) setError("nutrition.json corrupt or unreadable"); });
    return () => { stale = true; };
  }, [refreshKey]);
  return { nutrition: cfg, error };
}

export type FuelSegment = {
  /** Clif Blok packets (3-blok servings) to carry — phase-2+ substitution */
  bloks: number;
  /** Tailwind flasks filled at departure (3 with the 4th flask) — each fill
      takes one HCF scoop; aid supplies the base mix */
  flasks: number;
  /** station you leave (index into proj.stations, -1 = the start line) */
  fromIdx: number;
  /** station this leg ends at (the next mix refill, or the finish) */
  toIdx: number;
  from: string;
  to: string;
  /** stations passed with NO usable resupply (crew-only / water-only) */
  via: string[];
  /** a water-only station inside the leg — flasks of plain water refillable */
  water_note: string | null;
  departH: number;
  arriveH: number;
  carryH: number;
  /** integrated carb target for the carry, grams */
  carb_g: number;
  /** carbs the drink mix realistically supplies over the carry */
  liquid_carb_g: number;
  /** gels (or blok-packets — same slot) to carry out */
  gels: number;
  salt_tabs: number;
  /** fluid the carry demands, mL (heat-adjusted) */
  fluid_ml: number;
  /** demand exceeds 2 Tailwind flasks + drinkable water → fill the 4th (MIX) */
  fourth_flask: boolean;
  /** demand exceeds the 4-flask setup → also fill the 5th spare (WATER) */
  fifth_flask: boolean;
  /** what to swallow AT the aid station before leaving — demand beyond even
      five flasks (mL, 0 when the carried fluid suffices) */
  preload_ml: number;
  /** departure fill code: "2M" | "3M" | "3M+W" (M = mix flask, W = spare
      flask of plain water; the always-carried water flask is implied) */
  fill: string;
  heat: boolean;
  night: boolean;
  long_carry: boolean;
  /** dominant phase's supplement guidance at the segment midpoint */
  supplement: string;
};

export type DropBag = {
  /** where the bag waits ("Start" = what's in the vest at the gun) */
  station: string;
  /** race-clock arrival at this restock point, hours (0 for the start) */
  atH: number;
  /** everything consumed from here until the next drop bag (or the finish) */
  gels: number;
  bloks: number;
  hcf_scoops: number;
  salt_tabs: number;
  covers: string;
  night: boolean;
};

export type FuelPlan = {
  segments: FuelSegment[];
  drop_bags: DropBag[];
  longest_idx: number;
  total_gels: number;
  total_bloks: number;
  total_tabs: number;
  /** High Carb Fuel scoops = Tailwind flasks filled across the race */
  total_hcf_scoops: number;
  total_carb_g: number;
  /** mg/hr the drink alone leaves uncovered vs the sodium target */
  sodium_gap_mg_hr: number;
};

const parseHM = (hm: string): number => {
  const [h, m] = hm.split(":").map(Number);
  return h + (m || 0) / 60;
};

/** total overlap (hours) of [a0,a1] with window [w0,w1] repeated every 24h */
function dailyOverlap(a0: number, a1: number, w0: number, w1: number): number {
  let total = 0;
  for (let day = Math.floor(a0 / 24) - 1; day * 24 < a1; day++) {
    const s = Math.max(a0, day * 24 + w0);
    const e = Math.min(a1, day * 24 + w1);
    if (e > s) total += e - s;
  }
  return total;
}

export function planFuel(
  proj: NonNullable<ReturnType<typeof projectRace>>,
  course: Course,
  raceStart: Date,
  cfg: NutritionConfig,
): FuelPlan {
  const startH = raceStart.getHours() + raceStart.getMinutes() / 60;
  // clock-of-day windows converted to elapsed race hours
  const heat0 = parseHM(cfg.heat_window.start) - startH;
  const heat1 = parseHM(cfg.heat_window.end) - startH;
  const sunset = parseHM(course.sun.sunset) - startH;
  const sunriseNext = parseHM(course.sun.sunrise) - startH + 24;

  const phaseAt = (h: number) => {
    for (const p of cfg.phases) if (h < p.until_h) return p;
    return cfg.phases[cfg.phases.length - 1];
  };
  // integrate the piecewise-constant carb target over a carry
  const carbOver = (h0: number, h1: number): number => {
    let total = 0, prev = 0;
    for (const p of cfg.phases) {
      const s = Math.max(h0, prev), e = Math.min(h1, p.until_h);
      if (e > s) total += (e - s) * p.carb_g_hr;
      prev = p.until_h;
    }
    if (h1 > prev) total += (h1 - prev) * cfg.phases[cfg.phases.length - 1].carb_g_hr;
    return total;
  };

  const baseDrinkCap = cfg.tailwind_flasks * cfg.flask_carb_g;
  const fluidCap = cfg.tailwind_flasks * cfg.flask_ml + (cfg.water_flask_ml - cfg.water_reserve_ml);
  const heatFluid = (h0: number, h1: number): number => {
    const span = Math.max(0, h1 - h0);
    const heatH = dailyOverlap(h0, h1, heat0, heat1);
    return cfg.fluid_ml_hr * (span - heatH) + cfg.fluid_ml_hr_heat * heatH;
  };

  // NO-CREW model: a station only refills Tailwind mix if it has real aid
  // (crew-only points have nothing, water-only points have water but no mix).
  // The plan's rows are therefore LEGS between true mix refills — the finish
  // is always a terminus regardless of its flags.
  const canRefillMix = (i: number): boolean => {
    const s = proj.stations[i].station;
    return !s.crew_only && !s.water_only;
  };
  const last = proj.stations.length - 1;
  const boundaries: number[] = [-1];
  for (let i = 0; i < last; i++) if (canRefillMix(i)) boundaries.push(i);
  boundaries.push(last);

  const segments: FuelSegment[] = [];
  for (let b = 0; b + 1 < boundaries.length; b++) {
    const fromIdx = boundaries[b];
    const toIdx = boundaries[b + 1];
    const fromSt = fromIdx >= 0 ? proj.stations[fromIdx] : null;
    const departH = fromSt ? fromSt.eta_h.avg + fromSt.stop_min / 60 : 0;
    const arriveH = proj.stations[toIdx].eta_h.avg;
    const carryH = Math.max(0, arriveH - departH);
    const between = proj.stations.slice(fromIdx + 1, toIdx);
    const via = between.map((s) => s.station.name);
    const waterStops = between.filter((s) => s.station.water_only);

    // fluid: plain water is refillable mid-leg at a water-only station, so
    // the demand that must be CARRIED is the worst stretch between water
    // points, not the whole leg
    const waterPoints = [departH, ...waterStops.map((s) => s.eta_h.avg), arriveH];
    let fluid_ml = 0;
    for (let w = 0; w + 1 < waterPoints.length; w++) {
      fluid_ml = Math.max(fluid_ml, heatFluid(waterPoints[w], waterPoints[w + 1]));
    }
    const fourth_flask = fluid_ml > fluidCap;
    const fifth_flask = fluid_ml > fluidCap + cfg.flask_ml;
    const preload_ml = Math.max(0,
      Math.ceil((fluid_ml - (fluidCap + cfg.flask_ml + cfg.spare_flask_ml)) / 50) * 50);
    const flasks = cfg.tailwind_flasks + (fourth_flask ? 1 : 0);
    const fill = fourth_flask ? (fifth_flask ? "3M+W" : "3M") : "2M";

    // realized-intake cap on long carries — the paper target is unholdable
    // through a 4-hour climb, so don't plan pockets full of gels for it
    const rawCarb = carbOver(departH, arriveH);
    const carb_g = carryH > cfg.carb_cap_over_h
      ? Math.min(rawCarb, cfg.carb_cap_g_hr * carryH)
      : rawCarb;
    const liquid_carb_g = Math.min(flasks * cfg.flask_carb_g, cfg.liquid_carb_rate_g_hr * carryH);
    const suppCarb = Math.max(0, carb_g - liquid_carb_g);

    // split carried units between gels and bloks by the phase's preference
    const phase = phaseAt((departH + arriveH) / 2);
    const bloksFrac = phase.bloks_frac ?? 0;
    const bloks = Math.round((suppCarb * bloksFrac) / cfg.bloks.carb_g);
    const gels = Math.max(0, Math.ceil((suppCarb - bloks * cfg.bloks.carb_g) / cfg.gel.carb_g));

    const naNeed = cfg.sodium_mg_hr * carryH;
    const naFromDrink = (liquid_carb_g / cfg.flask_carb_g) * cfg.flask_sodium_mg;
    const naFromSupp = gels * cfg.gel.sodium_mg + bloks * cfg.bloks.sodium_mg;
    const salt_tabs = Math.max(0, Math.round((naNeed - naFromDrink - naFromSupp) / cfg.salt_tab_mg));

    const heatH = dailyOverlap(departH, arriveH, heat0, heat1);
    const nightH = dailyOverlap(departH, arriveH, sunset, sunriseNext);

    segments.push({
      fromIdx, toIdx,
      from: fromSt ? fromSt.station.name : "Start",
      to: proj.stations[toIdx].station.name,
      via,
      water_note: waterStops.length ? `water only @ ${waterStops.map((s) => s.station.name).join(", ")}` : null,
      departH, arriveH, carryH,
      carb_g: Math.round(carb_g / 5) * 5,
      liquid_carb_g: Math.round(liquid_carb_g),
      gels, bloks, salt_tabs,
      flasks,
      fluid_ml: Math.round(fluid_ml / 50) * 50,
      fourth_flask, fifth_flask, preload_ml, fill,
      heat: heatH > 0.25,
      night: nightH > 0.25,
      long_carry: carryH > cfg.long_carry_h,
      supplement: phase.supplement,
    });
  }

  // drop bags: personal supplies (gels/bloks/HCF/tabs) restock ONLY at
  // drop-bag stations — aggregate legs between them, "Start" = the vest
  const dropIdxs = proj.stations
    .map((s, i) => (s.station.drop_bag && i < last ? i : -1))
    .filter((i) => i >= 0);
  const drop_bags: DropBag[] = [];
  const dropBounds = [-1, ...dropIdxs];
  for (let d = 0; d < dropBounds.length; d++) {
    const fromIdx = dropBounds[d];
    const untilIdx = d + 1 < dropBounds.length ? dropBounds[d + 1] : last;
    const legs = segments.filter((s) => s.fromIdx >= fromIdx && s.toIdx <= untilIdx);
    if (!legs.length) continue;
    drop_bags.push({
      station: fromIdx >= 0 ? proj.stations[fromIdx].station.name : "Start",
      atH: fromIdx >= 0 ? proj.stations[fromIdx].eta_h.avg : 0,
      gels: legs.reduce((a, s) => a + s.gels, 0),
      bloks: legs.reduce((a, s) => a + s.bloks, 0),
      hcf_scoops: legs.reduce((a, s) => a + s.flasks, 0),
      salt_tabs: legs.reduce((a, s) => a + s.salt_tabs, 0),
      covers: `→ ${proj.stations[untilIdx].station.name}`,
      night: legs.some((s) => s.night),
    });
  }

  let longest_idx = 0;
  segments.forEach((s, i) => { if (s.carryH > segments[longest_idx].carryH) longest_idx = i; });
  return {
    segments,
    drop_bags,
    longest_idx,
    total_gels: segments.reduce((a, s) => a + s.gels, 0),
    total_bloks: segments.reduce((a, s) => a + s.bloks, 0),
    total_tabs: segments.reduce((a, s) => a + s.salt_tabs, 0),
    total_hcf_scoops: segments.reduce((a, s) => a + s.flasks, 0),
    total_carb_g: segments.reduce((a, s) => a + s.carb_g, 0),
    sodium_gap_mg_hr: Math.round(cfg.sodium_mg_hr - (cfg.liquid_carb_rate_g_hr / baseDrinkCap) * (cfg.tailwind_flasks * cfg.flask_sodium_mg)),
  };
}

/** "3h05" — carry durations read faster without minutes-padding ceremony */
export function fmtCarry(h: number): string {
  const total = Math.round(h * 60);
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}`;
}
