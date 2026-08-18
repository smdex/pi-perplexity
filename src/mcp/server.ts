/**
 * MCP server entry: builds a {@link FastMCP} instance exposing pi-perplexity
 * search to any MCP client (Claude Desktop, Cursor, etc.) over stdio or HTTP.
 *
 * The server reuses the subscription-backed search stack from the pi extension,
 * with no subprocess and no extra credentials. Requires Node >= 22 (the
 * @prefecthq/fastmcp-ts runtime requirement); the extension entry in
 * `src/index.ts` is unaffected and keeps the repo's Node >= 18.14.1 floor.
 */
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { z } from "zod";
import { FastMCP } from "@prefecthq/fastmcp-ts/server";

import { HELP_TEXT, parseFlags, resolveMcpConfig, type McpRunConfig } from "./config.js";
import { runDeepTool, runSearchTool, type ToolDeps, type ToolModelConfig } from "./tools.js";
import { errorMessage } from "../util.js";

const SERVER_NAME = "pi-perplexity";
const SERVER_VERSION = "0.4.0";

const recencySchema = z
  .enum(["hour", "day", "week", "month", "year"])
  .describe("Filter results by age: hour, day, week, month, or year");

const formatSchema = z
  .enum(["toon", "json"])
  .describe("Output serialization: TOON (default, token-efficient) or JSON");

export const searchInput = z.object({
  query: z.string().min(1).describe("The search query"),
  recency: recencySchema.optional(),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum number of sources to include (1-50)"),
  format: formatSchema.optional(),
});

export const deepInput = searchInput.extend({
  model: z.string().min(1).optional().describe("Perplexity model id (defaults to pplx_alpha)"),
});

const SEARCH_DESCRIPTION = [
  "Search the web using Perplexity (Pro/Max subscription) with synthesized answer",
  "and numbered source citations. Use for questions requiring up-to-date web",
  "information. Queries always run incognito. Requires prior `pi /perplexity-login`.",
].join(" ");

const DEEP_DESCRIPTION = [
  "Long-running Perplexity research (pplx_alpha model). Same copilot pipeline as",
  "perplexity_search but with a longer timeout and progress notifications; best for",
  "multi-step research questions. Requires prior `pi /perplexity-login`.",
].join(" ");

export interface CreateServerOptions {
  config: ToolModelConfig;
  deps?: ToolDeps;
}

/** Strip zod's `| undefined` inference so the value matches exactOptionalPropertyTypes. */
function toSearchInput(args: z.infer<typeof searchInput>) {
  return {
    query: args.query,
    ...(args.recency !== undefined ? { recency: args.recency } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.format !== undefined ? { format: args.format } : {}),
  };
}

function toDeepInput(args: z.infer<typeof deepInput>) {
  return {
    query: args.query,
    ...(args.recency !== undefined ? { recency: args.recency } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.format !== undefined ? { format: args.format } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
  };
}

/** Build the FastMCP server with both tools registered. Pure: does not start serving. */
export function createServer({ config, deps }: CreateServerOptions): FastMCP {
  const server = new FastMCP({ name: SERVER_NAME, version: SERVER_VERSION });

  server.tool(
    { name: "perplexity_search", description: SEARCH_DESCRIPTION, input: searchInput },
    async (args) =>
      runSearchTool(toSearchInput(args), config, deps),
  );

  server.tool(
    { name: "perplexity_deep", description: DEEP_DESCRIPTION, input: deepInput },
    async (args) => {
      const ctx = server.getContext();
      return runDeepTool(toDeepInput(args), config, deps, async (message) => {
        await ctx.info(message);
      });
    },
  );

  return server;
}

function modelsFromConfig(cfg: McpRunConfig): ToolModelConfig {
  return { model: cfg.model, deepModel: cfg.deepModel };
}

/** Parse flags, build config + server, and start serving. Resolves only on shutdown. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const flags = parseFlags(argv);
  if (flags.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const cfg = await resolveMcpConfig(argv);
  const server = createServer({ config: modelsFromConfig(cfg) });
  await server.run(cfg.runOptions);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`pi-perplexity MCP server failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
