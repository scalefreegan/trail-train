// Theme preset tests.
//
// Two jobs:
//   1. basecamp-default must stay byte-identical to `:root` in index.css.
//      The CSS is parsed with a regex rather than imported, so editing one
//      side and not the other fails here instead of drifting silently.
//   2. Every preset must stay readable — WCAG contrast on body, muted and
//      accent tokens, against both the page field and a raised panel
//      (text mostly sits on panels, which are lighter, so that is the
//      tighter of the two checks).
//
// The .ts sources are imported directly: Node strips the types (node >= 22.18,
// and the tsconfig sets erasableSyntaxOnly so nothing here needs a transform).
// No build step, so the test reads exactly what the app ships.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  BASECAMP_DEFAULT,
  THEME_PRESET_NAMES,
  THEME_PRESETS,
  resolveTheme,
} from "../web/src/themes/presets.ts";
import { contrastRatio, contrastRounded, parseHex } from "../web/src/themes/contrast.ts";

const CSS_PATH = fileURLToPath(new URL("../web/src/index.css", import.meta.url));

/** The custom properties declared in the first `:root { … }` block. */
function parseRootTokens(css) {
  const block = /:root\s*\{([^}]*)\}/.exec(css);
  assert.ok(block, "index.css has no :root block");
  const tokens = {};
  const decl = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = decl.exec(block[1])) !== null) tokens[m[1]] = m[2].trim();
  return tokens;
}

const ROOT_TOKENS = parseRootTokens(readFileSync(CSS_PATH, "utf8"));

test("index.css :root parses into a non-trivial token map", () => {
  assert.ok(
    Object.keys(ROOT_TOKENS).length >= 15,
    `only parsed ${Object.keys(ROOT_TOKENS).length} tokens from :root`,
  );
});

test("basecamp-default matches :root in index.css exactly", () => {
  assert.deepEqual(
    Object.keys(BASECAMP_DEFAULT).sort(),
    Object.keys(ROOT_TOKENS).sort(),
    "token names drifted between presets.ts and index.css",
  );
  for (const [name, value] of Object.entries(ROOT_TOKENS)) {
    assert.equal(
      BASECAMP_DEFAULT[name],
      value,
      `${name}: index.css has "${value}", presets.ts has "${BASECAMP_DEFAULT[name]}"`,
    );
  }
});

test("every preset name resolves and overrides only known tokens", () => {
  assert.deepEqual(
    [...THEME_PRESET_NAMES].sort(),
    Object.keys(THEME_PRESETS).sort(),
  );
  for (const name of THEME_PRESET_NAMES) {
    for (const token of Object.keys(THEME_PRESETS[name])) {
      assert.ok(
        token in BASECAMP_DEFAULT,
        `preset ${name} sets unknown token ${token}`,
      );
    }
  }
});

test("presets keep the Basecamp typefaces", () => {
  for (const name of THEME_PRESET_NAMES) {
    const tokens = resolveTheme(name);
    for (const font of ["--font-display", "--font-body", "--font-mono"]) {
      assert.equal(
        tokens[font],
        BASECAMP_DEFAULT[font],
        `preset ${name} changed ${font} — presets are palette variations, not new brands`,
      );
    }
  }
});

test("presets are dark: the page field stays darker than the text", () => {
  for (const name of THEME_PRESET_NAMES) {
    const tokens = resolveTheme(name);
    const field = parseHex(tokens["--night"]);
    const sum = field.r + field.g + field.b;
    assert.ok(sum < 120, `preset ${name} has a light --night (${tokens["--night"]})`);
  }
});

// contrast floors, checked against the page field and against a raised panel
const FLOORS = [
  { token: "--mist", min: 4.5, what: "body text" },
  { token: "--mist-dim", min: 4.5, what: "secondary text" },
  { token: "--mist-mute", min: 3, what: "muted text" },
  { token: "--lamp", min: 3, what: "accent" },
  { token: "--pine", min: 3, what: "good/ahead" },
  { token: "--ember", min: 3, what: "warn/behind" },
  { token: "--creek", min: 3, what: "informational" },
];

for (const name of THEME_PRESET_NAMES) {
  test(`${name}: contrast floors hold`, () => {
    const tokens = resolveTheme(name);
    for (const bg of ["--night", "--panel"]) {
      for (const { token, min, what } of FLOORS) {
        const ratio = contrastRatio(tokens[token], tokens[bg]);
        assert.ok(
          ratio >= min,
          `${name}: ${what} ${token} (${tokens[token]}) on ${bg} (${tokens[bg]}) ` +
            `is ${contrastRounded(tokens[token], tokens[bg])}:1, need ${min}:1`,
        );
      }
    }
  });
}

test("surfaces stay layered: night < night-deep-or-panel ordering is legible", () => {
  for (const name of THEME_PRESET_NAMES) {
    const t = resolveTheme(name);
    const lum = (token) => parseHex(t[token]).r + parseHex(t[token]).g + parseHex(t[token]).b;
    assert.ok(
      lum("--night-deep") <= lum("--night"),
      `${name}: --night-deep should recede below --night`,
    );
    assert.ok(
      lum("--panel") >= lum("--night"),
      `${name}: --panel should sit above --night`,
    );
    assert.ok(
      lum("--panel-raise") >= lum("--panel"),
      `${name}: --panel-raise should sit above --panel`,
    );
    assert.ok(
      lum("--edge-bright") >= lum("--edge"),
      `${name}: --edge-bright should be brighter than --edge`,
    );
  }
});
