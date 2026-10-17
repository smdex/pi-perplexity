import { afterEach, describe, expect, mock, test } from "../test-helpers.js";

import { AuthError } from "../../src/search/types.js";
import type { StoredToken } from "../../src/search/types.js";
import type { AuthCredentials } from "../../src/auth/login.js";

const originalFetch = globalThis.fetch;
const originalBorrow = process.env.PI_AUTH_NO_BORROW;
const originalEmail = process.env.PI_PERPLEXITY_EMAIL;
const originalOtp = process.env.PI_PERPLEXITY_OTP;
const originalToken = process.env.PI_PERPLEXITY_TOKEN;
const originalCookie = process.env.PI_PERPLEXITY_COOKIE;
const originalPlatform = process.platform;

function createJwt(expiryMs: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiryMs / 1000) })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function createOpaqueToken(): string {
  return "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0.part2.part3.part4.part5";
}

function csrfHeaders(): [string, string][] {
  return [
    ["content-type", "application/json"],
    ["set-cookie", "next-auth.csrf-token=csrf-cookie; Path=/; HttpOnly"],
  ];
}

async function importLoginModule() {
  return import(`../../src/auth/login.js?test=${crypto.randomUUID()}`);
}

function restoreEnv(): void {
  for (const [key, original] of [
    ["PI_AUTH_NO_BORROW", originalBorrow],
    ["PI_PERPLEXITY_EMAIL", originalEmail],
    ["PI_PERPLEXITY_OTP", originalOtp],
  ] as const) {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }

  if (originalToken === undefined) {
    delete process.env.PI_PERPLEXITY_TOKEN;
  } else {
    process.env.PI_PERPLEXITY_TOKEN = originalToken;
  }

  if (originalCookie === undefined) {
    delete process.env.PI_PERPLEXITY_COOKIE;
  } else {
    process.env.PI_PERPLEXITY_COOKIE = originalCookie;
  }
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

afterEach(() => {
  mock.restore();
  globalThis.fetch = originalFetch;
  restoreEnv();
  setPlatform(originalPlatform);
});

describe("auth/login", () => {
  test("extractFromDesktopApp returns null when defaults command fails", async () => {
    setPlatform("darwin");

    const execFileMock = mock((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      callback(new Error("missing defaults entry"), "", "not found");
    });

    mock.module("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { extractFromDesktopApp } = await importLoginModule();

    const token = await extractFromDesktopApp();
    expect(token).toBeNull();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  test("extractFromDesktopApp returns JWT from defaults output", async () => {
    setPlatform("darwin");

    const desktopToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    const execFileMock = mock((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      callback(null, `${desktopToken}\n`, "");
    }) as unknown as typeof import("node:child_process").execFile;

    (execFileMock as unknown as Record<symbol, unknown>)[
      Symbol.for("nodejs.util.promisify.custom")
    ] = async () => ({ stdout: `${desktopToken}\n`, stderr: "" });

    mock.module("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { extractFromDesktopApp } = await importLoginModule();

    const token = await extractFromDesktopApp();
    expect(token).toBe(desktopToken);
  });

  test("authenticate returns stored credentials without desktop or OTP calls", async () => {
    const cachedToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    const loadCredentialsMock = mock(async () => ({
      type: "oauth",
      access: cachedToken,
      cookies: ["__Secure-next-auth.session-token=abc"],
    }) satisfies StoredToken);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: mock(async () => null),
      loadCredentials: loadCredentialsMock,
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const execFileMock = mock((...args: unknown[]) => {
      const callback = args[args.length - 1] as (
        error: Error | null,
        stdout?: string,
        stderr?: string,
      ) => void;
      callback(new Error("should not run"), "", "");
    });

    mock.module("node:child_process", () => ({
      execFile: execFileMock,
    }));

    const { authenticate } = await importLoginModule();

    const credentials: AuthCredentials = await authenticate();

    expect(credentials.jwt).toBe(cachedToken);
    expect(credentials.cookies).toEqual(["__Secure-next-auth.session-token=abc"]);
    expect(credentials.source).toBe("cookies");
    expect(loadCredentialsMock).toHaveBeenCalledTimes(1);
    expect(saveTokenMock).toHaveBeenCalledTimes(0);
    expect(clearTokenMock).toHaveBeenCalledTimes(0);
    expect(execFileMock).toHaveBeenCalledTimes(0);
  });

  test("authenticate without a jar enriches from the CLI cookie jar", async () => {
    const cachedToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    mock.module("../../src/auth/storage.js", () => ({
      loadToken: mock(async () => null),
      loadCredentials: mock(async () => ({
        type: "oauth",
        access: cachedToken,
        cookies: ["__Secure-next-auth.session-token=cli", "cf_clearance=ua-bound"],
        userAgent: "Mozilla/5.0 CliUA",
      })),
      saveToken: mock(async (_token: StoredToken) => undefined),
      clearToken: mock(async () => undefined),
    }));

    const { authenticate } = await importLoginModule();

    const credentials = await authenticate();

    expect(credentials.source).toBe("cookies");
    expect(credentials.userAgent).toBe("Mozilla/5.0 CliUA");
    expect(credentials.cookies).toContain("cf_clearance=ua-bound");
  });

  test("authenticate uses OTP fallback when desktop borrowing is disabled", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    const otpToken = createOpaqueToken();
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: mock(async () => null),
      loadCredentials: mock(async () => null),
      saveToken: saveTokenMock,
      clearToken: mock(async () => undefined),
    }));

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/csrf")) {
        return new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: csrfHeaders(),
        });
      }

      if (url.endsWith("/signin-email")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.endsWith("/signin-otp")) {
        return new Response(JSON.stringify({ token: otpToken }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("not found", { status: 404 });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    const credentials = await authenticate({
      promptForEmail: async () => "user@example.com",
      promptForOtp: async () => "123456",
    });

    expect(credentials.jwt).toBe(otpToken);
    expect(credentials.source).toBe("otp");
    expect(credentials.email).toBe("user@example.com");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(saveTokenMock).toHaveBeenCalledTimes(1);

    const savedToken = saveTokenMock.mock.calls[0]?.[0] as StoredToken;
    expect(savedToken.type).toBe("oauth");
    expect(savedToken.access).toBe(otpToken);
    expect(savedToken.email).toBe("user@example.com");

    const signinEmailRequest = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const signinOtpRequest = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(new Headers(signinEmailRequest.headers).get("Cookie")).toBe("next-auth.csrf-token=csrf-cookie");
    expect(new Headers(signinOtpRequest.headers).get("Cookie")).toBe("next-auth.csrf-token=csrf-cookie");
    expect(JSON.parse(String(signinEmailRequest.body))).toEqual({
      email: "user@example.com",
      csrfToken: "csrf-token",
    });
    expect(JSON.parse(String(signinOtpRequest.body))).toEqual({
      email: "user@example.com",
      otp: "123456",
      csrfToken: "csrf-token",
    });
  });

  test("authenticate saves PI_PERPLEXITY_TOKEN without desktop or OTP calls", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    process.env.PI_PERPLEXITY_TOKEN = "env-token";

    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      loadCredentials: mock(async () => null),
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const { authenticate } = await importLoginModule();

    const credentials = await authenticate();

    expect(credentials.jwt).toBe("env-token");
    expect(credentials.source).toBe("token");
    expect(saveTokenMock).toHaveBeenCalledTimes(1);
    expect(saveTokenMock.mock.calls[0]?.[0]).toEqual({ type: "oauth", access: "env-token" });
  });

  test("authenticate saves browser Cookie header from PI_PERPLEXITY_COOKIE", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    const browserToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    process.env.PI_PERPLEXITY_COOKIE =
      `pplx.visitor-id=visitor; __Secure-next-auth.session-token=${browserToken}; cf_clearance=clearance`;

    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      loadCredentials: mock(async () => null),
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const { authenticate } = await importLoginModule();

    const credentials = await authenticate();

    expect(credentials.cookies.some((cookie: string) => cookie.startsWith("__Secure-next-auth.session-token="))).toBe(true);
    expect(credentials.jwt).toBe(browserToken);
    expect(credentials.source).toBe("cookies");
    expect(saveTokenMock).toHaveBeenCalledTimes(1);
  });

  test("authenticate accepts a bare session token from PI_PERPLEXITY_COOKIE", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    const browserToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    process.env.PI_PERPLEXITY_COOKIE = browserToken;

    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      loadCredentials: mock(async () => null),
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const { authenticate } = await importLoginModule();

    const credentials = await authenticate();

    expect(credentials.jwt).toBe(browserToken);
    expect(credentials.cookies).toEqual([]);
    expect(saveTokenMock).toHaveBeenCalledTimes(1);
  });

  test("authenticate rejects PI_PERPLEXITY_COOKIE without a signed-in session cookie", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";
    process.env.PI_PERPLEXITY_COOKIE = "pplx.visitor-id=visitor; cf_clearance=clearance";

    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      loadCredentials: mock(async () => null),
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const { authenticate } = await importLoginModule();

    let thrown: unknown;
    try {
      await authenticate();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("NO_TOKEN");
    expect((thrown as Error).message).toContain("PI_PERPLEXITY_COOKIE is set");
    expect((thrown as Error).message).toContain("not a Perplexity signed-in session cookie");
    expect(saveTokenMock).toHaveBeenCalledTimes(0);
  });

  test("parseBrowserAuthInput extracts cookies from Copy as cURL", async () => {
    const browserToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    const curl = `curl 'https://www.perplexity.ai/rest/sse/perplexity_ask' \\
  -H 'accept: text/event-stream' \\
  -H 'cookie: pplx.visitor-id=visitor; __Secure-next-auth.session-token=${browserToken}; cf_clearance=clearance' \\
  --data-raw '{"query":"hello"}'`;

    const { parseBrowserAuthInput } = await import("../../src/auth/browser.js");
    const parsed = parseBrowserAuthInput(curl);

    expect(parsed?.cookies).toEqual([
      "pplx.visitor-id=visitor",
      `__Secure-next-auth.session-token=${browserToken}`,
      "cf_clearance=clearance",
    ]);
    expect(parsed?.access).toBe(browserToken);
  });

  test("parseBrowserAuthInput extracts cookies from --cookie= cURL form", async () => {
    const browserToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    const curl = `curl 'https://www.perplexity.ai/rest/sse/perplexity_ask' \\
  --cookie='pplx.visitor-id=visitor; __Secure-next-auth.session-token=${browserToken}; cf_clearance=clearance' \\
  --data-raw '{"query":"hello"}'`;

    const { parseBrowserAuthInput } = await import("../../src/auth/browser.js");
    const parsed = parseBrowserAuthInput(curl);

    expect(parsed?.cookies).toEqual([
      "pplx.visitor-id=visitor",
      `__Secure-next-auth.session-token=${browserToken}`,
      "cf_clearance=clearance",
    ]);
    expect(parsed?.access).toBe(browserToken);
  });

  test("parseBrowserAuthInput extracts cookies from unquoted -b and --cookie cURL forms", async () => {
    const browserToken = createJwt(Date.now() + 2 * 60 * 60 * 1000);
    const { parseBrowserAuthInput } = await import("../../src/auth/browser.js");

    for (const flag of ["-b", "--cookie"]) {
      const curl = `curl 'https://www.perplexity.ai/rest/sse/perplexity_ask' ${flag} __Secure-next-auth.session-token=${browserToken}`;
      const parsed = parseBrowserAuthInput(curl);

      expect(parsed?.cookies).toEqual([`__Secure-next-auth.session-token=${browserToken}`]);
      expect(parsed?.access).toBe(browserToken);
    }
  });

  test("saveBrowserAuthInput explains Copy as cURL without cookies", async () => {
    const curl = `curl 'https://www.perplexity.ai/' \\
  -H 'Upgrade-Insecure-Requests: 1' \\
  -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36' \\
  -H 'sec-ch-ua: "Chromium";v="149", "Not)A;Brand";v="24"' \\
  -H 'sec-ch-ua-mobile: ?0' \\
  -H 'sec-ch-ua-platform: "macOS"'`;

    const { saveBrowserAuthInput } = await importLoginModule();

    let thrown: unknown;
    try {
      await saveBrowserAuthInput(curl);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("NO_TOKEN");
    expect((thrown as Error).message).toContain("The cURL command you pasted does not include cookies");
    expect((thrown as Error).message).toContain("-b");
    expect((thrown as Error).message).toContain("__Secure-next-auth.session-token");
  });

  test("authenticate reproduces Cloudflare CSRF failure without browser fallback", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    const loadTokenMock = mock(async () => null);
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);
    const clearTokenMock = mock(async () => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: loadTokenMock,
      loadCredentials: mock(async () => null),
      saveToken: saveTokenMock,
      clearToken: clearTokenMock,
    }));

    const fetchMock = mock(async () =>
      new Response("<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>", {
        status: 403,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    let thrown: unknown;
    try {
      await authenticate({
        promptForEmail: async () => "user@example.com",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("EXTRACTION_FAILED");
    expect((thrown as Error).message).toContain("Failed to fetch CSRF token");
    expect((thrown as Error).message).toContain("browser challenge");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saveTokenMock).toHaveBeenCalledTimes(0);
  });

  test("authenticate captures Set-Cookie jar during OTP login and saves it", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    const otpToken = createOpaqueToken();
    const saveTokenMock = mock(async (_token: StoredToken) => undefined);

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: mock(async () => null),
      loadCredentials: mock(async () => null),
      saveToken: saveTokenMock,
      clearToken: mock(async () => undefined),
    }));

    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith("/csrf")) {
        return new Response(JSON.stringify({ csrfToken: "csrf-token" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "__Host-next-auth.csrf-token=csrf-cookie; Path=/; HttpOnly",
          },
        });
      }

      if (url.endsWith("/signin-email")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      if (url.endsWith("/signin-otp")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            // token arrives as cookie, not body
            "set-cookie": "__Secure-next-auth.session-token=otp-session; Path=/; Secure",
          },
        });
      }

      return new Response("not found", { status: 404 });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { authenticate } = await importLoginModule();

    const credentials = await authenticate({
      promptForEmail: async () => "user@example.com",
      promptForOtp: async () => "123456",
    });

    // no body token, but the session cookie came through Set-Cookie
    expect(credentials.jwt).toBe("");
    expect(credentials.cookies).toContain("__Secure-next-auth.session-token=otp-session");
    expect(credentials.cookies).toContain("__Host-next-auth.csrf-token=csrf-cookie");
    expect(credentials.source).toBe("otp");

    const savedToken = saveTokenMock.mock.calls[0]?.[0] as StoredToken;
    expect(savedToken.cookies).toContain("__Secure-next-auth.session-token=otp-session");
  });

  test("authenticate throws NO_TOKEN when no credentials and no OTP email input", async () => {
    process.env.PI_AUTH_NO_BORROW = "1";

    mock.module("../../src/auth/storage.js", () => ({
      loadToken: mock(async () => null),
      loadCredentials: mock(async () => null),
      saveToken: mock(async (_token: StoredToken) => undefined),
      clearToken: mock(async () => undefined),
    }));

    const { authenticate } = await importLoginModule();

    let thrown: unknown;
    try {
      await authenticate({
        promptForEmail: async () => undefined,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AuthError);
    expect((thrown as AuthError).code).toBe("NO_TOKEN");
  });
});
