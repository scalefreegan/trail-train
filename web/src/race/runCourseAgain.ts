import { useCallback, useState } from "react";
import { runStage } from "./dialogChrome";

/* ------------------------------------------------------------------ */
/*  D8: "no course data" used to tell the athlete to run a shell        */
/*  command — useless from the phone that is usually the one looking    */
/*  at this screen. Stage 2 (the GPX match + sun computation that       */
/*  writes build/course.json) is deterministic and free, so the empty   */
/*  state can just offer the button, reusing the same SSE stream reader */
/*  the review dialog's "COURSE" run-again button uses (dialogChrome.ts)*/
/*  Three call sites — RaceDay.tsx, RacePlanner.tsx, NutritionPlan.tsx — */
/*  each an empty "no course data yet" state with nothing else on       */
/*  screen. The switcher's own "Run course again…" row (App.tsx) is a   */
/*  fourth surface for the SAME build endpoint, on an ARCHIVED race that*/
/*  already has other content on screen (round 3 sweep: the doc comment*/
/*  here used to claim it as a fourth call site of THIS hook, which was */
/*  never true — App.tsx never imported it); it hand-rolls the same two */
/*  ok:true checks below (null course, a built-but-warned course) since */
/*  its own busy/hint state is keyed per-row across N races, not one    */
/*  fixed slug the way this hook's callers are.                        */
/*                                                                       */
/*  Round 3 sweep, second pass: on the RACE/FUEL tabs, `onDone()` IS     */
/*  `reload()`, and App.tsx wraps those tabpanels in                    */
/*  `key={`race-${key}`}`/`key={`fuel-${key}`}` — the SAME pulse — so a  */
/*  successful build remounts the whole subtree (this hook's own state  */
/*  included) the instant it succeeds, before a caller ever gets to     */
/*  paint `warnings`. `resultStore` below is what survives that: the    */
/*  hook writes its own outcome into it (keyed by slug) right before    */
/*  handing back control, and re-reads it once `slug` next comes back   */
/*  non-null — which on a remount is not the same render `slug` was     */
/*  first non-null on (see the mount-time comment below), so this has   */
/*  to be an effect keyed on `slug`, not a `useState` lazy initializer.  */
/* ------------------------------------------------------------------ */

/** One hook instance's last outcome for one race, kept outside React so a
    remount (or a plain tab-away-and-back, which unmounts this component
    just as completely) can recover it. Module-level, not sessionStorage:
    nothing here needs to survive an actual page reload — a real reload
    re-fetches for real, and a stale "the build had this to say" from a
    browser session two days ago would be actively misleading. Cleared the
    moment a fresh `run()` starts for that slug (never mid-flight: only
    the store, not the component's own live `busy`/`warnings` state, which
    a genuine remount destroys regardless of what this map holds). */
const resultStore = new Map<string, { error: string | null; warnings: string[]; done: boolean }>();

export type RunCourseAgainState = {
  busy: boolean;
  error: string | null;
  done: boolean;
  /** Round 3 sweep (r3-sweep.md HIGH #1 extension): `course != null` (a real
      build, `done` true) is not "nothing left to say" — a course.gpx
      measuring far off the declared distance/gain, or a user-set waypoint
      override the matcher couldn't honor, still builds and still answers
      `ok: true`, with the reason here (scripts/build-course.mjs's
      courseMismatches, surfaced through scripts/race-build.mjs). Empty on a
      clean build. A caller that ignores this renders a degraded rebuild
      exactly like a clean one — which is the bug this field exists to let
      RaceDay.tsx/RacePlanner.tsx/NutritionPlan.tsx each stop being. */
  warnings: string[];
  run: () => void;
};

/**
 * @param slug the race folder to (re)build — null disables `run` (there is
 *   nothing on screen to build yet)
 * @param onDone called after a successful build — the caller's job to
 *   refetch whatever now exists (course.json, nutrition, etc.)
 */
export function useRunCourseAgain(slug: string | null, onDone: () => void): RunCourseAgainState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Recovers `resultStore`'s entry for THIS slug whenever `slug` next comes
  // back non-null — not a `useState` lazy initializer, which only runs once,
  // at this component's OWN first render. On the RACE/FUEL tabs that first
  // render happens with `slug` still null: the remount's `missing` starts at
  // its default `false` (see the file-header comment), so the caller passes
  // `null` here for a render or two until its OWN 404 lands and flips
  // `missing` true — THAT transition, not the mount, is when this hook needs
  // to notice a stored result is waiting.
  //
  // Adjusted during RENDER, not in a `useEffect` — React's own documented
  // alternative for "state that depends on a prop changing"
  // (react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes):
  // an effect that unconditionally calls setState on every dependency change
  // commits the stale render first and only THEN queues the corrected one
  // (react-hooks/set-state-in-effect flags exactly this as a needless
  // cascading render); doing it here bails out of the stale render before it
  // ever commits. `recoveredFor` is what makes this run at most once per
  // distinct `slug` rather than looping.
  const [recoveredFor, setRecoveredFor] = useState<string | null>(null);
  if (slug && slug !== recoveredFor) {
    setRecoveredFor(slug);
    const stored = resultStore.get(slug);
    if (stored) {
      setError(stored.error);
      setWarnings(stored.warnings);
      setDone(stored.done);
    }
  }

  const run = useCallback(() => {
    if (!slug || busy) return;
    setBusy(true);
    setError(null);
    setWarnings([]);
    // A fresh click is a fresh question — nothing stale should be waiting to
    // be recovered by the effect above if THIS run also gets torn down by a
    // remount before it can render its own answer.
    resultStore.delete(slug);
    runStage("/api/race-intake/build", { slug }, () => {}, new AbortController().signal)
      .then((result) => {
        // `ok: true` is not "there is now a course to show" — a folder with
        // no course.gpx and no http(s) links.gpx answers this way too:
        // `course: null` plus a warning naming the reason (round 4 finding
        // 2). Calling onDone() unconditionally used to make this a dead
        // button on exactly that folder — the caller's refetch just re-404s,
        // so the panel comes back byte-identical with no error, no toast, no
        // sign the click did anything. Surface the server's own reason
        // instead, the same way an actual exception already does below.
        if (result.course == null) {
          const w = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
          const message = w[0] ?? "the build finished without a course to show";
          // Written even though THIS branch never calls onDone()/reload() (so
          // never remounts on its own account): a plain tab-away-and-back
          // unmounts this component just as completely, and this is the only
          // one of the two branches whose message would otherwise be lost to
          // that too.
          resultStore.set(slug, { error: message, warnings: [], done: false });
          setError(message);
          return;
        }
        // Round 3 sweep extension: a course DID build, but `warnings` can
        // still be non-empty (a distance/gain mismatch, an unhonored user
        // waypoint override) — a real result, not a failure, so `done` still
        // goes true and `onDone()` still fires (the caller's refetch is
        // correct either way), but the caller now has what it needs to say
        // "built, with a catch" instead of rendering this identically to a
        // clean build.
        const w = Array.isArray(result.warnings) ? (result.warnings as string[]) : [];
        // Written BEFORE onDone(): onDone() is reload() on the three panel
        // call sites, and reload() is exactly the pulse that remounts the
        // RACE/FUEL tabpanels (App.tsx's `key={`race-${key}`}` /
        // `key={`fuel-${key}`}`) — this has to already be in the store by the
        // time that remount's fresh mount goes looking for it.
        resultStore.set(slug, { error: null, warnings: w, done: true });
        setWarnings(w);
        setDone(true);
        onDone();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, [slug, busy, onDone]);

  return { busy, error, done, warnings, run };
}
