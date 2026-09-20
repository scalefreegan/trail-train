#!/usr/bin/env bash
set -euo pipefail; cd "$(dirname "$0")/../.."; D=docs/beads-v2
EPIC=$(bd create --silent --title="Basecamp v2: altitude, tune-ups, live race day, crew export, chat context, UI tests, cleanup" --type=epic --priority=1 --labels=v2 --body-file=$D/00.md); echo "EPIC=$EPIC"
mk(){ bd create --silent --parent="$EPIC" --type="$3" --priority="$4" --labels="v2,$5" --title="$2" --body-file=$D/$1.md; }
B01=$(mk 01 "Altitude pacing term: model, projection, slider, model check" feature 1 w1)
B02=$(mk 02 "Acclimation inputs (home elevation, calendar arrival) + altitude calibration" feature 2 w2)
B03=$(mk 03 "B-race schema, quick-create endpoint, payload/facts/coach" feature 1 w1)
B04=$(mk 04 "B-race UI: switcher group, add-tune-up form, trajectory marker, reduced planner" feature 2 w2)
B05=$(mk 05 "Tracker adapters (MAProgress, OpenSplitTime) + on-demand endpoint" feature 1 w1)
B06=$(mk 06 "Race-day live hold from tracker + manual checkpoint entry" feature 2 w2)
B07=$(mk 07 "Static crew export pipeline: second Vite entry, self-contained HTML, endpoint, button" feature 2 w2)
B08=$(mk 08 "Crew export content: ETAs, directions, pickups, SVG map/profile, checkpoint updater, print" feature 2 w3)
B09=$(mk 09 "Coach chat gets race state (projection, fuel, status, checkpoint)" feature 2 w2)
B10=$(mk 10 "Frontend test harness: Playwright config, synthetic fixtures, TRAIL_PROJECT_ROOT, TRAIL_FAKE_AGENT, 4 core flows" task 1 w1)
B11=$(mk 11 "Remaining UI flows + check:races gate" task 2 w2)
B12=$(mk 12 "Cleanup: shared contracts module, stale TODOs, engines" task 1 w1)
B13=$(mk 13 "v2 harness, README, PRD status" task 3 w3)
dep(){ bd dep "$1" --blocks "$2" >/dev/null; }
dep $B01 $B02; dep $B03 $B04; dep $B05 $B06; dep $B06 $B08; dep $B07 $B08; dep $B10 $B11
for b in $B02 $B04 $B06 $B08 $B09 $B11; do dep $B12 $b; done
for b in $B02 $B04 $B06 $B07 $B08 $B09 $B11 $B12; do dep $b $B13; done
bd dep cycles && bd list
