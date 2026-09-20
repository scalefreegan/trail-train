// The shared-contracts tests.
//
// scripts/contracts.mjs is the one place the tables live; web/src/contracts.ts
// is a generated projection of it for the client and the dev API, and it is
// COMMITTED, because a fresh checkout has to typecheck before anyone runs a
// node script. A committed generated file is only as good as the check that
// it was regenerated, so that is the first test here.
//
// The rest assert that the modules which used to own these tables now hand
// back the very same object — a re-export, not a copy that happens to agree
// today. `assert.equal` (reference identity) rather than `deepEqual` is the
// point: a second literal with identical contents would pass a deep compare
// and is exactly what this module exists to stop.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import * as contracts from "./contracts.mjs";
import { CONTRACTS_TS_PATH, renderContracts } from "./gen-contracts.mjs";
import { GOAL_PHASES } from "./goals.mjs";
import { DEFAULT_BODY_KG, DEFAULT_LONG_RUN_REF_MI, PHYSIOLOGY_FIELDS, PHYSIOLOGY_KEYS } from "./profile.mjs";
import { PROVENANCE_BY, RACE_STATUSES } from "./race-config.mjs";
import { EDITABLE_RACE_KEYS } from "./race-edit.mjs";

test("the committed web/src/contracts.ts matches scripts/contracts.mjs", async () => {
  const committed = await fs.readFile(CONTRACTS_TS_PATH, "utf8");
  assert.equal(
    committed,
    renderContracts(),
    "web/src/contracts.ts is stale — run `npm run contracts` (from web/) and commit the result",
  );
});

test("the generated file is generated, not edited", async () => {
  const committed = await fs.readFile(CONTRACTS_TS_PATH, "utf8");
  assert.match(committed, /^\/\/ GENERATED FILE — DO NOT EDIT\./, "the warning header must survive");
});

test("every table in contracts.mjs reaches the client", () => {
  // renderContracts throws on a table the generator's manifest has not been
  // told about, which is the failure mode that would otherwise leave the
  // client with a silently missing export.
  assert.doesNotThrow(() => renderContracts());
  for (const name of Object.keys(contracts)) {
    assert.match(
      renderContracts(),
      new RegExp(`^export const ${name} = `, "m"),
      `${name} is exported by scripts/contracts.mjs but absent from web/src/contracts.ts`,
    );
  }
});

test("the scripts re-export the contract rather than keeping a copy", () => {
  assert.equal(GOAL_PHASES, contracts.GOAL_PHASES, "goals.mjs");
  assert.equal(PHYSIOLOGY_FIELDS, contracts.PHYSIOLOGY_FIELDS, "profile.mjs");
  assert.equal(PHYSIOLOGY_KEYS, contracts.PHYSIOLOGY_KEYS, "profile.mjs");
  assert.equal(DEFAULT_BODY_KG, contracts.DEFAULT_BODY_KG, "profile.mjs");
  assert.equal(DEFAULT_LONG_RUN_REF_MI, contracts.DEFAULT_LONG_RUN_REF_MI, "profile.mjs");
  assert.equal(RACE_STATUSES, contracts.RACE_STATUSES, "race-config.mjs");
  assert.equal(PROVENANCE_BY, contracts.PROVENANCE_BY, "race-config.mjs");
  assert.equal(EDITABLE_RACE_KEYS, contracts.EDITABLE_RACE_KEYS, "race-edit.mjs");
});

test("the physiology defaults are inside the physiology bounds", () => {
  // The generated DEFAULT_PHYSIOLOGY on the client is built from `dflt`, so a
  // default outside its own band would hand every offline client a value the
  // server would refuse on the way back in.
  for (const [key, spec] of Object.entries(contracts.PHYSIOLOGY_FIELDS)) {
    if (spec.dflt === null) {
      assert.equal(spec.optional, true, `${key}: a null default is only legal on an optional field`);
      continue;
    }
    assert.ok(spec.dflt >= spec.lo && spec.dflt <= spec.hi, `${key}: default ${spec.dflt} is outside [${spec.lo}, ${spec.hi}]`);
    assert.ok(spec.lo < spec.hi, `${key}: bounds are reversed`);
  }
  assert.deepEqual(PHYSIOLOGY_KEYS, Object.keys(contracts.PHYSIOLOGY_FIELDS));
});

test("the grep gates the cleanup bought stay at zero", async () => {
  // Bead tt-cv1b0.12's whole point: no hand-copied table announcing itself
  // with a sync comment, and no TODO pointing at an epic that has merged.
  // Kept as a test rather than a habit, because both grew back once already.
  const ROOT = new URL("..", import.meta.url);
  const files = [];
  for (const dir of ["scripts", "web/src"]) {
    const walk = async (rel) => {
      for (const e of await fs.readdir(new URL(rel, ROOT), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const next = `${rel}/${e.name}`;
        if (e.isDirectory()) await walk(next);
        else if (/\.(mjs|ts|tsx)$/.test(e.name)) files.push(next);
      }
    };
    await walk(dir);
  }
  files.push("web/vite.config.ts");

  const offenders = { sync: [], todo: [] };
  for (const rel of files) {
    if (rel === "scripts/contracts.test.mjs") continue; // this file names both patterns
    const text = await fs.readFile(new URL(rel, ROOT), "utf8");
    if (text.includes("KEEP IN " + "SYNC")) offenders.sync.push(rel);
    if (/TODO\(tt-yib/.test(text)) offenders.todo.push(rel);
  }
  assert.deepEqual(offenders.sync, [], "a table was copied again — put it in scripts/contracts.mjs instead");
  assert.deepEqual(offenders.todo, [], "tt-yib has merged; say what is still missing in prose, without the marker");
});
