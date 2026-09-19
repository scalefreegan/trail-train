#!/usr/bin/env bash
# Creates the "Modular races" epic + 19 child beads (docs/beads/*.md) with dependencies.
# Prerequisite: the beads DB must have its issue prefix set (it did not on 2026-09-18:
# `bd create` failed with "database not initialized: issue_prefix config is missing";
# `bd doctor` suggests `bd init --prefix tt` is safe to re-run on the empty DB).
set -euo pipefail
cd "$(dirname "$0")/../.."
D=docs/beads
EPIC=$(bd create --silent --title="Modular races: race folders, generic mode, agentic intake" --type=epic --priority=1 --labels=modular-races --body-file=$D/epic.md); echo "EPIC=$EPIC"
mk(){ bd create --silent --parent="$EPIC" --type="$3" --priority="$4" --labels="modular-races,$5" --title="$2" --body-file=$D/$1.md; }
B01=$(mk 01 "Race folder schema, loader, active pointer, /api/race/active" task 1 phase-1)
B02=$(mk 02 "Migrate MM100 to races/mogollon-monster-100-2026 and split state.json to v3" task 1 phase-1)
B03=$(mk 03 "config/goals.json and race-optional facts/coach (rolling window)" task 1 phase-1)
B04=$(mk 04 "Generic-mode rendering: gate race UI, rolling trajectory, drop client defaults" task 1 phase-1)
B05=$(mk 05 "Remove race literals; build-course per race folder; serve course from the folder" task 1 phase-1)
B06=$(mk 06 "Race-local clocks: IANA timezone, computed sun, weekday-derived race week, per-slug knobs" task 1 phase-1)
B07=$(mk 07 "Race switcher menu in the command bar + /api/races and /api/race/activate" feature 2 phase-2)
B08=$(mk 08 "Feature/panel gating of race and nutrition views; altitude caveat" task 2 phase-2)
B09=$(mk 09 "Athlete physiology and long-run patterns into profile.json; drop race_base" task 2 phase-2)
B10=$(mk 10 "Coach prompt assembled from race config; shared prompt module; course structure and history in facts" task 2 phase-2)
B11=$(mk 11 "Intake stage 1: /api/race-intake endpoint, source caching, PDF page images, agent draft" feature 2 phase-3)
B12=$(mk 12 "Intake stage 2: validation, GPX aid-station matcher, per-folder course build" task 2 phase-3)
B13=$(mk 13 "Intake stage 3: block targets, nutrition, coach_notes, theme suggestion" task 2 phase-3)
B14=$(mk 14 "New Race dialog: run intake, review screen, draft/activate" feature 2 phase-3)
B15=$(mk 15 "Re-intake with provenance-aware merge and diff review" feature 3 phase-3)
B16=$(mk 16 "Per-race visuals: theme presets, overrides, accent, hero" feature 3 phase-4)
B17=$(mk 17 "Results capture from Strava track + archived race view; backfill MM100" feature 3 phase-4)
B18=$(mk 18 "Phone race-day mode" feature 3 phase-4)
B19=$(mk 19 "Regression harness: MM100 re-derivation, Softie 2027 intake check, literal grep gate" task 3 phase-4)
dep(){ bd dep "$1" --blocks "$2" >/dev/null; }
dep $B01 $B02; dep $B01 $B03; dep $B02 $B03; dep $B01 $B05; dep $B02 $B05; dep $B01 $B06
dep $B03 $B04; dep $B02 $B04
dep $B04 $B07; dep $B01 $B08; dep $B02 $B09; dep $B03 $B10; dep $B06 $B10
dep $B01 $B11; dep $B11 $B12; dep $B05 $B12; dep $B06 $B12; dep $B12 $B13; dep $B09 $B13
dep $B13 $B14; dep $B07 $B14; dep $B14 $B15
dep $B07 $B16; dep $B07 $B17; dep $B02 $B17; dep $B06 $B18; dep $B08 $B18
dep $B15 $B19; dep $B17 $B19
bd dep cycles && bd list
