/* ------------------------------------------------------------------ */
/*  Nutrition CONFIG — the shape of a race folder's nutrition.json,    */
/*  its defaults, and the validator that merges a fetched file over    */
/*  them.                                                              */
/*                                                                    */
/*  Split out of nutrition.ts so it can be unit-tested: the fueling    */
/*  model next door imports React and ../data, which a `node --test`   */
/*  process cannot resolve, and the validator is precisely the part    */
/*  worth pinning down away from the DOM (see scripts/nutrition.test   */
/*  .mjs). Nothing in here imports anything.                           */
/* ------------------------------------------------------------------ */

/** "HH:MM" → hours as a float. Exported for the fueling model's heat-window
    math, which reads the same clock strings. */
export const parseHM = (hm: string): number => {
  const [h, m] = hm.split(":").map(Number);
  return h + (m || 0) / 60;
};

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
  caffeine: CaffeineConfig;
};

/** Caffeine is planned separately from carbs: the dose SCHEDULE is driven by
    darkness and the circadian low rather than by carb demand, so it can't be
    folded into the phase model. Everything here is per-athlete tuning. */
export type CaffeineConfig = {
  /** caffeine in one caffeinated gel, mg (Maurten CAF 100 = 100) */
  gel_mg: number;
  /** how many caffeinated gels to place across the race */
  gels: number;
  /** never pack doses tighter than this, hours — if the dosing window can't
      fit `gels` at this spacing, the plan carries fewer and says so */
  min_spacing_h: number;
  /** elimination half-life, hours (4–6 typical; habitual users clear faster) */
  half_life_h: number;
  /** race-morning coffee, mg — dose zero, and it counts */
  pre_race_mg: number;
  /** how long before the gun the pre-race dose is taken, hours */
  pre_race_before_h: number;
  /** caffeine per cup of aid-station cola, mg */
  cola_mg: number;
  /** cups of cola assumed across the back half — small, but real */
  cola_cups: number;
  /** stop dosing this many hours before the projected finish */
  tail_h: number;
  /** ergogenic band in mg/kg — below lo does nothing, above hi buys only
      side effects (the dose–response curve is flat past it) */
  band_lo_mg_kg: number;
  band_hi_mg_kg: number;
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
  // SaltStick Caps: 215 mg sodium per capsule (also 63 K / 22 Ca / 11 Mg,
  // untracked — the plan budgets by sodium)
  salt_tab_mg: 215,
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
  // Station names are per-race, so the built-in defaults carry NONE: the
  // race folder's nutrition.json supplies them, keyed by station name ("Start"
  // = the vest). A drop-bag station with no entry here still gets its row —
  // the gear line is simply omitted (see planFuel's `?? []` and DropBagCard).
  drop_bag_gear: {},
  caffeine: {
    gel_mg: 100,
    gels: 9,
    min_spacing_h: 1.75,
    half_life_h: 5,
    pre_race_mg: 175,
    pre_race_before_h: 1,
    cola_mg: 12,
    cola_cups: 6,
    tail_h: 3,
    band_lo_mg_kg: 3,
    band_hi_mg_kg: 6,
  },
};

const isHM = (v: unknown): v is string => typeof v === "string" && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v);

/** One note per session for a nutrition.json still carrying `caffeine.body_kg`
    — see normalizeNutrition. Module-level, so a refetch on every refresh pulse
    doesn't repeat it. */
let legacyBodyKgNoted = false;
function noteLegacyBodyKg() {
  if (legacyBodyKgNoted) return;
  legacyBodyKgNoted = true;
  console.info(
    "nutrition.json still has caffeine.body_kg — ignoring it. Body mass now " +
      "lives in config/profile.json as physiology.body_kg (editable in the " +
      "coach settings dialog); the key can be deleted from the race folder.",
  );
}

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

  // caffeine: every field reaches either mg/kg arithmetic or the dose-placement
  // loop, so a hand-edited string or a zero body mass must not survive. A
  // partial block merges over the defaults rather than falling back wholesale.
  // Built field-by-field from KNOWN CaffeineConfig keys, same reasoning as
  // the top-level merge below: a blanket `...rawCaf` spread would let an
  // unknown key (a coach's `caffeine_comment` dosing rationale, say) ride
  // straight through into what crew-export.mjs writes into the handout.
  const rawCaf = (raw.caffeine ?? {}) as Partial<CaffeineConfig> & { body_kg?: unknown };
  const caffeine: CaffeineConfig = { ...DEFAULT_NUTRITION.caffeine };
  // tt-yib.9 moved body mass to config/profile.json's `physiology.body_kg`: a
  // race folder has to be shareable without carrying the athlete's weight, and
  // the mg/kg band must not depend on which race folder happens to be active.
  // Older files still carry the key; it is never copied into `caffeine` now
  // (nothing to strip), but the note still fires once per session as a
  // migration hint.
  if ("body_kg" in rawCaf) noteLegacyBodyKg();
  const cafPositive = [
    "gel_mg", "min_spacing_h", "half_life_h",
    "cola_mg", "band_lo_mg_kg", "band_hi_mg_kg",
  ] as const;
  for (const k of cafPositive) caffeine[k] = posOr(rawCaf[k], DEFAULT_NUTRITION.caffeine[k]);
  // these may legitimately be 0 ("no caffeine at all", "no coffee", "dose to
  // the line") but must still be finite and non-negative
  const cafNonNeg = ["gels", "pre_race_mg", "pre_race_before_h", "cola_cups", "tail_h"] as const;
  for (const k of cafNonNeg) {
    caffeine[k] = Number.isFinite(rawCaf[k]) && (rawCaf[k] as number) >= 0
      ? (rawCaf[k] as number) : DEFAULT_NUTRITION.caffeine[k];
  }
  // gels/cups are counts — a fractional 2.5 would render as "2.5 gels"
  caffeine.gels = Math.min(30, Math.round(caffeine.gels));
  caffeine.cola_cups = Math.min(60, Math.round(caffeine.cola_cups));
  // pre_race_before_h sets where the body-load curve STARTS, and that curve is
  // sampled at a fixed step inside the render path. Left unbounded, a typo of
  // 100000 for 1 turns a few hundred samples into millions and freezes the tab
  // synchronously — no ErrorBoundary catches a loop that never throws. Same
  // reasoning as the spare_flasks cap below.
  caffeine.pre_race_before_h = Math.min(24, caffeine.pre_race_before_h);
  // a half-life at or near zero makes the decay term collapse and the curve
  // meaningless; keep it in a physiologically sane band
  caffeine.half_life_h = Math.min(24, Math.max(0.5, caffeine.half_life_h));
  // an inverted band would paint the "no added benefit" line below the
  // threshold line and read as though the plan were always over the ceiling
  if (caffeine.band_hi_mg_kg <= caffeine.band_lo_mg_kg) {
    caffeine.band_lo_mg_kg = DEFAULT_NUTRITION.caffeine.band_lo_mg_kg;
    caffeine.band_hi_mg_kg = DEFAULT_NUTRITION.caffeine.band_hi_mg_kg;
  }

  // Built field-by-field from KNOWN NutritionConfig keys only — never a
  // blanket `...raw` spread. nutrition.json is coach/planning scratch space
  // as much as it is config: a free-text `comment` or `caffeine_comment`
  // (coach rationale, never meant to leave the athlete/coach's hands) must
  // not survive into `merged`, because `merged` is what scripts/crew-export
  // .mjs writes verbatim into the printed handout a volunteer crew chief
  // gets at an aid station. `crewRace()` (crew-export.mjs) whitelists
  // race.json's fields for the identical reason; this is nutrition.json's
  // equivalent scoping. Every key below is read out of `raw` directly (not
  // off a pre-spread `merged`), so an unknown top-level key in the source
  // file has nowhere to ride along.
  const merged: NutritionConfig = {
    ...DEFAULT_NUTRITION,
    gel: gelSpec,
    bloks: blokSpec,
    phases, heat_window, drop_bag_gear, caffeine,
  };
  // numeric hygiene: every top-level number that reaches arithmetic must be a
  // usable number — a hand-edited "2" (string) turns `flasks + 1` into
  // concatenation; a 0 turns the sodium gap into NaN
  const positive = [
    "flask_ml", "flask_carb_g", "flask_sodium_mg",
    "liquid_carb_rate_g_hr", "salt_tab_mg", "sodium_mg_hr",
    "fluid_ml_hr", "fluid_ml_hr_heat", "carb_cap_over_h", "carb_cap_g_hr", "long_carry_h",
    "preload_over_flask_ml",
  ] as const;
  for (const k of positive) merged[k] = posOr(raw[k], DEFAULT_NUTRITION[k]);
  merged.tailwind_flasks = Number.isFinite(raw.tailwind_flasks) && (raw.tailwind_flasks as number) >= 1
    ? Math.round(raw.tailwind_flasks as number) : DEFAULT_NUTRITION.tailwind_flasks;
  // spare_flasks: 0 is a legitimate "just the 2 mix flasks"; cap at 8 —
  // nobody carries nine flasks, and the cap bounds planFuel's fill loop
  // against a hostile flask_ml × spare_flasks product (render-path freeze)
  merged.spare_flasks = Number.isFinite(raw.spare_flasks) && (raw.spare_flasks as number) >= 0
    ? Math.min(8, Math.round(raw.spare_flasks as number)) : DEFAULT_NUTRITION.spare_flasks;
  return merged;
}
