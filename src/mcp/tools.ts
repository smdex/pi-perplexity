/**
 * MCP tool handlers for Perplexity search and deep research.
 *
 * These are the in-process twins of {@link ../cli.ts}'s `runSearch` (which the
 * Hermes plugin drives via subprocess JSON). They reuse the same auth → search →
 * format pipeline, but run inside the MCP server process with no subprocess.
 *
 * fastmcp-ts v1.5.0 does not surface an MCP client cancellation signal to tool
 * handlers (see docs/research-mcp-server.md), so each handler creates its own
 * timeout-backed AbortSignal — the same pattern as {@link ../cli.ts}'s
 * `createTimeoutSignal`. Client-initiated cancellation is therefore not
 * propagated; only the per-tool timeout aborts in-flight work.
 */
import { authenticate } from "../auth/login.js";
import { formatForLLM } from "../search/format.js";
import { searchPerplexity } from "../search/client.js";
import { AuthError, SearchError, type StoredToken } from "../search/types.js";
import { errorMessage } from "../util.js";

const DEFAULT_ASK_TIMEOUT_MS = 90_000;
const DEFAULT_DEEP_TIMEOUT_MS = 600_000;

export type Recency = "hour" | "day" | "week" | "month" | "year";

export interface SearchToolInput {
  query: string;
  recency?: Recency;
  limit?: number;
}

export interface DeepToolInput extends SearchToolInput {
  model?: string;
}

export interface ToolModelConfig {
  /** Model used by perplexity_search. */
  model: string;
  /** Default model used by perplexity_deep when the caller omits `model`. */
  deepModel: string;
}

export interface ToolDeps {
  authenticate: typeof authenticate;
  searchPerplexity: typeof searchPerplexity;
  formatForLLM: typeof formatForLLM;
}

const defaultDeps: ToolDeps = {
  authenticate,
  searchPerplexity,
  formatForLLM,
};

export type ProgressLogger = (message: string) => void | Promise<void>;

function timeoutSignal(envVar: string, defaultMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const raw = Number(process.env[envVar] ?? defaultMs);
  const ms = Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/** Map an auth/search failure to user-readable text. Never throws. */
export function failureText(error: unknown): string {
  if (error instanceof AuthError || (error instanceof SearchError && error.code === "AUTH")) {
    return `Authentication failed: ${error.message}\n\nRe-run \`pi /perplexity-login --force\` to re-authenticate.`;
  }
  if (error instanceof SearchError) {
    return `Perplexity search failed: ${error.message}`;
  }
  return `Perplexity search failed: ${errorMessage(error)}`;
}

function buildParams(query: string, model: string, recency?: Recency) {
  return { query, model, ...(recency !== undefined ? { recency } : {}) };
}

async function runTool(
  args: SearchToolInput,
  model: string,
  kind: "ask" | "deep",
  deps: ToolDeps,
  onProgress?: ProgressLogger,
): Promise<string> {
  const envVar = kind === "deep" ? "PI_PERPLEXITY_DEEP_TIMEOUT_MS" : "PI_PERPLEXITY_ASK_TIMEOUT_MS";
  const timeout = timeoutSignal(envVar, kind === "deep" ? DEFAULT_DEEP_TIMEOUT_MS : DEFAULT_ASK_TIMEOUT_MS);
  try {
    let auth: StoredToken;
    try {
      // Non-interactive: no prompt callbacks. Throws AuthError on no credential source.
      auth = await deps.authenticate({ signal: timeout.signal });
    } catch (error) {
      return failureText(error);
    }

    const result = await deps.searchPerplexity(
      buildParams(args.query, model, args.recency),
      auth,
      timeout.signal,
      kind === "deep" && onProgress
        ? (event, snapshot) => {
            const status = event.status?.trim() || event.text?.trim();
            const blockCount = snapshot.blocks?.length ?? 0;
            const message = status ?? `researching (${blockCount} blocks)`;
            void onProgress(message);
          }
        : undefined,
    );

    return deps.formatForLLM(result, args.limit);
  } catch (error) {
    return failureText(error);
  } finally {
    timeout.dispose();
  }
}

/** Handler for the `perplexity_search` MCP tool. Returns formatted text or a readable error string. */
export async function runSearchTool(
  args: SearchToolInput,
  cfg: ToolModelConfig,
  deps: ToolDeps = defaultDeps,
): Promise<string> {
  return runTool(args, cfg.model, "ask", deps);
}

/**
 * Handler for the `perplexity_deep` MCP tool. `perplexity_deep` runs the same
 * copilot pipeline as `perplexity_search` (Perplexity always receives
 * `mode: "copilot"`); the difference is the longer-running `pplx_alpha` model
 * (overridable per call), a longer timeout, and progress notifications.
 */
export async function runDeepTool(
  args: DeepToolInput,
  cfg: ToolModelConfig,
  deps: ToolDeps = defaultDeps,
  onProgress?: ProgressLogger,
): Promise<string> {
  return runTool(args, args.model ?? cfg.deepModel, "deep", deps, onProgress);
}
