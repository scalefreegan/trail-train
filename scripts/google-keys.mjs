// Shared Google OAuth credential helpers.
//
// Client ID + secret are read from (in priority order):
//   1. ~/.config/google/config.json  with shape:
//        { "clientId": "...", "clientSecret": "...", "redirectUri": "..." }
//   2. Env vars (typically exported in ~/.keys and sourced by your shell):
//        GOOGLE_CAL_API_CLIENT_ID
//        GOOGLE_CAL_API_CLIENT_SECRET
//
// OAuth tokens (access + refresh) are stored at ~/.config/google/tokens.json
// regardless of how the client creds were sourced.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "google");
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
export const TOKENS_PATH = path.join(CONFIG_DIR, "tokens.json");

export const REDIRECT_URI_DEFAULT = "http://localhost:5174/google-callback";

function readJsonConfig() {
  try {
    const raw = fsSync.readFileSync(CONFIG_PATH, "utf8");
    const cfg = JSON.parse(raw);
    if (cfg.clientId && cfg.clientSecret) {
      return {
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        redirectUri: cfg.redirectUri || REDIRECT_URI_DEFAULT,
        source: CONFIG_PATH,
      };
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return null;
}

export function readCredentials() {
  // 1) ~/.config/google/config.json
  const fromFile = readJsonConfig();
  if (fromFile) return fromFile;
  // 2) env vars (~/.keys etc.)
  const clientId = process.env.GOOGLE_CAL_API_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CAL_API_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return { clientId, clientSecret, redirectUri: REDIRECT_URI_DEFAULT, source: "env" };
  }
  throw new Error([
    "",
    "✗ Google credentials not found.",
    "",
    "Expected either:",
    `  · ${CONFIG_PATH} with { clientId, clientSecret, redirectUri }`,
    "  · env vars GOOGLE_CAL_API_CLIENT_ID / GOOGLE_CAL_API_CLIENT_SECRET (e.g. in ~/.keys)",
    "",
    "If you don't have credentials yet:",
    "  1. Enable Calendar API: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
    "  2. Create OAuth 2.0 Client ID (Web app), redirect URI:",
    `       ${REDIRECT_URI_DEFAULT}`,
    "  3. Add yourself as a Test user in the OAuth consent screen.",
    "",
  ].join("\n"));
}

// Backwards-compat alias
export const readEnvCredentials = readCredentials;
export const REDIRECT_URI = REDIRECT_URI_DEFAULT;

export async function loadTokens() {
  try { return JSON.parse(await fs.readFile(TOKENS_PATH, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}

export async function saveTokens(tokens) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}
