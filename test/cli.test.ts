import { readFile } from "node:fs/promises";
import { describe, expect, test } from "./test-helpers.js";

import {
  parseAskArguments,
  parseCliArguments,
  parseDeepArguments,
  runCli,
  type CliDependencies,
} from "../src/cli.js";
import { AuthError, type SearchResult, type StoredToken } from "../src/search/types.js";

function dependencies(overrides: Partial<CliDependencies> = {}): CliDependencies {
  return {
    loadToken: async () => null,
    extractFromDesktopApp: async () => null,
    authenticate: async () => ({ type: "oauth", access: "fixture-token" }) satisfies StoredToken,
    loadConfig: async () => ({}),
    resolveDefaultModel: () => "pplx_pro_upgraded",
    searchPerplexity: async () => ({ answer: "answer", sources: [] }),
    ...overrides,
  };
}

describe("cli", () => {
  test("parses subcommands and JSON ask arguments", () => {
    expect(parseCliArguments(["ask", '{"query":"hello"}'])).toEqual({
      subcommand: "ask",
      rawArgs: '{"query":"hello"}',
    });
    expect(parseCliArguments(["auth-status"])).toEqual({ subcommand: "auth-status" });
    expect(parseCliArguments(["deep", '{"query":"hello"}'])).toEqual({
      subcommand: "deep",
      rawArgs: '{"query":"hello"}',
    });
    expect(parseAskArguments('{"query":"hello","recency":"week","limit":2}')).toEqual({
      query: "hello",
      recency: "week",
      limit: 2,
    });
    expect(parseDeepArguments('{"query":"hello","model":"custom"}')).toEqual({
      query: "hello",
      model: "custom",
    });
  });

  test("returns a structured AUTH error without interactive callbacks", async () => {
    const result = await runCli(
      ["ask", JSON.stringify({ query: "hello" })],
      dependencies({
        authenticate: async () => {
          throw new AuthError("NO_TOKEN", "no token");
        },
      }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.payload).toMatchObject({ ok: false, code: "AUTH" });
    expect(String(result.payload.error)).toContain("run: pi /perplexity-login --force");
  });

  test("returns the success shape and applies the source limit client-side", async () => {
    const fixture = JSON.parse(await readFile("test/fixtures/cli-success.json", "utf8")) as SearchResult;
    const result = await runCli(
      ["ask", JSON.stringify({ query: "hello", limit: 1 })],
      dependencies({ searchPerplexity: async () => fixture }),
    );

    expect(result).toEqual({
      exitCode: 0,
      payload: {
        ok: true,
        answer: "A fixture answer",
        sources: [{ name: "One", url: "https://one.example" }],
        displayModel: "pplx_pro_upgraded",
        uuid: "fixture-uuid",
      },
    });
  });

  test("deep defaults to pplx_alpha and passes recency and model overrides", async () => {
    let request: { model?: string; recency?: string } | undefined;
    const result = await runCli(
      ["deep", JSON.stringify({ query: "hello", recency: "week" })],
      dependencies({
        searchPerplexity: async (params) => {
          request = params;
          return { answer: "deep answer", sources: [] };
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(request).toEqual({ query: "hello", model: "pplx_alpha", recency: "week" });

    await runCli(
      ["deep", JSON.stringify({ query: "hello", model: "custom" })],
      dependencies({
        searchPerplexity: async (params) => {
          request = params;
          return { answer: "deep answer", sources: [] };
        },
      }),
    );
    expect(request?.model).toBe("custom");
  });

  test("deep honors PI_PERPLEXITY_DEEP_TIMEOUT_MS", async () => {
    const previous = process.env.PI_PERPLEXITY_DEEP_TIMEOUT_MS;
    process.env.PI_PERPLEXITY_DEEP_TIMEOUT_MS = "10";
    let aborted = false;
    try {
      const result = await runCli(
        ["deep", JSON.stringify({ query: "hello" })],
        dependencies({
          searchPerplexity: async (_params, _auth, signal) => {
            await new Promise<void>((resolve) => {
              if (signal?.aborted) {
                resolve();
                return;
              }
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            aborted = signal?.aborted ?? false;
            return { answer: "deep answer", sources: [] };
          },
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(aborted).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PI_PERPLEXITY_DEEP_TIMEOUT_MS;
      else process.env.PI_PERPLEXITY_DEEP_TIMEOUT_MS = previous;
    }
  });
});
