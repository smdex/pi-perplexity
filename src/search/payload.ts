import type { SearchResult } from "./types.js";

/**
 * Structured result shared by every machine-facing surface (CLI stdout, MCP
 * tools). Serialized as TOON by default, JSON on explicit request.
 */
export function buildSearchPayload(result: SearchResult, limit?: number): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ok: true,
    answer: result.answer,
    sources: limit === undefined ? result.sources : result.sources.slice(0, limit),
  };
  if (result.displayModel !== undefined) payload.displayModel = result.displayModel;
  if (result.uuid !== undefined) payload.uuid = result.uuid;
  return payload;
}
