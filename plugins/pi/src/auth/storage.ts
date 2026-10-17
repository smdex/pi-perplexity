import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { StoredToken } from "../search/types.js";

const TOKEN_PATH = join(homedir(), ".config", "pi-perplexity", "auth.json");
/** Cookie jar written by the pplx CLI (`pplx login`) — richer credential than Bearer. */
const CLI_AUTH_PATH = join(homedir(), ".config", "pplx-cli", "auth.json");

export function tokenPath(): string {
  return TOKEN_PATH;
}

/** Where the pplx CLI keeps its cookie jar (checked, read-only, when the extension has no jar). */
export function cliAuthPath(): string {
  return process.env.PPLX_CONFIG_DIR
    ? join(process.env.PPLX_CONFIG_DIR, "auth.json")
    : CLI_AUTH_PATH;
}

/** Where the resolved credentials came from (surfaced in tool output meta). */
export type CredentialsSource = "cookies" | "token" | "otp";

function isStoredToken(value: unknown): value is StoredToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const hasAccess = typeof candidate.access === "string" && candidate.access.length > 0;
  const hasCookies = Array.isArray(candidate.cookies) && candidate.cookies.length > 0;
  return (
    candidate.type === "oauth" &&
    (hasAccess || hasCookies)
  );
}

interface CliAuthShape {
  kind?: unknown;
  cookies?: unknown;
  userAgent?: unknown;
  email?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Read the pplx CLI's cookie jar (~/.config/pplx-cli/auth.json, written by
 * `pplx login`). The CLI validates the jar against /api/auth/session at login
 * time, so anything stored there was live when saved. Returns null when the
 * file is missing or holds no cookie jar (kind "cookies" / "otp").
 */
export async function loadCliCookies(): Promise<{ cookies: string[]; userAgent?: string; email?: string } | null> {
  let raw: string;
  try {
    raw = await readFile(cliAuthPath(), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const auth = parsed as CliAuthShape;
  if (!Array.isArray(auth.cookies)) return null;
  const cookies = auth.cookies.filter(isNonEmptyString);
  // The session cookie is the actual credential — a jar without it is dead weight.
  if (!cookies.some((cookie) => cookie.startsWith("__Secure-next-auth.session-token="))) {
    return null;
  }
  return {
    cookies,
    ...(isNonEmptyString(auth.userAgent) ? { userAgent: auth.userAgent } : {}),
    ...(isNonEmptyString(auth.email) ? { email: auth.email } : {}),
  };
}

/** Load persisted token from ~/.config/pi-perplexity/auth.json. Returns null if missing or unreadable. */
export async function loadToken(): Promise<StoredToken | null> {
  try {
    const raw = await readFile(TOKEN_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredToken(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/**
 * Resolve the credential set for API calls, in priority order:
 *   1. stored extension token (Bearer + its own cookie jar when OTP login captured one),
 *   2. the pplx CLI's cookie jar (`pplx login` output — full browser cookies),
 *   3. the stored extension token alone (desktop-app borrow / old files).
 * Never throws: no credential at all → null (caller decides the auth error).
 */
export async function loadCredentials(): Promise<StoredToken | null> {
  const own = await loadToken();
  if (own) {
    if (own.cookies && own.cookies.length > 0) return own;
    // Old token file without a jar: try to enrich from the CLI jar (cookies beat Bearer).
    const cli = await loadCliCookies();
    if (cli) {
      return {
        ...own,
        cookies: cli.cookies,
        ...(cli.userAgent ? { userAgent: cli.userAgent } : {}),
        ...(cli.email && !own.email ? { email: cli.email } : {}),
      };
    }
    return own;
  }
  const cli = await loadCliCookies();
  if (cli) {
    return {
      type: "oauth",
      access: "",
      ...(cli.email ? { email: cli.email } : {}),
      cookies: cli.cookies,
      ...(cli.userAgent ? { userAgent: cli.userAgent } : {}),
    };
  }
  return null;
}

/** Save token to disk with 0600 permissions. Creates directory if needed. */
export async function saveToken(token: StoredToken): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, `${JSON.stringify(token, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // writeFile mode only applies on create; enforce on existing files too.
  await chmod(TOKEN_PATH, 0o600);
}

/** Delete the stored token file. No-op if missing. */
export async function clearToken(): Promise<void> {
  await rm(TOKEN_PATH, { force: true });
}
