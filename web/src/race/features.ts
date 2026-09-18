import type { RaceConfig } from "./types";

/* ------------------------------------------------------------------ */
/*  Which parts of the race views a given race even has.               */
/*                                                                    */
/*  The schema spans 50k–100mi trail ultras, so most of what the race  */
/*  view shows is optional: a crewless 50k has no crew sheet, no crew  */
/*  column and no crew-stop slider, and a race that ends before dark   */
/*  has no caffeine schedule. `race.json.features` says which of those */
/*  a race carries; `visual.panels` then lets the user hide panels the */
/*  race does have.                                                    */
/*                                                                    */
/*  Everything here defaults to VISIBLE. An absent flag — or no active */
/*  race at all (generic mode, and every render before the fetch       */
/*  lands) — means "show it", so a race folder written before a flag   */
/*  existed keeps rendering exactly as it did, and the views never     */
/*  flicker a panel in as the config arrives. The cost is that hiding  */
/*  something is always an explicit `false`, never an omission.        */
/*                                                                    */
/*  Pure functions over the config, deliberately: they are the one     */
/*  piece of the gating that is unit-testable without a DOM (see       */
/*  scripts/features.test.mjs), so the views hold conditionals and no  */
/*  logic.                                                            */
/* ------------------------------------------------------------------ */

/** Every flag `RaceFeatures` defines (PRD §5.1). */
export const FEATURE_KEYS = [
  "crew", "drop_bags", "pacers", "night", "heat", "altitude", "water_crossings",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Every flag resolved to a boolean — no `undefined` reaches a view. */
export type ResolvedFeatures = Record<FeatureKey, boolean>;

/**
 * One feature flag. True when the race is null (generic mode / still
 * loading) or the flag is absent — see the default-visible rule above.
 */
export function hasFeature(race: RaceConfig | null | undefined, name: string): boolean {
  const v = race?.features?.[name];
  return v === undefined ? true : v;
}

/** All of them at once, for a view that gates on several. */
export function resolveFeatures(race: RaceConfig | null | undefined): ResolvedFeatures {
  const out = {} as ResolvedFeatures;
  for (const k of FEATURE_KEYS) out[k] = hasFeature(race, k);
  return out;
}

/** Panels `visual.panels` can switch off. */
export const PANEL_KEYS = [
  "climb_comparison", "model_check", "crew_sheet", "drop_bag_card",
] as const;

export type PanelKey = (typeof PANEL_KEYS)[number];

export type VisiblePanels = Record<PanelKey, boolean>;

/* A panel whose data comes from a feature cannot outlive that feature:
   `visual.panels` may hide a panel, never resurrect one the race has no
   data behind. A crew sheet for a race that forbids crew would be a page
   of blank ETAs, so the flag wins over the panel preference. */
const PANEL_REQUIRES: Partial<Record<PanelKey, FeatureKey>> = {
  crew_sheet: "crew",
  drop_bag_card: "drop_bags",
};

/**
 * Which optional panels this race renders. Absent panel key = visible.
 */
export function visiblePanels(race: RaceConfig | null | undefined): VisiblePanels {
  const chosen = race?.visual?.panels;
  const out = {} as VisiblePanels;
  for (const k of PANEL_KEYS) {
    const req = PANEL_REQUIRES[k];
    const wanted = chosen?.[k];
    out[k] = (req === undefined || hasFeature(race, req)) && (wanted === undefined ? true : wanted);
  }
  return out;
}

/** Station-table cells that only some races have anything to put in. */
export type VisibleColumns = {
  /** CREW chip and the crew-drive line under it, the crew-stop slider */
  crew: boolean;
  /** DROP chip, and the drop-bag rows in the fuel plan */
  drop_bag: boolean;
  /** PACER chip */
  pacers: boolean;
};

/**
 * Which per-station access flags the planner table shows. The H₂O and
 * NO AID chips are not here: they describe a station that exists in every
 * race's chart, not an optional feature.
 */
export function visibleColumns(race: RaceConfig | null | undefined): VisibleColumns {
  return {
    crew: hasFeature(race, "crew"),
    drop_bag: hasFeature(race, "drop_bags"),
    pacers: hasFeature(race, "pacers"),
  };
}
