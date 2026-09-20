import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  useRefresh, REFRESH_STEPS,
  useActiveRace,
  useUnits,
  useStrava,
  useOura, type OuraDay,
  useGoogleCal, usePersistentState, useAgentReadout,
  useBlockConfig,
  computeCoachFacts, type CoachFacts, type Flag,
  type Activity, type AgentReadout, type PlanBlock, type GCalEvent,
  daysUntil, isPast, relativeAgo, fmtDuration, isStale,
  useMeasuredWidth,
} from "./data";
import { RaceTheme, RefreshProvider, UnitsProvider, StravaProvider, OuraProvider, StateProvider } from "./providers";
import CoachSettings from "./CoachSettings";
import RaceIntake from "./race/RaceIntake";
import RaceRefresh from "./race/RaceRefresh";
import { SectionTag, Contours } from "./atoms";
import { RacePlanner } from "./race/RacePlanner";
import { ClimbComparison } from "./race/ClimbComparison";
import { NutritionPlan } from "./race/NutritionPlan";
import { ModelCheck } from "./race/ModelCheck";
import { RacePlanProvider } from "./race/RacePlanProvider";
import { buildRaceState } from "./race/raceState";
import { RaceErrorBoundary } from "./race/RaceErrorBoundary";
import { RaceDayRoute } from "./race/RaceDay";
import { RACE_DAY_HASH, useHashRoute } from "./race/hashRoute";
import { useCourse, useRaceResult } from "./race/useRaceData";
import { ArchiveRace } from "./race/ArchiveRace";
import { AddTuneUp } from "./race/AddTuneUp";
import { friendlyFetchError, runStage } from "./race/dialogChrome";
import type { RaceView } from "./data";
import { raceClockHM } from "./race/pacing";
import { ThemePreview } from "./themes/ThemePreview";
import type { VisualInput } from "./themes/visual";
import type { ActiveRaceResponse, RaceKind } from "./race/types";
import { isTuneUp } from "./race/features";

/* ================================================================== */
/*  BASECAMP — pre-dawn ops surface for ultra training                 */
/*  command bar · race ribbon · vitals band · trajectory ·             */
/*  road ahead (plan ∪ calendar) · log — with the coach as a           */
/*  persistent rail that never leaves your side.                       */
/* ================================================================== */

const SEVERITY_COLOR: Record<Flag["severity"], string> = {
  info:  "var(--pine)",
  watch: "var(--lamp)",
  warn:  "var(--ember)",
};

/* ------------------------------------------------------------------ */
/*  Shared atoms                                                       */
/* ------------------------------------------------------------------ */

function Spark({ values, color = "var(--mist-dim)", height = 34, fill = true }: {
  values: number[]; color?: string; height?: number; fill?: boolean;
}) {
  const vs = values.length > 1 ? values : [0, 0];
  const max = Math.max(...vs, 1);
  const min = Math.min(...vs, 0);
  const span = max - min || 1;
  const w = 100, h = 28;
  const step = w / (vs.length - 1);
  const path = vs.map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(2)} ${(h - ((v - min) / span) * (h - 2) - 1).toFixed(2)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }}>
      {fill && <path d={`${path} L ${w} ${h} L 0 ${h} Z`} fill={color} opacity="0.09" />}
      <motion.path
        d={path} fill="none" stroke={color} strokeWidth="1.2"
        strokeLinecap="round" strokeLinejoin="round"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
        transition={{ duration: 1.2, ease: "easeOut" }}
      />
      <circle cx={w} cy={h - ((vs[vs.length - 1] - min) / span) * (h - 2) - 1} r="1.8" fill={color} />
    </svg>
  );
}

function Delta({ value, suffix = "", good }: { value: number | null; suffix?: string; good: boolean | null }) {
  if (value == null) return <span className="eyebrow numerals">—</span>;
  const color = good == null ? "var(--mist-mute)" : good ? "var(--pine)" : "var(--ember)";
  return (
    <span className="numerals" style={{ fontSize: 10, letterSpacing: "0.08em", color }}>
      {value > 0 ? "▲" : value < 0 ? "▼" : "•"} {Math.abs(value).toFixed(Math.abs(value) < 10 ? 1 : 0)}{suffix}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Command bar — identity, block, countdown, sync, units              */
/* ------------------------------------------------------------------ */

function UnitsToggle() {
  const { system, toggle } = useUnits();
  const imperial = system === "imperial";
  return (
    <button
      onClick={toggle}
      title={`switch to ${imperial ? "metric" : "imperial"}`}
      style={{
        display: "inline-flex", border: "1px solid var(--edge-bright)",
        fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.12em",
        textTransform: "uppercase", position: "relative", height: 26, overflow: "hidden",
      }}
    >
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 380, damping: 30 }}
        style={{ position: "absolute", top: 0, bottom: 0, left: imperial ? 0 : "50%", width: "50%", background: "var(--lamp)" }}
      />
      <span style={{ padding: "0 9px", display: "grid", placeItems: "center", color: imperial ? "var(--night)" : "var(--mist-mute)", position: "relative", zIndex: 1, transition: "color 180ms" }}>mi·ft</span>
      <span style={{ padding: "0 9px", display: "grid", placeItems: "center", color: imperial ? "var(--mist-mute)" : "var(--night)", position: "relative", zIndex: 1, transition: "color 180ms" }}>km·m</span>
    </button>
  );
}

function BarStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ padding: "0 18px", borderLeft: "1px solid var(--edge)", display: "flex", flexDirection: "column", gap: 1, justifyContent: "center" }}>
      <span className="eyebrow" style={{ fontSize: 8, letterSpacing: "0.24em" }}>{label}</span>
      <span className="numerals" style={{ fontSize: 14, fontWeight: 600, color: accent ? "var(--lamp)" : "var(--mist)" }}>{value}</span>
    </div>
  );
}

type AppView = "training" | "race" | "nutrition";
/** Every view the app can render — the set a persisted preference is
    validated against, NOT the set on offer right now. */
const ALL_APP_VIEWS: AppView[] = ["training", "race", "nutrition"];
const isAppView = (v: string | null): v is AppView => v != null && (ALL_APP_VIEWS as string[]).includes(v);

/** The views this athlete actually has. Race and fuel are a race's views:
    with none active there is no course to project and no start clock to fuel
    against, so they are hidden rather than shown empty (PRD §6). */
function appViews(race: RaceView | null, hideFuel = false): AppView[] {
  if (!race) return ["training"];
  return hideFuel ? ALL_APP_VIEWS.filter((v) => v !== "nutrition") : ALL_APP_VIEWS;
}

/**
 * Whether the "fuel" chip is worth offering at all.
 *
 * The fuel view is built on races/<slug>/nutrition.json, and with no file it
 * falls back to the impersonal defaults (nutrition.ts) — which is the right
 * behaviour for an A race: a hundred always needs a fuel plan, and defaults
 * with a warning beat no page. A tune-up is the opposite case (PRD-v2 §3):
 * the quick form writes no nutrition.json, and a whole carb/caffeine plan
 * derived from nobody's numbers for a Saturday 50k is furniture, not advice.
 * So for kind "b" ONLY, the chip is hidden until the folder actually has a
 * nutrition.json — write one and it comes straight back.
 */
function fuelViewHidden(payload: ActiveRaceResponse | null): boolean {
  return isTuneUp(payload?.race ?? null) && (payload?.nutrition ?? null) == null;
}

const VIEW_LABEL: Record<AppView, string> = { training: "training", race: "race", nutrition: "fuel" };

/* ------------------------------------------------------------------ */
/*  Race switcher — config/active-race.json as a menu (PRD §7)         */
/* ------------------------------------------------------------------ */

/** One row of GET /api/races. `status` and `date` are null for a folder
    whose race.json would not parse — it is still listed, because hiding it
    would look like the race had been deleted. */
type RaceListEntry = {
  slug: string;
  name: string;
  short: string;
  status: "draft" | "active" | "archived" | null;
  date: string | null;
  /** the folder's `visual` block — the menu draws each race's accent */
  visual: VisualInput | null;
  /** "b" = a tune-up sitting inside `parent_slug`'s block (PRD-v2 §3). The
      server resolves the default: a folder written before v2 reads as "a". */
  kind?: RaceKind;
  parent_slug?: string | null;
  error: string | null;
};

/** The same rows nested, as GET /api/races' `groups` sends them: every A race
    carrying its tune-ups, oldest first, and an orphan B (its parent folder is
    gone) left at the top level rather than hidden. The nesting is derived
    SERVER-side — scripts/race-config.mjs's groupRaces — so the menu and the
    coach can never disagree about what hangs off what. `parent_missing` marks
    exactly that orphan case: it is still a tune-up (kind "b"), just one whose
    parent slug names a folder that is not on disk any more, and the row below
    renders it with the TUNE-UP marker and none of an A race's own actions
    rather than promoting it to a draft it never was (round 3, resilience
    finding 4). `parent_missing_reason` distinguishes a parent slug that
    names nothing on disk ("not_found") from one that names a real folder
    which is itself a tune-up, never a valid parent ("parent_is_tune_up") —
    round 3 resilience NEW-1. Either way `b_races` is always empty for an
    orphan; it is never a nesting target for anything else. */
type RaceGroupEntry = RaceListEntry & {
  b_races: RaceListEntry[];
  parent_missing?: true;
  parent_missing_reason?: "not_found" | "parent_is_tune_up";
};

/** An older dev server (or a cache written before v2) answers with the flat
    list only: every folder then stands on its own, which is the v1 menu. */
const flatGroups = (list: RaceListEntry[]): RaceGroupEntry[] => list.map((r) => ({ ...r, b_races: [] }));

/** The groups, in menu order. A folder with an unreadable race.json falls
    through all three and lands in its own group at the bottom. */
const RACE_GROUPS: { status: RaceListEntry["status"]; label: string }[] = [
  { status: "active", label: "active" },
  { status: "draft", label: "drafts" },
  { status: "archived", label: "archived" },
];

/** The last successfully-loaded race list, so a switcher open with the dev
    server unreachable can still show what races exist (greyed out) instead
    of collapsing to "New race…" as the only row that looks actionable
    (round 3, new finding 3). Written on every successful /api/races read;
    read only when that fetch fails AND the menu never loaded a list this
    session (`races` is still null) — a list already in state is kept as-is
    regardless of this cache. The ".v2" suffix is the tune-up nesting: the
    entry now holds the flat list AND the server's groups, and a v1 cache
    (a bare array) is simply not read rather than migrated. */
const RACES_CACHE_KEY = "bc.cache.races.v2";

/** The only mode a folder may be pointed at in — mirrors validateActivation
    in scripts/race-config.mjs, which is what actually enforces it. Picking it
    here rather than offering both keeps the menu one click deep: an active
    race is trained for, anything else is browsed. */
const modeFor = (status: RaceListEntry["status"]) => (status === "active" ? "train" : "view");

/** The races in menu order — grouped by status, unreadable folders last.
    The roving-focus index counts these after the "No race" row, so this
    order and the render order below are the same list. Tune-ups are NOT in
    it: a B race is rendered inside its A race's block (see rowsFor), not as
    a top-level row of its own. */
function orderedRaces(list: RaceGroupEntry[]): RaceGroupEntry[] {
  const known = RACE_GROUPS.flatMap((g) => list.filter((r) => r.status === g.status));
  return [...known, ...list.filter((r) => !RACE_GROUPS.some((g) => g.status === r.status))];
}

/** A draft or an active race gets a second row under it — "Review…" reopens
    the intake dialog's review screen on a folder that is already on disk,
    which is the only way back into it once the dialog has been closed
    (PRD §8). A folder whose race.json will not parse has nothing to review.
    Archived races stay without it: their aid chart/tracker are done being
    edited, and "Refresh from sources…" already covers a re-read of them.
    Used to be drafts-only (v2 review ui2 #2) — an active race's bib/name/
    tracker URL and unresolved fields still need a way back in, and race-day
    mode's own tracker notices ("set your bib on the review screen") send the
    runner to a screen that did not exist for the one race that most needs
    it: the one already running. */
const isReviewable = (r: RaceListEntry) => (r.status === "draft" || r.status === "active") && !r.error;

/** Any race whose race.json parses can be re-read from its own sources —
    draft, active or archived. An archived one is the interesting case: the
    organizer posts the finished results and the following year's chart to the
    same page, and a folder that is read-only in the app is not read-only to
    the intake. A folder we cannot parse has no links to refresh from. */
const isRefreshable = (r: RaceListEntry) => !r.error;

/** An archived race with no `build/course.json` (D8/R4) — a raced 100-miler
    whose course was never rebuilt, or one built before this feature existed
    — is otherwise a dead end: no "Review…" (that's drafts only), and
    "Refresh from sources…" is the paid re-intake, not the free deterministic
    build stage 2 already is. Offered for every archived folder rather than
    only ones already known to be missing course data — rebuilding is free
    and idempotent, and the row is the same one the race view's own "no
    course data" empty state now offers (RaceDay.tsx, NutritionPlan.tsx). */
const isRerunnable = (r: RaceListEntry) => r.status === "archived" && !r.error;

/** Only the race being TRAINED for gets an "Add tune-up…" row: a tune-up is
    a race inside a block, and a draft or an archived folder has no live block
    to sit inside (PRD-v2 §3 — `weeks_out` is counted from the A race the
    athlete is actually counting down to). A tune-up cannot itself hold one,
    and an unreadable folder has no slug to hang one off. */
const canAddTuneUp = (r: RaceGroupEntry, trainingSlug: string | null) =>
  // `trainingSlug` (useActiveRace().slug) is null in BOTH generic mode and
  // view mode — so browsing any folder (the active race's own tune-up, a
  // draft, an archive) used to blank this row for the one race it is always
  // valid on. `r.status === "active"` is the fact this row actually depends
  // on (only one folder may hold that status, and it IS the training
  // target — PRD-v2 §3), so it alone is checked whatever is on screen;
  // `r.slug === trainingSlug` stays as a redundant fast-path in train mode.
  (r.status === "active" || r.slug === trainingSlug) && r.kind !== "b" && !r.error;

/** How many menu rows a race contributes: itself, plus its "Review…",
    "Refresh from sources…" and "Run course again…" rows, plus one indented
    row per tune-up in its block and the "Add tune-up…" row that adds one.
    An orphaned tune-up (`parent_missing`) contributes only its own row — it
    is rendered outside all of that (see the switcher's render below), so it
    must not be counted as if the Review/Refresh/Rerun rows were there too.
    cursorForSlug and itemCount both count with this, and the render order
    below has to match it. */
const rowsFor = (r: RaceGroupEntry, trainingSlug: string | null) =>
  r.parent_missing ? 1 :
  1 + (isReviewable(r) ? 1 : 0) + (isRefreshable(r) ? 1 : 0) + (isRerunnable(r) ? 1 : 0)
  + r.b_races.length + (canAddTuneUp(r, trainingSlug) ? 1 : 0);

/** Where the cursor lands on a given slug, counting the "No race" row above
    the list and the extra rows each race contributes. Has to agree with the
    render order below — the roving-focus index is an index into the buttons
    as they are emitted, tune-up rows included. */
function cursorForSlug(list: RaceGroupEntry[], slug: string | null, trainingSlug: string | null): number {
  let i = 1;
  for (const r of orderedRaces(list)) {
    if (r.slug === slug) return i;
    // its own row, then Review / Refresh / Run-course-again, then the
    // tune-ups indented under it — the same order the render emits
    const own = r.parent_missing ? 1 : 1 + (isReviewable(r) ? 1 : 0) + (isRefreshable(r) ? 1 : 0) + (isRerunnable(r) ? 1 : 0);
    const bIdx = r.b_races.findIndex((b) => b.slug === slug);
    if (bIdx >= 0) return i + own + bIdx;
    i += rowsFor(r, trainingSlug);
  }
  return 0;
}

/** The kinds of row in the menu, in order: "No race (generic)", one per race
    folder (a draft followed by its "Review…" row, then every race's "Refresh
    from sources…" row, then an archived race's "Run course again…" row, then
    the tune-ups indented inside that race's block and — on the race being
    trained for — "Add tune-up…"), then, when there is a race to retire,
    "Archive with result…", then "New race…". */
type SwitcherItemKind = "generic" | "race" | "review" | "refresh" | "rerun" | "add-tune-up" | "archive" | "new";

/**
 * The short code in the command bar, as a menu over every race folder.
 *
 * Selecting one POSTs the pointer and then bumps the refresh pulse — NOT a
 * full resync: a different race means different race/course/nutrition files
 * and nothing about Strava, Oura or the calendar, and a menu click must not
 * spawn five subprocesses and a coach turn.
 */
function RaceSwitcher() {
  const { race, viewing } = useBlockConfig();
  const { slug: trainingSlug } = useActiveRace();
  const { reload } = useRefresh();

  const [open, setOpen] = useState(false);
  const [races, setRaces] = useState<RaceListEntry[] | null>(null);
  /* The same rows nested (GET /api/races' `groups`): tune-ups live inside
     their A race here, and this — not the flat list — is what the menu
     renders and what the roving-focus index counts. */
  const [grouped, setGrouped] = useState<RaceGroupEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `kind` distinguishes a real pointer switch from the free course-rebuild
  // stage sharing the same "which row is busy" slot (round 2, generic finding
  // 6: both used to report as "switching…", which is simply wrong for a
  // rebuild — see busyLabel below).
  const [busy, setBusy] = useState<{ slug: string; kind: "switch" | "build" } | null>(null);
  // Set once a "Run course again…" build finishes, so the row can say so
  // instead of the menu just closing with no confirmation at all (round 2,
  // generic finding 6). Self-clears; overwritten by the next thing that
  // matters (a fresh `error`, or busy again) via the effect below.
  const [builtNotice, setBuiltNotice] = useState<string | null>(null);
  // Synchronous re-entrancy guard: state-driven `disabled` on the rows can
  // only take effect once React re-renders, which does not happen mid-script
  // for a burst of clicks fired in the same tick (round 2, generic finding 2
  // — `row.disabled === false` on all three of three synchronous clicks).
  // This ref is checked and set before anything async happens, so the 2nd
  // and 3rd clicks in such a burst never even issue a request.
  const busyRef = useRef(false);
  /* The intake dialog, and which folder it opens on: null is the form ("New
     race…"), a slug is the review screen of a draft already on disk. */
  const [intake, setIntake] = useState<{ slug: string | null; parentSlug?: string } | null>(null);
  const [archiveOpen, setArchiveOpen] = useState<RaceListEntry | null>(null);
  /* The tune-up quick form, on the A race whose "Add tune-up…" row opened it
     (PRD-v2 §3). Null = closed. */
  const [tuneUpOn, setTuneUpOn] = useState<RaceGroupEntry | null>(null);
  /* The re-intake dialog. It opens on a folder that already exists, and may
     find a diff from an earlier run still waiting in it. */
  const [refreshing, setRefreshing] = useState<RaceListEntry | null>(null);
  const [cursor, setCursor] = useState(0);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const currentSlug = viewing?.slug ?? trainingSlug;

  // Top-level rows bucketed by status, in render order — the roving-focus
  // index is an index into THIS (each entry's tune-ups included, see
  // rowsFor). A tune-up is never its own bucket row: it is drawn indented
  // under its A race whatever its own status is, which is the whole point
  // of grouping them (PRD-v2 §3).
  const groups = useMemo(() => {
    const list = grouped ?? [];
    const known = RACE_GROUPS.map((g) => ({ label: g.label, entries: list.filter((r) => r.status === g.status) }));
    // a folder whose race.json would not parse belongs to no status
    const broken = list.filter((r) => !RACE_GROUPS.some((g) => g.status === r.status));
    return [...known, { label: "unreadable", entries: broken }].filter((g) => g.entries.length > 0);
  }, [grouped]);

  // An archived race with no activity linked still has a result to capture —
  // MM100 was archived by the migration long before its Strava run was.
  const { result: viewedResult } = useRaceResult(viewing?.status === "archived" ? viewing.slug : null);

  /**
   * The race an "Archive with result…" would act on: the one being trained
   * for (archiving it is how a race ends), or — with nothing in training —
   * the archived race on screen that never got its activity linked.
   * Null while the menu has not loaded the list yet: the row needs the
   * folder's name and date, not just its slug.
   *
   * Same root cause and fix as canAddTuneUp above: `trainingSlug`
   * (useActiveRace().slug) is null in BOTH generic mode and view mode, so
   * gating the first branch on it hid this row the instant anything but the
   * active race's own train-mode screen was on screen — even though nothing
   * about the training target changed (round 4 finding 5, the row this bug
   * shares with "Add tune-up…"). Each race already carries its own `status`
   * from GET /api/races, and "active" IS "the training target" (only one
   * folder may hold it), so it is checked directly instead.
   */
  const archiveTarget = useMemo(() => {
    const list = races ?? [];
    const active = list.find((r) => r.status === "active");
    if (active) return active;
    if (viewing?.status === "archived" && viewedResult?.strava_activity_id == null) {
      return list.find((r) => r.slug === viewing.slug) ?? null;
    }
    return null;
  }, [races, viewing, viewedResult]);

  /** menu length: "No race", every race with its own extra rows, maybe
      "Archive with result…", then "New race…" */
  const itemCount = (grouped ?? []).reduce((n, r) => n + rowsFor(r, trainingSlug), 0)
    + 2 + (archiveTarget ? 1 : 0);

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setError(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Load on every open: a draft the intake just wrote has to show up without
  // a page reload. The cursor lands ON the current race as the list arrives,
  // so the first Enter is a no-op rather than a surprise.
  useEffect(() => {
    if (!open) return;
    let stale = false;
    fetch(`/api/races?t=${Date.now()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`races failed to load (HTTP ${r.status})`);
        return (await r.json()) as { races: RaceListEntry[]; groups?: RaceGroupEntry[] };
      })
      .then((d) => {
        if (stale) return;
        // `groups` is the server's nesting (scripts/race-config.mjs's
        // groupRaces). A server that predates it still answers with the
        // flat list, and the menu then reads as it did in v1.
        const nested = d.groups ?? flatGroups(d.races);
        setRaces(d.races);
        setGrouped(nested);
        setCursor(cursorForSlug(nested, currentSlug, trainingSlug));
        // A successful read of the current server state is as good a signal
        // as any that whatever this menu was complaining about no longer
        // applies — clears a stale "another activation is already in
        // progress" left over from a resolved duplicate-click race, on the
        // next reopen even without an intervening switch of its own (round
        // 2, generic finding 5).
        setError(null);
        // So a LATER open with the server down (below) has something to show
        // instead of nothing — the whole point of this cache.
        try {
          localStorage.setItem(RACES_CACHE_KEY, JSON.stringify({ races: d.races, groups: nested }));
        } catch { /* ignore */ }
      })
      .catch((e: unknown) => {
        if (stale) return;
        // Keep whatever was loaded last, rather than blanking the list to
        // "New race…" as the one thing left that looks clickable — a paid
        // agent run is not a reasonable stand-in for "the server is down"
        // (round 2, resilience finding 6; round 3, new finding 3: a menu
        // that had never successfully loaded this session — first open,
        // server already unreachable — still fell back to empty, since
        // there was nothing in `prev` to keep). Fall back to the last
        // successfully-loaded list from localStorage in that case; the rows
        // render disabled/greyed (see `error` below) so nothing here claims
        // to be current.
        const cached = (() => {
          try {
            const raw = localStorage.getItem(RACES_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw) as { races?: RaceListEntry[]; groups?: RaceGroupEntry[] };
            if (!Array.isArray(parsed?.races)) return null;
            return { races: parsed.races, groups: parsed.groups ?? flatGroups(parsed.races) };
          } catch { return null; }
        })();
        setRaces((prev) => prev ?? cached?.races ?? []);
        setGrouped((prev) => prev ?? cached?.groups ?? []);
        setError(friendlyFetchError(e));
      });
    return () => { stale = true; };
  }, [open, currentSlug, trainingSlug]);

  useEffect(() => {
    if (open) itemRefs.current[cursor]?.focus();
  }, [open, cursor, itemCount]);

  // Click anywhere else closes — without stealing focus back, since the click
  // has already moved it somewhere the athlete chose.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  const choose = useCallback(async (slug: string | null, mode: "train" | "view") => {
    // See busyRef's comment above: a duplicate click fired before React
    // re-renders the (now-stale) `disabled` prop must still be a no-op.
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy({ slug: slug ?? "__generic__", kind: "switch" });
    setError(null);
    setBuiltNotice(null);
    try {
      const res = await fetch("/api/race/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, mode }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      close();
      // the pulse every panel is keyed on — race, course, fuel all refetch
      reload();
    } catch (e) {
      setError(friendlyFetchError(e));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [close, reload]);

  /** Stage 2 only — the free, deterministic build (validate → match GPX →
      compute sun → write build/course.json), the same endpoint the review
      dialog's "COURSE" run-again button calls (RaceIntake.tsx), reusing its
      SSE reader (dialogChrome.ts). Never the paid agent stage. Keeps the
      menu open with a busy row, the same pattern `choose` uses below, so a
      slow build doesn't look like the click did nothing. */
  const runCourseAgain = useCallback(async (slug: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy({ slug, kind: "build" });
    setError(null);
    setBuiltNotice(null);
    try {
      await runStage("/api/race-intake/build", { slug }, () => {}, new AbortController().signal);
      // Confirmation, not a silent close (round 2, generic finding 6): the
      // menu stays open long enough to say the build actually finished. The
      // reload pulse still fires now — the race/course views refetch right
      // away even though the row keeps its notice a little longer.
      reload();
      setBuiltNotice(slug);
      window.setTimeout(() => setBuiltNotice((cur) => (cur === slug ? null : cur)), 4000);
    } catch (e) {
      setError(friendlyFetchError(e));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }, [reload]);

  // The menu is `position: absolute` off a trigger that can sit anywhere in
  // the (wrapping) command bar — round 2, resilience finding 3: anchored
  // `left: 0` under a chip already ~130px in, the panel's fixed width ran
  // past the right edge of the document at 320/390px, on the one control a
  // phone needs most. Measured against the trigger's OWN viewport position
  // (not just capped by a max-width, which alone can't fix an anchor that is
  // already too far right for any reasonable width to fit) and clamped to a
  // GUTTER on both edges, so it can shift left of the trigger when it has to
  // but never past the document's own edges.
  const MENU_GUTTER = 16;
  const [menuLayout, setMenuLayout] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const width = Math.min(360, window.innerWidth - MENU_GUTTER * 2);
      const rect = trigger.getBoundingClientRect();
      const desiredLeft = Math.max(MENU_GUTTER, Math.min(rect.left, window.innerWidth - width - MENU_GUTTER));
      setMenuLayout({ left: desiredLeft - rect.left, width });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") { close(false); return; }
    const last = itemCount - 1;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c >= last ? 0 : c + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c <= 0 ? last : c - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setCursor(0); }
    else if (e.key === "End") { e.preventDefault(); setCursor(last); }
  };

  // The label: the race on screen, or "no race" in generic mode.
  const label = race ? race.short : "no race";
  const sub = viewing ? viewing.status : race ? "ops" : "generic";

  // Roving focus: exactly one item is tabbable, the arrow keys move it, and
  // the render order below has to stay in step with `items` above.
  let index = 0;
  const itemProps = (kind: SwitcherItemKind, slug?: string) => {
    const i = index++;
    const common = {
      ref: (el: HTMLButtonElement | null) => { itemRefs.current[i] = el; },
      tabIndex: cursor === i ? 0 : -1,
      onMouseEnter: () => setCursor(i),
    };
    return kind === "new" || kind === "archive" || kind === "review" || kind === "refresh"
      || kind === "rerun" || kind === "add-tune-up"
      ? { ...common, role: "menuitem" as const }
      : { ...common, role: "menuitemradio" as const, "aria-checked": kind === "generic" ? currentSlug == null : slug === currentSlug };
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        className="chip"
        onClick={() => (open ? close() : (setCursor(0), setOpen(true)))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) { e.preventDefault(); setCursor(0); setOpen(true); }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="switch race — active, drafts, archived, or no race at all"
        style={{
          fontSize: 8.5, padding: "3px 7px", display: "inline-flex", alignItems: "center", gap: 5,
          borderColor: viewing ? "var(--lamp)" : "var(--edge-bright)",
          color: viewing ? "var(--lamp)" : "var(--mist-mute)",
        }}
      >
        <span style={{ letterSpacing: "0.18em" }}>{label}</span>
        <span style={{ opacity: 0.6 }}>{sub}</span>
        <span aria-hidden style={{ fontSize: 7, transform: open ? "rotate(180deg)" : undefined, transition: "transform 160ms" }}>▼</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            ref={menuRef}
            role="menu"
            aria-label="race"
            onKeyDown={onKeyDown}
            initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14 }}
            className="panel"
            style={{
              position: "absolute", top: "calc(100% + 8px)", zIndex: 60,
              left: menuLayout?.left ?? 0,
              width: menuLayout?.width,
              minWidth: menuLayout ? undefined : 280,
              maxWidth: menuLayout ? undefined : `calc(100vw - ${MENU_GUTTER * 2}px)`,
              maxHeight: "70vh", overflowY: "auto",
              background: "var(--night-deep)", padding: "8px 0",
            }}
          >
            <SwitcherRow
              {...itemProps("generic")}
              label="No race (generic)"
              hint="train toward your goals"
              swatch={<ThemePreview visual={null} tokens={ACCENT_SWATCH} size={SWATCH_DOT} round label="basecamp palette" />}
              disabled={busy != null}
              busy={busy?.slug === "__generic__"}
              onSelect={() => choose(null, "train")}
            />
            {races === null && (
              <div className="eyebrow" style={{ padding: "8px 14px", fontSize: 8.5, color: "var(--mist-mute)" }}>loading races…</div>
            )}
            {groups.map((g) => (
              <div key={g.label}>
                <div className="eyebrow" style={{ padding: "10px 14px 4px", fontSize: 8, color: "var(--mist-dim)" }}>{g.label}</div>
                {g.entries.map((entry) => (
                  <Fragment key={entry.slug}>
                    <SwitcherRow
                      {...itemProps("race", entry.slug)}
                      label={entry.name}
                      hint={entry.error
                        ? "race.json unreadable"
                        // An orphaned tune-up (its parent folder is gone,
                        // round 3 resilience finding 4) keeps the same
                        // "tune-up ·" marker a nested one gets, plus WHY it
                        // is not nested under anything — a menu that quietly
                        // promoted it to a top-level A-shaped row looked
                        // exactly like a fresh draft the athlete never made.
                        : entry.parent_missing
                          ? `tune-up · ${entry.short}${entry.date ? ` · ${entry.date}` : ""} · read-only · ${
                              entry.parent_missing_reason === "parent_is_tune_up"
                                ? `parent "${entry.parent_slug ?? "?"}" is itself a tune-up`
                                : `parent "${entry.parent_slug ?? "?"}" not found`
                            }`
                          : `${entry.short}${entry.date ? ` · ${entry.date}` : ""}${entry.status === "active" ? "" : " · read-only"}`}
                      swatch={entry.error ? null : (
                        <ThemePreview visual={entry.visual} tokens={ACCENT_SWATCH} size={SWATCH_DOT} round />
                      )}
                      disabled={!!entry.error || busy != null || !!error}
                      // The rebuild stage shares this row's busy SLOT with a
                      // real pointer switch (both key off the same slug), but
                      // it must not borrow this row's busy DISPLAY too — a
                      // build is the "↳ Run course again…" row's own action,
                      // and confining the "building…" hint to that row (not
                      // also replacing this row's own subtitle) is round 2,
                      // generic finding 6's second half, still open as round
                      // 3's new finding 5.
                      busy={busy?.slug === entry.slug && busy.kind === "switch"}
                      busyLabel="switching…"
                      current={entry.slug === currentSlug}
                      // A tune-up — orphaned or not — is never trained for
                      // (PRD-v2 §3); modeFor(entry.status) would hand back
                      // "train" if a hand-edit ever left one reading
                      // "active" on disk, which is exactly the shape the
                      // pointer must refuse (scripts/race-config.mjs's
                      // validateActivation, kind gate).
                      onSelect={() => choose(entry.slug, entry.parent_missing ? "view" : modeFor(entry.status))}
                    />
                    {/* An orphan's parent folder is gone, so it gets none of
                        an A race's own actions — no Review (nothing to
                        activate it INTO), no Refresh (a quick-form tune-up
                        has no sources to re-read), no Run-course-again, no
                        tune-ups of its own and no Add-tune-up row. Only its
                        own row above, same as a normally-nested tune-up. */}
                    {!entry.parent_missing && isReviewable(entry) && (
                      <SwitcherRow
                        {...itemProps("review", entry.slug)}
                        label="↳ Review…"
                        hint={entry.status === "active"
                          ? "aid chart, profile, tracker bib/url"
                          : "aid chart, profile, unresolved · activate"}
                        disabled={busy != null || !!error}
                        onSelect={() => { setOpen(false); setIntake({ slug: entry.slug }); }}
                      />
                    )}
                    {!entry.parent_missing && isRefreshable(entry) && (
                      <SwitcherRow
                        {...itemProps("refresh", entry.slug)}
                        label="↳ Refresh from sources…"
                        hint="re-read the site and manual · diff before anything is written"
                        disabled={busy != null || !!error}
                        onSelect={() => { setOpen(false); setRefreshing(entry); }}
                      />
                    )}
                    {!entry.parent_missing && isRerunnable(entry) && (
                      <SwitcherRow
                        {...itemProps("rerun", entry.slug)}
                        label="↳ Run course again…"
                        hint={builtNotice === entry.slug
                          ? "course rebuilt ✓"
                          : "rebuild course.json from the stored gpx — free, no agent turn"}
                        busyLabel="building…"
                        disabled={busy != null || !!error}
                        busy={busy?.slug === entry.slug && busy.kind === "build"}
                        onSelect={() => runCourseAgain(entry.slug)}
                      />
                    )}
                    {/* the tune-ups inside this race's block, oldest first —
                        indented, and always browsed rather than trained for:
                        a B folder is never "active" (PRD-v2 §3), so picking
                        one is a view-mode switch whatever its status says.
                        Gated on !parent_missing too: an orphan's own b_races
                        (if it somehow had any) are never legitimate nested
                        children — groupRaces never populates them, but this
                        keeps the render honest even if that ever changes
                        (round 3 resilience NEW-1 — a chained orphan used to
                        render twice, once here and once as its own row). */}
                    {!entry.parent_missing && entry.b_races.map((b) => (
                      <SwitcherRow
                        key={b.slug}
                        {...itemProps("race", b.slug)}
                        indent
                        label={b.name}
                        hint={b.error
                          ? "race.json unreadable"
                          : `tune-up · ${b.short}${b.date ? ` · ${b.date}` : ""} · read-only`}
                        swatch={b.error ? null : (
                          <ThemePreview visual={b.visual} tokens={ACCENT_SWATCH} size={SWATCH_DOT} round />
                        )}
                        disabled={!!b.error || busy != null || !!error}
                        busy={busy?.slug === b.slug && busy.kind === "switch"}
                        busyLabel="switching…"
                        current={b.slug === currentSlug}
                        onSelect={() => choose(b.slug, "view")}
                      />
                    ))}
                    {!entry.parent_missing && canAddTuneUp(entry, trainingSlug) && (
                      <SwitcherRow
                        {...itemProps("add-tune-up", entry.slug)}
                        indent
                        label="↳ Add tune-up…"
                        hint="name, date, distance, gain, optional gpx — free, no agent turn"
                        disabled={busy != null || !!error}
                        onSelect={() => { setOpen(false); setTuneUpOn(entry); }}
                      />
                    )}
                  </Fragment>
                ))}
              </div>
            ))}
            <div style={{ borderTop: "1px solid var(--edge)", margin: "8px 0 0", paddingTop: 6 }}>
              {archiveTarget && (
                <SwitcherRow
                  {...itemProps("archive")}
                  // Which case archiveTarget matched — the active race
                  // (ending it), or an already-archived one merely missing
                  // its activity link — not `trainingSlug`, which reads null
                  // in view mode even while the active-race case applies.
                  label={archiveTarget.status === "active" ? "Archive with result…" : "Link result…"}
                  hint={archiveTarget.status === "active"
                    ? `${archiveTarget.short} · link the Strava run`
                    : `${archiveTarget.short} · no activity linked`}
                  disabled={busy != null || !!error}
                  onSelect={() => { setOpen(false); setArchiveOpen(archiveTarget); }}
                />
              )}
              <SwitcherRow
                {...itemProps("new")}
                label="New race…"
                hint="build a race folder from its website"
                disabled={busy != null}
                onSelect={() => { setOpen(false); setIntake({ slug: null }); }}
              />
            </div>
            {error && (
              <div style={{ padding: "8px 14px 2px", fontSize: 11, color: "var(--ember)", lineHeight: 1.4 }}>{error}</div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {intake && (
        <RaceIntake
          slug={intake.slug}
          parentSlug={intake.parentSlug ?? null}
          onClose={() => { setIntake(null); triggerRef.current?.focus(); }}
        />
      )}
      {refreshing && (
        <RaceRefresh
          slug={refreshing.slug}
          name={refreshing.name}
          onClose={() => { setRefreshing(null); triggerRef.current?.focus(); }}
        />
      )}
      {tuneUpOn && (
        <AddTuneUp
          parentSlug={tuneUpOn.slug}
          parentName={tuneUpOn.name}
          // the parent IS the training race (canAddTuneUp), so the payload on
          // screen is its own race.json — the zone the form offers to inherit
          parentTimezone={tuneUpOn.slug === trainingSlug ? race?.timeZone ?? null : null}
          parentDate={tuneUpOn.date}
          onClose={() => { setTuneUpOn(null); triggerRef.current?.focus(); }}
          onCreated={() => {
            setTuneUpOn(null);
            triggerRef.current?.focus();
            // the folder is on disk: the switcher's next open re-reads it,
            // and the payload's b_races (trajectory markers) refetch now
            reload();
          }}
          onRunIntake={() => {
            const parent = tuneUpOn.slug;
            setTuneUpOn(null);
            setIntake({ slug: null, parentSlug: parent });
          }}
        />
      )}
      {archiveOpen && (
        <ArchiveRace
          slug={archiveOpen.slug}
          name={archiveOpen.name}
          raceDate={archiveOpen.date}
          linkedActivityId={archiveOpen.slug === viewing?.slug ? viewedResult?.strava_activity_id ?? null : null}
          onClose={() => { setArchiveOpen(null); triggerRef.current?.focus(); }}
          onArchived={() => {
            setArchiveOpen(null);
            triggerRef.current?.focus();
            // same pulse as a switch: the pointer, the race and the result all
            // just changed under every panel
            reload();
          }}
        />
      )}
    </div>
  );
}

const SwitcherRow = ({ label, hint, onSelect, current, disabled, busy, busyLabel = "switching…", swatch, indent, ...rest }: {
  label: string; hint: string; onSelect: () => void;
  current?: boolean; disabled?: boolean; busy?: boolean;
  /** a row that belongs INSIDE the race above it — a tune-up in its A
      race's block, or the row that adds one (PRD-v2 §3). Indentation is the
      whole of the grouping the menu shows; the nesting itself is the
      server's (GET /api/races' `groups`). */
  indent?: boolean;
  /** what the hint line says while `busy` — a real pointer switch and the
      free course-rebuild stage are both "this row is busy" but are not the
      same claim (round 2, generic finding 6: a rebuild used to report
      "switching…", which the athlete never asked for). */
  busyLabel?: string;
  /** the race's palette, as one dot — see SWATCH_SLOT */
  swatch?: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement> & { ref?: React.Ref<HTMLButtonElement> }) => (
  <button
    {...rest}
    onClick={disabled ? undefined : onSelect}
    disabled={disabled || busy}
    style={{
      width: "100%", textAlign: "left", padding: indent ? "7px 14px 7px 32px" : "7px 14px",
      display: "flex", flexWrap: "wrap", alignItems: "baseline", rowGap: 2, columnGap: 8,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      background: "transparent",
    }}
    onFocus={(e) => {
      e.currentTarget.style.background = "var(--edge)";
      e.currentTarget.style.outline = "1px solid var(--lamp)";
      e.currentTarget.style.outlineOffset = "-1px";
    }}
    onBlur={(e) => {
      e.currentTarget.style.background = "transparent";
      e.currentTarget.style.outline = "none";
    }}
  >
    {/* One mark, not two: the dot IS the race's palette, and the race on
        screen is the one wearing a ring. (aria-checked on the row is what
        actually says "current" — this is its visible half.) Fixed width
        whether or not there is a dot, so the names stay in a column. */}
    <span
      aria-hidden
      style={{ ...SWATCH_SLOT, boxShadow: current ? "inset 0 0 0 1px var(--lamp)" : undefined }}
    >
      {swatch}
    </span>
    <span style={{ fontSize: 12.5, color: "var(--mist)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      {label}
    </span>
    {/* the label always gets the row to itself (swatch + label only); the
        hint is forced onto its own line below via flexBasis: 100% (a
        flex-wrap item with a 100% basis can't fit the remaining space on
        the label's line, so it wraps) rather than competing with the
        label for width and squeezing it to 0 (bug: a long hint like
        "re-read the site and manual…" left "↳ Refresh from sources…"
        rendering at 0px). It wraps or truncates within the menu instead
        of overflowing it. */}
    <span
      className="eyebrow"
      style={{
        fontSize: 8, color: "var(--mist-mute)", flexBasis: "100%",
        marginLeft: 19, whiteSpace: "normal", overflowWrap: "break-word",
      }}
    >
      {busy ? busyLabel : hint}
    </span>
  </button>
);

/** The switcher menu's left gutter: one accent dot per race, inside a slot
    that gains a lamp ring when that race is the one on screen. Same width on
    every row, dot or no dot, so the names stay in a column. */
const SWATCH_DOT = 6;
const SWATCH_SLOT: React.CSSProperties = {
  // 11px so the gutter costs the names almost nothing against the bullet it
  // replaces, and a 6px dot still has room for the ring
  width: 11, height: 11, borderRadius: "50%", flex: "0 0 auto", alignSelf: "center",
  display: "flex", alignItems: "center", justifyContent: "center",
};
/** The menu shows the light source and nothing else — the full seven-swatch
    strip belongs on a screen where a palette is being CHOSEN, not listed. */
const ACCENT_SWATCH = ["--lamp"] as const;

/** "you are looking at a race you are not training for" — on every view, so
    it can't be missed by switching tabs (PRD §7). */
function ViewingBanner() {
  const { race, viewing } = useBlockConfig();
  if (!viewing || !race) return null;
  const when = race.date.toLocaleDateString("en-US", {
    timeZone: race.timeZone, year: "numeric", month: "short", day: "numeric",
  }).toLowerCase();
  return (
    <div style={{
      display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap",
      borderLeft: "2px solid var(--lamp)", background: "rgba(198, 143, 62, 0.07)",
      padding: "9px 14px", margin: "18px 0 0",
    }}>
      <span className="eyebrow" style={{ color: "var(--lamp)", whiteSpace: "nowrap" }}>
        {viewing.status === "archived" ? `archived · ${when} · read-only`
          // An active race opened in view mode (only reachable by hand-editing
          // config/active-race.json today, per round 3, resilience finding 9)
          // still IS the training target — "draft · not activated" told the
          // athlete the opposite of the ACTIVE chip right next to it.
          : viewing.status === "active" ? "active · viewing read-only"
          : "draft · not activated"}
      </span>
      <span style={{ fontSize: 11.5, color: "var(--mist-mute)", lineHeight: 1.45 }}>
        viewing {race.name}. Training, the trajectory and the coach still work from your current
        goals — nothing here is being trained for.
      </span>
    </div>
  );
}

function CommandBar({ view, setView, railOpen, toggleRail }: {
  view: AppView; setView: (v: AppView) => void;
  railOpen: boolean; toggleRail: () => void;
}) {
  const { syncing, lastSync, refresh, currentStep, lastLog, status } = useRefresh();
  const { fetchedAt, currentWeek } = useStrava();
  const { race, viewing, totalWeeks } = useBlockConfig();
  // the raw payload, for the one question RaceView cannot answer: is the
  // folder on screen a tune-up, and does it carry a nutrition.json?
  const { activeRace } = useActiveRace();
  const views = appViews(race, fuelViewHidden(activeRace));
  const stamp = fetchedAt ? fetchedAt.getTime() : lastSync;
  // null in generic mode — every countdown below is gated on it, not faked —
  // and null while browsing, where "race in -371 days" is both useless and a
  // claim that this race is the one being trained for.
  const dleft = race && !viewing ? daysUntil(race.date) : null;
  // daysUntil clamps at 0, so a race trained for past its own date used to
  // read "RACE IN 0 days" forever instead of saying what actually happened
  // (PR #23 review round 2, generic finding 4 / resilience finding 9).
  const racePast = race && !viewing ? isPast(race.date) : false;
  const failedSteps = REFRESH_STEPS.filter((s) => status[s] === "error");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 20_000);
    return () => clearInterval(id);
  }, []);
  // Roving-tabindex focus targets, keyed by view — the WAI-ARIA tabs pattern
  // moves DOM focus itself on Arrow/Home/End, not just the selection state.
  const tabRefs = useRef<Partial<Record<AppView, HTMLButtonElement | null>>>({});

  return (
    <header style={{
      position: "sticky", top: 0, zIndex: 50,
      background: "rgba(12, 17, 14, 0.92)", backdropFilter: "blur(10px)",
      borderBottom: "1px solid var(--edge)",
    }}>
      <div className="command-bar" style={{ maxWidth: 1680, margin: "0 auto" }}>
        {/* wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: 4 }}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <path d="M1 14 L6 5 L9 10 L12 3 L17 14 Z" fill="none" stroke="var(--lamp)" strokeWidth="1.4" strokeLinejoin="round" />
            <circle cx="12" cy="3" r="1.6" fill="var(--lamp)" />
          </svg>
          <span className="display" style={{ fontSize: 17, letterSpacing: "-0.02em" }}>
            Basecamp
          </span>
          <RaceSwitcher />
        </div>

        {/* view switcher — training / race / fuel are one tabbed view, not
            three independent toggles, so a screen reader needs the tablist
            role and each button's selected state (round 3, resilience
            finding 12) rather than three plain buttons it has no way to
            relate to each other.

            Round 4 confirm, PARTIAL #12: the role was there but none of the
            keyboard contract it promises — no roving tabindex (both tabs
            carried tabindex=0), ArrowLeft/Right/Home/End moved nothing, and
            there was no aria-controls/role=tabpanel pair. Full WAI-ARIA tabs
            pattern below: roving tabindex (only the selected tab is in the
            page Tab order), arrow keys move AND activate (automatic
            activation — Enter/Space also work for free, since these stay
            native <button>s), Home/End jump to the ends with no wrap needed
            there, and each tab's aria-controls names the one tabpanel
            AppBody renders for the active view (see its `role="tabpanel"`
            wrapper). */}
        <div role="tablist" aria-label="view" style={{ display: "flex", gap: 6 }}>
          {views.map((v, i) => (
            <button
              key={v}
              ref={(el) => { tabRefs.current[v] = el; }}
              id={`tab-${v}`}
              role="tab"
              aria-selected={view === v}
              aria-controls={`tabpanel-${v}`}
              tabIndex={view === v ? 0 : -1}
              className={"chip" + (view === v ? " active" : "")}
              onClick={() => setView(v)}
              onKeyDown={(e) => {
                let nextIdx: number | null = null;
                if (e.key === "ArrowRight") nextIdx = (i + 1) % views.length;
                else if (e.key === "ArrowLeft") nextIdx = (i - 1 + views.length) % views.length;
                else if (e.key === "Home") nextIdx = 0;
                else if (e.key === "End") nextIdx = views.length - 1;
                if (nextIdx == null) return;
                e.preventDefault();
                const next = views[nextIdx];
                setView(next);
                tabRefs.current[next]?.focus();
              }}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>

        {/* mid stats */}
        <div className="commandbar-mid" style={{ flex: 1 }}>
          <BarStat label="block week" value={`${String(currentWeek).padStart(2, "0")} / ${totalWeeks}`} />
          {race && dleft != null && (
            racePast ? (
              <BarStat label="race day" value="has passed" />
            ) : (
              <>
                <BarStat label="race in" value={`${dleft} days`} accent />
                <BarStat label="race day" value={race.date.toLocaleDateString("en-US", { timeZone: race.timeZone, month: "short", day: "numeric" }).toLowerCase()} />
              </>
            )
          )}
        </div>

        {/* sync cluster */}
        <div className="command-bar-sync" style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
          <span
            className="eyebrow"
            title={lastLog}
            style={{
              color: syncing ? "var(--lamp)" : "var(--mist-mute)",
              maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {syncing
              ? (currentStep ? `${currentStep}… ${lastLog || ""}` : "starting…")
              : `synced ${relativeAgo(stamp)}`}
          </span>
          {!syncing && failedSteps.length > 0 && (
            <span
              className="eyebrow"
              title={`sync steps that failed: ${failedSteps.join(", ")} — this data may be stale`}
              style={{ color: "var(--ember)", whiteSpace: "nowrap" }}
            >
              · {failedSteps.join(", ")} failed
            </span>
          )}
          {syncing && (
            <span style={{ display: "inline-flex", gap: 4 }}>
              {REFRESH_STEPS.map((s) => (
                <span
                  key={s}
                  title={`${s}: ${status[s] ?? "pending"}`}
                  className={status[s] === "running" ? "pulse" : undefined}
                  style={{
                    width: 6, height: 6, transform: "rotate(45deg)",
                    background:
                      status[s] === "done" ? "var(--pine)" :
                      status[s] === "running" ? "var(--lamp)" :
                      status[s] === "error" ? "var(--ember)" : "var(--edge-bright)",
                  }}
                />
              ))}
            </span>
          )}
          <button
            className={"chip" + (railOpen ? " active" : "")}
            onClick={toggleRail}
            title={railOpen ? "collapse the coach rail" : "show the coach rail"}
          >
            coach
          </button>
          <UnitsToggle />
          <button
            onClick={refresh}
            disabled={syncing}
            className="chip"
            style={{
              borderColor: "var(--lamp)",
              color: syncing ? "var(--night)" : "var(--lamp)",
              background: syncing ? "var(--lamp)" : "transparent",
              cursor: syncing ? "wait" : "pointer",
              display: "inline-flex", alignItems: "center", gap: 6,
            }}
          >
            <span style={{ display: "inline-block", animation: syncing ? "spin 0.9s linear infinite" : undefined }}>↻</span>
            {syncing ? "syncing" : "resync"}
          </button>
          <button
            className="chip"
            onClick={() => setSettingsOpen(true)}
            title="coach settings — context, preferences, calendar markers"
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <span style={{ fontSize: 13, lineHeight: 1 }}>⚙</span> settings
          </button>
        </div>
      </div>
      {settingsOpen && <CoachSettings onClose={() => setSettingsOpen(false)} />}
      {/* sync progress filament */}
      <AnimatePresence>
        {syncing && (
          <motion.div
            initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} exit={{ scaleX: 0, transformOrigin: "right" }}
            transition={{ duration: 0.9, ease: "easeInOut" }}
            style={{ position: "absolute", bottom: -1, left: 0, right: 0, height: 1.5, background: "var(--lamp)", transformOrigin: "left" }}
          />
        )}
      </AnimatePresence>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/*  Race ribbon — name, countdown, elevation profile in one band       */
/* ------------------------------------------------------------------ */

// Pixel-space rendering (no viewBox stretching): uniform stroke weight on
// flats and climbs alike, and aid dots stay true circles.
const RIBBON_H = 96;
const RIBBON_PAD = { top: 10, bottom: 6 };

function ElevationRibbon({ race }: { race: RaceView }) {
  const u = useUnits();
  const { course } = useCourse();
  const { ref: measureRef, width } = useMeasuredWidth();

  // Real course profile from course.json; decorative ridge only as a
  // fallback for a checkout where `npm run course:build` hasn't run.
  const pts = useMemo(() => {
    if (width <= 0) return [];
    if (course && course.profile.length > 1) {
      const prof = course.profile;
      const target = Math.max(220, Math.min(600, Math.floor(width / 3)));
      const step = Math.max(1, Math.ceil(prof.length / target));
      const sel = prof.filter((_, i) => i % step === 0 || i === prof.length - 1);
      let lo = Infinity, hi = -Infinity;
      for (const p of sel) { if (p.ele_ft < lo) lo = p.ele_ft; if (p.ele_ft > hi) hi = p.ele_ft; }
      const span = hi - lo || 1;
      return sel.map((p) => ({
        x: (p.mi / course.distance_mi) * width,
        y: RIBBON_PAD.top + (1 - (p.ele_ft - lo) / span) * (RIBBON_H - RIBBON_PAD.top - RIBBON_PAD.bottom),
      }));
    }
    const n = 220;
    const arr: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const yy =
        50 +
        Math.sin(t * Math.PI * 6) * 20 +
        Math.sin(t * Math.PI * 14) * 5 +
        Math.sin(t * Math.PI * 2.1) * 7 +
        Math.cos(t * Math.PI * 9) * 3;
      arr.push({
        x: (i / (n - 1)) * width,
        y: RIBBON_PAD.top + ((100 - yy) / 100) * (RIBBON_H - RIBBON_PAD.top - RIBBON_PAD.bottom),
      });
    }
    return arr;
  }, [course, width]);

  const yAtX = (x: number) => {
    if (!pts.length) return RIBBON_H / 2;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
    return best.y;
  };

  // Real aid-station positions (GPX-snapped) when the course is loaded;
  // block-config miles (state.json or hardcoded defaults) otherwise.
  const aidDots = course
    ? course.aid_stations.map((a) => ({
        name: a.name, mi: a.total_mi, crew: a.crew || a.crew_only,
        x: (a.gpx_mi / course.distance_mi) * width,
      }))
    : race.aid_stations.map((a) => ({
        name: a.name, mi: a.mi, crew: false,
        x: (a.mi / race.distance_mi) * width,
      }));

  const linePath = pts.length
    ? "M" + pts.map((p) => p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" L ")
    : "";
  const areaPath = linePath ? `${linePath} L ${width.toFixed(1)} ${RIBBON_H} L 0 ${RIBBON_H} Z` : "";

  return (
    <div ref={measureRef} style={{ position: "absolute", inset: 0 }}>
      {width > 0 && pts.length > 1 && (
        <svg width={width} height={RIBBON_H} style={{ display: "block" }}>
          <defs>
            <linearGradient id="ribbonFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--lamp)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--lamp)" stopOpacity="0.01" />
            </linearGradient>
          </defs>
          {[0.3, 0.55, 0.8].map((f) => (
            <line key={f} x1="0" x2={width} y1={RIBBON_H * f} y2={RIBBON_H * f}
              stroke="var(--edge)" strokeWidth="1" strokeDasharray="2 6" />
          ))}
          <motion.path d={areaPath} fill="url(#ribbonFill)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1.2, delay: 0.4 }} />
          <motion.path
            d={linePath} fill="none" stroke="var(--lamp)" strokeWidth="1.5"
            strokeLinejoin="round" strokeLinecap="round"
            initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
            transition={{ duration: 2, ease: [0.2, 0.8, 0.2, 1] }}
          />
          {aidDots.map((a, i) => (
            <motion.circle
              key={a.name}
              cx={a.x} cy={yAtX(a.x)} r={a.crew ? 3 : 2.2}
              fill="var(--night)" strokeWidth="1.2"
              stroke={a.crew ? "var(--pine)" : "var(--mist-dim)"}
              initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ duration: 0.3, delay: 1.2 + i * 0.05 }}
            >
              <title>{a.name} · {u.dist(a.mi, 1)} {u.distUnit}{a.crew ? " · crew" : ""}</title>
            </motion.circle>
          ))}
        </svg>
      )}
    </div>
  );
}

/* Where the hero shows through: nothing behind the title, most of it behind
   the elevation profile, fading again under the tick row. Expressed as a mask
   rather than a gradient overlay so it carries no colour of its own — the
   panel underneath keeps whatever palette the race is wearing. */
const HERO_MASK =
  "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.3) 38%, rgba(0,0,0,0.92) 64%, rgba(0,0,0,0.22) 100%)";

/* Rendered only with a race on screen — AppBody does the gating, so the
   ribbon takes the race as a prop rather than re-deriving "is there one".
   `readOnly` is a race being BROWSED (view mode): it has no countdown, and
   "race in 000 days" on a race run last September would be a lie told in
   64px type. */
function RaceRibbon({ race, readOnly }: { race: RaceView; readOnly?: boolean }) {
  const u = useUnits();
  // The hero lives in the race FOLDER, so it comes off the payload rather
  // than RaceView (which is the shape the forty clock/pace call sites need).
  const { activeRace, viewing: viewingSlug } = useActiveRace();
  const hero = activeRace?.race?.visual?.hero;
  const heroSrc = hero && viewingSlug
    ? `/api/races/${encodeURIComponent(viewingSlug)}/asset/${encodeURIComponent(hero)}`
    : null;
  const dleft = daysUntil(race.date);
  const past = isPast(race.date);
  const nameWords = race.name.split(" ");
  // both read in the RACE's zone: "sep 12 · 06:00" is a fact about Arizona,
  // and on a laptop an hour ahead the browser's own zone would print 07:00
  const raceDay = race.date.toLocaleDateString("en-US", { timeZone: race.timeZone, month: "short", day: "numeric" }).toLowerCase();
  const raceStart = raceClockHM(race.date, race.timeZone);

  return (
    <motion.section
      className="panel notch"
      initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}
      style={{ overflow: "hidden" }}
    >
      {/* The race's own photograph, behind everything, and only where the
          profile is: masked out at the top so the name and countdown sit on
          the flat field they were designed for, and faded at the foot so the
          distance ticks stay readable. A background-image rather than an
          <img> so a hero the endpoint refuses is simply absent — no broken
          glyph, and the ribbon looks exactly as it does for a race with no
          hero at all. */}
      {heroSrc && (
        <div
          aria-hidden
          style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            backgroundImage: `url("${heroSrc}")`,
            backgroundSize: "cover",
            backgroundPosition: "center 45%",
            opacity: 0.42,
            maskImage: HERO_MASK,
            WebkitMaskImage: HERO_MASK,
          }}
        />
      )}
      <Contours seed={4} opacity={0.12} />
      <div style={{ position: "relative", padding: "22px 26px 0", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>objective{race.location ? ` — ${race.location.toLowerCase()}` : ""}</div>
          <h1 className="display" style={{ fontSize: "clamp(30px, 4.4vw, 54px)", margin: 0 }}>
            {nameWords.map((w, i) => (
              <span key={i} style={i === 1 ? { color: "var(--lamp)" } : undefined}>
                {w}{i < nameWords.length - 1 ? " " : ""}
              </span>
            ))}
          </h1>
          <div className="eyebrow" style={{ marginTop: 10, color: "var(--mist-dim)" }}>
            {u.dist(race.distance_mi)} {u.distUnit} · {u.elev(race.elevation_ft)} {u.elevUnit}↑
            {race.max_elev_ft > 0 && <> · max {u.elev(race.max_elev_ft)} {u.elevUnit}</>}
            {race.cutoff_h != null && <> · cutoff {race.cutoff_h}h</>} · {raceDay} · {raceStart}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          {readOnly ? (
            <>
              <div className="eyebrow">{past ? "raced" : "scheduled"}</div>
              <div className="numerals" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1.05, letterSpacing: "-0.03em", color: "var(--lamp)" }}>
                {race.date.toLocaleDateString("en-US", { timeZone: race.timeZone, year: "numeric", month: "short", day: "numeric" }).toLowerCase()}
              </div>
              <div className="eyebrow">read-only · not the training target</div>
            </>
          ) : (
            <>
              <div className="eyebrow">race in</div>
              <div className="numerals" style={{ fontSize: 64, fontWeight: 600, lineHeight: 0.95, letterSpacing: "-0.05em", color: "var(--lamp)" }}>
                {String(dleft).padStart(3, "0")}
              </div>
              <div className="eyebrow">days · {Math.floor(dleft / 7)} long runs left</div>
            </>
          )}
        </div>
      </div>
      <div style={{ position: "relative", height: 96, marginTop: 6 }}>
        <ElevationRibbon race={race} />
      </div>
      <div style={{ position: "relative", display: "flex", justifyContent: "space-between", padding: "6px 26px 12px", borderTop: "1px solid var(--edge)" }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <span key={f} className="eyebrow numerals" style={{ fontSize: 9 }}>
            {String(Math.round(u.distVal(race.distance_mi * f))).padStart(3, "0")} {u.distUnit}
          </span>
        ))}
      </div>
    </motion.section>
  );
}

/* ------------------------------------------------------------------ */
/*  Vitals band — load + recovery in one unified grammar               */
/* ------------------------------------------------------------------ */

type Vital = {
  key: string;
  label: string;
  value: string;
  unit?: string;
  delta?: { value: number | null; suffix?: string; good: boolean | null };
  series: number[];
  color: string;
  note?: string;
};

function VitalsBand() {
  const u = useUnits();
  const { activities } = useStrava();
  const oura = useOura();
  const facts = useFacts();
  const { targets, blockStart } = useBlockConfig();

  // anchor "now" once per mount — the section remounts on every resync
  // (AppBody keys it on the refresh counter), so this stays fresh without
  // an impure Date.now() during render
  const [now] = useState(() => Date.now());

  // daily series, last 30 days (oldest → newest). ACR uses the same
  // 7d/(28d/4) formula as computeCoachFacts. Block-delta DIVERGES: here weekly
  // targets are pro-rated by day so the trend moves within a week, whereas
  // computeCoachFacts counts the full current week's target at once.
  const daily = useMemo(() => {
    const n = 30;
    const m = n + 28; // extra history so the day-1 ACR has a full 28d window
    const dayMs = 86_400_000;
    const distLong = Array(m).fill(0) as number[];
    const dist = Array(n).fill(0) as number[];
    const elev = Array(n).fill(0) as number[];
    for (const a of activities) {
      const d = Math.floor((now - new Date(a.date).getTime()) / dayMs);
      if (d >= 0 && d < m) distLong[m - 1 - d] += a.distance_mi;
      if (d >= 0 && d < n) {
        dist[n - 1 - d] += a.distance_mi;
        elev[n - 1 - d] += a.elevation_ft;
      }
    }
    // rolling acute:chronic — 7d sum vs (28d sum / 4), per end-day
    const acr: number[] = [];
    for (let i = m - n; i < m; i++) {
      let a7 = 0, a28 = 0;
      for (let k = 0; k < 28 && i - k >= 0; k++) {
        a28 += distLong[i - k];
        if (k < 7) a7 += distLong[i - k];
      }
      acr.push(a28 > 0 ? a7 / (a28 / 4) : 1);
    }
    // block-vs-plan cumulative distance delta %, per day (weekly targets
    // pro-rated by day so the trend moves within a week)
    const start = new Date(blockStart + "T00:00:00").getTime();
    const blockDelta: number[] = [];
    for (let i = 0; i < n; i++) {
      const dayTime = now - (n - 1 - i) * dayMs;
      let act = 0;
      for (const a of activities) {
        const t = new Date(a.date).getTime();
        if (t >= start && t <= dayTime) act += a.distance_mi;
      }
      let rem = Math.max(0, Math.floor((dayTime - start) / dayMs) + 1);
      let exp = 0;
      for (const w of targets) {
        if (rem <= 0) break;
        const dd = Math.min(7, rem);
        exp += w.target_dist * (dd / 7);
        rem -= dd;
      }
      blockDelta.push(exp > 0 ? ((act - exp) / exp) * 100 : 0);
    }
    return { dist, elev, acr, blockDelta };
  }, [activities, now, targets, blockStart]);

  const ouraTail = oura.days.slice(0, 30).slice().reverse();
  const seriesOf = (f: (d: OuraDay) => number | null | undefined) => ouraTail.map((d) => f(d) ?? 0);

  // most recent non-null reading (last night's sync can lag a metric or two)
  const latestVal = (f: (d: OuraDay) => number | null | undefined): number | null => {
    for (const d of oura.days) {
      const v = f(d);
      if (v != null) return v;
    }
    return null;
  };
  const readiness = latestVal((d) => d.readiness_score);
  const hrv = latestVal((d) => d.avg_hrv);
  const rhr = latestVal((d) => d.lowest_hr);
  const sleepS = latestVal((d) => d.total_sleep_s);
  const latest = oura.latest;

  const vitals: Vital[] = [
    {
      key: "dist",
      label: "7d distance",
      value: u.dist(facts.d7_dist_mi, 0),
      unit: u.distUnit,
      delta: { value: (facts.acr_dist - 1) * 100, suffix: "% v28", good: facts.acr_dist <= 1.5 && facts.acr_dist >= 0.8 ? true : false },
      series: daily.dist,
      color: "var(--lamp)",
      note: `${facts.sessions_d7} sessions`,
    },
    {
      key: "vert",
      label: "7d vert",
      value: u.elev(facts.d7_elev_ft),
      unit: `${u.elevUnit}↑`,
      delta: { value: (facts.acr_elev - 1) * 100, suffix: "% v28", good: facts.acr_elev <= 1.5 },
      series: daily.elev,
      color: "var(--lamp)",
      note: `acr ${facts.acr_elev.toFixed(2)}×`,
    },
    {
      key: "acr",
      label: "acute : chronic",
      value: facts.acr_dist.toFixed(2),
      unit: "×",
      delta: undefined,
      series: daily.acr,
      color: facts.acr_dist > 1.5 ? "var(--ember)" : facts.acr_dist < 0.8 ? "var(--lamp)" : "var(--pine)",
      note: facts.acr_dist > 1.5 ? "load spike" : facts.acr_dist < 0.8 ? "volume low" : "in band",
    },
    {
      key: "block",
      label: "block vs plan",
      // No block.json yet (a freshly activated race) is "no data", not a
      // percentage computed against a faked denominator — was showing
      // "+53655%" / "9816273% vert" the instant a race with no block went live.
      value: facts.block_dist_delta_pct != null
        ? `${facts.block_dist_delta_pct >= 0 ? "+" : ""}${facts.block_dist_delta_pct.toFixed(0)}` : "—",
      unit: facts.block_dist_delta_pct != null ? "%" : undefined,
      delta: facts.block_elev_delta_pct != null
        ? { value: facts.block_elev_delta_pct, suffix: "% vert", good: facts.block_elev_delta_pct >= 0 }
        : undefined,
      series: daily.blockDelta,
      color: facts.block_dist_delta_pct != null && facts.block_dist_delta_pct >= 0 ? "var(--pine)" : "var(--mist-mute)",
      note: facts.block_dist_delta_pct != null ? "cumulative dist" : "no block yet",
    },
    {
      key: "readiness",
      label: "readiness",
      value: readiness != null ? String(readiness) : "—",
      delta: { value: readiness != null && facts.readiness_d7 != null ? readiness - facts.readiness_d7 : null, suffix: " v7d", good: readiness != null && facts.readiness_d7 != null ? readiness >= facts.readiness_d7 : null },
      series: seriesOf((d) => d.readiness_score),
      color: "var(--pine)",
      note: latest?.temp_deviation_c != null ? `temp ${latest.temp_deviation_c > 0 ? "+" : ""}${latest.temp_deviation_c.toFixed(2)}°C` : undefined,
    },
    {
      key: "hrv",
      label: "hrv",
      value: hrv != null ? String(Math.round(hrv)) : "—",
      unit: "ms",
      delta: { value: facts.hrv_ratio != null ? (facts.hrv_ratio - 1) * 100 : null, suffix: "% 7v28", good: facts.hrv_ratio != null ? facts.hrv_ratio >= 0.95 : null },
      series: seriesOf((d) => d.avg_hrv),
      color: "var(--creek)",
      note: latest?.avg_hr != null ? `sleep hr ${Math.round(latest.avg_hr)}` : undefined,
    },
    {
      key: "rhr",
      label: "resting hr",
      value: rhr != null ? String(Math.round(rhr)) : "—",
      unit: "bpm",
      delta: { value: facts.rhr_drift, suffix: " drift", good: facts.rhr_drift != null ? facts.rhr_drift < 3 : null },
      series: seriesOf((d) => d.lowest_hr),
      color: "var(--creek)",
    },
    {
      key: "sleep",
      label: "last night's sleep",
      value: sleepS != null ? fmtDuration(sleepS) : "—",
      delta: { value: facts.sleep_debt_h != null ? -facts.sleep_debt_h : null, suffix: "h 7d-debt", good: facts.sleep_debt_h != null ? facts.sleep_debt_h <= 0 : null },
      series: seriesOf((d) => (d.total_sleep_s ?? 0) / 3600),
      color: "var(--creek)",
      note: latest?.sleep_score != null ? `score ${latest.sleep_score}` : undefined,
    },
  ];

  return (
    <section>
      <SectionTag
        right={
          <span className="eyebrow">
            {oura.connected ? `ring · ${oura.days.length} nights` : "ring not connected"} · strava · {activities.length} runs
          </span>
        }
      >
        vitals — load × recovery
      </SectionTag>
      <div className="vitals-band">
        {vitals.map((v, i) => (
          <motion.div
            key={v.key}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.08 + i * 0.05 }}
            style={{ padding: "14px 14px 10px", minWidth: 0 }}
          >
            <span className="eyebrow" style={{ fontSize: 8.5, whiteSpace: "nowrap", display: "block" }}>{v.label}</span>
            <div className="numerals" style={{ fontSize: 27, fontWeight: 600, letterSpacing: "-0.04em", marginTop: 7, color: v.value === "—" ? "var(--mist-mute)" : "var(--mist)" }}>
              {v.value}
              {v.unit && <span style={{ fontSize: 11, fontWeight: 400, color: "var(--mist-mute)", marginLeft: 4 }}>{v.unit}</span>}
            </div>
            <div style={{ marginTop: 4, minHeight: 12, whiteSpace: "nowrap" }}>
              {v.delta && <Delta value={v.delta.value} suffix={v.delta.suffix} good={v.delta.good} />}
            </div>
            <div style={{ marginTop: 8 }}>
              {v.series.some((x) => x !== 0)
                ? <Spark values={v.series} color={v.color} height={30} />
                : <div style={{ height: 30, display: "grid", placeItems: "center", border: "1px dashed var(--edge)" }}>
                    <span className="eyebrow" style={{ fontSize: 8 }}>no data</span>
                  </div>}
            </div>
            <div className="eyebrow" style={{ fontSize: 8, marginTop: 6, color: "var(--mist-mute)", minHeight: 10 }}>
              {v.note ?? ""}
            </div>
          </motion.div>
        ))}
      </div>
      {!oura.connected && !oura.loading && <ConnectStrip kind="oura" />}
      <SleepStagesInline />
    </section>
  );
}

function SleepStagesInline() {
  const { latest, connected } = useOura();
  if (!connected || !latest) return null;
  const total = latest.total_sleep_s ?? 0;
  if (!total) return null;
  const deep = (latest.deep_sleep_s ?? 0) / total;
  const rem = (latest.rem_sleep_s ?? 0) / total;
  const light = Math.max(0, 1 - deep - rem);
  const segs = [
    { pct: deep, label: "deep", color: "var(--creek)" },
    { pct: rem, label: "rem", color: "var(--lamp)" },
    { pct: light, label: "light", color: "var(--edge-bright)" },
  ];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 8, padding: "0 2px" }}>
      <span className="eyebrow" style={{ fontSize: 8.5, whiteSpace: "nowrap" }}>last night</span>
      <div style={{ flex: 1, display: "flex", height: 6, background: "var(--night-deep)", border: "1px solid var(--edge)" }}>
        {segs.map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ width: 0 }} animate={{ width: `${s.pct * 100}%` }}
            transition={{ duration: 0.7, delay: 0.3 + i * 0.12, ease: "easeOut" }}
            style={{ background: s.color }}
            title={`${s.label} · ${(s.pct * 100).toFixed(0)}%`}
          />
        ))}
      </div>
      <span className="eyebrow numerals" style={{ fontSize: 8.5, whiteSpace: "nowrap" }}>
        {segs.map((s) => `${s.label} ${(s.pct * 100).toFixed(0)}%`).join(" · ")}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Trajectory — cumulative actual vs plan, the centerpiece chart      */
/* ------------------------------------------------------------------ */

/** "jul 7" — the Monday a block week starts on. Generic mode has no week
    numbers worth reading out ("wk 12" of a window that always ends today),
    so its weeks are labelled by date instead. */
function weekStartLabel(wk: number, blockStart: string): string {
  const start = new Date(new Date(blockStart + "T00:00:00").getTime() + (wk - 1) * 7 * 86400_000);
  return start.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();
}

function weekDates(wk: number, blockStart: string): string {
  const start = new Date(new Date(blockStart + "T00:00:00").getTime() + (wk - 1) * 7 * 86400_000);
  const end = new Date(start.getTime() + 6 * 86400_000);
  const f = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }).toLowerCase();
  return `${f(start)} – ${f(end)}`;
}

/** A tune-up's marker label: initials plus the distance in the name, the
    same rule scripts/race-intake.mjs's shortFromName writes into race.json's
    `short` ("Deadman Peaks 50k" → "DP50K"). A cosmetic twin, not a contract —
    the payload's b_races carry the full name and no short, and a chart axis
    has room for about five characters. */
function tuneUpTag(name: string): string {
  const words = String(name ?? "").split(/\s+/).filter(Boolean);
  const initials = words.filter((w) => /^[a-z]/i.test(w)).map((w) => w[0].toUpperCase()).join("");
  const distance = words.map((w) => /^(\d+(?:\.\d+)?)(k|km|mi|m|h)?$/i.exec(w)).find(Boolean);
  const tail = distance ? `${distance[1]}${(distance[2] ?? "").toUpperCase()}` : "";
  return `${initials}${tail}`.slice(0, 8) || name.slice(0, 8).toUpperCase() || "TUNE-UP";
}

function Trajectory() {
  const u = useUnits();
  const { weekly, currentWeek } = useStrava();
  // `mode` below is the CHART mode (cumulative/weekly); the block's own mode
  // is renamed so the two never get confused in this component.
  const { targets, totalWeeks, blockStart, mode: blockMode, loading } = useBlockConfig();
  /* The tune-ups inside THIS block (PRD-v2 §3), straight off the payload —
     the server counts `weeks_out` in the A race's own zone, so the marker
     sits on the same week the coach is told to taper into. Empty in view and
     generic mode, where there is no block for one to belong to. */
  const { activeRace } = useActiveRace();
  const bRaces = activeRace?.b_races ?? [];
  const [view, setView] = useState<"dist" | "elev">("dist");
  const [mode, setMode] = useState<"cum" | "wk">("cum");
  const [hoverWk, setHoverWk] = useState<number | null>(null); // 0-indexed
  const { ref: measureRef, width } = useMeasuredWidth();

  const data = useMemo(() => {
    const cumTarget: number[] = [];
    const cumActual: (number | null)[] = [];
    let t = 0, a = 0;
    for (let i = 0; i < targets.length; i++) {
      const wk = targets[i];
      t += view === "dist" ? wk.target_dist : wk.target_elev;
      cumTarget.push(t);
      if (i < currentWeek && weekly[i]) {
        const actWk = weekly[i];
        a += view === "dist" ? actWk.dist_mi : actWk.elev_ft;
        cumActual.push(a);
      } else {
        cumActual.push(null);
      }
    }
    return { cumTarget, cumActual };
  }, [view, weekly, currentWeek, targets]);

  /* ---- per-week attainment (weekly mode) ---- */
  const wkVals = useMemo(() => targets.map((t, i) => ({
    target: view === "dist" ? t.target_dist : t.target_elev,
    actual: i < currentWeek && weekly[i] ? (view === "dist" ? weekly[i].dist_mi : weekly[i].elev_ft) : null,
  })), [targets, weekly, currentWeek, view]);
  const completedWks = wkVals.slice(0, Math.max(0, currentWeek - 1)).filter((w) => w.actual != null && w.target > 0);
  const weeksHit = completedWks.filter((w) => w.actual! / w.target >= 0.9).length;
  const avgAttain = completedWks.length
    ? (completedWks.reduce((s, w) => s + w.actual! / w.target, 0) / completedWks.length) * 100 : 0;
  const thisWk = wkVals[currentWeek - 1] ?? { target: 0, actual: null };
  const thisWkPct = thisWk.target > 0 ? ((thisWk.actual ?? 0) / thisWk.target) * 100 : 0;
  const attainColor = (att: number | null) =>
    att == null ? "var(--mist-mute)" : att >= 0.9 ? "var(--pine)" : att >= 0.6 ? "var(--lamp)" : "var(--ember)";

  const totalTarget = data.cumTarget[data.cumTarget.length - 1];
  const expectedToday = data.cumTarget[currentWeek - 1] || 1;
  const actualToday = data.cumActual[currentWeek - 1] ?? 0;
  const deltaPct = ((actualToday - expectedToday) / expectedToday) * 100;
  const projectedFinal = actualToday > 0 ? (actualToday / expectedToday) * totalTarget : totalTarget;

  const fmt = (n: number) => (view === "dist" ? u.dist(n, 0) : u.elev(n));
  const unit = view === "dist" ? u.distUnit : `${u.elevUnit}↑`;
  const ahead = deltaPct >= 0;
  const lineColor = ahead ? "var(--pine)" : "var(--ember)";

  /* ---- pixel geometry: no viewBox stretching, so text stays crisp ---- */
  const H = 280;
  const PAD = { top: 26, right: 16, bottom: 26, left: 16 };
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = H - PAD.top - PAD.bottom;
  const weeklyMax = Math.max(...wkVals.map((w) => Math.max(w.target, w.actual ?? 0)), 1) * 1.08;
  const maxY = mode === "cum"
    ? Math.max(totalTarget, projectedFinal) * 1.05
    : weeklyMax;
  const xAt = (i: number) => PAD.left + (i / (totalWeeks - 1)) * plotW;
  const slotW = plotW / totalWeeks;
  const slotX = (i: number) => PAD.left + (i + 0.5) * slotW; // bar-slot center (weekly)
  const wx = (i: number) => (mode === "cum" ? xAt(i) : slotX(i));
  const yAt = (v: number) => PAD.top + (1 - v / maxY) * plotH;

  const targetPath = data.cumTarget.map((v, i) => `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`).join(" ");
  const actualPath = data.cumActual
    .map((v, i) => (v == null ? "" : `${i === 0 ? "M" : "L"} ${xAt(i).toFixed(1)} ${yAt(v).toFixed(1)}`))
    .join(" ").replace(/^L/, "M");

  const todayX = wx(currentWeek - 1);
  // The "WK NN · TODAY" caption sits to the right of the today line by
  // default, but "today" is very often the last (or near-last) week of the
  // block — that put the label's box entirely past the svg's own right edge
  // at every width tested, with `overflow: hidden` on the panel silently
  // dropping all of it (round 3, new finding 4). ~100px is the label's
  // rendered width at this fontSize/letterSpacing (measured: ~98px, "WK 12
  // · TODAY"); once it wouldn't fit to the right of the line, anchor it to
  // the LEFT of the line instead, still inside the plot.
  const TODAY_LABEL_W = 100;
  const todayLabelFitsRight = todayX + 6 + TODAY_LABEL_W <= width - 2;

  /* ---- hover: snap to nearest week ---- */
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const i = mode === "cum"
      ? Math.round(((x - PAD.left) / Math.max(1, plotW)) * (totalWeeks - 1))
      : Math.floor((x - PAD.left) / Math.max(1, slotW));
    setHoverWk(Math.max(0, Math.min(totalWeeks - 1, i)));
  };

  const hover = hoverWk != null ? {
    i: hoverWk,
    x: wx(hoverWk),
    plan: data.cumTarget[hoverWk],
    actual: data.cumActual[hoverWk],
    wkTarget: wkVals[hoverWk]?.target ?? 0,
    wkActual: wkVals[hoverWk]?.actual ?? null,
  } : null;
  const hoverDelta = hover && hover.actual != null && hover.plan > 0
    ? ((hover.actual - hover.plan) / hover.plan) * 100 : null;
  const hoverAttain = hover && hover.wkActual != null && hover.wkTarget > 0
    ? (hover.wkActual / hover.wkTarget) * 100 : null;
  const tipOnLeft = hover != null && width > 0 && hover.x > width * 0.62;

  const stats: { label: string; value: string; color?: string }[] = mode === "cum" ? [
    { label: "expected", value: `${fmt(expectedToday)} ${unit}` },
    { label: "actual", value: `${fmt(actualToday)} ${unit}`, color: lineColor },
    { label: "delta", value: `${ahead ? "+" : ""}${deltaPct.toFixed(1)}%`, color: lineColor },
    // Race mode projects forward to the finish line; the rolling window has
    // no future in it — its last column IS this week, so the same number is
    // a projection of where this week lands, not of a block finish.
    { label: blockMode === "race" ? `projected wk${totalWeeks}` : "projected this week",
      value: `${fmt(projectedFinal)} ${unit}`, color: lineColor },
    { label: "block goal", value: `${fmt(totalTarget)} ${unit}` },
  ] : [
    { label: `this week`, value: `${fmt(thisWk.actual ?? 0)} / ${fmt(thisWk.target)} ${unit}`, color: "var(--lamp)" },
    { label: "this week %", value: `${thisWkPct.toFixed(0)}%`, color: "var(--lamp)" },
    { label: "weeks ≥90%", value: `${weeksHit} / ${completedWks.length}`, color: attainColor(completedWks.length ? weeksHit / completedWks.length : null) },
    { label: "avg attainment", value: `${avgAttain.toFixed(0)}%`, color: attainColor(avgAttain / 100) },
    { label: "block goal", value: `${fmt(totalTarget)} ${unit}` },
  ];

  // Week axis labels: start with the 1/5/10/…/totalWeeks stride, then thin
  // by ACTUAL pixel extent rather than a fixed width breakpoint. Each label
  // is anchored differently (week 1 "start", the final week "end", every
  // multiple of 5 in between "middle"), so two labels a fixed CENTER
  // distance apart can still collide — e.g. week 10 of 12 (anchor middle)
  // sits right up against week 12 (anchor end, which extends back to the
  // LEFT from its x), only 2 of the axis's 11 slots apart, while the same
  // center gap between two middle-anchored labels has room to spare. Walk
  // left to right computing each candidate's true [left, right] extent from
  // its anchor and an approximate "WK NN" render width, dropping any
  // candidate (other than the pinned first/last) that would overlap the
  // last KEPT label, then re-check the final pair since the last week is
  // pinned to the true end of the block regardless of the every-5 stride
  // and can still collide with whatever the walk kept just before it.
  /* One marker per tune-up, placed by the week the server counted: the A
     race IS the last week of the block, so a race `weeks_out` weeks before
     it sits at index totalWeeks - 1 - weeks_out. A tune-up whose date the
     folder never had (weeks_out null), or one that lands outside the block
     entirely (a date after race day — negative weeks_out — or one from
     before the block started), gets NO marker rather than a clamped one on
     a week it is not in: a marker is a claim about a week.

     Only in race mode. Generic mode's rolling window ends on today rather
     than on a start line, and the payload sends no b_races there anyway. */
  const bMarkers = (blockMode === "race" ? bRaces : [])
    .map((b) => ({ b, idx: b.weeks_out == null ? -1 : totalWeeks - 1 - b.weeks_out }))
    .filter(({ idx }) => idx >= 0 && idx <= totalWeeks - 1)
    .map(({ b, idx }) => ({
      slug: b.slug,
      tag: tuneUpTag(b.name),
      x: wx(idx),
      // the native SVG tooltip: what it is, when it is, how far out
      tip: `${b.name}${b.date ? ` · ${b.date}` : ""} · ${b.weeks_out === 0 ? "race week" : `${b.weeks_out} wk out`}`
        // round 4 finding 9: this used to print a bare "mi" regardless of the
        // km/m toggle — every other distance on this chart (axis, stats row)
        // already goes through u.dist/u.distUnit.
        + (b.distance_mi != null ? ` · ${u.dist(b.distance_mi, 0)} ${u.distUnit}` : ""),
    }));

  const WEEK_LABEL_W = 34; // px — "WK NN" at fontSize 9 / letterSpacing 1
  const WEEK_LABEL_GAP = 3; // px — minimum clear space between labels
  const weekLabelExtent = (w: number): [number, number] => {
    const x = wx(w - 1);
    if (w === 1) return [x, x + WEEK_LABEL_W];
    if (w === totalWeeks) return [x - WEEK_LABEL_W, x];
    return [x - WEEK_LABEL_W / 2, x + WEEK_LABEL_W / 2];
  };
  const weekLabelWeeks = (() => {
    const candidates = [1, ...Array.from({ length: Math.floor((totalWeeks - 1) / 5) }, (_, i) => (i + 1) * 5), totalWeeks]
      .filter((w, i, arr) => arr.indexOf(w) === i);
    const kept: number[] = [];
    for (const w of candidates) {
      const prev = kept[kept.length - 1];
      if (prev != null && w !== totalWeeks) {
        const [, prevRight] = weekLabelExtent(prev);
        const [left] = weekLabelExtent(w);
        if (left < prevRight + WEEK_LABEL_GAP) continue;
      }
      kept.push(w);
    }
    if (kept.length >= 2) {
      const lastIdx = kept.length - 1;
      const last = kept[lastIdx];
      const beforeLast = kept[lastIdx - 1];
      const [, beforeLastRight] = weekLabelExtent(beforeLast);
      const [lastLeft] = weekLabelExtent(last);
      if (beforeLast !== 1 && lastLeft < beforeLastRight + WEEK_LABEL_GAP) kept.splice(lastIdx - 1, 1);
    }
    return kept;
  })();

  // No targets is a real state, not a zero one: a race folder with no
  // block.json yet, or the moment before /api/race/active answers. Dividing
  // cumulative actual by an expected of 0 would print "Infinity%".
  const hasTargets = targets.length > 0;

  return (
    <section>
      <SectionTag
        right={hasTargets ? (
          // SectionTag's own row is a non-wrapping flex (atoms.tsx) — at
          // 320/390 the title plus four un-shrinkable chip buttons in one
          // line ran the document 417px wide. flexWrap here lets the two
          // button groups drop to a second line (or scroll if they still
          // don't fit) instead of forcing the whole row wider than the
          // viewport; minWidth: 0 lets THIS box shrink inside SectionTag's
          // row rather than claiming its full unwrapped intrinsic width.
          <div
            style={{
              display: "flex", flexWrap: "wrap", gap: 8, rowGap: 4,
              justifyContent: "flex-end", minWidth: 0, maxWidth: "100%",
            }}
          >
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className={"chip" + (mode === "cum" ? " active" : "")} onClick={() => setMode("cum")}>cumulative</button>
              <button className={"chip" + (mode === "wk" ? " active" : "")} onClick={() => setMode("wk")}>weekly</button>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button className={"chip" + (view === "dist" ? " active" : "")} onClick={() => setView("dist")}>dist</button>
              <button className={"chip" + (view === "elev" ? " active" : "")} onClick={() => setView("elev")}>vert</button>
            </div>
          </div>
        ) : undefined}
      >
        {hasTargets
          ? (blockMode === "race"
            ? `trajectory — wk ${currentWeek} of ${totalWeeks}`
            : `trajectory — last ${totalWeeks} weeks`)
          : "trajectory"}
      </SectionTag>

      {/* ref lives on a wrapper mounted on EVERY render, whether or not
          targets have loaded — useMeasuredWidth's mount effect (data.ts)
          only ever runs once and bails for good if ref.current is null at
          that moment. Attaching the ref only inside the chart's own branch
          (as this used to) meant: on the very common timing where `targets`
          arrives a tick after first paint (useBlockConfig fetches over the
          network), the ref was null during that one-and-only effect run,
          no ResizeObserver was ever created, and the chart stayed
          permanently blank — width stuck at 0, no axis, no curve, nothing —
          even once real data showed up a moment later. */}
      <div ref={measureRef}>
        {!hasTargets ? (
          <div className="panel" style={{ padding: "26px 24px" }}>
            <div style={{ fontSize: 13, color: "var(--mist-dim)", lineHeight: 1.6 }}>
              {loading
                ? "Reading the training block…"
                : "No weekly targets yet — the coach writes them into the plan on the next resync."}
            </div>
          </div>
        ) : (
          <div className="panel notch" style={{ overflow: "hidden" }}>
            <Contours seed={13} opacity={0.08} />
            {/* inline stat row — the old right-rail, flattened into the panel */}
            <div style={{ position: "relative", display: "flex", flexWrap: "wrap", borderBottom: "1px solid var(--edge)" }}>
              {stats.map((s, i) => (
                <div key={s.label} style={{ padding: "12px 20px", borderLeft: i > 0 ? "1px solid var(--edge)" : "none", flex: "1 1 auto" }}>
                  <div className="eyebrow" style={{ fontSize: 8.5, whiteSpace: "normal", overflowWrap: "break-word" }}>{s.label}</div>
                  <div className="numerals" style={{ fontSize: 19, fontWeight: 600, letterSpacing: "-0.03em", marginTop: 3, color: s.color ?? "var(--mist)" }}>
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
    
            <div style={{ position: "relative", padding: "6px 4px 2px" }}>
              {width > 0 && (
                <svg
                  width={width} height={H} style={{ display: "block", cursor: "crosshair" }}
                  onMouseMove={onMove} onMouseLeave={() => setHoverWk(null)}
                >
                  {/* horizontal grid */}
                  {[0.25, 0.5, 0.75, 1].map((f) => (
                    <line key={f} x1={PAD.left} x2={width - PAD.right} y1={yAt(maxY * f / 1.05)} y2={yAt(maxY * f / 1.05)}
                      stroke="var(--edge)" strokeWidth="1" strokeDasharray="2 5" />
                  ))}
                  {/* week ticks */}
                  {Array.from({ length: totalWeeks }).map((_, i) => (
                    <line key={i} x1={xAt(i)} x2={xAt(i)} y1={H - PAD.bottom} y2={H - PAD.bottom + ((i + 1) % 5 === 0 || i === 0 ? 6 : 3)}
                      stroke="var(--edge-bright)" strokeWidth="1" />
                  ))}
                  {/* week axis labels — thinned by available width, see weekLabelWeeks above */}
                  {weekLabelWeeks.map((w) => (
                    <text key={w} x={wx(w - 1)} y={H - 6} fontSize="9" fontFamily="Spline Sans Mono" letterSpacing="1"
                      fill="var(--mist-mute)" textAnchor={w === 1 ? "start" : w === totalWeeks ? "end" : "middle"}>
                      WK {String(w).padStart(2, "0")}
                    </text>
                  ))}
    
                  {/* tune-up markers — one per B race in this block, at its
                      own week (PRD-v2 §3). Drawn under the plan/actual
                      lines so they never hide the data they sit behind. */}
                  {bMarkers.map((m) => (
                    <g key={`b-${m.slug}`} data-tune-up={m.slug}>
                      <title>{m.tip}</title>
                      <line
                        x1={m.x} x2={m.x} y1={PAD.top + 14} y2={H - PAD.bottom}
                        stroke="var(--creek)" strokeWidth="1" strokeDasharray="2 4" opacity="0.7"
                      />
                      <path
                        d={`M ${m.x} ${H - PAD.bottom - 4.5} L ${m.x + 4} ${H - PAD.bottom} L ${m.x} ${H - PAD.bottom + 4.5} L ${m.x - 4} ${H - PAD.bottom} Z`}
                        fill="var(--creek)"
                      />
                      <text
                        x={m.x} y={PAD.top + 10} textAnchor="middle"
                        fontSize="8" fontFamily="Spline Sans Mono" letterSpacing="1" fill="var(--creek)"
                      >
                        {m.tag}
                      </text>
                    </g>
                  ))}

                  {mode === "cum" ? (
                    <>
                      {/* plan target */}
                      <motion.path
                        d={targetPath} fill="none" stroke="var(--mist-mute)" strokeWidth="1.2" strokeDasharray="3 5" opacity="0.85"
                        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4, ease: "easeOut" }}
                      />
                      {/* actual */}
                      <motion.path
                        d={actualPath} fill="none" stroke={lineColor} strokeWidth="2.2" strokeLinecap="round"
                        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }}
                        transition={{ duration: 1.4, ease: [0.2, 0.7, 0.2, 1], delay: 0.2 }}
                      />
                      {/* projection */}
                      <motion.line
                        x1={todayX} y1={yAt(actualToday)} x2={xAt(totalWeeks - 1)} y2={yAt(projectedFinal)}
                        stroke={lineColor} strokeWidth="1" strokeDasharray="2 4"
                        initial={{ opacity: 0 }} animate={{ opacity: 0.7 }} transition={{ duration: 0.6, delay: 1.3 }}
                      />
                      <circle cx={todayX} cy={yAt(expectedToday)} r="2.5" fill="var(--mist-mute)" />
                      <circle cx={todayX} cy={yAt(actualToday)} r="3.5" fill={lineColor} stroke="var(--night)" strokeWidth="1" />
                      {/* race marker — the rolling window ends on today, not on
                          a start line, so there is nothing to mark there */}
                      {blockMode === "race" && (
                        <>
                          <circle cx={xAt(totalWeeks - 1)} cy={yAt(totalTarget)} r="3" fill="var(--lamp)" />
                          <text x={xAt(totalWeeks - 1) - 7} y={yAt(totalTarget) - 7} fontSize="10" fontFamily="Spline Sans Mono" letterSpacing="1.5" fill="var(--lamp)" textAnchor="end">
                            RACE
                          </text>
                        </>
                      )}
                    </>
                  ) : (
                    /* weekly bullet bars: outline = target, fill = actual (colored by attainment) */
                    wkVals.map((w, i) => {
                      const bw = Math.max(4, slotW * 0.56);
                      const x = slotX(i) - bw / 2;
                      const isCurrent = i === currentWeek - 1;
                      const att = w.actual != null && w.target > 0 ? w.actual / w.target : null;
                      const fill = isCurrent ? "var(--lamp)" : attainColor(att);
                      return (
                        <g key={i}>
                          <rect
                            x={x} y={yAt(w.target)} width={bw} height={Math.max(0, PAD.top + plotH - yAt(w.target))}
                            fill="none" stroke="var(--edge-bright)" strokeWidth="1" opacity={i < currentWeek ? 0.9 : 0.5}
                          />
                          {w.actual != null && w.actual > 0 && (
                            <motion.rect
                              x={x + 1.5} width={bw - 3}
                              y={yAt(w.actual)} height={Math.max(0, PAD.top + plotH - yAt(w.actual))}
                              fill={fill} opacity={isCurrent ? 0.75 : 0.88}
                              initial={{ opacity: 0 }} animate={{ opacity: isCurrent ? 0.75 : 0.88 }}
                              transition={{ duration: 0.4, delay: i * 0.02 }}
                            />
                          )}
                          {/* target cap so the goal reads even when the bar is full */}
                          <line x1={x - 1.5} x2={x + bw + 1.5} y1={yAt(w.target)} y2={yAt(w.target)}
                            stroke={i < currentWeek ? "var(--mist-dim)" : "var(--edge-bright)"} strokeWidth="1.5" />
                        </g>
                      );
                    })
                  )}
    
                  {/* today */}
                  <motion.line
                    x1={todayX} x2={todayX} y1={PAD.top - 12} y2={H - PAD.bottom} stroke="var(--lamp)" strokeWidth="1"
                    initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6, delay: 1 }}
                    opacity={mode === "cum" ? 1 : 0.45}
                  />
                  <text
                    x={todayLabelFitsRight ? todayX + 6 : todayX - 6}
                    y={PAD.top - 8}
                    textAnchor={todayLabelFitsRight ? "start" : "end"}
                    fontSize="10" fontFamily="Spline Sans Mono" letterSpacing="1.5" fill="var(--lamp)"
                  >
                    WK {currentWeek} · TODAY
                  </text>
    
                  {/* hover crosshair */}
                  {hover && (
                    <g>
                      <line x1={hover.x} x2={hover.x} y1={PAD.top - 4} y2={H - PAD.bottom} stroke="var(--mist-dim)" strokeWidth="1" opacity="0.5" />
                      {mode === "cum" && (
                        <>
                          <circle cx={hover.x} cy={yAt(hover.plan)} r="3" fill="var(--night)" stroke="var(--mist-dim)" strokeWidth="1.2" />
                          {hover.actual != null && (
                            <circle cx={hover.x} cy={yAt(hover.actual)} r="3.5" fill={lineColor} stroke="var(--night)" strokeWidth="1" />
                          )}
                        </>
                      )}
                    </g>
                  )}
                </svg>
              )}
    
              {/* hover tooltip — HTML so it never distorts */}
              {hover && width > 0 && (
                <div style={{
                  position: "absolute",
                  top: 30,
                  left: tipOnLeft ? undefined : Math.min(hover.x + 14, width - 230),
                  right: tipOnLeft ? width - hover.x + 14 : undefined,
                  width: 216,
                  background: "var(--night-deep)",
                  border: "1px solid var(--edge-bright)",
                  borderTop: "2px solid var(--lamp)",
                  padding: "10px 12px",
                  pointerEvents: "none",
                  zIndex: 5,
                  boxShadow: "0 8px 28px rgba(0,0,0,0.55)",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span className="eyebrow" style={{ fontSize: 8.5, color: "var(--lamp)" }}>
                      week {String(hover.i + 1).padStart(2, "0")}{hover.i + 1 === currentWeek ? " · now" : blockMode === "race" && hover.i + 1 === totalWeeks ? " · race" : ""}
                    </span>
                    <span className="numerals" style={{ fontSize: 9, color: "var(--mist-mute)" }}>{weekDates(hover.i + 1, blockStart)}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", marginTop: 8 }}>
                    <span className="eyebrow" style={{ fontSize: 8 }}>plan · cum</span>
                    <span className="numerals" style={{ fontSize: 12, textAlign: "right" }}>{fmt(hover.plan)} {unit}</span>
                    <span className="eyebrow" style={{ fontSize: 8 }}>actual · cum</span>
                    <span className="numerals" style={{ fontSize: 12, textAlign: "right", color: hover.actual != null ? lineColor : "var(--mist-mute)" }}>
                      {hover.actual != null ? `${fmt(hover.actual)} ${unit}` : "—"}
                    </span>
                    {hoverDelta != null && (
                      <>
                        <span className="eyebrow" style={{ fontSize: 8 }}>delta</span>
                        <span className="numerals" style={{ fontSize: 12, textAlign: "right", color: hoverDelta >= 0 ? "var(--pine)" : "var(--ember)" }}>
                          {hoverDelta >= 0 ? "+" : ""}{hoverDelta.toFixed(1)}%
                        </span>
                      </>
                    )}
                  </div>
                  <div style={{ borderTop: "1px solid var(--edge)", marginTop: 8, paddingTop: 7, display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px" }}>
                    <span className="eyebrow" style={{ fontSize: 8 }}>wk target</span>
                    <span className="numerals" style={{ fontSize: 11, textAlign: "right", color: "var(--mist-dim)" }}>{fmt(hover.wkTarget)} {unit}</span>
                    <span className="eyebrow" style={{ fontSize: 8 }}>wk actual</span>
                    <span className="numerals" style={{ fontSize: 11, textAlign: "right", color: "var(--mist-dim)" }}>
                      {hover.wkActual != null ? `${fmt(hover.wkActual)} ${unit}` : "—"}
                    </span>
                    {hoverAttain != null && (
                      <>
                        <span className="eyebrow" style={{ fontSize: 8 }}>wk attained</span>
                        <span className="numerals" style={{ fontSize: 11, textAlign: "right", color: hover.i + 1 === currentWeek ? "var(--lamp)" : attainColor(hoverAttain / 100) }}>
                          {hoverAttain.toFixed(0)}%{hover.i + 1 === currentWeek ? " so far" : ""}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Road ahead — next 14 days (calendar) ∪ next 6 weeks (plan)         */
/* ------------------------------------------------------------------ */

const CLASSIFICATION_META: Record<GCalEvent["classification"], { color: string; tag: string }> = {
  race:        { color: "var(--ember)", tag: "RACE" },
  travel:      { color: "var(--lamp)", tag: "TRVL" },
  appointment: { color: "var(--creek)", tag: "APPT" },
  training:    { color: "var(--pine)", tag: "TRN" },
  family:      { color: "var(--creek)", tag: "FAM" },
  childcare:   { color: "var(--ember)", tag: "KIDS" },
  work:        { color: "var(--mist-mute)", tag: "WORK" },
  other:       { color: "var(--mist-mute)", tag: "···" },
};

function RoadAhead() {
  const u = useUnits();
  const { currentWeek } = useStrava();
  const { data: cal, connected: calOk, missing: calMissing } = useGoogleCal();
  const { data: state } = usePersistentState();

  /* ---- 14-day calendar strip ---- */
  const days = useMemo(() => {
    const now = new Date();
    const localIso = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const out: { date: string; label: string; events: GCalEvent[] }[] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now.getTime() + i * 86400_000);
      out.push({
        date: localIso(d),
        label: d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" }),
        events: [],
      });
    }
    if (cal) {
      for (const e of cal.events) {
        if (!e.start) continue;
        if (!e.all_day) {
          const startMs = new Date(e.start).getTime();
          if (startMs < now.getTime() - 60 * 60_000) continue;
          const slot = out.find((d) => d.date === e.start!.slice(0, 10));
          if (slot) slot.events.push(e);
          continue;
        }
        // All-day `end` is exclusive per the Google API (a Jul 31 – Aug 2 span
        // ends "Aug 3"), and the span may already be underway — show it on
        // every covered day in the strip, not just its start date.
        const startDay = e.start.slice(0, 10);
        const endDay = (e.end || e.start).slice(0, 10);
        for (const slot of out) {
          if (slot.date === startDay || (slot.date > startDay && slot.date < endDay)) slot.events.push(e);
        }
      }
    }
    return out;
  }, [cal]);

  /* ---- plan blocks (the agent's plan, else block targets) ---- */
  // The plan lives in races/<slug>/plan.json, or config/generic-plan.json in
  // generic mode, and reaches us through /api/race/active — state.json has
  // not carried plan_blocks since v3 (tt-yib.2).
  const { targets, totalWeeks, blockStart, planBlocks, mode, loading } = useBlockConfig();
  const fallback: PlanBlock[] = useMemo(() => {
    const start = Math.min(totalWeeks, currentWeek);
    const end = Math.min(totalWeeks, currentWeek + 5);
    return targets.slice(start - 1, end).map((b) => ({
      wk: b.wk,
      // With a race, the last week of the block IS race week. The rolling
      // window has no such landmark, so its weeks are named by their dates.
      label: mode === "race"
        ? (b.wk === totalWeeks ? "Race week" : "Planned")
        : `Week of ${weekStartLabel(b.wk, blockStart)}`,
      dist_mi: b.target_dist,
      elev_ft: b.target_elev,
      focus: "Awaiting agent recommendations — resync to generate.",
    }));
  }, [currentWeek, targets, totalWeeks, mode, blockStart]);
  const stateBlocks = planBlocks.length > 0 ? planBlocks : null;
  const blocks: PlanBlock[] = useMemo(() => {
    if (!stateBlocks || stateBlocks.length === 0) return fallback;
    // The strip includes the CURRENT week. Older coach runs planned from
    // current_week+1 — synthesize this week from block targets until the
    // next coach run backfills it.
    if (!stateBlocks.some((b) => b.wk === currentWeek) && targets[currentWeek - 1]) {
      const t = targets[currentWeek - 1];
      return [
        {
          wk: t.wk,
          label: "This week",
          dist_mi: t.target_dist,
          elev_ft: t.target_elev,
          focus: "Block target — coach hasn't planned this week yet; resync to fill in.",
        },
        ...stateBlocks,
      ];
    }
    return stateBlocks;
  }, [stateBlocks, fallback, currentWeek, targets]);
  const live = !!(stateBlocks && stateBlocks.length > 0);
  // "Awaiting agent recommendations" is only honest once we KNOW the plan is
  // empty — before the payload lands we know nothing yet.
  const awaiting = !live && !loading;
  const maxDist = Math.max(...blocks.map((b) => b.dist_mi), 1);

  return (
    <section>
      <SectionTag
        right={
          <span className="eyebrow">
            {calOk
              ? `${cal!.summary.upcoming_events} events · ${cal!.summary.races_upcoming} race${cal!.summary.races_upcoming === 1 ? "" : "s"} · ${cal!.summary.travel_days_upcoming.length} travel days · ${cal!.summary.childcare_days_upcoming?.length ?? 0} kid days`
              : calMissing ? "calendar not connected" : "loading calendar…"}
            {calOk && isStale(cal!.fetched_at, 26) && (
              <span style={{ color: "var(--ember)" }} title="the calendar sync step has been failing — likely an expired Google token; run `node scripts/sync-google-cal.mjs --auth` to reconnect">
                {" "}· snapshot from {relativeAgo(new Date(cal!.fetched_at).getTime())} — reauth google
              </span>
            )}
            {" — plan "}
            <span style={{ color: live ? "var(--pine)" : "var(--mist-mute)" }}>
              {live
                ? `agent · ${state?.last_updated ? new Date(state.last_updated).toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toLowerCase() : ""}`
                // `awaiting` means the payload has actually resolved with no
                // plan — at that point "loading…" would be a lie forever, not
                // a moment. block.json targets with no plan.json yet reads
                // "targets only"; neither file existing yet (an active race
                // activated before its first plan turn — round 3, resilience
                // finding 3) gets the same honest empty state TRAJECTORY uses
                // rather than spinning with nothing left to wait for.
                : !awaiting ? "loading…"
                : targets.length > 0 ? "targets only"
                : "no plan yet — resync to generate"}
            </span>
          </span>
        }
      >
        the road ahead — {days.length} days · {blocks.length} week{blocks.length === 1 ? "" : "s"}
      </SectionTag>

      {/* calendar strip */}
      {calOk ? (
        <div className="horizon-days" style={{ marginBottom: 1 }}>
          {days.map((d, i) => {
            const isToday = i === 0;
            const isWeekend = ["Sat", "Sun"].includes(d.label.split(" ")[0]);
            return (
              <motion.div
                key={d.date}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: i * 0.015 }}
                style={{ padding: "9px 10px", minHeight: 74, position: "relative", overflow: "hidden" }}
              >
                {isToday && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "var(--lamp)" }} />}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="eyebrow" style={{ fontSize: 8.5, color: isToday ? "var(--lamp)" : isWeekend ? "var(--mist-dim)" : "var(--mist-mute)" }}>
                    {isToday ? "today" : d.label.toLowerCase()}
                  </span>
                  {d.events.length > 2 && (
                    <span className="eyebrow numerals" style={{ fontSize: 8 }}>+{d.events.length - 2}</span>
                  )}
                </div>
                <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                  {d.events.length === 0 ? (
                    <span style={{ fontSize: 10, color: "var(--edge-bright)", fontFamily: "var(--font-mono)" }}>—</span>
                  ) : (
                    d.events.slice(0, 2).map((e) => {
                      const meta = CLASSIFICATION_META[e.classification] || CLASSIFICATION_META.other;
                      const time = e.all_day ? "" : e.start ? new Date(e.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase().replace(" ", "") : "";
                      const inner = (
                        <span style={{ display: "block", fontSize: 10.5, lineHeight: 1.3, borderLeft: `2px solid ${meta.color}`, paddingLeft: 5, color: "var(--mist-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {time && <span className="numerals" style={{ color: "var(--mist-mute)", marginRight: 4, fontSize: 9 }}>{time}</span>}
                          {e.summary}
                        </span>
                      );
                      return e.html_link
                        ? <a key={e.id} href={e.html_link} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }} title={e.summary}>{inner}</a>
                        : <span key={e.id} title={e.summary}>{inner}</span>;
                    })
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>
      ) : calMissing ? (
        <ConnectStrip kind="google" />
      ) : null}

      {/* plan weeks — rows, not cards */}
      <div className="panel" style={{ marginTop: calOk ? 0 : 8, borderTop: calOk ? "none" : undefined }}>
        {blocks.map((w, i) => {
          const offset = w.wk - currentWeek;
          const isNow = offset === 0;
          const isNext = offset === 1;
          const isRace = mode === "race" && w.wk === totalWeeks;
          return (
            <motion.div
              key={w.wk}
              initial={{ opacity: 0, x: -8 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }}
              transition={{ duration: 0.35, delay: i * 0.05 }}
              style={{
                display: "grid",
                gridTemplateColumns: "70px minmax(0,1.2fr) minmax(0,1fr) 120px",
                gap: 16,
                alignItems: "center",
                padding: "13px 18px",
                borderTop: i > 0 ? "1px solid var(--edge)" : "none",
                background: isNow ? "var(--lamp-glow)" : isRace ? "rgba(240, 102, 77, 0.06)" : "transparent",
              }}
            >
              <div>
                <div className="eyebrow" style={{ fontSize: 8, color: isNow || isNext ? "var(--lamp)" : isRace ? "var(--ember)" : "var(--mist-mute)" }}>
                  {isNow ? "now" : isNext ? "next" : isRace ? "race" : `+${offset} wk`}
                </div>
                <div className="numerals" style={{ fontSize: 19, fontWeight: 600, marginTop: 1 }}>w{String(w.wk).padStart(2, "0")}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="display" style={{ fontSize: 15, fontWeight: 600 }}>
                  {w.label}
                  {w.quality != null && <span className="numerals" style={{ fontSize: 10, color: "var(--mist-mute)", marginLeft: 8 }}>Q{w.quality}</span>}
                </div>
                <div style={{ fontSize: 12, color: "var(--mist-dim)", marginTop: 3, lineHeight: 1.45 }}>{w.focus}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                {w.key_session ? (
                  <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--mist-dim)", lineHeight: 1.45, borderLeft: "2px solid var(--lamp)", paddingLeft: 8 }}>
                    <span className="eyebrow" style={{ fontSize: 7.5, color: "var(--lamp)", display: "block" }}>key session</span>
                    {w.key_session}
                  </div>
                ) : (
                  <span style={{ fontSize: 11, color: "var(--edge-bright)", fontFamily: "var(--font-mono)" }}>—</span>
                )}
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="numerals" style={{ fontSize: 14, fontWeight: 600 }}>{u.dist(w.dist_mi, 0)}<span style={{ fontSize: 9, color: "var(--mist-mute)" }}> {u.distUnit}</span></span>
                  <span className="numerals" style={{ fontSize: 11, color: "var(--mist-dim)" }}>{u.elev(w.elev_ft)}<span style={{ fontSize: 9, color: "var(--mist-mute)" }}> {u.elevUnit}↑</span></span>
                </div>
                <div style={{ height: 3, background: "var(--night-deep)", marginTop: 6 }}>
                  <motion.div
                    initial={{ width: 0 }} whileInView={{ width: `${(w.dist_mi / maxDist) * 100}%` }} viewport={{ once: true }}
                    transition={{ duration: 0.7, delay: 0.2 + i * 0.05 }}
                    style={{ height: "100%", background: isRace ? "var(--ember)" : "var(--lamp)" }}
                  />
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Log — compact field table                                          */
/* ------------------------------------------------------------------ */

const TYPE_META: Record<Activity["type"], { label: string; color: string }> = {
  run:     { label: "RUN", color: "var(--mist-dim)" },
  long:    { label: "LNG", color: "var(--lamp)" },
  vert:    { label: "VRT", color: "var(--pine)" },
  easy:    { label: "EZ",  color: "var(--mist-mute)" },
  workout: { label: "WRK", color: "var(--ember)" },
};

// Compact badge for the raw Strava sport of a non-run activity.
const SPORT_ABBREV: Record<string, string> = {
  Ride: "RIDE", VirtualRide: "VRIDE", GravelRide: "GRVL", MountainBikeRide: "MTB", EBikeRide: "EBIKE",
  VirtualRun: "VRUN", Hike: "HIKE", Walk: "WALK", WeightTraining: "WTS", Workout: "GYM", Yoga: "YOGA",
  Swim: "SWIM", Rowing: "ROW", RockClimbing: "CLMB",
  AlpineSki: "SKI", BackcountrySki: "BC SKI", NordicSki: "XC SKI", Snowboard: "BOARD", Snowshoe: "SHOE",
};
const sportLabel = (sport?: string) => (sport && SPORT_ABBREV[sport]) ?? (sport ?? "").slice(0, 5).toUpperCase();

/** The one run that IS the race being viewed — identified by result.json's
    linked activity, not by any classifier. */
const RACE_META = { label: "RACE", color: "var(--lamp)" };

const durFmt = (s: number) => {
  // round to whole minutes FIRST — rounding the remainder yields "1:60h"
  const mins = Math.round(s / 60);
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}:${m.toString().padStart(2, "0")}h` : `${m}m`;
};

// shared motion/hover shell for log rows — keeps run and cross rows in step
const logRowShell = (i: number) => ({
  initial: { opacity: 0 }, animate: { opacity: 1 },
  transition: { duration: 0.3, delay: Math.min(i * 0.025, 0.4) },
  style: { padding: "11px 18px", borderTop: i > 0 ? "1px solid var(--edge)" : "none" },
  onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => ((e.currentTarget as HTMLDivElement).style.background = "var(--panel-raise)"),
  onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => ((e.currentTarget as HTMLDivElement).style.background = "transparent"),
});

function LogTable() {
  const [limit, setLimit] = useState(12);
  // "other" lists non-run activities (cross-train.json) — coach context only,
  // never part of vitals/trajectory/pacing, which stay runs-only
  const [tab, setTab] = useState<"runs" | "other">("runs");
  const { activities, cross, crossError, crossSynced, crossLoading, loading, error } = useStrava();
  const { syncing } = useRefresh();
  // the archived race on screen labels its own run in the log
  const { viewing } = useBlockConfig();
  const { result: raceResult } = useRaceResult(viewing?.status === "archived" ? viewing.slug : null);
  const raceActivityId = raceResult?.strava_activity_id ?? null;
  const u = useUnits();
  const runsTab = tab === "runs";
  const visible = activities.slice(0, limit);
  const visibleCross = cross.slice(0, limit);
  const shownCount = runsTab ? activities.length : cross.length;
  const switchTab = (t: typeof tab) => { if (t !== tab) { setTab(t); setLimit(12); } };
  const gridClass = "log-grid" + (runsTab ? "" : " cross");

  return (
    <section>
      <SectionTag right={
        <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
          <button className={"chip" + (tab === "runs" ? " active" : "")} onClick={() => switchTab("runs")}>runs</button>
          <button className={"chip" + (tab === "other" ? " active" : "")} onClick={() => switchTab("other")}>other · {cross.length}</button>
          <span className="eyebrow">{syncing ? "pulling strava…" : `${shownCount} activities`}</span>
        </div>
      }>
        the log
      </SectionTag>
      <div className="panel">
        <div className={gridClass} style={{ padding: "10px 18px", borderBottom: "1px solid var(--edge-bright)" }}>
          <span className="eyebrow" style={{ fontSize: 8.5 }}>date</span>
          <span className="eyebrow" style={{ fontSize: 8.5 }}>activity</span>
          <span className="eyebrow col-type" style={{ fontSize: 8.5 }}>{runsTab ? "type" : "sport"}</span>
          <span className="eyebrow col-dist" style={{ fontSize: 8.5, textAlign: "right" }}>{u.distUnit}</span>
          <span className="eyebrow col-elev" style={{ fontSize: 8.5, textAlign: "right" }}>{u.elevUnit}↑</span>
          <span className="eyebrow col-pace" style={{ fontSize: 8.5, textAlign: "right" }}>{runsTab ? `pace${u.paceUnit}` : "time"}</span>
          <span className="eyebrow col-rpe" style={{ fontSize: 8.5 }}>{runsTab ? "rpe" : "hr"}</span>
        </div>

        {runsTab && loading && activities.length === 0 && (
          <div style={{ padding: "28px 0", textAlign: "center" }}><span className="eyebrow">loading strava snapshot…</span></div>
        )}
        {!runsTab && crossLoading && (
          <div style={{ padding: "28px 0", textAlign: "center" }}><span className="eyebrow">loading cross-train snapshot…</span></div>
        )}
        {runsTab && error && (
          <div style={{ padding: "28px 0", textAlign: "center" }}>
            <span className="eyebrow" style={{ color: "var(--ember)" }}>couldn't load strava.json — run `node scripts/sync-strava.mjs`</span>
          </div>
        )}
        {!runsTab && !crossLoading && crossError && (
          <div style={{ padding: "28px 0", textAlign: "center" }}>
            <span className="eyebrow" style={{ color: "var(--ember)" }}>couldn't load cross-train.json — {crossError}</span>
          </div>
        )}
        {!runsTab && !crossLoading && !crossError && cross.length === 0 && (
          <div style={{ padding: "28px 0", textAlign: "center" }}>
            <span className="eyebrow">
              {crossSynced
                ? "no non-run activities in this window"
                : "no cross-train snapshot yet — resync strava to pull it"}
            </span>
          </div>
        )}

        {!runsTab && !crossLoading && visibleCross.map((a, i) => (
          <motion.div key={a.id} className="log-grid cross" {...logRowShell(i)}>
            <span className="numerals" style={{ fontSize: 11.5, color: "var(--mist-mute)" }}>
              {new Date(a.date).toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toLowerCase()}
            </span>
            <div style={{ minWidth: 0 }}>
              {a.strava_url ? (
                <a href={a.strava_url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 13.5, fontWeight: 500, color: "var(--mist)", textDecoration: "none", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {a.title} <span style={{ color: "var(--mist-mute)", fontSize: 10 }}>↗</span>
                </a>
              ) : (
                <span style={{ fontSize: 13.5, fontWeight: 500 }}>{a.title}</span>
              )}
              {a.start_time_local && (
                <span className="numerals" style={{ fontSize: 9.5, color: "var(--mist-mute)", display: "block", marginTop: 2 }}>{a.start_time_local}</span>
              )}
            </div>
            <span className="col-type">
              <span className="eyebrow" style={{ fontSize: 8.5, color: "var(--mist-dim)", border: "1px solid var(--mist-dim)", padding: "2px 5px" }}>
                {sportLabel(a.sport)}
              </span>
            </span>
            <span className="numerals col-dist" style={{ fontSize: 14, fontWeight: 600, textAlign: "right" }}>{a.distance_mi >= 0.05 ? u.dist(a.distance_mi) : "—"}</span>
            <span className="numerals col-elev" style={{ fontSize: 14, fontWeight: 600, textAlign: "right", color: "var(--mist-dim)" }}>{a.elevation_ft >= 1 ? u.elev(a.elevation_ft) : "—"}</span>
            <span className="numerals col-pace" style={{ fontSize: 11.5, color: "var(--mist-mute)", textAlign: "right" }}>{durFmt(a.moving_s)}</span>
            <span className="numerals col-rpe" style={{ fontSize: 11.5, color: "var(--mist-mute)" }}>{a.avg_hr != null ? Math.round(a.avg_hr) : "—"}</span>
          </motion.div>
        ))}

        {runsTab && visible.map((a, i) => (
          <motion.div key={a.id} className="log-grid" {...logRowShell(i)}>
            <span className="numerals" style={{ fontSize: 11.5, color: "var(--mist-mute)" }}>
              {new Date(a.date).toLocaleDateString("en-US", { month: "short", day: "2-digit" }).toLowerCase()}
            </span>
            <div style={{ minWidth: 0 }}>
              {a.strava_url ? (
                <a href={a.strava_url} target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 13.5, fontWeight: 500, color: "var(--mist)", textDecoration: "none", display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {a.title} <span style={{ color: "var(--mist-mute)", fontSize: 10 }}>↗</span>
                </a>
              ) : (
                <span style={{ fontSize: 13.5, fontWeight: 500 }}>{a.title}</span>
              )}
              <span className="numerals" style={{ fontSize: 9.5, color: "var(--mist-mute)", display: "flex", gap: 8, marginTop: 2 }}>
                {a.start_time_local && <span>{a.start_time_local}</span>}
                {a.temp_avg_f != null && (
                  <span
                    title={[
                      `avg ${u.temp(a.temp_avg_f)}${u.tempUnit}`,
                      a.temp_max_f != null ? `max ${u.temp(a.temp_max_f)}${u.tempUnit}` : null,
                      a.apparent_avg_f != null ? `feels ${u.temp(a.apparent_avg_f)}${u.tempUnit}` : null,
                      a.humidity_avg != null ? `${a.humidity_avg}% rh` : null,
                    ].filter(Boolean).join(" · ")}
                    style={{ color: (a.apparent_avg_f ?? a.temp_avg_f) >= 75 ? "var(--ember)" : (a.apparent_avg_f ?? a.temp_avg_f) <= 40 ? "var(--creek)" : "var(--mist-mute)" }}
                  >
                    {u.temp(a.temp_avg_f)}{u.tempUnit}
                    {a.apparent_avg_f != null && Math.abs(a.apparent_avg_f - a.temp_avg_f) >= 2 && ` · feels ${u.temp(a.apparent_avg_f)}${u.tempUnit}`}
                  </span>
                )}
              </span>
            </div>
            <span className="col-type">
              {(() => {
                const meta = a.id === raceActivityId ? RACE_META : TYPE_META[a.type];
                return (
                  <span className="eyebrow" style={{ fontSize: 8.5, color: meta.color, border: `1px solid ${meta.color}`, padding: "2px 5px" }}>
                    {meta.label}
                  </span>
                );
              })()}
            </span>
            <span className="numerals col-dist" style={{ fontSize: 14, fontWeight: 600, textAlign: "right" }}>{u.dist(a.distance_mi)}</span>
            <span className="numerals col-elev" style={{ fontSize: 14, fontWeight: 600, textAlign: "right", color: "var(--mist-dim)" }}>{u.elev(a.elevation_ft)}</span>
            <span className="numerals col-pace" style={{ fontSize: 11.5, color: "var(--mist-mute)", textAlign: "right" }}>{u.paceFmt(a.moving_s, a.distance_mi)}</span>
            <span className="col-rpe" style={{ display: "inline-flex", gap: 3 }}>
              {Array.from({ length: 5 }).map((_, j) => (
                <span key={j} style={{ width: 6, height: 6, transform: "rotate(45deg)", background: j < a.rpe ? "var(--lamp)" : "transparent", border: "1px solid var(--edge-bright)" }} />
              ))}
            </span>
          </motion.div>
        ))}

        {shownCount > limit && (
          <div style={{ textAlign: "center", padding: 12, borderTop: "1px solid var(--edge)" }}>
            <button className="chip" onClick={() => setLimit((l) => l + 20)}>
              show {Math.min(20, shownCount - limit)} more · {shownCount - limit} hidden
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Agent rail — readout + flags + chat, always at your side           */
/* ------------------------------------------------------------------ */

function useFacts(): CoachFacts {
  const { activities, weekly, currentWeek } = useStrava();
  const { days: ouraDays } = useOura();
  const { targets } = useBlockConfig();
  return useMemo(
    () => computeCoachFacts(activities, ouraDays, weekly, currentWeek, targets),
    [activities, ouraDays, weekly, currentWeek, targets],
  );
}

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  meta?: {
    num_turns?: number; cost_usd?: number | null; duration_ms?: number | null; error?: boolean;
    saved_context?: { text: string; expires: string }[];
    saved_sections?: { section: string; text: string }[];
    context_save_error?: string | null;
  };
  pending?: boolean;
};

const SUGGESTED_PROMPTS = [
  "what should I do this weekend?",
  "why is my HRV up?",
  "swap a session this week",
  "race-day fueling strategy",
];

/* chat survives page refreshes — capped so localStorage stays small */
const CHAT_STORAGE_KEY = "coach-chat";
const CHAT_STORAGE_CAP = 50;

function loadStoredChat(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function AgentRail({ onCollapse }: { onCollapse?: () => void }) {
  const { data: agent, missing: agentMissing } = useAgentReadout();
  const { system } = useUnits();
  const facts = useFacts();
  // What the athlete has on screen, for the race_state each chat turn carries
  // (PRD-v2 §6). Free here: useActiveRace shares one in-flight request per
  // refresh key, and the rail is already mounted beside the views that use it.
  const { mode: raceMode, viewing: onScreenSlug, activeRace } = useActiveRace();
  const [readoutOpen, setReadoutOpen] = useState(true);

  /* chat state */
  const [messages, setMessages] = useState<ChatMessage[]>(loadStoredChat);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pending]);

  // persist the thread (drop the transient pending bubble, cap the length)
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages.slice(-CHAT_STORAGE_CAP)));
    } catch { /* private mode — chat just won't persist */ }
  }, [messages]);

  // collapse the readout once a conversation starts, to give chat room
  useEffect(() => {
    if (messages.length > 0) setReadoutOpen(false);
  }, [messages.length]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || pending) return;

    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", content: trimmed };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInput("");
    setPending(true);
    setStatusLine("thinking…");

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t0 = Date.now();

    try {
      /* The planner's own numbers for the race on screen — projection, knobs,
         fuel, review status, last stated position. Null in generic mode, and
         then the key is omitted entirely rather than sent as null: the server
         renders no block at all for a turn with no race (PRD-v2 §6). Never
         allowed to fail the turn — buildRaceState swallows its own fetch
         error and returns what it has. */
      const raceState = await buildRaceState(
        { mode: raceMode, slug: onScreenSlug, name: activeRace?.race?.name },
        ctrl.signal,
      ).catch(() => null);
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          messages: newHistory.map((m) => ({ role: m.role, content: m.content })),
          // the coach answers in the dashboard's selected unit system
          units: system,
          ...(raceState ? { race_state: raceState } : {}),
        }),
      });
      if (!res.body) throw new Error("no body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      // A `notice` means the server is still working but something changed —
      // today only the max-turns retry. It rides along in the status line
      // instead of arriving as a message, so the retry isn't a silent stall.
      let noticeLine = "";
      const handleEvent = (event: string, payload: { content?: string; meta?: ChatMessage["meta"]; message?: string }) => {
        if (event === "heartbeat") {
          const sec = Math.floor((Date.now() - t0) / 1000);
          setStatusLine(`${noticeLine || "thinking…"} ${sec}s`);
        } else if (event === "notice") {
          noticeLine = payload.message ?? "";
          setStatusLine(`${noticeLine} ${Math.floor((Date.now() - t0) / 1000)}s`);
        } else if (event === "message") {
          setMessages((prev) => [...prev, { id: `a-${Date.now()}`, role: "assistant", content: payload.content ?? "", meta: payload.meta }]);
        } else if (event === "error") {
          setMessages((prev) => [...prev, { id: `e-${Date.now()}`, role: "assistant", content: payload.message ?? "unknown error", meta: { error: true } }]);
        } else if (event === "done") {
          setStatusLine("");
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message", dataStr = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
          }
          if (!dataStr) continue;
          try { handleEvent(event, JSON.parse(dataStr)); } catch { /* skip malformed SSE block */ }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setMessages((prev) => [...prev, { id: `e-${Date.now()}`, role: "assistant", content: `network error: ${(e as Error).message}`, meta: { error: true } }]);
      }
    } finally {
      setPending(false);
      setStatusLine("");
      abortRef.current = null;
    }
  }, [messages, pending, system, raceMode, onScreenSlug, activeRace]);

  const cancel = () => {
    abortRef.current?.abort();
    setPending(false);
    setStatusLine("");
  };

  const clearChat = () => {
    setMessages([]);
    try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch { /* nothing stored */ }
  };

  // a readout older than a day means the coach step failed (or was skipped)
  // on recent resyncs — surface it instead of silently showing old advice
  const readoutStale = !!agent && isStale(agent.generated_at);

  return (
    <aside className="rail-sticky">
      <div className="panel notch" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
        {/* status header */}
        <div style={{ padding: "13px 18px", borderBottom: "1px solid var(--edge)", display: "flex", alignItems: "center", gap: 10 }}>
          <span className={agent ? undefined : "pulse"} style={{ width: 7, height: 7, borderRadius: "50%", background: agent ? (readoutStale ? "var(--ember)" : "var(--pine)") : "var(--lamp)", flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="eyebrow" style={{ color: "var(--mist-dim)" }}>the coach</div>
            <div className="numerals" style={{ fontSize: 10, color: readoutStale ? "var(--ember)" : "var(--mist-mute)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {agent
                ? `${agent.model} · ${relativeAgo(new Date(agent.generated_at).getTime())}${readoutStale ? " · stale — resync" : ""}`
                : agentMissing ? "no readout — resync to generate" : "loading…"}
            </div>
          </div>
          {pending
            ? <span className="eyebrow numerals" style={{ color: "var(--lamp)" }}>{statusLine}</span>
            : messages.length > 0 && (
                <button className="chip" onClick={clearChat} title="clear chat history" style={{ fontSize: 9 }}>
                  clear
                </button>
              )}
          {onCollapse && (
            <button
              className="chip" onClick={onCollapse}
              title="collapse the coach rail (reopen with the coach chip in the top bar)"
              style={{ fontSize: 9, padding: "3px 7px" }}
            >
              »
            </button>
          )}
        </div>

        {/* scrollable body: flags + readout + chat thread */}
        <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
          <ViewingNotice />
          <FlagsRow flags={facts.flags} />
          <ReadoutBlock agent={agent} missing={agentMissing} open={readoutOpen} setOpen={setReadoutOpen} facts={facts} />

          {/* chat thread */}
          <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
            {messages.length === 0 && (
              <p style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--mist-mute)" }}>
                Ask anything — load, recovery, this weekend's plan, fueling.
                The coach reads your live Strava, Oura and calendar snapshots before answering.
              </p>
            )}
            {messages.map((m) => <ChatBubble key={m.id} msg={m} />)}
            {pending && <ChatBubble msg={{ id: "pending", role: "assistant", content: "", pending: true }} />}
          </div>
        </div>

        {/* suggested prompts */}
        {messages.length === 0 && (
          <div style={{ padding: "0 18px 10px", display: "flex", gap: 5, flexWrap: "wrap" }}>
            {SUGGESTED_PROMPTS.map((p) => (
              <button key={p} className="chip" style={{ fontSize: 9, textTransform: "none", letterSpacing: "0.04em" }} onClick={() => send(p)} disabled={pending}>
                {p}
              </button>
            ))}
          </div>
        )}

        {/* input */}
        <div style={{ borderTop: "1px solid var(--edge)", padding: "10px 14px", display: "flex", gap: 10, alignItems: "flex-end", background: "var(--night-deep)" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="ask the coach…"
            disabled={pending}
            rows={1}
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none", resize: "none",
              padding: "6px 2px", font: "13px var(--font-body)", color: "var(--mist)",
              minHeight: 30, maxHeight: 120,
            }}
          />
          {pending ? (
            <button className="chip" onClick={cancel} style={{ borderColor: "var(--ember)", color: "var(--ember)" }}>stop</button>
          ) : (
            <button
              className="chip"
              onClick={() => send(input)}
              disabled={!input.trim()}
              style={{
                background: input.trim() ? "var(--lamp)" : "transparent",
                borderColor: input.trim() ? "var(--lamp)" : "var(--edge-bright)",
                color: input.trim() ? "var(--night)" : "var(--mist-mute)",
                cursor: input.trim() ? "pointer" : "not-allowed",
              }}
            >send ⏎</button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** The coach reads goals, not the browsed race — facts.mjs takes its race
    from loadActiveRaceFolder, which requires train mode. Say so where the
    coach speaks, rather than letting an archived course on screen imply the
    readout is about it. */
function ViewingNotice() {
  const { race, viewing } = useBlockConfig();
  if (!viewing || !race) return null;
  return (
    <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--edge)", background: "rgba(198, 143, 62, 0.06)" }}>
      <div className="eyebrow" style={{ fontSize: 8.5, color: "var(--lamp)", marginBottom: 4 }}>
        viewing {race.short} · {viewing.status}
      </div>
      <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "var(--mist-mute)" }}>
        This readout, the flags and the plan are your CURRENT training — the coach works from your
        goals while {race.short} is open read-only, and was not told to train you for it.
      </div>
    </div>
  );
}

function FlagsRow({ flags }: { flags: Flag[] }) {
  if (flags.length === 0) {
    return (
      <div style={{ padding: "10px 18px", borderBottom: "1px solid var(--edge)" }}>
        <span className="eyebrow" style={{ color: "var(--pine)" }}>● all systems green</span>
      </div>
    );
  }
  return (
    <div style={{ padding: "10px 18px 12px", borderBottom: "1px solid var(--edge)" }}>
      <div className="eyebrow" style={{ fontSize: 8.5, marginBottom: 8 }}>flags · computed locally</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {flags.map((f, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
            title={f.detail}
            style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 11.5, lineHeight: 1.45 }}
          >
            <span style={{ width: 3, alignSelf: "stretch", background: SEVERITY_COLOR[f.severity], flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <span className="eyebrow" style={{ fontSize: 8.5, color: SEVERITY_COLOR[f.severity] }}>{f.label}</span>
              <div style={{ color: "var(--mist-dim)", marginTop: 1 }}>{f.detail}</div>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function ReadoutBlock({ agent, missing, open, setOpen, facts }: {
  agent: AgentReadout | null; missing: boolean;
  open: boolean; setOpen: (b: boolean) => void;
  facts: CoachFacts;
}) {
  if (!agent) {
    return (
      <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--edge)" }}>
        <span className="eyebrow" style={{ fontSize: 8.5 }}>readout · awaiting</span>
        <p style={{ fontSize: 12, color: "var(--mist-mute)", marginTop: 6, lineHeight: 1.5 }}>
          {missing
            ? <>No agent readout for this snapshot yet — hit <span style={{ color: "var(--lamp)" }}>resync</span> (runs <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>claude -p</code> on your subscription) or <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>npm run coach</code>.</>
            : "loading…"}
        </p>
      </div>
    );
  }
  return (
    <div style={{ borderBottom: "1px solid var(--edge)" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ width: "100%", padding: "11px 18px", display: "flex", justifyContent: "space-between", alignItems: "center", textAlign: "left" }}
      >
        <span className="eyebrow" style={{ fontSize: 8.5 }}>readout · {new Date(agent.generated_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).toLowerCase()}</span>
        <span className="eyebrow" style={{ fontSize: 9, color: "var(--lamp)" }}>{open ? "− collapse" : "+ expand"}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.2, 0.7, 0.2, 1] }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: "0 18px 14px" }}>
              <p style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--mist)", whiteSpace: "pre-wrap" }}>{agent.summary}</p>
              {agent.watch_outs && agent.watch_outs.length > 0 && (
                <>
                  <div className="eyebrow" style={{ fontSize: 8.5, margin: "12px 0 5px", color: "var(--lamp)" }}>watch-outs</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.55, color: "var(--mist-dim)" }}>
                    {agent.watch_outs.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                </>
              )}
              {agent.recommendations && agent.recommendations.length > 0 && (
                <>
                  <div className="eyebrow" style={{ fontSize: 8.5, margin: "12px 0 5px", color: "var(--pine)" }}>recommendations</div>
                  <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.55, color: "var(--mist-dim)" }}>
                    {agent.recommendations.map((r) => <li key={r}>{r}</li>)}
                  </ul>
                </>
              )}
              {facts.recent_tags.length > 0 && (
                <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 12 }}>
                  {facts.recent_tags.map((t) => (
                    <span key={`${t.day}-${t.label}`} className="eyebrow" style={{ fontSize: 8, border: "1px dashed var(--edge-bright)", padding: "2px 6px", color: "var(--mist-mute)" }}>
                      {t.label}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";
  const isError = msg.meta?.error;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}
      style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3, flexDirection: isUser ? "row-reverse" : "row" }}>
        <span className="eyebrow" style={{ fontSize: 8, color: isError ? "var(--ember)" : isUser ? "var(--mist-mute)" : "var(--lamp)" }}>
          {isUser ? "you" : isError ? "error" : "coach"}
        </span>
        {msg.meta?.num_turns != null && (
          <span className="numerals" style={{ fontSize: 8.5, color: "var(--mist-mute)" }}>
            {msg.meta.num_turns} turns{msg.meta.cost_usd != null && ` · $${msg.meta.cost_usd.toFixed(3)}`}
          </span>
        )}
      </div>
      <div style={{
        maxWidth: "94%",
        padding: "9px 12px",
        background: isUser ? "var(--panel-raise)" : isError ? "rgba(240, 102, 77, 0.08)" : "var(--night-deep)",
        border: `1px solid ${isUser ? "var(--edge-bright)" : isError ? "var(--ember)" : "var(--edge)"}`,
        borderLeft: isUser ? undefined : `2px solid ${isError ? "var(--ember)" : "var(--lamp)"}`,
        color: isError ? "var(--ember)" : "var(--mist)",
        fontSize: 12.5, lineHeight: 1.55,
        whiteSpace: "pre-wrap", wordBreak: "break-word",
      }}>
        {msg.pending ? <TypingDots /> : msg.content}
      </div>
      {((msg.meta?.saved_context?.length ?? 0) > 0 || (msg.meta?.saved_sections?.length ?? 0) > 0 || msg.meta?.context_save_error) && (
        <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
          {(msg.meta?.saved_context ?? []).map((s, i) => (
            <span key={i} className="eyebrow" style={{ fontSize: 8, color: "var(--pine)", textTransform: "none", letterSpacing: "0.04em" }}>
              ● saved to coach memory: “{s.text.length > 72 ? `${s.text.slice(0, 72)}…` : s.text}” · until {s.expires}
            </span>
          ))}
          {(msg.meta?.saved_sections ?? []).map((s, i) => (
            <span key={`s-${i}`} className="eyebrow" style={{ fontSize: 8, color: "var(--pine)", textTransform: "none", letterSpacing: "0.04em" }}>
              ● added to {s.section.replace(/_/g, " ")}: “{s.text.length > 72 ? `${s.text.slice(0, 72)}…` : s.text}”
            </span>
          ))}
          {msg.meta?.context_save_error && (
            <span className="eyebrow" style={{ fontSize: 8, color: "var(--ember)", textTransform: "none", letterSpacing: "0.04em" }}>
              ● context save failed — {msg.meta.context_save_error} (the reply may still claim it saved)
            </span>
          )}
        </div>
      )}
    </motion.div>
  );
}

function TypingDots() {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18 }}
          style={{ width: 5, height: 5, background: "var(--lamp)", display: "inline-block", transform: "rotate(45deg)" }}
        />
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Connection strips + footer setup drawer                            */
/* ------------------------------------------------------------------ */

function ConnectStrip({ kind }: { kind: "oura" | "google" }) {
  const copy = kind === "oura"
    ? { label: "ring not connected", text: "Sleep, readiness, HRV and resting HR via Oura's OAuth2 — setup runs locally.", target: "setup-oura" }
    : { label: "calendar not connected", text: "Google Calendar gives the coach schedule context — travel, races, work blocks.", target: "setup-google" };
  const scroll = () => {
    const el = document.getElementById(copy.target);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.dispatchEvent(new CustomEvent("almanac:open"));
  };
  return (
    <div style={{
      marginTop: 8, padding: "10px 16px", border: "1px dashed var(--edge-bright)",
      display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
    }}>
      <span className="eyebrow" style={{ color: "var(--lamp)" }}>◆ {copy.label}</span>
      <span style={{ fontSize: 12, color: "var(--mist-mute)", flex: 1, minWidth: 200 }}>{copy.text}</span>
      <button className="chip" onClick={scroll} style={{ borderColor: "var(--lamp)", color: "var(--lamp)" }}>set up ↓</button>
    </div>
  );
}

const codeChip: React.CSSProperties = {
  background: "var(--night-deep)",
  border: "1px solid var(--edge)",
  padding: "1px 6px",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};
const codeBlock: React.CSSProperties = {
  background: "var(--night-deep)",
  padding: 10,
  border: "1px solid var(--edge)",
  fontFamily: "var(--font-mono)",
  fontSize: 11.5,
  marginTop: 6,
  overflow: "auto",
  color: "var(--mist-dim)",
};
const olStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  color: "var(--mist-dim)",
  paddingLeft: 20,
  margin: 0,
};
const linkLamp: React.CSSProperties = { color: "var(--lamp)", textDecoration: "underline" };

function SetupDrawer() {
  const strava = useStrava();
  const stravaOk = strava.activities.length > 0 && !strava.error;
  const { connected: ouraOk } = useOura();
  const { connected: googleOk } = useGoogleCal();
  const { data: agent } = useAgentReadout();
  const coachOk = !!agent;
  const [open, setOpen] = useState<"strava" | "oura" | "google" | "coach" | null>(null);
  const ouraRef = useRef<HTMLLIElement | null>(null);
  const googleRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    const oel = ouraRef.current;
    const gel = googleRef.current;
    const onOpenOura = () => setOpen("oura");
    const onOpenGoogle = () => setOpen("google");
    oel?.addEventListener("almanac:open", onOpenOura as EventListener);
    gel?.addEventListener("almanac:open", onOpenGoogle as EventListener);
    return () => {
      oel?.removeEventListener("almanac:open", onOpenOura as EventListener);
      gel?.removeEventListener("almanac:open", onOpenGoogle as EventListener);
    };
  }, []);

  const items: {
    key: "strava" | "oura" | "google" | "coach";
    title: string;
    connected: boolean;
    render: () => React.ReactNode;
  }[] = [
    {
      key: "strava",
      title: "Strava",
      connected: stravaOk,
      render: () => (
        <ol style={olStyle}>
          <li>
            Set up the strava-mcp client (one time): <a href="https://github.com/r-huijts/strava-mcp" target="_blank" rel="noopener noreferrer" style={linkLamp}>r-huijts/strava-mcp ↗</a>
          </li>
          <li>Confirm credentials saved at <code style={codeChip}>~/.config/strava-mcp/config.json</code>.</li>
          <li>Pull data from <code style={codeChip}>web/</code>:<pre style={codeBlock}>npm run sync:strava</pre></li>
        </ol>
      ),
    },
    {
      key: "oura",
      title: "Oura ring",
      connected: ouraOk,
      render: () => (
        <ol style={olStyle}>
          <li>
            Register an app:{" "}
            <a href="https://cloud.ouraring.com/oauth/applications" target="_blank" rel="noopener noreferrer" style={linkLamp}>cloud.ouraring.com/oauth/applications ↗</a>
            <div style={{ marginTop: 6, color: "var(--mist-mute)", fontSize: 12 }}>
              redirect URI: <code style={codeChip}>http://localhost:5174/oura-callback</code><br />
              scopes: <code style={codeChip}>daily heartrate tag personal</code>
            </div>
          </li>
          <li>
            Save credentials to <code style={codeChip}>~/.config/oura/config.json</code>:
            <pre style={codeBlock}>{`{
  "clientId": "...",
  "clientSecret": "...",
  "redirectUri": "http://localhost:5174/oura-callback"
}`}</pre>
          </li>
          <li>Authorize once (opens browser):<pre style={codeBlock}>npm run auth:oura</pre></li>
          <li>Pull data anytime:<pre style={codeBlock}>npm run sync:oura</pre></li>
        </ol>
      ),
    },
    {
      key: "google",
      title: "Google Calendar",
      connected: googleOk,
      render: () => (
        <ol style={olStyle}>
          <li>
            Enable the Calendar API for your GCP project:{" "}
            <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener noreferrer" style={linkLamp}>calendar-json.googleapis.com ↗</a>
          </li>
          <li>Configure the OAuth consent screen (External, testing mode is fine) and add your own email under "Test users".</li>
          <li>
            Create an OAuth 2.0 Client ID (Web application):
            <div style={{ marginTop: 6, color: "var(--mist-mute)", fontSize: 12 }}>
              redirect URI: <code style={codeChip}>http://localhost:5174/google-callback</code><br />
              scopes: <code style={codeChip}>calendar.readonly</code>
            </div>
          </li>
          <li>
            Save the client credentials to <code style={codeChip}>~/.config/google/config.json</code>:
            <pre style={codeBlock}>{`{ "clientId": "...", "clientSecret": "...",
  "redirectUri": "http://localhost:5174/google-callback" }`}</pre>
            <div style={{ marginTop: 6, color: "var(--mist-mute)", fontSize: 12 }}>
              (or export <code style={codeChip}>GOOGLE_CAL_API_CLIENT_ID</code> / <code style={codeChip}>GOOGLE_CAL_API_CLIENT_SECRET</code> as env vars)
            </div>
          </li>
          <li>Authorize once (opens browser, writes tokens to <code style={codeChip}>~/.config/google/tokens.json</code>):<pre style={codeBlock}>npm run auth:google</pre></li>
          <li>Pull events anytime:<pre style={codeBlock}>npm run sync:google</pre></li>
        </ol>
      ),
    },
    {
      key: "coach",
      title: "Claude coach",
      connected: coachOk,
      render: () => (
        <ol style={olStyle}>
          <li>
            Make sure the Claude Code CLI is installed and logged in:
            <pre style={codeBlock}>claude --version</pre>
            <span style={{ fontSize: 12, color: "var(--mist-mute)" }}>
              Uses your existing Claude Code subscription via headless <code style={codeChip}>claude -p</code> — no API key needed.
            </span>
          </li>
          <li>
            From <code style={codeChip}>web/</code> run:
            <pre style={codeBlock}>npm run coach</pre>
            <span style={{ fontSize: 12, color: "var(--mist-mute)" }}>
              Computes deterministic facts → spawns <code style={codeChip}>claude -p</code> with Read access → writes <code style={codeChip}>web/public/coach.json</code>. The dashboard auto-loads it.
            </span>
          </li>
          <li>Or chain it after a sync:<pre style={codeBlock}>npm run sync:all && npm run coach</pre></li>
        </ol>
      ),
    },
  ];

  return (
    <footer style={{ marginTop: 40, borderTop: "1px solid var(--edge)", paddingTop: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
        <span className="eyebrow">connections · tokens stay local</span>
        <span className="eyebrow" style={{ fontSize: 8.5 }}>basecamp · set in bricolage grotesque + spline sans mono</span>
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {items.map((it) => {
          const isOpen = open === it.key;
          return (
            <li
              key={it.key}
              ref={it.key === "oura" ? ouraRef : it.key === "google" ? googleRef : undefined}
              id={`setup-${it.key}`}
              style={{ borderBottom: "1px solid var(--edge)" }}
            >
              <button
                onClick={() => setOpen(isOpen ? null : it.key)}
                style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", textAlign: "left" }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span aria-hidden style={{
                    display: "inline-block", width: 12,
                    transform: isOpen ? "rotate(45deg)" : "rotate(0deg)", transition: "transform 200ms",
                    fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--lamp)",
                  }}>+</span>
                  <span className="display" style={{ fontSize: 16, fontWeight: 600 }}>{it.title}</span>
                  <span className="eyebrow" style={{ fontSize: 8.5, display: "inline-flex", alignItems: "center", gap: 6, color: it.connected ? "var(--pine)" : "var(--lamp)" }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: it.connected ? "var(--pine)" : "var(--lamp)", display: "inline-block" }} />
                    {it.connected ? "connected" : "set up"}
                  </span>
                </span>
                <span className="eyebrow" style={{ fontSize: 8.5 }}>{isOpen ? "hide" : "show"}</span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3, ease: [0.2, 0.7, 0.2, 1] }}
                    style={{ overflow: "hidden" }}
                  >
                    <div style={{ padding: "4px 0 24px 24px", maxWidth: 680 }}>{it.render()}</div>
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          );
        })}
      </ul>
      <div style={{ display: "flex", justifyContent: "space-between", padding: "14px 0 0" }}>
        <span className="eyebrow" style={{ fontSize: 8.5 }}>© basecamp · one race at a time</span>
        <span className="eyebrow" style={{ fontSize: 8.5 }}>strava · oura · google calendar · claude code</span>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/*  App shell                                                          */
/* ------------------------------------------------------------------ */

function AppBody() {
  const { key } = useRefresh();
  const { race, viewing } = useBlockConfig();
  // the slug ON SCREEN, for the crash boundary's message and its "back to
  // generic mode" pointer reset — same source useRacePlanInstance itself reads.
  const { activeRace, viewing: viewingSlug } = useActiveRace();
  const hash = useHashRoute();
  const [view, setViewState] = useState<AppView>(() => {
    // validate rather than cast — a stale or hand-edited key would otherwise
    // render an empty main column with no way back except clearing storage
    const saved = typeof localStorage === "undefined" ? null : localStorage.getItem("view");
    return isAppView(saved) ? saved : "training";
  });
  const setView = (v: AppView) => {
    setViewState(v);
    try { localStorage.setItem("view", v); } catch { /* private mode — preference just won't persist */ }
  };
  const [railOpen, setRailOpen] = useState<boolean>(() =>
    typeof localStorage === "undefined" || localStorage.getItem("rail.open") !== "0"
  );
  const toggleRail = () => {
    setRailOpen((open) => {
      try { localStorage.setItem("rail.open", open ? "0" : "1"); } catch { /* private mode */ }
      return !open;
    });
  };
  // A persisted "race"/"nutrition" survives the race being archived (and is
  // there on every reload before the payload lands). Resolve it to training
  // WITHOUT rewriting the preference: once a race is active again the
  // athlete gets the view they last chose back, instead of having had it
  // quietly overwritten by a loading frame.
  const views = appViews(race, fuelViewHidden(activeRace));
  const activeView = views.includes(view) ? view : "training";
  // Race-day mode takes the whole screen: the command bar and the agent
  // rail are desk furniture, and on a phone they cost a third of the page
  // the runner is squinting at. All hooks above run either way, so this is
  // a render branch, not a conditional hook. Reached by URL today; the
  // switcher menu has no entry for it yet (see the bead's follow-ups).
  if (hash === RACE_DAY_HASH) return <RaceDayRoute />;
  return (
    <>
      <CommandBar view={activeView} setView={setView} railOpen={railOpen} toggleRail={toggleRail} />
      <div className="shell">
        <div className={"ops-grid" + (railOpen ? "" : " rail-hidden")}>
          {/* main column */}
          <main style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
            {/* on every view: the race on screen is not the one being trained for */}
            <ViewingBanner />
            {/* CommandBar's tablist points aria-controls at THIS element —
                one dynamically-swapped panel rather than three permanently
                mounted ones (each view already unmounts/remounts its own
                subtree via `key`, RaceErrorBoundary and RacePlanProvider
                below, and keeping all three alive at once would multiply
                that machinery for no reader-visible benefit). The id/
                aria-labelledby pair always names the CURRENTLY selected
                tab, matching the APG's single-panel SPA pattern. */}
            <div
              role="tabpanel"
              id={`tabpanel-${activeView}`}
              aria-labelledby={`tab-${activeView}`}
              tabIndex={0}
              style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
            >
              {activeView === "training" ? (
                <>
                  {/* no race, no ribbon: there is no course, countdown or
                      elevation profile to put in it (PRD §6) */}
                  {race && <RaceRibbon race={race} readOnly={!!viewing} />}
                  <div key={`vitals-${key}`}><VitalsBand /></div>
                  <div key={`traj-${key}`}><Trajectory /></div>
                  <div key={`road-${key}`}><RoadAhead /></div>
                  <div key={`log-${key}`}><LogTable /></div>
                  <SetupDrawer />
                </>
              ) : activeView === "race" ? (
                <div key={`race-${key}`}>
                  {/* the boundary sits OUTSIDE the provider: useRacePlanInstance
                      computes the whole plan (course, projection, fuel) during
                      RacePlanScope's render, so a bad folder throws before any
                      child below the provider ever mounts (tt bug fix-sun-null). */}
                  <RaceErrorBoundary slug={viewingSlug}>
                    {/* one shared plan instance — planner sliders and the model
                        check must never disagree on the same screen. The climb
                        comparison takes no sliders, but it reads its visual.panels
                        gate off the same instance rather than fetching the active
                        race a second time, so it lives inside the provider too. */}
                    <RacePlanProvider>
                      <ClimbComparison />
                      <RacePlanner />
                      <ModelCheck />
                    </RacePlanProvider>
                  </RaceErrorBoundary>
                </div>
              ) : (
                <div key={`fuel-${key}`}>
                  <RaceErrorBoundary slug={viewingSlug}>
                    {/* single consumer, but useRacePlan requires the provider —
                        a fallback instance was the divergence footgun */}
                    <RacePlanProvider>
                      <NutritionPlan />
                    </RacePlanProvider>
                  </RaceErrorBoundary>
                </div>
              )}
            </div>
          </main>

          {/* the coach — persistent rail (hidden, not unmounted, when collapsed) */}
          <AgentRail onCollapse={toggleRail} />
        </div>
      </div>
    </>
  );
}

export default function App() {
  return (
    <UnitsProvider>
      <RefreshProvider>
        {/* renders nothing — repaints :root when the race on screen changes */}
        <RaceTheme />
        <StateProvider>
          <StravaProvider>
            <OuraProvider>
              <AppBody />
            </OuraProvider>
          </StravaProvider>
        </StateProvider>
      </RefreshProvider>
    </UnitsProvider>
  );
}
