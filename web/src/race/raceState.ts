/* ------------------------------------------------------------------ */
/*  race_state — the planner's numbers, for the coach chat turn        */
/*                                                                    */
/*  PRD-v2 §6. The chat endpoint can read every snapshot on disk and   */
/*  the facts digest, but not what the athlete is actually looking at: */
/*  the projection, the knob settings and the fuel plan are computed   */
/*  in the browser (useRacePlan) on every slider drag and are never    */
/*  written anywhere. Without them the coach answers "what does my     */
/*  fueling look like" from the race's config file, which is not the   */
/*  plan on screen. So the client sends a compact summary with each    */
/*  turn, and scripts/coach-prompt.mjs renders it as a short block.    */
/*                                                                    */
/*  The shape here is the WIRE shape, and its server-side twin is      */
/*  parseRaceState in scripts/coach-prompt.mjs: unknown keys there are */
/*  dropped rather than rejected, so adding a field here is safe ahead */
/*  of the renderer knowing a sentence for it.                         */
/*                                                                    */
/*  Why a channel rather than a hook call in AgentRail: the rail lives */
/*  OUTSIDE RacePlanProvider (App.tsx renders it beside the main       */
/*  column), and the provider is mounted only on the race and fuel     */
/*  views. Chat is used most from the training view, where no plan is  */
/*  mounted at all — so the planner publishes its summary here when it */
/*  has one, persisted per slug, and the rail reads the last one for   */
/*  the race currently on screen.                                      */
/* ------------------------------------------------------------------ */

import { useEffect } from "react";
import { planCaffeine } from "./caffeine";
import type { RacePlan } from "./useRacePlan";

/** The plan-derived half of race_state: everything only useRacePlan knows. */
export type PlanSnapshot = {
  slug: string;
  goal?: { projected_h?: number; target_h?: number; start_clock?: string; finish_clock?: string };
  knobs?: Record<string, number | string | boolean>;
  fuel?: {
    carb_g_h?: number; carb_g_total?: number;
    fluid_ml_h?: number; sodium_mg_h?: number; caffeine_mg_total?: number;
  };
  stations?: Array<{ name: string; mi: number; clock: string }>;
};

/** The whole payload the chat endpoint accepts. */
export type RaceState = Omit<PlanSnapshot, "slug"> & {
  mode: "train" | "view";
  slug?: string;
  name?: string;
  status?: { block_stale?: boolean; unresolved?: number; activated?: boolean; activation?: string };
  checkpoint?: { name?: string; mi?: number; clock?: string; delta_min?: number; source?: "tracker" | "manual" };
};

const snapshotKey = (slug: string) => `race.${slug}.chat_state`;

/* In memory as well as in localStorage: the rail reads this on the same tick
   the planner published it, and a private-mode browser (where every write
   below throws) still gets the state for as long as the tab is open. */
let live: PlanSnapshot | null = null;

/** Publish the plan summary for `snap.slug`. Overwrites the previous one. */
export function publishPlanSnapshot(snap: PlanSnapshot) {
  live = snap;
  try { localStorage.setItem(snapshotKey(snap.slug), JSON.stringify(snap)); }
  catch { /* private mode or quota — the in-memory copy still serves this tab */ }
}

/**
 * The last published summary for `slug`, or null.
 *
 * Matched on the slug rather than returned blind: after a race switch the
 * stored snapshot is for the race the athlete was looking at BEFORE, and
 * sending it would have the coach answer about the wrong race entirely.
 */
export function readPlanSnapshot(slug: string | null): PlanSnapshot | null {
  if (!slug) return null;
  if (live?.slug === slug) return live;
  try {
    const raw = localStorage.getItem(snapshotKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PlanSnapshot;
    return parsed && typeof parsed === "object" && parsed.slug === slug ? parsed : null;
  } catch { return null; }
}

const round = (n: number, places = 0) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Build the plan half of race_state from a mounted plan, or null when the
    plan has no projection yet (a race whose course has not been built). */
export function planSnapshot(plan: RacePlan): PlanSnapshot | null {
  const slug = plan.raceConfig?.slug;
  const proj = plan.proj;
  if (!slug || !proj) return null;

  const finishH = proj.finish_h.avg;
  const s = plan.settings;
  const knobs: Record<string, number | string | boolean> = {
    fatigue: round(s.fatigue, 3),
    calibration: round(s.calibration, 3),
    restraint: round(s.restraint, 3),
    altitude_pct: round(s.altitude),
    aid_stop_min: round(s.aidStopMin, 1),
    crew_stop_min: round(s.crewStopMin, 1),
    acclimation_days: plan.acclimation.days,
  };
  // Only worth a line when the athlete has actually overridden something:
  // "0 per-station stop overrides" is prompt tokens spent saying nothing.
  const overrides = Object.keys(s.stopOverrides ?? {}).length;
  if (overrides) knobs.per_station_stop_overrides = overrides;

  const fuel: PlanSnapshot["fuel"] = {
    fluid_ml_h: round(plan.nutrition.fluid_ml_hr),
    sodium_mg_h: round(plan.nutrition.sodium_mg_hr),
  };
  if (plan.fuelPlan) {
    fuel.carb_g_total = round(plan.fuelPlan.total_carb_g);
    // The config's carb rate is per PHASE and steps down through the race, so
    // a single phase number would misdescribe the plan. The realized average
    // over the projected finish is the number the athlete would check.
    if (finishH > 0) fuel.carb_g_h = round(plan.fuelPlan.total_carb_g / finishH);
    try {
      const caf = planCaffeine(
        proj, plan.sun, plan.fuelPlan, plan.raceStart,
        plan.nutrition.caffeine, plan.physiology.body_kg, plan.timeZone,
      );
      fuel.caffeine_mg_total = round(caf.total_mg);
    } catch {
      // Caffeine is keyed off sunrise/sunset and off the athlete's body mass;
      // a draft missing either is a normal state, not a reason to send no
      // fuel summary at all.
    }
  }

  return {
    slug,
    goal: {
      projected_h: round(finishH, 2),
      ...(proj.goal_h != null ? { target_h: round(proj.goal_h, 2) } : {}),
      start_clock: plan.clock(0),
      finish_clock: plan.clock(finishH),
    },
    knobs,
    fuel,
    stations: proj.stations.map((st) => ({
      name: st.station.name,
      mi: round(st.station.total_mi, 1),
      clock: plan.clock(st.eta_h.avg),
    })),
  };
}

/**
 * Publish this subtree's plan summary whenever it changes. Mounted once, by
 * RacePlanProvider — a second caller would just overwrite the same slot with
 * the same numbers.
 */
export function useRaceStateBeacon(plan: RacePlan) {
  useEffect(() => {
    const snap = planSnapshot(plan);
    if (snap) publishPlanSnapshot(snap);
  }, [plan]);
}

/** The runner's own "I'm at mile X" from race-day mode (RaceDay.tsx's
    usePosition), which is the only checkpoint this branch persists. It is a
    position, not a timed split: no clock and no delta are invented for it. */
function lastCheckpoint(slug: string): RaceState["checkpoint"] | undefined {
  try {
    const raw = localStorage.getItem(`race.${slug}.raceday_mi`);
    const mi = raw == null ? NaN : Number(raw);
    return Number.isFinite(mi) ? { mi: round(mi, 1), source: "manual" } : undefined;
  } catch { return undefined; }
}

/** The review payload's fields this cares about — GET /api/races/:slug
    (scripts/race-edit.mjs loadReview). Everything else in it is ignored. */
type ReviewStatus = {
  block_stale?: boolean;
  unresolved?: string[];
  unresolved_acknowledged?: string[];
  activation?: { ok?: boolean; errors?: string[] };
  race?: { status?: string };
};

/**
 * Assemble the race_state for one chat turn, or null when there is nothing to
 * send (generic mode, or a race whose planner has never been opened).
 *
 * One GET: the plan summary and the checkpoint are already local, and the
 * review payload is the only place block_stale / unresolved / activation
 * live. A failed or slow status fetch degrades to sending the plan without
 * it — a chat turn must not wait on, or fail because of, a status line.
 */
export async function buildRaceState(
  { mode, slug, name }: { mode: "train" | "view"; slug: string | null; name?: string | null },
  signal?: AbortSignal,
): Promise<RaceState | null> {
  if (!slug) return null;
  const snap = readPlanSnapshot(slug);
  const state: RaceState = { mode, slug };
  if (name) state.name = name;
  if (snap) {
    if (snap.goal) state.goal = snap.goal;
    if (snap.knobs) state.knobs = snap.knobs;
    if (snap.fuel) state.fuel = snap.fuel;
    if (snap.stations) state.stations = snap.stations;
  }
  const checkpoint = lastCheckpoint(slug);
  if (checkpoint) state.checkpoint = checkpoint;

  try {
    const res = await fetch(`/api/races/${encodeURIComponent(slug)}`, { signal });
    if (res.ok) {
      const review = (await res.json()) as ReviewStatus;
      const acked = new Set(review.unresolved_acknowledged ?? []);
      const open = (review.unresolved ?? []).filter((p) => !acked.has(p));
      const raceStatus = review.race?.status;
      const status: NonNullable<RaceState["status"]> = {
        block_stale: review.block_stale === true,
        unresolved: open.length,
        activated: raceStatus === "active",
      };
      // The activation gate only MEANS anything for a draft: for a race that
      // is already active it reports "only a draft can be activated", which
      // would read to the coach as a problem rather than as the normal state.
      if (raceStatus === "draft") {
        status.activation = review.activation?.ok
          ? "ready to activate"
          : `cannot activate yet: ${review.activation?.errors?.[0] ?? "the review gate is not satisfied"}`;
      }
      state.status = status;
    }
  } catch { /* offline, aborted, or no dev API — send the plan without status */ }

  return state;
}
