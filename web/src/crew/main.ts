import { projectRace, type RaceProjection } from "../race/pacing";
import { projectOptions, readCrewData } from "./crewData";
import { checkpointMessage, renderCrewPage } from "./render";
import {
  applyCheckpoint,
  clearCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  type CheckpointEntry,
  type CheckpointResult,
} from "./checkpoint";
import "./crew.css";

/* ------------------------------------------------------------------ */
/*  Crew page entry (PRD v2 §5).                                       */
/*                                                                     */
/*  The whole app this file bundles is: read the embedded JSON, run    */
/*  the real projection over it, put the result on screen — and then   */
/*  re-run that projection whenever the crew types where the runner    */
/*  actually was. Nothing fetches, no framework, one <script> and one  */
/*  <style>; the built file is opened from a phone's Downloads folder  */
/*  in airplane mode at 2 a.m., which is a harsher runtime than the    */
/*  dev server ever is.                                                */
/*                                                                     */
/*  It re-projects rather than only printing the embedded ETAs so the  */
/*  pure pacing code is genuinely EXERCISED in the export (a shell     */
/*  that merely printed numbers would keep passing after the bundle    */
/*  stopped working), and so the checkpoint updater has a live         */
/*  projection to re-run rather than a table to retrofit.              */
/*                                                                     */
/*  Listeners are DELEGATED from #root, which is assigned exactly once */
/*  per render: re-binding a form that innerHTML has just replaced is  */
/*  the standard way a page like this quietly stops responding on the  */
/*  second update.                                                     */
/* ------------------------------------------------------------------ */

/** "19:40" — the wall clock in the RACE's zone, whatever the phone is set to.
    This is the updater's default: the overwhelmingly common entry is "she
    just came through", typed within a minute or two of it happening. */
function nowInRaceZone(timeZone: string, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    const hour = parts.find((p) => p.type === "hour")?.value ?? "";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "";
    return hour && minute ? `${hour}:${minute}` : "";
  } catch {
    return "";
  }
}

function mount(): void {
  const root = document.getElementById("root");
  if (!root) return;

  const data = readCrewData();
  if (!data) {
    root.innerHTML =
      `<header><h1>No crew data</h1>` +
      `<p class="sub">This shell was opened without an export embedded in it. ` +
      `Run <code>node scripts/crew-export.mjs --race &lt;slug&gt;</code>, or press ` +
      `“export crew page” in the planner, and open the file that writes.</p></header>`;
    return;
  }

  document.title = `${data.race.name} — crew sheet`;

  let live: RaceProjection | null;
  try {
    live = projectRace(data.course, data.fit, projectOptions(data));
  } catch (e) {
    // A local re-projection that throws must not blank the sheet: the ETAs
    // computed at export time are embedded too, and renderCrewPage falls back
    // to them when `live` is null. The crew still gets their times, with the
    // reason printed rather than swallowed.
    live = null;
    console.error("local re-projection failed — showing the exported ETAs", e);
  }

  let checkpoint: CheckpointResult | null = null;
  let message = "";
  // Bug 4: a refused submit leaves `checkpoint` exactly as it was, so its
  // non-null-ness can no longer tell the status line "this message is a
  // success" — this says so explicitly.
  let warn = false;

  function render(): void {
    root!.innerHTML = renderCrewPage(data!, live, checkpoint, message, warn);
    if (!live && !checkpoint) {
      const note = document.createElement("p");
      note.className = "warn";
      note.textContent = "showing the times as exported (this device could not re-run the projection)";
      root!.appendChild(note);
    }
    // A courtesy for whoever inspects the file: prove where the numbers came
    // from without needing the console open.
    root!.setAttribute("data-projection", checkpoint ? "checkpoint" : live ? "live" : "exported");
    const clock = document.getElementById("cp-clock") as HTMLInputElement | null;
    if (clock && !clock.value) clock.value = nowInRaceZone(data!.race.timezone);
  }

  /** Apply an entry, remember it, and say what happened.
   *
   * Bug 4: a REFUSED submit must leave whatever checkpoint is already in
   * force completely untouched — the table, the caption, the clear button
   * and localStorage all keep showing the one that worked. Only the warning
   * line changes. Discarding a good split because the NEXT thing the crew
   * typed was a mistake (wrong station picked, a fat-fingered clock) is
   * worse than showing a warning next to a still-correct sheet. Persistence
   * on success is still the LAST step: a split the page could not use must
   * not come back on reload. */
  function commit(entry: CheckpointEntry, persist: boolean): void {
    const outcome = applyCheckpoint(data!, live, entry, { current: checkpoint });
    if (!outcome.ok) {
      message = escapeText(outcome.reason);
      warn = true;
      render();
      return;
    }
    checkpoint = outcome.result;
    message = checkpointMessage(outcome.result);
    warn = false;
    if (persist) saveCheckpoint(data!.slug, { station: entry.station, clock: outcome.result.clock });
    render();
  }

  // A reload in a parking lot must not lose the split the crew typed an hour
  // ago, so the last checkpoint is re-applied on load. It is re-APPLIED, not
  // restored from a cached result: the projection is recomputed from the
  // embedded inputs, which is the only copy of the numbers this file has.
  const stored = loadCheckpoint(data.slug);
  if (stored) {
    const outcome = applyCheckpoint(data, live, stored);
    if (outcome.ok) {
      checkpoint = outcome.result;
      message = checkpointMessage(outcome.result);
    } else {
      // A stored split that no longer applies (an edited file, a renamed
      // station) is dropped rather than left to haunt every future reload.
      clearCheckpoint(data.slug);
    }
  }

  render();

  root.addEventListener("submit", (ev) => {
    const form = (ev.target as HTMLElement | null)?.closest?.("#checkpoint-form");
    if (!form) return;
    ev.preventDefault();
    const station = (document.getElementById("cp-station") as HTMLSelectElement | null)?.value ?? "";
    const clock = (document.getElementById("cp-clock") as HTMLInputElement | null)?.value ?? "";
    commit({ station, clock }, true);
  });

  root.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest?.("#cp-clear");
    if (!target) return;
    ev.preventDefault();
    checkpoint = null;
    message = "";
    warn = false;
    clearCheckpoint(data.slug);
    render();
  });
}

/** The one place main.ts writes text into HTML: a refusal reason. Kept here
    rather than reaching into render.ts's escaper so the message path has no
    way to grow a markup feature by accident. */
function escapeText(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

mount();
