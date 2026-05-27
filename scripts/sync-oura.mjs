#!/usr/bin/env node
// Pulls Oura ring data for a date range and writes web/public/oura.json
// for the TrailTrain dashboard. Uses Oura's OAuth2 server-side flow
// (PAT is deprecated — see https://cloud.ouraring.com/docs/authentication).
//
// One-time setup:
//   1. Register an app at https://cloud.ouraring.com/oauth/applications
//      - name: trail-train
//      - redirect URI: http://localhost:5174/oura-callback
//      - scopes: daily, heartrate, tag, personal
//   2. Copy the client ID + secret into ~/.config/oura/config.json:
//        { "clientId": "...", "clientSecret": "...",
//          "redirectUri": "http://localhost:5174/oura-callback" }
//   3. Run `node scripts/sync-oura.mjs --auth` once to authorize
//      (opens browser, captures the callback, saves tokens).
//   4. Run `node scripts/sync-oura.mjs` anytime to refresh data.
//      Access tokens auto-refresh via the saved refresh_token.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { exec } from "node:child_process";

const CONFIG_PATH = path.join(os.homedir(), ".config", "oura", "config.json");
const OUT_PATH = path.join(process.cwd(), "web", "public", "oura.json");
const API = "https://api.ouraring.com/v2/usercollection";
const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";
const SCOPES = ["daily", "heartrate", "tag", "personal"];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return true;
  return next;
}

const START = arg("start", "2026-04-27");
const END   = arg("end",   new Date().toISOString().slice(0, 10));
const AUTH  = !!arg("auth", false);

async function loadConfig() {
  let cfg;
  try {
    cfg = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  } catch {
    console.error(`\n✗ couldn't read ${CONFIG_PATH}\n`);
    printSetupHelp();
    process.exit(2);
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    console.error(`✗ ${CONFIG_PATH} missing clientId / clientSecret\n`);
    printSetupHelp();
    process.exit(2);
  }
  if (!cfg.redirectUri) cfg.redirectUri = "http://localhost:5174/oura-callback";
  return cfg;
}
async function saveConfig(cfg) {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function printSetupHelp() {
  console.error("Setup steps:");
  console.error("  1. Register an app: https://cloud.ouraring.com/oauth/applications");
  console.error("     · redirect URI: http://localhost:5174/oura-callback");
  console.error("     · scopes: daily, heartrate, tag, personal");
  console.error(`  2. Save credentials to ${CONFIG_PATH}:`);
  console.error('     {');
  console.error('       "clientId": "...",');
  console.error('       "clientSecret": "...",');
  console.error('       "redirectUri": "http://localhost:5174/oura-callback"');
  console.error('     }');
  console.error("  3. node scripts/sync-oura.mjs --auth");
  console.error("");
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
        cfg.refreshToken = tok.refresh_token;
        cfg.expiresAt    = Math.floor(Date.now() / 1000) + (tok.expires_in || 86400);
        cfg.scope        = tok.scope;
        await saveConfig(cfg);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><meta charset="utf-8"><title>oura connected</title>
          <style>body{font:16px/1.5 system-ui;background:#ece3d0;color:#1a1410;padding:48px;max-width:560px;margin:auto}
          h1{font-family:Georgia,serif;font-style:italic;font-weight:300} code{background:#e3d8bf;padding:2px 6px}</style>
          <h1>✓ Trail Almanac is hooked into your Oura ring.</h1>
          <p>You can close this tab and return to your terminal.</p>
          <p>Run <code>npm run sync:oura</code> to pull your data.</p>`);
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
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function refreshAccessToken(cfg) {
  console.log("• refreshing oura access token…");
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
  cfg.accessToken  = tok.access_token;
  cfg.refreshToken = tok.refresh_token || cfg.refreshToken;
  cfg.expiresAt    = Math.floor(Date.now() / 1000) + (tok.expires_in || 86400);
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

async function ouraGet(endpoint, token, params = {}) {
  const all = [];
  let next = null;
  do {
    const qs = new URLSearchParams({ ...params, ...(next ? { next_token: next } : {}) }).toString();
    const url = `${API}/${endpoint}${qs ? "?" + qs : ""}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`${endpoint} → ${r.status} ${body.slice(0, 200)}`);
    }
    const data = await r.json();
    all.push(...(data.data || []));
    next = data.next_token || null;
  } while (next);
  return all;
}

async function main() {
  let cfg = await loadConfig();
  if (AUTH) {
    cfg = await authFlow(cfg);
    console.log(`✓ authorized · scopes: ${cfg.scope || SCOPES.join(" ")}`);
    return;
  }
  const token = await ensureToken(cfg);
  console.log(`• fetching oura ${START} → ${END}…`);

  const params = { start_date: START, end_date: END };
  const [dailySleep, sleeps, dailyReadiness, dailyActivity, tags] = await Promise.all([
    ouraGet("daily_sleep",      token, params),
    ouraGet("sleep",            token, params),
    ouraGet("daily_readiness",  token, params),
    ouraGet("daily_activity",   token, params),
    ouraGet("enhanced_tag",     token, params).catch(() => []),
  ]);

  const byDay = new Map();
  const ensure = (day) => { if (!byDay.has(day)) byDay.set(day, { day }); return byDay.get(day); };

  for (const s of dailySleep) {
    const r = ensure(s.day);
    r.sleep_score = s.score ?? null;
    r.sleep_contributors = s.contributors ?? null;
  }

  const longestByDay = new Map();
  for (const sl of sleeps) {
    if (!sl.day) continue;
    const prev = longestByDay.get(sl.day);
    if (!prev || (sl.total_sleep_duration ?? 0) > (prev.total_sleep_duration ?? 0)) {
      longestByDay.set(sl.day, sl);
    }
  }
  for (const [day, sl] of longestByDay) {
    const r = ensure(day);
    r.total_sleep_s    = sl.total_sleep_duration ?? null;
    r.time_in_bed_s    = sl.time_in_bed ?? null;
    r.rem_sleep_s      = sl.rem_sleep_duration ?? null;
    r.deep_sleep_s     = sl.deep_sleep_duration ?? null;
    r.light_sleep_s    = sl.light_sleep_duration ?? null;
    r.awake_s          = sl.awake_time ?? null;
    r.avg_hrv          = sl.average_hrv ?? null;
    r.avg_hr           = sl.average_heart_rate ?? null;
    r.lowest_hr        = sl.lowest_heart_rate ?? null;
    r.latency_s        = sl.latency ?? null;
    r.efficiency       = sl.efficiency ?? null;
    r.restless_periods = sl.restless_periods ?? null;
  }

  for (const r of dailyReadiness) {
    const d = ensure(r.day);
    d.readiness_score        = r.score ?? null;
    d.temp_deviation_c       = r.temperature_deviation ?? null;
    d.temp_trend_dev_c       = r.temperature_trend_deviation ?? null;
    d.readiness_contributors = r.contributors ?? null;
  }

  for (const a of dailyActivity) {
    const d = ensure(a.day);
    d.activity_score    = a.score ?? null;
    d.steps             = a.steps ?? null;
    d.active_calories   = a.active_calories ?? null;
    d.total_calories    = a.total_calories ?? null;
    d.equiv_walking_m   = a.equivalent_walking_distance ?? null;
  }

  const tagsByDay = new Map();
  for (const t of tags) {
    if (!t.start_day) continue;
    const arr = tagsByDay.get(t.start_day) ?? [];
    arr.push({
      tag_type_code: t.tag_type_code ?? null,
      comment: t.comment ?? null,
      tags: t.tags ?? [],
    });
    tagsByDay.set(t.start_day, arr);
  }
  for (const [day, arr] of tagsByDay) ensure(day).tags = arr;

  const days = [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));

  const recent = days.slice(0, 7);
  const avg = (key) => {
    const vals = recent.map((d) => d[key]).filter((v) => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const summary = {
    days_count: days.length,
    avg7_sleep_score:   avg("sleep_score"),
    avg7_readiness:     avg("readiness_score"),
    avg7_hrv:           avg("avg_hrv"),
    avg7_lowest_hr:     avg("lowest_hr"),
    avg7_total_sleep_s: avg("total_sleep_s"),
  };

  const payload = { fetched_at: new Date().toISOString(), window: { start: START, end: END }, summary, days };
  await fs.mkdir(path.dirname(OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`✓ wrote ${days.length} days → ${OUT_PATH}`);
  if (summary.avg7_readiness)
    console.log(`  7-day avg: readiness ${summary.avg7_readiness.toFixed(0)} · sleep ${summary.avg7_sleep_score?.toFixed(0)} · hrv ${summary.avg7_hrv?.toFixed(0)} ms · rhr ${summary.avg7_lowest_hr?.toFixed(0)} bpm`);
}

main().catch((e) => { console.error("✗", e.message || e); process.exit(1); });
