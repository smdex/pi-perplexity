import { API_VERSION, LOGIN_HELP, ORIGIN, USER_AGENT } from "../constants.js";
import { parsePastedCookies } from "../auth/cookies.js";
import { clearAuth, cookieHeader, loadAuth, saveAuth, upsertCookie, type StoredAuth } from "../config.js";

/**
 * Transport for the reverse-engineered Perplexity web API (contract §0).
 * Auth = session cookies (no Bearer). Every `/rest/*` GET/POST carries
 * `?version=2.18&source=default` EXCEPT the SSE endpoints and graphql, which
 * were captured without query params — use `apiUrl()` for those.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** No stored cookies (or session revoked server-side) → user must `pplx login`. */
export class AuthRequiredError extends Error {
  constructor(message = "Not logged in. " + LOGIN_HELP) {
    super(message);
    this.name = "AuthRequiredError";
  }
}

export interface RequestContext {
  cookieHeader: string;
  accountUuid: string | null;
  /** Resolved User-Agent (stored captured UA > env > default). */
  userAgent: string;
}

/**
 * URL for plain endpoints captured WITHOUT `?version=2.18&source=default`:
 * graphql, ask, subscribe SSE — VERIFIED in research/network/c-trace.json, where
 * the same session calls `POST /rest/sse/perplexity_ask`, `POST
 * /rest/perplexity_ask/graphql` and `POST /rest/sse/attachment_processing/subscribe`
 * with NO query params while sibling calls (e.g. `batch_create_upload_urls?version=2.18&source=default`)
 * DO carry them. Do not add params here without a fresh capture.
 */
export function apiUrl(path: string): string {
  return ORIGIN + path;
}

/** URL for `/rest/*` endpoints — always merges version=API_VERSION & source=default into the query. */
export function restUrl(path: string, query?: Record<string, string | number | boolean>): string {
  const merged = new URLSearchParams({ version: API_VERSION, source: "default" });
  for (const [key, value] of Object.entries(query ?? {})) {
    merged.set(key, String(value));
  }
  const qs = merged.toString();
  return ORIGIN + path + (qs ? `?${qs}` : "");
}

/** PPLX_COOKIE env (raw header) beats the stored jar (plan §5.4). */
export function effectiveCookieHeader(auth: StoredAuth | null): string {
  const override = process.env.PPLX_COOKIE?.trim();
  if (override) return override;
  return auth ? cookieHeader(auth.cookies) : "";
}

/**
 * User-Agent precedence: PPLX_USER_AGENT env > stored captured UA (from a curl/
 * headers paste — cf_clearance/__cf_bm are bound to the UA they were issued for)
 * > the CLI default.
 */
export function effectiveUserAgent(auth: StoredAuth | null): string {
  const override = process.env.PPLX_USER_AGENT?.trim();
  if (override) return override;
  return auth?.userAgent?.trim() || USER_AGENT;
}

/** Account uuids resolved from PPLX_COOKIE overrides — fetched at most once per
 *  distinct cookie value per process (the override may change mid-process). */
const envCookieAccounts = new Map<string, string>();

function baseHeaders(
  rc: RequestContext,
  extra?: Record<string, string>,
  opts?: { omitApiClientHeaders?: boolean },
): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": rc.userAgent,
    Cookie: rc.cookieHeader,
    "x-request-id": crypto.randomUUID(),
    ...(opts?.omitApiClientHeaders
      ? {}
      : { "x-app-apiclient": "default", "x-app-apiversion": API_VERSION }),
    ...(rc.accountUuid ? { "x-pplx-account": rc.accountUuid } : {}),
    ...(extra ?? {}),
  };
}

export { baseHeaders };

/** Rotate the stored jar from a response's Set-Cookie (contract §I.9). Fire-and-forget. */
async function rotateJar(setCookies: string[]): Promise<void> {
  if (setCookies.length === 0 || process.env.PPLX_COOKIE) return;
  try {
    const auth = await loadAuth();
    if (!auth) return;
    const next = upsertCookie(auth.cookies, setCookies);
    if (next.length !== auth.cookies.length || next.some((c, i) => c !== auth.cookies[i])) {
      await saveAuth({ ...auth, cookies: next });
    }
  } catch {
    // cookie rotation is best-effort; never fail a request over it
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve the request credential (plan §5.4 priority): PPLX_COOKIE env first — it is
 * a complete credential on its own and needs NO persisted auth (its account uuid is
 * resolved via /api/auth/session, cached per process) — then the stored jar.
 * Throws AuthRequiredError when neither yields a Cookie header.
 */
export async function requestContext(signal?: AbortSignal | undefined): Promise<RequestContext> {
  const override = process.env.PPLX_COOKIE?.trim();
  if (override) {
    const { cookies, userAgent: overrideUa } = parsePastedCookies(override); // tolerates a leading "Cookie:" prefix or a full curl command
    if (cookies.length === 0) {
      throw new AuthRequiredError("PPLX_COOKIE is set but contains no parseable name=value pairs.");
    }
    const header = cookieHeader(cookies);
    let accountUuid = envCookieAccounts.get(header) ?? null;
    if (accountUuid === null) {
      const { fetchSessionInfo } = await import("../auth/otp.js");
      const info = await fetchSessionInfo(cookies, signal, overrideUa ?? undefined).catch(() => null);
      // Only cache successful resolution — a transient network failure retries next call.
      accountUuid = info?.accountUuid ?? null;
      if (accountUuid) envCookieAccounts.set(header, accountUuid);
    }
    return {
      cookieHeader: header,
      accountUuid,
      userAgent: process.env.PPLX_USER_AGENT?.trim() || overrideUa || USER_AGENT,
    };
  }
  const auth = await loadAuth();
  if (!auth) throw new AuthRequiredError();
  const header = cookieHeader(auth.cookies);
  if (!header) throw new AuthRequiredError();
  if (auth.accountUuid) {
    return { cookieHeader: header, accountUuid: auth.accountUuid, userAgent: effectiveUserAgent(auth) };
  }
  // account uuid unknown → resolve + persist (fetchSessionInfo is a direct fetch, no recursion)
  const { fetchSessionInfo } = await import("../auth/otp.js");
  const info = await fetchSessionInfo(auth.cookies, signal).catch(() => null);
  const accountUuid = info ? nonEmpty(info.accountUuid) : null;
  if (accountUuid) {
    void saveAuth({
      ...auth,
      accountUuid,
      ...(info?.email ? { email: info.email } : {}),
      ...(info?.expires ? { sessionExpires: info.expires } : {}),
    }).catch(() => {});
  }
  return { cookieHeader: header, accountUuid, userAgent: effectiveUserAgent(auth) };
}

export interface Session {
  accountUuid: string | null;
  email: string | null;
  expires: string | null;
  paymentTier: string | null;
}

/** GET /api/auth/session (no version params). Body {} → logged-out Session (nulls). */
export async function getSession(signal?: AbortSignal | undefined): Promise<Session> {
  const { fetchSessionInfo } = await import("../auth/otp.js");
  const auth = await loadAuth();
  const info = await fetchSessionInfo(auth?.cookies ?? [], signal).catch(() => null);
  if (!info) return { accountUuid: null, email: null, expires: null, paymentTier: null };
  return {
    accountUuid: info.accountUuid,
    email: info.email,
    expires: info.expires,
    paymentTier: info.paymentTier,
  };
}

function bodyPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? flat.slice(0, 200) + "…" : flat;
}

/** Shared non-2xx mapping: 401 → clear + AuthRequiredError; 403 → keep cookies; 429 → retry hint. */
async function checkResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) void rotateJar(setCookies);
    if (response.status === 401) {
      await clearAuth().catch(() => {});
      throw new AuthRequiredError(`Session expired or revoked (HTTP 401). ${LOGIN_HELP}`);
    }
    if (response.status === 403) {
      // Keep cookies — 403 is often a Cloudflare challenge, not a dead session (contract §I.4).
      throw new ApiError(
        403,
        `Forbidden (HTTP 403) — possibly a Cloudflare challenge or missing entitlement. ` +
          `If it persists, ${LOGIN_HELP}`,
        bodyPreview(text),
      );
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const wait = retryAfter ? ` Retry after ${retryAfter}s.` : " Wait a moment and retry.";
      throw new ApiError(429, `Rate limited (HTTP 429).${wait}`, bodyPreview(text));
    }
    throw new ApiError(response.status, `HTTP ${response.status}: ${bodyPreview(text)}`, bodyPreview(text));
  }
  const text = await response.text();
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) void rotateJar(setCookies);
  if (text.length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

export async function restGet<T>(
  path: string,
  query?: Record<string, string | number | boolean>,
  signal?: AbortSignal | undefined,
): Promise<T> {
  const rc = await requestContext(signal);
  const response = await fetch(restUrl(path, query), {
    headers: baseHeaders(rc),
    ...(signal ? { signal } : {}),
  });
  return checkResponse<T>(response);
}

export async function restPost<T>(path: string, body: unknown, signal?: AbortSignal | undefined): Promise<T> {
  const rc = await requestContext(signal);
  const response = await fetch(restUrl(path), {
    method: "POST",
    headers: baseHeaders(rc, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  return checkResponse<T>(response);
}

/** DELETE /rest/* with an optional JSON body (t-04 delete_thread carries one). */
export async function restDelete<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal | undefined,
): Promise<T> {
  const rc = await requestContext(signal);
  const response = await fetch(restUrl(path), {
    method: "DELETE",
    headers: baseHeaders(rc, body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  return checkResponse<T>(response);
}

/**
 * POST to a captured-without-query-params endpoint (graphql/ask/subscribe). SSE calls
 * pass `sse: true`: x-app-apiclient/apiversion were absent in those captures, so they
 * are omitted (contract §0/§D).
 */
export async function apiPost(
  path: string,
  body: unknown,
  headers: Record<string, string>,
  opts?: { sse?: boolean; request_id?: string; signal?: AbortSignal | undefined },
): Promise<Response> {
  const rc = await requestContext(opts?.signal);
  const all = baseHeaders(
    rc,
    { "Content-Type": "application/json", ...headers },
    { omitApiClientHeaders: opts?.sse === true },
  );
  if (opts?.request_id) all["x-request-id"] = opts.request_id;
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: all,
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  if (!response.ok) {
    // Shared error mapping (throws on every non-2xx path).
    await checkResponse<never>(response);
  }
  return response;
}
