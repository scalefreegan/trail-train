export type CourseAvailabilitySignal =
  | { kind?: string | null; sources?: { kind: string }[] | null }
  | null
  | undefined;

/**
 * True when a race's own race.json already tells us `/course.json` can only
 * ever 404 for it — v2 review ui1 #14: a tune-up (kind "b") the quick form
 * created without a GPX (`AddTuneUp.tsx`) has no upload path afterward, so
 * every view of it repeats the exact same permanent 404. Chrome logs that
 * to the console on its own, regardless of how gracefully the response is
 * handled — the only way to avoid the noise is to never ask when the answer
 * is already known.
 *
 * A standalone module (same reason as raceDayHold.ts/whereAmI.ts/
 * holdPrecedence.ts/loadFailureMessage.ts: node-testable without a browser)
 * rather than an inline expression in useCourse(), so this one decision has
 * its own name and its own test.
 *
 * Deliberately narrow: only a kind "b" race with no `{kind:"gpx"}` entry in
 * its own `sources` (populated once, at creation time, by
 * scripts/race-intake.mjs's quickCreateRace — there is no "add a GPX to an
 * existing tune-up" path afterward) counts as known-courseless. An "a" race
 * never matches this check, and neither does a tune-up that DOES have a GPX
 * but simply hasn't had its course built yet — that 404 is real and
 * transient, not permanent, and worth seeing if something is stuck.
 */
export function isKnownCourseless(race: CourseAvailabilitySignal): boolean {
  return race?.kind === "b" && !race.sources?.some((s) => s.kind === "gpx");
}
