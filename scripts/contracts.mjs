// The tables more than one runtime has to agree on, letter for letter.
//
// Three runtimes share this codebase and none of them can import the others'
// modules directly:
//
//   - scripts/*.mjs — plain ESM under node, the writers and validators;
//   - web/vite.config.ts — the dev API, type-checked by tsconfig.node.json,
//     which has no `allowJs` and so cannot import a .mjs file at all;
//   - web/src/** — the React client, bundled by Vite, which must not reach
//     up into scripts/ (nothing there survives the production build).
//
// So a list like the legal race statuses used to be typed out once per
// runtime under a "KEEP IN SYNC" comment, and a drift between the copies was
// invisible until a value the dialog happily saved was rejected by the
// loader that read it back.
//
// This module is the single source. The direction is one-way: scripts import
// it here; `npm run contracts` (scripts/gen-contracts.mjs) writes
// web/src/contracts.ts from it for the other two, that generated file is
// committed, and scripts/contracts.test.mjs fails the suite if the two ever
// disagree. Edit a table HERE and re-run the generator — never edit
// web/src/contracts.ts by hand.
//
// What belongs here: a value both sides must agree on exactly. What does
// not: UI copy (the `label` below is here only because the loader quotes it
// in a warning; per-field hint text and input steps stay in the component),
// and anything only one runtime ever reads.

/* ---------------- generic mode: athlete goals ---------------- */

/** PRD §5.3. Ordered recovery → race-ready → holding pattern.
    Read by scripts/goals.mjs (validation), the settings PUT in
    web/vite.config.ts, and the phase picker in web/src/CoachSettings.tsx —
    an unvalidated phase would reach the coach prompt verbatim. */
export const GOAL_PHASES = [
  "recovery",
  "return_to_run",
  "base",
  "build",
  "peak",
  "taper",
  "maintain",
];

/* ---------------- the athlete's physiology ---------------- */

/** Fallback body mass, kg. Deliberately a round, IMPERSONAL number: the
    committed example profile must never carry the owner's real weight, and a
    plan built on this default is announced (see normalizePhysiology's
    warnings) rather than quietly wrong. Roughly a median adult male runner —
    close enough that the mg/kg caffeine band lands in the right ballpark,
    far enough from anyone in particular that nobody mistakes it for theirs. */
export const DEFAULT_BODY_KG = 75;

/** Fallback long-run reference distance, mi — the old pacing.ts `D_REF`. The
    projection evaluates its fitted fitness pace at this one distance and lets
    the fatigue curve carry everything past it, so it should sit in the middle
    of the athlete's actual long-run regime. */
export const DEFAULT_LONG_RUN_REF_MI = 20;

/** The editable physiology fields, with the bounds every writer enforces.
    `dflt` is what a missing/invalid value falls back to.

    Three readers, which is why it lives here: scripts/profile.mjs normalizes
    what it loads against these, the settings PUT in web/vite.config.ts
    validates what the dialog sends against them, and web/src/CoachSettings.tsx
    renders the inputs from them. The bounds have to agree or the dialog can
    save a value the loader then rejects and replaces with a default — the
    exact silent substitution the physiology block was introduced to end.
    config/profile.example.json's `physiology` block must also stay inside
    them; scripts/profile.test.mjs asserts that against the committed file.

    `optional: true` marks a field with no usable stand-in: it normalizes to
    null and, unlike the others, says nothing when it is missing. A default
    body mass still produces a roughly right caffeine band, so substituting
    one and warning is the honest move. There is no such number for where
    somebody lives — guessing sea level would quietly add hours of altitude
    penalty to a Denver athlete's race plan — so the field stays null and the
    views that use it ask for it by name. */
export const PHYSIOLOGY_FIELDS = {
  body_kg: { lo: 30, hi: 200, dflt: DEFAULT_BODY_KG, label: "body mass (kg)" },
  long_run_ref_mi: { lo: 5, hi: 50, dflt: DEFAULT_LONG_RUN_REF_MI, label: "long-run reference (mi)" },
  // −300 ft clears the Dead Sea and Death Valley; 15,000 ft clears every
  // inhabited place on earth by a wide margin.
  home_elevation_ft: { lo: -300, hi: 15000, dflt: null, optional: true, label: "home elevation (ft)" },
};

export const PHYSIOLOGY_KEYS = /** @type {const} */ (Object.keys(PHYSIOLOGY_FIELDS));

/** Days at altitude assumed when nobody has said otherwise: one — the
    fly-in-the-night-before case. scripts/acclimation.mjs returns it as its
    `source: "default"` branch, and web/src/race/useRacePlan.ts assumes it
    when the server told it nothing (a browsed race, generic mode, or a
    server too old to send the field), labelled "default" in the readout so
    it reads as an assumption rather than a measurement. */
export const DEFAULT_ACCLIMATION_DAYS = 1;

/* ---------------- race folders ---------------- */

/** races/<slug>/race.json `status`. At most one folder may be "active" — see
    validateSingleActive in scripts/race-config.mjs. The client mirrors it as
    RaceStatus (web/src/race/types.ts) and the race switcher groups by it. */
export const RACE_STATUSES = ["draft", "active", "archived"];

/**
 * Who last set a field. "computed" and "matcher" are third parties alongside
 * the human and the intake agent: scripts/race-sun.mjs derives `sun` from the
 * course coordinates, and scripts/race-build.mjs's aid-station matcher picks a
 * station's `gpx_wpt` out of the GPX — neither is a hand edit nor an agent
 * claim, and only "user" is protected from a re-intake merge. They are kept
 * apart because a matcher entry also carries its confidence and method, which
 * a re-match is allowed to overwrite; a computed one has no such gradient.
 */
export const PROVENANCE_BY = ["user", "agent", "computed", "matcher"];

/** Top-level keys PUT /api/races/:slug accepts. Anything else is refused BY
    NAME so the client gets told which field it invented rather than having it
    silently dropped — which means the review screen has to know the same
    list to know what it may send. */
export const EDITABLE_RACE_KEYS = [
  "aid_stations",
  "date",
  "visual",
  "tracking",
  "unresolved_acknowledged",
  "block_targets",
  "unresolved_fills",
];

/** Roots `unresolved_fills` will never write, whatever the folder declares.
    The first four are the folder's identity and the server's own bookkeeping;
    `aid_stations` is excluded because the review table's per-station editor
    already owns it with per-field validation, and a blanket path write would
    sneak past that. `sun` is excluded because it isn't a value a human types
    in — it's `{sunset, sunrise}`, computed by scripts/race-sun.mjs, and the
    generic fill path only ever writes a string/number/boolean/null, which
    would silently replace the object with garbage. The only fix is re-running
    the course build (see loadReview's unresolved_hints), or acknowledging it.

    The client needs the same list to know which unresolved paths to offer a
    fill box for; scripts/race-edit.mjs turns it into a Set. */
export const UNFILLABLE_ROOTS = [
  "schema_version", "slug", "status", "provenance", "sources",
  "unresolved", "unresolved_acknowledged", "aid_stations", "sun",
];
