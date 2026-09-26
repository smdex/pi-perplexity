import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, AuthRequiredError, requestContext, restGet } from "../src/api/http.js";
import { loadAuth, saveAuth, type StoredAuth } from "../src/config.js";
import { mockFetch } from "./fixtures.js";

/**
 * requestContext credential resolution + the shared non-2xx mapping — all over a
 * mocked global fetch (zero network), with the config dir redirected to a temp dir.
 */

let cfgDir: string;

beforeAll(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "pplx-http-"));
  process.env.PPLX_CONFIG_DIR = cfgDir;
});

afterAll(async () => {
  delete process.env.PPLX_CONFIG_DIR;
  delete process.env.PPLX_COOKIE;
  await rm(cfgDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.PPLX_COOKIE;
});

function storedAuth(): StoredAuth {
  return {
    kind: "cookies",
    cookies: ["__Secure-next-auth.session-token=tok", "pplx.session-id=sid"],
    accountUuid: "00000033-0000-4000-8000-000000000000",
    sessionExpires: null,
    email: "user@example.com",
    bearerToken: null,
    source: "paste",
    createdAt: "2026-09-22T00:00:00.000Z",
  };
}

describe("requestContext — PPLX_COOKIE is a complete credential (plan §5.4)", () => {
  it("works with NO stored auth: resolves the account uuid via /api/auth/session (memoized)", async () => {
    process.env.PPLX_COOKIE = "Cookie: __Secure-next-auth.session-token=tok; a=1";
    let sessionCalls = 0;
    const mocked = mockFetch((url) => {
      if (url.includes("/api/auth/session")) {
        sessionCalls++;
        return Response.json({ user: { id: "uuid-from-session", email: "a@b.c" }, expires: "2027-01-01T00:00:00.000Z" });
      }
      return Response.json({});
    });
    try {
      const rc = await requestContext();
      // the "Cookie:" header prefix is tolerated and stripped on the wire
      expect(rc.cookieHeader).toBe("__Secure-next-auth.session-token=tok; a=1");
      expect(rc.accountUuid).toBe("uuid-from-session");
      const rc2 = await requestContext();
      expect(rc2.accountUuid).toBe("uuid-from-session");
      expect(sessionCalls).toBe(1); // resolved once per process, not per request
    } finally {
      mocked.restore();
      delete process.env.PPLX_COOKIE;
    }
  });

  it("survives an unreachable session endpoint: proceeds without x-pplx-account", async () => {
    process.env.PPLX_COOKIE = "__Secure-next-auth.session-token=tok";
    const mocked = mockFetch(() => Promise.reject(new TypeError("offline")));
    try {
      const rc = await requestContext();
      expect(rc.cookieHeader).toBe("__Secure-next-auth.session-token=tok");
      expect(rc.accountUuid).toBeNull();
    } finally {
      mocked.restore();
      delete process.env.PPLX_COOKIE;
    }
  });

  it("rejects a garbage env cookie with AuthRequiredError", async () => {
    process.env.PPLX_COOKIE = "not a cookie header";
    const mocked = mockFetch(() => Response.json({}));
    try {
      await expect(requestContext()).rejects.toBeInstanceOf(AuthRequiredError);
    } finally {
      mocked.restore();
      delete process.env.PPLX_COOKIE;
    }
  });

  it("no env cookie and no stored auth → AuthRequiredError", async () => {
    await expect(requestContext()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it("stored auth with accountUuid: no session round-trip at all", async () => {
    await saveAuth(storedAuth());
    const mocked = mockFetch(() => Response.json({}));
    try {
      const rc = await requestContext();
      expect(rc.accountUuid).toBe("00000033-0000-4000-8000-000000000000");
      expect(mocked.calls.length).toBe(0);
    } finally {
      mocked.restore();
    }
  });
});

describe("non-2xx mapping (mocked fetch)", () => {
  it("401 clears the stored jar and throws AuthRequiredError", async () => {
    await saveAuth(storedAuth());
    const mocked = mockFetch(() => new Response("nope", { status: 401 }));
    try {
      await expect(restGet("/rest/sources")).rejects.toBeInstanceOf(AuthRequiredError);
      expect(await loadAuth()).toBeNull(); // jar cleared
    } finally {
      mocked.restore();
    }
  });

  it("403 throws ApiError(403) and KEEPS the stored jar (Cloudflare ambiguity)", async () => {
    const stored = storedAuth();
    await saveAuth(stored);
    const mocked = mockFetch(() => new Response("forbidden", { status: 403 }));
    try {
      const error = await restGet("/rest/sources").then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(403);
      expect((error as ApiError).message).toContain("403");
      expect(await loadAuth()).toEqual(stored); // jar intact
    } finally {
      mocked.restore();
    }
  });

  it("429 surfaces the retry-after hint", async () => {
    await saveAuth(storedAuth());
    const mocked = mockFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    try {
      const error = await restGet("/rest/sources").then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(429);
      expect((error as ApiError).message).toContain("Retry after 30s");
    } finally {
      mocked.restore();
    }
  });

  it("network failure propagates as a rejection (never a crash)", async () => {
    await saveAuth(storedAuth());
    const mocked = mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    try {
      await expect(restGet("/rest/sources")).rejects.toThrow("fetch failed");
    } finally {
      mocked.restore();
    }
  });

  it("restGet sends version=2.18&source=default + identity headers on /rest/*", async () => {
    await saveAuth(storedAuth());
    const mocked = mockFetch(() => Response.json({ sources: [] }));
    try {
      await restGet("/rest/sources", { limit: 40 });
      const call = mocked.calls[0];
      expect(call.url).toBe("https://www.perplexity.ai/rest/sources?version=2.18&source=default&limit=40");
      expect(call.init?.headers).toMatchObject({
        Cookie: "__Secure-next-auth.session-token=tok; pplx.session-id=sid",
        "x-pplx-account": "00000033-0000-4000-8000-000000000000",
        "x-app-apiclient": "default",
        "x-app-apiversion": "2.18",
      });
    } finally {
      mocked.restore();
    }
  });
});
