// Shared Google OAuth credential helpers.
//
// Client ID + secret come from env vars in ~/.keys (sourced by your shell):
//   GOOGLE_CAL_API_CLIENT_ID
//   GOOGLE_CAL_API_CLIENT_SECRET
//
// Tokens (access + refresh) are stored at ~/.config/google/tokens.json
// (separate from client creds since those live in ~/.keys).

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const CONFIG_DIR = path.join(os.homedir(), ".config", "google");
export const TOKENS_PATH = path.join(CONFIG_DIR, "tokens.json");

export const REDIRECT_URI = "http://localhost:5174/google-callback";

export function readEnvCredentials() {
  const clientId = process.env.GOOGLE_CAL_API_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CAL_API_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const msg = [
      "",
      "✗ Google credentials not in env.",
      "",
      "Expected env vars (likely in ~/.keys, sourced by your shell):",
      "  export GOOGLE_CAL_API_CLIENT_ID=...",
      "  export GOOGLE_CAL_API_CLIENT_SECRET=...",
      "",
      "Either source ~/.keys in this shell:  source ~/.keys",
      "Or pass them inline:                  GOOGLE_CAL_API_CLIENT_ID=… GOOGLE_CAL_API_CLIENT_SECRET=… npm run …",
      "",
      "If you don't have credentials yet:",
      "  1. Enable Calendar API: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
      "  2. Create OAuth 2.0 Client ID (Web app), redirect URI:",
      `       ${REDIRECT_URI}`,
      "  3. Add yourself as a Test user in the OAuth consent screen.",
      "",
    ].join("\n");
    throw new Error(msg);
  }
  return { clientId, clientSecret };
}

export async function loadTokens() {
  try { return JSON.parse(await fs.readFile(TOKENS_PATH, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw e; }
}

export async function saveTokens(tokens) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}
