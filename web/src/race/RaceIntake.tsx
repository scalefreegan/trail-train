// The "New race…" dialog and the review gate behind it (PRD §8).
//
// Two screens in one modal, because they are two halves of one decision:
//
//   form   — the race's own site, any extra URLs, the PDFs and GPX you have,
//            the edition year, a theme preset and what matters to you. "Run"
//            chains the three intake stages, each one's `done` feeding the
//            next, with the same streamed progress the resync button shows.
//   review — the folder that came out, as something you can argue with: the
//            aid chart, the built elevation profile, the block, the fuel plan
//            and — the part that earns the gate — the list of fields nothing
//            could establish. Activate stays dark until every one of them is
//            either filled in or explicitly acknowledged.
//
// Nothing here is speculative state: the draft is on disk from the moment
// stage 1 finishes, so closing the dialog (escape, backdrop, the X) loses only
// the scroll position. The same review screen reopens from the switcher's
// "Review…" row on any draft.
//
// Every write goes through PUT /api/races/:slug, which accepts exactly the
// fields this file renders and refuses the rest by name (scripts/race-edit.mjs).
// Activation is two steps on purpose — the folder's status first, then the
// pointer — because they are two different claims: "this race is real" and
// "this is what I am training for".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRefresh } from "../data";
import { THEME_PRESET_NAMES } from "../themes/presets";
import { ThemePreview } from "../themes/ThemePreview";
import type { Course, RaceAidStation, RaceBlock, RaceConfig } from "./types";
import type { NutritionConfig } from "./nutrition-config";
import { cellStyle, inputStyle, runStage, type StageEvent, type StageRow, type StageState } from "./dialogChrome";


/* ------------------------------------------------------------------ */
/*  Shapes                                                             */
/* ------------------------------------------------------------------ */

/** One scored waypoint the matcher considered for a station. */
type MatchCandidate = { wpt: string; score: number };

/** scripts/aid-match.mjs's per-station result, as GET /api/races/:slug sends it. */
type StationMatch = {
  name: string;
  gpx_wpt: string | null;
  method: "exact" | "fuzzy" | "distance" | null;
  confidence: number;
  candidates?: MatchCandidate[];
};

/** GET /api/races/:slug — everything the review screen renders, in one read. */
type ReviewPayload = {
  slug: string;
  race: RaceConfig;
  block: RaceBlock | null;
  nutrition: NutritionConfig | null;
  course: Course | null;
  has_gpx: boolean;
  waypoints: string[];
  matches: StationMatch[];
  unresolved: string[];
  /** field-specific pointers for a path that isn't a value a human just
      types in (`sun` is a script's output, not a form field) — keyed by
      the unresolved path, shown next to it in the list below. */
  unresolved_hints?: Record<string, string>;
  /** Target contract (fixer A, not yet landed): a list of acknowledged field
      paths. Until then the server still sends/accepts a single boolean —
      read side tolerates both (`normalizeAcked` below); write side always
      sends the array, which is what PUT /api/races/:slug will expect once
      A's schema change lands. */
  unresolved_acknowledged: boolean | string[];
  schema_errors: string[];
  activation: { ok: boolean; errors: string[] };
  /** block.json's weeks were counted back from a race date that is no
      longer race.json's — see scripts/race-edit.mjs's isBlockStale. Never
      touches block.json itself; this is a notice, not a write. */
  block_stale?: boolean;
  /** A prior "Accept" on this folder's re-intake started writing and did not
      finish (a crash, a closed tab) — some files may already be refreshed
      beside others that are not. Re-running Accept repairs it. */
  refresh_interrupted?: boolean;
};

/** Mirrors scripts/aid-match.mjs's LOW_CONFIDENCE — below it the match is a
    guess the mapping dropdown exists to settle, and the server agrees. */
const LOW_CONFIDENCE = 0.6;

type StageId = "intake" | "build" | "plan";

/** Round 1, bug D8: ESC/backdrop on a dirty "New race…" form used to discard
    it — fields AND the already-uploaded file — with no warning. A small
    inline confirm was the other option the plan offered; this codebase
    already leans on localStorage for "what this phone last saw" (see
    offlineCache.ts), the form has no server-side draft of its own to conflict
    with, and restoring silently on reopen needs no extra click from someone
    who dismissed the dialog by habit rather than intent. */
const NEW_RACE_DRAFT_KEY = "bc.newRaceDraft";
type NewRaceDraft = {
  siteUrl: string; extraUrls: string; year: string; notes: string; themePreset: string;
  uploads: { name: string; path: string; bytes: number }[];
};
const draftHasContent = (d: Pick<NewRaceDraft, "siteUrl" | "extraUrls" | "notes" | "uploads">): boolean =>
  Boolean(d.siteUrl.trim() || d.extraUrls.trim() || d.notes.trim() || d.uploads.length);
/** Read-only, synchronous, side-effect-free — safe to call straight from a
    `useState(() => …)` lazy initializer (unlike a ref, which the lint rule
    here refuses to let render read at all) without tripping the "no state
    updates during render" rule either, since nothing is written back here. */
const readNewRaceDraft = (openAt: string | null): NewRaceDraft | null => {
  if (openAt !== null) return null;
  try {
    const raw = localStorage.getItem(NEW_RACE_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<NewRaceDraft>;
    const normalized: NewRaceDraft = {
      siteUrl: d.siteUrl ?? "", extraUrls: d.extraUrls ?? "", year: d.year ?? String(new Date().getFullYear() + 1),
      notes: d.notes ?? "", themePreset: d.themePreset ?? "", uploads: d.uploads ?? [],
    };
    return draftHasContent(normalized) ? normalized : null;
  } catch {
    return null; // a corrupt draft is no worse than no draft
  }
};

const STAGES: { id: StageId; label: string; blurb: string }[] = [
  { id: "intake", label: "sources → draft", blurb: "fetches the site, the manual and the GPX, then one agent turn transcribes the aid chart" },
  { id: "build", label: "course", blurb: "snaps the aid stations to the GPX track, computes sun and the elevation profile" },
  { id: "plan", label: "block + fuel", blurb: "one agent turn: block targets back from race day, the fueling plan, coach notes" },
];

/* ------------------------------------------------------------------ */
/*  SSE                                                                */
/* ------------------------------------------------------------------ */

export const Eyebrow = ({ children }: { children: React.ReactNode }) => (
  <div className="eyebrow" style={{ fontSize: 9, color: "var(--lamp)", margin: "0 0 8px" }}>{children}</div>
);
export const Hint = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
  <div style={{ fontSize: 10.5, color: "var(--mist-mute)", marginTop: 4, lineHeight: 1.45, ...style }}>{children}</div>
);
export const Block = ({ children }: { children: React.ReactNode }) => (
  <div style={{ marginBottom: 26 }}>{children}</div>
);

/* ------------------------------------------------------------------ */
/*  The dialog                                                         */
/* ------------------------------------------------------------------ */

export default function RaceIntake({ slug: openAt = null, onClose }: {
  /** A draft to review straight away — the switcher's "Review…" row. Absent
      means the intake form, the "New race…" row. */
  slug?: string | null;
  onClose: () => void;
}) {
  const { reload } = useRefresh();
  const [slug, setSlug] = useState<string | null>(openAt);
  const [screen, setScreen] = useState<"form" | "review">(openAt ? "review" : "form");

  // Restore a form abandoned by ESC/backdrop (round 1, bug D8) — read once,
  // synchronously, during the first render, so the fields never flash empty
  // before filling in. Only for the "New race…" path — a draft already on
  // disk, opened via "Review…", has nothing to restore into. Each of these
  // lazy initializers only runs on mount, so re-reading localStorage per
  // field (rather than caching it) is cheap and still one consistent read.
  const [siteUrl, setSiteUrl] = useState(() => readNewRaceDraft(openAt)?.siteUrl ?? "");
  const [extraUrls, setExtraUrls] = useState(() => readNewRaceDraft(openAt)?.extraUrls ?? "");
  const [year, setYear] = useState(() => readNewRaceDraft(openAt)?.year ?? String(new Date().getFullYear() + 1));
  const [notes, setNotes] = useState(() => readNewRaceDraft(openAt)?.notes ?? "");
  const [themePreset, setThemePreset] = useState<string>(() => readNewRaceDraft(openAt)?.themePreset ?? "");
  const [uploads, setUploads] = useState<{ name: string; path: string; bytes: number }[]>(() => readNewRaceDraft(openAt)?.uploads ?? []);
  const [uploading, setUploading] = useState(false);
  const [restoredDraft] = useState(() => readNewRaceDraft(openAt) !== null);

  // run
  const [running, setRunning] = useState(false);
  const [stageState, setStageState] = useState<Record<StageId, StageState>>({ intake: "pending", build: "pending", plan: "pending" });
  const [stageLog, setStageLog] = useState<Record<StageId, string>>({ intake: "", build: "", plan: "" });
  const [runError, setRunError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [error, setError] = useState<string | null>(null);

  // The review screen (mounted below once a draft exists) runs its own
  // stage-again / save / activate calls, on its own `busy`/`stage` state we
  // can't see from here — it reports up through this so a close mid-activate
  // is blocked the same way a close mid-run is (see RaceRefresh.tsx's single
  // `locked`, which this mirrors across the two components).
  const [reviewLocked, setReviewLocked] = useState(false);
  const locked = running || reviewLocked;

  // Escape closes. The draft is on disk, so there is nothing here to lose —
  // except mid-run (or mid-review-screen-write), where closing would orphan
  // a stream or leave a second concurrent write racing a reopened dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !locked) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, locked]);
  useEffect(() => () => abortRef.current?.abort(), []);

  // Persist on every change so ESC/backdrop never loses it again.
  useEffect(() => {
    if (openAt !== null) return;
    try {
      const draft: NewRaceDraft = { siteUrl, extraUrls, year, notes, themePreset, uploads };
      if (draftHasContent(draft)) localStorage.setItem(NEW_RACE_DRAFT_KEY, JSON.stringify(draft));
      else localStorage.removeItem(NEW_RACE_DRAFT_KEY);
    } catch { /* private browsing / storage disabled — best-effort only */ }
  }, [openAt, siteUrl, extraUrls, year, notes, themePreset, uploads]);

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const res = await fetch("/api/race-intake/upload", {
          method: "POST",
          headers: { "X-Filename": encodeURIComponent(file.name) },
          body: file,
        });
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        const saved = body as { name: string; path: string; bytes: number };
        setUploads((prev) => [...prev.filter((u) => u.path !== saved.path), saved]);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const run = useCallback(async () => {
    setRunning(true);
    setRunError(null);
    setError(null);
    setStageState({ intake: "pending", build: "pending", plan: "pending" });
    setStageLog({ intake: "", build: "", plan: "" });
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const events = (id: StageId) => (e: StageEvent) => {
      if (e.kind === "log") setStageLog((p) => ({ ...p, [id]: e.line }));
      else if (e.kind === "step" && e.status === "start") setStageLog((p) => ({ ...p, [id]: e.label ?? e.id }));
      else if (e.kind === "error") setStageLog((p) => ({ ...p, [id]: e.message }));
    };
    const mark = (id: StageId, s: StageState) => setStageState((p) => ({ ...p, [id]: s }));

    try {
      mark("intake", "running");
      const intake = await runStage("/api/race-intake", {
        site_url: siteUrl.trim(),
        extra_urls: extraUrls.split(/\s+/).map((u) => u.trim()).filter(Boolean),
        year: year.trim(),
        uploads: uploads.map((u) => ({ name: u.name, path: u.path })),
        notes: notes.trim(),
      }, events("intake"), ctrl.signal);
      mark("intake", "done");
      const made = String(intake.slug ?? "");
      if (!made) throw new Error("the intake finished without naming a folder");
      setSlug(made);

      // The intake endpoint has no theme field — the picker is a review-screen
      // choice the form lets you make early, so it is written as an edit the
      // moment the folder exists rather than being carried in the request.
      if (themePreset) {
        await fetch(`/api/races/${made}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visual: { theme_preset: themePreset } }),
        }).catch(() => { /* a preset is cosmetic — never fail a run over it */ });
      }

      mark("build", "running");
      await runStage("/api/race-intake/build", { slug: made }, events("build"), ctrl.signal);
      mark("build", "done");

      mark("plan", "running");
      await runStage("/api/race-intake/plan", { slug: made }, events("plan"), ctrl.signal);
      mark("plan", "done");

      // The form's job is done — the draft folder is now the source of
      // truth, so the localStorage safety net (bug D8) is cleared with it.
      try { localStorage.removeItem(NEW_RACE_DRAFT_KEY); } catch { /* best-effort */ }
      setScreen("review");
    } catch (e) {
      // Stop the chain where it broke and say so in the server's own words.
      // Whatever landed stays on disk: a draft that only got through stage 1
      // is still a draft, and the switcher will list it.
      setStageState((p) => {
        const next = { ...p };
        for (const s of STAGES) if (next[s.id] === "running") next[s.id] = "error";
        for (const s of STAGES) if (next[s.id] === "pending") next[s.id] = "skipped";
        return next;
      });
      setRunError((e as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [siteUrl, extraUrls, year, uploads, notes, themePreset]);

  // 1800 (or 9999) is technically 4 digits but no race is happening then —
  // round 1, bug D14. A generous ±10-year window around today covers a
  // late-registered past edition and a race announced years out.
  const yearNum = Number(year.trim());
  const thisYear = new Date().getFullYear();
  const yearOk = /^\d{4}$/.test(year.trim()) && yearNum >= thisYear - 10 && yearNum <= thisYear + 10;
  const canRun = /^https?:\/\/\S+$/i.test(siteUrl.trim()) && yearOk && !running;
  const ranAnything = STAGES.some((s) => stageState[s.id] !== "pending");

  const header = screen === "review" ? "review · draft race" : "new race";
  const subtitle = screen === "review"
    ? "check what the intake read, fill or accept what it could not, then activate"
    : "the race's own site, whatever documents you have, and one run of the three intake stages";

  return createPortal(
    <Backdrop onClose={() => { if (!locked) onClose(); }}>
      <div
        className="panel notch"
        role="dialog"
        aria-modal="true"
        aria-label={header}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: screen === "review" ? "min(1240px, 100%)" : "min(720px, 100%)",
          margin: "0 auto", display: "flex", flexDirection: "column", maxHeight: "100%", flex: "0 1 auto",
        }}
      >
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16,
          borderBottom: "1px solid var(--edge)", padding: "16px 28px", flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow" style={{ color: "var(--mist-dim)" }}>{header}</div>
            <div style={{ fontSize: 11.5, color: "var(--mist-mute)", marginTop: 3 }}>{subtitle}</div>
          </div>
          <button className="chip" onClick={onClose} disabled={locked} style={{ fontSize: 9 }}>
            {locked ? "working…" : "close esc"}
          </button>
        </div>

        {screen === "review" && slug ? (
          <ReviewScreen
            slug={slug}
            onDone={() => { reload(); onClose(); }}
            onReload={reload}
            onLockedChange={setReviewLocked}
          />
        ) : (
          <>
            <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "24px 28px 8px" }}>
              {restoredDraft && (
                <p style={{ fontSize: 11, color: "var(--lamp)", margin: "0 0 16px", lineHeight: 1.5 }}>
                  restored your unsent form — closing this dialog kept what you had typed and any file already uploaded
                </p>
              )}
              <Block>
                <Eyebrow>sources</Eyebrow>
                <label style={{ display: "block" }}>
                  <Hint style={{ marginTop: 0, marginBottom: 4 }}>race site (required)</Hint>
                  <input
                    style={{ ...inputStyle, width: "100%" }}
                    placeholder="https://www.sanjuansoftie.com/"
                    value={siteUrl}
                    autoFocus
                    onChange={(e) => setSiteUrl(e.target.value)}
                  />
                  <Hint>the intake follows this page's own links to the runner's manual, the GPX, results and tracking</Hint>
                </label>
                <label style={{ display: "block", marginTop: 14 }}>
                  <Hint style={{ marginTop: 0, marginBottom: 4 }}>extra URLs</Hint>
                  <textarea
                    style={{ ...inputStyle, width: "100%", minHeight: 58, resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 11.5 }}
                    placeholder={"one per line — a results page, a course-change post, a Gaia or CalTopo link"}
                    value={extraUrls}
                    onChange={(e) => setExtraUrls(e.target.value)}
                  />
                </label>
                <div style={{ marginTop: 14 }}>
                  <Hint style={{ marginTop: 0, marginBottom: 4 }}>uploads · PDF, GPX, KML, HTML</Hint>
                  <input
                    type="file"
                    multiple
                    accept=".pdf,.gpx,.kml,.txt,.html,.htm"
                    disabled={uploading || running}
                    onChange={(e) => { void upload(e.target.files); e.target.value = ""; }}
                    style={{ fontSize: 11.5, color: "var(--mist-mute)" }}
                  />
                  {uploads.length > 0 && (
                    <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 4 }}>
                      {uploads.map((u) => (
                        <li key={u.path} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 11.5, color: "var(--mist)" }}>
                          <span style={{ color: "var(--pine)" }}>✓</span>
                          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{u.name}</span>
                          <span className="numerals" style={{ color: "var(--mist-mute)", fontSize: 10.5 }}>
                            {u.bytes < 1024 ? `${u.bytes} B` : `${(u.bytes / 1024).toFixed(0)} KB`}
                          </span>
                          <button
                            className="chip"
                            style={{ fontSize: 8.5 }}
                            onClick={() => setUploads((prev) => prev.filter((p) => p.path !== u.path))}
                          >
                            remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {error && <p style={{ fontSize: 11, color: "var(--ember)", margin: "8px 0 0", lineHeight: 1.45 }}>{error}</p>}
                  <Hint>a runner's manual whose aid chart is an image is rendered to page images and transcribed — that is the case this pipeline was built for</Hint>
                </div>
              </Block>

              <Block>
                <Eyebrow>the edition</Eyebrow>
                <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 14, alignItems: "start" }}>
                  <label>
                    <Hint style={{ marginTop: 0, marginBottom: 4 }}>year</Hint>
                    <input
                      className="numerals"
                      style={{ ...inputStyle, width: "100%" }}
                      value={year}
                      inputMode="numeric"
                      onChange={(e) => setYear(e.target.value)}
                    />
                  </label>
                  <label>
                    <Hint style={{ marginTop: 0, marginBottom: 4 }}>theme</Hint>
                    <select
                      style={{ ...inputStyle, width: "100%" }}
                      value={themePreset}
                      onChange={(e) => setThemePreset(e.target.value)}
                    >
                      <option value="">let the intake suggest one</option>
                      {THEME_PRESET_NAMES.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <Hint>
                      {themePreset
                        ? <ThemePreview visual={{ theme_preset: themePreset }} size={10} />
                        : "presets keep one Basecamp identity — a race varies its hue, not its brand"}
                    </Hint>
                  </label>
                </div>
                <label style={{ display: "block", marginTop: 14 }}>
                  <Hint style={{ marginTop: 0, marginBottom: 4 }}>what matters to me</Hint>
                  <textarea
                    style={{ ...inputStyle, width: "100%", minHeight: 76, resize: "vertical" }}
                    placeholder="what you want the plan to weigh — altitude, night, a cutoff you are worried about, a crew that can only reach two stations"
                    maxLength={8000}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                  <Hint>handed to both agent turns verbatim</Hint>
                </label>
              </Block>

              {(ranAnything || runError) && (
                <Block>
                  <Eyebrow>progress</Eyebrow>
                  <StageList stages={STAGES} state={stageState} log={stageLog} />
                  {runError && (
                    <p style={{ fontSize: 11.5, color: "var(--ember)", lineHeight: 1.5, marginTop: 12 }}>
                      {runError}
                      {slug && <><br />The folder <span className="numerals" style={{ color: "var(--mist)" }}>races/{slug}/</span> is on disk and listed in the switcher — reopen it with “Review…” once this is sorted.</>}
                    </p>
                  )}
                </Block>
              )}
            </div>

            <div style={{
              display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10,
              borderTop: "1px solid var(--edge)", padding: "14px 28px", flexShrink: 0,
            }}>
              <span style={{ fontSize: 10.5, color: "var(--mist-mute)", marginRight: "auto", lineHeight: 1.4 }}>
                stages 1 and 3 each cost one headless <code style={{ fontFamily: "var(--font-mono)" }}>claude -p</code> turn on your subscription
              </span>
              {slug && (
                <button className="chip" onClick={() => setScreen("review")} style={{ fontSize: 10 }}>
                  review draft
                </button>
              )}
              <button className="chip" onClick={onClose} disabled={locked} style={{ fontSize: 10 }}>
                {ranAnything ? "save draft" : "cancel"}
              </button>
              <button
                className="chip"
                onClick={run}
                disabled={!canRun}
                style={{
                  fontSize: 10, padding: "5px 16px", borderColor: "var(--lamp)",
                  background: canRun ? "var(--lamp)" : "transparent",
                  color: canRun ? "var(--night)" : "var(--lamp)",
                  cursor: canRun ? "pointer" : "not-allowed",
                }}
              >
                {running ? "running…" : ranAnything ? "run again" : "run intake"}
              </button>
            </div>
          </>
        )}
      </div>
    </Backdrop>,
    document.body,
  );
}

/** Close only when the CLICK STARTED on the backdrop — releasing a
    text-selection drag over the edge of the panel must not close it. */
export function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const startedOnBackdrop = useRef(false);
  return (
    <div
      onMouseDown={(e) => { startedOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && startedOnBackdrop.current) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 100, background: "rgba(4, 8, 12, 0.78)",
        display: "flex", padding: "clamp(12px, 3vh, 32px)",
      }}
    >
      {children}
    </div>
  );
}

/** A run sheet — same vocabulary as the command bar's resync filament, one row
    per stage because these are minutes, not seconds. The stages are a
    parameter: the intake runs three and a refresh (RaceRefresh.tsx) runs four,
    and they are the same sheet. */
export function StageList({ stages, state, log }: {
  stages: StageRow[];
  state: Record<string, StageState>;
  log: Record<string, string>;
}) {
  const tint: Record<StageState, string> = {
    pending: "var(--edge-bright)", running: "var(--lamp)", done: "var(--pine)",
    error: "var(--ember)", skipped: "var(--edge-bright)",
  };
  const at = (id: string): StageState => state[id] ?? "pending";
  return (
    <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
      {stages.map((s, i) => (
        <li key={s.id} style={{ display: "flex", gap: 10, alignItems: "baseline", opacity: at(s.id) === "skipped" ? 0.45 : 1 }}>
          <span
            aria-hidden
            className={at(s.id) === "running" ? "pulse" : undefined}
            style={{ width: 7, height: 7, transform: "rotate(45deg)", background: tint[at(s.id)], flexShrink: 0, marginTop: 4 }}
          />
          <span className="numerals" style={{ fontSize: 10.5, color: "var(--mist-mute)", width: 14 }}>{i + 1}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 12.5, color: at(s.id) === "pending" ? "var(--mist-mute)" : "var(--mist)" }}>{s.label}</span>
            <div style={{ fontSize: 10.5, color: "var(--mist-mute)", lineHeight: 1.45, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {log[s.id] || s.blurb}
            </div>
          </span>
          <span className="eyebrow" style={{ fontSize: 8, color: tint[at(s.id)], whiteSpace: "nowrap" }}>{at(s.id)}</span>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/*  Review screen                                                      */
/* ------------------------------------------------------------------ */

/** The edit buffer: only the fields the review screen renders, keyed the way
    PUT /api/races/:slug wants them back. Anything not touched is absent, so a
    save writes what was changed and nothing else. */
type AidEdit = Partial<Pick<RaceAidStation, "name" | "total_mi" | "cutoff_h" | "crew" | "drop_bag" | "pacers" | "gpx_wpt">>;

/** Reads either shape of `unresolved_acknowledged` as "is this path currently
    acknowledged, per the folder on disk". A bare `true` (today's server) means
    every path CURRENTLY unresolved was acknowledged at the time it was
    written — it says nothing about a path that has surfaced since, which is
    the whole point of moving to a list (round 1, bug R3/D6/D7). */
const diskAcked = (data: Pick<ReviewPayload, "unresolved_acknowledged"> | null, path: string): boolean => {
  const v = data?.unresolved_acknowledged;
  if (Array.isArray(v)) return v.includes(path);
  return v === true;
};

function ReviewScreen({ slug, onDone, onReload, onLockedChange }: {
  slug: string; onDone: () => void; onReload: () => void;
  /** Reports "a write or a stage re-run is in flight" up to RaceIntake, whose
      Escape/backdrop/close-button guards can't see this component's own
      `busy`/`stage` state otherwise (PR #23 review round 1, finding 6). */
  onLockedChange: (locked: boolean) => void;
}) {
  const [data, setData] = useState<ReviewPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<null | "saving" | "activating">(null);

  /* Stage 2 and stage 3 again, on a folder that already exists. The endpoints
     were built to be asked twice — the course build is deterministic and free,
     and the plan is a paid agent turn that is deliberately its own button
     rather than something the build chains into. */
  const [stage, setStage] = useState<null | "build" | "plan">(null);
  const [stageLine, setStageLine] = useState("");
  const [aidEdits, setAidEdits] = useState<Record<number, AidEdit>>({});
  const [blockEdits, setBlockEdits] = useState<Record<number, { target_dist?: number; target_elev?: number }>>({});
  const [themeEdit, setThemeEdit] = useState<string | null>(null);
  const [fills, setFills] = useState<Record<string, string>>({});
  const [acked, setAcked] = useState<Record<string, boolean>>({});

  // Mirrors RaceRefresh.tsx's single `locked = running || busy !== null`,
  // split across the parent (`running`) and this component (`busy`/`stage`)
  // — reported up on every change so the dialog's close paths see it.
  useEffect(() => {
    onLockedChange(busy !== null || stage !== null);
  }, [busy, stage, onLockedChange]);

  // runStageAgain's SSE stream has nothing to cancel it if the dialog closes
  // (unmounting this component) mid-run, unlike run()'s top-level abortRef —
  // stored here so the cleanup below can reach the CURRENT run's controller.
  const stageAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => stageAbortRef.current?.abort(), []);

  // Re-read on mount, and whenever a caller bumps the pulse — the folder is
  // the source of truth and a refused write must never leave the screen
  // showing something that is not on disk.
  //
  // `load(keepError)` — REVERT calls it bare, which clears any refused-save
  // error list along with the edit buffers (round 1, bug R3/D5). But
  // activate() also calls it after a refused status/pointer flip, to pick up
  // whatever the earlier PUT in the same activate attempt DID manage to write
  // — and that reload must not wipe the very error it is being called to
  // react to (PR #23 review round 2, draft finding 1: ACTIVATE's 400 was
  // rendered into `saveError` and then immediately cleared by this effect's
  // own success handler before the athlete ever saw it, since the GET here
  // succeeds even when the activation it followed did not).
  const [readKey, setReadKey] = useState(0);
  const keepErrorRef = useRef<string[] | null>(null);
  const load = useCallback((keepError?: string[] | null) => {
    keepErrorRef.current = keepError ?? null;
    setReadKey((k) => k + 1);
  }, []);
  useEffect(() => {
    let stale = false;
    fetch(`/api/races/${slug}?t=${Date.now()}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
        return body as ReviewPayload;
      })
      .then((body) => {
        if (stale) return;
        setData(body);
        // REVERT is "every control in the dialog back to the on-disk state"
        // (round 1, bug R3/D6) — that includes the acknowledge checkboxes,
        // not just the edit buffers.
        setAidEdits({}); setBlockEdits({}); setThemeEdit(null); setFills({}); setAcked({});
        setSaveError(keepErrorRef.current);
        keepErrorRef.current = null;
        setLoadError(null);
      })
      .catch((e: Error) => { if (!stale) setLoadError(e.message); });
    return () => { stale = true; };
  }, [slug, readKey]);

  const race = data?.race;
  const stations = race?.aid_stations ?? [];

  const stationValue = <K extends keyof AidEdit>(i: number, key: K): AidEdit[K] =>
    (key in (aidEdits[i] ?? {}) ? aidEdits[i][key] : stations[i]?.[key]) as AidEdit[K];

  // A duplicate gpx_wpt across two stations silently reassigns which station
  // a course reader thinks a point belongs to, and the server does not (yet)
  // refuse it either — round 1, bug D3. Flagged per row, blocking SAVE until
  // resolved rather than letting a save go out that the aid chart itself
  // disagrees with.
  const wptConflicts = new Map<number, number[]>();
  {
    const byWpt = new Map<string, number[]>();
    stations.forEach((_s, i) => {
      const w = stationValue(i, "gpx_wpt") as string | null | undefined;
      if (!w) return;
      byWpt.set(w, [...(byWpt.get(w) ?? []), i]);
    });
    for (const idxs of byWpt.values()) {
      if (idxs.length < 2) continue;
      for (const i of idxs) wptConflicts.set(i, idxs.filter((j) => j !== i));
    }
  }
  const hasWptConflict = wptConflicts.size > 0;

  // Any edit clears a refused save's error list (round 1, bug D5) — it was
  // asserting a violation that the next edit may no longer create, and
  // leaving it up reads as "this is still true".
  const editStation = (i: number, patch: AidEdit) => {
    setSaveError(null);
    setAidEdits((prev) => ({ ...prev, [i]: { ...prev[i], ...patch } }));
  };

  const openHoles = data?.unresolved ?? [];
  const unfilled = openHoles.filter((u) => !(fills[u] ?? "").trim());
  // An acknowledgement already on disk (either shape) is the default each
  // checkbox falls back to — reopening the dialog must not look like the
  // work was lost. A local toggle in `acked` overrides it until REVERT.
  const isAcked = (p: string) => acked[p] ?? diskAcked(data, p);
  // The counter is the REMAINING count — a field that is filled counts as
  // resolved even before it is acknowledged, and an already-acked field must
  // not inflate it (round 1, bug D7).
  const remaining = unfilled.filter((p) => !isAcked(p)).length;
  const allAcked = remaining === 0;
  const ackDirty = openHoles.some((p) => isAcked(p) !== diskAcked(data, p));

  const dirty = Object.keys(aidEdits).length > 0 || Object.keys(blockEdits).length > 0 ||
    themeEdit !== null || Object.values(fills).some((v) => v.trim()) || ackDirty;

  const runStageAgain = async (which: "build" | "plan") => {
    setStage(which);
    setStageLine("");
    setSaveError(null);
    const ctrl = new AbortController();
    stageAbortRef.current = ctrl;
    try {
      await runStage(
        which === "build" ? "/api/race-intake/build" : "/api/race-intake/plan",
        { slug },
        (e) => {
          if (e.kind === "log") setStageLine(e.line);
          else if (e.kind === "step" && e.status === "start") setStageLine(e.label ?? e.id);
          else if (e.kind === "error") setStageLine(e.message);
        },
        ctrl.signal,
      );
      setStageLine("");
      load();
    } catch (e) {
      // The dialog was closed (stageAbortRef's cleanup effect) — nothing to
      // report to a component that is unmounting.
      if ((e as Error).name === "AbortError") return;
      // A dropped connection (dev-server restart, network reset) surfaces as
      // either a fetch failure or the SSE reader running out of bytes with no
      // `done` frame (dialogChrome.ts's "the stream ended before…"). Round 1,
      // bug R5: silently landing back on the resting state with no error at
      // all reads as "nothing happened", when the build may be half-written.
      const msg = (e as Error).message;
      const connectionLost = (e as Error).name === "TypeError" || /stream ended before/.test(msg);
      setSaveError([connectionLost
        ? "connection to the server was lost — reload and check the run sheet"
        : msg]);
    } finally {
      setStage(null);
      stageAbortRef.current = null;
    }
  };

  /** The PUT body for whatever is currently in the edit buffer. */
  const buildBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const body: Record<string, unknown> = { ...extra };
    const rows = Object.entries(aidEdits)
      .map(([i, patch]) => ({
        index: Number(i),
        // A trailing space in a typed name is never intentional (round 1, D14).
        ...patch, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      }))
      .filter((r) => Object.keys(r).length > 1);
    if (rows.length) body.aid_stations = rows;
    if (themeEdit !== null) body.visual = { theme_preset: themeEdit };
    // Contract with fixer A: unresolved_acknowledged becomes a list of
    // acknowledged paths. The current server still stores/returns a single
    // boolean (`diskAcked` tolerates that on read), but every write from here
    // on sends the list — that is the shape A's schema change expects, and it
    // is also the only way to persist un-ticking a box (round 1, bug D6/R3):
    // a bare `true` can never express "acknowledged all but this one".
    //
    // Only when `ackDirty` — a checkbox was actually touched THIS session, so
    // its local state (`acked`) disagrees with what's on disk. Sending the
    // list on every save (even an unrelated aid-station edit that never
    // touched a checkbox) used to resend whatever this tab last loaded as
    // "acked", which is a lost-update bug the moment a second tab is open: an
    // ack withdrawn in tab A gets silently reinstated by an unrelated save in
    // stale tab B, since B's `acked` is empty and falls back to ITS OWN
    // (older) `data` for every path either way (PR #23 review round 2, draft
    // finding 2). A tab that never touched the boxes now sends nothing for
    // this field, leaving whatever the last tab to actually change it wrote.
    if (unfilled.length && ackDirty) body.unresolved_acknowledged = unfilled.filter(isAcked);
    if (data?.block && Object.keys(blockEdits).length) {
      body.block_targets = data.block.targets.map((t) => ({
        wk: t.wk,
        target_dist: blockEdits[t.wk]?.target_dist ?? t.target_dist,
        target_elev: blockEdits[t.wk]?.target_elev ?? t.target_elev,
      }));
    }
    const filled: Record<string, string | number> = {};
    for (const [p, raw] of Object.entries(fills)) {
      const v = raw.trim();
      if (!v) continue;
      // The server's schema check decides the type; a bare number is sent as
      // one so `elevation.min_ft` does not arrive as the string "7900".
      filled[p] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    // `date` has its own key in the whitelist rather than riding in the fills.
    if ("date" in filled) { body.date = filled.date; delete filled.date; }
    if (Object.keys(filled).length) body.unresolved_fills = filled;
    return body;
  };

  const put = async (body: Record<string, unknown>): Promise<ReviewPayload> => {
    const res = await fetch(`/api/races/${slug}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json();
    if (!res.ok) {
      const errors = (payload as { errors?: string[] }).errors ?? [String((payload as { error?: string }).error)];
      // Back-compat with a server that has not yet landed fixer A's per-path
      // `unresolved_acknowledged` schema change — it still wants a bare
      // boolean and refuses the array outright. Collapse to the old shape
      // once and retry, rather than 400ing every save that happens to touch
      // a race with anything unresolved: "every current path acked" still
      // has an exact boolean equivalent; a partial un-ack does not (that is
      // the whole reason for the array), so it is left off the retry —
      // everything else in the body (the actual edit) still lands.
      const ackArr = body.unresolved_acknowledged;
      if (Array.isArray(ackArr) && errors.some((e) => /unresolved_acknowledged: boolean required/.test(e))) {
        const retryBody = { ...body };
        if (ackArr.length === unfilled.length) retryBody.unresolved_acknowledged = true;
        else delete retryBody.unresolved_acknowledged;
        return put(retryBody);
      }
      throw Object.assign(new Error("save refused"), { errors });
    }
    return payload as ReviewPayload;
  };

  const save = async () => {
    setBusy("saving");
    setSaveError(null);
    try {
      const body = buildBody();
      if (Object.keys(body).length === 0) { setBusy(null); return; }
      setData(await put(body));
      setAidEdits({}); setBlockEdits({}); setThemeEdit(null); setFills({}); setAcked({});
      onReload();
    } catch (e) {
      setSaveError((e as { errors?: string[] }).errors ?? [(e as Error).message]);
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    setBusy("activating");
    setSaveError(null);
    try {
      // One write for the pending edits AND the acknowledgement, so a refused
      // activation never leaves half of the review screen committed.
      // buildBody() already includes the current per-path acknowledgement
      // array whenever there is anything unresolved left to acknowledge.
      const body = buildBody();
      if (Object.keys(body).length) setData(await put(body));

      const statusRes = await fetch(`/api/races/${slug}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      const statusBody = await statusRes.json();
      if (!statusRes.ok) {
        // `load(...)`, not a bare `setSaveError` + `load()`: the reload picks
        // up whatever the PUT above DID manage to write, and must not wipe
        // the very error it is being called to react to (see the comment on
        // `load` above — PR #23 review round 2, draft finding 1).
        load((statusBody as { errors?: string[] }).errors ?? [String((statusBody as { error?: string }).error)]);
        return;
      }

      // Status first, then the pointer: "this race is real" and "this is what
      // I am training for" are two claims, and only the second one moves the
      // app. Train mode is the whole point of activating.
      const ptr = await fetch("/api/race/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, mode: "train" }),
      });
      if (!ptr.ok) {
        const b = await ptr.json().catch(() => ({ error: `HTTP ${ptr.status}` }));
        load([`the folder is active but the pointer did not move: ${(b as { error?: string }).error}`]);
        return;
      }
      onDone();
    } catch (e) {
      load((e as { errors?: string[] }).errors ?? [(e as Error).message]);
    } finally {
      setBusy(null);
    }
  };

  if (loadError) {
    return (
      <div style={{ padding: "24px 28px", fontSize: 12.5, color: "var(--ember)", lineHeight: 1.5 }}>
        {loadError}
      </div>
    );
  }
  if (!data || !race) {
    return <div style={{ padding: "24px 28px", fontSize: 12.5, color: "var(--mist-mute)" }}>reading races/{slug}/…</div>;
  }

  const isDraft = race.status === "draft";
  // `data.activation` is the server's own verdict as of the last GET/PUT
  // response — it can refuse for a reason the ack checkboxes can never fix
  // (PR #23 review round 2, draft finding 1: a night race with no computed
  // sun stays refused no matter how many boxes are ticked — see
  // validateStatusTransition in scripts/race-edit.mjs). But it can ALSO be
  // stale in exactly one dimension: "N unresolved fields — fill or
  // acknowledge" reflects whatever was on disk as of that last read, while
  // `remaining` above tracks the SAME gate live against the checkboxes the
  // athlete is ticking right now. Recognizing that one message and leaving it
  // to `remaining` avoids nagging about an ack the athlete already made
  // locally but has not saved yet; every other reason (wrong status, another
  // folder already active, the missing-sun block, a schema failure) is
  // real regardless of any checkbox and must not be swallowed just because
  // there also happen to be open holes (which is exactly what let the sun
  // block above go silent).
  const activationBlocked = data.activation.ok === false
    && !/unresolved field.*fill them in or acknowledge/i.test(data.activation.errors?.[0] ?? "");
  const blockers = !isDraft
    ? [`this folder's status is "${race.status}" — only a draft activates here`]
    : remaining > 0
      ? [`${remaining} unresolved field${remaining > 1 ? "s" : ""} still to fill in or acknowledge`]
      : activationBlocked
        ? data.activation.errors
        : [];
  const canActivate = isDraft && allAcked && busy === null && stage === null && !hasWptConflict && !activationBlocked;

  return (
    <>
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "24px 28px 8px" }}>
        <Block>
          <Eyebrow>{race.name} · {race.short}</Eyebrow>
          <div style={{ display: "flex", gap: 22, flexWrap: "wrap", fontSize: 11.5, color: "var(--mist-mute)" }}>
            <span><span className="numerals" style={{ color: "var(--mist)" }}>{race.distance_mi}</span> mi</span>
            <span><span className="numerals" style={{ color: "var(--mist)" }}>{race.gain_ft?.toLocaleString()}</span> ft gain</span>
            <span>start <span className="numerals" style={{ color: "var(--mist)" }}>{race.start_time}</span> {race.timezone}</span>
            <span>cutoff <span className="numerals" style={{ color: "var(--mist)" }}>{race.cutoff_h ?? "—"}</span> h</span>
            <span>date <span className="numerals" style={{ color: race.date ? "var(--mist)" : "var(--ember)" }}>{race.date ?? "unknown"}</span></span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              theme
              <select
                style={{ ...inputStyle, fontSize: 11, padding: "2px 6px" }}
                value={themeEdit ?? race.visual?.theme_preset ?? ""}
                onChange={(e) => { setSaveError(null); setThemeEdit(e.target.value); }}
              >
                <option value="">none</option>
                {THEME_PRESET_NAMES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              {/* the race's own accent and overrides ride along — the strip
                  has to preview THIS race, not the bare preset */}
              <ThemePreview visual={{ ...race.visual, theme_preset: themeEdit ?? race.visual?.theme_preset }} size={10} />
            </span>
          </div>
          {race.review_notes && (
            <p style={{ fontSize: 11.5, color: "var(--mist-mute)", lineHeight: 1.55, margin: "12px 0 0", borderLeft: "2px solid var(--edge-bright)", paddingLeft: 12 }}>
              {race.review_notes}
            </p>
          )}
        </Block>

        {data.refresh_interrupted && (
          <Block>
            <p style={{ fontSize: 11.5, color: "var(--ember)", margin: 0 }}>
              a refresh didn't finish landing — some files here may be updated while others are not. Re-run Accept from the refresh review to repair it.
            </p>
          </Block>
        )}

        <UnresolvedList
          unresolved={openHoles}
          hints={data.unresolved_hints ?? {}}
          race={race}
          course={data.course}
          fills={fills}
          isAcked={isAcked}
          onFill={(p, v) => { setSaveError(null); setFills((prev) => ({ ...prev, [p]: v })); }}
          onAck={(p, v) => { setSaveError(null); setAcked((prev) => ({ ...prev, [p]: v })); }}
        />

        {data.schema_errors.length > 0 && (
          <Block>
            <Eyebrow>race.json does not validate</Eyebrow>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11.5, color: "var(--ember)", lineHeight: 1.6 }}>
              {data.schema_errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          </Block>
        )}

        <Block>
          <Eyebrow>stages · run again</Eyebrow>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="chip"
              style={{ fontSize: 10 }}
              disabled={stage !== null || busy !== null}
              onClick={() => void runStageAgain("build")}
              title="fetch the GPX if the folder has none, snap the aid stations to the track, compute sun, rebuild the profile"
            >
              {stage === "build" ? "building…" : "course"}
            </button>
            <button
              className="chip"
              style={{ fontSize: 10, opacity: race.date ? 1 : 0.55 }}
              disabled={stage !== null || busy !== null || !race.date}
              onClick={() => void runStageAgain("plan")}
              title={race.date
                ? "one headless claude -p turn: block targets, fuel plan, coach notes, theme suggestion"
                : "the block is counted back from race day — fill the date in above and save before spending an agent turn"}
            >
              {stage === "plan" ? "planning…" : "block + fuel"}
            </button>
            <span
              className={stage ? "pulse" : undefined}
              style={{ fontSize: 10.5, color: stage ? "var(--lamp)" : "var(--mist-mute)", lineHeight: 1.4, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {stageLine || (race.date
                ? "the course build is deterministic and free; the plan is a paid agent turn, so it is its own button"
                : "the plan needs a race date — it counts the block back from race day, and without one it writes no block.json at all")}
            </span>
          </div>
        </Block>

        <ProfilePreview course={data.course} hasGpx={data.has_gpx} />

        <Block>
          <Eyebrow>aid chart · {stations.length} stations</Eyebrow>
          <Hint style={{ marginTop: 0, marginBottom: 10 }}>
            the chart is the course's spine — miles must increase down the list and so must cutoffs, and the
            server refuses a save that breaks either. The waypoint column maps each station onto the GPX;
            a row the matcher was not sure about is marked and offers what it considered.
          </Hint>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11.5 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--mist-mute)" }}>
                  {["#", "station", "mile", "cutoff h", "crew", "drop bag", "pacers", "gpx waypoint"].map((h) => (
                    <th key={h} className="eyebrow" style={{ fontSize: 8, padding: "0 8px 6px 0", fontWeight: 400 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stations.map((_station, i) => (
                  <tr key={i} style={{ borderTop: "1px solid var(--edge)" }}>
                    <td className="numerals" style={{ color: "var(--mist-mute)", padding: "5px 8px 5px 0" }}>{i}</td>
                    <td style={{ padding: "5px 8px 5px 0", minWidth: 150 }}>
                      <input
                        aria-label={`station ${i} name`}
                        style={cellStyle}
                        placeholder="station name"
                        value={String(stationValue(i, "name") ?? "")}
                        onChange={(e) => editStation(i, { name: e.target.value })}
                      />
                    </td>
                    <td style={{ padding: "5px 8px 5px 0", width: 76 }}>
                      <input
                        aria-label={`station ${i} mile`}
                        type="number" step={0.1} min={0} className="numerals" style={cellStyle}
                        value={String(stationValue(i, "total_mi") ?? "")}
                        onChange={(e) => editStation(i, { total_mi: e.target.value === "" ? undefined : Number(e.target.value) })}
                      />
                    </td>
                    <td style={{ padding: "5px 8px 5px 0", width: 76 }}>
                      <input
                        aria-label={`station ${i} cutoff`}
                        type="number" step={0.25} min={0} className="numerals" style={cellStyle}
                        placeholder="none"
                        value={stationValue(i, "cutoff_h") == null ? "" : String(stationValue(i, "cutoff_h"))}
                        onChange={(e) => editStation(i, { cutoff_h: e.target.value === "" ? null : Number(e.target.value) })}
                      />
                    </td>
                    {(["crew", "drop_bag", "pacers"] as const).map((flag) => (
                      <td key={flag} style={{ padding: "5px 8px 5px 0" }}>
                        <input
                          type="checkbox"
                          aria-label={`station ${i} ${flag}`}
                          checked={stationValue(i, flag) === true}
                          onChange={(e) => editStation(i, { [flag]: e.target.checked } as AidEdit)}
                        />
                      </td>
                    ))}
                    <td style={{ padding: "5px 0", minWidth: 200 }}>
                      <WaypointPicker
                        value={(stationValue(i, "gpx_wpt") as string | null | undefined) ?? null}
                        match={data.matches[i]}
                        waypoints={data.waypoints}
                        isFinish={i === stations.length - 1}
                        onChange={(v) => editStation(i, { gpx_wpt: v })}
                        conflictWith={wptConflicts.get(i)?.map((j) => String(stationValue(j, "name") ?? stations[j]?.name ?? j))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Block>

        <BlockTargets
          block={data.block}
          edits={blockEdits}
          onEdit={(wk, patch) => { setSaveError(null); setBlockEdits((p) => ({ ...p, [wk]: { ...p[wk], ...patch } })); }}
          stale={data.block_stale === true}
        />
        <NutritionSummary nutrition={data.nutrition} />
      </div>

      <div style={{
        display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, flexWrap: "wrap",
        borderTop: "1px solid var(--edge)", padding: "14px 28px", flexShrink: 0,
      }}>
        <div style={{ marginRight: "auto", maxWidth: 620 }}>
          {saveError
            ? <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: "var(--ember)", lineHeight: 1.5 }}>
                {saveError.map((e, i) => <li key={i} style={{ listStyle: i === 0 ? "none" : undefined, marginLeft: i === 0 ? -16 : 0 }}>{e}</li>)}
              </ul>
            : <span style={{ fontSize: 10.5, color: "var(--mist-mute)", lineHeight: 1.4 }}>
                {blockers.length
                  ? blockers[0]
                  : isDraft
                    ? "activating sets this folder's status and points the app at it in train mode"
                    : `status: ${race.status}`}
              </span>}
        </div>
        <button className="chip" onClick={() => load()} disabled={busy !== null || stage !== null} style={{ fontSize: 10 }}>
          revert
        </button>
        <button
          className="chip"
          onClick={() => void save()}
          disabled={busy !== null || stage !== null || !dirty || hasWptConflict}
          title={hasWptConflict ? "resolve the duplicate waypoint mapping before saving" : undefined}
          style={{ fontSize: 10, opacity: dirty ? 1 : 0.5 }}
        >
          {busy === "saving" ? "saving…" : "save edits"}
        </button>
        <button
          className="chip"
          onClick={() => void activate()}
          disabled={!canActivate}
          title={blockers[0] ?? "set status active and train for this race"}
          style={{
            fontSize: 10, padding: "5px 16px", borderColor: "var(--lamp)",
            background: canActivate ? "var(--lamp)" : "transparent",
            color: canActivate ? "var(--night)" : "var(--lamp)",
            cursor: canActivate ? "pointer" : "not-allowed",
            opacity: canActivate ? 1 : 0.5,
          }}
        >
          {busy === "activating" ? "activating…" : "activate"}
        </button>
      </div>
    </>
  );
}

/* --------------------------- review sections ---------------------- */

/** The gate itself: every field nothing could establish, each one either
    filled in or consciously accepted. A suggestion is offered where the course
    build already knows the answer — `elevation.min_ft` is sitting in the
    profile, and making a human retype it would be theatre. */
function UnresolvedList({ unresolved, hints, race, course, fills, isAcked, onFill, onAck }: {
  unresolved: string[];
  /** server-supplied pointers for a path that isn't a value a human just
      types in (GET /api/races/:slug's unresolved_hints) */
  hints: Record<string, string>;
  race: RaceConfig;
  course: Course | null;
  fills: Record<string, string>;
  isAcked: (path: string) => boolean;
  onFill: (path: string, value: string) => void;
  onAck: (path: string, value: boolean) => void;
}) {
  const suggestion = (path: string): string | null => {
    if (!course?.profile?.length) return null;
    if (path === "elevation.min_ft") return String(Math.round(Math.min(...course.profile.map((p) => p.ele_ft))));
    if (path === "elevation.max_ft") return String(Math.round(Math.max(...course.profile.map((p) => p.ele_ft))));
    return null;
  };

  if (unresolved.length === 0) {
    return (
      <Block>
        <Eyebrow>unresolved · none</Eyebrow>
        <Hint style={{ marginTop: 0 }}>
          every field the intake read has a value. {race.status === "draft" ? "Activate is open." : ""}
        </Hint>
      </Block>
    );
  }
  return (
    <Block>
      <Eyebrow>unresolved · {unresolved.length}</Eyebrow>
      <Hint style={{ marginTop: 0, marginBottom: 10 }}>
        what nothing in the sources could establish. Fill it in, or tick it to say you know it is missing —
        an acknowledged field is recorded as not known rather than as an empty one. Activate waits for all of them.
      </Hint>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {unresolved.map((path) => {
          const filled = (fills[path] ?? "").trim() !== "";
          const hint = suggestion(path);
          const serverHint = hints[path];
          return (
            <li key={path} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <code style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: filled ? "var(--pine)" : "var(--ember)", minWidth: 190 }}>
                  {path}
                </code>
                <input
                  aria-label={`fill ${path}`}
                  style={{ ...inputStyle, fontSize: 11.5, padding: "4px 8px", width: 190 }}
                  placeholder={path === "date" ? "YYYY-MM-DD" : hint ? `e.g. ${hint}` : "leave empty to acknowledge"}
                  value={fills[path] ?? ""}
                  onChange={(e) => onFill(path, e.target.value)}
                />
                {hint && !filled && (
                  <button className="chip" style={{ fontSize: 8.5 }} onClick={() => onFill(path, hint)}>
                    use {hint} from the profile
                  </button>
                )}
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--mist-mute)", opacity: filled ? 0.4 : 1 }}>
                  <input type="checkbox" checked={filled || isAcked(path)} disabled={filled} onChange={(e) => onAck(path, e.target.checked)} />
                  acknowledge
                </label>
              </div>
              {/* a path like `sun` isn't a value a human types in here — it's a
                  script's output, so the review screen points at the fix instead */}
              {serverHint && (
                <div style={{ fontSize: 10.5, color: "var(--mist-mute)", paddingLeft: 2 }}>{serverHint}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Block>
  );
}

/** The mapping UI PRD §14 asks for: a station's GPX waypoint, with the
    matcher's own shortlist first when it was not confident. The full waypoint
    list follows it — the shortlist is scored on name similarity alone and a
    human reading the map may know better. */
function WaypointPicker({ value, match, waypoints, isFinish, onChange, conflictWith }: {
  value: string | null;
  match?: StationMatch;
  waypoints: string[];
  isFinish: boolean;
  onChange: (v: string | null) => void;
  /** Other station names already mapped to this same waypoint — round 1,
      bug D3: picking a used waypoint used to look like nothing happened and
      quietly saved a duplicate. */
  conflictWith?: string[];
}) {
  const shortlist = useMemo(() => {
    const seen = new Set<string>();
    const out: MatchCandidate[] = [];
    for (const c of match?.candidates ?? []) {
      if (seen.has(c.wpt)) continue;
      seen.add(c.wpt);
      out.push(c);
    }
    return out;
  }, [match]);

  const unsure = !value && (match?.confidence ?? 0) < LOW_CONFIDENCE && !isFinish;
  // Previously excluded the CURRENTLY SELECTED value from this list too —
  // if that value was not also in the matcher's shortlist (the common case),
  // no <option> for it existed anywhere in the DOM, so a browser falls back
  // to showing nothing selected even though `value` is set. That was the
  // real cause of round 1, bug D3's "picks a waypoint, select shows
  // unmapped" — the pick silently succeeded but looked like it had not.
  const rest = waypoints.filter((w) => !shortlist.some((c) => c.wpt === w));

  if (waypoints.length === 0) {
    return (
      <span style={{ fontSize: 10.5, color: "var(--mist-mute)" }}>
        {value ?? (isFinish ? "the track end" : "no GPX yet")}
      </span>
    );
  }
  const conflict = conflictWith && conflictWith.length > 0
    ? `already used by station ${conflictWith.join(", ")}`
    : null;

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2, width: "100%" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, width: "100%" }}>
        <select
          aria-label="gpx waypoint"
          style={{ ...cellStyle, borderColor: conflict || unsure ? "var(--ember)" : "var(--edge-bright)" }}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">{isFinish ? "— the track end —" : "— unmapped —"}</option>
          {value && !waypoints.includes(value) && <option value={value}>{value} (not in this GPX)</option>}
          {shortlist.length > 0 && (
            <optgroup label="the matcher considered">
              {shortlist.map((c) => <option key={c.wpt} value={c.wpt}>{c.wpt} · {c.score.toFixed(2)}</option>)}
            </optgroup>
          )}
          <optgroup label="every waypoint">
            {rest.map((w) => <option key={w} value={w}>{w}</option>)}
          </optgroup>
        </select>
        {!conflict && unsure && <span title="the matcher was not confident — pick one" style={{ color: "var(--ember)", fontSize: 11 }}>!</span>}
      </span>
      {conflict && <span style={{ fontSize: 9.5, color: "var(--ember)", lineHeight: 1.3 }}>{conflict} — pick a different waypoint or clear it before saving</span>}
    </span>
  );
}

const PROFILE_W = 760;
const PROFILE_H = 110;

/** The course as built — the one place the review screen can show that the
    aid miles and the GPX actually agree. */
function ProfilePreview({ course, hasGpx }: { course: Course | null; hasGpx: boolean }) {
  const path = useMemo(() => {
    const prof = course?.profile ?? [];
    if (prof.length < 2) return null;
    const step = Math.max(1, Math.ceil(prof.length / 600));
    const sel = prof.filter((_, i) => i % step === 0 || i === prof.length - 1);
    let lo = Infinity, hi = -Infinity;
    for (const p of sel) { if (p.ele_ft < lo) lo = p.ele_ft; if (p.ele_ft > hi) hi = p.ele_ft; }
    const span = hi - lo || 1;
    const dist = course?.distance_mi || sel[sel.length - 1].mi || 1;
    const pts = sel.map((p) => `${((p.mi / dist) * PROFILE_W).toFixed(1)},${(PROFILE_H - ((p.ele_ft - lo) / span) * (PROFILE_H - 8)).toFixed(1)}`);
    return { line: `M${pts.join("L")}`, fill: `M0,${PROFILE_H} L${pts.join("L")} L${PROFILE_W},${PROFILE_H} Z`, lo, hi, dist };
  }, [course]);

  if (!course || !path) {
    return (
      <Block>
        <Eyebrow>profile</Eyebrow>
        <Hint style={{ marginTop: 0 }}>
          {hasGpx
            ? "the folder has a GPX but no build/course.json yet — run the course stage"
            : "no course.gpx in the folder yet, so there is no profile to show. The course stage fetches it from the race's own GPX link."}
        </Hint>
      </Block>
    );
  }
  return (
    <Block>
      <Eyebrow>profile · {course.distance_mi.toFixed(1)} mi measured · {course.gain_ft.toLocaleString()} ft</Eyebrow>
      <svg viewBox={`0 0 ${PROFILE_W} ${PROFILE_H}`} preserveAspectRatio="none" style={{ width: "100%", height: 110, display: "block" }} aria-label="course elevation profile">
        <path d={path.fill} fill="var(--lamp-glow)" />
        <path d={path.line} fill="none" stroke="var(--lamp)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
        {course.aid_stations.map((s) => (
          <circle key={s.name} cx={(s.gpx_mi / path.dist) * PROFILE_W} cy={PROFILE_H - 3} r={2.2} fill="var(--mist-mute)" />
        ))}
      </svg>
      <Hint>
        {Math.round(path.lo).toLocaleString()}–{Math.round(path.hi).toLocaleString()} ft ·
        official {course.official_distance_mi} mi / {course.official_gain_ft.toLocaleString()} ft ·
        {" "}{course.aid_stations.length} stations snapped
      </Hint>
    </Block>
  );
}

/** block.json's weekly targets — the only numbers in the folder that say what
    the athlete will actually do, so they are editable here and nowhere else. */
function BlockTargets({ block, edits, onEdit, stale }: {
  block: RaceBlock | null;
  edits: Record<number, { target_dist?: number; target_elev?: number }>;
  onEdit: (wk: number, patch: { target_dist?: number; target_elev?: number }) => void;
  /** block.json's calendar was counted back from a race date this folder no
      longer has (scripts/race-edit.mjs's isBlockStale) — the targets below
      are unchanged, just possibly counting down to the wrong week. */
  stale?: boolean;
}) {
  if (!block) {
    return (
      <Block>
        <Eyebrow>block</Eyebrow>
        <Hint style={{ marginTop: 0 }}>no block.json yet — the plan stage writes it, working back from race day.</Hint>
      </Block>
    );
  }
  return (
    <Block>
      <Eyebrow>block · {block.total_weeks} weeks from {block.start_date}</Eyebrow>
      {stale && (
        <p style={{ fontSize: 11.5, color: "var(--ember)", margin: "0 0 10px" }}>
          this block was counted back from a different race date — re-run the block + fuel plan stage, or edit the targets by hand, to line the weeks back up.
        </p>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead>
            <tr style={{ color: "var(--mist-mute)" }}>
              <th className="eyebrow" style={{ fontSize: 8, textAlign: "left", padding: "0 10px 6px 0", fontWeight: 400 }}>wk</th>
              <th className="eyebrow" style={{ fontSize: 8, textAlign: "left", padding: "0 10px 6px 0", fontWeight: 400 }}>miles</th>
              <th className="eyebrow" style={{ fontSize: 8, textAlign: "left", padding: "0 10px 6px 0", fontWeight: 400 }}>vert ft</th>
            </tr>
          </thead>
          <tbody>
            {block.targets.map((t) => (
              <tr key={t.wk} style={{ borderTop: "1px solid var(--edge)" }}>
                <td className="numerals" style={{ color: "var(--mist-mute)", padding: "4px 10px 4px 0" }}>{t.wk}</td>
                <td style={{ padding: "4px 10px 4px 0" }}>
                  <input
                    aria-label={`week ${t.wk} miles`} type="number" min={0} step={1} className="numerals"
                    style={{ ...cellStyle, width: 74 }}
                    value={String(edits[t.wk]?.target_dist ?? t.target_dist)}
                    onChange={(e) => onEdit(t.wk, { target_dist: Number(e.target.value) })}
                  />
                </td>
                <td style={{ padding: "4px 10px 4px 0" }}>
                  <input
                    aria-label={`week ${t.wk} vert`} type="number" min={0} step={100} className="numerals"
                    style={{ ...cellStyle, width: 84 }}
                    value={String(edits[t.wk]?.target_elev ?? t.target_elev)}
                    onChange={(e) => onEdit(t.wk, { target_elev: Number(e.target.value) })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  );
}

/** Read-only: the fuel plan is a whole view of its own, and what the review
    gate needs from it is only "does this look like this race?". */
function NutritionSummary({ nutrition }: { nutrition: NutritionConfig | null }) {
  if (!nutrition) {
    return (
      <Block>
        <Eyebrow>fuel</Eyebrow>
        <Hint style={{ marginTop: 0 }}>no nutrition.json yet — the plan stage writes it.</Hint>
      </Block>
    );
  }
  const bags = Object.entries(nutrition.drop_bag_gear ?? {});
  return (
    <Block>
      <Eyebrow>fuel</Eyebrow>
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", fontSize: 11.5, color: "var(--mist-mute)" }}>
        <span>carb phases <span className="numerals" style={{ color: "var(--mist)" }}>{(nutrition.phases ?? []).map((p) => `${p.carb_g_hr}`).join(" → ")}</span> g/h</span>
        <span>sodium <span className="numerals" style={{ color: "var(--mist)" }}>{nutrition.sodium_mg_hr}</span> mg/h</span>
        <span>fluid <span className="numerals" style={{ color: "var(--mist)" }}>{nutrition.fluid_ml_hr}</span>→<span className="numerals" style={{ color: "var(--mist)" }}>{nutrition.fluid_ml_hr_heat}</span> mL/h</span>
        <span>heat <span className="numerals" style={{ color: "var(--mist)" }}>{nutrition.heat_window?.start}–{nutrition.heat_window?.end}</span></span>
        <span>caffeine <span className="numerals" style={{ color: "var(--mist)" }}>{nutrition.caffeine?.gels}</span> gels</span>
      </div>
      {bags.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--mist-mute)", lineHeight: 1.6 }}>
          {bags.map(([station, gear]) => (
            <div key={station}>
              <span style={{ color: "var(--mist)" }}>{station}</span> · {gear.join(", ")}
            </div>
          ))}
        </div>
      )}
    </Block>
  );
}
