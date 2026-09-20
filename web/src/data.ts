import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { isValidTimeZone, raceStart } from "./race/clock";
import { netMessage } from "./race/dialogChrome";
import {
  activeRaceCacheKey, cacheGet, cachePut,
  getLastCachedSlug, getLastTrainSlug, pruneActiveRaceCache, setLastCachedSlug, setLastTrainSlug,
} from "./race/offlineCache";
import { fmtRaceClock } from "./race/pacing";
import type { ActiveBlock, ActiveRaceResponse, RaceConfig as RaceJson, RaceStatus } from "./race/types";

/* ------------------------------------------------------------------ */
/*  Contexts + hooks + helpers. The provider components live in        */
/*  providers.tsx (react-refresh needs component-only files).          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Refresh context — drives a "resync everything" pulse               */
/* ------------------------------------------------------------------ */

export type RefreshStep = "strava" | "streams" | "oura" | "gcal" | "coach";
export type StepStatus = "pending" | "running" | "done" | "error";
export type RefreshCtx = {
  key: number;
  syncing: boolean;
  lastSync: number;
  status: Partial<Record<RefreshStep, StepStatus>>;
  currentStep: RefreshStep | null;
  lastLog: string;
  refresh: () => void;
  /**
   * The same pulse `refresh` ends on — bump the key so every snapshot hook
   * refetches — WITHOUT running the sync scripts. What the race switcher
   * needs: changing which race is on screen changes what /api/race/active,
   * /nutrition.json and course.json answer, but nothing about Strava, Oura or
   * the calendar, and a menu click must not spawn five subprocesses and a
   * coach turn.
   */
  reload: () => void;
};
export const RefreshContext = createContext<RefreshCtx>({
  key: 0, syncing: false, lastSync: 0,
  status: {}, currentStep: null, lastLog: "",
  refresh: () => {}, reload: () => {},
});
export const useRefresh = () => useContext(RefreshContext);

export const REFRESH_STEPS: RefreshStep[] = ["strava", "streams", "oura", "gcal", "coach"];

/* ------------------------------------------------------------------ */
/*  Units context — imperial / metric toggle                           */
/* ------------------------------------------------------------------ */

export type System = "imperial" | "metric";
export type UnitsCtx = {
  system: System;
  toggle: () => void;
  // value formatters (input always in imperial source units)
  dist: (mi: number, digits?: number) => string;       // raw number string
  elev: (ft: number) => string;
  temp: (f: number) => string;                          // raw number string
  distUnit: string;                                     // "mi" | "km"
  elevUnit: string;                                     // "ft" | "m"
  tempUnit: string;                                     // "°F" | "°C"
  paceUnit: string;                                     // "/mi" | "/km"
  paceFmt: (sec: number, mi: number) => string;        // "8:42"
  // raw converters (for charts / math)
  distVal: (mi: number) => number;
  elevVal: (ft: number) => number;
};

export const UnitsContext = createContext<UnitsCtx | null>(null);
export const useUnits = () => {
  const v = useContext(UnitsContext);
  if (!v) throw new Error("UnitsProvider missing");
  return v;
};

/* ------------------------------------------------------------------ */
/*  Race + training block                                              */
/*                                                                     */
/*  GET /api/race/active is the ONE source: the active race folder, or */
/*  — in generic mode — the goals and the rolling 12-week window, both */
/*  computed server-side by scripts/block.mjs so the client and the    */
/*  coach can never disagree about which weeks are in the block.       */
/*  useBlockConfig() below is the only place components read it from.  */
/*                                                                     */
/*  There are deliberately NO hardcoded race defaults any more. A      */
/*  default race is a lie the whole UI then renders — a countdown to   */
/*  somebody else's finish line on a fresh checkout (PRD §6).          */
/* ------------------------------------------------------------------ */

export type Activity = {
  id: string;
  date: string;
  start_time_local?: string | null;
  title: string;
  type: "run" | "long" | "vert" | "easy" | "workout";
  distance_mi: number;
  elevation_ft: number;
  moving_s: number;
  avg_hr?: number | null;
  rpe: 1 | 2 | 3 | 4 | 5;
  strava_url?: string;
  temp_max_f?: number | null;
  temp_avg_f?: number | null;
  apparent_avg_f?: number | null;  // heat index / feels-like, avg over the activity
  humidity_avg?: number | null;
};

// Non-run Strava activity (ride, hike, strength, …). Shown in the log's
// "other" tab and surfaced to the coach agent only — never included in
// weekly buckets, vitals, ACR, or the pacing model.
export type CrossActivity = {
  id: string;
  date: string;
  start_time_local?: string | null;
  title: string;
  sport: string;
  distance_mi: number;
  elevation_ft: number;
  moving_s: number;
  avg_hr?: number | null;
  strava_url?: string;
};

/** One week of the block's plan. `wk` is 1-indexed within the block —
    in generic mode wk 12 is the current week and wk 1 is eleven weeks ago. */
export type WeekTarget = { wk: number; target_dist: number; target_elev: number };

export type AidStation = { mi: number; name: string };
export type RaceView = {
  name: string;
  short: string;
  distance_mi: number;
  elevation_ft: number;
  max_elev_ft: number;
  cutoff_h: number | null;
  date: Date;           // the race START instant, resolved in `timeZone`
  /** the race's IANA zone — the browser's only until a race folder is active */
  timeZone: string;
  /**
   * An elapsed race hour formatted on the RACE's wall clock ("6:00a", "2:14p+1").
   *
   * Bound here rather than left to each caller because roughly forty call
   * sites format a clock off this one race, and a single one of them passing
   * the browser's zone is an ETA that is quietly an hour out on a printed crew
   * sheet. Memoised with the rest of the config, so it is stable enough to sit
   * in a useMemo dependency list.
   */
  clock: (elapsedH: number) => string;
  location: string;
  aid_stations: AidStation[];
};
export type BlockConfig = {
  /** The active race, as the views need it — null in generic mode, and on
      every render before /api/race/active answers. Nothing may dereference
      it unguarded. */
  race: RaceView | null;
  blockStart: string;   // ISO date, Monday of week 1
  totalWeeks: number;
  targets: WeekTarget[];
  /** The agent's planned weeks — races/<slug>/plan.json, or, in generic
      mode, config/generic-plan.json. Empty until a coach run writes one. */
  planBlocks: PlanBlock[];
  /** "race" = an active folder's block.json, counting toward a date;
      "rolling" = generic mode's trailing 12-week window. Same discriminator
      the payload and scripts/facts.mjs use. */
  mode: "race" | "rolling";
  /**
   * Set only when a race is on screen that is NOT being trained for — the
   * pointer in view mode on an archived or draft folder (PRD §7). `race`
   * above is then that folder's, so its course, aid chart and fueling are
   * browsable, but the block and plan are the athlete's own rolling window:
   * the app shows the race, it does not train for it. Every "is there a race"
   * gate stays false, so the countdown and the coach's target don't move.
   */
  viewing: { slug: string; status: RaceStatus } | null;
  /** true until the first /api/race/active response. The views render the
      generic layout while it holds rather than flashing race furniture. */
  loading: boolean;
};

/** Generic mode's window length — mirrors scripts/block.mjs ROLLING_WEEKS. */
export const ROLLING_WEEKS = 12;

/**
 * The rolling window's start, computed client-side. Used ONLY while the
 * first /api/race/active response is in flight: the weekly buckets need a
 * Monday before the payload lands, and picking the same one the server will
 * send means the log doesn't re-bucket itself when it arrives. Must stay in
 * step with scripts/block.mjs mondayOf — local ISO week, Monday start.
 */
function rollingWindowStart(now = new Date()): string {
  const m = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  m.setDate(m.getDate() - ((m.getDay() + 6) % 7) - 7 * (ROLLING_WEEKS - 1));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${m.getFullYear()}-${p(m.getMonth() + 1)}-${p(m.getDate())}`;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export const within = (iso: string, days: number) => {
  const now = Date.now();
  return now - new Date(iso).getTime() < days * 86400 * 1000;
};

export const daysUntil = (d: Date) => {
  const now = Date.now();
  return Math.max(0, Math.ceil((d.getTime() - now) / 86400000));
};

/** daysUntil clamps at 0, so it cannot tell "today" from "last September".
    The read-only race ribbon needs that difference to pick its tense. */
export const isPast = (d: Date) => d.getTime() < Date.now();

export function isStale(iso: string, hours = 24) {
  return Date.now() - new Date(iso).getTime() > hours * 3600_000;
}

export function relativeAgo(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function fmtDuration(secs?: number | null) {
  if (!secs && secs !== 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

/* ------------------------------------------------------------------ */
/*  Strava data context — loads /strava.json snapshot                  */
/* ------------------------------------------------------------------ */

export type StravaCtx = {
  loading: boolean;
  error: string | null;
  fetchedAt: Date | null;
  activities: Activity[];
  // non-run activities — display + agent context only, never in metrics
  cross: CrossActivity[];
  crossError: string | null;   // fetch/parse failure (a missing file is not an error)
  crossLoading: boolean;       // cross-train.json fetch not yet settled
  crossSynced: boolean;        // cross-train.json loaded, even if empty
  // weekly buckets by training block week (1..totalWeeks) — runs only
  weekly: { wk: number; dist_mi: number; elev_ft: number; sessions: number }[];
  currentWeek: number; // 1..totalWeeks
};
export const StravaContext = createContext<StravaCtx | null>(null);
export const useStrava = () => {
  const v = useContext(StravaContext);
  if (!v) throw new Error("StravaProvider missing");
  return v;
};

/* ------------------------------------------------------------------ */
/*  Oura context — loads /oura.json snapshot                           */
/* ------------------------------------------------------------------ */

export type OuraDay = {
  day: string;
  sleep_score?: number | null;
  readiness_score?: number | null;
  activity_score?: number | null;
  total_sleep_s?: number | null;
  nap_s?: number | null;
  rem_sleep_s?: number | null;
  deep_sleep_s?: number | null;
  avg_hrv?: number | null;
  avg_hr?: number | null;
  lowest_hr?: number | null;
  temp_deviation_c?: number | null;
  steps?: number | null;
  tags?: { tag_type_code: string | null; comment: string | null; tags: string[] }[];
};
export type OuraRaw = {
  fetched_at: string;
  window: { start: string; end: string };
  summary: Record<string, number | null>;
  days: OuraDay[];
};
export type OuraCtx = {
  loading: boolean;
  connected: boolean;
  error: string | null;
  fetchedAt: Date | null;
  days: OuraDay[];
  latest: OuraDay | null;
  summary: OuraRaw["summary"];
};
export const OuraContext = createContext<OuraCtx | null>(null);
export const useOura = () => {
  const v = useContext(OuraContext);
  if (!v) throw new Error("OuraProvider missing");
  return v;
};

/* ------------------------------------------------------------------ */
/*  Agent / persistent state / calendar loaders                        */
/* ------------------------------------------------------------------ */

export type PlanBlock = {
  wk: number;
  label: string;
  dist_mi: number;
  elev_ft: number;
  focus: string;
  key_session?: string;
  quality?: number;
};
export type AgentReadout = {
  generated_at: string;
  model: string;
  summary: string;
  watch_outs?: string[];
  recommendations?: string[];
  plan_blocks?: PlanBlock[];
};

export type TemporaryContextItem = {
  id: string;
  text: string;
  added: string; // YYYY-MM-DD
  expires: string; // YYYY-MM-DD — the agent ignores the item after this date
  source: "user" | "agent";
};
export type CoachContext = {
  sections: { about_me: string; calendar_conventions: string; training_preferences: string };
  temporary: TemporaryContextItem[];
};
export type Preferences = {
  training_philosophy?: string;
  weekly_rest_day?: string;
  nutrition_target_kcal_per_hour?: number;
  heat_threshold_c?: number;
  context?: CoachContext;
} & Record<string, unknown>;

/* state.json v3 (tt-yib.2) carries the athlete, not the race: `race`,
   `block` and `plan_blocks` moved into races/<slug>/ (or, in generic mode,
   config/goals.json + config/generic-plan.json) and reach the client through
   /api/race/active instead. Nothing here may grow them back — two sources
   for the block is how the dashboard and the coach start disagreeing. */
export type PersistentState = {
  version: number;
  last_updated: string | null;
  agent_notes?: { at: string; note: string }[];
  preferences?: Preferences;
};

export type GCalEvent = {
  id: string;
  summary: string;
  description?: string;
  start: string | null;
  end: string | null;
  all_day: boolean;
  duration_min: number | null;
  location: string | null;
  classification: "race" | "travel" | "appointment" | "training" | "family" | "childcare" | "work" | "other";
  calendar?: string;
  html_link: string | null;
};
export type GCalRaw = {
  fetched_at: string;
  window: { time_min: string; time_max: string };
  calendar_id: string;
  calendar_ids?: string[];
  summary: {
    total_events: number;
    upcoming_events: number;
    races_upcoming: number;
    travel_days_upcoming: string[];
    childcare_days_upcoming?: string[];
  };
  events: GCalEvent[];
};

/** Measure a container's rendered width (for pixel-space SVG charts). */
export function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function useGoogleCal() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<GCalRaw | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch(`/google-cal.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { setData(d); setMissing(false); })
      .catch(() => setMissing(true));
  }, [refreshKey]);
  return { data, missing, connected: !!data };
}

/**
 * The active race folder, merged: `{ active: null }` when no race is active
 * (generic mode) — served by the dev-server's GET /api/race/active from
 * config/active-race.json + races/<slug>/. Keyed on the refresh pulse like
 * the other snapshot hooks, with their failure semantics: 404 means the
 * endpoint isn't there (a static preview build), which is an absence, not a
 * failure; anything else KEEPS the loaded race and surfaces `error`.
 */
type ActiveRaceResult =
  /** `staleMessage` set = this came out of localStorage after the fetch
      failed. The data is real, it is just not necessarily current, and the
      views say so rather than quietly drawing a plan from last night. */
  | { kind: "ok"; data: ActiveRaceResponse; staleMessage?: string }
  | { kind: "missing" }
  /** `viewOnlyCacheMiss` = the ONLY reason there was no offline copy to fall
      back to is that the last thing cached was a browsed (view-mode) race,
      not the training target — see the note on offline/error below. */
  | { kind: "error"; message: string; viewOnlyCacheMiss?: boolean };

/**
 * A failed load falls back to the last payload that DID load, if there is
 * one. Race-day mode is read on a phone that may have lost the laptop; an
 * empty screen at mile 60 is worse than a plan stamped "offline".
 *
 * A 404 never reaches here — that is the endpoint being absent (a static
 * preview build), which is an answer, not a failure.
 *
 * The cache is namespaced by slug (see offlineCache.ts), so this prefers the
 * entry for the athlete's actual training target — `getLastTrainSlug()` —
 * over whatever race the switcher happened to be pointed at last. A
 * view-mode payload (an archived/draft race merely browsed) is never handed
 * back AS the active plan: if the only cached copy is one of those, the
 * fallback stays an error and says so, rather than quietly training the
 * athlete's phone toward a race they were just looking at.
 */
function activeRaceFallback(message: string): ActiveRaceResult {
  const trainSlug = getLastTrainSlug();
  if (trainSlug !== undefined) {
    const cached = cacheGet<ActiveRaceResponse>(activeRaceCacheKey(trainSlug));
    if (cached) return { kind: "ok", data: cached, staleMessage: message };
  }
  // No train-mode cache to fall back to. If the last thing cached was a
  // browsed (view-mode) race, say so explicitly rather than leaving the
  // athlete guessing why the plan they were training for didn't come back.
  const lastSlug = getLastCachedSlug();
  if (lastSlug !== undefined) {
    const cachedAny = cacheGet<ActiveRaceResponse>(activeRaceCacheKey(lastSlug));
    if (cachedAny?.mode === "view") {
      return {
        kind: "error",
        message: `${message} — only a view-mode copy of "${lastSlug}" is cached offline`,
        viewOnlyCacheMiss: true,
      };
    }
  }
  return { kind: "error", message };
}

/**
 * ONE in-flight GET per refresh pulse, shared by every useActiveRace() caller.
 * useBlockConfig reads the race's zone, so this hook now mounts a dozen times
 * on a single screen; a dozen identical requests is a dozen chances for the
 * views to disagree mid-flight (and the same file fetched a dozen times).
 * Keyed by the pulse so "resync everything" still refetches exactly once.
 */
let activeRaceRequest: { key: number; p: Promise<ActiveRaceResult> } | null = null;

function requestActiveRace(key: number): Promise<ActiveRaceResult> {
  if (!activeRaceRequest || activeRaceRequest.key !== key) {
    activeRaceRequest = {
      key,
      p: fetch(`/api/race/active?t=${Date.now()}`)
        .then(async (r): Promise<ActiveRaceResult> => {
          if (r.status === 404) return { kind: "missing" };
          if (!r.ok) return activeRaceFallback(`active race failed to load (HTTP ${r.status})`);
          const data = (await r.json()) as ActiveRaceResponse;
          // Namespace by the payload's OWN slug (train mode: `active`; view
          // mode: `viewing`; generic mode: null) — never a single shared key
          // that a browsed archive could overwrite. Only a train-mode payload
          // (mode !== "view") updates `lastTrainSlug`, so browsing an
          // archived race can never make it the offline fallback's answer.
          const ownSlug = data.mode === "view" ? (data.viewing ?? null) : (data.active ?? null);
          cachePut(activeRaceCacheKey(ownSlug), data);
          setLastCachedSlug(ownSlug);
          if (data.mode !== "view") setLastTrainSlug(ownSlug);
          // Bound the cache to what actually matters offline: the athlete's
          // real training target and whatever was just looked at — not every
          // race the switcher has ever been pointed at (see pruneActiveRaceCache).
          pruneActiveRaceCache([getLastTrainSlug() ?? null, ownSlug]);
          return { kind: "ok", data };
        })
        // A rejected json() lands here too — that one really is "corrupt",
        // but the fetch() call itself rejecting (dev server unreachable —
        // killed, crashed, a phone that lost the LAN) is a different failure
        // that used to be reported with the same fixed "corrupt or
        // unreadable" wording regardless (ui3-resilience BUG 6). netMessage
        // tells the two apart from the error alone.
        .catch((e: unknown) => activeRaceFallback(netMessage(e) || "active race config corrupt or unreadable")),
    };
  }
  return activeRaceRequest.p;
}

export type ActiveRaceState = {
  activeRace: ActiveRaceResponse | null;
  /** the TRAINING target's slug — null in generic mode and in view mode */
  slug: string | null;
  /** the slug ON SCREEN: the same as `slug` in train mode, an archived or
      draft folder being browsed in view mode, null in generic mode */
  viewing: string | null;
  mode: "train" | "view";
  missing: boolean;
  error: string | null;
  /** the race on screen came from the offline cache, not from the server */
  offline: boolean;
  /** the failed reload's ONLY offline fallback was a view-mode (browsed, not
      trained-for) copy of some OTHER race — `error` still names the HTTP/
      parse failure for anyone reading it, but whatever plan is already on
      screen is otherwise fine, so a view (RaceDay) that shows `offline` as a
      friendly notice should treat this the same way rather than surfacing
      the internals-flavored message as a plain error. */
  viewOnlyCacheMiss: boolean;
  /** the request has settled — before that, "no active race" is not yet a fact
      (see the per-slug localStorage keys in race/useRacePlan.ts) */
  resolved: boolean;
};

export function useActiveRace(): ActiveRaceState {
  const { key: refreshKey } = useRefresh();
  const [state, setState] = useState<{
    data: ActiveRaceResponse | null; missing: boolean; error: string | null;
    offline: boolean; viewOnlyCacheMiss: boolean; resolved: boolean;
  }>({ data: null, missing: false, error: null, offline: false, viewOnlyCacheMiss: false, resolved: false });
  useEffect(() => {
    let stale = false;
    requestActiveRace(refreshKey).then((res) => {
      if (stale) return;
      // `staleMessage` = served from the offline cache. It is still an error
      // condition, so it lands in `error` as well — the fetch did fail.
      if (res.kind === "ok") setState({
        data: res.data, missing: false,
        error: res.staleMessage ?? null, offline: res.staleMessage != null,
        viewOnlyCacheMiss: false, resolved: true,
      });
      else if (res.kind === "missing") setState({
        data: null, missing: true, error: null, offline: false, viewOnlyCacheMiss: false, resolved: true,
      });
      // a failed reload KEEPS the race already on screen and surfaces the error
      else setState((prev) => ({
        ...prev, missing: false, error: res.message, viewOnlyCacheMiss: res.viewOnlyCacheMiss ?? false, resolved: true,
      }));
    });
    return () => { stale = true; };
  }, [refreshKey]);
  return {
    activeRace: state.data, slug: state.data?.active ?? null,
    viewing: state.data?.viewing ?? state.data?.active ?? null,
    mode: state.data?.mode === "view" ? "view" : "train",
    missing: state.missing, error: state.error, offline: state.offline,
    viewOnlyCacheMiss: state.viewOnlyCacheMiss, resolved: state.resolved,
  };
}

/* state.json is fetched once (by StateProvider in providers.tsx) and shared
   via this context — it feeds both the agent plan (RoadAhead) and the
   race/block config (useBlockConfig). */
export type StateCtx = { data: PersistentState | null; missing: boolean; reload: () => void };
export const PersistentStateContext = createContext<StateCtx>({ data: null, missing: false, reload: () => {} });

export const usePersistentState = () => useContext(PersistentStateContext);

/**
 * The single source of truth for race + training-block config: a thin
 * adapter over the /api/race/active payload.
 *
 * Both block shapes it can return are already computed server-side — a race
 * folder's block.json, or generic mode's rolling window from
 * scripts/block.mjs. The only things derived here are the race START instant
 * and the clock bound to it, because neither survives JSON.
 */
export function useBlockConfig(): BlockConfig {
  const { activeRace, resolved } = useActiveRace();
  // `active` is the pointer AND the mode AND the folder's status agreeing
  // (the server resolves all three); a draft or an archived race is only ever
  // on screen in view mode.
  const view = activeRace?.mode === "view" && activeRace.race ? activeRace : null;
  const raceJson = view ? view.race ?? null : activeRace?.active ? activeRace.race ?? null : null;
  // In view mode the WINDOW is the athlete's, not the browsed race's: those
  // weeks were (or would be) run for a race nobody is training for, and the
  // trajectory plots this month's mileage against them.
  const block: ActiveBlock | null = (view ? view.training?.block : activeRace?.block) ?? null;
  const planBlocks = (view ? view.training?.plan?.plan_blocks : activeRace?.plan?.plan_blocks) ?? null;
  // primitives, so the memo below is not invalidated by a fresh object on
  // every render
  const viewSlug = view?.viewing ?? null;
  const viewStatus = view?.race?.status ?? null;
  return useMemo(() => ({
    race: raceJson ? raceView(raceJson) : null,
    viewing: viewSlug && viewStatus ? { slug: viewSlug, status: viewStatus } : null,
    // Before the payload lands — and for a race folder with no block.json
    // yet — the window is the rolling one, so the layout that renders is the
    // generic layout rather than a flash of race furniture.
    blockStart: block?.start_date ?? rollingWindowStart(),
    totalWeeks: block?.total_weeks ?? ROLLING_WEEKS,
    // Empty, never invented: a made-up target renders as a plan the athlete
    // never agreed to. The views show an awaiting state instead.
    targets: block?.targets ?? [],
    planBlocks: planBlocks ?? [],
    mode: block?.mode === "race" ? "race" : "rolling",
    loading: !resolved,
  }), [raceJson, block, planBlocks, viewSlug, viewStatus, resolved]);
}

/**
 * race.json → what the views actually read: the START as an instant, the
 * zone every clock on the page formats in, and the aid chart flattened to
 * the {mi, name} pairs the ribbon plots.
 *
 * The race START is derived HERE and nowhere else. A race folder carries an
 * IANA zone, so its gun time is a wall clock in THAT zone — 06:00 in Arizona
 * is one instant whether the laptop is in Albuquerque or Auckland. A folder
 * with a malformed date, start_time or zone falls back to the browser's zone
 * rather than blanking every view in the app.
 */
function raceView(race: RaceJson): RaceView {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let start: Date | null = null;
  let timeZone = browserZone;
  if (race.date && race.start_time && isValidTimeZone(race.timezone)) {
    try {
      start = raceStart(race.date, race.start_time, race.timezone);
      timeZone = race.timezone;
    } catch { /* hand-edited race.json — fall through to the browser zone */ }
  }
  if (!start) start = new Date(`${race.date}T${race.start_time || "00:00"}:00`);
  const at = start;
  return {
    name: race.name,
    short: race.short,
    distance_mi: race.distance_mi,
    elevation_ft: race.gain_ft,
    max_elev_ft: race.elevation?.max_ft ?? 0,
    cutoff_h: race.cutoff_h ?? null,
    date: at,
    timeZone,
    clock: (elapsedH: number) => fmtRaceClock(at, elapsedH, timeZone),
    location: race.location ?? "",
    aid_stations: (race.aid_stations ?? []).map((a) => ({ mi: a.total_mi, name: a.name })),
  };
}

export function useAgentReadout() {
  const { key: refreshKey } = useRefresh();
  const [data, setData] = useState<AgentReadout | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    fetch(`/coach.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => setMissing(true));
  }, [refreshKey]);
  return { data, missing };
}

/* ------------------------------------------------------------------ */
/*  Coach facts — deterministic computation over Strava + Oura         */
/* ------------------------------------------------------------------ */

export type Flag = { severity: "info" | "watch" | "warn"; label: string; detail: string };
export type CoachFacts = {
  // load
  d7_dist_mi: number;
  d28_dist_mi: number;
  d7_elev_ft: number;
  d28_elev_ft: number;
  acr_dist: number;     // 7d / (28d/4)
  acr_elev: number;
  longest_d7_mi: number;
  longest_d7_title: string | null;
  sessions_d7: number;

  // recovery
  hrv_d7: number | null;
  hrv_d28: number | null;
  hrv_ratio: number | null;       // d7 / d28
  rhr_d7: number | null;
  rhr_d28: number | null;
  rhr_drift: number | null;       // d7 - d28
  readiness_d7: number | null;
  sleep_d7_total_h: number | null;
  sleep_debt_h: number | null;    // 7×8h target - actual
  recent_tags: { day: string; label: string }[];

  // block
  block_dist_actual: number;
  block_dist_expected: number;
  /** null when there is no block target to compare against yet (no
      block.json — a freshly activated race, or one still awaiting a plan
      run) — never a percentage computed against a faked-up denominator. */
  block_dist_delta_pct: number | null;
  block_elev_actual: number;
  block_elev_expected: number;
  block_elev_delta_pct: number | null;

  flags: Flag[];
  recommendations: string[];
};

function avg(values: (number | null | undefined)[]): number | null {
  const vs = values.filter((v): v is number => typeof v === "number");
  return vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
}
function sum(values: (number | null | undefined)[]): number {
  return values.reduce((acc: number, v) => acc + (typeof v === "number" ? v : 0), 0);
}
function withinDays(iso: string, days: number, now = Date.now()): boolean {
  return now - new Date(iso).getTime() < days * 86400 * 1000;
}

export function computeCoachFacts(
  activities: Activity[],
  ouraDays: OuraDay[],
  weekly: { wk: number; dist_mi: number; elev_ft: number }[],
  currentWeek: number,
  targets: WeekTarget[],
): CoachFacts {
  const now = Date.now();

  // load
  const d7  = activities.filter((a) => withinDays(a.date,  7, now));
  const d28 = activities.filter((a) => withinDays(a.date, 28, now));
  const d7_dist_mi  = sum(d7.map((a) => a.distance_mi));
  const d28_dist_mi = sum(d28.map((a) => a.distance_mi));
  const d7_elev_ft  = sum(d7.map((a) => a.elevation_ft));
  const d28_elev_ft = sum(d28.map((a) => a.elevation_ft));
  const longest = d7.reduce<Activity | null>((m, a) => (!m || a.distance_mi > m.distance_mi ? a : m), null);

  // recovery
  const o7  = ouraDays.filter((d) => withinDays(d.day,  7, now));
  const o28 = ouraDays.filter((d) => withinDays(d.day, 28, now));
  const hrv_d7  = avg(o7.map((d) => d.avg_hrv));
  const hrv_d28 = avg(o28.map((d) => d.avg_hrv));
  const rhr_d7  = avg(o7.map((d) => d.lowest_hr));
  const rhr_d28 = avg(o28.map((d) => d.lowest_hr));
  const readiness_d7 = avg(o7.map((d) => d.readiness_score));
  // Debt only counts nights with data — an un-synced night (today before the
  // ring uploads) must not be scored as 0h slept. Target prorates to 8h per
  // recorded night.
  const sleepNights = o7.filter((d) => typeof d.total_sleep_s === "number");
  const sleep_total_s = sum(sleepNights.map((d) => d.total_sleep_s));
  const sleep_d7_total_h = sleepNights.length ? sleep_total_s / 3600 : null;
  const sleep_debt_h = sleep_d7_total_h != null ? sleepNights.length * 8 - sleep_d7_total_h : null;

  const recent_tags = ouraDays
    .filter((d) => withinDays(d.day, 7, now))
    .flatMap((d) => (d.tags ?? []).map((t) => ({
      day: d.day,
      label: (t.tags && t.tags[0]) || t.tag_type_code || "tag",
    })));

  // block
  const block_dist_actual = sum(weekly.slice(0, currentWeek).map((w) => w.dist_mi));
  const block_elev_actual = sum(weekly.slice(0, currentWeek).map((w) => w.elev_ft));
  const block_dist_expected = sum(targets.slice(0, currentWeek).map((w) => w.target_dist));
  const block_elev_expected = sum(targets.slice(0, currentWeek).map((w) => w.target_elev));
  // No targets (an active race with no block.json yet) is a real "no data"
  // state, not a zero one — flooring the denominator at 1 turned a few
  // hundred actual miles into a +53655% tile instead of an empty one.
  const block_dist_delta_pct = block_dist_expected > 0
    ? ((block_dist_actual - block_dist_expected) / block_dist_expected) * 100 : null;
  const block_elev_delta_pct = block_elev_expected > 0
    ? ((block_elev_actual - block_elev_expected) / block_elev_expected) * 100 : null;

  // acute:chronic ratio (1.0 = consistent, >1.5 = load spike, <0.8 = detraining)
  const acr_dist = d28_dist_mi > 0 ? d7_dist_mi / (d28_dist_mi / 4) : 1;
  const acr_elev = d28_elev_ft > 0 ? d7_elev_ft / (d28_elev_ft / 4) : 1;

  // flags
  const flags: Flag[] = [];
  if (acr_dist > 1.5) flags.push({ severity: "warn", label: "load spike · distance",
    detail: `7d miles ${(acr_dist).toFixed(2)}× the 28d weekly avg — sharp ramp.` });
  else if (acr_dist > 1.3) flags.push({ severity: "watch", label: "load rising · distance",
    detail: `7d miles ${(acr_dist).toFixed(2)}× the 28d avg.` });
  if (acr_elev > 1.5) flags.push({ severity: "warn", label: "load spike · vert",
    detail: `7d vert ${(acr_elev).toFixed(2)}× the 28d avg — easy to bury yourself here.` });
  if (acr_dist < 0.7 && d28_dist_mi > 30) flags.push({ severity: "watch", label: "volume drop",
    detail: `7d miles only ${(acr_dist).toFixed(2)}× the 28d avg — taper or under-doing it?` });

  if (hrv_d7 != null && hrv_d28 != null) {
    const ratio = hrv_d7 / hrv_d28;
    if (ratio < 0.88) flags.push({ severity: "warn", label: "HRV suppressed",
      detail: `7d HRV ${Math.round(hrv_d7)} ms vs 28d ${Math.round(hrv_d28)} ms (${((ratio - 1) * 100).toFixed(0)}%).` });
    else if (ratio < 0.95) flags.push({ severity: "watch", label: "HRV trending down",
      detail: `7d HRV ${Math.round(hrv_d7)} ms vs 28d ${Math.round(hrv_d28)} ms.` });
  }
  if (rhr_d7 != null && rhr_d28 != null && rhr_d7 - rhr_d28 >= 3)
    flags.push({ severity: "warn", label: "RHR elevated",
      detail: `7d resting HR +${(rhr_d7 - rhr_d28).toFixed(1)} bpm vs 28d baseline — under-recovery signal.` });

  if (sleep_d7_total_h != null && sleepNights.length > 0
      && sleep_d7_total_h / sleepNights.length < 7) // 7h/night avg
    flags.push({ severity: "warn", label: "sleep debt",
      detail: `${sleep_d7_total_h.toFixed(1)}h slept over ${sleepNights.length} nights · ${sleep_debt_h!.toFixed(1)}h under the 8h/night target.` });

  if (readiness_d7 != null && readiness_d7 < 70)
    flags.push({ severity: "watch", label: "readiness depressed",
      detail: `7d readiness avg ${readiness_d7.toFixed(0)}.` });

  // Both flags need a real block target to mean anything — suppressed
  // (never computed from Math.max(1, 0)) for a race with no block.json yet.
  if (block_dist_delta_pct != null && block_dist_delta_pct < -10)
    flags.push({ severity: "watch", label: "behind block plan · distance",
      detail: `${block_dist_delta_pct.toFixed(1)}% under expected cumulative.` });
  if (block_elev_delta_pct != null && block_elev_delta_pct > 15)
    flags.push({ severity: "info", label: "ahead on vert",
      detail: `+${block_elev_delta_pct.toFixed(0)}% over expected — banking climbing-specific fitness.` });

  // recommendations from flags
  const recommendations: string[] = [];
  if (flags.some((f) => f.label.startsWith("load spike") || f.label === "HRV suppressed" || f.label === "RHR elevated"))
    recommendations.push("Swap the next quality session for an easy aerobic day. Re-assess in 72h.");
  if (flags.some((f) => f.label === "sleep debt"))
    recommendations.push("Protect Tuesday & Friday nights this week — no late screens, lights out by 22:30.");
  if (flags.some((f) => f.label === "HRV suppressed" || f.label === "RHR elevated"))
    recommendations.push("Skip caffeine after 14:00 and add a 10-min Z1 cooldown after every run.");
  if (block_dist_delta_pct != null && block_dist_delta_pct < -5 && !flags.some((f) => f.label === "HRV suppressed"))
    recommendations.push("Add one easy 60-90min Z1 day to the week without raising intensity.");
  if (flags.length === 0)
    recommendations.push("All systems green. Hold the current load, finish the block as planned.");
  recommendations.push(`Next quality target: long with 1500m+ vert at race-relevant grade.`);

  return {
    d7_dist_mi, d28_dist_mi, d7_elev_ft, d28_elev_ft, acr_dist, acr_elev,
    longest_d7_mi: longest?.distance_mi ?? 0,
    longest_d7_title: longest?.title ?? null,
    sessions_d7: d7.length,
    hrv_d7, hrv_d28, hrv_ratio: hrv_d7 != null && hrv_d28 != null ? hrv_d7 / hrv_d28 : null,
    rhr_d7, rhr_d28, rhr_drift: rhr_d7 != null && rhr_d28 != null ? rhr_d7 - rhr_d28 : null,
    readiness_d7, sleep_d7_total_h, sleep_debt_h, recent_tags,
    block_dist_actual, block_dist_expected, block_dist_delta_pct,
    block_elev_actual, block_elev_expected, block_elev_delta_pct,
    flags, recommendations,
  };
}
