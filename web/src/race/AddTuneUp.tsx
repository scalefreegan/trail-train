import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { friendlyFetchError, inputStyle, useDialog } from "./dialogChrome";

/* The tune-up quick form (PRD-v2 §3) — the dialog behind the switcher's
   "↳ Add tune-up…" row.

   Five typed fields and an optional GPX, POSTed to /api/races, which writes
   races/<slug>/race.json with `kind: "b"` and `parent_slug` set to the A race
   this tune-up sits inside and (when a GPX came with it) builds the course.
   No agent turn, no spend: a B race is a date on the trajectory and a
   distance to pace, not a folder anybody needs read off a race website.

   The rules are the server's — quickCreateRace refuses a missing parent, a
   parent that is itself a tune-up and a slug that already exists, and the
   validator refuses a "b" that claims to be active. This form checks only
   what it can check without guessing, and shows the server's own sentence
   for everything else.

   The paid way in is still offered, clearly marked: "run the full intake
   instead" hands off to the New race dialog with this race's parent carried
   over. That path builds a race folder from a website with an agent turn —
   it is not this endpoint. */

const labelStyle: React.CSSProperties = {
  fontSize: 8.5, color: "var(--mist-dim)", display: "block", marginBottom: 4,
};

const field: React.CSSProperties = { ...inputStyle, width: "100%" };

/** What POST /api/races answers with, minus the whole race.json it echoes. */
type CreateResult = {
  slug: string;
  build: { ok: boolean; unresolved?: string[]; warnings?: string[]; error?: string } | null;
};

/* Round 4, finding 6: everything typed here used to be discarded the moment
   "run the full intake instead" opened the New-race dialog on top of it (the
   dialog un-mounts this component) — Escape out of THAT and reopening
   "↳ Add tune-up…" gave back six empty fields, even though the intake dialog
   right next to it survives exactly this with its own localStorage draft
   (RaceIntake.tsx's NEW_RACE_DRAFT_KEY). Same medicine here, one draft per
   parent race — a dashboard training two blocks at once (a tune-up on each)
   must not have one block's half-typed form bleed into the other's. */
const tuneUpDraftKey = (parentSlug: string) => `bc.tuneUpDraft.${parentSlug}`;
type TuneUpDraft = {
  name: string; date: string; distance: string; gain: string; timezone: string;
  gpx: { name: string; path: string; bytes: number } | null;
};
const tuneUpDraftHasContent = (d: TuneUpDraft): boolean =>
  Boolean(d.name.trim() || d.date.trim() || d.distance.trim() || d.gain.trim() || d.timezone.trim() || d.gpx);
/** Read-only and synchronous — safe to call from a `useState(() => …)` lazy
    initializer, same reasoning as RaceIntake.tsx's readNewRaceDraft. */
const readTuneUpDraft = (parentSlug: string): TuneUpDraft | null => {
  try {
    const raw = localStorage.getItem(tuneUpDraftKey(parentSlug));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<TuneUpDraft>;
    const normalized: TuneUpDraft = {
      name: d.name ?? "", date: d.date ?? "", distance: d.distance ?? "", gain: d.gain ?? "",
      timezone: d.timezone ?? "", gpx: d.gpx ?? null,
    };
    return tuneUpDraftHasContent(normalized) ? normalized : null;
  } catch {
    return null; // a corrupt draft is no worse than no draft
  }
};

/** Round 4, finding 13: a date this far from the parent race is not a tune-up
    inside its block, it is a typo (a stray "1999", the wrong year typed after
    the form's own year rolled over) — 3 years comfortably covers a "next
    year" off-by-one while still catching every observed case. */
const SANE_YEARS_FROM_PARENT = 3;

export function AddTuneUp({ parentSlug, parentName, parentTimezone, parentDate, onClose, onCreated, onRunIntake }: {
  /** the A race this tune-up hangs off — the switcher only offers this row
      on the race being trained for */
  parentSlug: string;
  parentName: string;
  /** the parent's IANA zone, inherited unless the athlete overrides it.
      Null when the switcher could not read it (the parent's own race.json
      is what the payload carries) — the server still inherits it. */
  parentTimezone: string | null;
  /** the A race's date, "YYYY-MM-DD" — used only to say how many weeks out
      the tune-up lands, the same count the trajectory marker uses */
  parentDate: string | null;
  onClose: () => void;
  /** the folder is on disk: close, pulse the refresh, reopen nothing */
  onCreated: (slug: string) => void;
  /** the paid escape hatch — open the New race dialog on this parent */
  onRunIntake: () => void;
}) {
  const [name, setName] = useState(() => readTuneUpDraft(parentSlug)?.name ?? "");
  const [date, setDate] = useState(() => readTuneUpDraft(parentSlug)?.date ?? "");
  const [distance, setDistance] = useState(() => readTuneUpDraft(parentSlug)?.distance ?? "");
  const [gain, setGain] = useState(() => readTuneUpDraft(parentSlug)?.gain ?? "");
  const [timezone, setTimezone] = useState(() => readTuneUpDraft(parentSlug)?.timezone ?? "");
  const [gpx, setGpx] = useState<{ name: string; path: string; bytes: number } | null>(() => readTuneUpDraft(parentSlug)?.gpx ?? null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Set only when the folder IS written but its course build failed (an
     unparseable GPX, a track with no points). The race exists either way —
     this is a second beat before the dialog hands off, not a refusal, the
     same shape ArchiveRace's post-write warning takes. */
  const [buildWarning, setBuildWarning] = useState<{ slug: string; message: string } | null>(null);

  const ids = useId();
  const id = (k: string) => `${ids}-${k}`;

  const finish = () => (buildWarning ? onCreated(buildWarning.slug) : onClose());
  const title = buildWarning ? "tune-up added — one thing to check" : "add tune-up";
  const { dialogProps, titleId } = useDialog({ onClose: finish, locked: busy || uploading });

  // Persist on every change, the same "ESC never loses it" rule
  // RaceIntake.tsx's own draft takes — cleared only once the folder is
  // actually written (see submit(), below).
  useEffect(() => {
    try {
      const draft: TuneUpDraft = { name, date, distance, gain, timezone, gpx };
      const key = tuneUpDraftKey(parentSlug);
      if (tuneUpDraftHasContent(draft)) localStorage.setItem(key, JSON.stringify(draft));
      else localStorage.removeItem(key);
    } catch { /* private browsing / storage disabled — best-effort only */ }
  }, [parentSlug, name, date, distance, gain, timezone, gpx]);

  const distanceNum = Number(distance);
  const gainNum = Number(gain);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date.trim());
  // Round 4 confirm, new finding 2: `Number("") === 0`, so a blank field
  // sailed straight through the `gainNum >= 0` gate — the one field on this
  // form where 0 is a legitimate, explicitly-typed value, so the gate alone
  // can't tell "athlete typed 0" from "athlete typed nothing". A blank gain
  // used to write `gain_ft: 0` with `provenance.gain_ft.by: "user"`, i.e. a
  // flat-course claim the athlete never made. Require the field non-blank,
  // same as every other required field on this form.
  const gainOk = gain.trim().length > 0 && Number.isFinite(gainNum) && gainNum >= 0;

  /* Whole weeks between this date and the A race's, counted the way
     scripts/race-config.mjs's weeksOut does (calendar days / 7, rounded):
     positive is before the A race, 0 is race week, negative is after it.
     Advisory only — the server computes the number the coach and the
     trajectory actually use. */
  const weeksOut = (() => {
    if (!dateOk || !parentDate) return null;
    const b = Date.parse(`${date.trim()}T00:00:00Z`);
    const a = Date.parse(`${parentDate}T00:00:00Z`);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.round((a - b) / (7 * 86400000));
  })();

  // Round 4, finding 13: `1999-01-01` used to sail through as "1493 weeks
  // out" with the submit button happily enabled. A tune-up this far from its
  // parent's block is not a known-gap the server should have to catch —
  // it's a typo the form can see coming from the same date field it already
  // reads for weeksOut above.
  const yearsFromParent = (() => {
    if (!dateOk || !parentDate) return null;
    const b = Date.parse(`${date.trim()}T00:00:00Z`);
    const a = Date.parse(`${parentDate}T00:00:00Z`);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.abs(a - b) / (365.25 * 86400000);
  })();
  const dateTooFar = yearsFromParent != null && yearsFromParent > SANE_YEARS_FROM_PARENT;

  const canSubmit = !busy && !uploading &&
    name.trim().length > 0 && dateOk && !dateTooFar &&
    Number.isFinite(distanceNum) && distanceNum > 0 &&
    gainOk;

  // Round 4, finding 10: the button just went from grey to grey with no
  // explanation of which of the five fields it was still waiting on. Checked
  // in the same order the fields appear, so the message always names the
  // FIRST thing to fix rather than whichever happens to be typed last.
  const disabledReason = canSubmit || busy || uploading ? null :
    !name.trim() ? "name a race"
    : !dateOk ? "pick a date"
    : dateTooFar ? `that date is ${Math.round(yearsFromParent!)} years from ${parentName} — check the year`
    : !(Number.isFinite(distanceNum) && distanceNum > 0) ? "distance mi must be greater than 0"
    : !gainOk ? "gain ft must be 0 or more"
    : null;

  const upload = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      // the same two-step the intake's own uploads take: the bytes go up
      // here, and the POST below carries only the path they landed at
      const res = await fetch("/api/race-intake/upload", {
        method: "POST",
        headers: { "X-Filename": encodeURIComponent(file.name) },
        body: file,
      });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      setGpx(body as { name: string; path: string; bytes: number });
    } catch (e) {
      setError(friendlyFetchError(e));
    } finally {
      setUploading(false);
    }
  };

  // Synchronous re-entrancy guard, same shape and reason as App.tsx's
  // RaceSwitcher.choose(): `setBusy(true)` is a React state update, which
  // does not repaint the button's `disabled` attribute until the next
  // render commits, so a burst of clicks landing in the same tick (a
  // double-tap, a key repeat) can all pass the `!canSubmit` check before any
  // of them sees `busy: true`. Checked and set before anything async
  // happens, so the 2nd and 3rd clicks in such a burst never issue a POST.
  const busyRef = useRef(false);

  const submit = async () => {
    if (!canSubmit) return;
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/races", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          date: date.trim(),
          distance_mi: distanceNum,
          gain_ft: gainNum,
          parent_slug: parentSlug,
          // absent = inherit the parent's zone, which is what the hint says
          ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
          ...(gpx ? { gpx: { path: gpx.path } } : {}),
        }),
      });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      const created = body as CreateResult;
      // The folder is on disk from here on, whatever the course build says —
      // the draft's job (surviving an accidental close before this point) is
      // done, so it does not outlive the race it was drafting.
      try { localStorage.removeItem(tuneUpDraftKey(parentSlug)); } catch { /* best-effort */ }
      if (created.build && created.build.ok === false) {
        setBuildWarning({
          slug: created.slug,
          message: `The folder is written, but the course build failed: ${created.build.error ?? "no reason given"}. `
            + "The tune-up is on the trajectory either way — rebuild it from the switcher's “Run course again…” row once the GPX is fixed.",
        });
        return;
      }
      // ok: true is not "nothing to say" — a course.gpx measuring far off
      // race.json's declared distance/gain (an easy mistake: the wrong file,
      // or a truncated download) still builds and still answers `ok: true`,
      // with the mismatch named in `warnings` (scripts/build-course.mjs's
      // courseMismatches). This channel used to fire only on build.ok ===
      // false, so a 3× distance mismatch reached the planner in total
      // silence (round 4 finding 1) — the same second beat as an outright
      // failure, worded for "check this" rather than "this broke".
      if (created.build?.ok && created.build.warnings && created.build.warnings.length > 0) {
        setBuildWarning({
          slug: created.slug,
          message: `${name.trim()} is added and its course built, but the build had this to say: `
            + `${created.build.warnings.join(" · ")} `
            + "Check that the right GPX was uploaded before trusting the pace and climb numbers below.",
        });
        return;
      }
      onCreated(created.slug);
    } catch (e) {
      setError(friendlyFetchError(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const backdropMouseDown = useRef(false);
  return createPortal(
    <div
      onMouseDown={(e) => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && backdropMouseDown.current && !busy && !uploading) finish(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 100, background: "rgba(4, 8, 12, 0.78)",
        display: "flex", padding: "clamp(12px, 3vh, 32px)",
      }}
    >
      <div
        {...dialogProps}
        className="panel notch"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 100%)", maxHeight: "100%", margin: "auto", display: "flex", flexDirection: "column" }}
      >
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          borderBottom: "1px solid var(--edge)", padding: "16px 24px",
        }}>
          <div className="eyebrow" id={titleId} style={{ color: "var(--mist-dim)" }}>{title}</div>
          <button className="chip" onClick={finish} disabled={busy || uploading} style={{ fontSize: 9 }}>close esc</button>
        </div>

        {buildWarning ? (
          <>
            <div style={{ padding: "16px 24px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: "var(--mist)" }}>
                <span style={{ color: "var(--pine)" }}>✓</span> {name.trim()} is in {parentName}'s block.
              </p>
              <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--lamp)", border: "1px solid var(--edge-bright)", padding: "10px 12px" }}>
                {buildWarning.message}
              </div>
            </div>
            <div style={{ borderTop: "1px solid var(--edge)", padding: "12px 24px", display: "flex", justifyContent: "flex-end" }}>
              <button
                className="chip"
                onClick={finish}
                style={{ fontSize: 9, background: "var(--lamp)", color: "var(--night)", borderColor: "var(--lamp)" }}
              >
                ok
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: "16px 24px 20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
              <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: "var(--mist-mute)" }}>
                A tune-up inside <span style={{ color: "var(--mist)" }}>{parentName}</span>'s block: five fields,
                no intake and no agent turn. It lands on the trajectory at its week, the coach plans the taper and
                the recovery around it, and its planner is the reduced one — pacing and ETAs, no crew sheet.
              </p>

              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
                <label htmlFor={id("name")}>
                  <span className="eyebrow" style={labelStyle}>name</span>
                  <input
                    id={id("name")} type="text" value={name} style={field}
                    placeholder="Deadman Peaks 50k"
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                  />
                </label>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                  <label htmlFor={id("date")}>
                    <span className="eyebrow" style={labelStyle}>date</span>
                    <input
                      id={id("date")} type="date" value={date} style={field}
                      onChange={(e) => setDate(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label htmlFor={id("distance")}>
                    <span className="eyebrow" style={labelStyle}>distance mi</span>
                    <input
                      id={id("distance")} type="number" min={0} step={0.1} value={distance}
                      className="numerals" style={field}
                      onChange={(e) => setDistance(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                  <label htmlFor={id("gain")}>
                    <span className="eyebrow" style={labelStyle}>gain ft</span>
                    <input
                      id={id("gain")} type="number" min={0} step={10} value={gain}
                      className="numerals" style={field}
                      onChange={(e) => setGain(e.target.value)}
                      disabled={busy}
                    />
                  </label>
                </div>

                {dateTooFar ? (
                  <span className="eyebrow" style={{ fontSize: 8.5, color: "var(--ember)" }}>
                    {Math.round(yearsFromParent!)} years from {parentName} — nowhere near its block
                  </span>
                ) : weeksOut != null && (
                  <span className="eyebrow" style={{ fontSize: 8.5, color: weeksOut < 0 ? "var(--lamp)" : "var(--mist-mute)" }}>
                    {weeksOut > 0
                      ? `${weeksOut} week${weeksOut === 1 ? "" : "s"} out from ${parentName}`
                      : weeksOut === 0
                        ? `race week — the same week as ${parentName}`
                        : `${Math.abs(weeksOut)} week${Math.abs(weeksOut) === 1 ? "" : "s"} AFTER ${parentName} — it falls outside the block`}
                  </span>
                )}

                <label htmlFor={id("timezone")}>
                  <span className="eyebrow" style={labelStyle}>timezone</span>
                  <input
                    id={id("timezone")} type="text" value={timezone} style={field}
                    placeholder={parentTimezone ?? "inherited from the parent race"}
                    onChange={(e) => setTimezone(e.target.value)}
                    disabled={busy}
                  />
                  <span className="eyebrow" style={{ fontSize: 8, color: "var(--mist-mute)", display: "block", marginTop: 4 }}>
                    {parentTimezone
                      ? `left blank, it inherits ${parentTimezone} from ${parentSlug}`
                      : `left blank, it inherits the zone from ${parentSlug}`}
                  </span>
                </label>

                <div>
                  <span className="eyebrow" style={labelStyle}>course gpx — optional</span>
                  <input
                    type="file" accept=".gpx" aria-label="course gpx — optional"
                    disabled={busy || uploading}
                    onChange={(e) => { void upload(e.target.files); e.target.value = ""; }}
                    style={{ fontSize: 11, color: "var(--mist-mute)" }}
                  />
                  <span className="eyebrow" style={{ fontSize: 8, color: "var(--mist-mute)", display: "block", marginTop: 4 }}>
                    {uploading
                      ? "uploading…"
                      : gpx
                        ? `${gpx.name} · ${(gpx.bytes / 1024).toFixed(0)} kB — the course builds with the folder`
                        : "without one the tune-up has a finish line and no profile: ETAs need a course"}
                  </span>
                </div>
              </div>

              {error && (
                <div style={{ fontSize: 12, color: "var(--ember)", lineHeight: 1.5 }}>{error}</div>
              )}
            </div>

            <div style={{
              borderTop: "1px solid var(--edge)", padding: "12px 24px",
              display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap",
            }}>
              {/* The paid path, said out loud: a full intake is an agent run
                  against the race's own website, not this endpoint. */}
              <button
                className="chip"
                onClick={onRunIntake}
                disabled={busy || uploading}
                title={`open the full race intake, carrying ${parentSlug} over — an agent turn against the race's website, and it costs`}
                style={{ fontSize: 9, color: "var(--mist-mute)" }}
              >
                run the full intake instead · paid
              </button>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
                {disabledReason && (
                  <span className="eyebrow" style={{ fontSize: 8.5, color: "var(--mist-mute)" }}>{disabledReason}</span>
                )}
                <button
                  className="chip"
                  onClick={submit}
                  disabled={!canSubmit}
                  title={disabledReason ?? undefined}
                  style={{
                    fontSize: 9,
                    background: canSubmit ? "var(--lamp)" : undefined,
                    color: canSubmit ? "var(--night)" : undefined,
                    borderColor: canSubmit ? "var(--lamp)" : undefined,
                  }}
                >
                  {busy ? "adding…" : "add tune-up"}
                </button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
