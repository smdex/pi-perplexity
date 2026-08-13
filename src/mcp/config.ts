/**
 * MCP server configuration.
 *
 * Resolution order for every setting (highest priority first):
 *   CLI flag → environment variable → config file → hardcoded default.
 *
 * The `model` tier composes the existing {@link resolveDefaultModel} chain
 * (env → file → default); the `--model` flag layers on top of it. The MCP
 * server adds no new config-file keys — it reuses `~/.config/pi-perplexity/config.json`.
 */
import { parseArgs } from "node:util";

import { getConfigPath, loadConfig, resolveDefaultModel } from "../config.js";

export const DEFAULT_MODEL = "pplx_pro_upgraded";
export const DEFAULT_DEEP_MODEL = "pplx_alpha";

export type Transport = "stdio" | "http";

export interface RunOptionsInput {
  transport: Transport;
  /** Present only for the http transport. */
  host?: string;
  port?: number;
  path?: string;
}

export interface McpRunConfig {
  model: string;
  deepModel: string;
  runOptions: RunOptionsInput;
}

export interface ParsedFlags {
  help: boolean;
  model?: string;
  deepModel?: string;
  configPath?: string;
  transport?: Transport;
  host?: string;
  port?: string;
  path?: string;
  allowPublic: boolean;
}

export interface McpConfigDeps {
  loadConfig: typeof loadConfig;
  resolveDefaultModel: typeof resolveDefaultModel;
  getConfigPath: typeof getConfigPath;
}

const defaultDeps: McpConfigDeps = {
  loadConfig,
  resolveDefaultModel,
  getConfigPath,
};

const FLAG_OPTIONS = {
  model: { type: "string" as const },
  "deep-model": { type: "string" as const },
  config: { type: "string" as const },
  transport: { type: "string" as const },
  host: { type: "string" as const },
  port: { type: "string" as const },
  path: { type: "string" as const },
  "allow-public": { type: "boolean" as const, default: false },
  help: { type: "boolean" as const, short: "h", default: false },
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/** Parse MCP server CLI flags. Pure: no I/O. Throws on malformed flag values. */
export function parseFlags(argv: readonly string[] = process.argv.slice(2)): ParsedFlags {
  const { values } = parseArgs({
    options: FLAG_OPTIONS,
    args: [...argv],
    allowNegativeFlags: true,
  });

  const transport = typeof values.transport === "string" ? values.transport : undefined;
  if (transport !== undefined && transport !== "stdio" && transport !== "http") {
    throw new Error(`--transport must be "stdio" or "http", got "${transport}"`);
  }

  let port: string | undefined;
  if (typeof values.port === "string") {
    const parsed = Number(values.port);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new Error(`--port must be a positive integer, got "${values.port}"`);
    }
    port = values.port;
  }

  return {
    help: Boolean(values.help),
    ...(typeof values.model === "string" ? { model: values.model } : {}),
    ...(typeof values["deep-model"] === "string" ? { deepModel: values["deep-model"] } : {}),
    ...(typeof values.config === "string" ? { configPath: values.config } : {}),
    ...(transport !== undefined ? { transport } : {}),
    ...(typeof values.host === "string" ? { host: values.host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(typeof values.path === "string" ? { path: values.path } : {}),
    allowPublic: Boolean(values["allow-public"]),
  };
}

function envTransport(): Transport | undefined {
  const raw = process.env.MCP_TRANSPORT?.trim().toLowerCase();
  if (!raw) return undefined;
  if (raw !== "stdio" && raw !== "http") {
    throw new Error(`MCP_TRANSPORT must be "stdio" or "http", got "${raw}"`);
  }
  return raw;
}

/**
 * Resolve the full MCP run config by merging flag → env → file → default.
 * Throws on an unsafe HTTP bind (non-loopback host without explicit opt-in)
 * or a malformed config file.
 */
export async function resolveMcpConfig(
  argv: readonly string[] = process.argv.slice(2),
  deps: McpConfigDeps = defaultDeps,
): Promise<McpRunConfig> {
  const flags = parseFlags(argv);
  const configPath = flags.configPath ?? deps.getConfigPath();
  // Malformed/unreadable config surfaces here (loadConfig throws on parse error).
  const fileConfig = await deps.loadConfig(configPath);

  // flag → env (via resolveDefaultModel) → file → default
  const model = flags.model ?? deps.resolveDefaultModel(fileConfig);

  const envDeepModel = process.env.PI_PERPLEXITY_DEEP_MODEL?.trim() || undefined;
  const deepModel = flags.deepModel ?? envDeepModel ?? DEFAULT_DEEP_MODEL;

  const transport = flags.transport ?? envTransport() ?? "stdio";

  const runOptions = buildRunOptions(flags, transport);

  return { model, deepModel, runOptions };
}

function buildRunOptions(flags: ParsedFlags, transport: Transport): RunOptionsInput {
  if (transport === "stdio") {
    return { transport };
  }

  const host = (flags.host ?? process.env.MCP_HOST?.trim()) || "127.0.0.1";

  if (!LOOPBACK_HOSTS.has(host) && !flags.allowPublic && process.env.PI_PERPLEXITY_ALLOW_PUBLIC !== "1") {
    throw new Error(
      `Refusing to bind HTTP transport to non-loopback host "${host}". ` +
        'MCP servers carry your Perplexity credentials. To allow a public bind, pass --allow-public ' +
        "or set PI_PERPLEXITY_ALLOW_PUBLIC=1, and ensure the server is fronted by a trusted reverse proxy with MCP authentication.",
    );
  }

  const portEnv = process.env.MCP_PORT?.trim() || process.env.PORT?.trim();
  const portRaw = flags.port ?? portEnv;
  const port = portRaw !== undefined ? Number(portRaw) : 3000;

  const path = (flags.path ?? process.env.MCP_PATH?.trim()) || "/mcp";

  const opts: RunOptionsInput = { transport, host, port, path };
  return opts;
}

export const HELP_TEXT = `pi-perplexity MCP server

Exposes Perplexity (Pro/Max subscription) search to any MCP client.

Usage:
  pi-perplexity-mcp [options]

Options:
  --model <id>           Perplexity model for perplexity_search
                          (env: PI_PERPLEXITY_MODEL; default: ${DEFAULT_MODEL})
  --deep-model <id>      Model for perplexity_deep
                          (env: PI_PERPLEXITY_DEEP_MODEL; default: ${DEFAULT_DEEP_MODEL})
  --config <path>        Config file path (default: ~/.config/pi-perplexity/config.json)
  --transport <type>     stdio | http (env: MCP_TRANSPORT; default: stdio)
  --host <addr>          HTTP bind host (env: MCP_HOST; default: 127.0.0.1)
  --port <n>             HTTP port (env: MCP_PORT/PORT; default: 3000)
  --path <path>          HTTP endpoint path (env: MCP_PATH; default: /mcp)
  --allow-public         Allow non-loopback HTTP bind (use only behind a trusted proxy)
  -h, --help             Show this help and exit

Requires Node >= 22 (the @prefecthq/fastmcp-ts runtime requirement).
Authenticate first with: pi /perplexity-login
`;
