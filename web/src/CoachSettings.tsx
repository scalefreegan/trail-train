// Coach settings dialog — the write surface for the agent's context.
// Opened from the "⚙ settings" chip in the command bar. Edits:
//   - scalar preferences + free-text context sections + dated temporary
//     notes  → state.json preferences (via PUT /api/settings)
//   - childcare markers + calendar keywords → config/profile.json
// Dev-only like chat/resync: the endpoints live in vite dev middleware.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePersistentState, type CoachContext, type TemporaryContextItem } from "./data";

type SettingsPayload = {
  preferences: {
    training_philosophy?: string;
    weekly_rest_day?: string;
    nutrition_target_kcal_per_hour?: number;
    heat_threshold_c?: number;
    context?: Partial<CoachContext>;
  };
  calendar: { childcare_markers: string[]; calendar_keywords: Record<string, string[]> };
  calendar_error?: string | null;
  today: string;
};

type FormState = {
  training_philosophy: string;
  weekly_rest_day: string;
  // "" while the user is clearing/retyping — omitted from the save payload
  // rather than silently committing 0
  nutrition_target_kcal_per_hour: number | "";
  heat_threshold_c: number | "";
  sections: CoachContext["sections"];
  temporary: TemporaryContextItem[];
  childcare_markers: string[];
  calendar_keywords: Record<string, string[]>;
};

const SECTION_META: { key: keyof CoachContext["sections"]; label: string; hint: string }[] = [
  { key: "about_me", label: "about me", hint: "background the coach should know — role, history, strengths, injuries" },
  { key: "training_preferences", label: "training preferences", hint: "how you like to train — biases, session shapes, non-negotiables" },
  { key: "calendar_conventions", label: "calendar conventions", hint: "what your calendar events mean — markers, recurring commitments, severity" },
];

function plusDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const inputStyle: React.CSSProperties = {
  background: "var(--night-deep)", border: "1px solid var(--edge-bright)",
  color: "var(--mist)", fontSize: 12.5, padding: "7px 10px", outline: "none",
};

/* Textarea that grows with its content — no inner scrollbars, no manual
   resize handles. Height tracks scrollHeight on every value change. */
function AutoGrowArea({ value, onChange, minHeight = 72, ...rest }: {
  value: string;
  onChange: (v: string) => void;
  minHeight?: number;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight + 2, minHeight)}px`;
  }, [value, minHeight]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
      style={{
        ...inputStyle, width: "100%", resize: "none", overflow: "hidden",
        lineHeight: 1.55, font: "12.5px var(--font-body)", minHeight,
        ...(rest.style ?? {}),
      }}
    />
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="eyebrow" style={{ fontSize: 9, color: "var(--lamp)", margin: "0 0 8px" }}>{children}</div>;
}

function Hint({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ fontSize: 10.5, color: "var(--mist-mute)", marginTop: 4, lineHeight: 1.45, ...style }}>{children}</div>;
}

function Block({ children }: { children: React.ReactNode }) {
  return <div style={{ marginBottom: 26 }}>{children}</div>;
}

export default function CoachSettings({ onClose }: { onClose: () => void }) {
  const { reload } = usePersistentState();
  const [form, setForm] = useState<FormState | null>(null);
  const [today, setToday] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newNote, setNewNote] = useState({ text: "", expires: "" });
  const [newMarker, setNewMarker] = useState("");
  const [markerHint, setMarkerHint] = useState<string | null>(null);
  const [newKeyword, setNewKeyword] = useState<Record<string, string>>({});
  // ids present at load time — the server preserves any item it has that
  // isn't in this set (e.g. appended by the coach while the dialog was open)
  const knownIdsRef = useRef<string[]>([]);

  // discarding a long edit deserves one confirmation; a clean form closes freely
  const requestClose = useCallback(() => {
    if (saving) return;
    if (!dirty || window.confirm("discard unsaved changes?")) onClose();
  }, [dirty, saving, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  useEffect(() => {
    fetch("/api/settings")
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => null);
          throw new Error(body?.error ?? (r.status === 404
            ? "settings endpoint unavailable — restart the dev server"
            : `settings unavailable (${r.status})`));
        }
        return (await r.json()) as SettingsPayload;
      })
      .then((d) => {
        const p = d.preferences ?? {};
        setToday(d.today);
        setCalendarError(d.calendar_error ?? null);
        setNewNote({ text: "", expires: plusDays(d.today, 30) });
        knownIdsRef.current = (p.context?.temporary ?? []).map((t) => t.id);
        setForm({
          training_philosophy: p.training_philosophy ?? "",
          weekly_rest_day: p.weekly_rest_day ?? "",
          nutrition_target_kcal_per_hour: p.nutrition_target_kcal_per_hour ?? 300,
          heat_threshold_c: p.heat_threshold_c ?? 24,
          sections: {
            about_me: p.context?.sections?.about_me ?? "",
            calendar_conventions: p.context?.sections?.calendar_conventions ?? "",
            training_preferences: p.context?.sections?.training_preferences ?? "",
          },
          temporary: p.context?.temporary ?? [],
          childcare_markers: d.calendar?.childcare_markers ?? [],
          calendar_keywords: d.calendar?.calendar_keywords ?? {},
        });
      })
      .catch((e) => setLoadError((e as Error).message));
  }, []);

  const patch = useCallback((p: Partial<FormState>) => {
    setDirty(true);
    setForm((f) => (f ? { ...f, ...p } : f));
  }, []);

  const save = async () => {
    if (!form || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          preferences: {
            training_philosophy: form.training_philosophy,
            weekly_rest_day: form.weekly_rest_day,
            // cleared number fields are omitted, not saved as 0
            ...(form.nutrition_target_kcal_per_hour !== "" ? { nutrition_target_kcal_per_hour: form.nutrition_target_kcal_per_hour } : {}),
            ...(form.heat_threshold_c !== "" ? { heat_threshold_c: form.heat_threshold_c } : {}),
            context: { sections: form.sections, temporary: form.temporary, known_ids: knownIdsRef.current },
          },
          // a corrupt profile.json makes calendar edits refusable server-side;
          // don't send them at all in that case
          ...(calendarError ? {} : {
            calendar: {
              childcare_markers: form.childcare_markers,
              calendar_keywords: form.calendar_keywords,
            },
          }),
        }),
      });
      const body = await res.json().catch(() => null);
      // even a failed save may have committed preferences (partial write) —
      // adopt the server's item ids so a retry can't resurrect a deletion
      const returnedIds = body?.preferences?.context?.temporary?.map((t: TemporaryContextItem) => t.id);
      if (Array.isArray(returnedIds)) knownIdsRef.current = returnedIds;
      if (!res.ok) throw new Error(body?.error ?? `save failed (${res.status})`);
      reload();
      onClose();
    } catch (e) {
      // a partial write may have committed preferences — refresh the
      // dashboard's view either way, and keep the dialog open with the error
      reload();
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addNote = () => {
    if (!form || !newNote.text.trim() || !newNote.expires) return;
    patch({
      temporary: [...form.temporary, {
        id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text: newNote.text.trim(),
        added: today,
        expires: newNote.expires,
        source: "user",
      }],
    });
    setNewNote({ text: "", expires: plusDays(today, 30) });
  };

  const body = !form ? (
    <p style={{ fontSize: 12.5, color: loadError ? "var(--ember)" : "var(--mist-mute)", padding: "24px 0" }}>
      {loadError ?? "loading…"}
    </p>
  ) : (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: "8px 48px" }}>
      {/* left column: who you are + how the coach should read things */}
      <div style={{ minWidth: 0 }}>
        <Block>
          <Eyebrow>preferences</Eyebrow>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <label style={{ gridColumn: "1 / -1" }}>
              <Hint style={{ marginTop: 0, marginBottom: 4 }}>training philosophy</Hint>
              <input style={{ ...inputStyle, width: "100%" }} value={form.training_philosophy}
                onChange={(e) => patch({ training_philosophy: e.target.value })} />
            </label>
            <label>
              <Hint style={{ marginTop: 0, marginBottom: 4 }}>weekly rest day</Hint>
              <input style={{ ...inputStyle, width: "100%" }} value={form.weekly_rest_day}
                onChange={(e) => patch({ weekly_rest_day: e.target.value })} />
            </label>
            <div style={{ display: "flex", gap: 14 }}>
              <label>
                <Hint style={{ marginTop: 0, marginBottom: 4 }}>fuel kcal/h</Hint>
                <input type="number" min={0} max={1000} className="numerals" style={{ ...inputStyle, width: 80 }}
                  value={form.nutrition_target_kcal_per_hour}
                  onChange={(e) => patch({ nutrition_target_kcal_per_hour: e.target.value === "" ? "" : Number(e.target.value) })} />
              </label>
              <label>
                <Hint style={{ marginTop: 0, marginBottom: 4 }}>heat °C</Hint>
                <input type="number" min={-10} max={50} className="numerals" style={{ ...inputStyle, width: 80 }}
                  value={form.heat_threshold_c}
                  onChange={(e) => patch({ heat_threshold_c: e.target.value === "" ? "" : Number(e.target.value) })} />
              </label>
            </div>
          </div>
        </Block>

        {SECTION_META.map(({ key, label, hint }) => (
          <Block key={key}>
            <Eyebrow>{label}</Eyebrow>
            <AutoGrowArea
              value={form.sections[key]}
              onChange={(v) => patch({ sections: { ...form.sections, [key]: v } })}
              minHeight={key === "calendar_conventions" ? 140 : 88}
              maxLength={4000}
            />
            <Hint>{hint} · sent to the coach verbatim</Hint>
          </Block>
        ))}
      </div>

      {/* right column: dated notes + calendar classifier config */}
      <div style={{ minWidth: 0 }}>
        <Block>
          <Eyebrow>temporary notes</Eyebrow>
          <Hint style={{ marginTop: 0, marginBottom: 12 }}>
            dated context the coach treats as a hard constraint until it expires — expired notes are
            ignored by the coach but kept here until you delete them
          </Hint>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {form.temporary.length === 0 && (
              <span style={{ fontSize: 12, color: "var(--mist-mute)" }}>none yet</span>
            )}
            {form.temporary.map((t) => {
              const expired = t.expires < today;
              return (
                <div key={t.id} style={{
                  border: "1px solid var(--edge)", borderLeft: `2px solid ${expired ? "var(--edge-bright)" : "var(--lamp)"}`,
                  padding: "10px 12px 12px", opacity: expired ? 0.5 : 1, background: "var(--night-deep)",
                }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                    <span className="eyebrow" style={{ fontSize: 8.5, color: "var(--mist-mute)" }}>until</span>
                    <input
                      type="date" value={t.expires} className="numerals"
                      onChange={(e) => patch({ temporary: form.temporary.map((x) => x.id === t.id ? { ...x, expires: e.target.value } : x) })}
                      style={{ ...inputStyle, fontSize: 11, padding: "3px 7px", colorScheme: "dark" }}
                    />
                    {t.source === "agent" && (
                      <span className="eyebrow" style={{ fontSize: 8, border: "1px dashed var(--edge-bright)", padding: "2px 6px", color: "var(--lamp)" }}>agent</span>
                    )}
                    {expired && (
                      <span className="eyebrow" style={{ fontSize: 8, color: "var(--ember)" }}>expired</span>
                    )}
                    <button className="chip" style={{ fontSize: 9, padding: "2px 8px", marginLeft: "auto" }}
                      onClick={() => patch({ temporary: form.temporary.filter((x) => x.id !== t.id) })}>
                      delete
                    </button>
                  </div>
                  <AutoGrowArea
                    value={t.text} minHeight={40} maxLength={2000}
                    onChange={(v) => patch({ temporary: form.temporary.map((x) => x.id === t.id ? { ...x, text: v } : x) })}
                    style={{ border: "1px solid var(--edge)", fontSize: 12 }}
                  />
                </div>
              );
            })}
            {/* add card */}
            <div style={{ border: "1px dashed var(--edge-bright)", padding: "10px 12px 12px" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <span className="eyebrow" style={{ fontSize: 8.5, color: "var(--mist-mute)" }}>new note · until</span>
                <input
                  type="date" value={newNote.expires} className="numerals"
                  onChange={(e) => setNewNote((n) => ({ ...n, expires: e.target.value }))}
                  style={{ ...inputStyle, fontSize: 11, padding: "3px 7px", colorScheme: "dark" }}
                />
                <button className="chip" style={{ fontSize: 9, padding: "2px 10px", marginLeft: "auto" }} onClick={addNote}
                  disabled={!newNote.text.trim() || !newNote.expires}
                  title={!newNote.expires ? "pick an end date first" : undefined}>add</button>
              </div>
              <AutoGrowArea
                value={newNote.text} minHeight={40} maxLength={2000}
                onChange={(v) => setNewNote((n) => ({ ...n, text: v }))}
                placeholder="e.g. travel, a niggle, a schedule change…"
                style={{ border: "1px solid var(--edge)", fontSize: 12 }}
              />
            </div>
          </div>
        </Block>

        <Block>
          <Eyebrow>calendar markers</Eyebrow>
          <Hint style={{ marginTop: 0 }}>single words that mark childcare days when they appear in an event title · applies at the next resync</Hint>
          {calendarError && (
            <p style={{ fontSize: 11.5, color: "var(--ember)", marginTop: 8 }}>{calendarError}</p>
          )}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
            {form.childcare_markers.map((mk) => (
              <button key={mk} className="chip" style={{ fontSize: 10, textTransform: "none" }} title="remove"
                disabled={!!calendarError}
                onClick={() => patch({ childcare_markers: form.childcare_markers.filter((x) => x !== mk) })}>
                {mk} ×
              </button>
            ))}
            <input
              placeholder="add marker…" value={newMarker} disabled={!!calendarError}
              onChange={(e) => { setNewMarker(e.target.value); setMarkerHint(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newMarker.trim()) {
                  const mk = newMarker.trim().toLowerCase();
                  if (/\s/.test(mk)) {
                    // the classifier matches markers against single words of the
                    // title — a spaced marker would save fine and match nothing
                    setMarkerHint("single words only — the sync matches each word of the event title");
                    return;
                  }
                  if (!form.childcare_markers.includes(mk)) patch({ childcare_markers: [...form.childcare_markers, mk] });
                  setNewMarker("");
                }
              }}
              style={{ ...inputStyle, width: 130, fontSize: 11, padding: "4px 8px" }}
            />
            {markerHint && <span style={{ fontSize: 10.5, color: "var(--ember)" }}>{markerHint}</span>}
          </div>
        </Block>

        {Object.keys(form.calendar_keywords).length > 0 && (
          <Block>
            <Eyebrow>calendar keywords</Eyebrow>
            <Hint style={{ marginTop: 0 }}>title keywords that classify events (per classification) · applies at the next resync</Hint>
            {Object.entries(form.calendar_keywords).map(([cls, words]) => (
              <div key={cls} style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
                <span className="eyebrow" style={{ fontSize: 9, color: "var(--mist-dim)", width: 90, flexShrink: 0 }}>{cls}</span>
                {words.map((w) => (
                  <button key={w} className="chip" style={{ fontSize: 10, textTransform: "none" }} title="remove"
                    onClick={() => patch({ calendar_keywords: { ...form.calendar_keywords, [cls]: words.filter((x) => x !== w) } })}>
                    {w} ×
                  </button>
                ))}
                <input
                  placeholder="add…" value={newKeyword[cls] ?? ""}
                  onChange={(e) => setNewKeyword((k) => ({ ...k, [cls]: e.target.value }))}
                  onKeyDown={(e) => {
                    const v = (newKeyword[cls] ?? "").trim().toLowerCase();
                    if (e.key === "Enter" && v) {
                      if (!words.includes(v)) patch({ calendar_keywords: { ...form.calendar_keywords, [cls]: [...words, v] } });
                      setNewKeyword((k) => ({ ...k, [cls]: "" }));
                    }
                  }}
                  style={{ ...inputStyle, width: 100, fontSize: 11, padding: "4px 8px" }}
                />
              </div>
            ))}
          </Block>
        )}
      </div>
    </div>
  );

  return createPortal(
    <div
      onClick={requestClose}
      style={{
        position: "fixed", inset: 0, zIndex: 100, background: "rgba(4, 8, 12, 0.78)",
        display: "flex", padding: "clamp(12px, 3vh, 32px)",
      }}
    >
      <div
        className="panel notch"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(1240px, 100%)", margin: "0 auto", display: "flex", flexDirection: "column",
          maxHeight: "100%", flex: "0 1 auto",
        }}
      >
        {/* header */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          borderBottom: "1px solid var(--edge)", padding: "16px 28px", flexShrink: 0,
        }}>
          <div>
            <div className="eyebrow" style={{ color: "var(--mist-dim)" }}>⚙ coach settings</div>
            <div style={{ fontSize: 11.5, color: "var(--mist-mute)", marginTop: 3 }}>
              the context the coach reads before every readout and chat reply
            </div>
          </div>
          <button className="chip" onClick={requestClose} style={{ fontSize: 9 }}>close esc</button>
        </div>

        {/* scrollable content */}
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "24px 28px 8px" }}>
          {body}
        </div>

        {/* footer */}
        <div style={{
          display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10,
          borderTop: "1px solid var(--edge)", padding: "14px 28px", flexShrink: 0,
        }}>
          {saveError && (
            <span style={{ fontSize: 11.5, color: "var(--ember)", marginRight: "auto" }}>{saveError}</span>
          )}
          <button className="chip" onClick={requestClose} style={{ fontSize: 10 }}>cancel</button>
          <button
            className="chip" onClick={save} disabled={saving || !form}
            style={{
              fontSize: 10, padding: "5px 16px",
              background: saving || !form ? "transparent" : "var(--lamp)",
              borderColor: "var(--lamp)",
              color: saving || !form ? "var(--lamp)" : "var(--night)",
            }}
          >
            {saving ? "saving…" : "save"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
