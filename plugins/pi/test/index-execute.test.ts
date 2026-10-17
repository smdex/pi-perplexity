import { afterEach, beforeEach, describe, expect, mock, test } from "./test-helpers.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SearchError } from "../src/search/types.js";

const originalCacheDir = process.env.PI_PERPLEXITY_CACHE_DIR;
let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "pi-perplexity-threads-"));
  process.env.PI_PERPLEXITY_CACHE_DIR = cacheDir;
});

afterEach(async () => {
  mock.restore();
  if (originalCacheDir === undefined) {
    delete process.env.PI_PERPLEXITY_CACHE_DIR;
  } else {
    process.env.PI_PERPLEXITY_CACHE_DIR = originalCacheDir;
  }
  await rm(cacheDir, { recursive: true, force: true });
});

const CREDENTIALS = {
  jwt: "jwt-token",
  cookies: ["__Secure-next-auth.session-token=abc"],
  userAgent: null,
  email: "user@example.com",
  source: "cookies" as const,
};

describe("perplexity_search execute", () => {
  test("includes effective config values in the search request and result details", async () => {
    const authenticate = mock(async () => CREDENTIALS);
    const saveBrowserAuthInput = mock(async () => ({ type: "oauth", access: "jwt-token" }));
    const loadConfig = mock(async () => ({ model: "gpt54" }));
    const resolveDefaultModel = mock(() => "gpt54");
    const searchPerplexity = mock(async () => ({
      answer: "answer",
      sources: [{ url: "https://example.com" }],
      displayModel: "gpt54",
      uuid: "req-123",
      slug: "s0000000-0000-4000-8000-000000000001",
      readWriteToken: "rw-1",
      backendUuid: "be-1",
    }));

    mock.module("../src/auth/login.js", () => ({ authenticate, saveBrowserAuthInput }));
    mock.module("../src/config.js", () => ({
      getConfigPath: () => "/tmp/pi-perplexity-config.json",
      loadConfig,
      resolveDefaultModel,
      saveConfig: mock(async () => undefined),
    }));
    mock.module("../src/search/client.js", () => ({ searchPerplexity, restGetJson: mock(async () => ({})), restPostJson: mock(async () => ({})) }));

    const { default: registerExtension } = await import(`../src/index.js?test=${crypto.randomUUID()}`);

    let execute: ((toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>) | undefined;
    let parameters: unknown;

    registerExtension({
      registerCommand() {
        return undefined;
      },
      registerTool(tool: { execute: typeof execute; parameters: unknown }) {
        execute = tool.execute;
        parameters = tool.parameters;
      },
    } as any);

    expect(execute).toBeDefined();
    expect(JSON.stringify(parameters)).not.toContain("incognito");

    const result = await execute!(
      "tool-1",
      { query: "how many planets", model: "pplx_pro" },
      undefined,
      undefined,
      { ui: {} },
    );

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(resolveDefaultModel).toHaveBeenCalledWith({ model: "gpt54" });
    expect(searchPerplexity).toHaveBeenCalledWith(
      {
        query: "how many planets",
        model: "gpt54",
      },
      CREDENTIALS,
      undefined,
    );
    expect(result.details.model).toBe("gpt54");
    expect(result.details.thread).toBe("s0000000-0000-4000-8000-000000000001");
    expect(result.details.authSource).toBe("cookies");
  });

  test("thread param reuses stored followup state", async () => {
    const authenticate = mock(async () => CREDENTIALS);
    const searchPerplexity = mock(async () => ({
      answer: "continued answer",
      sources: [],
      displayModel: "gpt54",
      slug: undefined,
      readWriteToken: "rw-2",
      backendUuid: "be-2",
    }));

    mock.module("../src/auth/login.js", () => ({ authenticate }));
    mock.module("../src/config.js", () => ({
      getConfigPath: () => "/tmp/pi-perplexity-config.json",
      loadConfig: mock(async () => ({ model: "gpt54" })),
      resolveDefaultModel: mock(() => "gpt54"),
      saveConfig: mock(async () => undefined),
    }));
    mock.module("../src/search/client.js", () => ({ searchPerplexity, restGetJson: mock(async () => ({})), restPostJson: mock(async () => ({})) }));

    const { default: registerExtension } = await import(`../src/index.js?test=${crypto.randomUUID()}`);
    const threadsMod = await import(`../src/auth/threads.js?test=${crypto.randomUUID()}`);

    let execute: ((toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>) | undefined;
    registerExtension({
      registerCommand() {
        return undefined;
      },
      registerTool(tool: { execute: typeof execute }) {
        execute = tool.execute;
      },
    } as any);

    // seed one thread state via the real threads module (isolated cache dir)
    const slug = "c0000000-0000-4000-8000-000000000004";
    await threadsMod.saveThreadState({
      slug,
      readWriteToken: "rw-seed",
      lastBackendUuid: "be-seed",
      url: `https://www.perplexity.ai/search/${slug}`,
      updatedAt: new Date().toISOString(),
      query: "seed",
      incognito: true,
      createdAt: new Date().toISOString(),
    });

    const result = await execute!("tool-2", { query: "follow-up", thread: slug }, undefined, undefined, { ui: {} });

    const lastCall = (searchPerplexity as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({
      query: "follow-up",
      followup: { lastBackendUuid: "be-seed", readWriteToken: "rw-seed" },
    });
    expect(lastCall?.[1]).toEqual(CREDENTIALS);
    expect(lastCall?.[2]).toBe(undefined);

    expect(result.details.continued).toBe(slug);
    // follow-up over an existing incognito thread keeps its original TTL anchor
    const state = await threadsMod.loadThreadState(slug);
    expect(state?.readWriteToken).toBe("rw-2");
  });

  test("continue=true without live sessions returns a helpful error", async () => {
    mock.module("../src/auth/login.js", () => ({ authenticate: mock(async () => CREDENTIALS) }));
    mock.module("../src/config.js", () => ({
      getConfigPath: () => "/tmp/pi-perplexity-config.json",
      loadConfig: mock(async () => ({ model: "gpt54" })),
      resolveDefaultModel: mock(() => "gpt54"),
      saveConfig: mock(async () => undefined),
    }));
    mock.module("../src/search/client.js", () => ({
      searchPerplexity: mock(async () => ({})),
      restGetJson: mock(async () => ({})),
      restPostJson: mock(async () => ({})),
    }));

    const { default: registerExtension } = await import(`../src/index.js?test=${crypto.randomUUID()}`);

    let execute: ((toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>) | undefined;
    registerExtension({
      registerCommand() {
        return undefined;
      },
      registerTool(tool: { execute: typeof execute }) {
        execute = tool.execute;
      },
    } as any);

    const result = await execute!("tool-3", { query: "q", continue: true }, undefined, undefined, { ui: {} });
    expect(result.details.isError).toBe(true);
    expect(result.content[0].text).toContain("No live Perplexity session");
  });

  test("does not clear cached credentials on Perplexity auth rejection", async () => {
    const authenticate = mock(async () => "jwt-token");
    const saveBrowserAuthInput = mock(async () => ({ type: "oauth", access: "jwt-token" }));
    const clearToken = mock(async () => undefined);
    const loadConfig = mock(async () => ({}));
    const resolveDefaultModel = mock(() => "pplx_pro_upgraded");
    const searchPerplexity = mock(async () => {
      throw new SearchError("AUTH", "Perplexity rejected authentication (401/403).");
    });

    mock.module("../src/auth/login.js", () => ({ authenticate, saveBrowserAuthInput }));
    mock.module("../src/auth/storage.js", () => ({ clearToken }));
    mock.module("../src/config.js", () => ({
      getConfigPath: () => "/tmp/pi-perplexity-config.json",
      loadConfig,
      resolveDefaultModel,
      saveConfig: mock(async () => undefined),
    }));
    mock.module("../src/search/client.js", () => ({ searchPerplexity, restGetJson: mock(async () => ({})), restPostJson: mock(async () => ({})) }));

    const { default: registerExtension } = await import(`../src/index.js?test=${crypto.randomUUID()}`);

    let execute: ((toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>) | undefined;
    registerExtension({
      registerCommand() {
        return undefined;
      },
      registerTool(tool: { execute: typeof execute }) {
        execute = tool.execute;
      },
    } as any);

    const result = await execute!("tool-1", { query: "hello" }, undefined, undefined, { ui: {} });

    expect(result.details.isError).toBe(true);
    expect(String(result.content[0].text)).toContain("Perplexity search failed");
    expect(clearToken).toHaveBeenCalledTimes(0);
  });
});
