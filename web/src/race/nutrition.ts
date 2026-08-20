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
  /** how fast the drink mix is actually consumed, g carb per hour */
  liquid_carb_rate_g_hr: number;
  gel: { carb_g: number; sodium_mg: number; label: string };
  bloks: { carb_g: number; sodium_mg: number; label: string };
  salt_tab_mg: number;
  phases: { until_h: number; carb_g_hr: number; supplement: string }[];
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
  liquid_carb_rate_g_hr: 55,
  gel: { carb_g: 25, sodium_mg: 20, label: "Maurten 100" },
  bloks: { carb_g: 24, sodium_mg: 50, label: "3 Clif Bloks" },
  salt_tab_mg: 250,
  phases: [
    { until_h: 12, carb_g_hr: 80, supplement: "gel hourly" },
    { until_h: 24, carb_g_hr: 75, supplement: "gel or bloks" },
    { until_h: 48, carb_g_hr: 62, supplement: "coke + broth at aid" },
  ],
  sodium_mg_hr: 700,
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
  /** station you leave (index into proj.stations, -1 = the start line) */
  fromIdx: number;
  from: string;
  to: string;
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
  /** demand exceeds 2 Tailwind flasks + drinkable water → carry a 4th flask */
  fourth_flask: boolean;
  /** demand exceeds even the 4-flask setup — refill on trail or accept the gap */
  beyond_four: boolean;
  heat: boolean;
  night: boolean;
  long_carry: boolean;
  /** dominant phase's supplement guidance at the segment midpoint */
  supplement: string;
};

export type FuelPlan = {
  segments: FuelSegment[];
  longest_idx: number;
  total_gels: number;
  total_tabs: number;
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

  const supplementAt = (h: number): string => {
    for (const p of cfg.phases) if (h < p.until_h) return p.supplement;
    return cfg.phases[cfg.phases.length - 1].supplement;
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

  const drinkCap = cfg.tailwind_flasks * cfg.flask_carb_g;
  const drinkNaCap = cfg.tailwind_flasks * cfg.flask_sodium_mg;
  const fluidCap = cfg.tailwind_flasks * cfg.flask_ml + (cfg.water_flask_ml - cfg.water_reserve_ml);

  const segments: FuelSegment[] = [];
  for (let i = 0; i < proj.stations.length; i++) {
    const prev = i > 0 ? proj.stations[i - 1] : null;
    const departH = prev ? prev.eta_h.avg + prev.stop_min / 60 : 0;
    const arriveH = proj.stations[i].eta_h.avg;
    const carryH = Math.max(0, arriveH - departH);

    // sub-15-minute hops (e.g. Black Mesa sits at Horton's mile) are part of
    // the same aid stop — carrying a gel or tab for them is noise
    const trivial = carryH < 0.25;

    const carb_g = carbOver(departH, arriveH);
    const liquid_carb_g = Math.min(drinkCap, cfg.liquid_carb_rate_g_hr * carryH);
    const suppCarb = Math.max(0, carb_g - liquid_carb_g);
    const gels = trivial ? 0 : Math.ceil(suppCarb / cfg.gel.carb_g);

    const naNeed = cfg.sodium_mg_hr * carryH;
    const naFromDrink = (liquid_carb_g / drinkCap) * drinkNaCap;
    const naFromGels = gels * cfg.gel.sodium_mg;
    const salt_tabs = trivial ? 0 : Math.max(0, Math.round((naNeed - naFromDrink - naFromGels) / cfg.salt_tab_mg));

    const heatH = dailyOverlap(departH, arriveH, heat0, heat1);
    const nightH = dailyOverlap(departH, arriveH, sunset, sunriseNext);
    const fluid_ml = cfg.fluid_ml_hr * (carryH - heatH) + cfg.fluid_ml_hr_heat * heatH;

    segments.push({
      fromIdx: i - 1,
      from: prev ? prev.station.name : "Start",
      to: proj.stations[i].station.name,
      departH, arriveH, carryH,
      carb_g: Math.round(carb_g / 5) * 5,
      liquid_carb_g: Math.round(liquid_carb_g),
      gels, salt_tabs,
      fluid_ml: Math.round(fluid_ml / 50) * 50,
      fourth_flask: fluid_ml > fluidCap,
      beyond_four: fluid_ml > fluidCap + cfg.flask_ml,
      heat: heatH > 0.25,
      night: nightH > 0.25,
      long_carry: carryH > cfg.long_carry_h,
      supplement: supplementAt((departH + arriveH) / 2),
    });
  }

  let longest_idx = 0;
  segments.forEach((s, i) => { if (s.carryH > segments[longest_idx].carryH) longest_idx = i; });
  return {
    segments,
    longest_idx,
    total_gels: segments.reduce((a, s) => a + s.gels, 0),
    total_tabs: segments.reduce((a, s) => a + s.salt_tabs, 0),
    sodium_gap_mg_hr: Math.round(cfg.sodium_mg_hr - (cfg.liquid_carb_rate_g_hr / drinkCap) * drinkNaCap),
  };
}

/** "3h05" — carry durations read faster without minutes-padding ceremony */
export function fmtCarry(h: number): string {
  const total = Math.round(h * 60);
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}`;
}
