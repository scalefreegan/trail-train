/* ------------------------------------------------------------------ */
/*  useTheme — the race on screen wears its own palette.               */
/*                                                                    */
/*  Mounted exactly once (providers.tsx's <RaceTheme />), and it       */
/*  renders nothing: a theme swap is eighteen setProperty calls on     */
/*  :root plus a data-theme attribute, so the dashboard recolors       */
/*  without a single component re-rendering its data. That is the      */
/*  whole reason it is a leaf and not a provider — a context whose     */
/*  value changed on every switch would re-render the tree under it    */
/*  to produce exactly the same DOM.                                   */
/*                                                                    */
/*  Which race: the one BEING LOOKED AT. In train mode that is the     */
/*  training target; in view mode it is the archived or draft folder   */
/*  being browsed (tt-yib.7), because the point of browsing a race is  */
/*  seeing it. Generic mode has no race and therefore no override —    */
/*  it clears back to :root, which IS basecamp-default.                */
/*                                                                    */
/*  Nothing is persisted. The pointer is the only state; a reload      */
/*  re-derives the palette from it.                                    */
/* ------------------------------------------------------------------ */

import { useEffect } from "react";

import { useActiveRace } from "../data";
import { applyTheme, clearTheme } from "./presets.ts";
import { resolveVisual, type VisualInput } from "./visual.ts";

/** The attribute the resolved preset name is published on, for CSS (and for
    a test, and for anyone wondering what they are looking at). */
export const THEME_ATTRIBUTE = "data-theme";

export function useTheme(): void {
  const { activeRace, resolved } = useActiveRace();

  // /api/race/active is re-fetched on every refresh pulse, so the `visual`
  // object is a new object each time even when not one byte of it changed.
  // Keying the effect on its VALUE means a resync does not repaint :root,
  // and a race switch does. `null` until the payload has settled: before
  // then "no race" is not yet a fact, and clearing on a loading frame is a
  // flash of the house palette on every reload.
  const visualKey = resolved
    ? JSON.stringify((activeRace?.race?.visual ?? null) as VisualInput | null)
    : null;

  useEffect(() => {
    if (visualKey === null) return;
    const visual = JSON.parse(visualKey) as VisualInput | null;
    const { preset, tokens } = resolveVisual(visual);
    const root = document.documentElement;
    // A race always gets the full resolved map, never a sparse one: writing
    // all eighteen is what guarantees the previous race's overrides are gone.
    if (visual) applyTheme(tokens, root);
    else clearTheme(root);
    root.setAttribute(THEME_ATTRIBUTE, preset);
  }, [visualKey]);
}
