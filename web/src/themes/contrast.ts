/* ------------------------------------------------------------------ */
/*  WCAG 2.x contrast math — pure, dependency-free.                    */
/*                                                                    */
/*  Used by the preset tests (and, later, by the intake preview) to    */
/*  prove that a race's palette is still readable: a race may recolor  */
/*  Basecamp, it may not make it unreadable. No DOM, no canvas — just  */
/*  the sRGB relative-luminance formula from WCAG 2.1 §Relative        */
/*  luminance and the contrast ratio (L1 + 0.05) / (L2 + 0.05).       */
/* ------------------------------------------------------------------ */

export type Rgb = { r: number; g: number; b: number };

/** Parse `#rgb`, `#rrggbb` (or the same without `#`) into 0-255 channels. */
export function parseHex(hex: string): Rgb {
  const raw = hex.trim().replace(/^#/, "");
  const full =
    raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`not a hex color: ${JSON.stringify(hex)}`);
  }
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

/** sRGB channel (0-255) → linear-light value (0-1). */
export function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, 0 (black) → 1 (white). */
export function relativeLuminance(color: string | Rgb): number {
  const { r, g, b } = typeof color === "string" ? parseHex(color) : color;
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

/** WCAG contrast ratio, 1 (identical) → 21 (black on white). Order-free. */
export function contrastRatio(a: string | Rgb, b: string | Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

/** Contrast rounded to 2dp — what a report or a preview badge shows. */
export function contrastRounded(a: string | Rgb, b: string | Rgb): number {
  return Math.round(contrastRatio(a, b) * 100) / 100;
}
