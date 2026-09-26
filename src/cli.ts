import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { extractFromDesktopApp, authenticate, type AuthCredentials } from "./auth/login.js";
import { loadToken } from "./auth/storage.js";
import { loadConfig, resolveDefaultModel } from "./config.js";
import { searchPerplexity } from "./search/client.js";
import { uploadAttachments } from "./search/upload.js";
import { AuthError, SearchError, type SearchResult } from "./search/types.js";
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
  files?: string[];
}

export interface DeepArguments extends AskArguments {
  model?: string;
}

export interface CliArguments {
  subcommand: "ask" | "deep" | "auth-status";
  search?: AskArguments | DeepArguments;
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
  uploadAttachments: typeof uploadAttachments;
}

const defaultDependencies: CliDependencies = {
  loadToken,
  extractFromDesktopApp,
  authenticate,
  loadConfig,
  resolveDefaultModel,
  searchPerplexity,
  uploadAttachments,
};

function invalidArguments(message: string): Error {
  return new Error(`Invalid CLI arguments: ${message}`);
}

export function parseCliArguments(argv: readonly string[]): CliArguments {
  const [subcommand, ...tokens] = argv;
  if (subcommand !== "ask" && subcommand !== "deep" && subcommand !== "auth-status") {
    throw invalidArguments("subcommand must be ask, deep, or auth-status");
  }
  if (subcommand === "auth-status") {
    if (tokens.length) throw invalidArguments("auth-status does not accept arguments");
    return { subcommand };
  }

  const query: string[] = [];
  const files: string[] = [];
  const values: Record<string, string> = {};
  const allowed = subcommand === "deep" ? ["recency", "limit", "attach", "model"] : ["recency", "limit", "attach"];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.startsWith("--")) { query.push(token); continue; }
    const equal = token.indexOf("=");
    const name = token.slice(2, equal < 0 ? undefined : equal);
    if (!allowed.includes(name)) throw invalidArguments(`unknown flag: --${name}`);
    const value = equal < 0 ? tokens[++i] : token.slice(equal + 1);
    if (value === undefined || value.startsWith("--")) throw invalidArguments(`--${name} requires a value`);
    if (name === "attach") {
      const paths = value.split(",").map((path) => path.trim()).filter(Boolean);
      if (!paths.length) throw invalidArguments("--attach requires at least one file path");
      files.push(...paths);
    } else {
      if (values[name] !== undefined) throw invalidArguments(`--${name} may only be specified once`);
      values[name] = value;
    }
  }
  const queryText = query.join(" ").trim();
  if (!queryText) throw invalidArguments(`${subcommand} requires a non-empty query`);
  const search: AskArguments | DeepArguments = { query: queryText };
  if (values.recency !== undefined) {
    if (!(RECENCIES as readonly string[]).includes(values.recency)) throw invalidArguments("recency must be hour, day, week, month, or year");
    search.recency = values.recency as Recency;
  }
  if (values.limit !== undefined) {
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalidArguments("limit must be an integer from 1 to 50");
    search.limit = limit;
  }
  if (files.length) search.files = files;
  if (subcommand === "deep" && values.model !== undefined) {
    if (!values.model.trim()) throw invalidArguments("model must be a non-empty string");
    (search as DeepArguments).model = values.model;
  }
  return { subcommand, search };
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
    let auth: AuthCredentials;
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
    const attachments = args.files?.length
      ? await deps.uploadAttachments(args.files.map((path) => ({ path })), auth, timeout.signal)
      : [];
    const result = await deps.searchPerplexity(
      {
        query: args.query,
        model,
        ...(attachments.length ? { attachments } : {}),
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
    if (args.files?.length) payload.attachments = args.files.map((path) => path.split(/[\\/]/).pop() ?? path);
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
    return await runSearch(parsed.search!, parsed.subcommand as "ask" | "deep", deps);
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
