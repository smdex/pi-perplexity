import { API_VERSION, ORIGIN, USER_AGENT } from "../constants.js";
import { SESSION_COOKIE_NAME } from "./cookies.js";
import { cookieHeader, saveAuth, upsertCookie, type StoredAuth } from "../config.js";

/**
 * Email-OTP login, ported from ../src/auth/login.ts (the pi extension). The CLI
 * additionally captures the Set-Cookie jar — cookie auth is the primary path
 * (contract §0/§A); the JSON bearer token is stored but unused by default.
 */

export interface OtpSession {
  email: string;
  csrfToken: string;
  cookies: string[];
}

export interface SessionInfo {
  accountUuid: string | null;
  email: string | null;
  expires: string | null;
  paymentTier: string | null;
}

const AUTH_BASE = `${ORIGIN}/api/auth`;

function normalizeInput(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Headers Chrome would send on /api/auth/* — deviations (missing Origin/Referer,
 *  bot-ish UA) are the most likely reason a succeeded OTP verification returns
 *  no Set-Cookie session. `userAgent` overrides when a captured one is available. */
function buildAuthHeaders(includeJsonContentType = false, userAgent?: string): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": userAgent ?? USER_AGENT,
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "x-app-apiversion": API_VERSION,
    ...(includeJsonContentType ? { "Content-Type": "application/json" } : {}),
  };
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

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** GET /api/auth/session with the given jar. Body {} (logged out) → null. */
export async function fetchSessionInfo(cookies: string[], signal?: AbortSignal, userAgent?: string): Promise<SessionInfo | null> {
  const response = await fetch(`${AUTH_BASE}/session`, {
    headers: { ...buildAuthHeaders(false, userAgent), Cookie: cookieHeader(cookies) },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`Session check failed (HTTP ${response.status}).`);
  }
  const payload = await readJsonResponse(response);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const user = (payload as Record<string, unknown>).user;
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const u = user as Record<string, unknown>;
  return {
    accountUuid: nonEmptyString(u.id),
    email: nonEmptyString(u.email),
    expires: nonEmptyString((payload as Record<string, unknown>).expires),
    paymentTier: nonEmptyString(u.payment_tier),
  };
}

/** Step 1+2: fetch CSRF, send the OTP email. 2xx = OTP sent. */
export async function beginOtpLogin(email: string, signal?: AbortSignal): Promise<OtpSession> {
  const normalizedEmail = normalizeInput(email);
  if (!normalizedEmail) {
    throw new Error("Email is required to start Perplexity OTP login.");
  }

  const csrfResponse = await fetch(`${AUTH_BASE}/csrf`, {
    headers: buildAuthHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!csrfResponse.ok) {
    throw new Error(`Failed to fetch CSRF token (HTTP ${csrfResponse.status}).`);
  }
  const csrfPayload = (await readJsonResponse(csrfResponse)) as { csrfToken?: unknown } | null;
  const csrfToken =
    csrfPayload && typeof csrfPayload.csrfToken === "string" && csrfPayload.csrfToken.length > 0
      ? csrfPayload.csrfToken
      : null;
  if (!csrfToken) {
    throw new Error("CSRF token missing from Perplexity auth response.");
  }
  const cookies = upsertCookie([], csrfResponse.headers.getSetCookie?.() ?? []);

  const emailResponse = await fetch(`${AUTH_BASE}/signin-email`, {
    method: "POST",
    headers: { ...buildAuthHeaders(true), Cookie: cookieHeader(cookies) },
    body: JSON.stringify({ email: normalizedEmail, csrfToken }),
    ...(signal ? { signal } : {}),
  });
  if (!emailResponse.ok) {
    throw new Error(`Failed to send OTP email (HTTP ${emailResponse.status}).`);
  }

  return {
    email: normalizedEmail,
    csrfToken,
    cookies: upsertCookie(cookies, emailResponse.headers.getSetCookie?.() ?? []),
  };
}

/** Step 3: verify the OTP; capture the session cookie jar and resolve the account profile.
 *
 * The server may deliver the session in any of three ways (observed across clients):
 *  1. Set-Cookie `__Secure-next-auth.session-token` on this response (classic),
 *  2. a 302 to /api/auth/session (or similar) that DOES set the cookie — followed here,
 *  3. JSON body `{token: …}` only, no Set-Cookie — the JWT becomes a Bearer credential
 *     (the same token the pi extension uses successfully against /rest/sse/*).
 */
export async function completeOtpLogin(session: OtpSession, otp: string, signal?: AbortSignal): Promise<StoredAuth> {
  const normalizedOtp = normalizeInput(otp);
  if (!normalizedOtp) {
    throw new Error("OTP code is required to complete Perplexity login.");
  }

  const otpResponse = await fetch(`${AUTH_BASE}/signin-otp`, {
    method: "POST",
    headers: { ...buildAuthHeaders(true), Cookie: cookieHeader(session.cookies) },
    body: JSON.stringify({ email: session.email, otp: normalizedOtp, csrfToken: session.csrfToken }),
    redirect: "manual", // a 30x here carries the session Set-Cookie — capture it, don't auto-follow
    ...(signal ? { signal } : {}),
  });
  if (!otpResponse.ok) {
    const detail = await otpResponse.text().catch(() => "");
    const reason = detail.match(/"text"\s*:\s*"([^"]*)"/)?.[1];
    throw new Error(`OTP verification failed (HTTP ${otpResponse.status})${reason ? `: ${reason}` : "."}`);
  }

  // The session cookie jar is the real credential (contract §A).
  let cookies = upsertCookie(session.cookies, otpResponse.headers.getSetCookie?.() ?? []);

  // 30x: follow manually and harvest Set-Cookie from the redirect hop(s).
  const location = otpResponse.headers.get("location");
  if (location) {
    const next = new URL(location, AUTH_BASE).href;
    const followed = await fetch(next, {
      headers: { ...buildAuthHeaders(), Cookie: cookieHeader(cookies) },
      redirect: "manual",
      ...(signal ? { signal } : {}),
    });
    cookies = upsertCookie(cookies, followed.headers.getSetCookie?.() ?? []);
  }

  const bearerToken = extractTokenFromPayload(await readJsonResponse(otpResponse));

  const hasSession = cookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!hasSession && !bearerToken) {
    throw new Error(
      "OTP login succeeded but the response included neither a session cookie nor a bearer token — login failed.",
    );
  }

  // Session check (cookie credential preferred). Without a session cookie we cannot
  // resolve the account profile here — the next authenticated call resolves it.
  const info = hasSession ? await fetchSessionInfo(cookies, signal).catch(() => null) : null;
  if (hasSession && !info) {
    throw new Error("Login failed — session check returned no active session.");
  }

  return {
    kind: "cookies",
    cookies,
    accountUuid: info?.accountUuid ?? null,
    sessionExpires: info?.expires ?? null,
    email: info?.email ?? session.email,
    bearerToken,
    source: "otp",
    createdAt: new Date().toISOString(),
  };
}

/** Full interactive OTP login. Precedence: explicit opts (CLI --email/--otp) →
 * PPLX_EMAIL/PPLX_OTP env → prompts. Saves before returning. */
export async function loginInteractive(
  io: {
    promptEmail: () => Promise<string>;
    promptOtp: (email: string) => Promise<string>;
  },
  signal?: AbortSignal,
  opts?: { email?: string; otp?: string },
): Promise<StoredAuth> {
  const email =
    normalizeInput(opts?.email) ?? normalizeInput(process.env.PPLX_EMAIL) ?? normalizeInput(await io.promptEmail());
  if (!email) {
    throw new Error("Email is required for OTP login.");
  }

  const session = await beginOtpLogin(email, signal);

  const otp =
    normalizeInput(opts?.otp) ?? normalizeInput(process.env.PPLX_OTP) ?? normalizeInput(await io.promptOtp(session.email));
  if (!otp) {
    throw new Error("OTP code is required to complete Perplexity login.");
  }

  const auth = await completeOtpLogin(session, otp, signal);
  await saveAuth(auth);
  return auth;
}
