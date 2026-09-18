// race.json `visual` — validation and accent derivation.
//
// Companion to theme-presets.test.mjs: that file proves the five palettes are
// readable, this one proves a RACE cannot break them. Everything under test is
// pure, so there is no DOM and no server here — the .ts sources are imported
// directly and node strips the types (node >= 22.18; see the note at the top
// of theme-presets.test.mjs).

import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCENT_MIN_CONTRAST,
  DEFAULT_PRESET,
  HERO_EXTENSIONS,
  deriveAccent,
  isHexColor,
  isSafeAssetName,
  isThemePreset,
  resolveVisual,
  visualErrors,
} from "../web/src/themes/visual.ts";
import {
  BASECAMP_DEFAULT,
  THEME_PRESET_NAMES,
  resolveTheme,
} from "../web/src/themes/presets.ts";
import { contrastRatio, contrastRounded } from "../web/src/themes/contrast.ts";

/* ------------------------------ validation ------------------------------ */

test("an absent or empty visual block is valid", () => {
  assert.deepEqual(visualErrors(undefined), []);
  assert.deepEqual(visualErrors(null), []);
  assert.deepEqual(visualErrors({}), []);
});

test("a visual block that is not an object is refused", () => {
  assert.equal(visualErrors("desert").length, 1);
  assert.equal(visualErrors([]).length, 1);
  assert.equal(visualErrors(7).length, 1);
});

test("every preset name is accepted; anything else is not", () => {
  for (const name of THEME_PRESET_NAMES) {
    assert.deepEqual(visualErrors({ theme_preset: name }), [], `preset ${name} should validate`);
  }
  for (const bad of ["neon", "DESERT", "", null, 3, "basecamp"]) {
    const errs = visualErrors({ theme_preset: bad });
    assert.equal(errs.length, 1, `preset ${JSON.stringify(bad)} should be refused`);
    assert.match(errs[0], /theme_preset/);
  }
});

test("accent must be a hex color", () => {
  assert.deepEqual(visualErrors({ accent: "#e58045" }), []);
  assert.deepEqual(visualErrors({ accent: "#fb5" }), []);
  assert.deepEqual(visualErrors({ accent: "e58045" }), []);
  for (const bad of ["rgb(1,2,3)", "orange", "#12345", "#gggggg", 16, null]) {
    const errs = visualErrors({ accent: bad });
    assert.ok(errs.length >= 1, `accent ${JSON.stringify(bad)} should be refused`);
    assert.match(errs[0], /accent/);
  }
});

test("an accent too dark to see on the field is refused", () => {
  const errs = visualErrors({ accent: "#101010" });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /needs 3:1/);
  // ...and the same accent passes on a field it can actually be seen on
  assert.deepEqual(visualErrors({ accent: "#101010", overrides: { "--night": "#ffffff" } }), []);
});

test("overrides may only name real theme tokens, with real colors", () => {
  assert.deepEqual(visualErrors({ overrides: { "--panel": "#191310" } }), []);
  // fonts are strings, not colors
  assert.deepEqual(visualErrors({ overrides: { "--font-body": '"Archivo", sans-serif' } }), []);
  // --lamp-glow is the one token that is a wash
  assert.deepEqual(visualErrors({ overrides: { "--lamp-glow": "rgba(229, 128, 69, 0.14)" } }), []);

  assert.match(visualErrors({ overrides: { "--nope": "#fff" } })[0], /not a theme token/);
  assert.match(visualErrors({ overrides: { background: "#fff" } })[0], /not a theme token/);
  assert.match(visualErrors({ overrides: { "--panel": "rebeccapurple" } })[0], /hex color/);
  assert.match(visualErrors({ overrides: { "--panel": "" } })[0], /non-empty/);
  assert.match(visualErrors({ overrides: { "--panel": 3 } })[0], /non-empty/);
  assert.match(visualErrors({ overrides: "dark" })[0], /must be an object/);
});

test("panels must be booleans", () => {
  assert.deepEqual(visualErrors({ panels: { crew_sheet: true, model_check: false } }), []);
  assert.match(visualErrors({ panels: { crew_sheet: "yes" } })[0], /true or false/);
  assert.match(visualErrors({ panels: [] })[0], /must be an object/);
});

test("hero must be a plain filename with a servable extension", () => {
  for (const ext of HERO_EXTENSIONS) {
    assert.deepEqual(visualErrors({ hero: `hero${ext}` }), [], `hero${ext} should validate`);
  }
  for (const bad of [
    "../../etc/passwd",
    "../hero.jpg",
    "sub/hero.jpg",
    "/etc/passwd",
    "..%2fhero.jpg",
    ".hidden.jpg",
    "hero.gif",
    "hero",
    "hero.jpg\0.txt",
    "",
    42,
  ]) {
    const errs = visualErrors({ hero: bad });
    assert.ok(errs.length >= 1, `hero ${JSON.stringify(bad)} should be refused`);
    assert.match(errs[0], /hero/);
  }
});

test("every error in a broken block is reported, not just the first", () => {
  const errs = visualErrors({ theme_preset: "neon", accent: "orange", hero: "../x.jpg" });
  assert.equal(errs.length, 3);
});

test("the MM100 folder's visual block validates", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const race = JSON.parse(
    readFileSync(fileURLToPath(new URL("../races/mogollon-monster-100-2026/race.json", import.meta.url)), "utf8"),
  );
  assert.deepEqual(visualErrors(race.visual), []);
  assert.equal(resolveVisual(race.visual).preset, "desert");
});

/* ------------------------------ predicates ------------------------------ */

test("the exported predicates agree with the validator", () => {
  assert.equal(isThemePreset("desert"), true);
  assert.equal(isThemePreset("neon"), false);
  assert.equal(isHexColor("#abc"), true);
  assert.equal(isHexColor("#abcd"), false);
  assert.equal(isSafeAssetName("hero.webp"), true);
  assert.equal(isSafeAssetName("../hero.webp"), false);
});

/* ------------------------------ resolution ------------------------------ */

test("no visual block resolves to the house palette", () => {
  const { preset, tokens } = resolveVisual(undefined);
  assert.equal(preset, DEFAULT_PRESET);
  assert.deepEqual(tokens, BASECAMP_DEFAULT);
});

test("an unknown preset falls back rather than throwing", () => {
  const { preset, tokens } = resolveVisual({ theme_preset: "neon" });
  assert.equal(preset, DEFAULT_PRESET);
  assert.deepEqual(tokens, BASECAMP_DEFAULT);
});

test("resolution layers preset, then accent, then overrides", () => {
  const { tokens } = resolveVisual({
    theme_preset: "desert",
    accent: "#3366cc",
    overrides: { "--panel": "#000102", "--lamp-deep": "#ffffff", "--bogus": "#fff" },
  });
  // the preset supplies what nothing else touches
  assert.equal(tokens["--night"], resolveTheme("desert")["--night"]);
  // the accent replaces the preset's whole lamp family
  assert.equal(tokens["--lamp"], "#3366cc");
  assert.equal(tokens["--lamp-glow"], "rgba(51, 102, 204, 0.14)");
  // ...except where an explicit override is more specific still
  assert.equal(tokens["--lamp-deep"], "#ffffff");
  assert.equal(tokens["--panel"], "#000102");
  // an unknown token never reaches the token map
  assert.equal("--bogus" in tokens, false);
});

test("resolution never changes the typefaces", () => {
  const { tokens } = resolveVisual({ theme_preset: "night", accent: "#7fd3f0" });
  for (const font of ["--font-display", "--font-body", "--font-mono"]) {
    assert.equal(tokens[font], BASECAMP_DEFAULT[font]);
  }
});

/* --------------------------- accent derivation --------------------------- */

test("deriveAccent returns the whole lamp family from one hex", () => {
  const fam = deriveAccent("#e58045");
  assert.deepEqual(Object.keys(fam).sort(), ["--lamp", "--lamp-deep", "--lamp-glow"]);
  assert.equal(fam["--lamp"], "#e58045");
  assert.equal(fam["--lamp-glow"], "rgba(229, 128, 69, 0.14)");
  assert.match(fam["--lamp-deep"], /^#[0-9a-f]{6}$/);
});

test("deriveAccent normalizes short and unprefixed hex", () => {
  assert.equal(deriveAccent("fb5")["--lamp"], "#ffbb55");
  assert.equal(deriveAccent("#FFBB55")["--lamp"], "#ffbb55");
});

test("the deepened accent is darker than the accent, and not black", () => {
  for (const accent of ["#ffb454", "#e58045", "#7fd3f0", "#a9cf6b", "#dfe8f0", "#ffffff"]) {
    const { "--lamp": lamp, "--lamp-deep": deep } = deriveAccent(accent);
    assert.ok(
      contrastRatio(deep, "#000000") < contrastRatio(lamp, "#000000"),
      `${accent}: deep ${deep} should be darker than ${lamp}`,
    );
    assert.ok(contrastRatio(deep, "#000000") > 1.5, `${accent}: deep ${deep} collapsed to black`);
  }
});

test("a grey accent derives a grey, not a hue", () => {
  const { "--lamp-deep": deep } = deriveAccent("#808080");
  assert.match(deep, /^#([0-9a-f]{2})\1\1$/);
});

for (const name of THEME_PRESET_NAMES) {
  test(`${name}: a derived accent clears the contrast floor`, () => {
    const preset = resolveTheme(name);
    // Treat the preset's own accent as if a race had supplied it bare, then
    // check the family we build from it — the whole point of derivation is
    // that one hex is enough, which is only true if what we derive is legible.
    const fam = deriveAccent(preset["--lamp"]);
    for (const bg of ["--night", "--panel"]) {
      for (const token of ["--lamp", "--lamp-deep"]) {
        const ratio = contrastRatio(fam[token], preset[bg]);
        assert.ok(
          ratio >= ACCENT_MIN_CONTRAST,
          `${name}: derived ${token} (${fam[token]}) on ${bg} (${preset[bg]}) is ` +
            `${contrastRounded(fam[token], preset[bg])}:1, need ${ACCENT_MIN_CONTRAST}:1`,
        );
      }
    }
  });
}

test("every preset's own accent would pass validation as a race accent", () => {
  for (const name of THEME_PRESET_NAMES) {
    const preset = resolveTheme(name);
    assert.deepEqual(
      visualErrors({ theme_preset: name, accent: preset["--lamp"] }),
      [],
      `${name}'s own accent should be a legal race accent`,
    );
  }
});

/* ------------------------------ write path ------------------------------ */

test("validateRaceJson refuses a race.json whose visual block is wrong", async () => {
  const { validateRaceJson } = await import("./race-config.mjs");
  const base = {
    schema_version: 1,
    slug: "san-juan-softie-100-2027",
    status: "draft",
    name: "San Juan Softie 100",
    short: "SJS100",
    date: "2027-08-13",
    start_time: "06:00",
    timezone: "America/Denver",
    distance_mi: 104,
    gain_ft: 19000,
    cutoff_h: 38,
    aid_stations: [{ name: "Finish", total_mi: 104, cutoff_h: 38, crew: true, drop_bag: false, menu: "full" }],
  };

  assert.equal(validateRaceJson({ ...base, visual: { theme_preset: "alpine", accent: "#4b7f9e" } }).ok, true);

  for (const [visual, needle] of [
    [{ theme_preset: "neon" }, /theme_preset/],
    [{ accent: "chartreuse" }, /accent/],
    [{ hero: "../../etc/passwd" }, /hero/],
    [{ overrides: { "--nope": "#fff" } }, /not a theme token/],
  ]) {
    const res = validateRaceJson({ ...base, visual });
    assert.equal(res.ok, false, `${JSON.stringify(visual)} should be refused`);
    assert.ok(res.errors.some((e) => needle.test(e)), `expected ${needle} in ${JSON.stringify(res.errors)}`);
  }
});
