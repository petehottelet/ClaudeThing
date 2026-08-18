/**
 * Claude CLI OAuth credential access and refresh.
 *
 * Secrets stay in the CLI's own credential store. On macOS the complete JSON
 * document is read from and written back to Keychain; elsewhere the CLI's
 * credentials file is updated atomically with owner-only permissions. Secret
 * values are sent to `security` over stdin, never process arguments or logs.
 */

import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isObject, pickNumber } from "../util";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;

export interface OauthCredential {
  accessToken: string | null;
  /** Epoch ms when the access token expires, when known. */
  expiresAt: number | null;
  refreshToken: string | null;
  /** Epoch ms when the refresh token expires, when known. */
  refreshTokenExpiresAt: number | null;
  scopes: string[];
  /** True when a credential store exists at all (even if expired). */
  present: boolean;
}

export type CredentialReader = () => Promise<OauthCredential>;

export type CredentialRefreshResult =
  | { kind: "refreshed"; credential: OauthCredential }
  | { kind: "expired" }
  | { kind: "transient"; retryAfter: string | null };

export type CredentialRefresher = (
  credential: OauthCredential,
  fetchImpl: typeof fetch,
  nowMs: number,
  force?: boolean,
) => Promise<CredentialRefreshResult>;

interface CredentialStore {
  document: Record<string, unknown>;
  oauth: Record<string, unknown>;
  nested: boolean;
  location: { kind: "keychain"; account: string } | { kind: "file"; filePath: string };
}

const absent: OauthCredential = {
  accessToken: null,
  expiresAt: null,
  refreshToken: null,
  refreshTokenExpiresAt: null,
  scopes: [],
  present: false,
};

function execSecurity(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/security", args, { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

function keychainAccount(metadata: string | null): string {
  const match = metadata?.match(/"acct"<blob>="([^"\\]*(?:\\.[^"\\]*)*)"/);
  if (!match?.[1]) return os.userInfo().username;
  return match[1].replace(/\\([\\"])/g, "$1");
}

function credentialFilePath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

async function loadCredentialStore(explicitFilePath: string | null = null): Promise<CredentialStore | null> {
  let raw: string | null = null;
  let location: CredentialStore["location"] | null = null;

  if (explicitFilePath) {
    try {
      raw = (await readFile(explicitFilePath, "utf8")).trim();
      location = { kind: "file", filePath: explicitFilePath };
    } catch {
      return null;
    }
  } else if (process.platform === "darwin") {
    raw = await execSecurity(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
    if (raw !== null) {
      const metadata = await execSecurity(["find-generic-password", "-s", KEYCHAIN_SERVICE]);
      location = { kind: "keychain", account: keychainAccount(metadata) };
    }
  }

  if (raw === null) {
    const filePath = credentialFilePath();
    try {
      raw = (await readFile(filePath, "utf8")).trim();
      location = { kind: "file", filePath };
    } catch {
      return null;
    }
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed) || !location) return null;
    const nested = isObject(parsed.claudeAiOauth);
    const oauth = nested ? parsed.claudeAiOauth as Record<string, unknown> : parsed;
    return { document: parsed, oauth, nested, location };
  } catch {
    return null;
  }
}

function stringField(obj: Record<string, unknown>, name: string): string | null {
  const value = obj[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseScopes(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/\s+/)
      : [];
  return values.filter((scope): scope is string => typeof scope === "string" && scope.trim() !== "")
    .map((scope) => scope.trim());
}

function credentialFromStore(store: CredentialStore): OauthCredential {
  return {
    accessToken: stringField(store.oauth, "accessToken"),
    expiresAt: pickNumber(store.oauth, ["expiresAt"]),
    refreshToken: stringField(store.oauth, "refreshToken"),
    refreshTokenExpiresAt: pickNumber(store.oauth, ["refreshTokenExpiresAt"]),
    scopes: parseScopes(store.oauth.scopes),
    present: true,
  };
}

/** Read the CLI credential without exposing its raw document. Never throws. */
export async function readCliCredential(explicitFilePath: string | null = null): Promise<OauthCredential> {
  const store = await loadCredentialStore(explicitFilePath);
  return store ? credentialFromStore(store) : { ...absent };
}

async function writeKeychain(account: string, document: string): Promise<boolean> {
  // `security add-generic-password -w` truncates prompted input at 128 bytes,
  // while this JSON document is considerably larger. JXA is available on
  // macOS and can call SecItemUpdate directly with NSData read from stdin.
  // The generated script contains only the non-secret account/service query.
  const script = `
ObjC.import("Foundation");
ObjC.import("Security");
const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const query = $.NSMutableDictionary.alloc.init;
query.setObjectForKey($("genp"), $("class"));
query.setObjectForKey($(${JSON.stringify(KEYCHAIN_SERVICE)}), $("svce"));
query.setObjectForKey($(${JSON.stringify(account)}), $("acct"));
const update = $.NSMutableDictionary.alloc.init;
update.setObjectForKey(data, $("v_Data"));
const status = $.SecItemUpdate(query, update);
if (status !== 0) throw new Error("Keychain update failed");
`;
  return new Promise((resolve) => {
    const child = spawn(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const timer = setTimeout(() => child.kill(), 15_000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin.end(document);
  });
}

async function writeCredentialStore(store: CredentialStore): Promise<boolean> {
  const serialized = JSON.stringify(store.document);
  if (store.location.kind === "keychain") {
    return writeKeychain(store.location.account, serialized);
  }
  const { filePath } = store.location;
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    await writeFile(tmp, serialized, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

function positiveSeconds(value: unknown): number | null {
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Refresh an expired/near-expiry CLI token and persist the rotated credential.
 * Provider/network errors are deliberately reduced to non-secret status.
 */
export async function refreshCliCredential(
  _credential: OauthCredential,
  fetchImpl: typeof fetch,
  nowMs: number,
  force = false,
  explicitFilePath: string | null = null,
): Promise<CredentialRefreshResult> {
  // Re-read at refresh time so a simultaneous CLI refresh always wins.
  const store = await loadCredentialStore(explicitFilePath);
  if (!store) return { kind: "expired" };
  const current = credentialFromStore(store);
  if (
    !force &&
    current.accessToken &&
    (current.expiresAt === null || current.expiresAt > nowMs + CLAUDE_TOKEN_REFRESH_WINDOW_MS)
  ) {
    return { kind: "refreshed", credential: current };
  }
  if (
    !current.refreshToken ||
    (current.refreshTokenExpiresAt !== null && current.refreshTokenExpiresAt <= nowMs)
  ) {
    return { kind: "expired" };
  }

  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: CLIENT_ID,
        ...(current.scopes.length > 0 ? { scope: current.scopes.join(" ") } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { kind: "transient", retryAfter: null };
  }

  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return { kind: "expired" };
  }
  if (!response.ok) {
    return { kind: "transient", retryAfter: response.headers.get("retry-after") };
  }

  const body: unknown = await response.json().catch(() => null);
  if (!isObject(body)) return { kind: "transient", retryAfter: null };
  const accessToken = stringField(body, "access_token");
  const expiresIn = positiveSeconds(body.expires_in);
  if (!accessToken || expiresIn === null) return { kind: "transient", retryAfter: null };

  const rotatedRefreshToken = stringField(body, "refresh_token") ?? current.refreshToken;
  const refreshExpiresIn = positiveSeconds(body.refresh_token_expires_in);
  const responseScopes = parseScopes(body.scope);
  const nextOauth: Record<string, unknown> = {
    ...store.oauth,
    accessToken,
    expiresAt: nowMs + expiresIn * 1000,
    refreshToken: rotatedRefreshToken,
    scopes: responseScopes.length > 0 ? responseScopes : current.scopes,
  };
  if (refreshExpiresIn !== null) {
    nextOauth.refreshTokenExpiresAt = nowMs + refreshExpiresIn * 1000;
  }
  if (store.nested) store.document.claudeAiOauth = nextOauth;
  else store.document = nextOauth;
  store.oauth = nextOauth;

  if (!(await writeCredentialStore(store))) {
    return { kind: "transient", retryAfter: null };
  }
  return { kind: "refreshed", credential: credentialFromStore(store) };
}
