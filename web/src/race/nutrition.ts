import { useEffect, useState } from "react";
import { useActiveRace, useRefresh } from "../data";
import { cacheGet, cachePut, slugKey } from "./offlineCache";
import { DEFAULT_NUTRITION, normalizeNutrition, parseHM } from "./nutrition-config";
import type { NutritionConfig } from "./nutrition-config";
import { raceClockH } from "./pacing";
import type { projectRace } from "./pacing";
import { dailyOverlap, nightOverlapH, type SunTimes } from "./nightWindow";

// The config shape, its defaults and its validator live next door — re-exported
// here so every existing `from "./nutrition"` import keeps working.
export { DEFAULT_NUTRITION, normalizeNutrition } from "./nutrition-config";
export type { NutritionConfig, CaffeineConfig } from "./nutrition-config";

/* ------------------------------------------------------------------ */
/*  Fueling model — per-segment carb / sodium / fluid plan derived     */
/*  from the pacing projection's EXPECTED splits. Constants come from  */
/*  the race folder's nutrition.json, served at /nutrition.json by the */
/*  dev server (user-editable), with the defaults in nutrition-config  */
/*  as the fallback. All math is departure-oriented: a FuelSegment is  */
/*  what you carry OUT of `from` to reach `to`.                        */
/* ------------------------------------------------------------------ */

/** Where the returned config actually came from — "default" is the one case
    that used to be entirely silent (a 404 is expected/valid, but it still
    means every number on the fuel page is the impersonal fallback, not this
    race's own tuning), so callers that want to say so can. */
export type NutritionSource = "file" | "cache" | "default";

/** Same failure semantics as the useRaceData hooks, except a 404 silently
    falls back to DEFAULT_NUTRITION — the file is optional tuning, not data. */
export function useNutrition() {
  const { key: refreshKey } = useRefresh();
  // `viewing`, not `slug`: the dev server serves /course.json,
  // /crew-base.json and /nutrition.json out of the folder the POINTER
  // names, which in view mode (tt-yib.7) is the archived race being
  // browsed rather than the training target. Keying the cache on the
  // training slug would file one race's course under another's name.
  const { viewing: slug, resolved } = useActiveRace();
  const [cfg, setCfg] = useState<NutritionConfig>(DEFAULT_NUTRITION);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<NutritionSource>("default");
  useEffect(() => {
    if (!resolved) return;
    let stale = false;
    // cached per slug like the other race payloads: without it an offline
    // race-day reload silently swaps this race's tuning for the generic
    // defaults, and the drop-bag gear list (drop_bag_gear) empties out
    const cacheKey = slugKey("nutrition", slug);
    const fallback = (message: string) => {
      if (stale) return;
      const cached = cacheGet<unknown>(cacheKey);
      const norm = cached == null ? null : normalizeNutrition(cached);
      if (norm) { setCfg(norm); setError(`${message} — showing the last saved copy`); setSource("cache"); }
      else { setError(message); setSource("default"); }
    };
    // see useRaceData.ts's useCourse comment on `?slug=` — same pointer race
    // (a request left in flight across a race switch used to resolve
    // against whichever folder the pointer named by the time the server got
    // to it, poisoning THIS slug's offline cache with the other race's
    // fueling numbers), same fix: pin the read to an explicit slug.
    const url = slug ? `/nutrition.json?slug=${encodeURIComponent(slug)}&t=${Date.now()}` : `/nutrition.json?t=${Date.now()}`;
    fetch(url)
      .then(async (r) => {
        if (stale) return;
        if (r.status === 404) { setCfg(DEFAULT_NUTRITION); setError(null); setSource("default"); return; }
        if (!r.ok) { fallback(`nutrition.json failed to load (HTTP ${r.status})`); return; }
        const d = await r.json().catch(() => { throw new Error("parse"); });
        const norm = normalizeNutrition(d);
        if (!norm) { if (!stale) { setError("nutrition.json invalid — using previous config or defaults"); setSource("default"); } return; }
        if (stale) return;
        cachePut(cacheKey, d);
        setCfg(norm);
        setError(null);
        setSource("file");
      })
      .catch(() => fallback("nutrition.json corrupt or unreadable"));
    return () => { stale = true; };
  }, [refreshKey, resolved, slug]);
  return { nutrition: cfg, error, source };
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
  /** one drink instruction per stretch whose demand exceeds the carried
      capacity — every stretch starts somewhere with drinkable water (the
      departure aid for the first, a water-only station after), so each
      shortfall is swallowed right before the stretch it covers. at: null =
      the departure aid. ml capped at 800 per stop (ration beyond). */
  preloads: { at: string | null; ml: number }[];
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

// dailyOverlap now lives in nightWindow.ts (zero imports, so it and the
// night-band math around it can be unit-tested directly — see
// scripts/sun-null.test.mjs); imported above, re-used by heatFluid below.

export function planFuel(
  proj: NonNullable<ReturnType<typeof projectRace>>,
  /** course.sun, with the raceConfig fallback already applied by
      useRacePlan — null when nobody has computed it yet (a draft built
      before its date was known). Every night annotation below degrades to
      "none" rather than throwing when this is null. (planFuel otherwise
      reads the course entirely through `proj`, so this is its only use
      of a course.json field — no `course` parameter needed.) */
  sun: SunTimes | null,
  raceStart: Date,
  cfg: NutritionConfig,
  timeZone: string,
): FuelPlan {
  // race-local: the heat window and the sun times are clock-of-day facts about
  // the COURSE, so the start has to be read on the same clock they are
  const startH = raceClockH(raceStart, timeZone);
  // clock-of-day windows converted to elapsed race hours
  const heat0 = parseHM(cfg.heat_window.start) - startH;
  const heat1 = parseHM(cfg.heat_window.end) - startH;

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
    // EPS guards ceil/threshold arithmetic against float dust — heatFluid's
    // sum can land 1e-13 mL above an exact value, which Math.ceil would
    // otherwise inflate into a whole extra 50 mL instruction
    const EPS = 1e-6;
    const thr = cfg.preload_over_flask_ml;
    let extraMix = 0, water_flasks = 0;
    let capacity = cfg.tailwind_flasks * cfg.flask_ml;
    if (cfg.spare_flasks > 0 && fluid_ml - capacity > thr + EPS) { extraMix = 1; capacity += cfg.flask_ml; }
    while (water_flasks < cfg.spare_flasks - extraMix && fluid_ml - capacity > thr + EPS) {
      water_flasks++; capacity += cfg.flask_ml;
    }
    // EVERY stretch that exceeds the carried capacity gets its own drink
    // instruction, placed where that stretch begins (a single preload at the
    // binding stretch left same-sized sibling stretches silently uncovered).
    // Nobody can pre-load more than ~800 mL at one stop — beyond that the
    // honest instruction is "ration", not a bigger number.
    const preloads: { at: string | null; ml: number }[] = [];
    let ration = false;
    for (let w = 0; w + 1 < waterPoints.length; w++) {
      const short = Math.ceil((Math.max(0, heatFluid(waterPoints[w], waterPoints[w + 1]) - capacity) - EPS) / 50) * 50;
      if (short <= 0) continue;
      preloads.push({ at: w === 0 ? null : waterStops[w - 1].station.name, ml: Math.min(short, 800) });
      if (short > 800) ration = true;
    }
    const preloadTotal = preloads.reduce((a, p) => a + p.ml, 0);
    const flasks = cfg.tailwind_flasks + extraMix;
    const extra_fill = extraMix > 0 || water_flasks > 0;
    const fill = `${flasks}M${water_flasks > 0 ? `+${water_flasks}W` : ""}`;

    // realized-intake cap on long carries — the paper target is unholdable
    // through a 4-hour climb, so don't plan pockets full of gels for it
    const rawCarb = carbOver(departH, arriveH);
    const carb_g = carryH > cfg.carb_cap_over_h
      ? Math.min(rawCarb, cfg.carb_cap_g_hr * carryH)
      : rawCarb;
    // credit what the runner is FORCED to drink: with no water flask, every
    // mL of a hot leg's demand is mix, which can exceed the sipping-rate
    // credit — without this floor those carbs get prescribed a second time
    // as gels. Legs with a mid-leg water stop fall back to the rate credit
    // (refill water dilutes the forcing, conservatively).
    const forcedMix_g = waterStops.length > 0 ? 0 :
      (Math.max(0, Math.min(flasks * cfg.flask_ml,
        heatFluid(departH, arriveH) - preloadTotal - water_flasks * cfg.flask_ml)) / cfg.flask_ml) * cfg.flask_carb_g;
    const liquid_carb_g = Math.min(flasks * cfg.flask_carb_g,
      Math.max(cfg.liquid_carb_rate_g_hr * carryH, forcedMix_g));
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
    const nightH = nightOverlapH(departH, arriveH, sun, startH);

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
      water_flasks, extra_fill, preloads, ration, fill,
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
