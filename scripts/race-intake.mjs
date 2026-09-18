#!/usr/bin/env node
// Race intake, stage 1 — "plug in a race" (PRD §8 steps 1-3).
//
// Given a race's website (plus optional extra URLs, PDF/GPX uploads and a
// free-text "what matters to me"), this fetches and caches the sources, turns
// image-only PDFs into per-page PNGs, and runs a headless `claude -p` agent
// with WebFetch/WebSearch/Read to transcribe them into a race.json draft.
//
// What it deliberately does NOT do:
//   · invent anything — a field the agent cannot establish from a source is
//     null and named in `unresolved[]`, for the review dialog to fill;
//   · compute anything the course build owns — sun times, snapped lat/lon and
//     climb metrics are stage 2 (build-course.mjs / aid-match.mjs);
//   · touch config/active-race.json or web/public/. The draft is inert until
//     a human activates it.
//
// Usage (library):  import { runIntake } from "./race-intake.mjs"
// Usage (CLI):      node scripts/race-intake.mjs --site https://… --year 2027 \
//                     [--upload /path/manual.pdf] [--url https://…] [--notes "…"] [--refresh]

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { RACE_SCHEMA_VERSION, raceDir, validateRaceJson } from "./race-config.mjs";
import { runClaudeJson, extractJson, agentModel } from "./agent-run.mjs";
import { parseGpx } from "./aid-match.mjs";
import { arg, writeJsonAtomic } from "./lib.mjs";

const exec = promisify(execFile);

/** Hard cap on fetched pages. A race site can link a whole blog; the agent
    only needs the pages that carry course facts, and every extra page is
    cache noise plus another thing for the agent to read. */
export const MAX_FETCH_PAGES = 12;

/** Per-resource fetch timeout. Race sites are small; a stall is a dead link. */
const FETCH_TIMEOUT_MS = 25_000;

/** Refuse to cache anything larger than this (a GPX or manual is ≪ this). */
const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;

/** Page images beyond this are almost certainly sponsor pages, and each one
    costs the agent a turn to look at. */
const MAX_PDF_PAGES = 24;

/** Long-side pixels for a rendered PDF page. 2000 keeps an aid chart's small
    print legible without producing files the agent's Read chokes on. */
const PDF_RENDER_PX = 2000;

/* The intake reads a website, several pages and up to a couple of dozen page
   images, so its budget is far larger than the coach's. Measured shape: ~6-10
   WebFetch/Read turns for the site, 1-3 per PDF page image that matters. */
const INTAKE_MAX_TURNS = 60;
const INTAKE_TIMEOUT_SEC = 600;

/* Every source the agent reads is attributed to the run as a whole; a field
   the agent can pin to one document gets that document in its provenance. */
const PROVENANCE_BY = "agent";

/** Top-level fields that may never be null, whatever the agent says: without
    them there is no race folder to review (the slug and the name are the
    folder's identity, and a course with no aid stations has no spine). */
const NEVER_EXCUSABLE = new Set(["schema_version", "slug", "status", "name", "short", "aid_stations"]);

/* ----------------------------- slug ---------------------------------- */

/**
 * Lowercase kebab-case, accents folded, punctuation dropped.
 * @param {string} s
 * @returns {string}
 */
export function kebab(s) {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Race folder slug: `<kebab name>-<year>` (PRD §4). A name that already ends
 * in the edition year does not get it twice ("Softie 2027" + 2027).
 * @param {string} name
 * @param {number|string} year
 * @returns {string}
 */
export function deriveSlug(name, year) {
  const base = kebab(name);
  const y = String(year ?? "").trim();
  if (!base) throw new Error("cannot derive a slug from an empty race name");
  if (!/^\d{4}$/.test(y)) throw new Error(`edition year must be a 4-digit year (got ${JSON.stringify(year)})`);
  return base.endsWith(`-${y}`) ? base : `${base}-${y}`;
}

/** True when races/<slug>/race.json already exists. */
async function slugExists(root, slug) {
  try {
    await fs.access(path.join(raceDir(root, slug), "race.json"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Guard the one destructive thing intake could do: overwrite a race folder.
 * Re-intake is a separate bead with a merge step, so without `refresh` this
 * refuses rather than clobbering hand edits.
 * @param {string} root
 * @param {string} slug
 * @param {{refresh?: boolean}} [opts]
 */
export async function assertSlugAvailable(root, slug, { refresh = false } = {}) {
  if (!(await slugExists(root, slug))) return;
  if (refresh) return;
  throw new Error(`races/${slug}/race.json already exists — pass refresh: true to re-intake it (hand edits are NOT merged by this stage)`);
}

/* --------------------------- source fetch ----------------------------- */

const PDF_RE = /\.pdf(?:[?#]|$)/i;
const GPX_RE = /\.gpx(?:[?#]|$)/i;
/** Link text / href words that mark a page worth following for course facts. */
const FOLLOW_RE = /manual|course|aid[-_ ]?station|aid\b|crew|pacer|drop[-_ ]?bag|logistics|race[-_ ]?info|runner|details|schedule|cutoff|elevation|map|gpx|results|track/i;

/**
 * Classify a link by what it is to the intake, not by its file type alone.
 * @param {string} url absolute URL
 * @param {string} [text] the link's anchor text
 * @returns {"pdf"|"gpx"|"results"|"tracking"|"page"|null} null = not worth fetching
 */
export function classifyLink(url, text = "") {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const hay = `${u.pathname}${u.search} ${text}`;
  if (PDF_RE.test(u.pathname)) return "pdf";
  if (GPX_RE.test(u.pathname)) return "gpx";
  // Gaia/CalTopo/Strava route pages are where organizers park the GPX; the
  // agent can follow them with WebFetch even when the file itself is behind a
  // login, so they are worth recording as a source.
  if (/gaiagps\.com|caltopo\.com|strava\.com\/routes/.test(host + u.pathname)) return "gpx";
  if (/opensplittime\.org|ultrasignup\.com\/results|runsignup\.com\/.*results/.test(host + u.pathname)) return "results";
  if (/maprogress\.com|trackleaders\.com|live\.trackleaders|open-?tracking/.test(host + u.pathname)) return "tracking";
  if (FOLLOW_RE.test(hay)) return "page";
  return null;
}

/**
 * Pull `<a href>` links out of an HTML page, resolved against its URL.
 * Regex, not a parser: no new dependency, and a race site's markup is plain.
 * @param {string} html
 * @param {string} baseUrl
 * @returns {{url: string, text: string}[]} de-duplicated, order preserved
 */
export function discoverLinks(html, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let abs;
    try { abs = new URL(m[1], baseUrl).toString(); } catch { continue; }
    const clean = abs.split("#")[0];
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push({ url: clean, text: m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() });
  }
  return out;
}

/** A filesystem-safe cache name for a URL, keeping its extension. */
function cacheName(url, kind) {
  const u = new URL(url);
  const base = kebab(`${u.hostname}${u.pathname}`) || "page";
  const ext = kind === "pdf" ? ".pdf" : kind === "gpx" ? ".gpx" : ".html";
  return `${base.slice(0, 80)}${ext}`;
}

/** Fetch one resource with a timeout and a size cap. Never throws. */
async function fetchResource(url) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // Some race sites 403 a bare fetch; a normal UA is not a trick, it is
      // the same request the owner's browser makes.
      headers: { "user-agent": "Mozilla/5.0 (Macintosh) Basecamp-race-intake/1" },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_RESOURCE_BYTES) {
      return { ok: false, status: res.status, error: `larger than ${MAX_RESOURCE_BYTES} bytes` };
    }
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      buffer: buf,
      finalUrl: res.url || url,
      error: res.ok ? null : `HTTP ${res.status}`,
    };
  } catch (e) {
    return { ok: false, status: null, error: e.name === "TimeoutError" ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : e.message };
  }
}

/**
 * Fetch the site, follow the links that carry course facts, and cache
 * everything into `sourcesDir` with a manifest. Failures are recorded in the
 * manifest rather than thrown: one dead link must not kill the intake.
 * @returns {Promise<object[]>} manifest entries
 */
async function cacheSources({ sourcesDir, siteUrl, extraUrls, maxPages, onProgress }) {
  await fs.mkdir(sourcesDir, { recursive: true });
  const manifest = [];
  const queued = new Map(); // url -> kind
  const record = async (url, kind, res) => {
    const entry = {
      kind: kind === "page" ? "url" : kind === "results" || kind === "tracking" ? "url" : kind,
      role: kind,
      ref: url,
      file: null,
      status: res.status,
      content_type: res.contentType ?? null,
      bytes: res.buffer?.byteLength ?? 0,
      fetched_at: new Date().toISOString(),
      error: res.error ?? null,
    };
    if (res.ok && res.buffer) {
      entry.file = cacheName(url, kind);
      await fs.writeFile(path.join(sourcesDir, entry.file), res.buffer);
    }
    manifest.push(entry);
    return entry;
  };

  queued.set(siteUrl, "page");
  for (const u of extraUrls) {
    const kind = classifyLink(u) ?? "page";
    if (!queued.has(u)) queued.set(u, kind);
  }

  // Pass 1: the seeds. The site's own HTML is also the link source.
  const seeds = [...queued.entries()];
  const discovered = [];
  for (const [url, kind] of seeds) {
    onProgress({ step: "fetch", status: "log", message: `fetching ${url}` });
    const res = await fetchResource(url);
    const entry = await record(url, kind, res);
    if (!res.ok) {
      onProgress({ step: "fetch", status: "log", message: `  ✗ ${url}: ${res.error}`, stream: "err" });
      continue;
    }
    if ((res.contentType || "").includes("html")) {
      for (const link of discoverLinks(res.buffer.toString("utf8"), entry.ref)) {
        const linkKind = classifyLink(link.url, link.text);
        if (!linkKind || queued.has(link.url)) continue;
        // Stay on the race's own site for plain pages; PDFs, GPX, results and
        // tracking are routinely hosted elsewhere and are still the race's.
        if (linkKind === "page" && new URL(link.url).hostname !== new URL(siteUrl).hostname) continue;
        queued.set(link.url, linkKind);
        discovered.push({ url: link.url, kind: linkKind, text: link.text });
      }
    }
  }

  // Pass 2: the discovered links, files first — a runner manual is worth more
  // than the tenth nav page, and the cap is shared.
  const rank = { pdf: 0, gpx: 1, results: 2, tracking: 3, page: 4 };
  discovered.sort((a, b) => rank[a.kind] - rank[b.kind]);
  for (const link of discovered) {
    if (manifest.length >= maxPages) {
      onProgress({ step: "fetch", status: "log", message: `page cap (${maxPages}) reached — ${discovered.length - manifest.length} link(s) left unfetched` });
      break;
    }
    onProgress({ step: "fetch", status: "log", message: `fetching ${link.kind}: ${link.url}` });
    const res = await fetchResource(link.url);
    await record(link.url, link.kind, res);
    if (!res.ok) onProgress({ step: "fetch", status: "log", message: `  ✗ ${link.url}: ${res.error}`, stream: "err" });
  }
  return manifest;
}

/* ---------------------------- PDF pages -------------------------------- */

/**
 * Page count straight out of the PDF's object table. Heuristic on purpose:
 * we only need it to choose a renderer and to cap the work, and being wrong
 * costs an extra probe, not a wrong answer.
 * @param {Buffer} buf
 * @returns {number} at least 1
 */
export function pdfPageCount(buf) {
  const text = buf.toString("latin1");
  const byType = (text.match(/\/Type\s*\/Page(?![s/\w])/g) || []).length;
  if (byType > 0) return byType;
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return counts.length ? Math.max(...counts, 1) : 1;
}

/**
 * Pick the PDF→PNG path for this machine.
 *
 * Why the order is what it is: the aid chart we most need to transcribe is an
 * IMAGE on page 11 of the Softie manual, so a renderer that can only do page 1
 * is not a renderer for this job — it is a last resort. `sips` and
 * `qlmanage -t` are page-1-only; both Quartz paths (PyObjC, and the same
 * PDFKit through JXA/osascript) can split every page.
 *
 * @param {{pageCount?: number, tools: {sips?: boolean, quartz?: boolean, jxa?: boolean, qlmanage?: boolean}}} input
 * @returns {{id: "quartz"|"quartz-jxa"|"sips"|"qlmanage"|null, scope: "all"|"first"|"none", warning: string|null}}
 */
export function choosePdfRenderer({ pageCount = 1, tools }) {
  const t = tools || {};
  const multipage = pageCount > 1;
  if (multipage) {
    if (t.quartz) return { id: "quartz", scope: "all", warning: null };
    if (t.jxa) return { id: "quartz-jxa", scope: "all", warning: null };
    const fallback = t.sips ? "sips" : t.qlmanage ? "qlmanage" : null;
    if (!fallback) {
      return { id: null, scope: "none", warning: `no PDF renderer on this machine — ${pageCount} pages will be passed as text only; an image-only aid chart cannot be transcribed` };
    }
    return {
      id: fallback,
      scope: "first",
      warning: `${fallback} can only render page 1 of ${pageCount} — pages 2+ are text-only; an image-only aid chart on a later page cannot be transcribed`,
    };
  }
  if (t.sips) return { id: "sips", scope: "first", warning: null };
  if (t.quartz) return { id: "quartz", scope: "all", warning: null };
  if (t.jxa) return { id: "quartz-jxa", scope: "all", warning: null };
  if (t.qlmanage) return { id: "qlmanage", scope: "first", warning: null };
  return { id: null, scope: "none", warning: "no PDF renderer on this machine — the PDF is passed as text only" };
}

/** Does `cmd --version`-ish succeed? Used only to probe for a tool. */
async function canRun(cmd, args) {
  try {
    await exec(cmd, args, { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe this machine for PDF→PNG tools. macOS-only by design: this is a
 * local Mac dashboard, and every path here is a system binary (no new deps).
 * @returns {Promise<{sips: boolean, quartz: boolean, quartzPython: string|null, jxa: boolean, qlmanage: boolean}>}
 */
export async function detectPdfTools() {
  const [sips, qlmanage] = await Promise.all([
    canRun("sips", ["--help"]),
    canRun("qlmanage", ["-h"]),
  ]);
  // PyObjC ships with some system pythons and not others — probe both the
  // one on PATH and /usr/bin/python3 rather than assuming either.
  let quartzPython = null;
  for (const py of ["python3", "/usr/bin/python3"]) {
    if (await canRun(py, ["-c", "import Quartz"])) { quartzPython = py; break; }
  }
  const jxa = await canRun("osascript", ["-l", "JavaScript", "-e", "ObjC.import('Quartz'); 'ok'"]);
  return { sips, quartz: Boolean(quartzPython), quartzPython, jxa, qlmanage };
}

const QUARTZ_PY = `import sys
import Quartz
from CoreFoundation import CFURLCreateFromFileSystemRepresentation, kCFAllocatorDefault
src, outdir, limit, px = sys.argv[1], sys.argv[2], int(sys.argv[3]), float(sys.argv[4])
url = CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault, src.encode("utf-8"), len(src.encode("utf-8")), False)
doc = Quartz.CGPDFDocumentCreateWithURL(url)
n = min(Quartz.CGPDFDocumentGetNumberOfPages(doc), limit)
for i in range(1, n + 1):
    page = Quartz.CGPDFDocumentGetPage(doc, i)
    rect = Quartz.CGPDFPageGetBoxRect(page, Quartz.kCGPDFMediaBox)
    w, h = rect.size.width, rect.size.height
    scale = px / max(w, h)
    cs = Quartz.CGColorSpaceCreateDeviceRGB()
    ctx = Quartz.CGBitmapContextCreate(None, int(w * scale), int(h * scale), 8, 0, cs, Quartz.kCGImageAlphaPremultipliedFirst)
    Quartz.CGContextSetRGBFillColor(ctx, 1, 1, 1, 1)
    Quartz.CGContextFillRect(ctx, Quartz.CGRectMake(0, 0, w * scale, h * scale))
    Quartz.CGContextScaleCTM(ctx, scale, scale)
    Quartz.CGContextDrawPDFPage(ctx, page)
    img = Quartz.CGBitmapContextCreateImage(ctx)
    out = "%s/p%02d.png" % (outdir, i)
    outurl = CFURLCreateFromFileSystemRepresentation(kCFAllocatorDefault, out.encode("utf-8"), len(out.encode("utf-8")), False)
    dest = Quartz.CGImageDestinationCreateWithURL(outurl, "public.png", 1, None)
    Quartz.CGImageDestinationAddImage(dest, img, None)
    Quartz.CGImageDestinationFinalize(dest)
print(n)
`;

// JXA reaches the same PDFKit through osascript, which is present on every
// Mac even when PyObjC is not. It splits each page to a one-page PDF; sips
// then rasterizes it (sips only ever renders page 1 — of a one-page file
// that is the page we want).
// NB: the JXA ObjC bridge spells `writeToFile:atomically:` as
// `writeToFileAtomically` — colons dropped, parts capitalized.
const SPLIT_JXA = `ObjC.import('Foundation');
ObjC.import('Quartz');
function run(argv) {
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc.js) return '0';
  var n = Math.min(doc.pageCount, parseInt(argv[2], 10));
  for (var i = 0; i < n; i++) {
    var page = doc.pageAtIndex(i);
    var name = argv[1] + '/p' + (i + 1 < 10 ? '0' : '') + (i + 1) + '.pdf';
    page.dataRepresentation.writeToFileAtomically(name, true);
  }
  return String(n);
}
`;

/**
 * Render a PDF to per-page PNGs under `outDir`.
 * @param {string} pdfPath
 * @param {string} outDir
 * @param {{renderer: ReturnType<typeof choosePdfRenderer>, tools: object, maxPages?: number}} opts
 * @returns {Promise<{images: string[], renderer: string|null, warning: string|null}>}
 */
export async function renderPdfPages(pdfPath, outDir, { renderer, tools, maxPages = MAX_PDF_PAGES }) {
  await fs.mkdir(outDir, { recursive: true });
  const warn = renderer.warning;
  try {
    if (renderer.id === "quartz") {
      await exec(tools.quartzPython, ["-c", QUARTZ_PY, pdfPath, outDir, String(maxPages), String(PDF_RENDER_PX)], { timeout: 300_000 });
    } else if (renderer.id === "quartz-jxa") {
      const scriptPath = path.join(outDir, "_split.js");
      await fs.writeFile(scriptPath, SPLIT_JXA);
      await exec("osascript", ["-l", "JavaScript", scriptPath, pdfPath, outDir, String(maxPages)], { timeout: 300_000 });
      await fs.unlink(scriptPath).catch(() => {});
      for (const f of (await fs.readdir(outDir)).filter((f) => f.endsWith(".pdf")).sort()) {
        const single = path.join(outDir, f);
        await exec("sips", ["-s", "format", "png", "-Z", String(PDF_RENDER_PX), single, "--out", single.replace(/\.pdf$/, ".png")], { timeout: 120_000 });
        await fs.unlink(single).catch(() => {});
      }
    } else if (renderer.id === "sips") {
      await exec("sips", ["-s", "format", "png", "-Z", String(PDF_RENDER_PX), pdfPath, "--out", path.join(outDir, "p01.png")], { timeout: 120_000 });
    } else if (renderer.id === "qlmanage") {
      await exec("qlmanage", ["-t", "-s", String(PDF_RENDER_PX), "-o", outDir, pdfPath], { timeout: 120_000 });
      const made = (await fs.readdir(outDir)).find((f) => f.endsWith(".png"));
      if (made && made !== "p01.png") await fs.rename(path.join(outDir, made), path.join(outDir, "p01.png"));
    } else {
      return { images: [], renderer: null, warning: warn };
    }
  } catch (e) {
    return { images: [], renderer: renderer.id, warning: `${renderer.id} failed to render ${path.basename(pdfPath)}: ${e.message.slice(0, 200)}${warn ? ` · ${warn}` : ""}` };
  }
  const images = (await fs.readdir(outDir)).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(outDir, f));
  return { images, renderer: renderer.id, warning: warn };
}

/* --------------------------- agent contract ---------------------------- */

/** The JSON the agent must return: race.json minus everything computed. */
const CONTRACT = `{
  "name": "full official race name",
  "short": "≤8-char code used in the UI, e.g. SJS100",
  "edition_year": 2027,
  "date": "YYYY-MM-DD race-local start date, or null",
  "start_time": "HH:MM 24h local start time, or null",
  "timezone": "IANA zone of the start line, e.g. America/Denver, or null",
  "location": "start line · town, state — or null",
  "format": "point_to_point | out_and_back | loop | null",
  "distance_mi": 104,
  "gain_ft": 19000,
  "elevation": { "min_ft": 8770, "max_ft": 12438, "avg_ft": 10282, "altitude_significant": true },
  "cutoff_h": 38,
  "features": { "crew": true, "drop_bags": true, "pacers": true, "night": true, "heat": false, "altitude": true, "water_crossings": true },
  "aid_stations": [
    { "name": "Cross Mountain", "total_mi": 45.8, "seg_mi": 8.2, "cutoff_h": null, "cutoff_clock": "22:00",
      "crew": true, "crew_only": false, "drop_bag": true, "pacers": true, "water_only": false,
      "menu": "full | basic | backcountry", "notes": "" }
  ],
  "race_climbs": [{ "id": "kennebec", "label": "Kennebec Pass", "approx_mi": [6, 12] }],
  "crew_info": { "rules": [], "cell_strategy": "", "station_notes": { "Cross Mountain": "" }, "start_notes": "", "driving": {} },
  "coach_notes": { "terrain": "", "climate": "", "altitude": "", "key_demands": "", "race_week": "" },
  "links": { "site": "", "manual": "", "gpx": "", "tracking": "", "results": "", "map": "" },
  "visual": { "theme_preset": "basecamp-default | desert | alpine | forest | night" },
  "field_sources": { "aid_stations": "runner-manual-2026.pdf p11", "cutoff_h": "sanjuansoftie.com/course" },
  "unresolved": ["date", "aid_stations[3].cutoff_h"],
  "review_notes": "one paragraph for the human reviewer: what was transcribed from an image, what is a prior-year figure, what to double-check"
}`;

const SYSTEM_PROMPT = `You are the race-intake agent inside Basecamp, a personal ultra-training dashboard.

Your job: read a trail ultramarathon's own sources — its website, its runner manual, its
GPX, its results and tracking pages — and return ONE JSON object describing the race.

THE PRIME RULE: never invent a fact. Every number and flag you emit must trace to something
you actually read. If a source does not say, the field is null AND its path is listed in
"unresolved". A plausible guess is worse than a null here: a null gets reviewed, a guess
gets trained on. This includes dates — if the site says "August, 2027" without a day, the
date is null and "date" goes in unresolved. Do not compute "the second Friday".

PRIOR EDITIONS: you are often given last year's manual for a future edition. Course facts
(distance, gain, elevation, aid stations, cutoffs, crew rules) carry over unless the site
says otherwise — use them, and say so in review_notes. Edition-specific facts (the date,
registration, the exact cutoff clock times) do NOT carry over: take them from the site for
the requested year, or leave them null.

THE RACE NAME is what the organizer calls the event, not the page title or the tagline.
Drop a trailing generic race-type word ("Ultramarathon", "Trail Race", "Endurance Run") when
the name already states the distance — "San Juan Softie 100", not "San Juan Softie 100 Mile
Ultramarathon". The folder the owner lives with is named from it.

AID STATIONS ARE THE SPINE. Transcribe the aid chart station by station, in course order,
with the mile each one sits at. Charts are often IMAGES in the PDF — you will be given
per-page PNGs; Read the page images and transcribe the table cell by cell. Do not skip a
station because a column is unreadable: emit the station and list the unreadable field in
unresolved. total_mi must increase down the list, and cutoff_h (elapsed hours from the
start) must never go backwards. When the manual gives clock times, fill cutoff_clock AND
derive cutoff_h from the start time; if the two disagree, keep both and say so in
review_notes.

cutoff_h IS A CUTOFF, NEVER AN ELAPSED TIME. A station with no posted cutoff — including the
start line, which cannot have one — is null, NOT 0. Emitting 0 says "you are timed out the
moment the gun goes off", and the schema rejects it. Include the start and the finish as
stations (the course needs both ends); the start's cutoff_h and cutoff_clock are null unless
the manual really does post one.

WHAT YOU MUST NOT EMIT: sun times, aid-station lat/lon, and climb metrics (gain, grade,
length). Those are computed later from the GPX by a different tool. Give race_climbs only
as named windows: id, label (a place name — never a number or a gain figure), and
approximate start/end mile.

FEATURES drive which panels the dashboard shows: crew (is crew access allowed anywhere),
drop_bags, pacers, night (will mid-pack runners run in the dark), heat (is heat a real
factor — a high alpine August race usually is NOT), altitude, water_crossings.

COACH NOTES are prose the coach model will receive verbatim. Write them for a runner
training for this race: terrain, climate, altitude, key_demands, race_week. 2-4 sentences
each, specific to this course, no filler. Empty string if you have nothing grounded to say.

OUTPUT: respond with ONLY the JSON object — no prose outside it, no markdown fences. Use
exactly these keys:

${CONTRACT}`;

/**
 * The per-run prompt: what to look at and where it already is on disk.
 * @returns {string}
 */
function buildPrompt({ siteUrl, extraUrls, year, notes, manifest, images, gpxSummary, sourcesDir }) {
  // Split the cache by how the agent should actually open it. A cached page
  // is RAW site source — a Squarespace homepage is ~700 KB of boilerplate and
  // reading it costs several turns for nothing, whereas WebFetch returns the
  // same page already reduced to text. Files (PDF, GPX) are the opposite:
  // they are on disk, and fetching them again would only re-download them.
  const pages = manifest.filter((m) => m.file && m.kind === "url");
  const files = manifest.filter((m) => m.file && m.kind !== "url");
  const cached = [
    pages.length
      ? `  WebFetch these (cached raw HTML is at the path in brackets if a fetch fails):\n${pages.map((m) => `    · ${m.role}: ${m.ref}  [${path.join(sourcesDir, m.file)}]`).join("\n")}`
      : "",
    files.length
      ? `  Files already on disk (Read these — do not re-download):\n${files.map((m) => `    · ${m.role}: ${m.ref}\n        ${path.join(sourcesDir, m.file)}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n");
  const failed = manifest.filter((m) => !m.file).map((m) => `  · ${m.ref} — ${m.error}`).join("\n");
  const imgList = images.length
    ? images.map((g) => `  · ${g.label} (${g.images.length} page image${g.images.length === 1 ? "" : "s"}):\n${g.images.map((p) => `      ${p}`).join("\n")}`).join("\n")
    : "  (none — no PDF was rendered; see the warnings below)";
  return `Build the race.json draft for the ${year} edition of the race at ${siteUrl}.

${extraUrls.length ? `Additional URLs the owner supplied:\n${extraUrls.map((u) => `  · ${u}`).join("\n")}\n` : ""}
SOURCES ALREADY FETCHED AND CACHED:
${cached || "  (nothing cached — fetch the site yourself with WebFetch)"}
${failed ? `\nSOURCES THAT FAILED TO FETCH (use WebFetch on them yourself if they matter):\n${failed}\n` : ""}
PDF PAGE IMAGES — Read these to transcribe charts that are images rather than text:
${imgList}

${gpxSummary ? `GPX SANITY CHECK (parsed locally, for cross-checking your aid list — do NOT copy coordinates into your output):\n${gpxSummary}\n` : ""}
You may also use WebFetch and WebSearch for anything the cache is missing — the race's own
site first, then the results/tracking hosts. Do not take course facts from third-party
aggregators when the organizer's own pages say something different.

${notes ? `WHAT THE OWNER SAID MATTERS TO THEM:\n${notes}\n` : ""}
Work through the aid chart carefully — it is the part the human reviewer will check first.
Then return the single JSON object per the contract in your system prompt, with
"edition_year": ${year}. Anything you could not establish: null, and named in "unresolved".`;
}

/* --------------------------- draft validation -------------------------- */

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check the agent's raw output against the intake contract, BEFORE it is
 * shaped into a race.json. This catches the two failures the schema validator
 * cannot: a missing contract key (the agent answered a different question),
 * and a computed field the agent was told never to emit (it guessed at
 * coordinates or sun times, which would silently outrank the real course build).
 * @param {unknown} draft
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateAgentDraft(draft) {
  const errors = [];
  if (!isObj(draft)) return { ok: false, errors: ["agent output must be a JSON object"] };
  for (const k of ["name", "short", "aid_stations"]) {
    if (draft[k] === undefined) errors.push(`${k}: required by the intake contract`);
  }
  if (draft.name !== undefined && (typeof draft.name !== "string" || !draft.name.trim())) {
    errors.push("name: non-empty string required (the folder slug is derived from it)");
  }
  if (draft.short !== undefined && (typeof draft.short !== "string" || !draft.short.trim())) {
    errors.push("short: non-empty string required");
  }
  if (draft.sun !== undefined) errors.push("sun: computed from the course build — the agent must not emit it");
  if (draft.unresolved !== undefined && (!Array.isArray(draft.unresolved) || draft.unresolved.some((u) => typeof u !== "string"))) {
    errors.push("unresolved: array of field paths required");
  }
  if (draft.field_sources !== undefined && !isObj(draft.field_sources)) {
    errors.push("field_sources: object keyed by field name required");
  }
  if (!Array.isArray(draft.aid_stations) || draft.aid_stations.length === 0) {
    errors.push("aid_stations: non-empty array required — the course has no spine without it");
  } else {
    draft.aid_stations.forEach((s, i) => {
      if (!isObj(s)) { errors.push(`aid_stations[${i}]: object required`); return; }
      if (s.lat !== undefined || s.lon !== undefined) {
        errors.push(`aid_stations[${i}]: lat/lon are snapped from the GPX by the course build — the agent must not emit them`);
      }
      // 0 is the one number that cannot be a cutoff: it reads as "timed out at
      // the gun". It turns up when a chart's start row is transcribed as an
      // elapsed time, and without this the schema rejects the whole draft
      // several steps later with a much vaguer complaint.
      if (s.cutoff_h === 0) {
        errors.push(`aid_stations[${i}] (${s.name ?? "?"}): cutoff_h 0 is an elapsed time, not a cutoff — a station with no posted cutoff is null`);
      }
    });
  }
  if (draft.race_climbs !== undefined) {
    if (!Array.isArray(draft.race_climbs)) errors.push("race_climbs: array required");
    else draft.race_climbs.forEach((c, i) => {
      if (isObj(c) && (c.gain_ft !== undefined || c.grade_pct !== undefined || c.len_mi !== undefined)) {
        errors.push(`race_climbs[${i}]: climb metrics are computed from the GPX — emit only id, label and approx_mi`);
      }
    });
  }
  return { ok: errors.length === 0, errors };
}

/** Read `a.b[2].c` out of an object; undefined when the path does not exist. */
function valueAtPath(obj, pathStr) {
  let cur = obj;
  for (const part of String(pathStr).split(".")) {
    const m = /^([A-Za-z0-9_]+)((?:\[\d+\])*)$/.exec(part);
    if (!m || !isObj(cur) && !Array.isArray(cur)) return undefined;
    cur = cur?.[m[1]];
    for (const idx of m[2].match(/\d+/g) ?? []) cur = cur?.[Number(idx)];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** The top-level field a validator error is about ("aid_stations[3].cutoff_h" → path). */
function errorFieldPath(message) {
  const m = /^([A-Za-z0-9_]+(?:\[\d+\])?(?:\.[A-Za-z0-9_]+)?)/.exec(message);
  return m ? m[1] : null;
}

/**
 * Schema errors that a DRAFT is allowed to carry: a field the agent honestly
 * could not establish is null and named in unresolved[], and the review dialog
 * is where a human fills it. Everything else still aborts the write — a draft
 * with a malformed date is a bug, a draft with no date is a known unknown.
 * @param {object} race the assembled race.json
 * @param {string[]} unresolved
 * @returns {{errors: string[], excused: string[]}}
 */
export function draftValidationErrors(race, unresolved) {
  const { errors } = validateRaceJson(race);
  const known = new Set(unresolved);
  const out = { errors: [], excused: [] };
  for (const message of errors) {
    const field = errorFieldPath(message);
    const top = field ? field.split(/[.[]/)[0] : null;
    const excusable = field && top && !NEVER_EXCUSABLE.has(top) &&
      known.has(field) && valueAtPath(race, field) === null;
    if (excusable) out.excused.push(message);
    else out.errors.push(message);
  }
  return out;
}

/**
 * Every top-level field whose value is null (or an aid-station field that is),
 * merged with what the agent itself flagged. The agent's list is a claim; this
 * makes it complete, so the review dialog can never miss a hole.
 * @param {object} race
 * @param {string[]} [agentUnresolved]
 * @returns {string[]} sorted, de-duplicated field paths
 */
export function collectUnresolved(race, agentUnresolved = []) {
  const found = new Set(agentUnresolved.filter((u) => typeof u === "string" && u.trim()));
  for (const [k, v] of Object.entries(race)) {
    if (v === null) found.add(k);
  }
  for (const [k, v] of Object.entries(race.elevation ?? {})) {
    if (v === null) found.add(`elevation.${k}`);
  }
  (race.aid_stations ?? []).forEach((s, i) => {
    for (const [k, v] of Object.entries(s ?? {})) {
      if (v === null && k !== "cutoff_h" && k !== "cutoff_clock") found.add(`aid_stations[${i}].${k}`);
    }
  });
  return [...found].sort();
}

/**
 * Shape the agent's draft into a race.json: our fields (schema_version, slug,
 * status), the agent's fields as given, per-field provenance, and the source
 * list. Nothing is filled in on the agent's behalf — a null stays null.
 * @param {object} draft the validated agent output
 * @param {{slug: string, year: number, manifest: object[], at?: string}} ctx
 * @returns {object} race.json
 */
export function buildRaceJson(draft, { slug, year, manifest = [], at = new Date().toISOString() }) {
  const agentFields = [
    "name", "short", "date", "start_time", "timezone", "location", "format",
    "distance_mi", "gain_ft", "elevation", "cutoff_h", "features", "aid_stations",
    "race_climbs", "crew_info", "coach_notes", "links", "visual",
  ];
  const race = {
    schema_version: RACE_SCHEMA_VERSION,
    slug,
    // A draft is inert: no view reads it and the active-race pointer is never
    // touched. Activation is a human action in the review dialog.
    status: "draft",
    edition_year: Number(draft.edition_year ?? year),
  };
  const provenance = {};
  for (const field of agentFields) {
    if (!(field in draft)) continue;
    race[field] = draft[field];
    provenance[field] = {
      by: PROVENANCE_BY,
      at,
      source: typeof draft.field_sources?.[field] === "string" ? draft.field_sources[field] : "race-intake",
    };
  }
  provenance.edition_year = { by: PROVENANCE_BY, at, source: "intake request" };
  race.provenance = provenance;
  race.sources = manifest
    .filter((m) => m.file || m.status === 200)
    .map((m) => ({ kind: m.kind, ref: m.ref, fetched_at: m.fetched_at, file: m.file ?? null }));
  if (typeof draft.review_notes === "string" && draft.review_notes.trim()) {
    race.review_notes = draft.review_notes.trim();
  }
  return race;
}

/* ------------------------------ the run -------------------------------- */

/** Short human summary of a GPX so the agent can cross-check its aid list. */
function summarizeGpx(text) {
  const { waypoints, track } = parseGpx(text);
  if (!track.length && !waypoints.length) return null;
  const miles = track.length ? track[track.length - 1].cum_mi.toFixed(1) : "?";
  const names = waypoints.slice(0, 40).map((w) => w.name).filter(Boolean);
  return `  track: ${track.length} points, ${miles} mi end to end\n  waypoints (${waypoints.length}): ${names.join(", ") || "none named"}`;
}

/**
 * Run the intake: fetch sources → render PDFs → agent → validate → write
 * races/<slug>/race.json as a draft.
 *
 * @param {object} opts
 * @param {string} opts.root repo root
 * @param {string} opts.siteUrl the race's own site (required)
 * @param {string[]} [opts.extraUrls]
 * @param {number|string} opts.year edition year
 * @param {{name: string, path: string}[]} [opts.uploads] PDFs/GPX already on disk (copied, never moved)
 * @param {string} [opts.notes] the owner's "what matters to me"
 * @param {boolean} [opts.refresh] allow an existing slug to be overwritten
 * @param {string} [opts.slugHint] the folder to write, when the caller already
 *   knows it (re-intake). Checked BEFORE the agent runs so an existing race
 *   refuses in a second rather than after a ten-minute read, and it WINS over
 *   the name the agent derives — the caller owns the folder's identity.
 * @param {(e: {step: string, status: string, message?: string}) => void} [opts.onProgress]
 * @param {number} [opts.maxPages] fetch cap
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.timeoutSec]
 * @param {string} [opts.model]
 * @returns {Promise<{slug: string, dir: string, unresolved: string[], race: object, warnings: string[], agent: object}>}
 */
export async function runIntake({
  root,
  siteUrl,
  extraUrls = [],
  year,
  uploads = [],
  notes = "",
  refresh = false,
  slugHint = null,
  onProgress = () => {},
  maxPages = MAX_FETCH_PAGES,
  maxTurns = INTAKE_MAX_TURNS,
  timeoutSec = INTAKE_TIMEOUT_SEC,
  model = agentModel(),
}) {
  if (!root) throw new Error("runIntake: root is required");
  if (!siteUrl || !/^https?:\/\//i.test(siteUrl)) throw new Error("runIntake: siteUrl must be an http(s) URL");
  if (!/^\d{4}$/.test(String(year))) throw new Error(`runIntake: year must be a 4-digit year (got ${JSON.stringify(year)})`);
  const warnings = [];
  const say = (step, message, extra = {}) => onProgress({ step, status: "log", message, ...extra });
  // Fail fast when the caller already knows the folder: the alternative is
  // spending the whole agent run and refusing afterwards.
  if (slugHint) await assertSlugAvailable(root, slugHint, { refresh });

  // Stage everything in a temp dir: the folder name depends on the race NAME,
  // which only the agent can tell us. The cache moves into races/<slug>/sources/
  // once we know where it belongs.
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "basecamp-intake-"));
  const sourcesDir = path.join(staging, "sources");
  await fs.mkdir(sourcesDir, { recursive: true });
  // Set when a failure left the only copy of the agent's output in staging.
  let keepStaging = false;

  try {
    /* 1. fetch + cache */
    onProgress({ step: "fetch", status: "start", label: "fetching sources" });
    const manifest = await cacheSources({ sourcesDir, siteUrl, extraUrls, maxPages, onProgress });

    /* uploads: copied in, never moved — the owner's file stays where it was */
    const uploadDir = path.join(sourcesDir, "uploads");
    if (uploads.length) await fs.mkdir(uploadDir, { recursive: true });
    for (const up of uploads) {
      const name = path.basename(up.name || up.path);
      const dest = path.join(uploadDir, name);
      await fs.copyFile(up.path, dest);
      const bytes = (await fs.stat(dest)).size;
      manifest.push({
        kind: PDF_RE.test(name) ? "pdf" : GPX_RE.test(name) ? "gpx" : "url",
        role: "upload",
        ref: name,
        file: path.join("uploads", name),
        status: null,
        content_type: null,
        bytes,
        fetched_at: new Date().toISOString(),
        error: null,
      });
      say("fetch", `uploaded ${name} (${(bytes / 1024).toFixed(0)} KB)`);
    }
    onProgress({ step: "fetch", status: "done", count: manifest.length });

    /* 2. PDFs → per-page PNGs */
    onProgress({ step: "render", status: "start", label: "rendering PDF pages" });
    const tools = await detectPdfTools();
    const pdfs = manifest.filter((m) => m.file && (m.kind === "pdf" || PDF_RE.test(m.file)));
    const images = [];
    let rendererUsed = null;
    // The runner manual routinely arrives twice — linked from the site AND
    // uploaded by the owner. Rendering both hands the agent two identical
    // stacks of page images and invites it to spend turns on the copy.
    const seenPdfs = new Map();
    for (const entry of pdfs) {
      const pdfPath = path.join(sourcesDir, entry.file);
      const buf = await fs.readFile(pdfPath);
      const digest = crypto.createHash("sha256").update(buf).digest("hex");
      if (seenPdfs.has(digest)) {
        entry.duplicate_of = seenPdfs.get(digest);
        say("render", `${path.basename(entry.file)}: byte-identical to ${seenPdfs.get(digest)} — not rendered twice`);
        continue;
      }
      seenPdfs.set(digest, entry.file);
      const pageCount = pdfPageCount(buf);
      const renderer = choosePdfRenderer({ pageCount, tools });
      const outDir = path.join(sourcesDir, "pages", kebab(path.basename(entry.file, ".pdf")));
      say("render", `${path.basename(entry.file)}: ${pageCount} page(s) via ${renderer.id ?? "no renderer"}`);
      const result = await renderPdfPages(pdfPath, outDir, { renderer, tools });
      rendererUsed = rendererUsed ?? result.renderer;
      if (result.warning) {
        warnings.push(result.warning);
        say("render", `  ⚠ ${result.warning}`, { stream: "err" });
      }
      if (result.images.length) images.push({ label: entry.ref, images: result.images });
      entry.pages_rendered = result.images.length;
      entry.page_count = pageCount;
    }
    if (!pdfs.length) say("render", "no PDFs to render");
    onProgress({ step: "render", status: "done", renderer: rendererUsed });

    /* 3. GPX sanity check — the matcher is stage 2; this is only a cross-check
          the agent can hold its aid list against. */
    let gpxSummary = null;
    const gpxEntry = manifest.find((m) => m.file && (m.kind === "gpx" || GPX_RE.test(m.file)));
    if (gpxEntry) {
      try {
        gpxSummary = summarizeGpx(await fs.readFile(path.join(sourcesDir, gpxEntry.file), "utf8"));
        say("render", `gpx: ${gpxSummary?.split("\n")[0].trim() ?? "unreadable"}`);
      } catch (e) {
        warnings.push(`GPX ${gpxEntry.ref} could not be parsed: ${e.message}`);
      }
    }

    /* 4. the agent */
    onProgress({ step: "agent", status: "start", label: "reading sources with the intake agent" });
    const prompt = buildPrompt({ siteUrl, extraUrls, year, notes, manifest, images, gpxSummary, sourcesDir });
    const { text, wrapper, retried } = await runClaudeJson({
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      allowedTools: ["WebFetch", "WebSearch", "Read"],
      maxTurns,
      timeoutSec,
      cwd: root,
      model,
      // A blown turn budget on a 100-mile aid chart means "emit what you have
      // and mark the rest unresolved", which is exactly the contract anyway.
      retryNudge: "\n\nIMPORTANT: the previous attempt ran out of tool calls before answering. Do NOT open anything else. Return the JSON object NOW from what you have already read, with every field you could not establish set to null and named in \"unresolved\".",
      retryMaxTurns: 4,
      onNotice: (m) => { warnings.push(m); say("agent", m, { stream: "err" }); },
    });
    say("agent", `agent finished: ${wrapper.numTurns ?? "?"} turns${wrapper.costUsd != null ? ` · $${wrapper.costUsd.toFixed(4)}` : ""}${retried ? " (after one retry)" : ""}`);

    /* 5. validate, then write */
    onProgress({ step: "validate", status: "start", label: "validating the draft" });
    // Nothing below may throw without first parking the agent's output
    // somewhere readable — a run that cost ten minutes and a chunk of the
    // owner's session budget must not evaporate into a deleted temp dir.
    const abort = async (slugForOutput, reason, message) => {
      const where = await saveRawOutput({ root, slug: slugForOutput, staging, sourcesDir, raw: text, reason });
      if (where.kept) keepStaging = true;
      throw new Error(`${message}\n(raw agent output saved to ${where.path})`);
    };

    let draft;
    let slug = null;
    try {
      draft = extractJson(text);
    } catch (e) {
      await abort(slugHint ?? fallbackSlug(siteUrl, year), e.message, `intake agent did not return JSON: ${e.message}`);
    }
    slug = slugHint ?? (typeof draft.name === "string" && draft.name.trim()
      ? deriveSlug(draft.name, year)
      : fallbackSlug(siteUrl, year));

    const contract = validateAgentDraft(draft);
    if (!contract.ok) {
      await abort(slug, contract.errors.join("; "), `intake agent output failed the contract:\n  · ${contract.errors.join("\n  · ")}`);
    }

    await assertSlugAvailable(root, slug, { refresh });

    const race = buildRaceJson(draft, { slug, year: Number(year), manifest });
    const unresolved = collectUnresolved(race, draft.unresolved ?? []);
    const { errors, excused } = draftValidationErrors(race, unresolved);
    if (errors.length) {
      await abort(slug, errors.join("; "), `draft failed schema validation:\n  · ${errors.join("\n  · ")}`);
    }
    for (const e of excused) say("validate", `known gap (listed unresolved): ${e}`);

    const dir = raceDir(root, slug);
    await moveSources(staging, dir);
    await writeJsonAtomic(path.join(dir, "sources", "manifest.json"), manifest);
    await writeJsonAtomic(path.join(dir, "race.json"), race);
    onProgress({ step: "validate", status: "done", slug, unresolved: unresolved.length });

    return {
      slug,
      dir,
      race,
      unresolved,
      warnings,
      manifest,
      agent: {
        model,
        num_turns: wrapper.numTurns,
        cost_usd: wrapper.costUsd,
        duration_ms: wrapper.durationMs,
        retried,
        pdf_renderer: rendererUsed,
      },
    };
  } finally {
    // The staging cache is copied into the race folder on success, and on a
    // failure whose slug names a folder we may create. When it could not be
    // (the slug is an existing race — copying would clobber ITS cache), the
    // temp dir stays put and the thrown error names it.
    if (!keepStaging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** A slug for the failure path, when the agent never gave us a usable name. */
function fallbackSlug(siteUrl, year) {
  const host = new URL(siteUrl).hostname.replace(/^www\./, "").split(".")[0];
  return deriveSlug(host || "unknown-race", year);
}

/** Copy the staged sources/ into races/<slug>/ (gitignored there). */
async function moveSources(staging, dir) {
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(path.join(staging, "sources"), path.join(dir, "sources"), { recursive: true, force: true });
}

/**
 * Validation failed: keep everything. The sources and the agent's raw output
 * land in races/<slug>/sources/ so the failure can be read rather than re-run.
 * No race.json is written — a draft that failed validation is not a draft.
 *
 * When the slug is an EXISTING race, nothing is copied: overwriting that
 * race's own source cache to report a failed intake would destroy the thing
 * the re-intake diff is supposed to compare against. The staging dir is kept
 * instead, and the caller is told where it is.
 * @returns {Promise<{path: string, kept: boolean}>} where the output ended up
 */
async function saveRawOutput({ root, slug, staging, sourcesDir, raw, reason }) {
  try {
    await fs.writeFile(path.join(sourcesDir, "agent-output.json"), raw ?? "");
    await fs.writeFile(path.join(sourcesDir, "agent-output-error.txt"), `${new Date().toISOString()}\n${reason}\n`);
    if (!(await slugExists(root, slug))) {
      await moveSources(staging, raceDir(root, slug));
      return { path: `races/${slug}/sources/agent-output.json`, kept: false };
    }
  } catch { /* best effort — the thrown error is what matters */ }
  return { path: path.join(sourcesDir, "agent-output.json"), kept: true };
}

/* -------------------------------- CLI ---------------------------------- */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const collect = (flag) => process.argv.reduce((acc, a, i) => (a === `--${flag}` && process.argv[i + 1] ? [...acc, process.argv[i + 1]] : acc), []);
  const site = arg("site", null);
  const year = arg("year", null);
  if (typeof site !== "string" || typeof year !== "string") {
    console.error("usage: node scripts/race-intake.mjs --site <url> --year <YYYY> [--url <url>]… [--upload <path>]… [--notes <text>] [--slug <slug>] [--refresh]");
    process.exit(2);
  }
  const notesArg = arg("notes", "");
  runIntake({
    root: ROOT,
    siteUrl: site,
    extraUrls: collect("url"),
    year,
    uploads: collect("upload").map((p) => ({ name: path.basename(p), path: p })),
    notes: typeof notesArg === "string" ? notesArg : "",
    refresh: arg("refresh", false) === true,
    slugHint: typeof arg("slug", null) === "string" ? arg("slug", null) : null,
    onProgress: (e) => {
      if (e.status === "start") console.log(`• ${e.label}`);
      else if (e.message) console.log(`  ${e.message}`);
    },
  })
    .then((r) => {
      console.log(`\n✓ races/${r.slug}/race.json (draft) — ${r.race.aid_stations?.length ?? 0} aid stations`);
      if (r.unresolved.length) console.log(`  unresolved (${r.unresolved.length}): ${r.unresolved.join(", ")}`);
      for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    })
    .catch((e) => { console.error(`\n✗ ${e.message || e}`); process.exit(1); });
}
