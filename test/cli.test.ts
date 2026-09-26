import { readFile } from "node:fs/promises";
import { describe, expect, test } from "./test-helpers.js";

import { parseCliArguments, runCli, type CliDependencies } from "../src/cli.js";
import type { AuthCredentials } from "../src/auth/login.js";
import { AuthError, type SearchResult } from "../src/search/types.js";

function dependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    loadToken: async () => null,
    extractFromDesktopApp: async () => null,
    authenticate: async () => ({ jwt: "fixture-jwt", cookies: [], userAgent: null, email: null, source: "token" }) satisfies AuthCredentials,
    loadConfig: async () => ({}), resolveDefaultModel: () => "pplx_pro_upgraded",
    searchPerplexity: async () => ({ answer: "answer", sources: [] }), uploadAttachments: async () => [],
    ...overrides,
  };
}

describe("cli", () => {
  test("joins positional query words and parses interspersed flags", () => {
    expect(parseCliArguments(["ask", "latest", "--recency", "week", "release", "--limit=5", "notes", "for", "X"])).toEqual({
      subcommand: "ask", search: { query: "latest release notes for X", recency: "week", limit: 5 },
    });
  });
  test("validates query, recency, limit, scalar duplicates, and missing values", () => {
    for (const args of [["ask"], ["ask", "--recency", "decade", "q"], ["ask", "--limit", "0", "q"], ["ask", "--limit", "2.5", "q"], ["ask", "--limit", "2", "--limit", "3", "q"], ["ask", "--recency"], ["ask", "--limit=--attach", "q"]]) {
      expect(() => parseCliArguments(args)).toThrow();
    }
  });
  test("parses repeatable comma-separated attachments", () => {
    expect(parseCliArguments(["ask", "q", "--attach", "a, b,,", "--attach=c"])).toEqual({
      subcommand: "ask", search: { query: "q", files: ["a", "b", "c"] },
    });
    expect(() => parseCliArguments(["ask", "q", "--attach= , "])).toThrow(/at least one file path/);
  });
  test("deep supports model and auth-status rejects extras", () => {
    expect(parseCliArguments(["deep", "q", "--model=custom", "--recency", "year", "--limit", "50"]).search).toEqual({ query: "q", model: "custom", recency: "year", limit: 50 });
    expect(() => parseCliArguments(["auth-status", "extra"])).toThrow(/auth-status does not accept arguments/);
    expect(() => parseCliArguments(["auth-status", "--attach=x"])).toThrow();
  });
  test("uploads attachments before search and passes returned URLs", async () => {
    let uploaded: { path: string }[] = [];
    let request: { query?: string; attachments?: string[]; recency?: string } | undefined;
    const result = await runCli(["ask", "latest", "--recency", "week", "release", "notes", "--attach=one,two", "--attach", "three"], dependencies({
      uploadAttachments: async (files) => { uploaded = files; return ["url1", "url2", "url3"]; },
      searchPerplexity: async (params) => { request = params; return { answer: "answer", sources: [] }; },
    }));
    expect(uploaded).toEqual([{ path: "one" }, { path: "two" }, { path: "three" }]);
    expect(request).toEqual({ query: "latest release notes", model: "pplx_pro_upgraded", recency: "week", attachments: ["url1", "url2", "url3"] });
    expect(result.payload.attachments).toEqual(["one", "two", "three"]);
  });
  test("returns structured AUTH error without interactive callbacks", async () => {
    const result = await runCli(["ask", "hello"], dependencies({ authenticate: async () => { throw new AuthError("NO_TOKEN", "no token"); } }));
    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({ ok: false, code: "AUTH" });
    expect(String(result.payload.error)).toContain("run: pi /perplexity-login --force");
  });
  test("limits sources client-side", async () => {
    const fixture = JSON.parse(await readFile("test/fixtures/cli-success.json", "utf8")) as SearchResult;
    const result = await runCli(["ask", "hello", "--limit", "1"], dependencies({ searchPerplexity: async () => fixture }));
    expect(result.payload.sources).toEqual([{ name: "One", url: "https://one.example" }]);
  });
  test("deep defaults model and passes recency and override", async () => {
    let request: { model?: string; recency?: string } | undefined;
    await runCli(["deep", "hello", "--recency=week"], dependencies({ searchPerplexity: async (params) => { request = params; return { answer: "deep", sources: [] }; } }));
    expect(request).toEqual({ query: "hello", model: "pplx_alpha", recency: "week" });
    await runCli(["deep", "hello", "--model", "custom"], dependencies({ searchPerplexity: async (params) => { request = params; return { answer: "deep", sources: [] }; } }));
    expect(request?.model).toBe("custom");
  });
});
