import { describe, expect, it } from "bun:test";
import { ASK_PARAM_KEYS, askHeaders, buildAskBody, type AskOptions } from "../src/api/ask.js";
import { REAL_FOLLOWUP_BODY } from "./fixtures.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FORBIDDEN_KEYS = [
  "frontend_context_uuid", // first-message-only
  "dsl_query", // first-message-only
  "client_search_results_cache_key", // first-message-only
  "rum_session_id", // Datadog telemetry — stripped
  "time_from_first_type", // keystroke telemetry — stripped
] as const;

describe("buildAskBody — new thread", () => {
  it("params keys are exactly the required minimal set (contract §D)", () => {
    const body = buildAskBody({ query: "hi" });
    expect(Object.keys(body.params).sort()).toEqual([...ASK_PARAM_KEYS].slice().sort());
    expect(Object.keys(body).sort()).toEqual(["params", "query_str"]);
  });

  it("defaults: web source, incognito, copilot, gemini38flash, version 2.18", () => {
    const { params } = buildAskBody({ query: "hi" });
    expect(params.sources).toEqual(["web"]);
    expect(params.is_incognito).toBe(true);
    expect(params.mode).toBe("copilot");
    expect(params.model_preference).toBe("gemini38flash");
    expect(params.version).toBe("2.18");
    expect(params.query_source).toBe("home");
    expect(params.search_focus).toBe("internet");
    expect(params.source).toBe("default");
    expect(params.use_schematized_api).toBe(true);
    expect(params.attachments).toEqual([]);
  });

  it("frontend_uuid is a fresh uuid; query_str is top-level", () => {
    const a = buildAskBody({ query: "q" });
    const b = buildAskBody({ query: "q" });
    expect(UUID_RE.test(String(a.params.frontend_uuid))).toBe(true);
    expect(a.params.frontend_uuid).not.toBe(b.params.frontend_uuid);
    expect(a.query_str).toBe("q");
  });

  it("never emits forbidden first-message/telemetry fields", () => {
    const { params } = buildAskBody({ query: "q" });
    for (const key of FORBIDDEN_KEYS) expect(key in params).toBe(false);
  });

  it("applies overrides: model, sources, language, timezone, non-incognito", () => {
    const { params } = buildAskBody({
      query: "q",
      model: "glm_5_3_thinking",
      sources: ["scholar", "finance"],
      language: "de-DE",
      timezone: "UTC",
      incognito: false,
    });
    expect(params.model_preference).toBe("glm_5_3_thinking");
    expect(params.sources).toEqual(["scholar", "finance"]);
    expect(params.language).toBe("de-DE");
    expect(params.timezone).toBe("UTC");
    expect(params.is_incognito).toBe(false);
  });

  it("applies recency only when supplied", () => {
    expect(buildAskBody({ query: "q", recency: "week" }).params.search_recency_filter).toBe("week");
    expect("search_recency_filter" in buildAskBody({ query: "q" }).params).toBe(false);
  });

  it("attachments land in params.attachments (s3 urls only)", () => {
    const { params } = buildAskBody({ query: "q", attachments: ["https://s3/x.txt"] });
    expect(params.attachments).toEqual(["https://s3/x.txt"]);
  });
});

describe("buildAskBody — follow-up (contract §E)", () => {
  const followup: NonNullable<AskOptions["followup"]> = {
    // ask #2 continues from ask #1's entry uuid (NOT ask #2's own entry uuid)
    lastBackendUuid: "00000066-0000-4000-8000-000000000000",
    readWriteToken: "00000068-0000-4000-8000-000000000000",
  };

  it("adds the four thread-continuation fields", () => {
    const { params } = buildAskBody({ query: "next", followup });
    expect(params.last_backend_uuid).toBe(followup.lastBackendUuid);
    expect(params.read_write_token).toBe(followup.readWriteToken);
    expect(params.query_source).toBe("followup");
    expect(params.followup_source).toBe("link");
  });

  it("still omits the forbidden fields", () => {
    const { params } = buildAskBody({ query: "next", followup });
    for (const key of FORBIDDEN_KEYS) expect(key in params).toBe(false);
  });

  it("minimal body is a subset of the real captured follow-up body, matching all shared R-fields", () => {
    // Regression against c-trace ask #2: every key we send must exist in the real
    // body with the same value (except per-request/option fields).
    const { params } = buildAskBody({
      query: REAL_FOLLOWUP_BODY.query_str,
      model: String(REAL_FOLLOWUP_BODY.params.model_preference),
      sources: REAL_FOLLOWUP_BODY.params.sources as string[],
      language: String(REAL_FOLLOWUP_BODY.params.language),
      timezone: String(REAL_FOLLOWUP_BODY.params.timezone),
      attachments: REAL_FOLLOWUP_BODY.params.attachments as string[],
      followup,
    });
    const real = REAL_FOLLOWUP_BODY.params;
    for (const [key, value] of Object.entries(params)) {
      expect(key in real).toBe(true);
      if (key === "frontend_uuid") continue; // fresh per request by design
      expect(value).toEqual(real[key]);
    }
    expect(params.frontend_uuid).not.toBe(real.frontend_uuid); // fresh, not replayed
  });
});

describe("buildAskBody — research variant (r-summary §1: pplx_alpha, no cache key)", () => {
  it("model_preference=pplx_alpha; no search_mode, no client_search_results_cache_key; mode stays copilot", () => {
    const { params } = buildAskBody({ query: "q", research: true });
    expect(params.model_preference).toBe("pplx_alpha");
    expect(params.mode).toBe("copilot"); // mode is NOT the carrier
    expect("search_mode" in params).toBe(false);
    expect("client_search_results_cache_key" in params).toBe(false);
  });

  it("research overrides --model (the web client swaps the engine to pplx_alpha)", () => {
    const { params } = buildAskBody({ query: "q", research: true, model: "glm_5_3_thinking" });
    expect(params.model_preference).toBe("pplx_alpha");
  });

  it("diff vs the normal ask body is model_preference ONLY (everything else identical)", () => {
    const normal = buildAskBody({ query: "q" }).params;
    const research = buildAskBody({ query: "q", research: true }).params;
    expect(Object.keys(research).sort()).toEqual(Object.keys(normal).sort());
    for (const key of Object.keys(normal)) {
      if (key === "model_preference" || key === "frontend_uuid") continue; // fresh uuid per request
      expect(research[key]).toEqual(normal[key]);
    }
    expect(normal.model_preference).toBe("gemini38flash");
  });

  it("plain search never emits search_mode (matches captured bodies)", () => {
    expect("search_mode" in buildAskBody({ query: "q" }).params).toBe(false);
  });
});

describe("askHeaders", () => {
  it("requests the SSE content type and mirrors frontend_uuid into x-request-id", () => {
    const uuid = crypto.randomUUID();
    const headers = askHeaders(uuid);
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers["x-request-id"]).toBe(uuid);
  });
});
