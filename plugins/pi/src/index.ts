import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runPplxAsk } from "./pplx.js";
import { effectiveSourceCount, formatAskResult, threadSlugFromUrl } from "./format.js";
import { renderPerplexityCall } from "./render/call.js";
import { renderPerplexityResult } from "./render/result.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "perplexity_search",
    label: "Perplexity Search",
    description: "Search using the installed pplx CLI. Omitted options inherit CLI defaults. Authentication requires `pplx login` in a terminal; this tool never prompts.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query", minLength: 1 }),
      files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Local files to attach" })),
      thread: Type.Optional(Type.String({ description: "Thread slug or URL to continue", minLength: 1 })),
      continue: Type.Optional(Type.Boolean({ description: "Continue the latest live CLI session" })),
      recency: Type.Optional(StringEnum(["hour", "day", "week", "month", "year"] as const)),
      limit: Type.Optional(Type.Integer({ description: "Max sources to include in the result", minimum: 1, maximum: 50 })),
      model: Type.Optional(Type.String({ description: "Override the CLI model (see `pplx models`)", minLength: 1 })),
      sources: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Replace CLI source/connector defaults; use [\"web\"] for web-only search", minItems: 1 })),
      space: Type.Optional(Type.String({ description: "Override the CLI space by title or UUID", minLength: 1 })),
      incognito: Type.Optional(Type.Boolean({ description: "Explicit privacy choice: false keeps the chat in history. Omit to inherit CLI behavior." })),
    }),
    renderCall: renderPerplexityCall,
    renderResult: renderPerplexityResult,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const start = Date.now();
      try {
        if (!signal?.aborted) onUpdate?.({
          content: [{ type: "text", text: "Querying Perplexity via pplx…" }],
          details: { toolCallId },
        });
        const outcome = await runPplxAsk(params, signal, ctx?.cwd);
        if (outcome.kind !== "ok") {
          return {
            content: [{ type: "text", text: outcome.message }],
            details: { sourceCount: 0, queryMs: Date.now() - start, isError: true, cancelled: outcome.kind === "cancelled" },
          };
        }
        const result = outcome.result;
        const thread = threadSlugFromUrl(result.threadUrl);
        return {
          content: [{ type: "text", text: formatAskResult(result, params.limit) }],
          details: {
            model: result.model,
            sourceCount: effectiveSourceCount(result.sources?.length ?? 0, params.limit),
            queryMs: Date.now() - start,
            ...(thread ? { thread } : {}),
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Perplexity search failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { sourceCount: 0, queryMs: Date.now() - start, isError: true },
        };
      }
    },
  });
}
