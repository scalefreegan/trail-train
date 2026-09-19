// The hero-asset endpoint's guard rails.
//
// Everything here is the PURE half of GET /api/races/:slug/asset/:name — the
// half that decides which file may be opened. vite.config.ts does the opening
// and nothing else, so a traversal that this file refuses cannot be served.

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  ASSET_CONTENT_TYPES,
  ASSET_MAX_BYTES,
  parseAssetUrl,
  resolveRaceAsset,
} from "./race-asset.mjs";

const ROOT = "/tmp/basecamp-root";
const SLUG = "mogollon-monster-100-2026";
const DIR = path.join(ROOT, "races", SLUG);
const HERO = "hero.jpg";

const resolve = (slug, name, hero = HERO) => resolveRaceAsset(ROOT, slug, name, hero);

/* ------------------------------- routing -------------------------------- */

test("a non-asset path under /api/races is not ours", () => {
  // the race LIST is mounted at the same prefix — saying "not mine" is what
  // lets it keep working
  assert.equal(parseAssetUrl("/"), null);
  assert.equal(parseAssetUrl(""), null);
  assert.equal(parseAssetUrl("/some-slug"), null);
  assert.equal(parseAssetUrl("/some-slug/race.json"), null);
});

test("an asset path splits into slug and name", () => {
  assert.deepEqual(parseAssetUrl(`/${SLUG}/asset/${HERO}`), { slug: SLUG, name: HERO });
  assert.deepEqual(parseAssetUrl(`/${SLUG}/asset/${HERO}?t=1`), { slug: SLUG, name: HERO });
  assert.deepEqual(parseAssetUrl(`/${SLUG}/asset/${HERO}#x`), { slug: SLUG, name: HERO });
});

test("a malformed asset path is CLAIMED, not passed on", () => {
  // handing "/a/asset/../../x" back to the race-list handler would answer a
  // traversal attempt with the race list
  assert.deepEqual(parseAssetUrl("/a/asset/../../etc/passwd"), { slug: "a", name: "../../etc/passwd" });
  assert.deepEqual(parseAssetUrl("/a/asset/b/c.jpg"), { slug: "a", name: "b/c.jpg" });
  assert.deepEqual(parseAssetUrl("//asset/x.jpg"), { slug: "", name: "x.jpg" });
});

/* ------------------------------- the happy path ------------------------- */

test("the declared hero resolves inside the race folder", () => {
  const r = resolve(SLUG, HERO);
  assert.equal(r.ok, true);
  assert.equal(r.file, path.join(DIR, HERO));
  assert.equal(r.contentType, "image/jpeg");
});

test("every servable extension resolves with its content type", () => {
  for (const [ext, type] of Object.entries(ASSET_CONTENT_TYPES)) {
    const name = `hero${ext}`;
    const r = resolve(SLUG, name, name);
    assert.equal(r.ok, true, `${ext} should be servable`);
    assert.equal(r.contentType, type);
  }
});

test("a percent-encoded but harmless name still resolves", () => {
  const r = resolve(SLUG, "hero%2Ejpg");
  assert.equal(r.ok, true);
  assert.equal(r.file, path.join(DIR, HERO));
});

/* ------------------------------ traversal ------------------------------- */

const TRAVERSALS = [
  ["..", "bare dotdot"],
  ["../race.json", "up one"],
  ["../../../../etc/passwd", "up many"],
  ["..%2f..%2fetc%2fpasswd", "encoded slashes"],
  ["%2e%2e%2f%2e%2e%2fetc%2fpasswd", "fully encoded"],
  ["%2E%2E/race.json", "encoded dots"],
  ["..\\..\\windows\\win.ini", "backslashes"],
  ["/etc/passwd", "absolute"],
  ["%2Fetc%2Fpasswd", "encoded absolute"],
  ["sub/hero.jpg", "subdirectory"],
  ["hero.jpg/../../race.json", "traversal after a legal prefix"],
  ["....//hero.jpg", "doubled dots"],
  ["hero.jpg\0.txt", "null byte"],
  ["%zz", "malformed encoding"],
];

for (const [name, what] of TRAVERSALS) {
  test(`asset name is refused: ${what}`, () => {
    // checked against a hero that IS the attempted name, so the refusal can
    // only come from the path guard and never from the hero comparison
    const r = resolveRaceAsset(ROOT, SLUG, name, name);
    assert.equal(r.ok, false, `${JSON.stringify(name)} should be refused`);
    assert.equal(r.status, 400);
  });
}

const BAD_SLUGS = [
  ["..", "dotdot"],
  ["../races", "traversal"],
  ["%2e%2e", "encoded dotdot"],
  ["", "empty"],
  ["_fixtures", "underscore folder"],
  ["Mogollon", "uppercase"],
  ["a/b", "slash"],
  ["..%2f..", "encoded traversal"],
];

for (const [slug, what] of BAD_SLUGS) {
  test(`slug is refused: ${what}`, () => {
    const r = resolve(slug, HERO);
    assert.equal(r.ok, false, `slug ${JSON.stringify(slug)} should be refused`);
    assert.equal(r.status, 400);
  });
}

/* --------------------------- only the hero ------------------------------ */

test("a real file in the folder that is not the hero is not served", () => {
  for (const name of ["race.json", "course.gpx", "block.json"]) {
    const r = resolve(SLUG, name);
    assert.equal(r.ok, false, `${name} should not be servable`);
  }
  // ...and even a legal image name is 404 unless it IS the hero
  const other = resolve(SLUG, "other.png");
  assert.equal(other.ok, false);
  assert.equal(other.status, 404);
  assert.match(other.error, /visual\.hero/);
});

test("a race with no hero serves nothing", () => {
  for (const hero of [undefined, null, "", 0, {}]) {
    const r = resolveRaceAsset(ROOT, SLUG, HERO, hero);
    assert.equal(r.ok, false, `hero ${JSON.stringify(hero)} should serve nothing`);
    assert.equal(r.status, 404);
  }
});

test("a hero the validator would have refused is not servable either", () => {
  // belt and braces: visualErrors() rejects these at write time, and the
  // endpoint refuses them again at read time
  for (const hero of ["../secrets.jpg", "hero.gif", "sub/hero.jpg"]) {
    const r = resolveRaceAsset(ROOT, SLUG, hero, hero);
    assert.equal(r.ok, false, `hero ${JSON.stringify(hero)} should be refused`);
  }
});

test("the size cap is a real cap", () => {
  assert.equal(ASSET_MAX_BYTES, 8 * 1024 * 1024);
});
