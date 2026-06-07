#!/usr/bin/env node
// Pulls Google Calendar events for the next 30 days (and last 7 for context)
// and writes web/public/google-cal.json for the dashboard / agent.
//
// One-time setup:
//   1. Enable the Google Calendar API for your project:
//      https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
//   2. Configure the OAuth consent screen (External, testing mode is fine),
//      add your own email as a test user.
//   3. Create an OAuth 2.0 Client ID (Web application type):
//      - Redirect URI: http://localhost:5174/google-callback
//   4. Save credentials to ~/.config/google/config.json:
//        { "clientId": "...", "clientSecret": "...",
//          "redirectUri": "http://localhost:5174/google-callback" }
//   5. node scripts/sync-google-cal.mjs --auth   (one-time browser dance)
//
// Subsequent runs auto-refresh the access token via the saved refresh_token.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { exec } from "node:child_process";

const CONFIG_PATH = path.join(os.homedir(), ".config", "google", "config.json");
const OUT_PATH = path.join(process.cwd(), "web", "public", "google-cal.json");
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
const SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}

const PAST_DAYS   = Number(arg("past",   7));
const FUTURE_DAYS = Number(arg("future", 30));
const CAL_ID      = arg("cal", "primary");
const AUTH        = !!arg("auth", false);

function printSetupHelp() {
  console.error("Setup steps:");
  console.error("  1. Enable Calendar API:");
  console.error("     https://console.cloud.google.com/apis/library/calendar-json.googleapis.com");
  console.error("  2. Configure OAuth consent screen, add your email as a test user.");
  console.error("  3. Create an OAuth 2.0 Client ID (Web application):");
  console.error("     - Redirect URI: http://localhost:5174/google-callback");
  console.error(`  4. Save credentials to ${CONFIG_PATH}:`);
  console.error('     {');
  console.error('       "clientId": "...",');
  console.error('       "clientSecret": "...",');
  console.error('       "redirectUri": "http://localhost:5174/google-callback"');
  console.error('     }');
  console.error("  5. node scripts/sync-google-cal.mjs --auth");
  console.error("");
}

async function loadConfig() {
  let cfg;
  try { cfg = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8")); }
  catch {
    console.error(`\n✗ couldn't read ${CONFIG_PATH}\n`);
    printSetupHelp();
    process.exit(2);
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    console.error(`✗ ${CONFIG_PATH} missing clientId / clientSecret\n`);
    printSetupHelp();
    process.exit(2);
  }
  if (!cfg.redirectUri) cfg.redirectUri = "http://localhost:5174/google-callback";
  return cfg;
}
async function saveConfig(cfg) {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? `open "${url}"`
            : process.platform === "win32"  ? `start "" "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function authFlow(cfg) {
  return new Promise((resolve, reject) => {
    const state = Math.random().toString(36).slice(2);
    const url = new URL(AUTHORIZE_URL);
    const redirect = new URL(cfg.redirectUri);
    const port = Number(redirect.port) || 5174;
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", cfg.redirectUri);
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");      // get refresh token
    url.searchParams.set("prompt", "consent");           // force refresh-token issuance
    url.searchParams.set("state", state);

    const server = http.createServer(async (req, res) => {
      if (!req.url.startsWith(redirect.pathname)) {
        res.writeHead(404); res.end(); return;
      }
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
        const tok = await exchangeCode(cfg, code);
        cfg.accessToken  = tok.access_token;
        cfg.refreshToken = tok.refresh_token || cfg.refreshToken;
        cfg.expiresAt    = Math.floor(Date.now() / 1000) + (tok.expires_in || 3600);
        cfg.scope        = tok.scope;
        await saveConfig(cfg);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><meta charset="utf-8"><title>google calendar connected</title>
          <style>body{font:16px/1.5 system-ui;background:#ece3d0;color:#1a1410;padding:48px;max-width:560px;margin:auto}
          h1{font-family:Georgia,serif;font-style:italic;font-weight:300} code{background:#e3d8bf;padding:2px 6px}</style>
          <h1>✓ Trail Almanac is hooked into your Google Calendar.</h1>
          <p>You can close this tab and return to your terminal.</p>
          <p>Run <code>npm run sync:google</code> to pull your events.</p>`);
        server.close();
        resolve(cfg);
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

async function exchangeCode(cfg, code) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function refreshAccessToken(cfg) {
  console.log("• refreshing google access token…");
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status} ${await r.text()}`);
  const tok = await r.json();
  cfg.accessToken = tok.access_token;
  // Google may NOT return a new refresh token on each refresh; keep existing.
  if (tok.refresh_token) cfg.refreshToken = tok.refresh_token;
  cfg.expiresAt   = Math.floor(Date.now() / 1000) + (tok.expires_in || 3600);
  await saveConfig(cfg);
  return cfg.accessToken;
}

async function ensureToken(cfg) {
  if (!cfg.refreshToken && !cfg.accessToken) {
    throw new Error("not authorized — run with --auth first");
  }
  if (!cfg.expiresAt || cfg.expiresAt * 1000 < Date.now() + 60_000) {
    if (!cfg.refreshToken) throw new Error("access token expired and no refresh token; re-run with --auth");
    return refreshAccessToken(cfg);
  }
  return cfg.accessToken;
}

async function fetchEvents(token, calId, timeMin, timeMax) {
  const all = [];
  let pageToken;
  do {
    const url = new URL(`${API}/calendars/${encodeURIComponent(calId)}/events`);
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("singleEvents", "true");        // expand recurring
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "250");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`events fetch failed: ${r.status} ${body.slice(0, 240)}`);
    }
    const data = await r.json();
    all.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return all;
}

function eventStart(ev) {
  return ev.start?.dateTime || ev.start?.date || null;   // RFC3339 or YYYY-MM-DD
}
function eventEnd(ev) {
  return ev.end?.dateTime || ev.end?.date || null;
}
function isAllDay(ev) { return !ev.start?.dateTime; }
function durationMin(ev) {
  if (isAllDay(ev)) return null;
  const s = new Date(eventStart(ev)).getTime();
  const e = new Date(eventEnd(ev)).getTime();
  return Math.max(0, Math.round((e - s) / 60_000));
}

// Cheap heuristic classifier: tag events the agent should weight.
function classify(ev) {
  const t = `${ev.summary || ""} ${ev.description || ""} ${ev.location || ""}`.toLowerCase();
  if (/race|50k|50mi|100mi|ultra|marathon|trail run|fkt/.test(t)) return "race";
  if (/flight|airport|trip|travel|hotel/.test(t)) return "travel";
  if (/dr\.|doctor|appt|appointment|dentist|pt\b|physio/.test(t)) return "appointment";
  if (/long run|workout|tempo|intervals?|hill|vert|coach/.test(t)) return "training";
  if (/meeting|standup|sync|call|interview|review/.test(t)) return "work";
  return "other";
}

async function main() {
  const cfg = await loadConfig();
  if (AUTH) {
    await authFlow(cfg);
    console.log(`✓ authorized · scopes: ${cfg.scope || SCOPES.join(" ")}`);
    return;
  }
  const token = await ensureToken(cfg);

  const now = new Date();
  const timeMin = new Date(now.getTime() - PAST_DAYS   * 86400_000).toISOString();
  const timeMax = new Date(now.getTime() + FUTURE_DAYS * 86400_000).toISOString();
  console.log(`• fetching ${CAL_ID} events ${timeMin.slice(0,10)} → ${timeMax.slice(0,10)}…`);

  const raw = await fetchEvents(token, CAL_ID, timeMin, timeMax);
  const events = raw
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
      classification: classify(e),
      html_link: e.htmlLink || null,
    }));

  // Per-day grouping for the next 14 days — useful for the agent to scan
  // upcoming training-affecting blocks fast.
  const upcoming = events.filter((e) => e.start && new Date(e.start) > now);
  const daysAhead = 14;
  const upcoming_by_day = {};
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(now.getTime() + i * 86400_000).toISOString().slice(0, 10);
    upcoming_by_day[d] = upcoming.filter((e) => (e.start || "").startsWith(d));
  }

  const summary = {
    total_events: events.length,
    past_events: events.filter((e) => e.start && new Date(e.start) < now).length,
    upcoming_events: upcoming.length,
    races_upcoming: upcoming.filter((e) => e.classification === "race").length,
    travel_days_upcoming: [
      ...new Set(
        upcoming
          .filter((e) => e.classification === "travel")
          .map((e) => (e.start || "").slice(0, 10))
          .filter(Boolean)
      ),
    ],
  };

  const payload = {
    fetched_at: new Date().toISOString(),
    window: { time_min: timeMin, time_max: timeMax, past_days: PAST_DAYS, future_days: FUTURE_DAYS },
    calendar_id: CAL_ID,
    summary,
    events,
    upcoming_by_day,
  };
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`✓ wrote ${events.length} events → ${OUT_PATH}`);
  console.log(`  ${summary.past_events} past · ${summary.upcoming_events} upcoming · ${summary.races_upcoming} races · ${summary.travel_days_upcoming.length} travel days`);
}

main().catch((e) => { console.error("✗", e.message || e); process.exit(1); });
