// The bits of the intake dialogs that are not components: the SSE reader every
// stage endpoint is consumed with, the run-sheet vocabulary, and the two input
// styles the forms share.
//
// They live here rather than in RaceIntake.tsx for one reason — a file that
// exports both components and plain values breaks React Fast Refresh, and the
// lint rule that says so is right: RaceIntake.tsx and RaceRefresh.tsx are two
// dialogs over the same endpoints, and this is the seam between them.

import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent, type RefObject } from "react";

export type StageState = "pending" | "running" | "done" | "error" | "skipped";

/** One row of a run sheet: what the stage is called and what it does. */
export type StageRow = { id: string; label: string; blurb: string };

/** What the SSE stream says, once a frame is parsed. */
export type StageEvent =
  | { kind: "step"; id: string; status: string; label?: string }
  | { kind: "log"; line: string }
  | { kind: "error"; message: string };

/**
 * POST a stage endpoint and consume its SSE stream, resolving with the final
 * `done` payload. The same frame parser providers.tsx uses for /api/refresh —
 * these endpoints speak the identical dialect on purpose.
 *
 * Rejects on a transport failure or on a `done` that says `ok: false`, with
 * the server's own sentence: scripts/agent-run.mjs has already turned an
 * expired sign-in or a spent usage limit into what to do about it, and
 * rewording that here would only make it vaguer.
 */
export async function runStage(
  url: string,
  body: unknown,
  onEvent: (e: StageEvent) => void,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error("the server sent no stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let done: Record<string, unknown> | null = null;

  const frame = (block: string) => {
    let evt = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) evt = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(data); } catch { return; }
    if (evt === "step") onEvent({ kind: "step", id: String(payload.id ?? ""), status: String(payload.status ?? ""), label: payload.label as string | undefined });
    else if (evt === "log") onEvent({ kind: "log", line: String(payload.line ?? "") });
    else if (evt === "error") onEvent({ kind: "error", message: String(payload.message ?? "") });
    else if (evt === "done") done = payload;
  };

  for (;;) {
    const { done: closed, value } = await reader.read();
    if (closed) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      frame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (!done) throw new Error("the stream ended before the stage reported a result");
  const result = done as Record<string, unknown>;
  if (result.ok !== true) throw new Error(String(result.error ?? "the stage failed without saying why"));
  return result;
}

/* ------------------------------------------------------------------ */
/*  Shared bits of chrome                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  useDialog — the chrome every modal in this app needs and (before   */
/*  this) none of them fully had: labelled, focused, trapped, and      */
/*  handed back to whoever opened it.                                  */
/* ------------------------------------------------------------------ */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * role="dialog" + aria-modal, initial focus moved into the dialog, Tab and
 * Shift+Tab trapped inside it, Escape to close (unless `locked` — a stage
 * is running and closing mid-write would strand it), and focus handed back
 * to whatever had it before the dialog opened once the dialog unmounts.
 *
 * Spread `dialogProps` onto the dialog's own outer element (the one that
 * carries `role="dialog"` today). Point the dialog's heading at `titleId`
 * with `id={titleId}` — or, for a dialog with no heading of its own (the
 * printable cards), pass `label` instead and the hook uses aria-label.
 *
 * Adopted so far: RaceRefresh, ArchiveRace, CoachSettings, RunnerCard,
 * FuelCard, DropBagCard. TODO — RaceIntake.tsx (the review/new-race dialog)
 * still has its own hand-rolled Escape effect and no focus trap; it owns
 * `locked`/`reviewLocked` state this hook would take as its `locked` param
 * the same way RaceRefresh does. Not switched over here to stay out of a
 * file another fixer is actively editing.
 */
export function useDialog({ onClose, locked, label }: {
  onClose: () => void;
  locked?: boolean;
  label?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const openerRef = useRef<HTMLElement | null>(null);

  // the opener: whatever had focus right before this dialog mounted — the
  // switcher row or button that triggered it. Captured once, restored once.
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    return () => { openerRef.current?.focus?.(); };
  }, []);

  // initial focus, once, into the dialog's first focusable control (every
  // one of these dialogs renders a header with a close button up front, so
  // there is always a fallback target even before async content loads)
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el).focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (!locked) onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const el = dialogRef.current;
    if (!el) return;
    const nodes = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
    if (nodes.length === 0) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return {
    titleId,
    dialogProps: {
      ref: dialogRef as RefObject<HTMLDivElement>,
      role: "dialog" as const,
      "aria-modal": true as const,
      ...(label ? { "aria-label": label } : { "aria-labelledby": titleId }),
      tabIndex: -1,
      onKeyDown,
    },
  };
}

/** A network-level fetch failure (dev server unreachable — killed, crashed,
    a phone that lost the LAN) throws a bare `TypeError: Failed to
    fetch`/`Load failed`, which is a JS runtime detail, not something to put
    in front of an athlete (PR #23 review round 2, draft finding 5 /
    resilience finding 6). An HTTP error response is a real `Error` carrying
    the server's own message and passes through unchanged. Shared by every
    dialog that hits the dev API directly (RaceIntake's save/activate, the
    race switcher) rather than each re-deriving its own copy. */
export function friendlyFetchError(e: unknown): string {
  if (e instanceof TypeError) return "server unreachable — is Basecamp running?";
  return e instanceof Error ? e.message : String(e);
}

export const inputStyle: CSSProperties = {
  background: "var(--night-deep)", border: "1px solid var(--edge-bright)",
  color: "var(--mist)", fontSize: 12.5, padding: "7px 10px", outline: "none",
};
/** The same input, sized for a table cell — the aid chart and the block. */
export const cellStyle: CSSProperties = { ...inputStyle, fontSize: 11.5, padding: "4px 6px", width: "100%" };
