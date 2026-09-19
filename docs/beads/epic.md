## What
Turn Basecamp from a single-race (Mogollon Monster 100) dashboard into a race-pluggable training app: a race is a folder of config under races/<slug>/ produced by an agentic intake, exactly one race is active at a time, and with none active the app runs in a generic mode driven by config/goals.json. Completed races are archived with results.

## Why
The next A-race is the San Juan Softie 100 (Aug 2027). Every race so far has meant editing four duplicated constant blocks and two literal prompt sentences. The athlete is currently in post-race recovery with no race active, which today the app cannot represent.

## Source of truth
docs/PRD-modular-races.md — read it before any child bead. Section numbers in child beads refer to it.

## Phases (labels)
phase-1 schema, migration, generic mode · phase-2 switcher and config-driven views · phase-3 intake · phase-4 visuals, results, race-day mode.
