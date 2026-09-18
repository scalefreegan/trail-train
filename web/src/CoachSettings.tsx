// Coach settings dialog — the write surface for the agent's context.
// Opened from the "⚙ settings" chip in the command bar. Edits:
//   - scalar preferences + free-text context sections + dated temporary
//     notes  → state.json preferences (via PUT /api/settings)
//   - childcare markers + calendar keywords + athlete physiology (body mass,
//     long-run reference distance) → config/profile.json
//   - generic-mode goals (event class, phase, volume band, notes)
//     → config/goals.json
// Dev-only like chat/resync: the endpoints live in vite dev middleware.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePersistentState, type CoachContext, type TemporaryContextItem } from "./data";

/** PRD §5.3 — KEEP IN SYNC with GOAL_PHASES in scripts/goals.mjs. */
const GOAL_PHASES = ["recovery", "return_to_run", "base", "build", "peak", "taper", "maintain"] as const;

type Goals = {
  event_class: string;
  horizon: string;
  phase: string;
  weekly_volume_band: { dist_mi: [number, number]; vert_ft: [number, number] };
  notes: string;
};

// "" while a band field is being retyped — the save refuses rather than
// committing a 0 the athlete didn't mean
type GoalsForm = Omit<Goals, "weekly_volume_band"> & {
  weekly_volume_band: { dist_mi: (number | "")[]; vert_ft: (number | "")[] };
};

/** PRD §5.4 — the athlete's own numbers. KEEP THE BOUNDS IN SYNC with
    PHYSIOLOGY_BOUNDS in web/vite.config.ts and PHYSIOLOGY_FIELDS in
    scripts/profile.mjs; the server rejects anything outside them. */
const PHYSIOLOGY_META = [
  {
    key: "body_kg" as const,
    label: "body mass (kg)",
    hint: "every mg/kg caffeine figure in the race plan scales with this — it lives here, not in a race folder, so a race can be shared without it",
    min: 30, max: 200, step: 0.1,
  },
  {
    key: "long_run_ref_mi" as const,
    label: "long-run reference (mi)",
    hint: "the distance the pacing fit is read at: your own long-run regime, not the race distance. The projection evaluates fitness pace here and lets the fatigue curve carry everything past it",
    min: 5, max: 50, step: 1,
  },
];

type PhysiologyKey = (typeof PHYSIOLOGY_META)[number]["key"];
// "" while a field is being retyped — the save refuses rather than committing
// a 0 the athlete didn't mean (same rule as the volume band)
type PhysiologyForm = Record<PhysiologyKey, number | "">;

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
  goals?: Partial<Goals> | null;
  goals_error?: string | null;
  physiology?: Partial<Record<PhysiologyKey, number>> | null;
  /** what the loader substituted, and why — shown so a plan built on the
      impersonal defaults says so instead of looking personal */
  physiology_warnings?: string[] | null;
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
  goals: GoalsForm;
  physiology: PhysiologyForm;
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
   resize handles. Height tracks scrollHeight on every value change AND on
   width changes (grid reflow / window resize rewraps the text). */
function AutoGrowArea({ value, onChange, minHeight = 72, ...rest }: {
  value: string;
  onChange: (v: string) => void;
  minHeight?: number;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const lastWidth = useRef(0);
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight + 2, minHeight)}px`;
  }, [minHeight]);
  // layout effect: sized before paint, no one-frame flash on mount
  useLayoutEffect(measure, [value, measure]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // re-measure only on WIDTH changes — our own height writes also fire
      // the observer and would loop otherwise
      if (el.clientWidth !== lastWidth.current) {
        lastWidth.current = el.clientWidth;
        measure();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
      style={{
        ...inputStyle, width: "100%", resize: "none", overflow: "hidden",
        font: "12.5px var(--font-body)", lineHeight: 1.55, minHeight,
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

/* One [lo, hi] row of the weekly volume band. A field cleared mid-edit stays
   "" rather than snapping to 0 — the save refuses on a blank instead. */
function BandRow({ label, hint, value, step, onChange }: {
  label: string;
  hint: string;
  step?: number;
  value: (number | "")[];
  onChange: (next: (number | "")[]) => void;
}) {
  const set = (i: number, raw: string) => {
    const next = [...value];
    next[i] = raw === "" ? "" : Number(raw);
    onChange(next);
  };
  return (
    <div>
      <Hint style={{ marginTop: 0, marginBottom: 4 }}>{label}</Hint>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="number" min={0} step={step} className="numerals" aria-label={`${label} low`}
          style={{ ...inputStyle, width: 88 }} value={value[0]} onChange={(e) => set(0, e.target.value)} />
        <span style={{ color: "var(--mist-mute)", fontSize: 12 }}>–</span>
        <input type="number" min={0} step={step} className="numerals" aria-label={`${label} high`}
          style={{ ...inputStyle, width: 88 }} value={value[1]} onChange={(e) => set(1, e.target.value)} />
      </div>
      <Hint>{hint}</Hint>
    </div>
  );
}

export default function CoachSettings({ onClose }: { onClose: () => void }) {
  const { reload } = usePersistentState();
  const [form, setForm] = useState<FormState | null>(null);
  const [today, setToday] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [goalsError, setGoalsError] = useState<string | null>(null);
  const [physiologyNote, setPhysiologyNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [newNote, setNewNote] = useState({ text: "", expires: "" });
  const [newMarker, setNewMarker] = useState("");
  const [markerHint, setMarkerHint] = useState<string | null>(null);
  const [newKeyword, setNewKeyword] = useState<Record<string, string>>({});
  // ids present at load time — the server preserves any item it has that
  // isn't in this set (e.g. appended by the coach while the dialog was open)
  const knownIdsRef = useRef<string[]>([]);
  // section text at load time — lets the server re-apply agent appends that
  // landed while the dialog was open instead of clobbering them
  const sectionsBaselineRef = useRef<CoachContext["sections"] | null>(null);
  const backdropMouseDown = useRef(false);

  // discarding a long edit deserves one confirmation; a clean form closes
  // freely — a typed-but-not-added note draft counts as an edit too
  const requestClose = useCallback(() => {
    if (saving) return;
    if ((!dirty && !newNote.text.trim()) || window.confirm("discard unsaved changes?")) onClose();
  }, [dirty, saving, newNote.text, onClose]);

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
        setGoalsError(d.goals_error ?? null);
        // the server already fell back to defaults; the dialog shows them as
        // real values and explains, once, that they are stand-ins
        setPhysiologyNote(d.physiology_warnings?.length ? d.physiology_warnings.join(" · ") : null);
        setNewNote({ text: "", expires: plusDays(d.today, 30) });
        knownIdsRef.current = (p.context?.temporary ?? []).map((t) => t.id);
        sectionsBaselineRef.current = {
          about_me: p.context?.sections?.about_me ?? "",
          calendar_conventions: p.context?.sections?.calendar_conventions ?? "",
          training_preferences: p.context?.sections?.training_preferences ?? "",
        };
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
          physiology: {
            body_kg: d.physiology?.body_kg ?? "",
            long_run_ref_mi: d.physiology?.long_run_ref_mi ?? "",
          },
          goals: {
            event_class: d.goals?.event_class ?? "",
            horizon: d.goals?.horizon ?? "",
            phase: d.goals?.phase ?? "maintain",
            notes: d.goals?.notes ?? "",
            weekly_volume_band: {
              dist_mi: d.goals?.weekly_volume_band?.dist_mi ?? [0, 0],
              vert_ft: d.goals?.weekly_volume_band?.vert_ft ?? [0, 0],
            },
          },
        });
      })
      .catch((e) => setLoadError((e as Error).message));
  }, []);

  const patch = useCallback((p: Partial<FormState>) => {
    setDirty(true);
    setForm((f) => (f ? { ...f, ...p } : f));
  }, []);

  /** Which band fields are blank or reversed — the save refuses on any. */
  const goalsBandProblem = (g: GoalsForm): string | null => {
    for (const [key, label] of [["dist_mi", "weekly miles"], ["vert_ft", "weekly vert"]] as const) {
      const [lo, hi] = g.weekly_volume_band[key];
      if (lo === "" || hi === "") return `${label}: the volume band needs both a low and a high number`;
      if (lo > hi) return `${label}: the low end (${lo}) is above the high end (${hi})`;
    }
    return null;
  };

  /** Which physiology field is blank or out of the server's range. Checked
      here so the dialog names the field instead of relaying a 400. */
  const physiologyProblem = (ph: PhysiologyForm): string | null => {
    for (const { key, label, min, max } of PHYSIOLOGY_META) {
      const v = ph[key];
      if (v === "") return `${label}: needs a number`;
      if (!Number.isFinite(v) || v < min || v > max) return `${label}: must be between ${min} and ${max}`;
    }
    return null;
  };

  const save = async () => {
    if (!form || saving) return;
    const bandProblem = goalsBandProblem(form.goals);
    if (bandProblem) { setSaveError(bandProblem); return; }
    const physProblem = physiologyProblem(form.physiology);
    if (physProblem) { setSaveError(physProblem); return; }
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
            context: {
              sections: form.sections,
              sections_baseline: sectionsBaselineRef.current ?? undefined,
              temporary: form.temporary,
              known_ids: knownIdsRef.current,
            },
          },
          goals: {
            ...form.goals,
            weekly_volume_band: {
              dist_mi: form.goals.weekly_volume_band.dist_mi as number[],
              vert_ft: form.goals.weekly_volume_band.vert_ft as number[],
            },
          },
          // a corrupt profile.json makes every profile-owned edit refusable
          // server-side; don't send them at all in that case
          ...(calendarError ? {} : {
            calendar: {
              childcare_markers: form.childcare_markers,
              calendar_keywords: form.calendar_keywords,
            },
            physiology: {
              body_kg: form.physiology.body_kg as number,
              long_run_ref_mi: form.physiology.long_run_ref_mi as number,
            },
          }),
        }),
      });
      const body = await res.json().catch(() => null);
      // even a failed save may have committed preferences (partial write) —
      // adopt the server's item ids and section text so a retry can't
      // resurrect a deletion or re-clobber a merged append
      const returnedIds = body?.preferences?.context?.temporary?.map((t: TemporaryContextItem) => t.id);
      if (Array.isArray(returnedIds)) knownIdsRef.current = returnedIds;
      const returnedSections = body?.preferences?.context?.sections;
      if (returnedSections && typeof returnedSections === "object") {
        const adopted = {
          about_me: returnedSections.about_me ?? "",
          calendar_conventions: returnedSections.calendar_conventions ?? "",
          training_preferences: returnedSections.training_preferences ?? "",
        };
        sectionsBaselineRef.current = adopted;
        if (!res.ok) {
          // dialog stays open — show the server's merged text (it contains
          // this form's edits plus any re-applied agent append) so a retry
          // can't clobber the merge
          setForm((f) => (f ? { ...f, sections: adopted } : f));
        }
      }
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

        <Block>
          <Eyebrow>physiology · yours, not the race's</Eyebrow>
          <Hint style={{ marginTop: 0, marginBottom: 12 }}>
            the two numbers the race plan needs about your body (config/profile.json, gitignored) ·
            they used to be hard-coded in a race folder and in the pacing model
          </Hint>
          {calendarError && (
            <p style={{ fontSize: 11.5, color: "var(--ember)", marginBottom: 10 }}>
              config/profile.json could not be parsed — physiology edits are disabled until it is fixed by hand
            </p>
          )}
          {physiologyNote && (
            <p style={{ fontSize: 11.5, color: "var(--lamp)", marginBottom: 10 }}>{physiologyNote}</p>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {PHYSIOLOGY_META.map(({ key, label, hint, min, max, step }) => (
              <label key={key}>
                <Hint style={{ marginTop: 0, marginBottom: 4 }}>{label}</Hint>
                <input type="number" min={min} max={max} step={step} className="numerals" disabled={!!calendarError}
                  style={{ ...inputStyle, width: "100%" }} value={form.physiology[key]}
                  onChange={(e) => patch({
                    physiology: { ...form.physiology, [key]: e.target.value === "" ? "" : Number(e.target.value) },
                  })} />
                <Hint>{hint}</Hint>
              </label>
            ))}
          </div>
        </Block>

        <Block>
          <Eyebrow>goals · when no race is active</Eyebrow>
          <Hint style={{ marginTop: 0, marginBottom: 12 }}>
            what the coach trains you toward between races (config/goals.json) · the volume band also
            sets the weekly targets of the rolling 12-week window, for any week the coach hasn't planned
          </Hint>
          {goalsError && (
            <p style={{ fontSize: 11.5, color: "var(--ember)", marginBottom: 10 }}>{goalsError}</p>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <label style={{ gridColumn: "1 / -1" }}>
              <Hint style={{ marginTop: 0, marginBottom: 4 }}>event class</Hint>
              <input style={{ ...inputStyle, width: "100%" }} maxLength={200} value={form.goals.event_class}
                placeholder="e.g. 100 mi mountain race"
                onChange={(e) => patch({ goals: { ...form.goals, event_class: e.target.value } })} />
            </label>
            <label>
              <Hint style={{ marginTop: 0, marginBottom: 4 }}>horizon</Hint>
              <input style={{ ...inputStyle, width: "100%" }} maxLength={200} value={form.goals.horizon}
                placeholder="e.g. next A-race ~Aug 2027"
                onChange={(e) => patch({ goals: { ...form.goals, horizon: e.target.value } })} />
            </label>
            <label>
              <Hint style={{ marginTop: 0, marginBottom: 4 }}>phase</Hint>
              <select style={{ ...inputStyle, width: "100%" }} value={form.goals.phase}
                onChange={(e) => patch({ goals: { ...form.goals, phase: e.target.value } })}>
                {GOAL_PHASES.map((ph) => (
                  <option key={ph} value={ph}>{ph.replace(/_/g, " ")}</option>
                ))}
              </select>
            </label>
            <BandRow
              label="weekly miles" hint="low–high band the coach plans inside"
              value={form.goals.weekly_volume_band.dist_mi}
              onChange={(next) => patch({ goals: { ...form.goals, weekly_volume_band: { ...form.goals.weekly_volume_band, dist_mi: next } } })}
            />
            <BandRow
              label="weekly vert (ft)" hint="its midpoint is the rolling window's target" step={100}
              value={form.goals.weekly_volume_band.vert_ft}
              onChange={(next) => patch({ goals: { ...form.goals, weekly_volume_band: { ...form.goals.weekly_volume_band, vert_ft: next } } })}
            />
          </div>
          <div style={{ marginTop: 14 }}>
            <Hint style={{ marginTop: 0, marginBottom: 4 }}>goals notes</Hint>
            <AutoGrowArea
              value={form.goals.notes} minHeight={64} maxLength={2000}
              placeholder="injuries and their reassessment dates, why this phase, anything that caps the week"
              onChange={(v) => patch({ goals: { ...form.goals, notes: v } })}
            />
            <Hint>sent to the coach verbatim in place of the race paragraph</Hint>
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
                    disabled={!!calendarError}
                    onClick={() => patch({ calendar_keywords: { ...form.calendar_keywords, [cls]: words.filter((x) => x !== w) } })}>
                    {w} ×
                  </button>
                ))}
                <input
                  placeholder="add…" value={newKeyword[cls] ?? ""} disabled={!!calendarError}
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
      // close only when the CLICK STARTED on the backdrop — releasing a
      // text-selection drag over the edge of the panel must not close it
      onMouseDown={(e) => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && backdropMouseDown.current) requestClose(); }}
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
