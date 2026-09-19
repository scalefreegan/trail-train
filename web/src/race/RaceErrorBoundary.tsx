import { Component, type ErrorInfo, type ReactNode } from "react";

/* ------------------------------------------------------------------ */
/*  Race-view crash guard.                                            */
/*                                                                    */
/*  Wraps the race view, the nutrition view and the race-day route —   */
/*  every RacePlanProvider-fed subtree. Its projection, fuel plan and  */
/*  caffeine plan are computed IN RENDER (useRacePlanInstance), not in  */
/*  an effect, so a bad race folder (a draft's course built before its  */
/*  date was known, a hand-edited race.json, a malformed course.json)   */
/*  throws mid-render — and with no boundary above it, that white-      */
/*  screens the WHOLE app, training view included, because App.tsx's    */
/*  root has nothing else to catch it. Class component because error    */
/*  boundaries are the one thing React hooks still can't do.            */
/*                                                                    */
/*  Deliberately placed OUTSIDE each RacePlanProvider, not around just   */
/*  its children: the crash this exists for happens while the provider   */
/*  itself is resolving the plan (RacePlanScope's useRacePlanInstance     */
/*  call, in useRacePlan.ts), before any child ever renders.             */
/* ------------------------------------------------------------------ */

type Props = {
  /** the folder ON SCREEN, for the crash message and the recovery POST */
  slug: string | null;
  children: ReactNode;
};

type State = { error: Error | null };

export class RaceErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // no server-side error tracker to send this to — the console is it.
    console.error(`[race] ${this.props.slug ?? "(no slug)"} crashed the race view:`, error, info.componentStack);
  }

  private backToTrainMode = async () => {
    try {
      await fetch("/api/race/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: null, mode: "train" }),
      });
    } catch {
      // the reload below is the recovery either way — a failed POST just
      // means the pointer didn't move, which reload() will surface again
      // as "no race" rather than as this boundary's crash screen.
    }
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <section>
        <div className="panel notch" style={{ padding: "28px 26px" }}>
          <span className="eyebrow" style={{ color: "var(--ember)" }}>race view crashed</span>
          <div style={{ marginTop: 10, fontSize: 13, color: "var(--mist-dim)", lineHeight: 1.6, maxWidth: 640 }}>
            <div>
              <b>{this.props.slug ?? "(no active race)"}</b> hit an error the race view couldn't render around:
            </div>
            <div
              className="numerals"
              style={{ marginTop: 8, fontSize: 11.5, color: "var(--mist-mute)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            >
              {error.message}
            </div>
          </div>
          <button
            className="chip"
            style={{ marginTop: 16, fontSize: 10.5, padding: "6px 14px" }}
            onClick={() => { void this.backToTrainMode(); }}
          >
            back to generic mode
          </button>
        </div>
      </section>
    );
  }
}
