/* ------------------------------------------------------------------ */
/*  race.json `visual` — validation, accent derivation, resolution.    */
/*                                                                    */
/*  `presets.ts` knows the five palettes; this file knows what a RACE  */
/*  is allowed to say about them. Three jobs, all pure:                */
/*                                                                    */
/*    visualErrors()  — what is wrong with this `visual` block, in     */
/*                      sentences a person can act on. Nothing writes  */
/*                      a race folder without passing through here.    */
/*    deriveAccent()  — one hex is enough. A race says `accent:        */
/*                      "#e58045"` and gets the whole --lamp family:   */
/*                      the pressed/deepened variant and the wash.     */
/*    resolveVisual() — preset + accent + overrides → the token map    */
/*                      `applyTheme` writes onto :root.                */
/*                                                                    */
/*  No DOM, no React: the intake preview, the theme hook and the       */
/*  node:test suite all import this file directly (node strips the     */
/*  types — see scripts/theme-presets.test.mjs). The two relative       */
/*  imports below carry their `.ts` extension for exactly that reason:  */
/*  node's resolver needs it, and `allowImportingTsExtensions` in       */
/*  tsconfig.app.json means Vite and tsc are happy with it too.         */
/* ------------------------------------------------------------------ */

import {
  BASECAMP_DEFAULT,
  THEME_PRESET_NAMES,
  resolveTheme,
  type ThemePreset,
  type ThemeTokens,
} from "./presets.ts";
import { contrastRatio, contrastRounded, parseHex, type Rgb } from "./contrast.ts";

/** The shape `race.json.visual` carries (RaceVisual in race/types.ts), as
    something this file can validate WITHOUT trusting it to be that type. */
export type VisualInput = {
  theme_preset?: string;
  accent?: string;
  hero?: string;
  panels?: Record<string, boolean>;
  overrides?: Record<string, string>;
};

/** The accent is not one token but three — they must move together or the
    pressed state and the wash keep the old race's hue. */
export const ACCENT_TOKENS = ["--lamp", "--lamp-deep", "--lamp-glow"] as const;

/** Tokens that are fonts, not colors — the only ones not parsed as a color. */
const FONT_TOKENS = ["--font-display", "--font-body", "--font-mono"] as const;

/** The accent must stay visible on the field it sits on: WCAG's floor for
    large text and graphical objects. Below this a race has not themed
    Basecamp, it has hidden it. */
export const ACCENT_MIN_CONTRAST = 3;

/** Hero images: what the dev-server's asset endpoint will serve. Mirrored in
    scripts/race-asset.mjs (which is what actually opens the file); a test
    asserts the two agree on a battery of names. */
export const HERO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"] as const;

const HEX_RE = /^#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** `rgb()`/`rgba()` — the form --lamp-glow takes. */
const RGB_RE = /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_RE.test(value.trim());
}

/**
 * A hero filename that is a NAME and nothing else: no directory, no escape,
 * no hidden file, and an extension we serve. Kept deliberately narrow — the
 * endpoint's safety does not rest on this (it resolves and re-checks the
 * path), but a race whose hero cannot be served should fail at write time.
 */
export function isSafeAssetName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 128) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return false;
  if (name.includes("..")) return false;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return (HERO_EXTENSIONS as readonly string[]).includes(name.slice(dot).toLowerCase());
}

/** The seven tokens that say what a palette IS — field, surface, text, light
    source, and the three signals. The order ThemePreview renders them in, and
    the reason two races can be compared by looking at their strips. Lives
    here rather than beside the component so that file exports only a
    component (react-refresh). */
export const SWATCH_TOKENS = [
  "--night",
  "--panel",
  "--mist",
  "--lamp",
  "--pine",
  "--ember",
  "--creek",
] as const;

/* ----------------------------- accent ---------------------------------- */

type Hsl = { h: number; s: number; l: number };

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return {
    r: Math.round(channel(h + 1 / 3) * 255),
    g: Math.round(channel(h) * 255),
    b: Math.round(channel(h - 1 / 3) * 255),
  };
}

const toHex = ({ r, g, b }: Rgb) =>
  "#" + [r, g, b].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("");

/**
 * How much darker the pressed accent sits. Reverse-engineered from the five
 * hand-built presets, where --lamp-deep is consistently ~0.68 of --lamp's
 * lightness at the same hue (amber #ffb454 → #cc7a1f, sand #e58045 → #a9531f).
 */
export const LAMP_DEEP_LIGHTNESS = 0.68;
/** The wash's alpha — every preset uses 0.14, so a derived one does too. */
export const LAMP_GLOW_ALPHA = 0.14;

/**
 * One accent hex → the whole --lamp family. The deepened variant keeps the
 * hue and saturation and drops the lightness; the glow is the same color at
 * the wash alpha. So a race folder can carry `accent: "#e58045"` and nothing
 * else and still get a coherent light source.
 */
export function deriveAccent(accent: string): Pick<ThemeTokens, (typeof ACCENT_TOKENS)[number]> {
  const rgb = parseHex(accent);
  const hsl = rgbToHsl(rgb);
  const deep = hslToRgb({ ...hsl, l: hsl.l * LAMP_DEEP_LIGHTNESS });
  return {
    "--lamp": toHex(rgb),
    "--lamp-deep": toHex(deep),
    "--lamp-glow": `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${LAMP_GLOW_ALPHA})`,
  };
}

/* ---------------------------- resolution -------------------------------- */

export const DEFAULT_PRESET: ThemePreset = "basecamp-default";

export function isThemePreset(name: unknown): name is ThemePreset {
  return typeof name === "string" && (THEME_PRESET_NAMES as readonly string[]).includes(name);
}

/**
 * The tokens a race actually renders as, most-specific-last: the house
 * palette, the preset, the derived accent family, then the race's own
 * per-token `overrides`. An unknown preset falls back to the house palette
 * rather than throwing — `visualErrors` is where a bad one is refused, and a
 * dashboard that renders unthemed beats one that renders a stack trace.
 */
export function resolveVisual(visual: VisualInput | null | undefined): {
  preset: ThemePreset;
  tokens: ThemeTokens;
} {
  const preset = isThemePreset(visual?.theme_preset) ? visual.theme_preset : DEFAULT_PRESET;
  const accent = isHexColor(visual?.accent) ? deriveAccent(visual.accent) : {};
  const overrides = (visual?.overrides ?? {}) as Partial<ThemeTokens>;
  const known: Partial<ThemeTokens> = {};
  for (const [name, value] of Object.entries(overrides)) {
    if (name in BASECAMP_DEFAULT && typeof value === "string") {
      known[name as keyof ThemeTokens] = value;
    }
  }
  return { preset, tokens: resolveTheme(preset, { ...accent, ...known }) };
}

/* ---------------------------- validation -------------------------------- */

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Everything wrong with a `visual` block, as sentences. An empty array means
 * it is safe to write into a race folder and safe to apply.
 *
 * Deliberately total rather than throw-on-first: the intake dialog shows all
 * of them at once, and a PUT that fixes one problem only to be refused for
 * the next one is a bad afternoon.
 */
export function visualErrors(visual: unknown): string[] {
  const errs: string[] = [];
  if (visual == null) return errs; // no visual block is not an error — it is the house palette
  if (!isPlainObject(visual)) return ["visual must be an object"];

  const { theme_preset, accent, hero, panels, overrides } = visual;

  if (theme_preset !== undefined && !isThemePreset(theme_preset)) {
    errs.push(
      `visual.theme_preset ${JSON.stringify(theme_preset)} is not a preset — expected one of ${THEME_PRESET_NAMES.join(", ")}`,
    );
  }

  if (accent !== undefined && !isHexColor(accent)) {
    errs.push(`visual.accent must be a hex color like "#e58045", got ${JSON.stringify(accent)}`);
  }

  if (hero !== undefined && !isSafeAssetName(hero)) {
    errs.push(
      `visual.hero must be a plain filename inside the race folder ending in ${HERO_EXTENSIONS.join("/")}, got ${JSON.stringify(hero)}`,
    );
  }

  if (panels !== undefined) {
    if (!isPlainObject(panels)) errs.push("visual.panels must be an object of booleans");
    else {
      for (const [key, value] of Object.entries(panels)) {
        if (typeof value !== "boolean") {
          errs.push(`visual.panels.${key} must be true or false, got ${JSON.stringify(value)}`);
        }
      }
    }
  }

  if (overrides !== undefined) {
    if (!isPlainObject(overrides)) errs.push("visual.overrides must be an object of theme tokens");
    else {
      for (const [name, value] of Object.entries(overrides)) {
        if (!(name in BASECAMP_DEFAULT)) {
          errs.push(`visual.overrides.${name} is not a theme token`);
          continue;
        }
        if (typeof value !== "string" || value.trim() === "") {
          errs.push(`visual.overrides.${name} must be a non-empty string, got ${JSON.stringify(value)}`);
          continue;
        }
        if ((FONT_TOKENS as readonly string[]).includes(name)) continue;
        // --lamp-glow is a wash, so it is the one color token that may be rgba()
        // (two separate checks, not one `||`: isHexColor is a type guard, and
        // the else-branch of one narrows `value` to never)
        const hex = isHexColor(value);
        const wash = name === "--lamp-glow" && RGB_RE.test(value.trim());
        if (!hex && !wash) {
          errs.push(`visual.overrides.${name} must be a hex color, got ${JSON.stringify(value)}`);
        }
      }
    }
  }

  // Only worth checking once the parts above parse — otherwise the message is
  // about a color we already said was not a color.
  if (errs.length === 0) {
    const { tokens } = resolveVisual(visual as VisualInput);
    const ratio = contrastRatio(tokens["--lamp"], tokens["--night"]);
    if (ratio < ACCENT_MIN_CONTRAST) {
      errs.push(
        `the accent ${tokens["--lamp"]} is ${contrastRounded(tokens["--lamp"], tokens["--night"])}:1 ` +
          `on the page field ${tokens["--night"]} — needs ${ACCENT_MIN_CONTRAST}:1 to stay legible`,
      );
    }
  }

  return errs;
}
