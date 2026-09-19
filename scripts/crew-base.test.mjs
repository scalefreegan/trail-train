// crewBaseFromPrivate — the validation behind the gitignored crew-base.json.
//
// The rule worth pinning down is the INDEPENDENCE of the two halves. Until
// tt-yib.9 the whole file was written only when a valid base existed, so a
// race folder carrying emergency numbers and no race-week lodging silently
// lost the crew sheet's emergency strip. Nothing in the UI would have said so.
//
// The function is pure (no network, no filesystem) so this test doesn't need
// a GPX, a course or OSRM — importing build-course.mjs is safe because its
// main() sits behind a run-as-a-script guard.

import test from "node:test";
import assert from "node:assert/strict";

import { crewBaseFromPrivate } from "./build-course.mjs";

const validBase = () => ({
  label: "Crew base",
  address: "12 Somewhere Rd, Pine AZ",
  lat: 34.38,
  lon: -111.45,
});

const contacts = () => [
  { label: "race HQ", phone: "555-0100" },
  { label: "hospital", phone: "555-0111" },
];

test("base and emergency numbers both come through", () => {
  const { base, emergency, warnings } = crewBaseFromPrivate({ base: validBase(), emergency: contacts() });
  assert.equal(base.label, "Crew base");
  assert.equal(base.lat, 34.38);
  // the drive fields are placeholders the caller fills from OSRM
  assert.equal(base.drive_to_start_min, null);
  assert.equal(base.drive_to_start_mi, null);
  assert.equal(emergency.length, 2);
  assert.deepEqual(warnings, []);
});

test("emergency numbers survive a folder with no base", () => {
  const { base, emergency, warnings } = crewBaseFromPrivate({ emergency: contacts() });
  assert.equal(base, null, "no lodging is a normal state, not an error");
  assert.equal(emergency.length, 2, "the emergency strip must not depend on where you slept");
  assert.deepEqual(warnings, [], "an absent base is not worth warning about");
});

test("a base survives a folder with no emergency numbers", () => {
  const { base, emergency } = crewBaseFromPrivate({ base: validBase() });
  assert.ok(base);
  assert.deepEqual(emergency, []);
});

test("a malformed base is dropped with a warning, and the numbers still go out", () => {
  for (const bad of [
    { ...validBase(), lat: undefined },
    { ...validBase(), lon: "-111.45" },
    { ...validBase(), lat: NaN },
    { ...validBase(), label: "" },
    { ...validBase(), label: undefined },
  ]) {
    const { base, emergency, warnings } = crewBaseFromPrivate({ base: bad, emergency: contacts() });
    assert.equal(base, null, `should reject ${JSON.stringify(bad)}`);
    assert.equal(emergency.length, 2);
    assert.equal(warnings.length, 1);
  }
});

test("a base that isn't an object is reported rather than spread", () => {
  const { base, warnings } = crewBaseFromPrivate({ base: "12 Somewhere Rd" });
  assert.equal(base, null);
  assert.ok(warnings.some((w) => w.includes("not an object")));
});

test("half-written emergency contacts are skipped and counted", () => {
  const { emergency, warnings } = crewBaseFromPrivate({
    emergency: [{ label: "race HQ", phone: "555-0100" }, { label: "no phone" }, { phone: "555-0122" }, null],
  });
  assert.equal(emergency.length, 1);
  assert.ok(warnings.some((w) => w.includes("3 emergency contact")));
});

test("an emergency value that isn't an array is reported", () => {
  const { emergency, warnings } = crewBaseFromPrivate({ emergency: "555-0100" });
  assert.deepEqual(emergency, []);
  assert.ok(warnings.some((w) => w.includes("not an array")));
});

test("an empty private file is a no-op, not a crash", () => {
  const { base, emergency, warnings } = crewBaseFromPrivate({});
  assert.equal(base, null);
  assert.deepEqual(emergency, []);
  assert.deepEqual(warnings, []);
});
