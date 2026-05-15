/**
 * OAuth 2.0 device-authorization flow for @reidar80/webshelf-mcp.
 *
 * Reads/writes a credentials JSON file at:
 *   $WEBSHELF_CREDENTIALS_FILE  (when set)
 *   ~/.webshelf/credentials.json (otherwise)
 *
 * The credentials file contains the refresh + access tokens issued at
 * the end of the device flow. The MCP server consults it on every API
 * call and silently refreshes the access token when it's within 60s of
 * expiry (or when the server returns 401).
 *
 * Bare tokens never leave this file — they're returned only to the
 * fetch wrapper in `api.ts`.
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

interface Credentials {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when `accessToken` expires. */
  accessExpiresAtMs: number;
  /** epoch ms when `refreshToken` expires. */
  refreshExpiresAtMs: number;
  /** Base URL of the Webshelf instance these tokens belong to. */
  baseUrl: string;
}

const REFRESH_LEAD_TIME_MS = 60 * 1000;

function credentialsPath(): string {
  const explicit = process.env.WEBSHELF_CREDENTIALS_FILE;
  if (explicit) return explicit;
  return join(homedir(), ".webshelf", "credentials.json");
}

async function readCredentials(): Promise<Credentials | null> {
  try {
    const buf = await readFile(credentialsPath(), "utf8");
    const parsed = JSON.parse(buf);
    if (
      typeof parsed?.accessToken === "string" &&
      typeof parsed?.refreshToken === "string" &&
      typeof parsed?.accessExpiresAtMs === "number" &&
      typeof parsed?.refreshExpiresAtMs === "number" &&
      typeof parsed?.baseUrl === "string"
    ) {
      return parsed as Credentials;
    }
  } catch {
    return null;
  }
  return null;
}

async function writeCredentials(creds: Credentials): Promise<void> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(creds, null, 2), "utf8");
  // Try to lock down permissions to the current user. chmod is a no-op
  // on Windows but harmless.
  try {
    await chmod(path, 0o600);
  } catch {
    // ignore
  }
}

export interface DeviceFlowOptions {
  baseUrl: string;
  clientName: string;
  /** Print the user instructions / poll progress. Defaults to stderr. */
  log?: (line: string) => void;
}

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
}

/**
 * Run the OAuth device flow and persist the resulting tokens. Resolves
 * with the live credentials. Rejects if the user denies, the device
 * code expires, or the network breaks.
 */
export async function runDeviceFlow(
  options: DeviceFlowOptions,
): Promise<Credentials> {
  const log = options.log ?? ((line) => process.stderr.write(`${line}\n`));

  const start = await fetch(`${options.baseUrl}/api/oauth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: options.clientName }),
  });
  if (!start.ok) {
    throw new Error(
      `device authorization failed: HTTP ${start.status} ${await start.text()}`,
    );
  }
  const auth = (await start.json()) as DeviceAuthResponse;

  log("");
  log("┌─ Webshelf authorization ──────────────────────────────");
  log(`│ Open this URL in your browser:`);
  log(`│   ${auth.verification_uri_complete}`);
  log(`│`);
  log(`│ Or visit ${auth.verification_uri} and enter the code:`);
  log(`│   ${auth.user_code}`);
  log("└────────────────────────────────────────────────────────");
  log("");

  const deadline = Date.now() + auth.expires_in * 1000;
  let interval = auth.interval;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    const res = await fetch(`${options.baseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: auth.device_code,
      }),
    });
    if (res.ok) {
      const tokens = (await res.json()) as TokenResponse;
      const creds: Credentials = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        accessExpiresAtMs: Date.now() + tokens.expires_in * 1000,
        refreshExpiresAtMs:
          Date.now() + (tokens.refresh_expires_in ?? 30 * 24 * 60 * 60) * 1000,
        baseUrl: options.baseUrl,
      };
      await writeCredentials(creds);
      log("Authorization complete. Token stored.");
      return creds;
    }

    const body = (await res
      .json()
      .catch(() => ({ error: "unknown" }))) as {
      error?: string;
      error_description?: string;
    };
    if (body.error === "authorization_pending") {
      // keep polling
      continue;
    }
    if (body.error === "slow_down") {
      // RFC 8628 §3.5: bump the interval by 5s and keep polling.
      interval += 5;
      continue;
    }
    throw new Error(
      `device authorization rejected: ${body.error}${
        body.error_description ? ` (${body.error_description})` : ""
      }`,
    );
  }
  throw new Error("device code expired before user approval");
}

/**
 * Refresh an expired or near-expired access token. Returns the updated
 * credentials. Throws if the refresh token itself has expired or been
 * revoked — caller should re-run the device flow in that case.
 */
async function refreshAccessToken(creds: Credentials): Promise<Credentials> {
  const res = await fetch(`${creds.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `refresh failed: HTTP ${res.status} ${await res.text()}; re-run device flow`,
    );
  }
  const tokens = (await res.json()) as TokenResponse;
  const next: Credentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessExpiresAtMs: Date.now() + tokens.expires_in * 1000,
    refreshExpiresAtMs:
      Date.now() + (tokens.refresh_expires_in ?? 30 * 24 * 60 * 60) * 1000,
    baseUrl: creds.baseUrl,
  };
  await writeCredentials(next);
  return next;
}

/**
 * Return a live credentials object, refreshing if needed. Initiates the
 * device flow when no credentials are present on disk yet.
 */
export async function ensureCredentials(
  baseUrl: string,
  clientName: string,
): Promise<Credentials> {
  let creds = await readCredentials();
  if (!creds || creds.baseUrl !== baseUrl) {
    creds = await runDeviceFlow({ baseUrl, clientName });
  }
  if (creds.accessExpiresAtMs - Date.now() < REFRESH_LEAD_TIME_MS) {
    creds = await refreshAccessToken(creds);
  }
  return creds;
}

/** Force a refresh, used by the API client on 401. */
export async function forceRefresh(creds: Credentials): Promise<Credentials> {
  return refreshAccessToken(creds);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
