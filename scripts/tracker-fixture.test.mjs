// The test-fixture tracker adapter — scripts/trackers/fixture.mjs.
//
// It exists so the Playwright proof for bead tt-cv1b0.6 can poll a real HTTP
// route instead of a volunteer-run timing site, and it is only in the
// registry under TRAIL_TEST_FIXTURES=1 (scripts/trackers.test.mjs pins that
// gate). This file pins the rest: that it claims the fixture route and
// nothing else, and that it reports the SAME checkpoint the real
// OpenSplitTime adapter reports off the same page — a test double that
// parsed differently from the thing it stands in for would be worse than no
// double at all.
//
// No network: the fetch is injected, like everywhere else under scripts/.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as fixture from "./trackers/fixture.mjs";
import * as ost from "./trackers/opensplittime.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SPREAD = fs.readFileSync(path.join(here, "fixtures/trackers/opensplittime-spread.html"), "utf8");
const FIXTURE_URL = "http://127.0.0.1:38156/__fixtures__/trackers/opensplittime-spread.html";

const SOFTIE_STATIONS = [
  "Start", "Cascade #1", "EMT #2", "Engine Creek #3", "Middle of Nowhere #4",
  "Cross Mountain #5", "Calico #6", "Burnett #7", "Ryman Creek #8", "Corral #9",
  "Big Lick #10", "Elbert Creek #11", "Finish",
];

function fetchStub(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    return { ok, status, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test("it claims the dev server's fixture route, on any host or port", () => {
  assert.equal(fixture.matches(FIXTURE_URL), true);
  assert.equal(fixture.matches("http://192.168.1.42:38100/__fixtures__/trackers/x.html"), true);
});

test("it claims nothing else — least of all a real tracker", () => {
  for (const url of [
    "https://www.opensplittime.org/events/2026-san-juan-softie-100/spread",
    "https://app.maprogress.com/emap/1234",
    "http://127.0.0.1:38156/__fixtures__/trackers/../../../etc/passwd",
    "http://127.0.0.1:38156/__fixtures__/trackers/",
    "http://127.0.0.1:38156/api/races/x/tracker",
    "not a url",
    "",
  ]) {
    assert.equal(fixture.matches(url), false, url);
  }
});

test("it reads the committed spread and reports the last checkpoint", async () => {
  const impl = fetchStub(SPREAD);
  const hit = await fixture.fetchLastCheckpoint(
    { url: FIXTURE_URL, bib: "999", stations: SOFTIE_STATIONS, at: "2026-08-15T03:00:00.000Z" },
    impl,
  );
  // TEST RUNNER started Fri 6:00AM and left Burnett #7 at Fri 9:22PM
  assert.equal(hit.station, "Burnett #7");
  assert.equal(hit.clock, "21:22");
  assert.equal(hit.matched, true);
  assert.equal(hit.bib, "999");
  assert.deepEqual(impl.calls, [FIXTURE_URL]);
});

test("it answers exactly what the real adapter answers, but says it is a fixture", async () => {
  const mine = await fixture.fetchLastCheckpoint(
    { url: FIXTURE_URL, bib: "999", stations: SOFTIE_STATIONS, at: "2026-08-15T03:00:00.000Z" },
    fetchStub(SPREAD),
  );
  const real = await ost.fetchLastCheckpoint(
    {
      url: "https://www.opensplittime.org/events/2026-san-juan-softie-100/spread",
      bib: "999", stations: SOFTIE_STATIONS, at: "2026-08-15T03:00:00.000Z",
    },
    fetchStub(SPREAD),
  );
  assert.equal(mine.source, "fixture");
  assert.equal(real.source, "opensplittime");
  assert.deepEqual({ ...mine, source: null }, { ...real, source: null });
});

test("a runner not on the page is null, not an error", async () => {
  const miss = await fixture.fetchLastCheckpoint(
    { url: FIXTURE_URL, bib: "12345", stations: SOFTIE_STATIONS },
    fetchStub(SPREAD),
  );
  assert.equal(miss, null);
});

test("a URL it does not claim is a tagged bad_request, not a crash", async () => {
  await assert.rejects(
    () => fixture.fetchLastCheckpoint({ url: "https://example.test/x" }, fetchStub(SPREAD)),
    (e) => e.code === "bad_request",
  );
});

test("an unreadable route is a tagged bad_gateway", async () => {
  await assert.rejects(
    () => fixture.fetchLastCheckpoint({ url: FIXTURE_URL }, fetchStub("", { ok: false, status: 404 })),
    (e) => e.code === "bad_gateway" && /HTTP 404/.test(e.message),
  );
  await assert.rejects(
    () => fixture.fetchLastCheckpoint({ url: FIXTURE_URL }, fetchStub("<html>nope</html>")),
    (e) => e.code === "bad_gateway" && /not a readable spread table/.test(e.message),
  );
});
