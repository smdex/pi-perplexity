import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AuthError, type StoredToken } from "../search/types.js";
import { errorMessage } from "../util.js";
import { loadCredentials, loadToken, saveToken, type CredentialsSource } from "./storage.js";
import {
  BROWSER_AUTH_HELP,
  browserAuthFailureMessage,
  extractSessionTokenFromCookieHeader,
  parseBrowserAuthInput,
} from "./browser.js";
import { PERPLEXITY_USER_AGENT, PERPLEXITY_API_VERSION } from "../constants.js";
import {
  perplexityFetchText as fetchAuth,
  type PerplexityFetchResponse as AuthFetchResponse,
} from "../perplexity-fetch.js";

const DESKTOP_AUTH_HELP =
  "Install the Perplexity desktop app and sign in, or set PI_AUTH_NO_BORROW=1 to skip desktop token borrowing.";
const OTP_AUTH_HELP =
  "Provide credentials via PI_PERPLEXITY_EMAIL and PI_PERPLEXITY_OTP, or run interactively to enter email and OTP.";
const AUTH_BASE_URL = "https://www.perplexity.ai/api/auth";
const TOKEN_ENV_KEYS = ["PI_PERPLEXITY_TOKEN", "PI_PERPLEXITY_AUTH_TOKEN"] as const;
const COOKIE_ENV_KEYS = ["PI_PERPLEXITY_COOKIE", "PI_PERPLEXITY_COOKIES"] as const;

const execFileAsync = promisify(execFile);

export interface AuthenticateOptions {
  signal?: AbortSignal;
  promptForEmail?: () => Promise<string | null | undefined>;
  promptForOtp?: (email: string) => Promise<string | null | undefined>;
}

/** Resolved credentials: Bearer JWT + optional cookie jar + the UA the cookies were issued for. */
export interface AuthCredentials {
  jwt: string;
  cookies: string[];
  userAgent: string | null;
  email: string | null;
  source: CredentialsSource;
}

export interface EmailOtpLoginSession {
  email: string;
  csrfToken: string;
  cookieHeader?: string;
}

function normalizeInput(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function stripBearerPrefix(value: string): string {
  return value.replace(/^Bearer\s+/i, "").trim();
}

function credentialsFromTokenValue(value: string): StoredToken | null {
  const token = normalizeInput(stripBearerPrefix(value));
  return token ? { type: "oauth", access: token } : null;
}

function credentialsFromEnvironment(): StoredToken | null {
  for (const key of TOKEN_ENV_KEYS) {
    const value = normalizeInput(process.env[key]);
    if (value) {
      return credentialsFromTokenValue(value);
    }
  }

  for (const key of COOKIE_ENV_KEYS) {
    const value = normalizeInput(process.env[key]);
    if (value) {
      const credentials = parseBrowserAuthInput(value);
      if (!credentials) {
        throw new AuthError(
          "NO_TOKEN",
          `${key} is set but does not contain a signed-in Perplexity browser cookie. ${browserAuthFailureMessage(value)}`,
        );
      }
      return credentials;
    }
  }

  return null;
}

export async function saveBrowserAuthInput(input: string): Promise<StoredToken> {
  const credentials = parseBrowserAuthInput(input);
  if (!credentials) {
    throw new AuthError("NO_TOKEN", browserAuthFailureMessage(input));
  }

  await saveToken(credentials);
  return credentials;
}

/** Headers Chrome would send on /api/auth/* — missing Origin/Referer/Sec-Fetch-*
 * is the most likely reason a 200 OTP verification returns no session cookie. */
function buildAuthHeaders(includeJsonContentType = false): Record<string, string> {
  return {
    Accept: "application/json",
    Origin: "https://www.perplexity.ai",
    Referer: "https://www.perplexity.ai/",
    "User-Agent": PERPLEXITY_USER_AGENT,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "X-App-ApiVersion": PERPLEXITY_API_VERSION,
    ...(includeJsonContentType ? { "Content-Type": "application/json" } : {}),
  };
}

function parseJsonResponse(action: string, response: AuthFetchResponse): unknown {
  try {
    return JSON.parse(response.bodyText) as unknown;
  } catch (error) {
    throw new Error(`${action} returned invalid JSON: ${errorMessage(error)}`);
  }
}

function formatHttpFailure(action: string, response: AuthFetchResponse): string {
  const bodyPreview = response.bodyText.trim().replace(/\s+/g, " ").slice(0, 160);
  const suffix = bodyPreview ? `: ${bodyPreview}` : "";
  return `${action} (HTTP ${response.status}${suffix}).`;
}

function isBrowserChallengeResponse(response: AuthFetchResponse): boolean {
  const body = response.bodyText.toLowerCase();
  return (
    body.includes("just a moment") ||
    body.includes("enable javascript and cookies") ||
    body.includes("_cf_chl_opt") ||
    body.includes("cdn-cgi/challenge-platform") ||
    body.includes("cf-browser-verification")
  );
}

function throwHttpFailure(action: string, response: AuthFetchResponse): never {
  const failure = formatHttpFailure(action, response);
  if (isBrowserChallengeResponse(response)) {
    throw new Error(`${failure} Perplexity returned a browser challenge that Node fetch cannot solve.`);
  }

  throw new Error(failure);
}

function cookieHeaderFrom(cookies: string[]): string {
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function extractTokenFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const obj = payload as Record<string, unknown>;
  for (const key of ["token", "accessToken", "jwt", "access_token"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function getCookieHeader(response: AuthFetchResponse): string | null {
  return cookieHeaderFrom(response.cookies) || null;
}

/** Distinct name=value pairs accumulated across responses (later Set-Cookie wins per name). */
function collectCookies(existing: string[], response: AuthFetchResponse): string[] {
  const byName = new Map<string, string>();
  for (const cookie of existing) {
    byName.set(cookie.slice(0, cookie.indexOf("=")), cookie);
  }
  for (const setCookie of response.cookies) {
    const pair = setCookie.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    byName.set(pair.slice(0, eq), pair);
  }
  return [...byName.values()];
}

export async function beginEmailOtpLogin(
  email: string,
  options: Pick<AuthenticateOptions, "signal"> = {},
): Promise<EmailOtpLoginSession> {
  const normalizedEmail = normalizeInput(email);
  if (!normalizedEmail) {
    throw new Error("Email is required to start Perplexity OTP login.");
  }

  const signal = options.signal ?? null;

  const csrfResponse = await fetchAuth(`${AUTH_BASE_URL}/csrf`, {
    method: "GET",
    headers: buildAuthHeaders(),
    signal,
  });

  if (!csrfResponse.ok) {
    throwHttpFailure("Failed to fetch CSRF token", csrfResponse);
  }

  const csrfPayload = parseJsonResponse("CSRF token response", csrfResponse);
  const csrfToken =
    csrfPayload && typeof csrfPayload === "object" && !Array.isArray(csrfPayload)
      ? (csrfPayload as Record<string, unknown>).csrfToken
      : null;

  if (typeof csrfToken !== "string") {
    throw new Error("CSRF token missing from Perplexity auth response.");
  }

  const cookieHeader = getCookieHeader(csrfResponse);
  if (!cookieHeader) {
    throw new Error(
      "Perplexity auth response did not include Set-Cookie headers required for OTP login.",
    );
  }

  const emailHeaders = buildAuthHeaders(true);
  if (cookieHeader) {
    emailHeaders.Cookie = cookieHeader;
  }

  const emailResponse = await fetchAuth(`${AUTH_BASE_URL}/signin-email`, {
    method: "POST",
    headers: emailHeaders,
    body: JSON.stringify({ email: normalizedEmail, csrfToken }),
    signal,
  });

  if (!emailResponse.ok) {
    throwHttpFailure("Failed to send OTP email", emailResponse);
  }

  return {
    email: normalizedEmail,
    csrfToken,
    ...(cookieHeader ? { cookieHeader } : {}),
  };
}

/**
 * Verify the OTP. Returns the Bearer token from the body when present plus every
 * cookie the exchange set (the session cookie may arrive as Set-Cookie instead —
 * observed behavior differs between clients). Throws only when NEITHER is returned.
 */
export async function completeEmailOtpLogin(
  session: EmailOtpLoginSession,
  otp: string,
  options: Pick<AuthenticateOptions, "signal"> = {},
): Promise<{ token: string | null; cookies: string[] }> {
  const normalizedOtp = normalizeInput(otp);
  if (!normalizedOtp) {
    throw new Error("OTP code is required to complete Perplexity login.");
  }

  const signal = options.signal ?? null;
  const otpHeaders = buildAuthHeaders(true);
  if (session.cookieHeader) {
    otpHeaders.Cookie = session.cookieHeader;
  }


  const otpResponse = await fetchAuth(`${AUTH_BASE_URL}/signin-otp`, {
    method: "POST",
    headers: otpHeaders,
    body: JSON.stringify({ email: session.email, otp: normalizedOtp, csrfToken: session.csrfToken }),
    signal,
  });

  if (!otpResponse.ok) {
    throwHttpFailure("OTP verification failed", otpResponse);
  }

  const otpPayload = parseJsonResponse("OTP verification response", otpResponse);
  const token = extractTokenFromPayload(otpPayload);
  const cookies = collectCookies(
    (session.cookieHeader ?? "").split("; ").filter((pair) => pair.includes("=")),
    otpResponse,
  );

  if (!token && !cookies.some((cookie) => cookie.startsWith("__Secure-next-auth.session-token="))) {
    throw new Error("Perplexity OTP response included neither a token nor a session cookie.");
  }

  return { token, cookies };
}

async function loginWithEmailOtp(
  email: string,
  options: AuthenticateOptions,
): Promise<{ token: string | null; cookies: string[] }> {
  const session = await beginEmailOtpLogin(email, options);

  const otp =
    normalizeInput(process.env.PI_PERPLEXITY_OTP) ??
    normalizeInput(await options.promptForOtp?.(session.email));

  if (!otp) {
    throw new AuthError(
      "NO_TOKEN",
      `OTP code is required to complete Perplexity login. ${OTP_AUTH_HELP}`,
    );
  }

  return completeEmailOtpLogin(session, otp, options);
}

/** Extract JWT from macOS Perplexity desktop app via `defaults read`. Returns null if app not installed or not logged in. */
export async function extractFromDesktopApp(): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("defaults", ["read", "ai.perplexity.mac", "authToken"]);
    const token = normalizeInput(stdout);
    if (!token || token === "(null)") {
      return null;
    }

    return token;
  } catch {
    return null;
  }
}

/**
 * Run the auth strategy and return the full credential set (never just a JWT):
 *   1. stored credentials (extension token file, enriched with the pplx CLI jar),
 *   2. desktop-app token borrow (macOS),
 *   3. email OTP — saves the cookie jar captured during the exchange.
 */
export async function authenticate(options: AuthenticateOptions = {}): Promise<AuthCredentials> {
  const cached = await loadCredentials();
  if (cached) {
    return {
      jwt: cached.access ?? "",
      cookies: cached.cookies ?? [],
      userAgent: cached.userAgent ?? null,
      email: cached.email ?? null,
      source: cached.cookies && cached.cookies.length > 0 ? "cookies" : "token",
    };
  }

  const envCredentials = credentialsFromEnvironment();
  if (envCredentials) {
    await saveToken(envCredentials);
    return {
      jwt: envCredentials.access ?? "",
      cookies: envCredentials.cookies ?? [],
      userAgent: envCredentials.userAgent ?? null,
      email: envCredentials.email ?? null,
      source: envCredentials.cookies && envCredentials.cookies.length > 0 ? "cookies" : "token",
    };
  }

  const borrowDisabled = process.env.PI_AUTH_NO_BORROW === "1";
  if (!borrowDisabled) {
    const desktopToken = await extractFromDesktopApp();
    if (desktopToken) {
      await saveToken({ type: "oauth", access: desktopToken });
      return { jwt: desktopToken, cookies: [], userAgent: null, email: null, source: "token" };
    }
  }

  const email =
    normalizeInput(process.env.PI_PERPLEXITY_EMAIL) ??
    normalizeInput(await options.promptForEmail?.());
  if (!email) {
    throw new AuthError(
      "NO_TOKEN",
      `Could not find a desktop token, browser token/cookie, or email for OTP fallback. ${DESKTOP_AUTH_HELP} ${OTP_AUTH_HELP} ${BROWSER_AUTH_HELP}`,
    );
  }

  let otpResult: { token: string | null; cookies: string[] };

  try {
    otpResult = await loginWithEmailOtp(email, options);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }

    throw new AuthError(
      "EXTRACTION_FAILED",
      `Email OTP authentication failed: ${errorMessage(error)}. ${OTP_AUTH_HELP} ${BROWSER_AUTH_HELP}`,
    );
  }

  const credentials: StoredToken = {
    type: "oauth",
    access: otpResult.token ?? "",
    email,
  };
  if (otpResult.cookies.length > 0) {
    credentials.cookies = otpResult.cookies;
  }
  await saveToken(credentials);
  return {
    jwt: otpResult.token ?? "",
    cookies: otpResult.cookies,
    userAgent: null, // OTP ran under the CLI-style UA; no browser UA was captured
    email,
    source: "otp",
  };
}

/** Force-refresh helper used by /perplexity-login --force: forget everything, re-auth. */
export async function hasStoredToken(): Promise<boolean> {
  return (await loadToken()) !== null;
}
