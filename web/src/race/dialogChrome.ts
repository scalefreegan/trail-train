// The bits of the intake dialogs that are not components: the SSE reader every
// stage endpoint is consumed with, the run-sheet vocabulary, and the two input
// styles the forms share.
//
// They live here rather than in RaceIntake.tsx for one reason — a file that
// exports both components and plain values breaks React Fast Refresh, and the
// lint rule that says so is right: RaceIntake.tsx and RaceRefresh.tsx are two
// dialogs over the same endpoints, and this is the seam between them.

import type { CSSProperties } from "react";

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

export const inputStyle: CSSProperties = {
  background: "var(--night-deep)", border: "1px solid var(--edge-bright)",
  color: "var(--mist)", fontSize: 12.5, padding: "7px 10px", outline: "none",
};
/** The same input, sized for a table cell — the aid chart and the block. */
export const cellStyle: CSSProperties = { ...inputStyle, fontSize: 11.5, padding: "4px 6px", width: "100%" };
