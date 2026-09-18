/* ------------------------------------------------------------------ */
/*  Per-race theme presets.                                            */
/*                                                                    */
/*  Basecamp has one identity — pre-dawn trailhead, layered dark       */
/*  surfaces, one accent that reads as a light source. A race does not */
/*  get a new brand; it gets a variation on that one. So every preset  */
/*  keeps the same token structure and the same three typefaces, and   */
/*  changes only hue and temperature: the desert's warm sand, the San  */
/*  Juans' cold granite, a forest's moss, a moonless night.            */
/*                                                                    */
/*  The tokens are exactly the custom properties `web/src/index.css`   */
/*  defines on `:root`, keyed by their CSS names, so applying a preset */
/*  is a loop of setProperty and nothing else — no CSS-in-JS, no       */
/*  parallel naming scheme to keep in sync. `basecamp-default` holds   */
/*  today's values byte-for-byte (a test parses index.css and fails on */
/*  drift); the other four are sparse and inherit the rest from it.   */
/* ------------------------------------------------------------------ */

/** Every color/font custom property `index.css` sets on `:root`. */
export type ThemeTokens = {
  /** page field */
  "--night": string;
  /** recessed wells (chat, inputs) */
  "--night-deep": string;
  /** raised surfaces */
  "--panel": string;
  /** hover / active surfaces */
  "--panel-raise": string;
  /** hairline borders */
  "--edge": string;
  /** emphasized borders */
  "--edge-bright": string;
  /** primary text */
  "--mist": string;
  /** secondary text */
  "--mist-dim": string;
  /** tertiary / labels */
  "--mist-mute": string;
  /** primary accent — the light source */
  "--lamp": string;
  /** accent, pressed / deepened */
  "--lamp-deep": string;
  /** accent wash (rgba) */
  "--lamp-glow": string;
  /** good / ahead / connected */
  "--pine": string;
  /** warn / behind */
  "--ember": string;
  /** cool informational (sleep, calendar) */
  "--creek": string;
  "--font-display": string;
  "--font-body": string;
  "--font-mono": string;
};

export type ThemePreset =
  | "basecamp-default"
  | "desert"
  | "alpine"
  | "forest"
  | "night";

/** Menu order for pickers — the house palette first, then warm → dark. */
export const THEME_PRESET_NAMES: readonly ThemePreset[] = [
  "basecamp-default",
  "desert",
  "alpine",
  "forest",
  "night",
];

/**
 * Today's palette, byte-identical to `:root` in `web/src/index.css`.
 * Generic (no active race) mode uses this.
 */
export const BASECAMP_DEFAULT: ThemeTokens = {
  "--night": "#0c110e",
  "--night-deep": "#090d0b",
  "--panel": "#111813",
  "--panel-raise": "#16201a",
  "--edge": "#232f27",
  "--edge-bright": "#35453a",

  "--mist": "#e9efe6",
  "--mist-dim": "#a7b5a5",
  "--mist-mute": "#758573",

  "--lamp": "#ffb454",
  "--lamp-deep": "#cc7a1f",
  "--lamp-glow": "rgba(255, 180, 84, 0.14)",
  "--pine": "#8fd49a",
  "--ember": "#f0664d",
  "--creek": "#7fc4d8",

  "--font-display": '"Bricolage Grotesque", "Helvetica Neue", sans-serif',
  "--font-body": '"Archivo", system-ui, sans-serif',
  "--font-mono": '"Spline Sans Mono", ui-monospace, monospace',
};

/**
 * Mogollon Rim / Pine, AZ — ponderosa duff and red rock. Warm near-black
 * field, sandstone text, a rust accent where the amber headlamp was.
 */
const DESERT: Partial<ThemeTokens> = {
  "--night": "#120e0a",
  "--night-deep": "#0d0a07",
  "--panel": "#191310",
  "--panel-raise": "#221a15",
  "--edge": "#2f241c",
  "--edge-bright": "#463629",

  "--mist": "#f2e8dc",
  "--mist-dim": "#c4b39f",
  "--mist-mute": "#94826e",

  "--lamp": "#e58045",
  "--lamp-deep": "#a9531f",
  "--lamp-glow": "rgba(229, 128, 69, 0.14)",
  "--pine": "#a9c583",
  "--ember": "#ef5f57",
  "--creek": "#8fb9c4",
};

/**
 * San Juans above treeline — cold granite and blue shadow, with a glacier
 * accent. The only preset whose light source reads cold.
 */
const ALPINE: Partial<ThemeTokens> = {
  "--night": "#0b0f14",
  "--night-deep": "#080b0f",
  "--panel": "#10161d",
  "--panel-raise": "#161f28",
  "--edge": "#212d38",
  "--edge-bright": "#344350",

  "--mist": "#e7eef5",
  "--mist-dim": "#a9b9c7",
  "--mist-mute": "#7b8b98",

  "--lamp": "#7fd3f0",
  "--lamp-deep": "#2f8cad",
  "--lamp-glow": "rgba(127, 211, 240, 0.14)",
  "--pine": "#8ad2ab",
  "--ember": "#f07a5f",
  "--creek": "#a3b6e2",
};

/**
 * Deep timber — spruce black pushed greener, moss for the accent, and a
 * cooler mint for "good" so the two greens never read as one.
 */
const FOREST: Partial<ThemeTokens> = {
  "--night": "#0a0f0b",
  "--night-deep": "#070b08",
  "--panel": "#0f1610",
  "--panel-raise": "#141e16",
  "--edge": "#1f2c21",
  "--edge-bright": "#304434",

  "--mist": "#e9f0e7",
  "--mist-dim": "#abbca8",
  "--mist-mute": "#7b8d77",

  "--lamp": "#a9cf6b",
  "--lamp-deep": "#6b9339",
  "--lamp-glow": "rgba(169, 207, 107, 0.14)",
  "--pine": "#72d1b1",
  "--ember": "#ef6a4d",
  "--creek": "#7fc4d8",
};

/**
 * Moonless — near-black neutral field, cool white accent. The quietest
 * preset: for a night race, or for a screen at 3am in a crew tent.
 */
const NIGHT: Partial<ThemeTokens> = {
  "--night": "#060708",
  "--night-deep": "#030405",
  "--panel": "#0c0e10",
  "--panel-raise": "#131619",
  "--edge": "#1c2024",
  "--edge-bright": "#2c3237",

  "--mist": "#eef1f4",
  "--mist-dim": "#adb6be",
  "--mist-mute": "#7e8790",

  "--lamp": "#dfe8f0",
  "--lamp-deep": "#94a3af",
  "--lamp-glow": "rgba(223, 232, 240, 0.10)",
  "--pine": "#8fd4b0",
  "--ember": "#ef6a5a",
  "--creek": "#85c3dc",
};

/**
 * Every preset, keyed by the name a race's `visual.theme_preset` carries.
 * All but `basecamp-default` are sparse — they override only what changes.
 */
export const THEME_PRESETS: Record<ThemePreset, Partial<ThemeTokens>> = {
  "basecamp-default": BASECAMP_DEFAULT,
  desert: DESERT,
  alpine: ALPINE,
  forest: FOREST,
  night: NIGHT,
};

/**
 * The full token map a preset actually renders as: the house palette, the
 * preset's overrides, then the race's own `visual.overrides` on top.
 */
export function resolveTheme(
  preset: ThemePreset,
  overrides: Partial<ThemeTokens> = {},
): ThemeTokens {
  return { ...BASECAMP_DEFAULT, ...THEME_PRESETS[preset], ...overrides };
}

/**
 * Write tokens onto an element as CSS custom properties. Pass the resolved
 * map for a full swap, or a sparse one to nudge single tokens.
 */
export function applyTheme(
  tokens: Partial<ThemeTokens>,
  root: HTMLElement = document.documentElement,
): void {
  for (const [name, value] of Object.entries(tokens)) {
    if (value != null) root.style.setProperty(name, value);
  }
}

/**
 * Undo `applyTheme` — drop the inline overrides so `:root` in index.css
 * shows through again. Used when a race deactivates.
 */
export function clearTheme(
  root: HTMLElement = document.documentElement,
): void {
  for (const name of Object.keys(BASECAMP_DEFAULT)) {
    root.style.removeProperty(name);
  }
}
