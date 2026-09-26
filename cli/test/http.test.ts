import { afterEach, describe, expect, it } from "bun:test";
import { apiUrl, baseHeaders, effectiveCookieHeader, restUrl } from "../src/api/http.js";
import type { StoredAuth } from "../src/config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(() => {
  delete process.env.PPLX_COOKIE;
});

describe("restUrl", () => {
  it("always merges version=2.18&source=default", () => {
    const url = new URL(restUrl("/rest/sources"));
    expect(url.origin + url.pathname).toBe("https://www.perplexity.ai/rest/sources");
    expect(url.searchParams.get("version")).toBe("2.18");
    expect(url.searchParams.get("source")).toBe("default");
  });

  it("merges extra query params alongside", () => {
    const url = new URL(restUrl("/rest/sources", { limit: 40, group_by_family: "true", flag: true }));
    expect(url.searchParams.get("limit")).toBe("40");
    expect(url.searchParams.get("group_by_family")).toBe("true");
    expect(url.searchParams.get("flag")).toBe("true");
    expect(url.searchParams.get("version")).toBe("2.18");
  });

  it("lets an explicit version override the default", () => {
    const url = new URL(restUrl("/rest/x", { version: "9.9" }));
    expect(url.searchParams.get("version")).toBe("9.9");
  });
});

describe("apiUrl", () => {
  it("builds plain URLs without query params (graphql/ask/subscribe captures)", () => {
    expect(apiUrl("/rest/sse/perplexity_ask")).toBe("https://www.perplexity.ai/rest/sse/perplexity_ask");
    expect(apiUrl("/rest/perplexity_ask/graphql")).toBe("https://www.perplexity.ai/rest/perplexity_ask/graphql");
  });
});

describe("effectiveCookieHeader", () => {
  const auth: StoredAuth = {
    kind: "cookies",
    cookies: ["__Secure-next-auth.session-token=t", "pplx.session-id=s"],
    accountUuid: "u",
    sessionExpires: null,
    email: null,
    bearerToken: null,
    source: "paste",
    createdAt: "2026-01-01T00:00:00Z",
  };

  it("joins the stored jar", () => {
    expect(effectiveCookieHeader(auth)).toBe("__Secure-next-auth.session-token=t; pplx.session-id=s");
  });

  it("PPLX_COOKIE env beats the stored jar", () => {
    process.env.PPLX_COOKIE = "a=1; b=2";
    expect(effectiveCookieHeader(auth)).toBe("a=1; b=2");
    expect(effectiveCookieHeader(null)).toBe("a=1; b=2");
  });

  it("empty with no auth and no env", () => {
    expect(effectiveCookieHeader(null)).toBe("");
  });
});

describe("baseHeaders", () => {
  const rc = { cookieHeader: "a=1", accountUuid: "2767-uuid", userAgent: "TestUA/1.0" };

  it("sends identity + client headers with a fresh request id", () => {
    const h1 = baseHeaders(rc);
    const h2 = baseHeaders(rc);
    expect(h1["x-pplx-account"]).toBe("2767-uuid");
    expect(h1.Cookie).toBe("a=1");
    expect(h1["x-app-apiclient"]).toBe("default");
    expect(h1["x-app-apiversion"]).toBe("2.18");
    expect(h1.Accept).toBe("application/json");
    expect(UUID_RE.test(h1["x-request-id"])).toBe(true);
    expect(h1["x-request-id"]).not.toBe(h2["x-request-id"]);
    expect(h1["User-Agent"]).toBe("TestUA/1.0");
  });

  it("omits x-pplx-account when the uuid is unknown", () => {
    expect("x-pplx-account" in baseHeaders({ cookieHeader: "a=1", accountUuid: null, userAgent: "U" })).toBe(false);
  });

  it("can omit apiclient headers (SSE captures) and merge extras", () => {
    const h = baseHeaders(rc, { Accept: "text/event-stream" }, { omitApiClientHeaders: true });
    expect(h.Accept).toBe("text/event-stream");
    expect("x-app-apiclient" in h).toBe(false);
    expect("x-app-apiversion" in h).toBe(false);
  });
});
