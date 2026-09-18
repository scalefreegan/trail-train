// "Refresh from sources" — the re-intake dialog (PRD §8).
//
// The intake dialog's twin, and deliberately the smaller one. A new race is a
// form; a refresh has nothing to ask: the race already knows its own site, its
// manual and its GPX, so the only inputs are a newly posted document you want
// read alongside them and a sentence about what to look for.
//
// Three screens, in the order the decision is made:
//
//   ready   — what a refresh will do, and to which race. One button.
//   running — the four stages as a run sheet, same vocabulary as the intake's.
//   diff    — what Accept would change, old → new, grouped by file. This is
//             the whole point: nothing has been written to the race yet. The
//             run happened in races/<slug>/.refresh/, and Accept is the first
//             and only moment the live folder moves.
//
// A field you authored is never overwritten — it shows up under "kept as you
// wrote it" with the refresh's value beside it as a suggestion, and if you
// want the suggestion you type it in the review screen afterwards. That rule
// lives in scripts/race-merge.mjs; this file only renders its verdict.
//
// The dialog re-opens onto a diff that is already waiting: the shadow folder
// survives a closed dialog, a reload and a restarted dev server, so a refresh
// run before dinner is still there to accept after it.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRefresh } from "../data";
import { Backdrop, Block, Eyebrow, Hint, StageList } from "./RaceIntake";
import { inputStyle, runStage, type StageRow, type StageState } from "./dialogChrome";

/* ------------------------------------------------------------------ */
/*  Shapes                                                             */
/* ------------------------------------------------------------------ */

/** One field-level difference, as scripts/race-merge.mjs writes it. */
export type DiffEntry = {
  file: string;
  path: string;
  kind: "added" | "changed" | "removed" | "renamed" | "kept";
  from?: unknown;
  to?: unknown;
  by?: string | null;
  key?: string | number | null;
};

/** races/<slug>/.refresh/diff.json — GET /api/races/:slug/refresh. */
export type RefreshDiff = {
  slug: string;
  at: string;
  site: string;
  files: string[];
  diff: DiffEntry[];
  conflicts: DiffEntry[];
  unresolved: string[];
  warnings: string[];
  sources_stamp: string;
};

/* The stages runRefresh streams. Its sub-stages (a fetch pass, a PDF render,
   the agent turns) arrive as log lines against whichever of these four is
   running, which is why the run sheet tracks the top-level ids only. */
const STAGES: StageRow[] = [
  { id: "intake", label: "sources → draft", blurb: "re-fetches the site and the manual, then one agent turn re-reads the aid chart" },
  { id: "build", label: "course", blurb: "snaps the new chart to the GPX track and rebuilds the profile" },
  { id: "plan", label: "block + fuel", blurb: "one agent turn: the block and the fueling plan against the new course" },
  { id: "merge", label: "diff", blurb: "compares the result with the race on disk — your own edits are kept" },
];
const STAGE_IDS = new Set(STAGES.map((s) => s.id));

/* ------------------------------------------------------------------ */
/*  Rendering a value                                                  */
/* ------------------------------------------------------------------ */

/** A field's value, short enough to sit in a table cell. */
function show(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "null";
  if (typeof v === "string") return v.trim() === "" ? '""' : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  const o = v as Record<string, unknown>;
  // an aid station or a target row is worth naming, not counting
  if (typeof o.name === "string") return o.name;
  if (typeof o.wk === "number") return `week ${o.wk}`;
  return `{ ${Object.keys(o).slice(0, 3).join(", ")}${Object.keys(o).length > 3 ? ", …" : ""} }`;
}

const KIND_TINT: Record<DiffEntry["kind"], string> = {
  added: "var(--pine)",
  changed: "var(--lamp)",
  removed: "var(--ember)",
  renamed: "var(--lamp)",
  kept: "var(--mist-dim)",
};

/** The station or week a row belongs to, when the path alone is cryptic. */
function rowLabel(d: DiffEntry): string {
  const field = d.path.replace(/^[a-z_]+\[\d+\]\.?/, "");
  if (d.key == null) return d.path || "the whole file";
  return field ? `${d.key} · ${field}` : String(d.key);
}

function DiffRows({ rows }: { rows: DiffEntry[] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
      <tbody>
        {rows.map((d, i) => (
          <tr key={`${d.path}-${i}`} style={{ borderTop: i ? "1px solid var(--edge)" : undefined }}>
            <td style={{ padding: "6px 10px 6px 0", verticalAlign: "top", width: "40%" }}>
              <span style={{ color: "var(--mist)" }}>{rowLabel(d)}</span>
              <div className="eyebrow" style={{ fontSize: 8, color: KIND_TINT[d.kind], marginTop: 2 }}>
                {d.kind}{d.by && d.kind !== "kept" ? ` · was ${d.by}` : ""}
              </div>
            </td>
            <td className="numerals" style={{ padding: "6px 10px 6px 0", verticalAlign: "top", color: "var(--mist-mute)", width: "30%", wordBreak: "break-word" }}>
              {show(d.from)}
            </td>
            <td className="numerals" style={{ padding: "6px 0", verticalAlign: "top", width: "30%", wordBreak: "break-word", color: d.kind === "kept" ? "var(--mist-dim)" : "var(--mist)" }}>
              {d.kind === "kept" ? <span title="not applied — you authored this field">suggested: {show(d.to)}</span> : show(d.to)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ */
/*  The dialog                                                         */
/* ------------------------------------------------------------------ */

export default function RaceRefresh({ slug, name, onClose }: {
  slug: string;
  /** The race's own name, for the header — the dialog opens before any fetch. */
  name: string;
  onClose: () => void;
}) {
  const { reload } = useRefresh();
  const [diff, setDiff] = useState<RefreshDiff | null>(null);
  const [notes, setNotes] = useState("");
  const [uploads, setUploads] = useState<{ name: string; path: string; bytes: number }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<null | "accept" | "reject">(null);
  const [stageState, setStageState] = useState<Record<string, StageState>>({});
  const [stageLog, setStageLog] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const locked = running || busy !== null;

  // A diff waiting from an earlier run. 404 is the ordinary answer — it means
  // there is nothing pending, not that anything went wrong.
  useEffect(() => {
    let stale = false;
    fetch(`/api/races/${slug}/refresh?t=${Date.now()}`)
      .then(async (r) => (r.status === 404 ? null : ((await r.json()) as RefreshDiff)))
      .then((d) => { if (!stale && d) setDiff(d); })
      .catch(() => { /* nothing pending is not an error */ });
    return () => { stale = true; };
  }, [slug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !locked) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, locked]);
  useEffect(() => () => abortRef.current?.abort(), []);

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
    setError(null);
    setDiff(null);
    setStageState(Object.fromEntries(STAGES.map((s) => [s.id, "pending" as StageState])));
    setStageLog({});
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    /* Which stage the sub-events belong to: runRefresh brackets each stage
       with its own step, and everything between them is that stage talking. */
    let current = "intake";

    try {
      const done = await runStage("/api/race-intake/refresh", {
        slug,
        notes: notes.trim(),
        uploads: uploads.map((u) => ({ name: u.name, path: u.path })),
      }, (e) => {
        if (e.kind === "log") setStageLog((p) => ({ ...p, [current]: e.line }));
        else if (e.kind === "error") setError(e.message);
        else if (e.kind === "step" && STAGE_IDS.has(e.id)) {
          current = e.id;
          setStageState((p) => ({ ...p, [e.id]: e.status === "done" ? "done" : "running" }));
          if (e.label) setStageLog((p) => ({ ...p, [e.id]: e.label as string }));
        } else if (e.kind === "step" && e.status === "start" && e.label) {
          setStageLog((p) => ({ ...p, [current]: e.label as string }));
        }
      }, ctrl.signal);
      setDiff(done.diff as RefreshDiff);
    } catch (e) {
      setStageState((p) => {
        const next = { ...p };
        for (const s of STAGES) if (next[s.id] === "running") next[s.id] = "error";
        for (const s of STAGES) if (next[s.id] === "pending") next[s.id] = "skipped";
        return next;
      });
      setError((e as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [slug, notes, uploads]);

  const settle = async (action: "accept" | "reject") => {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/races/${slug}/refresh/${action}`, { method: "POST" });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      // Accept rewrote the folder the whole dashboard reads; reject did not,
      // but the pulse is cheap and keeps the two paths one code path.
      reload();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const byFile = (diff?.files.length ? diff.files : [...new Set(diff?.diff.map((d) => d.file) ?? [])])
    .map((file) => ({ file, rows: (diff?.diff ?? []).filter((d) => d.file === file) }))
    .filter((g) => g.rows.length > 0);
  const kept = diff?.conflicts ?? [];
  const nothingToDo = diff !== null && diff.diff.length === 0;

  return createPortal(
    <Backdrop onClose={() => { if (!locked) onClose(); }}>
      <div
        className="panel notch"
        role="dialog"
        aria-modal="true"
        aria-label={`refresh ${name}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(860px, 100%)", margin: "0 auto", display: "flex",
          flexDirection: "column", maxHeight: "100%", flex: "0 1 auto",
        }}
      >
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16,
          borderBottom: "1px solid var(--edge)", padding: "16px 28px", flexShrink: 0,
        }}>
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow" style={{ color: "var(--mist-dim)" }}>refresh from sources · {name}</div>
            <div style={{ fontSize: 11.5, color: "var(--mist-mute)", marginTop: 3 }}>
              {diff
                ? "nothing has been written to the race yet — this is what Accept would change"
                : "re-reads the race's own site and manual into a shadow folder, then shows you the diff"}
            </div>
          </div>
          <button className="chip" onClick={onClose} disabled={locked} style={{ fontSize: 9 }}>
            {locked ? "working…" : "close esc"}
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "24px 28px 8px" }}>
          {!diff && !running && (
            <>
              <Block>
                <Eyebrow>what this does</Eyebrow>
                <Hint style={{ marginTop: 0 }}>
                  The three intake stages run again into <span className="numerals">races/{slug}/.refresh/</span>, and
                  the result is diffed against the race on disk. Cutoffs, notes and anything else you
                  edited by hand are kept — the refresh's version of those is shown as a suggestion, never applied.
                  Your plan and your result are never touched, and an active race stays active throughout.
                </Hint>
              </Block>
              <Block>
                <Eyebrow>a newly posted document · optional</Eyebrow>
                <input
                  type="file"
                  multiple
                  accept=".pdf,.gpx,.kml,.txt,.html,.htm"
                  disabled={uploading || running}
                  onChange={(e) => { void upload(e.target.files); e.target.value = ""; }}
                  style={{ fontSize: 11.5, color: "var(--mist-mute)" }}
                />
                <Hint>the next edition's manual or GPX, read alongside whatever the site still links</Hint>
                {uploads.length > 0 && (
                  <div style={{ marginTop: 8, fontSize: 11, color: "var(--mist-mute)" }}>
                    {uploads.map((u) => (
                      <div key={u.path} className="numerals">{u.name} · {(u.bytes / 1024).toFixed(0)} KB</div>
                    ))}
                  </div>
                )}
              </Block>
              <Block>
                <Eyebrow>what changed, if you know</Eyebrow>
                <textarea
                  style={{ ...inputStyle, width: "100%", minHeight: 58, resize: "vertical", fontSize: 11.5 }}
                  placeholder="the 2027 course reroutes after Kendall; new cutoffs posted in March"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </Block>
            </>
          )}

          {running && (
            <Block>
              <Eyebrow>running · two agent turns</Eyebrow>
              <StageList stages={STAGES} state={stageState} log={stageLog} />
            </Block>
          )}

          {diff && (
            <>
              {nothingToDo ? (
                <Block>
                  <Eyebrow>no change</Eyebrow>
                  <Hint style={{ marginTop: 0 }}>
                    The sources say exactly what this folder already says. Reject throws the shadow
                    folder away; there is nothing to accept.
                  </Hint>
                </Block>
              ) : (
                byFile.map((g) => (
                  <Block key={g.file}>
                    <Eyebrow>{g.file} · {g.rows.length} change{g.rows.length === 1 ? "" : "s"}</Eyebrow>
                    <DiffRows rows={g.rows.filter((d) => d.kind !== "kept")} />
                  </Block>
                ))
              )}

              {kept.length > 0 && (
                <Block>
                  <Eyebrow>kept as you wrote it · {kept.length}</Eyebrow>
                  <Hint style={{ marginTop: 0, marginBottom: 8 }}>
                    These carry your own provenance, so Accept leaves them alone. The refresh's value
                    is beside each one — to take it, edit the field in the review screen.
                  </Hint>
                  <DiffRows rows={kept} />
                </Block>
              )}

              {diff.unresolved.length > 0 && (
                <Block>
                  <Eyebrow>still unresolved after the merge · {diff.unresolved.length}</Eyebrow>
                  <Hint style={{ marginTop: 0 }} >{diff.unresolved.join(" · ")}</Hint>
                </Block>
              )}

              {diff.warnings.length > 0 && (
                <Block>
                  <Eyebrow>warnings</Eyebrow>
                  {diff.warnings.map((w, i) => (
                    <Hint key={i} style={{ marginTop: i ? 4 : 0, color: "var(--ember)" }}>{w}</Hint>
                  ))}
                </Block>
              )}
            </>
          )}

          {error && (
            <div style={{ fontSize: 11.5, color: "var(--ember)", lineHeight: 1.5, whiteSpace: "pre-wrap", marginBottom: 16 }}>{error}</div>
          )}
        </div>

        <div style={{
          display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10,
          borderTop: "1px solid var(--edge)", padding: "12px 28px", flexShrink: 0,
        }}>
          {diff ? (
            <>
              <button className="chip" onClick={() => settle("reject")} disabled={locked} style={{ fontSize: 10 }}>
                {busy === "reject" ? "discarding…" : "reject"}
              </button>
              <button
                className="chip"
                onClick={() => settle("accept")}
                disabled={locked || nothingToDo}
                style={{
                  fontSize: 10, padding: "5px 16px", borderColor: "var(--lamp)",
                  background: nothingToDo ? "transparent" : "var(--lamp)",
                  color: nothingToDo ? "var(--lamp)" : "var(--night)",
                  cursor: nothingToDo ? "not-allowed" : "pointer",
                }}
              >
                {busy === "accept" ? "applying…" : "accept"}
              </button>
            </>
          ) : (
            <>
              <button className="chip" onClick={onClose} disabled={locked} style={{ fontSize: 10 }}>cancel</button>
              <button
                className="chip"
                onClick={run}
                disabled={locked}
                style={{
                  fontSize: 10, padding: "5px 16px", borderColor: "var(--lamp)",
                  background: locked ? "transparent" : "var(--lamp)",
                  color: locked ? "var(--lamp)" : "var(--night)",
                  cursor: locked ? "not-allowed" : "pointer",
                }}
              >
                {running ? "running…" : "refresh"}
              </button>
            </>
          )}
        </div>
      </div>
    </Backdrop>,
    document.body,
  );
}
