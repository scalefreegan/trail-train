import { useEffect, useState } from "react";

/* ------------------------------------------------------------------ */
/*  The app's one hash route.                                          */
/*                                                                    */
/*  Hash and not a path because there is no router and no server-side  */
/*  rewrite: `vite preview` and the dev server both 404 an unknown     */
/*  path, and the fix for that is either a router dependency or a      */
/*  middleware — this app wants neither for a single phone view.       */
/*  `#/race-day` is typable, bookmarkable, survives a reload, and      */
/*  costs one `hashchange` listener.                                   */
/*                                                                    */
/*  Own module so RaceDay.tsx stays component-only (react-refresh).    */
/* ------------------------------------------------------------------ */

export const RACE_DAY_HASH = "#/race-day";

/** The current location hash, re-read on every `hashchange`. */
export function useHashRoute(): string {
  const [hash, setHash] = useState(() =>
    typeof window === "undefined" ? "" : window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    // re-read on mount too: the hash can change between the lazy initial
    // state and the listener being attached (a deep link that redirects)
    onChange();
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

/** Leave a hash route. Assigning "" fires `hashchange`; replaceState does
    not, which would leave the view mounted with a cleared URL. */
export function clearHash(): void {
  window.location.hash = "";
}
