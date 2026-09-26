import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { streamAsk } from "../src/api/ask.js";
import { askCommand } from "../src/commands/ask.js";
import { loadThreadState, saveAuth, saveThreadState, type StoredAuth, type ThreadState } from "../src/config.js";
import { ASK1_SSE, ASK2_FOLLOWUP_SSE } from "./fixtures.js";

/**
 * End-to-end streamAsk against a stubbed fetch (zero network): verifies the
 * request shape (URL without query params, x-request-id === frontend_uuid,
 * cookie auth) and the streaming merge behavior on the verbatim c-trace ask
 * snapshots.
 */

let cfgDir: string;
const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  throw new Error("fetch stub not configured for this test");
});

beforeAll(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "pplx-ask-"));
  process.env.PPLX_CONFIG_DIR = cfgDir;
  const auth: StoredAuth = {
    kind: "cookies",
    cookies: ["__Secure-next-auth.session-token=t", "pplx.session-id=s"],
    accountUuid: "00000033-0000-4000-8000-000000000000",
    sessionExpires: null,
    email: null,
    bearerToken: null,
    source: "paste",
    createdAt: "2026-01-01T00:00:00Z",
  };
  await saveAuth(auth);
});

afterAll(async () => {
  delete process.env.PPLX_CONFIG_DIR;
  await rm(cfgDir, { recursive: true, force: true });
});

afterEach(() => {
  fetchMock.mockRestore();
});

function sseResponse(raw: string): Response {
  return new Response(new Blob([raw]).stream(), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Replace globalThis.fetch with the stub (double-cast: fetch carries extra props like preconnect). */
function installFetchStub(raw: string): void {
  fetchMock.mockImplementation(async () => sseResponse(raw));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

describe("streamAsk — end-to-end over stubbed fetch (fixtures from c-trace)", () => {
  it("POSTs the captured URL shape and mirrors frontend_uuid into x-request-id", async () => {
    installFetchStub(ASK1_SSE);

    await streamAsk({ query: "Reply with exactly OK" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // Captured without query params (c-trace entry 1) — version/source must NOT appear.
    expect(input).toBe("https://www.perplexity.ai/rest/sse/perplexity_ask");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cookie")).toContain("__Secure-next-auth.session-token=t");
    expect(headers.get("x-pplx-account")).toBe("00000033-0000-4000-8000-000000000000");
    const body = JSON.parse(String(init.body)) as { params: Record<string, unknown> };
    expect(headers.get("x-request-id")).toBe(body.params.frontend_uuid as string); // verified equality in c-01
  });

  it("streams incremental answers via onEvent and returns the merged result", async () => {
    installFetchStub(ASK1_SSE);

    const partials: string[] = [];
    const result = await streamAsk({ query: "Reply with exactly OK" }, {
      onEvent: (partial) => partials.push(partial),
    });

    // 5 message events in ASK1: three empty PENDING, "OK" (diff), "OK" (final).
    expect(partials.filter((p) => p.length > 0)).toEqual(["OK", "OK"]);
    expect(result.answer).toBe("OK");
    expect(result.readWriteToken).toBe("00000068-0000-4000-8000-000000000000");
    expect(result.backendUuid).toBe("00000066-0000-4000-8000-000000000000");
    expect(result.threadUrl).toBe("https://www.perplexity.ai/search/00000066-0000-4000-8000-000000000000");
    expect(result.model).toBe("gemini38flash");
  });

  it("follow-up body carries last_backend_uuid + read_write_token and query_source=followup", async () => {
    installFetchStub(ASK2_FOLLOWUP_SSE);

    const result = await streamAsk({
      query: "Reply with exactly DONE",
      followup: {
        lastBackendUuid: "00000066-0000-4000-8000-000000000000",
        readWriteToken: "00000068-0000-4000-8000-000000000000",
      },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const params = (JSON.parse(String(init.body)) as { params: Record<string, unknown> }).params;
    expect(params.last_backend_uuid).toBe("00000066-0000-4000-8000-000000000000");
    expect(params.read_write_token).toBe("00000068-0000-4000-8000-000000000000");
    expect(params.query_source).toBe("followup");
    expect(params.followup_source).toBe("link");
    // First-message-only fields must not leak into follow-ups (contract §E).
    expect(params.frontend_context_uuid).toBeUndefined();
    expect(params.dsl_query).toBeUndefined();
    expect(params.client_search_results_cache_key).toBeUndefined();

    // New entry's backend_uuid becomes the chain's tail for the next follow-up.
    expect(result.answer).toBe("DONE");
    expect(result.backendUuid).toBe("00000039-0000-4000-8000-000000000000");
  });
});

describe("ask command — --continue (temp chat registry e2e, stubbed fetch)", () => {
  // Registry files live under PPLX_CACHE_DIR — each test gets a fresh dir so
  // seeded state never touches the real ~/.cache/pplx (or leaks across tests).
  let cacheDir: string;

  const OLDER_SLUG = "00000066-0000-4000-8000-000000000000"; // ASK1 thread slug
  const NEWER_SLUG = "00000039-0000-4000-8000-000000000000"; // ASK2 thread slug
  const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000).toISOString();

  function tempState(slug: string, updatedAt: string, createdAt: string): ThreadState {
    return {
      slug,
      readWriteToken: "00000068-0000-4000-8000-000000000000",
      lastBackendUuid: slug, // ASK1/ASK2 backend_uuid === thread slug
      url: `https://www.perplexity.ai/search/${slug}`,
      updatedAt,
      incognito: true,
      createdAt,
      query: "seeded",
    };
  }

  async function runAsk(argv: Record<string, unknown>): Promise<void> {
    const handler = askCommand.handler as (a: Record<string, unknown>) => Promise<void>;
    await handler(argv);
  }

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "pplx-ask-cmd-"));
    process.env.PPLX_CACHE_DIR = cacheDir;
  });

  afterEach(async () => {
    delete process.env.PPLX_CACHE_DIR;
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("--continue picks the most recently updated live temp chat and preserves the TTL anchor", async () => {
    await saveThreadState(tempState(NEWER_SLUG, oneHourAgo, oneHourAgo));
    await saveThreadState(tempState(OLDER_SLUG, tenMinAgo, oneHourAgo)); // most recently used
    installFetchStub(ASK2_FOLLOWUP_SSE);

    await runAsk({ query: ["go", "deeper"], continue: true, stream: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const params = (JSON.parse(String(init.body)) as { params: Record<string, unknown> }).params;
    expect(params.last_backend_uuid).toBe(OLDER_SLUG);
    expect(params.read_write_token).toBe("00000068-0000-4000-8000-000000000000");
    expect(params.query_source).toBe("followup");

    // Registry updated: new tail uuid + original createdAt anchor preserved.
    const state = await loadThreadState(OLDER_SLUG);
    expect(state?.lastBackendUuid).toBe(NEWER_SLUG);
    expect(state?.createdAt).toBe(oneHourAgo); // anchor NOT reset by the follow-up
  });

  it("--continue with only expired temp chats fails with an actionable error", async () => {
    await saveThreadState(tempState(OLDER_SLUG, tenMinAgo, twoDaysAgo));

    await expect(runAsk({ query: ["anything"], continue: true })).rejects.toThrow(/no live temp chat/);
  });

  it("--thread on an expired temp chat fails fast with the slug in the error", async () => {
    await saveThreadState(tempState(OLDER_SLUG, tenMinAgo, twoDaysAgo));

    await expect(runAsk({ query: ["anything"], thread: OLDER_SLUG })).rejects.toThrow(
      new RegExp(`temp chat ${OLDER_SLUG} expired`),
    );
  });

  it("--save <file> dumps the JSON reply in --json mode", async () => {
    installFetchStub(ASK1_SSE);
    const replyPath = join(cacheDir, "nested", "reply.json");

    await runAsk({ query: ["hi"], json: true, save: replyPath });

    const parsed = JSON.parse(await readFile(replyPath, "utf8")) as { answer?: string };
    expect(parsed.answer).toBe("OK");
  });

  it("--save <file> dumps answer + sources block in human mode", async () => {
    installFetchStub(ASK1_SSE);
    const replyPath = join(cacheDir, "reply.md");

    await runAsk({ query: ["hi"], stream: false, save: replyPath });

    const text = await readFile(replyPath, "utf8");
    expect(text).toStartWith("OK\n\n");
    expect(text).toContain("## Meta");
  });
});
