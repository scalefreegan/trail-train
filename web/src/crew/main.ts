import { projectRace, type RaceProjection } from "../race/pacing";
import { projectOptions, readCrewData } from "./crewData";
import { renderCrewPage } from "./render";
import "./crew.css";

/* ------------------------------------------------------------------ */
/*  Crew page entry (PRD v2 §5).                                       */
/*                                                                     */
/*  The whole app this file bundles is: read the embedded JSON, run    */
/*  the real projection over it, put the result on screen. Nothing     */
/*  fetches, nothing stores, no framework — the built file is opened   */
/*  from a phone's Downloads folder in airplane mode at 2 a.m., which  */
/*  is a harsher runtime than the dev server ever is.                  */
/*                                                                     */
/*  It re-projects rather than only printing the embedded ETAs so the  */
/*  pure pacing code is genuinely EXERCISED in the export (a shell     */
/*  that merely printed numbers would keep passing after the bundle    */
/*  stopped working), and so bead 08's checkpoint updater has a live   */
/*  projection to re-run instead of a table to retrofit.               */
/* ------------------------------------------------------------------ */

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

  root.innerHTML = renderCrewPage(data, live);
  if (!live) {
    const note = document.createElement("p");
    note.className = "warn";
    note.textContent = "showing the times as exported (this device could not re-run the projection)";
    root.appendChild(note);
  }
  // A courtesy for whoever inspects the file: prove where the numbers came
  // from without needing the console open.
  root.setAttribute("data-projection", live ? "live" : "exported");
}

mount();
