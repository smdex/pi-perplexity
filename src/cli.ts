import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { extractFromDesktopApp, authenticate } from "./auth/login.js";
import { loadToken } from "./auth/storage.js";
import { loadConfig, resolveDefaultModel } from "./config.js";
import { searchPerplexity } from "./search/client.js";
import { AuthError, SearchError, type SearchResult, type StoredToken } from "./search/types.js";
import { errorMessage } from "./util.js";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_DEEP_TIMEOUT_MS = 600_000;
const DEEP_MODEL = "pplx_alpha";
const RECENCIES = ["hour", "day", "week", "month", "year"] as const;
type Recency = (typeof RECENCIES)[number];

export interface AskArguments {
  query: string;
  recency?: Recency;
  limit?: number;
}

export interface DeepArguments extends AskArguments {
  model?: string;
}

export interface CliArguments {
  subcommand: "ask" | "deep" | "auth-status";
  rawArgs?: string;
}

export interface CliOutput {
  exitCode: number;
  payload: Record<string, unknown>;
}

export interface CliDependencies {
  loadToken: typeof loadToken;
  extractFromDesktopApp: typeof extractFromDesktopApp;
  authenticate: typeof authenticate;
  loadConfig: typeof loadConfig;
  resolveDefaultModel: typeof resolveDefaultModel;
  searchPerplexity: typeof searchPerplexity;
}

const defaultDependencies: CliDependencies = {
  loadToken,
  extractFromDesktopApp,
  authenticate,
  loadConfig,
  resolveDefaultModel,
  searchPerplexity,
};

function invalidArguments(message: string): Error {
  return new Error(`Invalid CLI arguments: ${message}`);
}

export function parseCliArguments(argv: readonly string[]): CliArguments {
  const [subcommand, rawArgs, ...extra] = argv;
  if (extra.length > 0) {
    throw invalidArguments("expected one JSON argument");
  }

  if (subcommand !== "ask" && subcommand !== "deep" && subcommand !== "auth-status") {
    throw invalidArguments("subcommand must be ask, deep, or auth-status");
  }

  if (subcommand === "auth-status" && rawArgs !== undefined) {
    throw invalidArguments("auth-status does not accept arguments");
  }

  return { subcommand, ...(rawArgs !== undefined ? { rawArgs } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSearchArguments(rawArgs: string | undefined, command: "ask" | "deep"): AskArguments | DeepArguments {
  if (rawArgs === undefined) {
    throw invalidArguments(`${command} requires a JSON object argument`);
  }

  let value: unknown;
  try {
    value = JSON.parse(rawArgs) as unknown;
  } catch (error) {
    throw invalidArguments(`arguments are not valid JSON: ${errorMessage(error)}`);
  }

  if (!isRecord(value)) {
    throw invalidArguments(`${command} arguments must be a JSON object`);
  }

  if (typeof value.query !== "string" || value.query.trim().length === 0) {
    throw invalidArguments("query must be a non-empty string");
  }

  const result: AskArguments | DeepArguments = { query: value.query };

  if (value.recency !== undefined) {
    if (typeof value.recency !== "string" || !(RECENCIES as readonly string[]).includes(value.recency)) {
      throw invalidArguments("recency must be hour, day, week, month, or year");
    }
    result.recency = value.recency as Recency;
  }

  if (value.limit !== undefined) {
    if (typeof value.limit !== "number" || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 50) {
      throw invalidArguments("limit must be an integer from 1 to 50");
    }
    result.limit = value.limit;
  }

  if (command === "deep" && value.model !== undefined) {
    if (typeof value.model !== "string" || value.model.trim().length === 0) {
      throw invalidArguments("model must be a non-empty string");
    }
    (result as DeepArguments).model = value.model;
  }

  return result;
}

export function parseAskArguments(rawArgs?: string): AskArguments {
  return parseSearchArguments(rawArgs, "ask") as AskArguments;
}

export function parseDeepArguments(rawArgs?: string): DeepArguments {
  return parseSearchArguments(rawArgs, "deep") as DeepArguments;
}

function authErrorPayload(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : errorMessage(error);
  return {
    ok: false,
    code: "AUTH",
    error: `${message} Please run: pi /perplexity-login --force.`,
  };
}

function failurePayload(error: unknown): Record<string, unknown> {
  if (error instanceof AuthError || (error instanceof SearchError && error.code === "AUTH")) {
    return authErrorPayload(error);
  }

  return { ok: false, error: error instanceof Error ? error.message : errorMessage(error) };
}

function createTimeoutSignal(kind: "ask" | "deep"): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const defaultTimeout = kind === "deep" ? DEFAULT_DEEP_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const envName = kind === "deep" ? "PI_PERPLEXITY_DEEP_TIMEOUT_MS" : "PI_PERPLEXITY_ASK_TIMEOUT_MS";
  const rawTimeout = Number(process.env[envName] ?? defaultTimeout);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : defaultTimeout;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function limitedSources(result: SearchResult, limit?: number): SearchResult["sources"] {
  return limit === undefined ? result.sources : result.sources.slice(0, limit);
}

async function runAuthStatus(deps: CliDependencies): Promise<CliOutput> {
  const cached = await deps.loadToken();
  if (cached) {
    return { exitCode: 0, payload: { ok: true, authed: true, source: "cached" } };
  }

  if (process.env.PI_AUTH_NO_BORROW !== "1") {
    const desktopToken = await deps.extractFromDesktopApp();
    if (desktopToken) {
      return { exitCode: 0, payload: { ok: true, authed: true, source: "desktop" } };
    }
  }

  return { exitCode: 0, payload: { ok: true, authed: false, source: "none" } };
}

function writeDeepProgress(event: { status?: string; text?: string }, snapshot: { blocks?: unknown[] }): void {
  const status = typeof event.status === "string" && event.status.trim() ? event.status.trim() : undefined;
  const text = typeof event.text === "string" && event.text.trim() ? event.text.trim() : undefined;
  const blockCount = snapshot.blocks?.length ?? 0;
  const message = status ?? text ?? `received update (${blockCount} blocks)`;
  process.stderr.write(`[perplexity-deep] ${message}\n`);
}

async function runSearch(
  args: AskArguments | DeepArguments,
  kind: "ask" | "deep",
  deps: CliDependencies,
): Promise<CliOutput> {
  const timeout = createTimeoutSignal(kind);
  try {
    let auth: StoredToken;
    try {
      // Deliberately omit prompt callbacks: this entry point must never interactively prompt.
      auth = await deps.authenticate({ signal: timeout.signal });
    } catch (error) {
      return {
        exitCode: 1,
        payload: error instanceof AuthError ? authErrorPayload(error) : failurePayload(error),
      };
    }

    const config = await deps.loadConfig();
    const model = kind === "deep"
      ? (args as DeepArguments).model ?? DEEP_MODEL
      : deps.resolveDefaultModel(config);
    const result = await deps.searchPerplexity(
      {
        query: args.query,
        model,
        ...(args.recency !== undefined ? { recency: args.recency } : {}),
      },
      auth,
      timeout.signal,
      kind === "deep" ? writeDeepProgress : undefined,
    );

    const payload: Record<string, unknown> = {
      ok: true,
      answer: result.answer,
      sources: limitedSources(result, args.limit),
    };
    if (result.displayModel !== undefined) payload.displayModel = result.displayModel;
    if (result.uuid !== undefined) payload.uuid = result.uuid;
    return { exitCode: 0, payload };
  } catch (error) {
    return { exitCode: 1, payload: failurePayload(error) };
  } finally {
    timeout.dispose();
  }
}

export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  deps: CliDependencies = defaultDependencies,
): Promise<CliOutput> {
  try {
    const parsed = parseCliArguments(argv);
    if (parsed.subcommand === "auth-status") {
      return await runAuthStatus(deps);
    }
    if (parsed.subcommand === "deep") {
      return await runSearch(parseDeepArguments(parsed.rawArgs), "deep", deps);
    }
    return await runSearch(parseAskArguments(parsed.rawArgs), "ask", deps);
  } catch (error) {
    return { exitCode: 1, payload: failurePayload(error) };
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const result = await runCli(argv);
  process.stdout.write(`${JSON.stringify(result.payload)}\n`);
  if (result.exitCode !== 0) {
    process.exitCode = result.exitCode;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: errorMessage(error) })}\n`);
    process.exitCode = 1;
  });
}
