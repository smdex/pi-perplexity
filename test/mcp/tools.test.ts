import { describe, expect, test } from "../test-helpers.js";

import {
  failureText,
  runDeepTool,
  runSearchTool,
  type ToolDeps,
  type ToolModelConfig,
} from "../../src/mcp/tools.js";
import { AuthError, SearchError, type SearchResult, type StoredToken } from "../../src/search/types.js";

const CFG: ToolModelConfig = { model: "pplx_pro_upgraded", deepModel: "pplx_alpha" };

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    authenticate: async () => ({ type: "oauth", access: "fixture-token" }) satisfies StoredToken,
    searchPerplexity: async () => ({ answer: "answer", sources: [] }) satisfies SearchResult,
    formatForLLM: (result, limit?) => `FMT:${result.answer}:${limit ?? "-"}`,
    ...overrides,
  };
}

describe("failureText", () => {
  test("AuthError points to re-login", () => {
    const text = failureText(new AuthError("NO_TOKEN", "no token"));
    expect(text).toContain("Authentication failed");
    expect(text).toContain("perplexity-login --force");
  });

  test("AUTH SearchError treated as auth failure", () => {
    expect(failureText(new SearchError("AUTH", "bad creds"))).toContain("Authentication failed");
  });

  test("other SearchError surfaced as search failure", () => {
    expect(failureText(new SearchError("RATE_LIMIT", "slow down"))).toContain("Perplexity search failed");
  });
});

describe("runSearchTool", () => {
  test("returns formatted answer on success", async () => {
    const out = await runSearchTool({ query: "hello" }, CFG, deps());
    expect(out).toBe("FMT:answer:-");
  });

  test("honors source limit", async () => {
    const out = await runSearchTool({ query: "hello", limit: 3 }, CFG, deps());
    expect(out).toBe("FMT:answer:3");
  });

  test("uses configured model and passes recency", async () => {
    let captured: { model?: string; recency?: string; query?: string } | undefined;
    await runSearchTool(
      { query: "q", recency: "week" },
      CFG,
      deps({
        searchPerplexity: async (params) => {
          captured = params;
          return { answer: "a", sources: [] };
        },
      }),
    );
    expect(captured).toEqual({ query: "q", model: "pplx_pro_upgraded", recency: "week" });
  });

  test("returns readable text on AuthError (never throws)", async () => {
    const out = await runSearchTool(
      { query: "q" },
      CFG,
      deps({ authenticate: async () => {
        throw new AuthError("NO_TOKEN", "no token");
      } }),
    );
    expect(out).toContain("Authentication failed");
    expect(out).toContain("perplexity-login --force");
  });

  test("returns readable text on SearchError", async () => {
    const out = await runSearchTool(
      { query: "q" },
      CFG,
      deps({ searchPerplexity: async () => {
        throw new SearchError("NETWORK", "boom");
      } }),
    );
    expect(out).toContain("Perplexity search failed");
    expect(out).toContain("boom");
  });
});

describe("runDeepTool", () => {
  test("defaults to deepModel (pplx_alpha)", async () => {
    let captured: { model?: string } | undefined;
    await runDeepTool(
      { query: "q" },
      CFG,
      deps({ searchPerplexity: async (params) => {
        captured = params;
        return { answer: "d", sources: [] };
      } }),
    );
    expect(captured?.model).toBe("pplx_alpha");
  });

  test("per-call model overrides default", async () => {
    let captured: { model?: string } | undefined;
    await runDeepTool(
      { query: "q", model: "custom" },
      CFG,
      deps({ searchPerplexity: async (params) => {
        captured = params;
        return { answer: "d", sources: [] };
      } }),
    );
    expect(captured?.model).toBe("custom");
  });

  test("forwards progress notifications", async () => {
    const progressed: string[] = [];
    await runDeepTool(
      { query: "q" },
      CFG,
      deps({
        searchPerplexity: async (_params, _auth, _signal, onProgress) => {
          onProgress?.({ status: "researching" }, { blocks: [] });
          return { answer: "d", sources: [] };
        },
      }),
      (message) => {
        progressed.push(message);
      },
    );
    expect(progressed).toContain("researching");
  });
});
