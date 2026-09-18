// scripts/coach.mjs is a script that spawns a PAID headless session. These
// tests cover the contract that makes it safe to import: importing it runs
// nothing, and the model it would spawn on is the shared one the chat
// endpoint uses. The prompt assembly it used to own now lives in
// scripts/coach-prompt.mjs and is tested there.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_DEFAULT } from "./coach.mjs";
import { COACH_MODEL } from "./coach-prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("importing coach.mjs spawns nothing and pins the shared model", () => {
  // reaching this line at all is the assertion: main() is guarded by the
  // argv[1] check, so an import can never start a session
  assert.equal(MODEL_DEFAULT, COACH_MODEL);
});

test("the prompts can be reviewed without paying for a session", async () => {
  const src = await fs.readFile(path.join(ROOT, "scripts", "coach.mjs"), "utf8");
  // both dry-run flags, and the early return that keeps either from spawning
  assert.match(src, /arg\("print-prompt", null\)/);
  assert.match(src, /arg\("print-chat-prompt", null\)/);
  assert.match(src, /if \(PRINT_PROMPT \|\| PRINT_CHAT_PROMPT\) return;/);
  // the prompts themselves are no longer written here
  assert.doesNotMatch(src, /SYSTEM_PROMPT_TEMPLATE/);
  assert.match(src, /from "\.\/coach-prompt\.mjs"/);
});
