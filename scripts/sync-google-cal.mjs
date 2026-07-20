#!/usr/bin/env node
// Pulls Google Calendar events for the next 30 days (and last 7 for context)
// and writes web/public/google-cal.json for the dashboard.
//
// Credentials come from ~/.config/google/config.json ({ clientId,
// clientSecret, redirectUri }) or, as a fallback, env vars
// GOOGLE_CAL_API_CLIENT_ID / GOOGLE_CAL_API_CLIENT_SECRET (see google-keys.mjs).
//
// Tokens are stored at ~/.config/google/tokens.json (kept separate from
// the credential file so the @cocal/google-calendar-mcp server can co-
// exist using its own bootstrap at ~/.config/google/gcp-oauth.keys.json).
//
// Usage:
//   node scripts/sync-google-cal.mjs --auth          # one-time browser dance
//   node scripts/sync-google-cal.mjs                 # subsequent pulls
//   node scripts/sync-google-cal.mjs --past 7 --future 30 --cal primary

import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { exec } from "node:child_process";
import { readCredentials, loadTokens, saveTokens } from "./google-keys.mjs";
import { arg, writeJsonAtomic } from "./lib.mjs";

// Resolve from the script location, not cwd — `npm run sync:google` executes
// from web/, where a cwd-relative path would land in web/web/public/.
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_PATH = path.join(ROOT, "web", "public", "google-cal.json");
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

const PAST_DAYS   = Number(arg("past",   7));
const FUTURE_DAYS = Number(arg("future", 30));
// --cal takes a comma-separated list of calendar ids; when absent, profile.json
// calendar_ids decides, falling back to "primary". Family logistics (childcare
// markers, kid sports) usually live on shared calendars the athlete can read
// but that never appear on the authorized account's primary calendar.
const CAL_ARG     = arg("cal", null);
const AUTH        = !!arg("auth", false);

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? `open "${url}"`
            : process.platform === "win32"  ? `start "" "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function authFlow({ clientId, clientSecret, redirectUri }) {
  return new Promise((resolve, reject) => {
    const state = Math.random().toString(36).slice(2);
    const url = new URL(AUTHORIZE_URL);
    const redirect = new URL(redirectUri);
    const port = Number(redirect.port) || 5174;
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);

    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith(redirect.pathname)) { res.writeHead(404); res.end(); return; }
      const incoming = new URL(req.url, `http://localhost:${port}`);
      const code = incoming.searchParams.get("code");
      const returnedState = incoming.searchParams.get("state");
      if (!code || returnedState !== state) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end("<h2>auth failed</h2><p>missing code or state mismatch — close this tab and re-run.</p>");
        server.close();
        reject(new Error("auth failed: missing code or state mismatch"));
        return;
      }
      try {
        const r = await fetch(TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code, client_id: clientId, client_secret: clientSecret,
            redirect_uri: redirectUri, grant_type: "authorization_code",
          }),
        });
        if (!r.ok) throw new Error(`token exchange ${r.status}: ${await r.text()}`);
        const tok = await r.json();
        await saveTokens({
          accessToken:  tok.access_token,
          refreshToken: tok.refresh_token,
          expiresAt:    Math.floor(Date.now() / 1000) + (tok.expires_in || 3600),
          scope:        tok.scope,
        });
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><meta charset="utf-8"><title>google calendar connected</title>
          <style>body{font:16px/1.5 system-ui;background:#ece3d0;color:#1a1410;padding:48px;max-width:560px;margin:auto}
          h1{font-family:Georgia,serif;font-style:italic;font-weight:300} code{background:#e3d8bf;padding:2px 6px}</style>
          <h1>✓ Trail Almanac is hooked into your Google Calendar.</h1>
          <p>Close this tab and return to your terminal. Run <code>npm run sync:google</code> to pull events.</p>`);
        server.close();
        resolve();
      } catch (e) {
        res.writeHead(500); res.end(String(e.message || e));
        server.close();
        reject(e);
      }
    });
    server.listen(port, () => {
      console.log(`• opening browser to authorize…`);
      console.log(`  if it doesn't open, paste this URL:\n  ${url.toString()}\n`);
      openBrowser(url.toString());
    });
  });
}

async function refreshAccessToken({ clientId, clientSecret }, tokens) {
  console.log("• refreshing google access token…");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: clientId, client_secret: clientSecret,
    }),
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status} ${await r.text()}`);
  const tok = await r.json();
  const next = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || tokens.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (tok.expires_in || 3600),
    scope: tok.scope || tokens.scope,
  };
  await saveTokens(next);
  return next.accessToken;
}

async function ensureToken(creds) {
  const tokens = await loadTokens();
  if (!tokens.refreshToken && !tokens.accessToken) {
    throw new Error("not authorized — run with --auth first");
  }
  if (!tokens.expiresAt || tokens.expiresAt * 1000 < Date.now() + 60_000) {
    if (!tokens.refreshToken) throw new Error("access token expired and no refresh token; re-run with --auth");
    return refreshAccessToken(creds, tokens);
  }
  return tokens.accessToken;
}

async function fetchEvents(token, calId, timeMin, timeMax) {
  const all = [];
  let pageToken;
  do {
    const url = new URL(`${API}/calendars/${encodeURIComponent(calId)}/events`);
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`events fetch failed: ${r.status} ${(await r.text()).slice(0, 240)}`);
    const data = await r.json();
    all.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return all;
}

function eventStart(ev) { return ev.start?.dateTime || ev.start?.date || null; }
function eventEnd(ev)   { return ev.end?.dateTime   || ev.end?.date   || null; }
function isAllDay(ev)   { return !ev.start?.dateTime; }
function durationMin(ev) {
  if (isAllDay(ev)) return null;
  const s = new Date(eventStart(ev)).getTime();
  const e = new Date(eventEnd(ev)).getTime();
  return Math.max(0, Math.round((e - s) / 60_000));
}

// Personal calendar config from config/profile.json:
//   "calendar_ids":      ["primary", "partner@gmail.com", …] — calendars to merge
//   "calendar_keywords": { "travel": ["alabama"], "family": ["hawthorn"] } — substring rules
//   "childcare_markers": ["em", "m", "emerson", "h", "hawthorne"] — whole-word day markers
// Keyword rules are checked before the built-in patterns so personal naming
// wins (a trip named after a place, a kid's team name, …).
async function loadProfileConfig() {
  for (const p of [
    path.join(ROOT, "config", "profile.json"),
    path.join(ROOT, "config", "profile.example.json"),
  ]) {
    try {
      const profile = JSON.parse(await fs.readFile(p, "utf8"));
      const kw = profile.calendar_keywords;
      const rules = (!kw || typeof kw !== "object") ? [] :
        Object.entries(kw).flatMap(([classification, words]) =>
          (Array.isArray(words) ? words : []).map((w) => ({
            word: String(w).toLowerCase(),
            classification,
          }))
        );
      return {
        rules,
        calendarIds: Array.isArray(profile.calendar_ids) && profile.calendar_ids.length
          ? profile.calendar_ids.map(String)
          : ["primary"],
        childcareMarkers: Array.isArray(profile.childcare_markers)
          ? profile.childcare_markers.map((m) => String(m).toLowerCase())
          : [],
      };
    } catch {}
  }
  return { rules: [], calendarIds: ["primary"], childcareMarkers: [] };
}

function classify(ev, rules = [], childcareMarkers = []) {
  const t = `${ev.summary || ""} ${ev.description || ""} ${ev.location || ""}`.toLowerCase();
  // Childcare day markers first — they're terse all-day flags ("Em",
  // "H no school"), so match whole words of the TITLE only; a substring
  // rule for "m" or "h" would swallow nearly every event. Timed events
  // that happen to contain a marker word ("Em PT" at 14:30) fall through
  // to the normal rules.
  if (childcareMarkers.length && isAllDay(ev)) {
    const words = String(ev.summary || "").toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
    if (words.some((w) => childcareMarkers.includes(w))) return "childcare";
  }
  for (const r of rules) {
    if (t.includes(r.word)) return r.classification;
  }
  if (/race|50k|50mi|100mi|ultra|marathon|trail run|fkt/.test(t)) return "race";
  if (/flight|airport|\btrip\b|travel|hotel/.test(t)) return "travel";
  if (/dr\.|doctor|appt|appointment|dentist|\bpt\b|physio/.test(t)) return "appointment";
  if (/long run|workout|tempo|intervals?|hill|vert|coach/.test(t)) return "training";
  if (/soccer|practice|recital|playdate|birthday|school event/.test(t)) return "family";
  if (/meeting|standup|sync|call|interview|review/.test(t)) return "work";
  return "other";
}

async function main() {
  const creds = readCredentials();    // throws helpful error if missing
  console.log(`• creds source: ${creds.source}`);

  if (AUTH) {
    await authFlow(creds);
    console.log(`✓ authorized — tokens saved to ~/.config/google/tokens.json`);
    return;
  }

  const token = await ensureToken(creds);
  const now = new Date();
  const timeMin = new Date(now.getTime() - PAST_DAYS   * 86400_000).toISOString();
  const timeMax = new Date(now.getTime() + FUTURE_DAYS * 86400_000).toISOString();
  const { rules: keywordRules, calendarIds, childcareMarkers } = await loadProfileConfig();
  const calIds = CAL_ARG
    ? String(CAL_ARG).split(",").map((s) => s.trim()).filter(Boolean)
    : calendarIds;
  console.log(`• fetching ${calIds.length} calendar(s) ${timeMin.slice(0,10)} → ${timeMax.slice(0,10)}…`);

  const raw = [];
  for (const calId of calIds) {
    try {
      const items = await fetchEvents(token, calId, timeMin, timeMax);
      console.log(`  ✓ ${calId}: ${items.length} events`);
      for (const it of items) raw.push({ ...it, _calendar: calId });
    } catch (e) {
      // One unreadable calendar (revoked share, typo'd id) must not kill
      // the whole sync — the others still carry schedule constraints.
      console.warn(`  ✗ ${calId}: ${e.message}`);
    }
  }

  const mapped = raw
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({
      id: e.id,
      summary: e.summary || "(untitled)",
      description: (e.description || "").slice(0, 500),
      start: eventStart(e),
      end: eventEnd(e),
      all_day: isAllDay(e),
      duration_min: durationMin(e),
      location: e.location || null,
      attendees_count: Array.isArray(e.attendees) ? e.attendees.length : 0,
      classification: classify(e, keywordRules, childcareMarkers),
      calendar: e._calendar,
      html_link: e.htmlLink || null,
    }));
  // The same event often lands on two calendars (kid sports synced to both a
  // personal and a shared calendar) — keep one copy per (title, start). Merging
  // calendars also breaks the API's per-calendar startTime order, so re-sort.
  const seenKey = new Set();
  const events = mapped
    .filter((e) => {
      const k = `${e.summary.trim().toLowerCase()}|${e.start}`;
      if (seenKey.has(k)) return false;
      seenKey.add(k);
      return true;
    })
    .sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));

  const upcoming = events.filter((e) => e.start && new Date(e.start) > now);
  const upcoming_by_day = {};
  // Local-zone YYYY-MM-DD so keys match Google's event.start (which is in
  // the calendar's local zone). toISOString() would shift by a day in
  // the user's evening hours.
  const localIso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  for (let i = 0; i < 14; i++) {
    const d = localIso(new Date(now.getTime() + i * 86400_000));
    upcoming_by_day[d] = upcoming.filter((e) => (e.start || "").startsWith(d));
  }
  // Expand multi-day all-day events (a week-long trip, a 3-day "Em" childcare
  // block) into every covered day, not just the start date. All-day `end` is
  // exclusive per the Google API. Include ongoing spans (end > now).
  const coveredDaysUpcoming = (classification) => {
    const days = new Set();
    const todayIso = localIso(now);
    for (const e of events) {
      if (e.classification !== classification || !e.start) continue;
      const startDay = e.start.slice(0, 10);
      const endDay = (e.end || e.start).slice(0, 10);
      if (e.all_day && endDay > startDay) {
        for (let d = new Date(startDay + "T12:00:00"); localIso(d) < endDay; d = new Date(d.getTime() + 86400_000)) {
          const iso = localIso(d);
          if (iso >= todayIso) days.add(iso);
        }
      } else if (startDay >= todayIso) {
        days.add(startDay);
      }
    }
    return [...days].sort();
  };
  const summary = {
    total_events: events.length,
    past_events: events.filter((e) => e.start && new Date(e.start) < now).length,
    upcoming_events: upcoming.length,
    races_upcoming: upcoming.filter((e) => e.classification === "race").length,
    travel_days_upcoming: coveredDaysUpcoming("travel"),
    // Solo-kid-duty day markers ("Em", "H no school") — the coach treats these
    // as blocked for long daytime sessions.
    childcare_days_upcoming: coveredDaysUpcoming("childcare"),
  };

  const payload = {
    fetched_at: new Date().toISOString(),
    window: { time_min: timeMin, time_max: timeMax, past_days: PAST_DAYS, future_days: FUTURE_DAYS },
    calendar_id: calIds.join(","),
    calendar_ids: calIds,
    summary,
    events,
    upcoming_by_day,
  };
  await writeJsonAtomic(OUT_PATH, payload);
  console.log(`✓ wrote ${events.length} events → ${OUT_PATH}`);
  console.log(`  ${summary.past_events} past · ${summary.upcoming_events} upcoming · ${summary.races_upcoming} races · ${summary.travel_days_upcoming.length} travel days · ${summary.childcare_days_upcoming.length} childcare days`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
