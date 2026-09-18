/* ------------------------------------------------------------------ */
/*  GET /api/races/:slug/asset/:name — race folder assets, safely.     */
/*                                                                    */
/*  A race folder is a directory the athlete (and an agent) writes     */
/*  into, and the dev server has to hand one file out of it to the     */
/*  browser: the hero image behind the elevation ribbon. That is a     */
/*  path-traversal endpoint by construction, so everything that        */
/*  decides WHICH file lives here, pure and tested, and vite.config.ts */
/*  only opens what this module already agreed to.                     */
/*                                                                    */
/*  Four gates, in order, and a request must clear all four:           */
/*    1. the slug is a race slug (lowercase kebab — never "..")        */
/*    2. the name is a plain filename with a servable image extension  */
/*       (isSafeAssetName, shared with the visual validator, so a hero */
/*       that would be refused here cannot be written in the first     */
/*       place)                                                        */
/*    3. the name is EXACTLY what that race's visual.hero declares —   */
/*       the folder is not a static mount, it serves one nominated     */
/*       file                                                          */
/*    4. the resolved absolute path is still inside races/<slug>/      */
/*                                                                    */
/*  Percent-encoding is decoded BEFORE the checks, so "%2e%2e%2f" is   */
/*  the same request as "../" and is refused the same way.             */
/* ------------------------------------------------------------------ */

import path from "node:path";

import { raceDir } from "./race-config.mjs";
import { isSafeAssetName } from "../web/src/themes/visual.ts";

/** What we will serve, and as what. Keys mirror HERO_EXTENSIONS in visual.ts. */
export const ASSET_CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * Hero images are backdrops, not photo albums. 8 MB is generous for a
 * full-bleed JPEG and small enough that a stray RAW export is an error
 * message rather than a stalled dev server.
 */
export const ASSET_MAX_BYTES = 8 * 1024 * 1024;

/** The same shape race-config.mjs enforces on race.json's slug. */
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** decodeURIComponent that answers null instead of throwing on "%zz". */
function decodeOnce(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Split the path BELOW the /api/races mount into a slug and an asset name.
 *
 * @param {string} rest  req.url as connect hands it to a handler mounted on
 *                       /api/races — "/mogollon-monster-100-2026/asset/hero.jpg".
 * @returns {{slug: string, name: string}|null}  null when this is not an asset
 *   request at all (the race LIST lives at the same mount point, so the
 *   middleware has to be able to say "not mine" and call next()).
 *
 * Deliberately loose: anything containing "/asset/" is an asset request, even
 * "/a/asset/b/c" or "/a/asset/../x". Those come back as a slug and a name and
 * are REFUSED by resolveRaceAsset — falling through to next() would answer a
 * traversal attempt with the race list.
 */
export function parseAssetUrl(rest) {
  const pathname = String(rest ?? "").split(/[?#]/)[0];
  const m = /^\/([^/]*)\/asset\/(.*)$/.exec(pathname);
  if (!m) return null;
  return { slug: m[1], name: m[2] };
}

const deny = (status, error) => ({ ok: false, status, error });

/**
 * Gates 1, 2 and 4 — everything that can be decided WITHOUT reading the race
 * folder. Split out because the caller cannot safely open races/<slug>/race.json
 * (to learn the hero) until the slug has been proven not to be "..".
 *
 * @param {string} root   project root
 * @param {string} rawSlug  slug as it appeared in the URL (still encoded)
 * @param {string} rawName  name as it appeared in the URL (still encoded)
 * @returns {{ok: true, slug: string, name: string, file: string, contentType: string}
 *          |{ok: false, status: number, error: string}}
 */
export function checkAssetRequest(root, rawSlug, rawName) {
  const slug = decodeOnce(rawSlug);
  const name = decodeOnce(rawName);
  if (slug === null || name === null) return deny(400, "malformed percent-encoding in the request path");

  if (!SLUG_RE.test(slug)) return deny(400, `not a race slug: ${JSON.stringify(slug)}`);
  // Catches "..", "a/b", "/etc/passwd", "..\\x", ".hidden.png", "x.gif", "" —
  // and everything a decoded "%2e%2e%2f" turns into.
  if (!isSafeAssetName(name)) return deny(400, `not a servable asset name: ${JSON.stringify(name)}`);

  // Gate 4. The two above already make this unreachable; it is here because
  // the day one of them is loosened, THIS is what still has to hold.
  const dir = path.resolve(raceDir(root, slug));
  const file = path.resolve(dir, name);
  if (file !== path.join(dir, name) || !file.startsWith(dir + path.sep)) {
    return deny(400, "resolved outside the race folder");
  }

  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const contentType = ASSET_CONTENT_TYPES[ext];
  if (!contentType) return deny(400, `unsupported asset type: ${ext}`);

  return { ok: true, slug, name, file, contentType };
}

/**
 * The whole decision: may this request be served, and from which file?
 * checkAssetRequest plus gate 3 — the name must be the race's own
 * visual.hero. The folder is not a static mount.
 *
 * @param {string} root   project root
 * @param {string} rawSlug  slug as it appeared in the URL (still encoded)
 * @param {string} rawName  name as it appeared in the URL (still encoded)
 * @param {string|null|undefined} hero  that race's visual.hero
 * @returns {{ok: true, slug: string, name: string, file: string, contentType: string}
 *          |{ok: false, status: number, error: string}}
 */
export function resolveRaceAsset(root, rawSlug, rawName, hero) {
  const checked = checkAssetRequest(root, rawSlug, rawName);
  if (!checked.ok) return checked;

  if (typeof hero !== "string" || hero === "") {
    return deny(404, `races/${checked.slug} declares no visual.hero`);
  }
  if (hero !== checked.name) {
    return deny(404, `races/${checked.slug} serves only its visual.hero, not ${JSON.stringify(checked.name)}`);
  }
  return checked;
}
