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
/* ------------------------------------------------------------------ */

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

  const run = useCallback(() => {
    if (!slug || busy) return;
    setBusy(true);
    setError(null);
    setWarnings([]);
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
          setError(w[0] ?? "the build finished without a course to show");
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
        setWarnings(w);
        setDone(true);
        onDone();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, [slug, busy, onDone]);

  return { busy, error, done, warnings, run };
}
