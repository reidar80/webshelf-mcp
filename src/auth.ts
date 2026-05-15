/**
 * OAuth 2.0 device-authorization flow for @reidar80/webshelf-mcp.
 *
 * Reads/writes credentials JSON files at:
 *   $WEBSHELF_CREDENTIALS_FILE  (when set, base path)
 *   ~/.webshelf/credentials.json (otherwise)
 *
 * Two files are involved:
 *   • credentials.json — the live access + refresh tokens.
 *   • credentials.pending.json — an in-progress device flow (device_code +
 *     verification URL) waiting for the human to approve in their browser.
 *
 * Why a pending file: when the MCP server runs under a host like Claude
 * Desktop, stderr is captured to a log file the user never opens. If we
 * blocked the first tool call on a 10-minute polling loop (RFC 8628's
 * device-code TTL), the MCP client times out after a few minutes with a
 * "server unresponsive" error — and the user never sees the verification
 * URL printed to stderr. Instead, we fast-fail the first tool call with
 * the URL in the error message (which the MCP client surfaces verbatim
 * to the user). The user approves in their browser, retries any tool,
 * and the retry exchanges the device_code for tokens in one shot.
 *
 * Bare tokens never leave this module — they're returned only via the
 * `Credentials` object to the fetch wrapper in `api.ts`.
 */

import { mkdir, readFile, unlink, writeFile, chmod } from "node:fs/promises";
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

interface PendingDeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** epoch ms when the device_code stops being redeemable. */
  expiresAtMs: number;
  /** Base URL the device flow was started against. */
  baseUrl: string;
  /** Label the user picked when launching the flow. */
  clientName: string;
}

const REFRESH_LEAD_TIME_MS = 60 * 1000;

function credentialsPath(): string {
  const explicit = process.env.WEBSHELF_CREDENTIALS_FILE;
  if (explicit) return explicit;
  return join(homedir(), ".webshelf", "credentials.json");
}

function pendingPath(): string {
  return credentialsPath().replace(/\.json$/, ".pending.json");
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
  try {
    await chmod(path, 0o600);
  } catch {
    // chmod is a no-op on Windows but harmless.
  }
}

async function readPending(): Promise<PendingDeviceFlow | null> {
  try {
    const buf = await readFile(pendingPath(), "utf8");
    const parsed = JSON.parse(buf);
    if (
      typeof parsed?.deviceCode === "string" &&
      typeof parsed?.userCode === "string" &&
      typeof parsed?.verificationUri === "string" &&
      typeof parsed?.verificationUriComplete === "string" &&
      typeof parsed?.expiresAtMs === "number" &&
      typeof parsed?.baseUrl === "string" &&
      typeof parsed?.clientName === "string"
    ) {
      return parsed as PendingDeviceFlow;
    }
  } catch {
    return null;
  }
  return null;
}

async function writePending(pending: PendingDeviceFlow): Promise<void> {
  const path = pendingPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(pending, null, 2), "utf8");
  try {
    await chmod(path, 0o600);
  } catch {
    // ignore
  }
}

async function clearPending(): Promise<void> {
  try {
    await unlink(pendingPath());
  } catch {
    // already gone
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
 * Thrown when the caller has no credentials and must approve the device
 * flow in their browser. Carries the verification URL so the MCP client
 * can show it to the user verbatim. After approval, retrying any tool
 * resumes the flow via {@link tryCompletePending}.
 */
export class DeviceFlowPendingError extends Error {
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly userCode: string;
  readonly expiresAtMs: number;
  constructor(pending: PendingDeviceFlow) {
    super(
      [
        "Webshelf needs you to authorize this MCP server before it can act on your behalf.",
        "",
        `  1. Open: ${pending.verificationUriComplete}`,
        `     (or visit ${pending.verificationUri} and enter code ${pending.userCode})`,
        "  2. Approve in your browser.",
        "  3. Retry the tool call — it will complete automatically.",
      ].join("\n"),
    );
    this.name = "DeviceFlowPendingError";
    this.verificationUri = pending.verificationUri;
    this.verificationUriComplete = pending.verificationUriComplete;
    this.userCode = pending.userCode;
    this.expiresAtMs = pending.expiresAtMs;
  }
}

/**
 * Start a device flow and write the pending state. Returns the pending
 * record so the caller can decide whether to throw it as a user-visible
 * error or wait on it. Does NOT poll.
 */
async function startDeviceFlow(
  baseUrl: string,
  clientName: string,
): Promise<PendingDeviceFlow> {
  const start = await fetch(`${baseUrl}/api/oauth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: clientName }),
  });
  if (!start.ok) {
    throw new Error(
      `device authorization failed: HTTP ${start.status} ${await start.text()}`,
    );
  }
  const auth = (await start.json()) as DeviceAuthResponse;
  const pending: PendingDeviceFlow = {
    deviceCode: auth.device_code,
    userCode: auth.user_code,
    verificationUri: auth.verification_uri,
    verificationUriComplete: auth.verification_uri_complete,
    expiresAtMs: Date.now() + auth.expires_in * 1000,
    baseUrl,
    clientName,
  };
  await writePending(pending);

  // Best-effort stderr breadcrumb so headless runs (CLI tail -f) and host
  // log files contain the URL even when no tool has been called yet.
  process.stderr.write(
    `\nWebshelf authorization required.\n  Visit: ${pending.verificationUriComplete}\n  Code:  ${pending.userCode}\n\n`,
  );

  return pending;
}

/**
 * Attempt to redeem a pending device_code exactly once. Returns the new
 * credentials on success, null when the user hasn't approved yet, and
 * throws when the device code expired or the flow was rejected (in
 * which case the caller should restart).
 */
async function tryRedeemDeviceCode(
  pending: PendingDeviceFlow,
): Promise<Credentials | null> {
  const res = await fetch(`${pending.baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: pending.deviceCode,
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
      baseUrl: pending.baseUrl,
    };
    return creds;
  }
  const body = (await res.json().catch(() => ({ error: "unknown" }))) as {
    error?: string;
    error_description?: string;
  };
  if (body.error === "authorization_pending" || body.error === "slow_down") {
    return null;
  }
  // expired_token / access_denied / unknown — caller should drop pending
  // state and restart from scratch.
  throw new Error(
    `device authorization rejected: ${body.error ?? "unknown"}${
      body.error_description ? ` (${body.error_description})` : ""
    }`,
  );
}

/**
 * Refresh an expired or near-expired access token. Returns the updated
 * credentials. Throws if the refresh token itself has expired or been
 * revoked — caller should clear credentials and re-run the device flow.
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
 * Return live credentials or throw {@link DeviceFlowPendingError} when
 * the user needs to approve the flow first. Never blocks for more than a
 * single HTTP round trip — the long poll that would happen in a vanilla
 * device flow is replaced by "throw → user approves → retry → redeem".
 */
export async function ensureCredentials(
  baseUrl: string,
  clientName: string,
): Promise<Credentials> {
  // 1. Live credentials? Refresh if they're stale and return.
  const existing = await readCredentials();
  if (existing && existing.baseUrl === baseUrl) {
    if (existing.accessExpiresAtMs - Date.now() < REFRESH_LEAD_TIME_MS) {
      const refreshed = await refreshAccessToken(existing);
      await writeCredentials(refreshed);
      return refreshed;
    }
    return existing;
  }

  // 2. Pending flow? Try to complete it — but bounce out fast if not
  //    ready. The user might still be in the browser; better to surface
  //    the URL than to hold the MCP transport hostage.
  let pending = await readPending();
  if (pending && pending.baseUrl === baseUrl && pending.expiresAtMs > Date.now()) {
    try {
      const redeemed = await tryRedeemDeviceCode(pending);
      if (redeemed) {
        await writeCredentials(redeemed);
        await clearPending();
        return redeemed;
      }
    } catch (err) {
      // Device code expired or was denied — fall through to start a new one.
      await clearPending();
      pending = null;
      // Stick the failure on stderr so logs explain why we restarted.
      process.stderr.write(
        `[webshelf-mcp] pending device flow rejected (${
          err instanceof Error ? err.message : String(err)
        }); restarting.\n`,
      );
    }
    if (pending) throw new DeviceFlowPendingError(pending);
  }

  // 3. Nothing live or pending — kick off a new flow and bail out so the
  //    user can approve. Their next tool call lands in branch (2).
  if (pending && pending.expiresAtMs <= Date.now()) {
    await clearPending();
  }
  const fresh = await startDeviceFlow(baseUrl, clientName);
  throw new DeviceFlowPendingError(fresh);
}

/** Force a refresh, used by the API client on 401. */
export async function forceRefresh(creds: Credentials): Promise<Credentials> {
  return refreshAccessToken(creds);
}
