// node --test scripts/race-intake.test.mjs   (or: cd web && npm test)
//
// Covers the parts of the intake that must hold without spending an agent
// turn: the folder slug, the output contract, the draft's right to carry
// known unknowns, the existing-slug refusal, and the PDF renderer choice.
// The recorded agent output in fixtures/ is a synthetic race — nothing here
// touches the real races/ folder or the network.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRaceJson } from "./race-config.mjs";
import {
  assertSlugAvailable,
  buildRaceJson,
  choosePdfRenderer,
  classifyLink,
  collectUnresolved,
  deriveSlug,
  discoverLinks,
  draftValidationErrors,
  kebab,
  pdfPageCount,
  releaseSlugClaim,
  renderManifestPdfs,
  renderPdfPages,
  detectPdfTools,
  runIntake,
  summarizeManifestGpx,
  validateAgentDraft,
} from "./race-intake.mjs";

/** A site that fails immediately: the discard port on loopback, nothing
    listening — a runIntake test that has to reach the network fails on a
    plane (same trick scripts/race-refresh.test.mjs uses). */
const DEAD_SITE = "http://127.0.0.1:9/cinder-cone-50k";

/** The canned agent reply, in the shape runClaudeJson returns. */
const cannedAgent = (body) => async () => ({
  text: JSON.stringify(body),
  wrapper: { numTurns: 3, costUsd: 0.1, durationMs: 4000 },
  retried: false,
});

/** Same, but holds for `delayMs` first — wide enough to force two concurrent
    runIntake calls to both be mid-flight (past fetch/render, waiting on
    "the agent") at once, so their post-agent slug checks land in the same
    window instead of one call finishing outright before the other starts. */
const slowCannedAgent = (body, delayMs) => async () => {
  await new Promise((r) => setTimeout(r, delayMs));
  return { text: JSON.stringify(body), wrapper: { numTurns: 3, costUsd: 0.1, durationMs: 4000 }, retried: false };
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "race-intake-agent-output.json");

/** A fresh parse each time — every test mutates its own copy. */
async function loadDraft(over = {}) {
  return { ...JSON.parse(await fs.readFile(FIXTURE, "utf8")), ...over };
}

/** The manifest the fetch stage would have produced for that fixture. */
const MANIFEST = [
  { kind: "url", role: "page", ref: "https://example.org/cinder-cone-50k", file: "example-org-cinder-cone-50k.html", status: 200, fetched_at: "2026-09-18T00:00:00Z" },
  { kind: "pdf", role: "pdf", ref: "https://example.org/cinder-cone-50k/manual-2026.pdf", file: "manual-2026.pdf", status: 200, fetched_at: "2026-09-18T00:00:00Z" },
];

/* ------------------------------- slug ---------------------------------- */

test("deriveSlug is <kebab name>-<year>", () => {
  assert.equal(deriveSlug("San Juan Softie 100", 2027), "san-juan-softie-100-2027");
  assert.equal(deriveSlug("Cinder Cone 50K", "2027"), "cinder-cone-50k-2027");
  // punctuation and accents fold away; the slug must satisfy the schema's
  // lowercase-kebab rule or validateRaceJson rejects the whole draft
  assert.equal(deriveSlug("Ultra-Trail du Mont-Blanc®", 2027), "ultra-trail-du-mont-blanc-2027");
  assert.match(deriveSlug("The  Bear   100!!", 2026), /^[a-z0-9]+(-[a-z0-9]+)*$/);
});

test("deriveSlug does not repeat a year the name already carries", () => {
  assert.equal(deriveSlug("Softie 2027", 2027), "softie-2027");
  // a DIFFERENT year still gets appended — "Softie 2027" run as 2028 is a
  // different edition, not the same folder
  assert.equal(deriveSlug("Softie 2027", 2028), "softie-2027-2028");
});

test("deriveSlug refuses input it cannot make a folder name from", () => {
  assert.throws(() => deriveSlug("", 2027), /empty race name/);
  assert.throws(() => deriveSlug("!!!", 2027), /empty race name/);
  assert.throws(() => deriveSlug("Softie", "next year"), /4-digit year/);
});

test("kebab folds case, accents and punctuation", () => {
  assert.equal(kebab("Cañon del Río"), "canon-del-rio");
  assert.equal(kebab("  --Leading & trailing--  "), "leading-trailing");
});

/* --------------------------- link discovery ----------------------------- */

test("classifyLink recognises the source kinds the intake follows", () => {
  assert.equal(classifyLink("https://x.org/manual.pdf"), "pdf");
  assert.equal(classifyLink("https://x.org/route.gpx"), "gpx");
  assert.equal(classifyLink("https://www.gaiagps.com/datasummary/route/abc/"), "gpx");
  assert.equal(classifyLink("https://opensplittime.org/events/softie"), "results");
  assert.equal(classifyLink("https://www.maprogress.com/softie"), "tracking");
  assert.equal(classifyLink("https://x.org/aid-stations", "Aid Stations"), "page");
  // a link with nothing course-shaped about it is not worth a fetch slot
  assert.equal(classifyLink("https://x.org/shop"), null);
  assert.equal(classifyLink("mailto:rd@x.org"), null);
});

test("discoverLinks resolves relative hrefs and de-duplicates", () => {
  const html = `<a href="/course">Course</a><a href="/course#top">Course again</a>
                <a href="https://other.org/manual.pdf">Runner Manual</a>`;
  const links = discoverLinks(html, "https://x.org/info");
  assert.deepEqual(links.map((l) => l.url), ["https://x.org/course", "https://other.org/manual.pdf"]);
  assert.equal(links[1].text, "Runner Manual");
});

/* --------------------------- output contract ---------------------------- */

test("the recorded agent output satisfies the intake contract", async () => {
  const { ok, errors } = validateAgentDraft(await loadDraft());
  assert.deepEqual(errors, []);
  assert.ok(ok);
});

test("the contract rejects computed fields the agent must never invent", async () => {
  const withSun = validateAgentDraft(await loadDraft({ sun: { sunset: "20:12", sunrise: "06:18" } }));
  assert.match(withSun.errors.join(" "), /sun: computed/);

  const draft = await loadDraft();
  draft.aid_stations[1] = { ...draft.aid_stations[1], lat: 35.2, lon: -111.6 };
  assert.match(validateAgentDraft(draft).errors.join(" "), /lat\/lon are snapped/);

  const climbs = await loadDraft({ race_climbs: [{ id: "cone", label: "The Cone", approx_mi: [12, 18], gain_ft: 2200 }] });
  assert.match(validateAgentDraft(climbs).errors.join(" "), /climb metrics are computed/);
});

test("the contract rejects a zero cutoff — that is an elapsed time, not a cutoff", async () => {
  const draft = await loadDraft();
  // the shape a transcribed start row takes when the chart's first column is
  // read as "hours elapsed": the schema would reject it much later and much
  // more vaguely, after the agent run is already paid for
  draft.aid_stations[0] = { ...draft.aid_stations[0], cutoff_h: 0 };
  const { ok, errors } = validateAgentDraft(draft);
  assert.equal(ok, false);
  assert.match(errors.join(" "), /cutoff_h 0 is an elapsed time/);
  // null is the right answer for a station with no posted cutoff
  draft.aid_stations[0].cutoff_h = null;
  assert.deepEqual(validateAgentDraft(draft).errors, []);
});

test("the contract rejects an answer with no aid stations or no name", async () => {
  assert.match(validateAgentDraft(await loadDraft({ aid_stations: [] })).errors.join(" "), /no spine/);
  assert.match(validateAgentDraft(await loadDraft({ name: "  " })).errors.join(" "), /name: non-empty/);
  assert.match(validateAgentDraft("not an object").errors.join(" "), /must be a JSON object/);
});

/* ------------------------ assembly into race.json ----------------------- */

test("buildRaceJson writes a draft with agent provenance on every field it took", async () => {
  const draft = await loadDraft();
  const race = buildRaceJson(draft, { slug: "cinder-cone-50k-2027", year: 2027, manifest: MANIFEST, at: "2026-09-18T12:00:00Z" });

  assert.equal(race.schema_version, 1);
  assert.equal(race.slug, "cinder-cone-50k-2027");
  assert.equal(race.status, "draft");
  assert.equal(race.edition_year, 2027);
  // the agent's own values are carried verbatim — the intake shapes, it does
  // not second-guess
  assert.equal(race.cutoff_h, 11);
  assert.equal(race.aid_stations.length, 4);
  assert.equal(race.date, null);

  for (const field of ["name", "short", "date", "timezone", "aid_stations", "coach_notes", "links"]) {
    assert.equal(race.provenance[field].by, "agent", `${field} must be attributed to the agent`);
    assert.equal(race.provenance[field].at, "2026-09-18T12:00:00Z");
  }
  // a field the agent could attribute to a document keeps that attribution
  assert.equal(race.provenance.aid_stations.source, "manual-2026.pdf p4 (image chart)");
  assert.equal(race.provenance.name.source, "race-intake");
  // computed fields are absent, not null: the course build owns them
  assert.equal("sun" in race, false);
  assert.deepEqual(race.sources.map((s) => s.kind), ["url", "pdf"]);
  assert.equal(race.review_notes.startsWith("The aid chart is an image"), true);
});

test("buildRaceJson keeps a source whose refetch failed, marked with an error, instead of dropping it", async () => {
  const draft = await loadDraft();
  const manifest = [
    ...MANIFEST,
    { kind: "pdf", ref: "https://example.org/aid-chart.pdf", file: null, status: 503, error: "503 Service Unavailable" },
  ];
  const race = buildRaceJson(draft, { slug: "cinder-cone-50k-2027", year: 2027, manifest });
  assert.equal(race.sources.length, 3, "the failed fetch is still a source record, not silently gone");
  const failed = race.sources.find((s) => s.ref === "https://example.org/aid-chart.pdf");
  assert.ok(failed, "the manifest entry is preserved");
  assert.equal(failed.file, null);
  assert.match(failed.error, /503/);
  // the two successful entries are unaffected
  assert.equal(race.sources.filter((s) => !("error" in s)).length, 2);
});

test("buildRaceJson persists the run's warnings onto race.json — durable, not just SSE progress text", async () => {
  const draft = await loadDraft();
  const withWarnings = buildRaceJson(draft, {
    slug: "cinder-cone-50k-2027", year: 2027, manifest: MANIFEST,
    warnings: ["manual-2026.pdf: no PDF renderer on this machine — the PDF is passed as text only"],
  });
  assert.deepEqual(withWarnings.intake_warnings, ["manual-2026.pdf: no PDF renderer on this machine — the PDF is passed as text only"]);
  assert.equal(validateRaceJson(withWarnings).ok, false, "date is still null in the fixture, unrelated to this field");
  assert.deepEqual(validateRaceJson(withWarnings).errors.filter((e) => /intake_warnings/.test(e)), []);

  // no warnings at all: the key does not appear rather than an empty array —
  // consistent with review_notes and every other "only when there is
  // something to say" optional field in this file.
  const clean = buildRaceJson(draft, { slug: "cinder-cone-50k-2027", year: 2027, manifest: MANIFEST });
  assert.equal("intake_warnings" in clean, false);
});

test("a draft with a known unknown validates; the same hole unlisted does not", async () => {
  const draft = await loadDraft();
  const race = buildRaceJson(draft, { slug: "cinder-cone-50k-2027", year: 2027, manifest: MANIFEST });
  const unresolved = collectUnresolved(race, draft.unresolved);

  // date is null and the agent said so — the schema complains, the draft is
  // still writable, and the review dialog is where it gets filled
  assert.ok(unresolved.includes("date"));
  const listed = draftValidationErrors(race, unresolved);
  assert.deepEqual(listed.errors, []);
  assert.match(listed.excused.join(" "), /^date must be a YYYY-MM-DD/);

  // the same null with nothing declared is an unexplained hole, and aborts
  const silent = draftValidationErrors(race, unresolved.filter((u) => u !== "date"));
  assert.equal(silent.errors.length, 1);
  assert.match(silent.errors[0], /^date must be a YYYY-MM-DD/);
});

test("a malformed value is never excused, listed or not", async () => {
  const race = buildRaceJson(await loadDraft({ timezone: "Mountain Time" }), { slug: "cinder-cone-50k-2027", year: 2027, manifest: MANIFEST });
  const { errors } = draftValidationErrors(race, ["timezone"]);
  assert.match(errors.join(" "), /is not an IANA zone name/);
});

test("the course spine is never excusable, however loudly it is declared", async () => {
  const race = buildRaceJson(await loadDraft({ aid_stations: null }), { slug: "cinder-cone-50k-2027", year: 2027, manifest: MANIFEST });
  const { errors } = draftValidationErrors(race, ["aid_stations", "name"]);
  assert.match(errors.join(" "), /aid_stations: non-empty array required/);
});

test("collectUnresolved finds holes the agent forgot to declare", async () => {
  const draft = await loadDraft({ cutoff_h: null, unresolved: [] });
  draft.aid_stations[2] = { ...draft.aid_stations[2], menu: null };
  const race = buildRaceJson(draft, { slug: "cinder-cone-50k-2027", year: 2027, manifest: MANIFEST });
  const unresolved = collectUnresolved(race, draft.unresolved);
  assert.ok(unresolved.includes("cutoff_h"));
  assert.ok(unresolved.includes("date"));
  assert.ok(unresolved.includes("aid_stations[2].menu"));
  // a station with no cutoff is normal, not a hole
  assert.equal(unresolved.some((u) => /aid_stations\[0\]\.cutoff_h/.test(u)), false);
});

test("a fully-resolved draft passes the real schema validator untouched", async () => {
  const draft = await loadDraft({ date: "2027-09-25", unresolved: [] });
  const race = buildRaceJson(draft, { slug: "cinder-cone-50k-2027", year: 2027, manifest: MANIFEST });
  const { ok, errors } = validateRaceJson(race);
  assert.deepEqual(errors, []);
  assert.ok(ok);
});

/* --------------------------- existing slugs ----------------------------- */

test("an existing race folder is refused unless refresh is asked for", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intake-slug-"));
  try {
    const dir = path.join(root, "races", "cinder-cone-50k-2027");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "race.json"), JSON.stringify({ slug: "cinder-cone-50k-2027" }));

    await assert.rejects(
      () => assertSlugAvailable(root, "cinder-cone-50k-2027"),
      /already exists — pass refresh: true/,
    );
    // refresh is the re-intake bead's door, and it is explicit
    await assertSlugAvailable(root, "cinder-cone-50k-2027", { refresh: true });
    // a folder with no race.json is not a race — the slug is free
    await fs.mkdir(path.join(root, "races", "half-built"), { recursive: true });
    await assertSlugAvailable(root, "half-built");
    await assertSlugAvailable(root, "never-seen-2027");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("assertSlugAvailable claims a new slug atomically, and releaseSlugClaim frees it for a retry", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intake-slug-claim-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // First caller claims the slug — no race.json yet, so this is the "brand
  // new race" branch, not the existing-folder refusal above.
  await assertSlugAvailable(root, "never-claimed-2027");
  // A second, concurrent caller for the SAME not-yet-written slug must be
  // refused deterministically — this is the actual fix: a plain fs.access
  // existence check would have let both through.
  await assert.rejects(
    () => assertSlugAvailable(root, "never-claimed-2027"),
    /already exists — pass refresh: true/,
  );
  // Releasing the claim (what runIntake's `finally` does on any outcome)
  // frees the slug again for a genuine retry — the claim must not outlive
  // its run and block one forever.
  await releaseSlugClaim(root, "never-claimed-2027");
  await assertSlugAvailable(root, "never-claimed-2027");
});

/* ---------------------------- PDF rendering ----------------------------- */

test("choosePdfRenderer prefers a whole-document renderer for a multipage PDF", () => {
  const all = { sips: true, quartz: true, jxa: true, qlmanage: true };
  assert.equal(choosePdfRenderer({ pageCount: 13, tools: all }).id, "quartz");
  assert.equal(choosePdfRenderer({ pageCount: 13, tools: all }).scope, "all");

  // sips is present and first in the bead's order, but it can only render
  // page 1 — and the aid chart is on page 11. Whole-document wins.
  const noPyObjC = { sips: true, quartz: false, jxa: true, qlmanage: true };
  assert.equal(choosePdfRenderer({ pageCount: 13, tools: noPyObjC }).id, "quartz-jxa");
});

test("choosePdfRenderer falls back to page 1 with a warning that says so", () => {
  const pageOneOnly = { sips: true, quartz: false, jxa: false, qlmanage: true };
  const r = choosePdfRenderer({ pageCount: 13, tools: pageOneOnly });
  assert.equal(r.id, "sips");
  assert.equal(r.scope, "first");
  assert.match(r.warning, /only render page 1 of 13/);

  const ql = choosePdfRenderer({ pageCount: 13, tools: { qlmanage: true } });
  assert.equal(ql.id, "qlmanage");
  assert.match(ql.warning, /image-only aid chart/);
});

test("choosePdfRenderer uses sips for a single page and gives up honestly with nothing", () => {
  assert.equal(choosePdfRenderer({ pageCount: 1, tools: { sips: true, quartz: true } }).id, "sips");
  const none = choosePdfRenderer({ pageCount: 9, tools: {} });
  assert.equal(none.id, null);
  assert.equal(none.scope, "none");
  assert.match(none.warning, /no PDF renderer/);
});

/** The smallest PDF that is still a real PDF: one page, one text line. */
function miniPdf(pages = 1) {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  const objs = [`<</Type/Catalog/Pages 2 0 R>>`, `<</Type/Pages/Kids[${kids}]/Count ${pages}>>`];
  for (let i = 0; i < pages; i++) {
    const text = `BT /F1 18 Tf 15 50 Td (AID ${i + 1}) Tj ET`;
    objs.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 120]/Contents ${4 + i * 2} 0 R/Resources<</Font<</F1 ${2 + pages * 2 + 1} 0 R>>>>>>`);
    objs.push(`<</Length ${text.length}>>stream\n${text}\nendstream`);
  }
  objs.push(`<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`);
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

test("pdfPageCount reads the page count out of the PDF itself", () => {
  assert.equal(pdfPageCount(miniPdf(1)), 1);
  assert.equal(pdfPageCount(miniPdf(4)), 4);
  // not a PDF at all: never zero, so the caller still tries one page
  assert.equal(pdfPageCount(Buffer.from("not a pdf")), 1);
});

test("the chosen renderer actually produces page PNGs on this machine", async (t) => {
  const tools = await detectPdfTools();
  const renderer = choosePdfRenderer({ pageCount: 2, tools });
  if (!renderer.id) {
    t.skip("no PDF renderer on this machine (sips / PyObjC Quartz / osascript+Quartz / qlmanage all absent)");
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intake-render-"));
  try {
    const pdfPath = path.join(dir, "mini.pdf");
    await fs.writeFile(pdfPath, miniPdf(2));
    const out = await renderPdfPages(pdfPath, path.join(dir, "pages"), { renderer, tools });
    assert.equal(out.images.length > 0, true, `no images: ${out.warning ?? "no warning given"}`);
    // a whole-document renderer must give us BOTH pages — the page-1-only
    // fallbacks are the ones that warn
    if (renderer.scope === "all") assert.equal(out.images.length, 2);
    for (const img of out.images) assert.ok((await fs.stat(img)).size > 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("renderManifestPdfs persists a failing renderer's warning onto the manifest entry, not just the transient log", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intake-render-fail-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sourcesDir = path.join(dir, "sources");
  await fs.mkdir(sourcesDir, { recursive: true });
  await fs.writeFile(path.join(sourcesDir, "manual-2026.pdf"), miniPdf(3));

  const manifest = [
    { kind: "pdf", ref: "https://example.org/manual-2026.pdf", file: "manual-2026.pdf", status: 200 },
  ];
  // tools: {} forces choosePdfRenderer to give up honestly — no sips, no
  // Quartz, no osascript, no qlmanage — deterministically, on any machine.
  const said = [];
  const { images, warnings, rendererUsed } = await renderManifestPdfs(manifest, {
    sourcesDir,
    tools: {},
    say: (m) => said.push(m),
  });

  assert.equal(images.length, 0);
  assert.equal(rendererUsed, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no PDF renderer on this machine/);
  // the durable half: the manifest entry itself, not just the returned
  // (equally transient) warnings array — this is what a reviewer opening
  // sources/manifest.json later actually sees.
  assert.equal(manifest[0].warning, warnings[0]);
  assert.equal(manifest[0].pages_rendered, 0);
  assert.equal(manifest[0].page_count, 3);
  assert.ok(said.some((m) => /⚠/.test(m)), "the failure is also surfaced as progress text");
});

test("renderManifestPdfs clears a prior warning on a manifest entry that DOES render", async (t) => {
  const tools = await detectPdfTools();
  const renderer = choosePdfRenderer({ pageCount: 1, tools });
  if (!renderer.id || renderer.scope !== "all") {
    return t.skip("needs a renderer with no page-1-only warning on this machine");
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intake-render-ok-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sourcesDir = path.join(dir, "sources");
  await fs.mkdir(sourcesDir, { recursive: true });
  await fs.writeFile(path.join(sourcesDir, "manual.pdf"), miniPdf(1));

  const manifest = [{ kind: "pdf", ref: "https://example.org/manual.pdf", file: "manual.pdf", status: 200 }];
  const { warnings } = await renderManifestPdfs(manifest, { sourcesDir, tools });
  assert.deepEqual(warnings, []);
  assert.equal(manifest[0].warning, null);
  assert.equal(manifest[0].pages_rendered, 1);
});

test("summarizeManifestGpx persists a read/parse failure onto the manifest entry", async (t) => {
  // parseGpx (aid-match.mjs) is a lenient regex scan that never throws on bad
  // XML — the realistic failure this catches is the file not being where the
  // manifest says it is (a moved/renamed cache entry, a permissions error).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intake-gpx-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sourcesDir = path.join(dir, "sources");
  await fs.mkdir(sourcesDir, { recursive: true });
  // route.gpx is deliberately never written — the manifest names a file that
  // is not on disk.

  const manifest = [{ kind: "gpx", ref: "https://example.org/route.gpx", file: "route.gpx", status: 200 }];
  const { gpxSummary, warning } = await summarizeManifestGpx(manifest, { sourcesDir });

  assert.equal(gpxSummary, null);
  assert.match(warning, /GPX https:\/\/example\.org\/route\.gpx could not be parsed/);
  assert.equal(manifest[0].warning, warning, "the failure survives on the manifest entry, not just the return value");
});

test("summarizeManifestGpx leaves the manifest entry alone when nothing is wrong", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intake-gpx-ok-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sourcesDir = path.join(dir, "sources");
  await fs.mkdir(sourcesDir, { recursive: true });
  const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>` +
    `<trkpt lat="37.0" lon="-107.8"><ele>2600</ele></trkpt>` +
    `<trkpt lat="37.01" lon="-107.81"><ele>2650</ele></trkpt>` +
    `</trkseg></trk></gpx>`;
  await fs.writeFile(path.join(sourcesDir, "route.gpx"), gpx);

  const manifest = [{ kind: "gpx", ref: "https://example.org/route.gpx", file: "route.gpx", status: 200 }];
  const { warning } = await summarizeManifestGpx(manifest, { sourcesDir });
  assert.equal(warning, null);
  assert.equal("warning" in manifest[0], false);
});

test("summarizeManifestGpx is a no-op when the manifest has no GPX", async () => {
  const result = await summarizeManifestGpx([{ kind: "url", ref: "x", file: "x.html" }], { sourcesDir: "/nonexistent" });
  assert.deepEqual(result, { gpxSummary: null, warning: null });
});

/* ------------------------------ runIntake -------------------------------- */

test("renderPdfPages: quartz-jxa on a PDF it cannot open synthesizes a warning instead of reading as success", async (t) => {
  const tools = await detectPdfTools();
  if (!tools.jxa) return t.skip("osascript/Quartz JXA not available on this machine");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intake-jxa-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, "garbage.pdf");
  // Not a PDF at all — PDFKit's initWithURL gives back a doc whose `.js` is
  // false, and SPLIT_JXA's own guard (`if (!doc.js) return '0'`) exits 0
  // with zero pages split. pdfPageCount is heuristic and never returns 0,
  // so choosing quartz-jxa for it is exactly what a real corrupt/encrypted
  // upload would trigger.
  await fs.writeFile(pdfPath, "this is not a pdf at all, just bytes\n".repeat(20));

  const out = await renderPdfPages(pdfPath, path.join(dir, "pages"), {
    renderer: { id: "quartz-jxa", scope: "all", warning: null },
    tools,
    pageCount: 3,
  });
  assert.deepEqual(out.images, []);
  assert.match(out.warning ?? "", /produced 0 of its 3 page/);
});

test("renderPdfPages: quartz-jxa does not synthesize a warning when pageCount is not given", async (t) => {
  const tools = await detectPdfTools();
  if (!tools.jxa) return t.skip("osascript/Quartz JXA not available on this machine");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "intake-jxa-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, "garbage.pdf");
  await fs.writeFile(pdfPath, "this is not a pdf at all, just bytes\n".repeat(20));

  // Same unopenable file, but the caller did not pass pageCount — without
  // something to compare 0 images against, the check must not fire blind.
  const out = await renderPdfPages(pdfPath, path.join(dir, "pages"), {
    renderer: { id: "quartz-jxa", scope: "all", warning: null },
    tools,
  });
  assert.deepEqual(out.images, []);
  assert.equal(out.warning, null);
});

test("runIntake writes race.unresolved onto the file — the field its own consumers assume is there", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "intake-run-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const draft = await loadDraft({ cutoff_h: null, unresolved: ["cutoff_h"] });

  const { race, unresolved } = await runIntake({
    root: tmp,
    siteUrl: DEAD_SITE,
    year: 2027,
    runAgent: cannedAgent(draft),
  });

  assert.ok(unresolved.includes("cutoff_h"));
  assert.ok(unresolved.includes("date"), "an unclaimed null is still found");
  // the actual bug: race.unresolved existing on the object AND surviving the
  // write to disk, not just the function's separate return value
  assert.deepEqual(race.unresolved, unresolved);
  const onDisk = JSON.parse(await fs.readFile(path.join(tmp, "races", race.slug, "race.json"), "utf8"));
  assert.deepEqual(onDisk.unresolved, unresolved);
});

test("runIntake: a late slug collision (post-agent) is parked through the abort net, not deleted", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "intake-run-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  // The fixture's name derives to cinder-cone-50k-2027 (deriveSlug tests
  // above pin this) — pre-occupy that folder so the check AFTER the agent
  // call collides, the same way an unrelated earlier intake would.
  await fs.mkdir(path.join(tmp, "races", "cinder-cone-50k-2027"), { recursive: true });
  await fs.writeFile(path.join(tmp, "races", "cinder-cone-50k-2027", "race.json"), "{}");

  const draft = await loadDraft();
  const err = await runIntake({ root: tmp, siteUrl: DEAD_SITE, year: 2027, runAgent: cannedAgent(draft) })
    .then(() => null, (e) => e);
  assert.ok(err, "the collision must reject");
  assert.match(err.message, /already exists/);
  assert.match(err.message, /raw agent output saved to/);

  // the collision means moveSources into races/<slug>/ is refused (that
  // folder is somebody else's cache) — the raw output stays in staging,
  // which the abort net must NOT have deleted.
  const match = /raw agent output saved to (.+)\)$/.exec(err.message);
  assert.ok(match, "the error names where the raw output landed");
  assert.equal(await fs.readFile(match[1], "utf8").then(() => true, () => false), true, `${match[1]} must actually exist`);
});

test("runIntake: two concurrent runs deriving the same NEW slug — only one writes, the other is parked through the abort net", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "intake-run-concurrent-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const draft = await loadDraft(); // both runs derive the same slug: cinder-cone-50k-2027

  // Two independent runIntake calls, each with its own injected runner (the
  // shape a "New race…" submitted twice from two tabs would produce, or two
  // trivially-different URLs for the same event) — nothing here reaches a
  // real agent or the network (DEAD_SITE, per the file header).
  const results = await Promise.allSettled([
    runIntake({ root: tmp, siteUrl: DEAD_SITE, year: 2027, runAgent: slowCannedAgent(draft, 30) }),
    runIntake({ root: tmp, siteUrl: DEAD_SITE, year: 2027, runAgent: slowCannedAgent(draft, 30) }),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, `expected exactly one winner: ${JSON.stringify(results.map((r) => r.status))}`);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /already exists|slug collision/);

  // The folder holds exactly one race.json — not two writers interleaved —
  // and the exclusive claim used to serialize them did not outlive the run
  // that took it (it would otherwise block every future intake of this slug).
  const dir = path.join(tmp, "races", "cinder-cone-50k-2027");
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, "race.json"), "utf8"));
  assert.equal(onDisk.slug, "cinder-cone-50k-2027");
  const claimExists = await fs.access(path.join(dir, ".intake-claim")).then(() => true, () => false);
  assert.equal(claimExists, false, "the claim must be released once its run is done");
});

test("runIntake: a write failure after validation still parks the raw output instead of deleting staging", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "intake-run-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  // races/ is a FILE, not a directory: slugExists (fs.access, catches
  // everything) reads this as "no such race", so assertSlugAvailable passes
  // and the run reaches moveSources — whose own `fs.mkdir(dir, {recursive})`
  // then fails on this exact same obstruction, well after validation.
  await fs.writeFile(path.join(tmp, "races"), "not a directory");

  const draft = await loadDraft();
  await assert.rejects(
    runIntake({ root: tmp, siteUrl: DEAD_SITE, year: 2027, runAgent: cannedAgent(draft) }),
    (e) => /raw agent output saved to/.test(e.message),
  );
});
