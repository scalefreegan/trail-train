/* ------------------------------------------------------------------ */
/*  ThemePreview — what a race's palette looks like, at a glance.      */
/*                                                                    */
/*  A row of equal swatches, in one fixed order: the field, a raised   */
/*  panel, body text, the accent, then the three signal colors. Same   */
/*  seven, same order, same size everywhere it appears — the point is  */
/*  that two races can be compared by looking at them, which only      */
/*  works if nothing about the strip moves between them.              */
/*                                                                    */
/*  The colors are written as literal values rather than var(), on     */
/*  purpose: the page's own :root is already wearing SOME race's       */
/*  theme, and a preview of a different one that inherited the current */
/*  accent would be a preview of nothing.                             */
/*                                                                    */
/*  Consumers: the race switcher menu (one accent dot per race) and    */
/*  the intake review dialog's preset picker (tt-yib.14).              */
/* ------------------------------------------------------------------ */

import { SWATCH_TOKENS, resolveVisual, type VisualInput } from "./visual.ts";
import type { ThemeTokens } from "./presets.ts";

export function ThemePreview({
  visual,
  tokens = SWATCH_TOKENS,
  size = 12,
  gap = 3,
  round = false,
  label,
  style,
}: {
  /** the race's `visual` block — preset, accent and overrides all honored */
  visual: VisualInput | null | undefined;
  /** which tokens to show, in order (default: SWATCH_TOKENS) */
  tokens?: readonly (keyof ThemeTokens)[];
  /** swatch edge length, px */
  size?: number;
  /** space between swatches, px */
  gap?: number;
  /** circles instead of squares — the one-swatch form used in menus */
  round?: boolean;
  /** accessible name; defaults to the resolved preset's name */
  label?: string;
  style?: React.CSSProperties;
}) {
  const { preset, tokens: resolved } = resolveVisual(visual);
  const name = label ?? `${preset} theme`;
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      style={{ display: "inline-flex", alignItems: "center", gap, flex: "0 0 auto", ...style }}
    >
      {tokens.map((token) => (
        <span
          key={token}
          aria-hidden
          style={{
            width: size,
            height: size,
            borderRadius: round ? "50%" : Math.max(1, Math.round(size / 6)),
            background: resolved[token],
            // the preset's OWN edge, so a swatch of the field is still a
            // visible shape against a page field of nearly the same value
            boxShadow: `inset 0 0 0 1px ${resolved["--edge-bright"]}`,
          }}
        />
      ))}
    </span>
  );
}
