// Shared plumbing for the headless Claude Code CLI (`claude -p`).
//
// Three callers spawn the CLI with the same failure modes: the resync coach
// (scripts/coach.mjs), the dashboard chat endpoint and the race intake
// (scripts/race-intake.mjs). Each had its own copy of the error
// classification, and the copies had already drifted — this module is the one
// place that knows what a blown session limit, an expired sign-in or an
// exhausted turn budget looks like, and what to tell the human about it.
//
// No I/O beyond the subprocess: the callers own their prompts and their files.

import { spawn } from "node:child_process";

/** The CLI's structured subtype for "ran out of tool calls before answering". */
export const MAX_TURNS_SUBTYPE = "error_max_turns";

// Recognize known headless-CLI failures (API-key and OAuth/subscription auth
// phrasings, usage limits, API overload) so the UI can say what to actually do
// instead of surfacing a cryptic exit code.
const AUTH_ERROR_RE = /invalid api key|please run \/login|not logged in|log ?in again|login expired|oauth token.{0,40}(expired|revoked|invalid)|authentication[_ ]?error|credentials?.{0,20}(expired|invalid|missing)|unauthorized|re-?authenticate/i;
// No bare status codes (429/529) here: on failure paths the classified text
// includes the full stdout JSON wrapper, whose numeric fields (durations,
// token counts) can contain them as substrings.
const LIMIT_ERROR_RE = /usage limit reached|session limit|hit your .{0,20}limit|limit will reset|limit .{0,15}resets|out of (extra )?usage|rate.?limit(ed|_error)?|too many requests/i;
// Bare "overloaded" is normal coaching vocabulary ("legs are overloaded") —
// require the error-token or api-context form.
const OVERLOAD_ERROR_RE = /overloaded_error|api.{0,20}(overloaded|unavailable|internal server error)/i;

/** What to tell the human when the CLI's sign-in has lapsed. */
export const AUTH_FIX = "open a terminal, run `claude`, type `/login` and finish the browser sign-in, then retry.";

/**
 * Classify CLI output into an actionable sentence, or null when the text is
 * not one of the known failures.
 * @param {string} text stderr and/or the stdout JSON wrapper
 * @returns {string|null}
 */
export function failureHint(text) {
  if (AUTH_ERROR_RE.test(text)) return `Claude Code sign-in has expired — ${AUTH_FIX}`;
  if (LIMIT_ERROR_RE.test(text)) {
    // the CLI phrases it "Claude AI usage limit reached|<epoch-seconds>"
    const m = text.match(/limit reached\|(\d{9,13})/i);
    const reset = m ? new Date(Number(m[1]) * (m[1].length <= 10 ? 1000 : 1)).toLocaleString() : null;
    return `Claude usage limit reached — not an auth problem. Wait for the limit to reset${reset ? ` (~${reset})` : ""} and retry.`;
  }
  if (OVERLOAD_ERROR_RE.test(text)) return "Claude API is overloaded right now — transient; retry in a minute.";
  return null;
}

/**
 * True when the failure is one where retrying now is pointless — the caller
 * should stop rather than loop (a usage limit does not clear in a minute).
 * @param {string} text
 */
export function isTerminalFailure(text) {
  return AUTH_ERROR_RE.test(text) || LIMIT_ERROR_RE.test(text);
}

/**
 * Model for every headless spawn. Pinned rather than inherited: without
 * --model the CLI silently uses whatever ~/.claude/settings.json happens to
 * say, so the output's provenance would depend on an unrelated global setting.
 * @returns {string}
 */
export function agentModel() {
  return (process.env.TRAIL_COACH_MODEL || "").trim() || "claude-opus-5";
}

/**
 * Parse the `--output-format json` wrapper. Every field is optional because a
 * failing CLI can emit a partial wrapper, plain text, or nothing at all.
 * `isError` is null when stdout was not a wrapper — only an explicit
 * `is_error: false` counts as a confirmed valid result.
 * @param {string} stdout
 * @returns {{isError: boolean|null, result: string, subtype: string, numTurns: number|null, costUsd: number|null, durationMs: number|null}}
 */
export function parseWrapper(stdout) {
  const out = { isError: null, result: "", subtype: "", numTurns: null, costUsd: null, durationMs: null };
  try {
    const w = JSON.parse(stdout);
    if (!w || typeof w !== "object" || Array.isArray(w)) return out;
    if (typeof w.is_error === "boolean") out.isError = w.is_error;
    if (typeof w.result === "string") out.result = w.result.trim();
    if (typeof w.subtype === "string") out.subtype = w.subtype;
    if (typeof w.num_turns === "number") out.numTurns = w.num_turns;
    if (typeof w.total_cost_usd === "number") out.costUsd = w.total_cost_usd;
    if (typeof w.duration_ms === "number") out.durationMs = w.duration_ms;
  } catch { /* stdout wasn't the JSON wrapper */ }
  return out;
}

/**
 * The message to surface for a nonzero exit. The CLI often exits nonzero with
 * an empty stderr and the real message inside the wrapper's `result`, so this
 * picks whichever detail actually exists — and keeps a CONFIRMED non-error
 * wrapper (which holds the agent's own prose) away from the classifier, since
 * "overloaded" and "hit your limit" are ordinary agent vocabulary.
 * @param {{code: number|null, stdout: string, stderr: string}} attempt
 * @returns {string}
 */
export function closeFailureMessage({ code, stdout, stderr }) {
  const w = parseWrapper(stdout);
  const stderrTrim = (stderr || "").trim();
  const hint = failureHint(w.isError === false ? stderrTrim : `${stderrTrim}\n${stdout}`);
  if (hint) return hint;
  const detail = w.isError === true
    ? (w.result || w.subtype || stderrTrim)
    : w.isError === false
      ? stderrTrim
      : (stderrTrim || (stdout || "").trim());
  if (detail) return `claude exited ${code}: ${detail.slice(0, 800)}`;
  if (w.isError === false) return `claude exited ${code} after producing a normal result (likely a teardown error) — retry.`;
  return `claude exited ${code} with no error output — this is most often an expired sign-in: ${AUTH_FIX}`;
}

/**
 * Pull a JSON object out of an agent reply that may be fenced or prefaced.
 * @param {string} text
 * @returns {object}
 */
export function extractJson(text) {
  const tryParse = (s) => {
    const v = JSON.parse(s);
    if (typeof v !== "object" || v === null) throw new Error("not an object");
    return v;
  };
  try { return tryParse(text); } catch { /* not bare JSON */ }
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) { try { return tryParse(fence[1]); } catch { /* fence wasn't JSON */ } }
  // Last resort: the first `{` to the last `}` — an agent that prefaced its
  // answer with prose still gives us the object.
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return tryParse(text.slice(i, j + 1)); } catch { /* not an object */ } }
  throw new Error(`agent returned non-JSON: ${text.slice(0, 240)}`);
}

/** A no-tools answer still has to be generated; below this much remaining
    budget the retry would be killed mid-sentence, so we report the failure
    honestly instead of promising an answer we cannot deliver. */
const RETRY_MIN_RUNWAY_MS = 60_000;

/**
 * Spawn `claude -p --output-format json` and resolve with its result text.
 *
 * Running out of tool calls is the one failure the caller can do something
 * about: when `retryNudge` is given and the CLI reports `error_max_turns`,
 * one retry runs with that nudge appended and a small turn budget, inside the
 * REMAINING timeout rather than a fresh one (so the worst case doesn't
 * double). Every other failure rejects with a classified message.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.systemPrompt] appended to the CLI's own system prompt
 * @param {string[]} [opts.allowedTools] e.g. ["Read"], ["WebFetch","WebSearch","Read"]
 * @param {number} [opts.maxTurns]
 * @param {number} [opts.timeoutSec] watchdog over the WHOLE exchange, retry included
 * @param {string} [opts.cwd]
 * @param {string} [opts.model]
 * @param {string} [opts.retryNudge] appended to the prompt on the max-turns retry
 * @param {number} [opts.retryMaxTurns]
 * @param {(msg: string) => void} [opts.onNotice] progress/notice sink
 * @returns {Promise<{text: string, wrapper: ReturnType<typeof parseWrapper>, retried: boolean, elapsedMs: number}>}
 */
export function runClaudeJson({
  prompt,
  systemPrompt = "",
  allowedTools = [],
  maxTurns = 16,
  timeoutSec = 300,
  cwd = process.cwd(),
  model = agentModel(),
  retryNudge = "",
  retryMaxTurns = 3,
  onNotice = () => {},
}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let proc = null;
    let stdout = "";
    let stderr = "";
    let retried = false;
    let settled = false;

    const killProc = () => {
      const pid = proc?.pid;
      if (pid == null) return;
      // claude spawns children; kill the whole group. It may already be dead,
      // in which case the kill throws and that is fine.
      try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
    };
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      fn(arg);
    };

    const watchdog = setTimeout(() => {
      killProc();
      finish(reject, new Error(`claude timed out after ${timeoutSec}s`));
    }, timeoutSec * 1000);

    const start = (promptText, turns) => {
      stdout = "";
      stderr = "";
      const args = [
        "-p", promptText,
        "--output-format", "json",
        "--model", model,
        "--max-turns", String(turns),
      ];
      for (const t of allowedTools) args.push("--allowedTools", t);
      if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
      // stdin must be ignored: the default pipe stays open forever and the CLI
      // stalls 3s in -p mode waiting on it, then warns into stderr.
      proc = spawn("claude", args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout.on("data", (d) => { stdout += d; });
      proc.stderr.on("data", (d) => { stderr += d; });
      proc.on("error", (err) => {
        finish(reject, err.code === "ENOENT"
          ? new Error("`claude` CLI not found in PATH — install Claude Code (https://claude.com/claude-code) or add it to PATH, then retry")
          : err);
      });
      proc.on("close", (code) => onClose(code));
    };

    // Returns true when a retry was started — the caller must then return and
    // leave the promise pending.
    const maybeRetryMaxTurns = (isError, subtype) => {
      if (retried || !retryNudge || isError !== true || subtype !== MAX_TURNS_SUBTYPE) return false;
      const leftMs = timeoutSec * 1000 - (Date.now() - startedAt);
      if (leftMs < RETRY_MIN_RUNWAY_MS) {
        onNotice(`hit the turn limit with only ${Math.round(leftMs / 1000)}s left — not retrying`);
        return false;
      }
      retried = true;
      onNotice("hit the turn limit — retrying once, answering from what was already read");
      start(prompt + retryNudge, retryMaxTurns);
      return true;
    };

    function onClose(code) {
      if (settled) return;
      const w = parseWrapper(stdout);
      if (code !== 0) {
        if (maybeRetryMaxTurns(w.isError, w.subtype)) return;
        finish(reject, new Error(closeFailureMessage({ code, stdout, stderr })));
        return;
      }
      // Some CLI versions exit 0 with is_error plus the real message (auth
      // expiry, usage limit, …) in result — those are failures, not results.
      if (w.isError) {
        if (maybeRetryMaxTurns(true, w.subtype)) return;
        const hint = failureHint(w.result || stdout);
        finish(reject, new Error(hint ?? `claude failed: ${w.result.slice(0, 800) || w.subtype || "no detail from claude"}`));
        return;
      }
      finish(resolve, {
        text: w.result || stdout,
        wrapper: w,
        retried,
        elapsedMs: Date.now() - startedAt,
      });
    }

    start(prompt, maxTurns);
  });
}
