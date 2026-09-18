// The race-optional half of the coach prompt: coachFocus decides whether the
// prompt speaks about a race or about the standing goals. Importing coach.mjs
// must NOT spawn a session — that guard is part of what this file tests.

import test from "node:test";
import assert from "node:assert/strict";
import { coachFocus } from "./coach.mjs";

test("race mode: the prompt keeps its race paragraph and race week", () => {
  const f = coachFocus({
    race: {
      name: "San Juan Softie 100", distance_mi: 104, elevation_ft: 19000,
      date: "2027-08-13", location: "Durango, CO", days_until: 329,
      notes: "High and rocky.", max_elev_ft: 12438,
    },
    block: { mode: "race", total_weeks: 20 },
  });
  assert.match(f.training_for, /training for San Juan Softie 100 \(104 mi, 19,000 ft, 2027-08-13, 329 days out\)/);
  assert.match(f.block_phrase, /planned 20-week training block/);
  assert.match(f.plan_horizon, /race week 20/);
  assert.match(f.shape_line, /race week = wk 20/);
  assert.match(f.course_line, /High and rocky\. Max elevation 12,438 ft\./);
  assert.match(f.user_horizon, /San Juan Softie 100 \(329 days out\)/);
});

test("generic mode: a goals paragraph, a rolling window, no race week", () => {
  const f = coachFocus({
    race: null,
    goals: {
      event_class: "100 mi mountain race",
      horizon: "next A-race ~Aug 2027",
      phase: "return_to_run",
      weekly_volume_band: { dist_mi: [0, 25], vert_ft: [0, 3000] },
      notes: "shin niggle; reassess 2026-09-23",
    },
    block: { mode: "rolling", total_weeks: 12 },
  });
  assert.match(f.training_for, /NO RACE IS ACTIVE/);
  assert.match(f.training_for, /100 mi mountain race \(next A-race ~Aug 2027\)/);
  assert.match(f.training_for, /"return_to_run" phase/);
  assert.match(f.training_for, /0-25 mi and 0-3,000 ft of vert/);
  assert.match(f.training_for, /shin niggle/);
  assert.match(f.block_phrase, /rolling 12-week training window/);
  assert.match(f.wk_comment, /wk 12 is the CURRENT week/);
  assert.match(f.shape_line, /no race week/);
  assert.equal(f.course_line, "", "there is no course to describe");
  assert.match(f.user_horizon, /toward 100 mi mountain race/);
  // never name a file the athlete's race used to live in
  assert.doesNotMatch(f.state_line, /races\//);
});

test("generic mode with no goals file at all still produces a prompt", () => {
  const f = coachFocus({ race: null, block: { mode: "rolling", total_weeks: 12 } });
  assert.match(f.training_for, /no named event/);
  assert.match(f.training_for, /unset mi and unset ft/);
  assert.match(f.shape_line, /phase \(unset\)/);
});
