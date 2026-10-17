import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginOtpLogin, completeOtpLogin, loginInteractive, type OtpSession } from "../src/auth/otp.js";
import { hasSessionCookie } from "../src/auth/cookies.js";
import { loadAuth } from "../src/config.js";
import { jsonResponse, mockFetch } from "./fixtures.js";

/**
 * Email-OTP flow over a mocked fetch: csrf → signin-email → signin-otp →
 * /api/auth/session. Asserts jar capture, failure modes, and the credential
 * precedence (CLI flags > PPLX_EMAIL/PPLX_OTP env > interactive prompts).
 */

let cfgDir: string;

beforeAll(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "pplx-otp-"));
  process.env.PPLX_CONFIG_DIR = cfgDir;
});

afterAll(async () => {
  delete process.env.PPLX_CONFIG_DIR;
  delete process.env.PPLX_EMAIL;
  delete process.env.PPLX_OTP;
  await rm(cfgDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.PPLX_EMAIL;
  delete process.env.PPLX_OTP;
});

interface OtpMockOpts {
  otpCookies?: string[]; // set-cookies returned by signin-otp
  otpBody?: unknown; // signin-otp JSON body
  otpStatus?: number;
  sessionBody?: unknown;
}

/** Route the four auth endpoints; default = the happy path. */
function otpMock(opts: OtpMockOpts = {}) {
  return mockFetch((url) => {
    if (url.endsWith("/api/auth/csrf")) {
      return jsonResponse({ csrfToken: "csrf-1" }, ["__Host-next-auth.csrf-token=c1; Path=/"]);
    }
    if (url.endsWith("/api/auth/signin-email")) {
      return jsonResponse({}, ["__Host-next-auth.csrf-token=c1; Path=/"]);
    }
    if (url.endsWith("/api/auth/signin-otp")) {
      return jsonResponse(
        opts.otpBody ?? { token: "jwt-abc" },
        opts.otpCookies ?? ["__Secure-next-auth.session-token=sess-1; Path=/"],
        opts.otpStatus ?? 200,
      );
    }
    if (url.endsWith("/api/auth/session")) {
      return jsonResponse(opts.sessionBody ?? { user: { id: "acc-uuid", email: "user@example.com", payment_tier: "pro" }, expires: "2027-01-01T00:00:00.000Z" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("beginOtpLogin", () => {
  it("captures the csrf token + cookie jar from the two round-trips", async () => {
    const mocked = otpMock();
    try {
      const session = await beginOtpLogin("user@example.com");
      expect(session.email).toBe("user@example.com");
      expect(session.csrfToken).toBe("csrf-1");
      expect(session.cookies).toEqual(["__Host-next-auth.csrf-token=c1"]);
      // signin-email carries the csrf cookie + csrfToken in the body
      const emailCall = mocked.calls.find((c) => c.url.endsWith("/api/auth/signin-email"));
      expect(emailCall?.init?.headers).toMatchObject({ Cookie: "__Host-next-auth.csrf-token=c1" });
      expect(JSON.parse(String(emailCall?.init?.body))).toEqual({ email: "user@example.com", csrfToken: "csrf-1" });
    } finally {
      mocked.restore();
    }
  });
});

describe("completeOtpLogin", () => {
  it("returns a StoredAuth: session cookie jar, bearer token, resolved account", async () => {
    const mocked = otpMock();
    try {
      const session = await beginOtpLogin("user@example.com");
      const auth = await completeOtpLogin(session, " 123456 ");
      expect(auth.cookies).toContain("__Secure-next-auth.session-token=sess-1");
      expect(auth.accountUuid).toBe("acc-uuid");
      expect(auth.email).toBe("user@example.com");
      expect(auth.bearerToken).toBe("jwt-abc");
      expect(auth.source).toBe("otp");
      expect(auth.sessionExpires).toBe("2027-01-01T00:00:00.000Z");
    } finally {
      mocked.restore();
    }
  });

  it("falls back to the bearer token when signin-otp sets no session cookie", async () => {
    const mocked = otpMock({ otpCookies: [] });
    try {
      const session: OtpSession = { email: "user@example.com", csrfToken: "csrf-1", cookies: ["c=1"] };
      const auth = await completeOtpLogin(session, "123456");
      expect(auth.bearerToken).toBe("jwt-abc");
      expect(auth.source).toBe("otp");
      expect(hasSessionCookie(auth.cookies)).toBeFalse();
    } finally {
      mocked.restore();
    }
  });

  it("throws when signin-otp yields neither a session cookie nor a token", async () => {
    const mocked = otpMock({ otpCookies: [], otpBody: {} });
    try {
      const session: OtpSession = { email: "user@example.com", csrfToken: "csrf-1", cookies: ["c=1"] };
      await expect(completeOtpLogin(session, "123456")).rejects.toThrow("neither a session cookie nor a bearer token");
    } finally {
      mocked.restore();
    }
  });

  it("throws when the post-login session check reports logged-out ({})", async () => {
    const mocked = otpMock({ sessionBody: {} });
    try {
      const session: OtpSession = { email: "user@example.com", csrfToken: "csrf-1", cookies: ["c=1"] };
      await expect(completeOtpLogin(session, "123456")).rejects.toThrow("no active session");
    } finally {
      mocked.restore();
    }
  });

  it("throws on a non-2xx otp verification", async () => {
    const mocked = otpMock({ otpStatus: 401, otpCookies: [] });
    try {
      const session: OtpSession = { email: "user@example.com", csrfToken: "csrf-1", cookies: ["c=1"] };
      await expect(completeOtpLogin(session, "wrong")).rejects.toThrow("HTTP 401");
    } finally {
      mocked.restore();
    }
  });
});

describe("loginInteractive credential precedence", () => {
  const promptsThrow = {
    promptEmail: () => Promise.reject(new Error("promptEmail must not be called")),
    promptOtp: () => Promise.reject(new Error("promptOtp must not be called")),
  };

  it("explicit opts (CLI --email/--otp) win and skip the prompts entirely", async () => {
    process.env.PPLX_EMAIL = "env@example.com"; // must NOT win over opts
    process.env.PPLX_OTP = "999999";
    const mocked = otpMock();
    try {
      const auth = await loginInteractive(promptsThrow, undefined, { email: "flag@example.com", otp: "123456" });
      const emailCall = mocked.calls.find((c) => c.url.endsWith("/api/auth/signin-email"));
      expect(JSON.parse(String(emailCall?.init?.body))).toMatchObject({ email: "flag@example.com", csrfToken: "csrf-1" });
      const otpCall = mocked.calls.find((c) => c.url.endsWith("/api/auth/signin-otp"));
      expect(JSON.parse(String(otpCall?.init?.body))).toMatchObject({ email: "flag@example.com", otp: "123456" });
      expect(await loadAuth()).not.toBeNull(); // saved
    } finally {
      mocked.restore();
    }
  });

  it("PPLX_EMAIL/PPLX_OTP env is used when no opts are given", async () => {
    process.env.PPLX_EMAIL = "env@example.com";
    process.env.PPLX_OTP = "654321";
    const mocked = otpMock();
    try {
      const auth = await loginInteractive(promptsThrow);
      const emailCall = mocked.calls.find((c) => c.url.endsWith("/api/auth/signin-email"));
      expect(JSON.parse(String(emailCall?.init?.body))).toMatchObject({ email: "env@example.com" });
    } finally {
      mocked.restore();
    }
  });

  it("falls back to the prompts when neither opts nor env are set", async () => {
    let prompts = 0;
    const mocked = otpMock();
    try {
      const auth = await loginInteractive({
        promptEmail: async () => {
          prompts++;
          return "typed@example.com";
        },
        promptOtp: async () => {
          prompts++;
          return "111222";
        },
      });
      const emailCall = mocked.calls.find((c) => c.url.endsWith("/api/auth/signin-email"));
      expect(JSON.parse(String(emailCall?.init?.body))).toMatchObject({ email: "typed@example.com" });
      expect(prompts).toBe(2);
    } finally {
      mocked.restore();
    }
  });

  it("email via opts + OTP via prompt (mixed sources)", async () => {
    let otpPrompts = 0;
    const mocked = otpMock();
    try {
      const auth = await loginInteractive(
        {
          promptEmail: () => Promise.reject(new Error("email known — no prompt")),
          promptOtp: async () => {
            otpPrompts++;
            return "333444";
          },
        },
        undefined,
        { email: "flag@example.com" },
      );
      const emailCall = mocked.calls.find((c) => c.url.endsWith("/api/auth/signin-email"));
      expect(JSON.parse(String(emailCall?.init?.body))).toMatchObject({ email: "flag@example.com" });
      expect(otpPrompts).toBe(1);
    } finally {
      mocked.restore();
    }
  });
});
