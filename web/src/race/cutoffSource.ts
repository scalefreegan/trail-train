import type { Course } from "./types";

/* ------------------------------------------------------------------ */
/*  Where a course's cutoff times came from — shared by RacePlanner.tsx */
/*  (station table footer) and CrewSheet.tsx (printed handout), which   */
/*  used to each carry their own copy of this derivation and disagree   */
/*  on the one thing that actually matters: whether there is a cutoff   */
/*  to attribute a source to at all (round 4 finding 12).               */
/* ------------------------------------------------------------------ */

/** Does ANY station on this course carry a posted cutoff? A quick-form
    tune-up writes `cutoff_h: null` on every station and no `sources` entry
    of its own (races/<slug>/race.json never had a manual to read) — and, in
    principle, a fun-run A race could be genuinely cutoff-free too. Callers
    check this before naming a source: attributing "the runner manual" to a
    course with nothing to attribute is worse than saying there is nothing. */
export function courseHasCutoffs(course: Pick<Course, "aid_stations">): boolean {
  return course.aid_stations.some((s) => s.cutoff_h != null);
}

/**
 * "Cutoffs from …" names the document a course's cutoff times came from —
 * the first manual/guide/handbook-ish `sources` entry, or the first
 * non-GPX one, stripped of its parenthetical scope note. A URL collapses to
 * its hostname (the fact an athlete actually recognizes a source by — a
 * manual's own 70-character PDF link otherwise turns into a wall of
 * all-caps slug on a printed card: round 2 review, draft finding 6);
 * anything that isn't a URL at all (a bare document title) is short enough
 * to print as-is.
 *
 * The generic "the runner manual" fallback is only ever correct when there
 * IS a cutoff to attribute — callers must check `courseHasCutoffs` first
 * and show something else (RacePlanner.tsx: "no cutoffs on this course")
 * when there is not, rather than calling this unconditionally.
 */
export function cutoffSourceLabel(
  course: Pick<Course, "sources">,
  opts: { editionYear?: number | null } = {},
): string {
  const sources = course.sources ?? [];
  const manual = sources.find((s) => /manual|guide|handbook/i.test(s.ref));
  const ref = (manual ?? sources.find((s) => s.kind !== "gpx"))?.ref;
  const fallback = `the runner manual${opts.editionYear ? ` (${opts.editionYear})` : ""}`;
  if (!ref) return fallback;
  const stripped = ref.replace(/\s*\([^)]*\)\s*$/, "");
  try {
    return new URL(stripped).hostname.replace(/^www\./, "");
  } catch {
    return stripped || fallback;
  }
}
