# Fix report — round 3, raceday lane (v2fix-r3-raceday)

Branch: `v2fix-r3-raceday` @ base `a33c915`. Lane: `web/src/App.tsx` (only the
`runCourseAgain` switcher row, ~547-566/~763 and its busy/hint state),
`web/src/race/RaceIntake.tsx`, `web/src/race/RaceDay.tsx`,
`web/src/race/runCourseAgain.ts`, and `web/tests/{switcher,review,race-day}.spec.ts`.

## Finding 1 (HIGH, r3-sweep.md, App.tsx:547-566) — false "course rebuilt ✓"

**Root cause.** The switcher's "Run course again…" row called `runStage(...)`
with `() => {}` as `onEvent` and threw away the resolved `done` payload
entirely. `POST /api/race-intake/build` answers `ok: true` in two cases that
are not "a course rebuilt cleanly": `course: null` (no `course.gpx` in the
folder and no `http(s) links.gpx` to fetch one from —
`scripts/race-build.mjs`'s `stop()` path) and a built course whose measured
distance/gain is >15% off the declared figures (`warnings`, from
`build-course.mjs`'s `courseMismatches`). Both were rendered identically to a
clean build: `setBuiltNotice(slug)` → "course rebuilt ✓". The sibling hook
`runCourseAgain.ts` (`useRunCourseAgain`, used by RacePlanner/NutritionPlan/
RaceDay) already had the first check; the switcher's hand-rolled copy had
neither.

**Fix.** Inlined both checks in `App.tsx`'s `runCourseAgain` (kept it
hand-rolled rather than routing through the shared hook — the hook is
parameterized by one fixed slug per mount, and the switcher needs one
callback usable across whichever row's slug was clicked; restructuring that
was more churn than the fix warranted, and the lane note allowed inlining):
- `result.course == null` → `setError(warnings[0] ?? "the build finished
  without a course to show")`, the same top-level error banner every other
  switcher failure uses. This also disables the other rows, same as any
  other switcher error — that's existing, unrelated behavior, unchanged here.
- `result.course` present but `result.warnings.length > 0` → a new
  `builtWarning: {slug, message}` state, self-clearing after 4s exactly like
  `builtNotice`. The row's `hint` now branches: `builtNotice` → "course
  rebuilt ✓", else `builtWarning` for this slug → `⚠ <message>`, else the
  default hint text.
- Clean build (course present, no warnings) → unchanged "course rebuilt ✓".

**Files.** `web/src/App.tsx` (the `builtWarning` state declaration next to
`builtNotice`, the `runCourseAgain` callback body, the row's `hint` prop).

**How a verifier triggers the guard.** `web/tests/switcher.spec.ts`, two new
tests:
- *"Run course again on a race with no course.gpx shows the reason, not a
  false tick"* — uses the existing `ARCHIVED` fixture (`rimrock-50k`), which
  already has no `course.gpx` and `links` with only `site` (no `gpx`) — the
  exact "stop" shape (confirmed against `scripts/race-build.mjs`'s own "no
  course.gpx and no links.gpx: unresolved, not a failure" unit test, which
  also confirms this path writes **nothing** to the folder, so it's safe to
  build against the shared fixture from a Playwright spec). Clicks the row,
  asserts the top-level error text appears and the row never shows "rebuilt
  ✓".
- *"Run course again on a clean build still shows the tick"* — writes a new
  fixture straight onto the shared temp root, `races/r3rd-clean-archived-50k`
  (single "Finish" aid station — race-build.mjs's matcher only special-cases
  the *last* station as the finish line, so with one station there is no
  aid-station-matching warning either — plus a synthetic `course.gpx` and a
  `distance_mi`/`gain_ft` pairing (30 / 399) taken from
  `scripts/race-build.test.mjs`'s own "a GPX within normal drift of
  race.json's distance_mi (and gain) raises nothing" case against the
  identical synthetic track). Confirms the tick still appears.

The mismatch/`warnings`-with-a-real-course branch (the second check) is
implemented but not separately pinned by a new Playwright test — the two
tests above were what the finding asked for by name; the branch reuses the
exact same payload shape AddTuneUp.tsx's own build-warning banner already has
a passing spec for (`web/tests/tuneup-fixes.spec.ts`'s "bug 1 & 4 & 12").

## Finding 2 (MEDIUM, r3-raceday.md, RaceIntake.tsx:742-744/851-853) — cleared tracker URL not durable

**Root cause.** `linksTrackingSeed` re-seeded `tracking.url` from
`race.links.tracking` whenever `race.tracking?.url` read falsy. But
`scripts/race-edit.mjs`'s `applyRaceEdit` already normalizes a client-sent
`""` to `null` on write ("`\"\"` is how a text input says 'I cleared this' —
stored as null" — race-edit.mjs:440-444), so a *deliberate* clear is
indistinguishable, by value, from *never set*. The "deliberately cleared"
guard in `buildBody` (`trackingEdit.url === ""` is sent as-is) only covers
the save that does the clearing — the next time the dialog mounts,
`trackingEdit` resets to `null` (on load, `RaceIntake.tsx`'s reload effect),
`race.tracking.url` reads `null` same as "never touched", and
`linksTrackingSeed` fires again. A later save that only touches bib/name
then has `buildBody`'s `trackingEdit.url !== undefined ? ... : linksTrackingSeed`
put the abandoned seed right back onto disk.

**No server-side change needed — checked, and here's why.** I confirmed
`scripts/race-edit.mjs`'s merge (`applyRaceEdit`, ~432-449) always writes the
`url` **key** onto `race.tracking` whenever a save touches it at all — including
a clear, where it lands as an explicit `null`, not an absent key. A race
whose `tracking.url` has genuinely never been saved has no `url` key on the
object at all (either `race.tracking` itself is absent — intake only writes
it when it found a tracking link — or, on a folder that has only ever saved
`bib`/`name`, `race.tracking = {bib: "…"}` with no `url` key, since
`race-edit.mjs`'s merge only ever writes the keys present in the PUT body).
So `"url" in race.tracking` distinguishes "decided" (set OR cleared) from
"never asked" using data that's already on disk today, via the existing
`GET /api/races/:slug` (`race-edit.mjs`'s review payload returns
`folder.race` verbatim — no reshaping). I considered a `tracking.url_cleared`
marker (your other suggested option) but it's unnecessary and would have
needed `EDITABLE_TRACKING_KEYS`/`validateRaceJson` whitelist changes in
`scripts/` (out of my lane) for no behavioral gain over the key-presence
check.

**Fix.** `RaceIntake.tsx`: added `trackingUrlEverSet = trackingObj != null &&
"url" in trackingObj` (from `race?.tracking`). `linksTrackingSeed` is now
gated on `trackingUrlEverSet` instead of `race?.tracking?.url` truthiness.
`buildBody`'s existing `linksTrackingSeed ?? undefined` fallback needed no
separate change — it already resolves to `undefined` once the seed itself is
suppressed, so a bib/name-only save sends no `tracking.url` at all once the
field has been decided (set or cleared). The seed-suggestion copy/placeholder
in the tracker-URL block (lines ~1077-1092) reads the same
`linksTrackingSeed`, so it stops re-offering the abandoned link too.

**Files.** `web/src/race/RaceIntake.tsx` only.

**How a verifier triggers the guard.** `web/tests/review.spec.ts`, new test
*"clearing the tracker url is durable — a later bib-only save does not
resurrect it from the seed"*: PUTs `mm-like-100`'s `tracking.url` to a known
value directly, opens Review, clears the URL field, saves, confirms
`race.json`'s url is falsy, **reloads the page** (fresh mount —
`trackingEdit` starts `null` again, the exact shape a new session leaves),
reopens Review, asserts neither the "seeded below…" copy nor the input value
shows the seed, edits **only** the bib field, saves, and asserts the captured
PUT body has `tracking.url === undefined` (not resent) and
`race.json`'s url is still falsy after. Restores `mm-like-100`'s tracking to
null afterward (same cleanup convention the existing test above it uses).

## Finding 3 (LOW, r3-raceday.md, RaceDay.tsx:705-719) — stale WHERE AM I error survives a successful "passed at" hold

**Root cause.** The "passed \<station\> at HH:MM" form's `onSubmit` cleared
`cpStation`/`cpClock`/`stationDraft`/`miDraft` on success, matching the other
two hold-committing paths ("where am i"'s submit, and the AUTO button) —
but, alone among the three, never cleared `whereAmIError`.

**Fix.** Added `setWhereAmIError(null)` to that `onSubmit`, alongside the
existing draft clears.

**Files.** `web/src/race/RaceDay.tsx`.

**How a verifier triggers the guard.** `web/tests/race-day.spec.ts`, new test
*'the "passed \<station\> at" form clears a stale WHERE AM I error on
success'*: types an unparsable value into the "where am i" mile box, submits
(banner appears), then picks a station and time in the *other* form and
submits it — asserts the hold commits and the stale banner is gone.

## Finding 4 (LOW, r3-sweep.md, switcher.spec.ts:96-133) — missing pageErrors assertion

**Fix.** Added the `trouble` fixture and `expect(trouble.pageErrors).toEqual([])`
to "a tune-up chained onto another tune-up renders once, orphaned, and does
not shift the cursor", matching every other test in the file.

**Files.** `web/tests/switcher.spec.ts`.

## Addendum — sweep round 2 (SHAs `fe98679`, `f97e0bb`)

Two follow-up messages after the above landed: two more RaceIntake.tsx
findings from the second sweep report (r3-sweep-b.md), and an extension to
finding 1 (the shared `useRunCourseAgain` hook also drops `warnings`).

### Finding 1 extension (r3-sweep.md, first HIGH) — hook + all four surfaces

**Root cause.** `web/src/race/runCourseAgain.ts`'s `useRunCourseAgain` hook
(used by `RaceDay.tsx:363`, `RacePlanner.tsx:440`, `NutritionPlan.tsx:337`)
dropped `result.warnings` on its own success path exactly the way the
switcher's hand-rolled copy did before this round's finding-1 fix, and
`RunCourseAgainState` had no field to expose it through even if a caller
wanted to read it.

**Fix.** Added `warnings: string[]` to `RunCourseAgainState`, populated on
the success path alongside `done`. `App.tsx`'s switcher row (already fixed
separately, see Finding 1 above) now joins all warnings with `" · "`
(matching `AddTuneUp.tsx`'s own pattern) instead of showing only the first,
for consistency. `RaceDay.tsx`, `RacePlanner.tsx`, `NutritionPlan.tsx` each
get a small `⚠ {warnings.join(" · ")}` note next to their existing
`courseBuild.error` line.

**A real complication I did not paper over.** I instrumented the hook and
`RacePlanner`'s render directly (temporary `console.log`s, removed before
committing) rather than assuming the fix worked, and found: `App.tsx` wraps
the RACE and FUEL tabpanels in `<div key={`race-${key}`}>` /
`<div key={`fuel-${key}`}>`, where `key` is the SAME refresh pulse
`courseBuild`'s own `onDone()` (= `reload()`) bumps. App.tsx's own comment
confirms this is deliberate ("each view already unmounts/remounts its own
subtree via `key`"). The practical effect: the instant a build-with-warnings
succeeds on the RACE or FUEL tab, the whole subtree — including the hook
holding `warnings` — remounts fresh (`warnings` back to `[]`) in the very
next render, before the note the code adds ever paints. This is not new
breakage — the pre-existing `done` field suffered the identical fate, which
is presumably why no consumer ever read it. I did not try to route around
this (e.g. with cross-remount localStorage persistence) since it wasn't
asked for and touches App.tsx's tab-remount design, outside this lane —
flagging it here instead.

`RaceDay.tsx` (`#/race-day`) is NOT affected: `RaceDayRoute` mounts
`RacePlanProvider` directly with no such wrapping key, so its copy of the
note reaches the screen reliably — confirmed with a real, deterministic
Playwright test (route-delayed `/course.json`, no flakiness).

**Files.** `web/src/race/runCourseAgain.ts`, `web/src/App.tsx` (join fix
only), `web/src/race/RaceDay.tsx`; render-only additions at the exact
call-site lines in `web/src/race/RacePlanner.tsx` and
`web/src/race/NutritionPlan.tsx` (per the fixer who owns the rest of those
files).

**How a verifier triggers the guard.** `web/tests/switcher.spec.ts`, three
new tests: (1) the switcher's own mismatched-build case now asserts the ⚠
hint joins the (single, in this fixture) warning; (2) the RACE tab test
clicks "run course build" on a mismatched, never-built race and asserts the
real, *surviving* outcome — RacePlanner's own persisted `unresolved`-driven
mismatch banner, re-derived off the reloaded race.json — rather than the
hook's note, which the finding above explains cannot survive there; (3) the
RaceDay test asserts the hook's own note directly, on the one call site
where it actually can, using a `page.route` delay on `/course.json` to
create a reliable observation window (not a flaky timing race — the delay
only has to outlast the deterministic build+reload round trip, confirmed
independently to take single-digit milliseconds against the local temp
server).

### Finding 5 (HIGH, r3-sweep-b.md, RaceIntake.tsx:284-315 `run()` / 793-810 `runStageAgain()`)

**Root cause.** Both the new-race wizard's `run()` and the review screen's
own per-stage "run again" buttons (`runStageAgain()`) called `runStage(...)`
for the build/plan stages and never inspected the resolved `warnings` array
— only `dialogChrome.ts`'s `runStage()` rejecting on `ok !== true` was ever
handled. A stage that succeeds with real degradation (e.g.
`race-plan.mjs:1079`'s "no fitness snapshot … the block's ramp is
unanchored") returned cleanly and was dropped. The only transient trace was
`stageLine`, a one-line SSE readout overwritten by the next log line, a
later stage switch, or (for `run()`) the hand-off to the review screen —
never a persistent surface, unlike `AddTuneUp.tsx`'s already-fixed
`created.build?.ok && created.build.warnings?.length` → `setBuildWarning`
pattern this was copied from but never carried the fix into.

**Fix.** `run()` now collects each stage's `warnings` (joined per stage)
into a new `stageWarnings` array and hands it to `<ReviewScreen>` as an
`initialStageWarnings` seed prop (only relevant the one time `run()`
actually executes before the screen switches — a draft opened directly via
"Review…" passes nothing, correctly). `ReviewScreen`'s own `runStageAgain()`
now captures `runStage`'s resolved result and replaces (not appends) that
stage's own entry in the same `stageWarnings` state — a clean re-run clears
a stale warning rather than leaving it to look current. Both render in a
new persistent block (see Finding 6 below — same block).

**Files.** `web/src/race/RaceIntake.tsx` only.

**How a verifier triggers the guard.** `web/tests/review.spec.ts`, new test
"a stage re-run's warnings land in a persistent banner, not just the
transient run sheet": opens DRAFT's review screen, clicks "course" (no
`course.gpx`/`links.gpx` on this fixture), and asserts the exact
`race-build.mjs` reason ("no course.gpx in the folder and no http(s)
links.gpx to fetch one from") is visible in the banner. Confirmed this
reproduction path writes nothing to the folder (matches
`race-build.test.mjs`'s own "no course.gpx and no links.gpx: unresolved,
not a failure"), so it cannot disturb the `unresolved` counts the tests
around it in the same serial file depend on.

### Finding 6 (MEDIUM, r3-sweep-b.md / r3-sweep.md, scripts/race-intake.mjs:909, no web/src consumer)

**Root cause.** `race.intake_warnings` — a real, durably-recorded
degradation from stage 1 (e.g. "no PDF renderer on this machine — the PDF
is passed as text only"), written by `scripts/race-intake.mjs` and diffed
through every re-intake merge (`scripts/race-merge.test.mjs`) — had no
reader anywhere in `web/src` (`grep -rn "intake_warnings" web/src` returned
nothing) and wasn't even in the `RaceConfig` TypeScript type.

**Fix.** Added `intake_warnings?: string[]` to `RaceConfig`
(`web/src/race/types.ts`) and rendered it in the same persistent block
Finding 5 adds, ahead of the session-only `stageWarnings` entries (this one
survives a reload; those don't).

**Files.** `web/src/race/types.ts`, `web/src/race/RaceIntake.tsx`.
`races/_fixtures/unresolved-draft-50k/race.json` now carries one
(`intake_warnings` was absent from every committed fixture in the suite,
confirmed by grep before adding it — matches your note "unresolved-draft-50k
may already; otherwise add the field").

**How a verifier triggers the guard.** `web/tests/review.spec.ts`, new test
"a durable intake warning (race.intake_warnings) is shown on the review
screen": opens DRAFT's review screen and asserts the fixture's
`intake_warnings` text is visible. Re-ran `review.spec.ts`, `a11y.spec.ts`,
and `switcher.spec.ts` (everything touching this fixture) after the edit —
all still pass; the addition doesn't change DRAFT's `unresolved` count
(that field is orthogonal to `intake_warnings`) or trip any accessibility
check.

## Gate results (from `web/`, all green — current, after both rounds)

```
npx tsc -b       → clean, no output
npm run build    → tsc -b && eslint . && vite build — clean
npm test         → tests 865, pass 864, fail 0, skipped 1 (pre-existing skip)
npm run test:ui  → 67 passed (was 58 before round 1's fixes; 62 after round 1;
                    67 after this addendum's 5 new tests)
```
