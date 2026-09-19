import { useCallback, useState } from "react";
import { runStage } from "./dialogChrome";

/* ------------------------------------------------------------------ */
/*  D8: "no course data" used to tell the athlete to run a shell        */
/*  command — useless from the phone that is usually the one looking    */
/*  at this screen. Stage 2 (the GPX match + sun computation that       */
/*  writes build/course.json) is deterministic and free, so the empty   */
/*  state can just offer the button, reusing the same SSE stream reader */
/*  the review dialog's "COURSE" run-again button uses (dialogChrome.ts)*/
/*  and the switcher's own "Run course again…" row for archived races   */
/*  (App.tsx). One hook, three call sites, one behavior.                */
/* ------------------------------------------------------------------ */

export type RunCourseAgainState = {
  busy: boolean;
  error: string | null;
  done: boolean;
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

  const run = useCallback(() => {
    if (!slug || busy) return;
    setBusy(true);
    setError(null);
    runStage("/api/race-intake/build", { slug }, () => {}, new AbortController().signal)
      .then(() => { setDone(true); onDone(); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, [slug, busy, onDone]);

  return { busy, error, done, run };
}
