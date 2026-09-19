import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStrava } from "../data";
import type { Activity } from "../data";
import { useDialog } from "./dialogChrome";

/* Archive with result (PRD §10). The dialog behind the switcher's "Archive
   with result…" row: pick the Strava activity that IS the race, optionally
   overwrite what the GPS says with the official results, and POST it to
   /api/races/:slug/archive — which derives the per-station splits from the
   activity's track, writes result.json, retires race.json and releases the
   pointer (scripts/race-result.mjs).

   The picker is deliberately narrow: activities within a few days of the race
   date, race day first. The server enforces ±1 day in RACE-local time and
   refuses anything else, so the list is a convenience, not the guard. */

/** "33:16", "33:16:12" or a decimal "33.27" → hours. null when unreadable. */
function parseElapsedH(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const hms = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(t);
  if (hms) return +(Number(hms[1]) + Number(hms[2]) / 60 + Number(hms[3] ?? 0) / 3600).toFixed(4);
  const dec = Number(t);
  return Number.isFinite(dec) && dec > 0 ? dec : null;
}

/**
 * One official split per line: the station name, then its elapsed time —
 * "<station> 6:25", "<station> = 6:25" and "<station>, 6:25" all read the same.
 * Lines that do not end in a time come back in `bad` so a typo is shown
 * rather than silently dropped.
 */
function parseOfficialSplits(text: string): {
  splits: { station: string; elapsed_h: number }[];
  bad: string[];
} {
  const splits: { station: string; elapsed_h: number }[] = [];
  const bad: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.*?)[\s,=|]+(\d{1,3}:[0-5]?\d(?::[0-5]?\d)?|\d+(?:\.\d+)?)$/.exec(line);
    const h = m ? parseElapsedH(m[2]) : null;
    if (!m || !m[1].trim() || h === null) { bad.push(line); continue; }
    splits.push({ station: m[1].trim(), elapsed_h: h });
  }
  return { splits, bad };
}

/** Whole days from the race date to an activity's local date. */
function dayOffset(activityDate: string, raceDate: string): number {
  const a = Date.parse(`${activityDate.slice(0, 10)}T00:00:00Z`);
  const r = Date.parse(`${raceDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(r)) return Number.POSITIVE_INFINITY;
  return Math.round((a - r) / 86400000);
}

const PICKER_SLACK_DAYS = 3;
const FALLBACK_ROWS = 20;

const field: React.CSSProperties = {
  width: "100%", background: "var(--night-deep)", border: "1px solid var(--edge-bright)",
  outline: "none", padding: "6px 8px", font: "12.5px var(--font-body)", color: "var(--mist)",
};

const labelStyle: React.CSSProperties = { fontSize: 8.5, color: "var(--mist-dim)", display: "block", marginBottom: 4 };

export function ArchiveRace({ slug, name, raceDate, linkedActivityId, onClose, onArchived }: {
  slug: string;
  name: string;
  /** race.json's date, "YYYY-MM-DD" — null for a folder whose race.json would not parse. */
  raceDate: string | null;
  /** already-linked activity, when this is a re-link rather than a first archive */
  linkedActivityId?: string | null;
  onClose: () => void;
  /** called after the POST succeeds — the caller closes and pulses the refresh */
  onArchived: () => void;
}) {
  const { activities } = useStrava();

  // Race day first, then outward — the right row is almost always the first.
  const candidates = useMemo(() => {
    const runs = [...activities].sort((a, b) => b.date.localeCompare(a.date));
    if (!raceDate) return runs.slice(0, FALLBACK_ROWS);
    const near = runs
      .map((a) => ({ a, off: dayOffset(a.date, raceDate) }))
      .filter((x) => Math.abs(x.off) <= PICKER_SLACK_DAYS)
      .sort((x, y) => Math.abs(x.off) - Math.abs(y.off) || y.a.distance_mi - x.a.distance_mi);
    // Nothing near race day usually means the Strava window no longer reaches
    // back that far; showing the recent log at least explains the emptiness.
    return near.length > 0 ? near.map((x) => x.a) : runs.slice(0, FALLBACK_ROWS);
  }, [activities, raceDate]);

  const [picked, setPicked] = useState<string | null>(null);
  const [status, setStatus] = useState<"finished" | "dnf" | "dns">("finished");
  const [notes, setNotes] = useState("");
  const [officialOpen, setOfficialOpen] = useState(false);
  const [finishText, setFinishText] = useState("");
  const [placement, setPlacement] = useState("");
  const [splitsText, setSplitsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server enforces ±1 day (RACE-local time) and refuses anything wider
  // — the picker's own ±PICKER_SLACK_DAYS window (or the 20-row fallback) is
  // just what fills the list, so a folder with nothing that close needs to
  // say so up front rather than let the athlete pick a row and find out only
  // after ARCHIVE RACE comes back 400. A folder with no parseable race date
  // can't be checked client-side at all — that case is left to the server.
  const withinDay = (a: Activity) => raceDate != null && Math.abs(dayOffset(a.date, raceDate)) <= 1;
  const noneWithinDay = raceDate != null && candidates.length > 0 && !candidates.some(withinDay);

  // The selection before anyone has clicked: the already-linked activity, or
  // the longest run on race day (the candidates are sorted that way). Derived
  // rather than seeded into state, so a late-arriving Strava log still lands
  // on race day instead of on nothing.
  const defaultId = useMemo(() => {
    if (linkedActivityId && candidates.some((a) => a.id === linkedActivityId)) return linkedActivityId;
    if (candidates.length > 0 && raceDate && dayOffset(candidates[0].date, raceDate) === 0) return candidates[0].id;
    return null;
  }, [candidates, linkedActivityId, raceDate]);
  const activityId = picked ?? defaultId;
  const { titleId, dialogProps } = useDialog({ onClose, locked: busy });
  // Can't tell locally (no parseable race date) → don't block; the server
  // guard is still the one that actually enforces this.
  const selectedActivity = candidates.find((a) => a.id === activityId) ?? null;
  const selectedQualifies = raceDate == null || (selectedActivity != null && withinDay(selectedActivity));

  const parsedSplits = useMemo(() => parseOfficialSplits(splitsText), [splitsText]);
  const finishH = parseElapsedH(finishText);
  const finishBad = finishText.trim() !== "" && finishH === null;

  const submit = async () => {
    if (!activityId || busy) return;
    setBusy(true);
    setError(null);
    const official = officialOpen && (finishH !== null || placement.trim() || parsedSplits.splits.length > 0)
      ? {
          finish_h: finishH ?? undefined,
          official_time: finishText.trim() || undefined,
          placement: placement.trim() || undefined,
          splits: parsedSplits.splits.length > 0 ? parsedSplits.splits : undefined,
        }
      : undefined;
    try {
      const res = await fetch(`/api/races/${encodeURIComponent(slug)}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          activity_id: activityId,
          status,
          notes: notes.trim() || undefined,
          official,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      onArchived();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const backdropMouseDown = useRef(false);
  return createPortal(
    <div
      onMouseDown={(e) => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && backdropMouseDown.current && !busy) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 100, background: "rgba(4, 8, 12, 0.78)",
        display: "flex", padding: "clamp(12px, 3vh, 32px)",
      }}
    >
      <div
        {...dialogProps}
        className="panel notch"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(620px, 100%)", maxHeight: "100%", margin: "auto", display: "flex", flexDirection: "column" }}
      >
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          borderBottom: "1px solid var(--edge)", padding: "16px 24px",
        }}>
          <div id={titleId} className="eyebrow" style={{ color: "var(--mist-dim)" }}>
            {linkedActivityId ? "link result" : "archive with result"}
          </div>
          <button className="chip" onClick={onClose} disabled={busy} style={{ fontSize: 9 }}>close esc</button>
        </div>

        <div style={{ padding: "16px 24px 20px", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: "var(--mist-mute)" }}>
            Pick the Strava activity that is <span style={{ color: "var(--mist)" }}>{name}</span>
            {raceDate ? <> on <span className="numerals" style={{ color: "var(--mist)" }}>{raceDate}</span></> : null}.
            Its GPS track becomes the per-station splits — where it first passes within 150 m of each
            aid station. Archiving retires the folder and hands training back to your goals.
          </p>

          {/* ---- the activity ---- */}
          <div>
            <span className="eyebrow" style={labelStyle}>race activity</span>
            {candidates.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--lamp)", lineHeight: 1.5 }}>
                No runs in the Strava log — run a resync first.
              </div>
            ) : (
              <>
                {noneWithinDay && (
                  <div style={{ fontSize: 12, color: "var(--lamp)", lineHeight: 1.5, marginBottom: 6 }}>
                    No activity within ±1 day of race day — the server will refuse any of these as the result.
                    Pick the closest below to enter it manually, or add the official time and splits under
                    "official results".
                  </div>
                )}
                <div style={{ border: "1px solid var(--edge-bright)", maxHeight: 190, overflowY: "auto" }}>
                  {candidates.map((a) => (
                    <ActivityRow
                      key={a.id}
                      activity={a}
                      offset={raceDate ? dayOffset(a.date, raceDate) : null}
                      selected={a.id === activityId}
                      onSelect={() => setPicked(a.id)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {/* ---- how it ended ---- */}
          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 12 }}>
            <label>
              <span className="eyebrow" style={labelStyle}>result</span>
              <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} style={field}>
                <option value="finished">finished</option>
                <option value="dnf">dnf</option>
                <option value="dns">dns</option>
              </select>
            </label>
            <label>
              <span className="eyebrow" style={labelStyle}>notes</span>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="how it actually went" style={field} />
            </label>
          </div>

          {/* ---- official results, when they disagree with the watch ---- */}
          <div style={{ borderTop: "1px solid var(--edge)", paddingTop: 12 }}>
            <button
              className="chip"
              onClick={() => setOfficialOpen((v) => !v)}
              style={{ fontSize: 9 }}
              aria-expanded={officialOpen}
            >
              {officialOpen ? "− " : "+ "}official results
            </button>
            {officialOpen && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <label>
                    <span className="eyebrow" style={labelStyle}>official finish (h:mm)</span>
                    <input
                      value={finishText}
                      onChange={(e) => setFinishText(e.target.value)}
                      placeholder="33:16"
                      style={{ ...field, borderColor: finishBad ? "var(--ember)" : "var(--edge-bright)" }}
                    />
                  </label>
                  <label>
                    <span className="eyebrow" style={labelStyle}>placement</span>
                    <input value={placement} onChange={(e) => setPlacement(e.target.value)} placeholder="41 / 112" style={field} />
                  </label>
                </div>
                <label>
                  <span className="eyebrow" style={labelStyle}>official splits — one per line, "station 6:25"</span>
                  <textarea
                    value={splitsText}
                    onChange={(e) => setSplitsText(e.target.value)}
                    rows={4}
                    placeholder={"aid station 6:25\nnext station 11:42"}
                    style={{ ...field, resize: "vertical", font: "12.5px var(--font-mono, var(--font-body))" }}
                  />
                </label>
                <div style={{ fontSize: 11, color: "var(--mist-dim)", lineHeight: 1.5 }}>
                  {parsedSplits.splits.length > 0 && (
                    <span>{parsedSplits.splits.length} split{parsedSplits.splits.length === 1 ? "" : "s"} will overwrite the track. </span>
                  )}
                  {parsedSplits.bad.length > 0 && (
                    <span style={{ color: "var(--ember)" }}>
                      unreadable: {parsedSplits.bad.slice(0, 3).join(" · ")}
                      {parsedSplits.bad.length > 3 ? ` (+${parsedSplits.bad.length - 3})` : ""}
                    </span>
                  )}
                  {finishBad && <span style={{ color: "var(--ember)" }}> finish time must be h:mm or decimal hours.</span>}
                </div>
              </div>
            )}
          </div>

          {error && (
            <div style={{ fontSize: 11.5, color: "var(--ember)", lineHeight: 1.5 }}>{error}</div>
          )}
        </div>

        <div style={{
          borderTop: "1px solid var(--edge)", padding: "12px 24px",
          display: "flex", justifyContent: "flex-end", gap: 10, alignItems: "center",
        }}>
          <button className="chip" onClick={onClose} disabled={busy} style={{ fontSize: 9 }}>cancel</button>
          <button
            className="chip"
            onClick={submit}
            disabled={!activityId || busy || finishBad || !selectedQualifies}
            title={!selectedQualifies ? "the picked activity is more than 1 day from race day — the server will refuse it" : undefined}
            style={{
              fontSize: 9,
              background: activityId && !busy && !finishBad && selectedQualifies ? "var(--lamp)" : "transparent",
              borderColor: activityId && !busy && !finishBad && selectedQualifies ? "var(--lamp)" : "var(--edge-bright)",
              color: activityId && !busy && !finishBad && selectedQualifies ? "var(--night)" : "var(--mist-mute)",
              cursor: activityId && !busy && !finishBad && selectedQualifies ? "pointer" : "not-allowed",
            }}
          >
            {busy ? "archiving…" : linkedActivityId ? "link result" : "archive race"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ActivityRow({ activity, offset, selected, onSelect }: {
  activity: Activity; offset: number | null; selected: boolean; onSelect: () => void;
}) {
  const hours = Math.floor(activity.moving_s / 3600);
  const mins = Math.round((activity.moving_s % 3600) / 60);
  return (
    <button
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      style={{
        width: "100%", textAlign: "left", display: "flex", alignItems: "baseline", gap: 10,
        padding: "7px 10px", cursor: "pointer",
        background: selected ? "var(--edge)" : "transparent",
        borderLeft: `2px solid ${selected ? "var(--lamp)" : "transparent"}`,
      }}
    >
      <span className="numerals" style={{ fontSize: 10.5, color: "var(--mist-dim)", width: 78, flexShrink: 0 }}>
        {activity.date.slice(0, 10)}
      </span>
      <span style={{ fontSize: 12, color: "var(--mist)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {activity.title}
      </span>
      <span className="numerals" style={{ fontSize: 10.5, color: "var(--mist-mute)", whiteSpace: "nowrap" }}>
        {activity.distance_mi.toFixed(1)} mi · {hours}h{String(mins).padStart(2, "0")}
      </span>
      {offset === 0 && (
        <span className="eyebrow" style={{ fontSize: 8, color: "var(--lamp)", whiteSpace: "nowrap" }}>race day</span>
      )}
    </button>
  );
}
