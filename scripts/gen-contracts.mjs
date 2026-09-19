// Writes web/src/contracts.ts from scripts/contracts.mjs.
//
// The client and the dev API cannot import a .mjs file (see the header of
// contracts.mjs), so the shared tables are projected into TypeScript instead
// of being retyped by hand. Everything here is mechanical: the values come
// from the module, the `as const` and the derived string-union types come
// from the manifest below, and nothing is edited on the way through.
//
//   npm run contracts        # from web/, or: node scripts/gen-contracts.mjs
//
// It also runs from the `predev`, `prebuild` and `pretest` hooks in
// web/package.json, so a stale generated file cannot survive a dev server
// start, a build or a test run. The output IS committed (a fresh checkout
// must typecheck before anyone runs a script), and scripts/contracts.test.mjs
// fails if the committed copy does not match what this generator produces.
//
// `--check` exits non-zero instead of writing — the same comparison the test
// makes, for a pre-commit hook or CI that wants it without node:test.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as contracts from "./contracts.mjs";

export const CONTRACTS_TS_PATH = fileURLToPath(
  new URL("../web/src/contracts.ts", import.meta.url),
);

/** One entry per export, in the order they should appear.
 *  `union` derives `export type <union> = (typeof NAME)[number]` from an
 *  array; `alias` emits a raw extra type line. `doc` is the one-line
 *  reminder in the generated file — the full rationale stays in
 *  contracts.mjs, which is where anyone changing a table has to look. */
const MANIFEST = [
  {
    name: "GOAL_PHASES",
    union: "GoalPhase",
    doc: "PRD §5.3 — the generic-mode training phases, recovery → holding pattern.",
  },
  {
    name: "DEFAULT_BODY_KG",
    doc: "Impersonal fallback body mass, kg — announced when it is substituted.",
  },
  {
    name: "DEFAULT_LONG_RUN_REF_MI",
    doc: "Fallback long-run reference distance, mi (pacing's old D_REF).",
  },
  {
    name: "PHYSIOLOGY_FIELDS",
    alias: "export type PhysiologyKey = keyof typeof PHYSIOLOGY_FIELDS;",
    doc: "PRD §5.4 — the editable physiology fields and the bounds every writer enforces.",
  },
  {
    name: "PHYSIOLOGY_KEYS",
    doc: "PHYSIOLOGY_FIELDS' keys, in dialog order.",
  },
  {
    name: "DEFAULT_ACCLIMATION_DAYS",
    doc: "Days at altitude assumed when nobody has said otherwise — the night before.",
  },
  {
    name: "RACE_STATUSES",
    union: "RaceStatus",
    doc: "races/<slug>/race.json `status`; at most one folder is \"active\".",
  },
  {
    name: "PROVENANCE_BY",
    union: "ProvenanceBy",
    doc: "Who last set a field — only \"user\" is protected from a re-intake merge.",
  },
  {
    name: "EDITABLE_RACE_KEYS",
    union: "EditableRaceKey",
    doc: "Top-level keys PUT /api/races/:slug accepts; anything else is refused by name.",
  },
  {
    name: "UNFILLABLE_ROOTS",
    union: "UnfillableRoot",
    doc: "Roots `unresolved_fills` will never write, whatever the folder declares.",
  },
];

const HEADER = `// GENERATED FILE — DO NOT EDIT.
//
// Written by scripts/gen-contracts.mjs from scripts/contracts.mjs, which is
// the single source for every table below and carries the reasoning for each
// one. Edit it there and run \`npm run contracts\` (the predev/prebuild/pretest
// hooks in web/package.json run it too); scripts/contracts.test.mjs fails if
// this file and that module disagree.
//
// It exists because neither the client bundle nor web/vite.config.ts can
// import a .mjs file, and hand-copied tables drift silently.
`;

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Render the value as a TypeScript literal. JSON.stringify does the work;
    identifier-safe object keys are then unquoted so the generated file reads
    like hand-written source rather than a pasted JSON blob. */
function literal(value) {
  return JSON.stringify(value, null, 2).replace(
    /^(\s*)"([^"\\]+)":/gm,
    (whole, indent, key) => (IDENT.test(key) ? `${indent}${key}:` : whole),
  );
}

/** The exact contents web/src/contracts.ts should have. */
export function renderContracts() {
  const blocks = MANIFEST.map(({ name, doc, union, alias }) => {
    if (!(name in contracts)) {
      throw new Error(`scripts/contracts.mjs does not export ${name}`);
    }
    const value = contracts[name];
    // `as const` only where it buys something: it turns a table into literal
    // types the client can derive unions and `keyof` from. On a bare number
    // it would be noise.
    const suffix = value !== null && typeof value === "object" ? " as const" : "";
    const lines = [`/** ${doc} */`, `export const ${name} = ${literal(value)}${suffix};`];
    if (union) lines.push(`export type ${union} = (typeof ${name})[number];`);
    if (alias) lines.push(alias);
    return lines.join("\n");
  });
  // Nothing in contracts.mjs may be forgotten here: a table added to the
  // source but not to the manifest would reach neither the client nor the
  // dev API, which is the failure this whole module exists to prevent.
  const missing = Object.keys(contracts).filter((k) => !MANIFEST.some((e) => e.name === k));
  if (missing.length > 0) {
    throw new Error(
      `scripts/gen-contracts.mjs MANIFEST is missing ${missing.join(", ")} — ` +
        "add an entry (with its one-line doc) so the client gets the table too",
    );
  }
  return `${HEADER}\n${blocks.join("\n\n")}\n`;
}

async function main() {
  const want = renderContracts();
  const rel = path.relative(process.cwd(), CONTRACTS_TS_PATH);
  if (process.argv.includes("--check")) {
    const have = await fs.readFile(CONTRACTS_TS_PATH, "utf8").catch(() => null);
    if (have === want) {
      console.log(`✓ ${rel} is up to date`);
      return;
    }
    console.error(`✗ ${rel} is stale — run \`npm run contracts\``);
    process.exitCode = 1;
    return;
  }
  const have = await fs.readFile(CONTRACTS_TS_PATH, "utf8").catch(() => null);
  if (have === want) return; // no write, no mtime churn, no vite reload storm
  await fs.writeFile(CONTRACTS_TS_PATH, want);
  console.log(`✓ wrote ${rel}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
