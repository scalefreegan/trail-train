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
  /** empty flasks in the vest beyond the 2 mix flasks; filled per leg (at
      most one extra takes mix — the rest take plain water when demand asks) */
  spare_flasks: number;
  /** shortfalls up to this are covered by drinking at the aid before leaving
      instead of carrying another 500g flask for a 50mL overage */
  preload_over_flask_ml: number;
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
  /** non-food gear per drop bag, keyed by station name ("Start" = the vest) */
  drop_bag_gear: Record<string, string[]>;
};

export const DEFAULT_NUTRITION: NutritionConfig = {
  flask_ml: 500,
  tailwind_flasks: 2,
  flask_carb_g: 55,
  flask_sodium_mg: 537,
  spare_flasks: 3,
  preload_over_flask_ml: 350,
  liquid_carb_rate_g_hr: 55,
  gel: { carb_g: 25, sodium_mg: 20, label: "Maurten 100" },
  bloks: { carb_g: 24, sodium_mg: 50, label: "3 Clif Bloks" },
  salt_tab_mg: 250,
  // gels stay the majority throughout; bloks are a steady minority that
  // tapers as chewing gets harder, rather than clustering in one phase
  phases: [
    { until_h: 12, carb_g_hr: 75, bloks_frac: 0.4, supplement: "gels lead; bloks while chewing is easy" },
    { until_h: 24, carb_g_hr: 70, bloks_frac: 0.3, supplement: "gels + occasional bloks" },
    { until_h: 48, carb_g_hr: 62, bloks_frac: 0.2, supplement: "gels + coke/broth at aid" },
  ],
  carb_cap_over_h: 3,
  carb_cap_g_hr: 70,
  sodium_mg_hr: 650,
  fluid_ml_hr: 500,
  fluid_ml_hr_heat: 650,
  heat_window: { start: "10:00", end: "17:00" },
  long_carry_h: 2.5,
  drop_bag_gear: {
    "Start": ["sunscreen + hat", "arm sleeves (am chill)"],
    "Fish Hatchery": ["small headlamp (dusk cover → Buck Springs)", "long-sleeve for night", "anti-chafe"],
    "Buck Springs": ["main headlamp + spare battery", "beanie + gloves", "warm midlayer", "caffeine starts here"],
    "Geronimo": ["fresh socks + blister kit", "sunscreen for day 2"],
  },
};

const isHM = (v: unknown): v is string => typeof v === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v);

/** Validate a fetched nutrition.json and merge it over the defaults. Nested
    objects are deep-merged or fall back wholesale — a partial heat_window or
    a malformed gear map must never reach planFuel (no ErrorBoundary exists;
    a throw in the planner's render blanks the whole app). Returns null when
    the payload is structurally unusable. */
export function normalizeNutrition(d: unknown): NutritionConfig | null {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const raw = d as Record<string, unknown>;
  type RawPhase = { until_h: unknown; carb_g_hr: unknown; supplement?: unknown; bloks_frac?: unknown };
  const phasesOk = Array.isArray(raw.phases) && raw.phases.length > 0 &&
    (raw.phases as RawPhase[]).every((p) => p && typeof p === "object" &&
      Number.isFinite(p.until_h) && Number.isFinite(p.carb_g_hr) && (p.carb_g_hr as number) > 0 &&
      (p.supplement === undefined || typeof p.supplement === "string") &&
      (p.bloks_frac === undefined || Number.isFinite(p.bloks_frac)));
  if (!phasesOk || !Number.isFinite(raw.flask_carb_g) || (raw.flask_carb_g as number) <= 0) return null;
  // unit specs divide the carb/sodium math — a zero renders Infinity/NaN gels
  // on a card carried into a race
  const posOr = (v: unknown, dflt: number): number => (Number.isFinite(v) && (v as number) > 0 ? (v as number) : dflt);
  const gelSpec = { ...DEFAULT_NUTRITION.gel, ...(raw.gel as Partial<NutritionConfig["gel"]> | undefined) };
  const blokSpec = { ...DEFAULT_NUTRITION.bloks, ...(raw.bloks as Partial<NutritionConfig["bloks"]> | undefined) };
  if (gelSpec.carb_g <= 0 || blokSpec.carb_g <= 0) return null;

  // carbOver/phaseAt assume ascending until_h — sort rather than mis-integrate
  const phases = (raw.phases as NutritionConfig["phases"])
    .map((p) => ({ ...p, supplement: p.supplement ?? "", bloks_frac: Math.min(1, Math.max(0, p.bloks_frac ?? 0)) }))
    .sort((a, b) => a.until_h - b.until_h);

  // dailyOverlap cannot represent a midnight-wrapping window (start > end
  // would silently disable heat race-wide), so require start < end
  const hw = raw.heat_window as { start?: unknown; end?: unknown } | undefined;
  const heat_window = hw && isHM(hw.start) && isHM(hw.end) && parseHM(hw.start) < parseHM(hw.end)
    ? { start: hw.start, end: hw.end }
    : DEFAULT_NUTRITION.heat_window;

  let drop_bag_gear = DEFAULT_NUTRITION.drop_bag_gear;
  if (raw.drop_bag_gear !== undefined) {
    drop_bag_gear = {};
    if (raw.drop_bag_gear && typeof raw.drop_bag_gear === "object" && !Array.isArray(raw.drop_bag_gear)) {
      for (const [k, v] of Object.entries(raw.drop_bag_gear as Record<string, unknown>)) {
        if (Array.isArray(v)) drop_bag_gear[k] = v.filter((x): x is string => typeof x === "string");
      }
    }
  }

  const merged: NutritionConfig = {
    ...DEFAULT_NUTRITION,
    ...(raw as Partial<NutritionConfig>),
    gel: gelSpec,
    bloks: blokSpec,
    phases, heat_window, drop_bag_gear,
  };
  // numeric hygiene: every top-level number that reaches arithmetic must be a
  // usable number — a hand-edited "2" (string) survives the spread and turns
  // `flasks + 1` into concatenation; a 0 turns the sodium gap into NaN
  const positive = [
    "flask_ml", "flask_carb_g", "flask_sodium_mg",
    "liquid_carb_rate_g_hr", "salt_tab_mg", "sodium_mg_hr",
    "fluid_ml_hr", "fluid_ml_hr_heat", "carb_cap_over_h", "carb_cap_g_hr", "long_carry_h",
    "preload_over_flask_ml",
  ] as const;
  for (const k of positive) merged[k] = posOr(merged[k], DEFAULT_NUTRITION[k]);
  merged.tailwind_flasks = Number.isFinite(merged.tailwind_flasks) && merged.tailwind_flasks >= 1
    ? Math.round(merged.tailwind_flasks) : DEFAULT_NUTRITION.tailwind_flasks;
  // spare_flasks: 0 is a legitimate "just the 2 mix flasks" — clamp negatives/NaN
  merged.spare_flasks = Number.isFinite(merged.spare_flasks) && merged.spare_flasks >= 0
    ? Math.round(merged.spare_flasks) : DEFAULT_NUTRITION.spare_flasks;
  return merged;
}

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
        const norm = normalizeNutrition(d);
        if (!norm) { if (!stale) setError("nutrition.json invalid — using previous config or defaults"); return; }
        if (stale) return;
        setCfg(norm);
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
  /** MIX flasks filled at departure (tailwind_flasks + at most one extra on
      heavy legs) — each takes one HCF scoop; aid supplies the base mix.
      Water flasks are counted separately in water_flasks and take no scoop. */
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
  /** plain-water flasks filled for this leg (demand-driven, 0 most legs) */
  water_flasks: number;
  /** anything filled beyond the standard 2 mix flasks — the heavy-leg marker */
  extra_fill: boolean;
  /** what to swallow AT the aid station before leaving — demand beyond every
      owned flask (mL, 0 when the carried fluid suffices, capped at 800) */
  preload_ml: number;
  /** demand exceeds flasks + a realistic pre-load — ration deliberately */
  ration: boolean;
  /** departure fill code counting EVERY flask you leave with — "2M",
      "3M+1W", "3M+2W" (M = mix, W = plain water; total flasks = M + W) */
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
  /** non-food items for this bag, from cfg.drop_bag_gear */
  gear: string[];
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

/** total overlap (hours) of [a0,a1] with window [w0,w1] repeated every 24h.
    Bounds are derived from the window edges themselves — a start bound of
    floor(a0/24)-1 silently skipped the last repeat whenever w0 < 0 (e.g. an
    evening race start putting the heat window at negative elapsed hours). */
function dailyOverlap(a0: number, a1: number, w0: number, w1: number): number {
  let total = 0;
  for (let day = Math.floor((a0 - w1) / 24); day * 24 + w0 < a1; day++) {
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
    // tail past the last boundary starts at the LATER of departure and the
    // boundary — charging from the boundary over-fueled any leg departing
    // after it (a 2h carry at hour 60 priced as 12h of carbs)
    const tail = Math.max(h0, prev);
    if (h1 > tail) total += (h1 - tail) * cfg.phases[cfg.phases.length - 1].carb_g_hr;
    return total;
  };

  const baseDrinkCap = cfg.tailwind_flasks * cfg.flask_carb_g;
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
    const waterStops = between.filter((s) => s.station.water_only);
    // water-only stations live in water_note, not the "no resupply" list —
    // listing them in both printed contradictory guidance on the card
    const via = between.filter((s) => !s.station.water_only).map((s) => s.station.name);

    // fluid: plain water is refillable mid-leg at a water-only station, so
    // the demand that must be CARRIED is the worst stretch between water
    // points, not the whole leg
    const waterPoints = [departH, ...waterStops.map((s) => s.eta_h.avg), arriveH];
    let fluid_ml = 0;
    for (let w = 0; w + 1 < waterPoints.length; w++) {
      fluid_ml = Math.max(fluid_ml, heatFluid(waterPoints[w], waterPoints[w + 1]));
    }
    // demand-driven fill from the 2 standard mix flasks: at most ONE extra
    // flask takes mix (carbs ride along), further spares take plain water —
    // each added only when the shortfall beats the drink-at-aid threshold
    const thr = cfg.preload_over_flask_ml;
    let extraMix = 0, water_flasks = 0;
    let capacity = cfg.tailwind_flasks * cfg.flask_ml;
    if (cfg.spare_flasks > 0 && fluid_ml - capacity > thr) { extraMix = 1; capacity += cfg.flask_ml; }
    while (water_flasks < cfg.spare_flasks - extraMix && fluid_ml - capacity > thr) {
      water_flasks++; capacity += cfg.flask_ml;
    }
    const rawPreload = Math.max(0, Math.ceil((fluid_ml - capacity) / 50) * 50);
    // nobody can pre-load more than ~800 mL at an aid table — beyond that the
    // honest instruction is "ration", not a bigger number
    const preload_ml = Math.min(rawPreload, 800);
    const ration = rawPreload > 800;
    const flasks = cfg.tailwind_flasks + extraMix;
    const extra_fill = extraMix > 0 || water_flasks > 0;
    const fill = `${flasks}M${water_flasks > 0 ? `+${water_flasks}W` : ""}`;

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
      // nearest 10, not 50 — coarser rounding displayed a demand above the
      // fill it actually fits inside (1237 → "1.3L" vs a 1.25L carry)
      fluid_ml: Math.round(fluid_ml / 10) * 10,
      water_flasks, extra_fill, preload_ml, ration, fill,
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
    const nextBound = d + 1 < dropBounds.length ? dropBounds[d + 1] : Infinity;
    // partition by DEPARTURE index: every leg lands in exactly one bag even
    // when a drop-bag station is not a mix-refill boundary (a leg spanning
    // the drop point is packed from the earlier bag — conservative), so the
    // per-bag sums always reconcile with the race totals
    const legs = segments.filter((s) => s.fromIdx >= fromIdx && s.fromIdx < nextBound);
    if (!legs.length) continue;
    drop_bags.push({
      station: fromIdx >= 0 ? proj.stations[fromIdx].station.name : "Start",
      atH: fromIdx >= 0 ? proj.stations[fromIdx].eta_h.avg : 0,
      gels: legs.reduce((a, s) => a + s.gels, 0),
      bloks: legs.reduce((a, s) => a + s.bloks, 0),
      hcf_scoops: legs.reduce((a, s) => a + s.flasks, 0),
      salt_tabs: legs.reduce((a, s) => a + s.salt_tabs, 0),
      covers: `→ ${legs[legs.length - 1].to}`,
      night: legs.some((s) => s.night),
      gear: cfg.drop_bag_gear[fromIdx >= 0 ? proj.stations[fromIdx].station.name : "Start"] ?? [],
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
