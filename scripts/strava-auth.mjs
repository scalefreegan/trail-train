// Shared Strava OAuth token handling. Extracted from sync-strava.mjs so both the
// activity sync and the altitude-stream sync (sync-streams.mjs) refresh and reuse
// the same token store instead of each rolling their own.
//
// Token store: ~/.config/strava-mcp/config.json (shared with strava-mcp).

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const CONFIG_PATH = path.join(os.homedir(), ".config", "strava-mcp", "config.json");

export async function loadConfig() {
  return JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
}

export async function saveConfig(cfg) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/**
 * Return a valid access token, refreshing (and persisting) it if it has expired
 * or is within 60 s of expiring. Throws if the refresh call fails.
 */
export async function ensureToken(cfg) {
  if (cfg.expiresAt && cfg.expiresAt * 1000 > Date.now() + 60_000) return cfg.accessToken;
  console.log("• refreshing strava token…");
  const r = await fetch("https://www.strava.com/api/v3/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: cfg.refreshToken,
    }),
  });
  if (!r.ok) throw new Error(`token refresh failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  cfg.accessToken = data.access_token;
  cfg.refreshToken = data.refresh_token;
  cfg.expiresAt = data.expires_at;
  await saveConfig(cfg);
  return cfg.accessToken;
}
