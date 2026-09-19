// Unit tests for the tracker adapters and the registry. Run with `npm test`
// from web/ (node --test).
//
// NOTHING HERE TOUCHES THE NETWORK. Every call takes an injected `fetchImpl`
// that returns the committed, scrubbed fixture in
// scripts/fixtures/trackers/ (see its README for that file's origin and what
// was removed). A test that forgets to inject one would hit a volunteer-run
// timing site from CI, so `noNetwork` below is the default and fails loudly.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADAPTERS,
  CACHE_TTL_MS,
  createTrackerCache,
  detect,
  fetchLastCheckpoint,
  pollTracker,
  requireTracking,
} from "./trackers/index.mjs";
import * as ost from "./trackers/opensplittime.mjs";
import * as maprogress from "./trackers/maprogress.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SPREAD = fs.readFileSync(path.join(here, "fixtures/trackers/opensplittime-spread.html"), "utf8");
const SPREAD_URL = "https://www.opensplittime.org/events/2026-san-juan-softie-100/spread";

/** A fetch that serves one body, and records what it was asked for. */
function fetchStub(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return { ok, status, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

/** The guard: any adapter that reaches for the real network fails the test. */
const noNetwork = async () => {
  throw new Error("a test tried to make a real network request");
};

/** The Softie's aid stations, as races/san-juan-softie-100-2027/race.json has them. */
const SOFTIE_STATIONS = [
  "Start", "Cascade #1", "EMT #2", "Engine Creek #3", "Middle of Nowhere #4",
  "Cross Mountain #5", "Calico #6", "Burnett #7", "Ryman Creek #8", "Corral #9",
  "Big Lick #10", "Elbert Creek #11", "Finish",
];

const softieRace = (tracking) => ({
  slug: "san-juan-softie-100-2027",
  aid_stations: SOFTIE_STATIONS.map((name, i) => ({ name, total_mi: i * 8 })),
  tracking,
});

/* ------------------------------ registry ------------------------------- */

test("detect: routes by hostname, subdomains included", () => {
  assert.equal(detect(SPREAD_URL)?.id, "opensplittime");
  assert.equal(detect("https://opensplittime.org/events/x/spread")?.id, "opensplittime");
  assert.equal(detect("https://app.maprogress.com/emap/1234")?.id, "maprogress");
  assert.equal(detect("https://softie2027.maprogress.com/")?.id, "maprogress");
  assert.equal(detect("https://ultralive.net/race/softie"), null);
  assert.equal(detect("https://www.opensplittime.org.evil.test/events/x"), null);
  assert.equal(detect("not a url"), null);
  assert.equal(detect(""), null);
  assert.equal(detect(null), null);
});

test("detect: every registered adapter has the full shape", () => {
  for (const a of ADAPTERS) {
    assert.equal(typeof a.id, "string", "id");
    assert.equal(typeof a.label, "string", "label");
    // Empty hostnames are legal for exactly one adapter: the test fixture
    // (bead tt-cv1b0.6) is claimed by PATH, because it is served off
    // whatever loopback or LAN address the dev server happens to have.
    assert.ok(Array.isArray(a.hostnames) && (a.hostnames.length || a.id === "fixture"), `${a.id}: hostnames`);
    assert.equal(typeof a.matches, "function", `${a.id}: matches`);
    assert.equal(typeof a.fetchLastCheckpoint, "function", `${a.id}: fetchLastCheckpoint`);
  }
  assert.deepEqual(ADAPTERS.filter((a) => a.id !== "fixture").map((a) => a.id), ["opensplittime", "maprogress"]);
  // The gate itself, both ways: a production run must not carry a test
  // double in its tracker registry.
  assert.equal(
    ADAPTERS.some((a) => a.id === "fixture"),
    process.env.TRAIL_TEST_FIXTURES === "1",
    "the fixture adapter is in the registry if and only if TRAIL_TEST_FIXTURES=1",
  );
});

test("fetchLastCheckpoint: a URL no adapter claims is not_found, not a crash", async () => {
  await assert.rejects(
    () => fetchLastCheckpoint({ url: "https://ultralive.net/race/softie" }, noNetwork),
    (e) => e.code === "not_found" && /no tracker adapter matches/.test(e.message),
  );
});

test("requireTracking: a race with no tracking.url is not_found", () => {
  assert.throws(() => requireTracking(undefined), (e) => e.code === "not_found");
  assert.throws(() => requireTracking({ url: "  " }), (e) => e.code === "not_found");
  assert.deepEqual(requireTracking({ url: SPREAD_URL, bib: " 999 ", name: "" }), {
    url: SPREAD_URL, bib: "999", name: null,
  });
});

/* --------------------------- OpenSplitTime ----------------------------- */

test("opensplittime: spreadUrl normalizes whatever the race site linked", () => {
  assert.equal(ost.spreadUrl(SPREAD_URL), SPREAD_URL);
  assert.equal(ost.spreadUrl("https://www.opensplittime.org/events/2026-san-juan-softie-100"), SPREAD_URL);
  assert.equal(
    ost.spreadUrl("https://www.opensplittime.org/events/2026-san-juan-softie-100/spread?sort=bib_number#x"),
    SPREAD_URL,
  );
  assert.throws(
    () => ost.spreadUrl("https://www.opensplittime.org/organizations/softie"),
    (e) => e.code === "bad_request",
  );
});

test("opensplittime: the fixture's headers are the 13 course stations in order", () => {
  assert.deepEqual(ost.parseStationHeaders(SPREAD), SOFTIE_STATIONS);
});

test("opensplittime: parseClockToken reads every shape the page prints", () => {
  assert.deepEqual(ost.parseClockToken("Fri 6:00AM"), { minutes: 360, weekday: 5 });
  assert.deepEqual(ost.parseClockToken("Fri 9:22PM"), { minutes: 21 * 60 + 22, weekday: 5 });
  assert.deepEqual(ost.parseClockToken("Sat 12:30AM"), { minutes: 30, weekday: 6 });
  assert.deepEqual(ost.parseClockToken("Sat 12:30PM"), { minutes: 12 * 60 + 30, weekday: 6 });
  // the finish carries seconds
  assert.equal(ost.parseClockToken("Sat 5:28:32AM").minutes, 5 * 60 + 28 + 32 / 60);
  // display_style=military, and a bare time with no weekday
  assert.deepEqual(ost.parseClockToken("Fri 21:19"), { minutes: 21 * 60 + 19, weekday: 5 });
  assert.deepEqual(ost.parseClockToken("21:19"), { minutes: 21 * 60 + 19, weekday: null });
  // placeholders and junk are "not reached", not errors
  assert.equal(ost.parseClockToken("--:--:--"), null);
  assert.equal(ost.parseClockToken(""), null);
  assert.equal(ost.parseClockToken("   "), null);
  assert.equal(ost.parseClockToken(undefined), null);
  assert.equal(ost.parseClockToken("Fri 25:00"), null);
  assert.equal(ost.parseClockToken("Fri 13:00PM"), null);
});

test("opensplittime: an in/out cell reports the OUT time, and survives a missing in", () => {
  assert.equal(ost.parseStationCell("Fri 9:19AM / Fri 9:22AM").minutes, 9 * 60 + 22);
  assert.equal(ost.parseStationCell("--:--:-- / Fri 11:25AM").minutes, 11 * 60 + 25);
  assert.equal(ost.parseStationCell("Sat 8:00AM / --:--:--").minutes, 8 * 60);
  assert.equal(ost.parseStationCell("--:--:-- / --:--:--"), null);
  assert.equal(ost.parseStationCell("Fri 6:00AM").minutes, 360);
});

test("opensplittime: last checkpoint of the mid-race runner, by bib", async () => {
  const impl = fetchStub(SPREAD);
  const hit = await ost.fetchLastCheckpoint(
    { url: SPREAD_URL, bib: "999", stations: SOFTIE_STATIONS, at: "2026-08-15T03:00:00.000Z" },
    impl,
  );
  // TEST RUNNER started Fri 6:00AM and left Burnett #7 at Fri 9:22PM
  assert.equal(hit.station, "Burnett #7");
  assert.equal(hit.checkpoint, "Burnett #7");
  assert.equal(hit.matched, true);
  assert.equal(hit.clock, "21:22");
  assert.equal(hit.elapsed_h, +(15 + 22 / 60).toFixed(3));
  assert.equal(hit.source, "opensplittime");
  assert.equal(hit.at, "2026-08-15T03:00:00.000Z");
  assert.equal(hit.bib, "999");
  assert.deepEqual(impl.calls, [SPREAD_URL]);
});

test("opensplittime: the same runner found by name, bib absent", async () => {
  const byName = await ost.fetchLastCheckpoint(
    { url: SPREAD_URL, name: "test runner", stations: SOFTIE_STATIONS },
    fetchStub(SPREAD),
  );
  assert.equal(byName.bib, "999");
  assert.equal(byName.station, "Burnett #7");
});

test("opensplittime: a finished runner reports the finish, across midnight", async () => {
  const hit = await ost.fetchLastCheckpoint(
    { url: SPREAD_URL, bib: "902", stations: SOFTIE_STATIONS },
    fetchStub(SPREAD),
  );
  // Entrant Two: Fri 6:00AM → Sat 5:28:32AM = 23:28:32
  assert.equal(hit.station, "Finish");
  assert.equal(hit.clock, "05:28");
  assert.equal(hit.elapsed_h, +(23 + 28 / 60 + 32 / 3600).toFixed(3));
  assert.equal(hit.runner_status, "Finished");
});

test("opensplittime: a DNF reports the last station actually reached (an in-time)", async () => {
  const hit = await ost.fetchLastCheckpoint(
    { url: SPREAD_URL, bib: "904", stations: SOFTIE_STATIONS },
    fetchStub(SPREAD),
  );
  // Entrant Four's last real time is "Sat 8:00AM / --:--:--" at Elbert Creek #11
  assert.equal(hit.station, "Elbert Creek #11");
  assert.equal(hit.clock, "08:00");
  assert.equal(hit.elapsed_h, 26);
  assert.equal(hit.runner_status, "Dropped");
});

test("opensplittime: a runner who never started and one who isn't entered are both a null tracker, but for different reasons", async () => {
  // bib 903 IS on the page (a row with only its start time) — reached, no
  // checkpoint past it yet.
  const notStarted = await ost.fetchLastCheckpoint(
    { url: SPREAD_URL, bib: "903", stations: SOFTIE_STATIONS },
    fetchStub(SPREAD),
  );
  assert.deepEqual(notStarted, { tracker: null, reason: "no_checkpoint" });

  // bib 4242 is not a row on the page at all.
  const notEntered = await ost.fetchLastCheckpoint(
    { url: SPREAD_URL, bib: "4242", stations: SOFTIE_STATIONS },
    fetchStub(SPREAD),
  );
  assert.deepEqual(notEntered, { tracker: null, reason: "runner_not_found" });

  // a name that is close but not the same person must not match
  const wrongName = await ost.fetchLastCheckpoint(
    { url: SPREAD_URL, name: "Test Runnerson", stations: SOFTIE_STATIONS },
    fetchStub(SPREAD),
  );
  assert.deepEqual(wrongName, { tracker: null, reason: "runner_not_found" });
});

test("opensplittime: a name shared by two entrants is refused as ambiguous, not guessed at", async () => {
  // A synthetic tie: two rows with the same name, neither an exact-score
  // winner over the other. Built from the fixture's own rows rather than a
  // second fixture, so the parse path stays real.
  const rows = [
    { bib: "", name: "Pat Rivera", status: "", cells: ["Fri 6:00AM"] },
    { bib: "", name: "Pat Rivera", status: "", cells: ["Fri 6:01AM"] },
  ];
  assert.throws(
    () => ost.findRow(rows, { name: "Pat Rivera" }),
    (e) => e.code === "ambiguous" && e.candidates === 2 && /2 entrants/.test(e.message),
  );
  // a bib still wins outright over an ambiguous name — no ambiguity to
  // report when the athlete already gave the unique identifier
  const withBib = rows.map((r, i) => ({ ...r, bib: i === 1 ? "42" : "" }));
  assert.equal(ost.findRow(withBib, { bib: "42", name: "Pat Rivera" }), withBib[1]);

  // and it propagates all the way through fetchLastCheckpoint, off a real
  // (minimal, synthetic) spread page — a duo sharing a name, no bib set yet.
  const page = `<table><thead><tr>
    <th></th><th></th><th></th><th></th><th></th><th></th><th></th>
    <th class="text-nowrap text-center">Start<br>(Mile 0.0)</th>
  </tr></thead><tbody>
    <tr id="effort_1"><td></td><td>1</td><td></td><td>Pat Rivera</td><td>M</td><td>NM</td><td></td><td>Fri 6:00AM</td></tr>
    <tr id="effort_2"><td></td><td>2</td><td></td><td>Pat Rivera</td><td>M</td><td>NM</td><td></td><td>Fri 6:00AM</td></tr>
  </tbody></table>`;
  await assert.rejects(
    () => ost.fetchLastCheckpoint({ url: SPREAD_URL, name: "Pat Rivera", stations: [] }, fetchStub(page)),
    (e) => e.code === "ambiguous" && e.candidates === 2,
  );
});

test("opensplittime: a page with no spread table is an error, not a silent null", async () => {
  await assert.rejects(
    () => ost.fetchLastCheckpoint({ url: SPREAD_URL, bib: "999" }, fetchStub("<html><body>Sign in</body></html>")),
    (e) => e.code === "bad_gateway" && /no readable spread table/.test(e.message),
  );
  // truncated mid-table: headers but no rows
  const truncated = SPREAD.slice(0, SPREAD.indexOf("<tbody"));
  await assert.rejects(
    () => ost.fetchLastCheckpoint({ url: SPREAD_URL, bib: "999" }, fetchStub(truncated)),
    (e) => e.code === "bad_gateway",
  );
});

test("opensplittime: HTTP failures and transport errors surface as bad_gateway", async () => {
  await assert.rejects(
    () => ost.fetchLastCheckpoint({ url: SPREAD_URL, bib: "999" }, fetchStub("nope", { ok: false, status: 503 })),
    (e) => e.code === "bad_gateway" && /HTTP 503/.test(e.message),
  );
  const boom = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(
    () => ost.fetchLastCheckpoint({ url: SPREAD_URL, bib: "999" }, boom),
    (e) => e.code === "bad_gateway" && /could not be reached/.test(e.message),
  );
  const timeout = async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); };
  await assert.rejects(
    () => ost.fetchLastCheckpoint({ url: SPREAD_URL, bib: "999" }, timeout),
    (e) => e.code === "bad_gateway" && /did not answer/.test(e.message),
  );
});

test("opensplittime: station mapping falls back to the tracker's own label", () => {
  // the aid-match normaliser folds punctuation and "Aid"/"Station"
  assert.deepEqual(ost.mapStation("Cross Mtn #5", SOFTIE_STATIONS).station, "Cross Mountain #5");
  assert.equal(ost.mapStation("Ryman Creek Aid", SOFTIE_STATIONS).station, "Ryman Creek #8");
  const unknown = ost.mapStation("Secret Water Drop", SOFTIE_STATIONS);
  assert.equal(unknown.station, "Secret Water Drop");
  assert.equal(unknown.matched, false);
  // no stations configured at all: the label passes straight through
  assert.equal(ost.mapStation("Burnett #7", []).station, "Burnett #7");
});

test("opensplittime: a race whose stations don't match keeps the tracker's labels", async () => {
  const hit = await ost.fetchLastCheckpoint(
    { url: SPREAD_URL, bib: "999", stations: ["Alpha", "Bravo", "Charlie"] },
    fetchStub(SPREAD),
  );
  assert.equal(hit.station, "Burnett #7");
  assert.equal(hit.matched, false);
});

test("opensplittime: rows are walked left to right — a synthetic row's LAST time wins", () => {
  const headers = ["Start", "One", "Two", "Three"];
  const cells = ["Fri 6:00AM", "Fri 8:30AM", "Fri 11:00AM / Fri 11:06AM", "--:--:--"];
  assert.deepEqual(ost.lastCheckpointFromRow(cells, headers), {
    index: 2, checkpoint: "Two", clock: "11:06", elapsed_h: 5.1,
  });
  // only a start time: not a checkpoint
  assert.equal(ost.lastCheckpointFromRow(["Fri 6:00AM", "--:--:--"], headers), null);
  // nothing at all
  assert.equal(ost.lastCheckpointFromRow(["--:--:--", "--:--:--"], headers), null);
  // no weekdays anywhere: the backwards clock still rolls the day over
  assert.equal(ost.lastCheckpointFromRow(["18:00", "02:00"], headers).elapsed_h, 8);
  // a multi-day row: Fri → Sun is two days, not "minus five"
  assert.equal(ost.lastCheckpointFromRow(["Fri 6:00AM", "Sun 6:00AM"], headers).elapsed_h, 48);
});

/* ----------------------------- MAProgress ------------------------------ */

test("maprogress: claimed by detect, but refuses with a clear unsupported error", async () => {
  assert.equal(maprogress.supported, false);
  assert.equal(detect("https://app.maprogress.com/emap/1234")?.id, "maprogress");
  await assert.rejects(
    () => fetchLastCheckpoint({ url: "https://app.maprogress.com/emap/1234", bib: "999" }, noNetwork),
    (e) => e.code === "unsupported" && /not supported/.test(e.message),
  );
});

/* ------------------------- the cached poll ----------------------------- */

test("pollTracker: the second call inside the TTL is served from cache", async () => {
  const cache = createTrackerCache();
  const impl = fetchStub(SPREAD);
  const race = softieRace({ url: SPREAD_URL, bib: "999" });
  const t0 = Date.parse("2026-08-14T21:22:00.000Z");

  const first = await pollTracker({ slug: "softie", race, cache, fetchImpl: impl, now: t0 });
  assert.equal(first.cached, false);
  assert.equal(first.age_s, 0);
  assert.equal(first.source, "opensplittime");
  assert.equal(first.tracker.station, "Burnett #7");
  assert.equal(first.polled_at, new Date(t0).toISOString());
  assert.equal(impl.calls.length, 1);

  const second = await pollTracker({ slug: "softie", race, cache, fetchImpl: impl, now: t0 + 30_000 });
  assert.equal(second.cached, true);
  assert.equal(second.age_s, 30);
  assert.deepEqual(second.tracker, first.tracker);
  assert.equal(impl.calls.length, 1, "no second fetch inside the TTL");

  // one tick before expiry is still the cached copy
  const edge = await pollTracker({ slug: "softie", race, cache, fetchImpl: impl, now: t0 + CACHE_TTL_MS - 1 });
  assert.equal(edge.cached, true);
  assert.equal(impl.calls.length, 1);

  // at the TTL it polls again
  const third = await pollTracker({ slug: "softie", race, cache, fetchImpl: impl, now: t0 + CACHE_TTL_MS });
  assert.equal(third.cached, false);
  assert.equal(impl.calls.length, 2);
});

test("pollTracker: editing the bib invalidates the cache without a manual clear", async () => {
  const cache = createTrackerCache();
  const impl = fetchStub(SPREAD);
  const t0 = Date.parse("2026-08-14T21:22:00.000Z");

  const a = await pollTracker({ slug: "softie", race: softieRace({ url: SPREAD_URL, bib: "999" }), cache, fetchImpl: impl, now: t0 });
  const b = await pollTracker({ slug: "softie", race: softieRace({ url: SPREAD_URL, bib: "902" }), cache, fetchImpl: impl, now: t0 + 1000 });
  assert.equal(a.tracker.station, "Burnett #7");
  assert.equal(b.cached, false);
  assert.equal(b.tracker.station, "Finish");
  assert.equal(impl.calls.length, 2);
});

test("pollTracker: a null answer is cached too — nothing re-polls for a runner who hasn't started", async () => {
  const cache = createTrackerCache();
  const impl = fetchStub(SPREAD);
  const race = softieRace({ url: SPREAD_URL, bib: "903" });
  const t0 = Date.parse("2026-08-14T12:00:00.000Z");

  const first = await pollTracker({ slug: "softie", race, cache, fetchImpl: impl, now: t0 });
  assert.equal(first.tracker, null);
  assert.equal(first.reason, "no_checkpoint", "bib 903 is on the page, just not past a checkpoint yet");
  const second = await pollTracker({ slug: "softie", race, cache, fetchImpl: impl, now: t0 + 5_000 });
  assert.equal(second.cached, true);
  assert.equal(second.tracker, null);
  assert.equal(second.reason, "no_checkpoint");
  assert.equal(impl.calls.length, 1);
});

test("pollTracker: a bib nobody has is runner_not_found, not no_checkpoint", async () => {
  const cache = createTrackerCache();
  const race = softieRace({ url: SPREAD_URL, bib: "4242" });
  const hit = await pollTracker({ slug: "softie", race, cache, fetchImpl: fetchStub(SPREAD), now: Date.now() });
  assert.equal(hit.tracker, null);
  assert.equal(hit.reason, "runner_not_found");
});

test("pollTracker: an ambiguous name is not swallowed — it throws same as any other adapter refusal", async () => {
  const cache = createTrackerCache();
  const race = { slug: "softie", aid_stations: [], tracking: { url: SPREAD_URL, name: "Pat Rivera" } };
  const page = `<table><thead><tr>
    <th></th><th></th><th></th><th></th><th></th><th></th><th></th>
    <th class="text-nowrap text-center">Start<br>(Mile 0.0)</th>
  </tr></thead><tbody>
    <tr id="effort_1"><td></td><td>1</td><td></td><td>Pat Rivera</td><td>M</td><td>NM</td><td></td><td>Fri 6:00AM</td></tr>
    <tr id="effort_2"><td></td><td>2</td><td></td><td>Pat Rivera</td><td>M</td><td>NM</td><td></td><td>Fri 6:00AM</td></tr>
  </tbody></table>`;
  await assert.rejects(
    () => pollTracker({ slug: "softie", race, cache, fetchImpl: fetchStub(page), now: Date.now() }),
    (e) => e.code === "ambiguous" && e.candidates === 2,
  );
});

test("pollTracker: a failure is NOT cached — the next request tries again", async () => {
  const cache = createTrackerCache();
  const race = softieRace({ url: SPREAD_URL, bib: "999" });
  const t0 = Date.parse("2026-08-14T21:22:00.000Z");

  const down = fetchStub("", { ok: false, status: 502 });
  await assert.rejects(
    () => pollTracker({ slug: "softie", race, cache, fetchImpl: down, now: t0 }),
    (e) => e.code === "bad_gateway",
  );

  const up = fetchStub(SPREAD);
  const recovered = await pollTracker({ slug: "softie", race, cache, fetchImpl: up, now: t0 + 1_000 });
  assert.equal(recovered.cached, false);
  assert.equal(recovered.tracker.station, "Burnett #7");
  assert.equal(up.calls.length, 1);
});

test("pollTracker: no tracking, and an unknown tracker, are both not_found", async () => {
  const cache = createTrackerCache();
  await assert.rejects(
    () => pollTracker({ slug: "softie", race: softieRace(undefined), cache, fetchImpl: noNetwork }),
    (e) => e.code === "not_found" && /no tracking\.url/.test(e.message),
  );
  await assert.rejects(
    () => pollTracker({ slug: "softie", race: softieRace({ url: "https://ultralive.net/x" }), cache, fetchImpl: noNetwork }),
    (e) => e.code === "not_found" && /no tracker adapter matches/.test(e.message),
  );
});

test("pollTracker: stations come from race.json, so the hold names the course's station", async () => {
  const cache = createTrackerCache();
  const race = {
    slug: "softie",
    // deliberately spelled the way a hand-authored race.json might be
    aid_stations: [{ name: "Start" }, { name: "Burnett Aid" }],
    tracking: { url: SPREAD_URL, bib: "999" },
  };
  const hit = await pollTracker({ slug: "softie", race, cache, fetchImpl: fetchStub(SPREAD), now: Date.now() });
  assert.equal(hit.tracker.checkpoint, "Burnett #7");
  assert.equal(hit.tracker.station, "Burnett Aid");
  assert.equal(hit.tracker.matched, true);
});
