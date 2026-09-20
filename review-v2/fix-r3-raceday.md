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

## Gate results (from `web/`, all green)

```
npx tsc -b                → clean, no output
npm run build              → tsc -b && eslint . && vite build — clean
npm test                   → tests 865, pass 864, fail 0, skipped 1 (pre-existing skip)
npm run test:ui             → 62 passed (was 58 before this round's 4 new tests)
```
