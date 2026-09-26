import { DEFAULT_MODEL, ORIGIN, RESEARCH_MODEL } from "../constants.js";
import { apiPost } from "./http.js";
import { AskMerger, isTerminalEvent, parseAskEvent, readSseJson, type AskEvent, type GeneratedImage, type WebResultRef } from "./sse.js";

/**
 * Ask submission: POST /rest/sse/perplexity_ask (no query params — captured
 * verbatim in c-trace). Request body per contract §D/§E minimal subset;
 * telemetry (rum_session_id, time_from_first_type, …) is never added.
 */

export interface AskOptions {
  query: string;
  model?: string; // default DEFAULT_MODEL
  recency?: "hour" | "day" | "week" | "month" | "year";
  sources?: string[]; // default ["web"]
  attachments?: string[]; // s3_object_urls from uploads.ts
  incognito?: boolean; // default true
  language?: string; // default "en-US"
  timezone?: string; // default local IANA tz
  /** Follow-up in an existing thread (contract §E). */
  followup?: { lastBackendUuid: string; readWriteToken: string };
  /**
   * Deep Research (verified r-summary §1): same endpoint + params, the mode is
   * carried ONLY by model_preference "pplx_alpha" (overrides `model`); the
   * normal-mode `client_search_results_cache_key` is omitted (never sent by
   * this CLI anyway) and `search_mode` does NOT exist in the ask body.
   */
  research?: boolean;
  /**
   * Space targeting (verified s-summary “Ask inside space”): sets
   * params.target_collection_uuid + target_thread_access_level 5 +
   * query_source "collection". Value = the space uuid (resolveSpace first).
   * mentions stays absent — the web client sends `mentions: []` for space asks.
   */
  space?: string;
}

/** Exact required-minimal param set (contract §D) — keys in this set and no more. */
export const ASK_PARAM_KEYS = [
  "attachments",
  "language",
  "timezone",
  "search_focus",
  "sources",
  "frontend_uuid",
  "mode",
  "model_preference",
  "is_incognito",
  "query_source",
  "source",
  "use_schematized_api",
  "version",
] as const;

export interface AskBody {
  params: Record<string, unknown>;
  query_str: string;
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Build the minimal ask body. New thread vs follow-up (adds last_backend_uuid,
 * read_write_token, query_source=followup, followup_source=link) vs attachment
 * (params.attachments = s3_object_urls) — frontend_uuid is fresh per request.
 * Never emits frontend_context_uuid / dsl_query / client_search_results_cache_key
 * / rum_session_id / time_from_first_type (first-message + telemetry fields).
 */
export function buildAskBody(opts: AskOptions): AskBody {
  const frontendUuid = crypto.randomUUID();
  const params: Record<string, unknown> = {
    attachments: opts.attachments && opts.attachments.length > 0 ? [...opts.attachments] : [],
    language: opts.language ?? "en-US",
    timezone: opts.timezone ?? defaultTimezone(),
    search_focus: "internet",
    sources: opts.sources && opts.sources.length > 0 ? [...opts.sources] : ["web"],
    frontend_uuid: frontendUuid,
    mode: "copilot",
    model_preference: opts.research ? RESEARCH_MODEL : opts.model ?? DEFAULT_MODEL,
    is_incognito: opts.incognito ?? true,
    query_source: "home",
    source: "default",
    use_schematized_api: true,
    version: "2.18",
  };
  if (opts.recency) params.search_recency_filter = opts.recency;
  if (opts.space) {
    params.target_collection_uuid = opts.space;
    params.target_thread_access_level = 5;
    params.query_source = "collection";
  }
  if (opts.followup) {
    params.last_backend_uuid = opts.followup.lastBackendUuid;
    params.read_write_token = opts.followup.readWriteToken;
    params.query_source = "followup";
    params.followup_source = "link";
  }
  return { params, query_str: opts.query };
}

/** Headers for the ask POST — x-request-id MUST equal params.frontend_uuid (verified c-01). */
export function askHeaders(frontendUuid: string): Record<string, string> {
  return { Accept: "text/event-stream", "x-request-id": frontendUuid };
}

export interface AskResult {
  answer: string;
  readWriteToken: string | null;
  backendUuid: string | null; // last entry uuid → next follow-up's last_backend_uuid
  threadUrl: string | null; // ORIGIN/search/<threadUrlSlug>
  followups: string[];
  model: string | null; // display_model from stream
  sources: WebResultRef[]; // citations from web_results blocks (may be empty, §I.8)
  images: GeneratedImage[]; // image-mode asks (may be empty); S3 urls are short-lived
}

export interface AskHooks {
  /** Called after each snapshot merge with the full answer so far. */
  onEvent?: (partialAnswer: string, ev: AskEvent) => void;
  signal?: AbortSignal | undefined;
}

/**
 * Submit an ask and consume the SSE stream to its terminal event
 * (status COMPLETED && final true; then end_of_stream ends the generator).
 */
export async function streamAsk(opts: AskOptions, hooks?: AskHooks): Promise<AskResult> {
  const body = buildAskBody(opts);
  const frontendUuid = body.params.frontend_uuid as string;
  const response = await apiPost("/rest/sse/perplexity_ask", body, askHeaders(frontendUuid), {
    sse: true,
    request_id: frontendUuid,
    signal: hooks?.signal,
  });
  if (!response.body) throw new Error("Ask stream: empty response body");

  const merger = new AskMerger();
  for await (const raw of readSseJson(response.body, hooks?.signal)) {
    const ev = parseAskEvent(raw);
    if (!ev) continue; // non-object snapshot — skip rather than trust the cast
    merger.merge(ev);
    hooks?.onEvent?.(merger.answerText(), ev);
    if (isTerminalEvent(ev)) {
      break; // drain handled by readSseJson (end_of_stream) / generator cancel
    }
  }
  const slug = merger.slug;
  return {
    answer: merger.answerText(),
    readWriteToken: merger.rwToken,
    backendUuid: merger.lastBackendUuid,
    threadUrl: slug ? `${ORIGIN}/search/${slug}` : null,
    followups: merger.followups(),
    model: merger.model,
    sources: merger.sources(),
    images: merger.images(),
  };
}
