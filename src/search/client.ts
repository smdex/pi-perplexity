import { randomUUID } from "node:crypto";

import { mergeEvent, readSseEvents } from "./stream.js";
import type { SearchResult, StoredToken, StreamEvent, WebResult } from "./types.js";
import { SearchError } from "./types.js";
import { errorMessage } from "../util.js";
import { PERPLEXITY_USER_AGENT, PERPLEXITY_API_VERSION } from "../constants.js";
import type { AuthCredentials } from "../auth/login.js";

const ORIGIN = "https://www.perplexity.ai";
const PERPLEXITY_ENDPOINT = `${ORIGIN}/rest/sse/perplexity_ask`;

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const MAX_BUN_STDOUT = 50 * 1024 * 1024;

/**
 * Execute an HTTP request via a Bun subprocess.
 * Pi loads extensions under Node/jiti whose fetch gets Cloudflare-challenged.
 * Bun's native fetch has a different TLS fingerprint that passes.
 */
async function fetchViaBunRuntime(
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal?: AbortSignal,
): Promise<{ status: number; bodyText: string }> {
  const script = `
const c = JSON.parse(await Bun.stdin.text());
try {
  const r = await fetch(c.url, { method: c.method, headers: c.headers, ...(c.body ? { body: c.body } : {}) });
  const t = await r.text();
  process.stdout.write(JSON.stringify({ s: r.status, b: t }));
} catch (e) {
  process.stdout.write(JSON.stringify({ s: 0, b: String(e?.message ?? e) }));
}
`;

  // Dynamic import: spawn is only needed under Node/jiti (not Bun),
  // and Bun's node:child_process polyfill may not export it.
  const { spawn } = await import("node:child_process");

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("bun", ["-e", script], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { HOME: process.env.HOME, PATH: process.env.PATH },
    });

    if (signal) {
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener("abort", onAbort));
    }

    if (!child.stdin || !child.stdout) {
      reject(new Error("Failed to open subprocess pipes"));
      return;
    }

    child.stdin.write(JSON.stringify({ url, headers, body, method: body === undefined ? "GET" : "POST" }));
    child.stdin.end();

    const chunks: Buffer[] = [];
    let totalLen = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      totalLen += chunk.length;
      if (totalLen <= MAX_BUN_STDOUT) {
        chunks.push(chunk);
      }
    });

    child.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
    child.on("error", reject);
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Bun subprocess returned invalid output: ${stdout.slice(0, 200)}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("Bun subprocess response is not an object.");
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.s !== "number" || typeof obj.b !== "string") {
    throw new Error("Bun subprocess response missing required fields.");
  }

  return { status: obj.s, bodyText: obj.b };
}

/** One shared HTTP exchange: Bun subprocess under Node/jiti, native fetch under Bun. */
async function exchange(
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal?: AbortSignal,
): Promise<{ status: number; bodyText: string; stream?: ReadableStream<Uint8Array> }> {
  // ponytail: NODE_TEST_CONTEXT probe — node --test mocks globalThis.fetch; subprocess only for the real Node/jiti runtime
  if (!("Bun" in globalThis) && !process.env.NODE_TEST_CONTEXT) {
    const result = await fetchViaBunRuntime(url, headers, body, signal);
    if (result.status === 0) throw new Error(result.bodyText);
    return result;
  }
  const response = await fetch(url, {
    ...(body !== undefined ? { method: "POST" as const } : {}),
    headers,
    ...(body !== undefined ? { body } : {}),
    signal: signal ?? null,
  });
  return {
    status: response.status,
    bodyText: "",
    ...(response.body ? { stream: response.body as ReadableStream<Uint8Array> } : {}),
  };
}

export interface SearchParams {
  query: string;
  recency?: "hour" | "day" | "week" | "month" | "year";
  model: string;
  /** Continue an existing conversation: last entry uuid + its read-write token. */
  followup?: { lastBackendUuid: string; readWriteToken: string };
}

export type SearchProgress = (event: StreamEvent, snapshot: StreamEvent) => void;

function normalizeUrl(url: string): string {
  const trimmed = url.trim().replace(/\/$/, "");
  try {
    // URL lowercases scheme and host; paths/queries stay case-sensitive.
    return new URL(trimmed).href.replace(/\/$/, "");
  } catch {
    return trimmed.toLowerCase();
  }
}

function dedupeSourcesByUrl(sources: WebResult[]): WebResult[] {
  const seen = new Set<string>();
  const deduped: WebResult[] = [];

  for (const source of sources) {
    const url = source.url?.trim();
    if (!url) {
      deduped.push(source);
      continue;
    }

    const key = normalizeUrl(url);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(source);
  }

  return deduped;
}

function extractTextFromBlock(event: StreamEvent, match: (usage: string) => boolean): string | null {
  const blocks = event.blocks ?? [];

  for (const block of blocks) {
    const usage = block.intended_usage ?? "";
    if (!match(usage)) {
      continue;
    }

    const markdown = block.markdown_block;
    if (!markdown) {
      continue;
    }

    if (typeof markdown.answer === "string" && markdown.answer.trim().length > 0) {
      return markdown.answer.trim();
    }

    if (markdown.chunks && markdown.chunks.length > 0) {
      const chunkText = markdown.chunks.join("").trim();
      if (chunkText.length > 0) {
        return chunkText;
      }
    }
  }

  return null;
}

function extractAnswer(event: StreamEvent): string {
  const markdownAnswer = extractTextFromBlock(event, (usage) => usage.includes("markdown"));
  if (markdownAnswer) {
    return markdownAnswer;
  }

  const askTextAnswer = extractTextFromBlock(event, (usage) => usage === "ask_text");
  if (askTextAnswer) {
    return askTextAnswer;
  }

  return event.text?.trim() ?? "";
}

function extractSources(event: StreamEvent): WebResult[] {
  const webResultsBlock = (event.blocks ?? []).find(
    (block) => block.intended_usage === "web_results",
  );

  const blockSources = webResultsBlock?.web_result_block?.web_results ?? [];
  if (blockSources.length > 0) {
    return dedupeSourcesByUrl(blockSources);
  }

  const fallbackSources: WebResult[] = (event.sources_list ?? []).map((source) => {
    const result: WebResult = {};
    if (source.title !== undefined) result.name = source.title;
    if (source.url !== undefined) result.url = source.url;
    if (source.snippet !== undefined) result.snippet = source.snippet;
    if (source.date !== undefined) result.timestamp = source.date;
    return result;
  });

  return dedupeSourcesByUrl(fallbackSources);
}

function buildRequestBody(params: SearchParams): Record<string, unknown> {
  const query = params.query;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

  const requestParams: Record<string, unknown> = {
    query_str: query,
    search_focus: "internet",
    mode: "copilot",
    model_preference: params.model,
    sources: ["web"],
    attachments: [],
    frontend_uuid: randomUUID(),
    // NOTE: frontend_context_uuid is deliberately NOT set on first messages
    // (verified pplx CLI contract: fresh threads omit it; follow-ups too).
    version: PERPLEXITY_API_VERSION,
    language: "en-US",
    timezone,
    search_recency_filter: params.recency ?? null,
    is_incognito: true,
    use_schematized_api: true,
    skip_search_enabled: true,
  };
  if (params.followup) {
    requestParams.last_backend_uuid = params.followup.lastBackendUuid;
    requestParams.read_write_token = params.followup.readWriteToken;
    requestParams.query_source = "followup";
    requestParams.followup_source = "link";
  }

  return {
    query_str: query,
    params: requestParams,
  };
}

function buildRequestHeaders(credentials: AuthCredentials, requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    // Cookie jar is the primary credential (all cookies, not just the session
    // token — cf_clearance/__cf_bm are required to pass Cloudflare).
    Cookie: credentials.cookies.join("; "),
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Origin: ORIGIN,
    Referer: `${ORIGIN}/`,
    // Replay the UA the cookies were issued for when one was captured.
    "User-Agent": credentials.userAgent ?? PERPLEXITY_USER_AGENT,
    "X-App-ApiClient": "default",
    "X-App-ApiVersion": PERPLEXITY_API_VERSION,
    "X-Perplexity-Request-Reason": "submit",
    "X-Request-ID": requestId,
  };
  // Bearer supplements the jar when a JWT is available (desktop borrow / OTP body token).
  if (credentials.jwt) {
    headers.Authorization = `Bearer ${credentials.jwt}`;
  }
  return headers;
}

function mapHttpError(status: number): SearchError {
  if (status === 401 || status === 403) {
    return new SearchError(
      "AUTH",
      "Perplexity rejected authentication (401/403). Run /perplexity-login (or `pplx login` in a terminal) and retry.",
    );
  }

  if (status === 429) {
    return new SearchError(
      "RATE_LIMIT",
      "Perplexity rate limited this request (429). Wait a bit, then retry.",
    );
  }

  return new SearchError(
    "NETWORK",
    `Perplexity request failed with HTTP ${status}. Check connectivity and retry.`,
  );
}

/**
 * GET a /rest/* JSON endpoint with the same credentials + Cloudflare-safe
 * transport (used by the live model catalog). Throws Error on non-2xx.
 */
export async function restGetJson(
  credentials: AuthCredentials,
  path: string,
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const qs = new URLSearchParams(query).toString();
  const headers: Record<string, string> = {
    Accept: "application/json",
    Cookie: credentials.cookies.join("; "),
    "User-Agent": credentials.userAgent ?? PERPLEXITY_USER_AGENT,
    "X-App-ApiClient": "default",
    "X-App-ApiVersion": PERPLEXITY_API_VERSION,
  };
  if (credentials.jwt) headers.Authorization = `Bearer ${credentials.jwt}`;

  let result: { status: number; bodyText: string };
  try {
    result = await exchange(`${ORIGIN}${path}${qs ? `?${qs}` : ""}`, headers, undefined, signal);
  } catch (error) {
    throw new Error(`GET ${path} failed: ${errorMessage(error)}`);
  }
  if (result.status === 401 || result.status === 403) {
    throw new SearchError("AUTH", `GET ${path} rejected authentication (HTTP ${result.status}).`);
  }
  if (result.status !== 200) {
    throw new Error(`GET ${path} returned HTTP ${result.status}.`);
  }
  try {
    return JSON.parse(result.bodyText) as unknown;
  } catch {
    throw new Error(`GET ${path} returned non-JSON body.`);
  }
}

/** Execute a Perplexity search: POST SSE, stream/merge events, extract answer + sources + thread state. Throws SearchError on failure. */
export async function searchPerplexity(
  params: SearchParams,
  credentials: AuthCredentials,
  signal?: AbortSignal,
  onProgress?: SearchProgress,
): Promise<SearchResult> {
  const requestId = randomUUID();
  const requestBody = buildRequestBody(params);
  const requestHeaders = buildRequestHeaders(credentials, requestId);

  let eventStream: ReadableStream<Uint8Array>;

  try {
    const result = await exchange(
      PERPLEXITY_ENDPOINT,
      requestHeaders,
      JSON.stringify(requestBody),
      signal,
    );
    if (result.status !== 200) {
      throw mapHttpError(result.status);
    }
    if (result.stream) {
      eventStream = result.stream;
    } else if (result.bodyText) {
      eventStream = streamFromText(result.bodyText);
    } else {
      throw new SearchError("STREAM", "Perplexity returned an empty response.");
    }
  } catch (error) {
    if (error instanceof SearchError) throw error;
    if (signal?.aborted) {
      throw new SearchError("NETWORK", "Perplexity request was cancelled.");
    }
    throw new SearchError(
      "NETWORK",
      `Could not connect to Perplexity. ${errorMessage(error)}`,
    );
  }

  let snapshot: StreamEvent = {};
  let shouldCancelStream = true;
  let stoppedAtTerminalEvent = false;

  try {
    try {
      for await (const event of readSseEvents(eventStream, signal)) {
        snapshot = mergeEvent(snapshot, event);
        onProgress?.(event, snapshot);
        if (event.final || event.status === "COMPLETED") {
          stoppedAtTerminalEvent = true;
          break;
        }
      }

      if (signal?.aborted) {
        throw new SearchError("NETWORK", "Perplexity request was cancelled.");
      }

      shouldCancelStream = stoppedAtTerminalEvent;
    } finally {
      if (shouldCancelStream && !signal?.aborted) {
        await eventStream.cancel();
      }
    }
  } catch (error) {
    if (error instanceof SearchError) {
      throw error;
    }

    if (signal?.aborted) {
      throw new SearchError("NETWORK", "Perplexity request was cancelled.");
    }

    throw new SearchError(
      "STREAM",
      `Failed to read Perplexity stream: ${errorMessage(error)}`,
    );
  }

  if (snapshot.error_code || snapshot.error_message) {
    throw new SearchError(
      "STREAM",
      snapshot.error_message || `Perplexity stream error: ${snapshot.error_code}`,
    );
  }

  const answer = extractAnswer(snapshot);
  const sources = extractSources(snapshot);

  if (!answer && sources.length === 0) {
    throw new SearchError(
      "EMPTY",
      "Perplexity returned no answer and no sources for this query.",
    );
  }

  const result: SearchResult = {
    answer: answer || "No answer text returned by Perplexity.",
    sources,
  };
  // The stream's model fields are inconsistent: either user_selected_model or
  // display_model may report "turbo" even when the requested model was honored
  // (see issue #7). Prefer whichever is present and not "turbo"; if both are
  // missing or "turbo", fall back to the requested model.
  const reportedModel =
    [snapshot.user_selected_model, snapshot.display_model].find(
      (model) => model && model !== "turbo",
    ) ?? params.model;
  if (reportedModel !== undefined) result.displayModel = reportedModel;
  if (snapshot.uuid !== undefined) result.uuid = snapshot.uuid;
  // Thread continuation state (all optional — stream shape is unstable).
  if (snapshot.thread_url_slug) result.slug = snapshot.thread_url_slug;
  if (snapshot.read_write_token) result.readWriteToken = snapshot.read_write_token;
  if (snapshot.backend_uuid) result.backendUuid = snapshot.backend_uuid;

  return result;
}
