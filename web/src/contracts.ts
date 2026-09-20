// GENERATED FILE — DO NOT EDIT.
//
// Written by scripts/gen-contracts.mjs from scripts/contracts.mjs, which is
// the single source for every table below and carries the reasoning for each
// one. Edit it there and run `npm run contracts` (the predev/prebuild/pretest
// hooks in web/package.json run it too); scripts/contracts.test.mjs fails if
// this file and that module disagree.
//
// It exists because neither the client bundle nor web/vite.config.ts can
// import a .mjs file, and hand-copied tables drift silently.

/** PRD §5.3 — the generic-mode training phases, recovery → holding pattern. */
export const GOAL_PHASES = [
  "recovery",
  "return_to_run",
  "base",
  "build",
  "peak",
  "taper",
  "maintain"
] as const;
export type GoalPhase = (typeof GOAL_PHASES)[number];

/** Impersonal fallback body mass, kg — announced when it is substituted. */
export const DEFAULT_BODY_KG = 75;

/** Fallback long-run reference distance, mi (pacing's old D_REF). */
export const DEFAULT_LONG_RUN_REF_MI = 20;

/** PRD §5.4 — the editable physiology fields and the bounds every writer enforces. */
export const PHYSIOLOGY_FIELDS = {
  body_kg: {
    lo: 30,
    hi: 200,
    dflt: 75,
    label: "body mass (kg)"
  },
  long_run_ref_mi: {
    lo: 5,
    hi: 50,
    dflt: 20,
    label: "long-run reference (mi)"
  },
  home_elevation_ft: {
    lo: -300,
    hi: 15000,
    dflt: null,
    optional: true,
    label: "home elevation (ft)"
  }
} as const;
export type PhysiologyKey = keyof typeof PHYSIOLOGY_FIELDS;

/** PHYSIOLOGY_FIELDS' keys, in dialog order. */
export const PHYSIOLOGY_KEYS = [
  "body_kg",
  "long_run_ref_mi",
  "home_elevation_ft"
] as const;

/** Days at altitude assumed when nobody has said otherwise — the night before. */
export const DEFAULT_ACCLIMATION_DAYS = 1;

/** races/<slug>/race.json `status`; at most one folder is "active". */
export const RACE_STATUSES = [
  "draft",
  "active",
  "archived"
] as const;
export type RaceStatus = (typeof RACE_STATUSES)[number];

/** Who last set a field — only "user" is protected from a re-intake merge. */
export const PROVENANCE_BY = [
  "user",
  "agent",
  "computed",
  "matcher"
] as const;
export type ProvenanceBy = (typeof PROVENANCE_BY)[number];

/** Top-level keys PUT /api/races/:slug accepts; anything else is refused by name. */
export const EDITABLE_RACE_KEYS = [
  "aid_stations",
  "date",
  "visual",
  "tracking",
  "unresolved_acknowledged",
  "block_targets",
  "unresolved_fills"
] as const;
export type EditableRaceKey = (typeof EDITABLE_RACE_KEYS)[number];

/** Roots `unresolved_fills` will never write, whatever the folder declares. */
export const UNFILLABLE_ROOTS = [
  "schema_version",
  "slug",
  "status",
  "provenance",
  "sources",
  "unresolved",
  "unresolved_acknowledged",
  "aid_stations",
  "sun"
] as const;
export type UnfillableRoot = (typeof UNFILLABLE_ROOTS)[number];
