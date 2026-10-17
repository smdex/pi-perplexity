import { spawn } from "node:child_process";

/**
 * pplx subprocess bridge.
 *
 * The pi extension delegates every Perplexity request to the installed `pplx`
 * CLI (`pplx ask --json`), inheriting its authentication, defaults, and wire
 * handling. No network, auth, or Perplexity-protocol code lives in this
 * package; unspecified options are omitted from the argv so the CLI's own
 * defaults (built-ins and its config file) apply.
 */

/** Tool parameters that map onto `pplx ask` flags. */
export interface PplxAskParams {
  query: string;
  model?: string;
  recency?: "hour" | "day" | "week" | "month" | "year";
  sources?: string[];
  files?: string[];
  thread?: string;
  continue?: boolean;
  space?: string;
  incognito?: boolean;
}

/** Loose mirror of the CLI's `--json` AskResult (every field best-effort). */
export interface AskResultJson {
  answer: string;
  readWriteToken?: string | null;
  backendUuid?: string | null;
  threadUrl?: string | null;
  followups?: string[];
  model?: string | null;
  sources?: Array<{ name?: string; url?: string; snippet?: string; timestamp?: string }>;
  images?: Array<{ url: string; filename?: string; caption?: string; width?: number; height?: number }>;
}

export type PplxOutcome =
  | { kind: "ok"; result: AskResultJson }
  | { kind: "auth"; message: string }
  | { kind: "error"; message: string }
  | { kind: "cancelled"; message: string };

const PPLX_BINARY = "pplx";
const STDOUT_LIMIT_BYTES = 20 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2_000;
const KILL_GRACE_MS = 5_000;
const INSTALL_HINT =
  "`pplx` executable not found on PATH — install the pplx CLI from this repository (see its README), then retry.";

/** Extract a thread slug from a bare uuid, a /search/<uuid> URL, or a full thread URL. */
export function threadSlugFromRef(ref: string): string {
  const match = ref.match(/\/search\/([0-9a-f-]{36})/i);
  if (match?.[1]) return match[1];
  return ref.trim();
}

function pushFlag(argv: string[], flag: string, value: string | undefined): void {
  if (value === undefined) return;
  if (!value.trim()) throw new Error(`${flag} requires a nonempty value`);
  argv.push(`${flag}=${value}`);
}

/** Build the exact `pplx ask --json` argv for the given tool params. */
export function buildAskArgv(params: PplxAskParams): string[] {
  const query = params.query.trim();
  if (!query) throw new Error("query is required");

  // yargs does not bind tokens after `--` to this command's required
  // positional. Place the query before array flags; prefix option-looking
  // text with whitespace, which executeAsk already trims before submission.
  const argv = ["ask", "--json", query.startsWith("-") ? ` ${query}` : query];
  pushFlag(argv, "--model", params.model);
  pushFlag(argv, "--recency", params.recency);
  if (params.sources !== undefined && params.sources.length === 0) {
    throw new Error("sources must be a nonempty list; omit it to inherit CLI defaults, or use [\"web\"] for web-only search");
  }
  for (const source of params.sources ?? []) pushFlag(argv, "--sources", source);
  for (const file of params.files ?? []) {
    pushFlag(argv, "--attach", file);
  }
  pushFlag(argv, "--thread", params.thread === undefined ? undefined : threadSlugFromRef(params.thread));
  if (params.continue === true) argv.push("--continue");
  pushFlag(argv, "--space", params.space);
  if (params.incognito !== undefined) argv.push(params.incognito ? "--incognito" : "--no-incognito");
  return argv;
}

interface ParsedJson {
  object?: Record<string, unknown>;
  malformed: boolean;
}

function parseStdout(text: string): ParsedJson {
  try {
    const value: unknown = JSON.parse(text.trim());
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { object: value as Record<string, unknown>, malformed: false };
    }
  } catch {
    // fall through
  }
  return { malformed: true };
}

function errorMessageFrom(parsed: ParsedJson, stderrTail: string, fallback: string): string {
  const err = parsed.object?.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  if (stderrTail.trim()) return stderrTail.trim();
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isResult(object: Record<string, unknown> | undefined): boolean {
  if (!object || typeof object.answer !== "string") return false;
  for (const key of ["model", "threadUrl", "readWriteToken", "backendUuid"]) {
    if (object[key] != null && typeof object[key] !== "string") return false;
  }
  if (object.followups !== undefined && (!Array.isArray(object.followups) || !object.followups.every((f) => typeof f === "string"))) return false;
  if (object.sources !== undefined && (!Array.isArray(object.sources) || !object.sources.every((s) =>
    isRecord(s) && ["name", "url", "snippet", "timestamp"].every((key) => s[key] === undefined || typeof s[key] === "string")))) return false;
  if (object.images !== undefined && (!Array.isArray(object.images) || !object.images.every((image) =>
    isRecord(image) && typeof image.url === "string" &&
    ["filename", "caption"].every((key) => image[key] === undefined || typeof image[key] === "string") &&
    ["width", "height"].every((key) => image[key] === undefined || (typeof image[key] === "number" && Number.isFinite(image[key])))))) return false;
  return true;
}

function normalizeResult(object: Record<string, unknown>): AskResultJson {
  const answer = typeof object.answer === "string" ? object.answer : "";
  return {
    answer,
    readWriteToken: typeof object.readWriteToken === "string" ? object.readWriteToken : null,
    backendUuid: typeof object.backendUuid === "string" ? object.backendUuid : null,
    threadUrl: typeof object.threadUrl === "string" ? object.threadUrl : null,
    followups: Array.isArray(object.followups) ? object.followups.filter((f) => typeof f === "string") : [],
    model: typeof object.model === "string" ? object.model : null,
    sources: Array.isArray(object.sources)
      ? object.sources.filter(
          (s): s is NonNullable<AskResultJson["sources"]>[number] => s !== null && typeof s === "object" && !Array.isArray(s),
        )
      : [],
    images: Array.isArray(object.images)
      ? object.images.filter(
          (s): s is NonNullable<AskResultJson["images"]>[number] => s !== null && typeof s === "object" && !Array.isArray(s),
        )
      : [],
  };
}

/**
 * Run `pplx ask --json` and map the process outcome onto a PplxOutcome.
 * Cancellation (AbortSignal) terminates the child: SIGTERM, then SIGKILL after
 * a grace period; the process is always awaited (reaped) before returning.
 */
export async function runPplxAsk(params: PplxAskParams, signal?: AbortSignal, cwd?: string): Promise<PplxOutcome> {
  if (signal?.aborted) {
    return { kind: "cancelled", message: "Perplexity search was cancelled before it started." };
  }
  const argv = buildAskArgv(params);

  let child;
  try {
    child = spawn(PPLX_BINARY, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, PPLX_NO_SPINNER: "1" },
      windowsHide: true,
      // An owned POSIX group also covers non-exec PATH wrappers.
      detached: process.platform !== "win32",
    });
  } catch {
    return { kind: "error", message: INSTALL_HINT };
  }

  let stdout = "";
  let stdoutOverflow = false;
  let stderrTail = "";
  let spawnError: NodeJS.ErrnoException | undefined;

  let stdoutBytes = 0;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk);
    if (stdoutBytes > STDOUT_LIMIT_BYTES) {
      stdoutOverflow = true;
      return;
    }
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });

  let killTimer: NodeJS.Timeout | undefined;
  const terminate = (signalName: NodeJS.Signals): void => {
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, signalName); } catch { /* group already exited */ }
    } else {
      child.kill(signalName);
    }
  };
  const onAbort = (): void => {
    terminate("SIGTERM");
    killTimer = setTimeout(() => terminate("SIGKILL"), KILL_GRACE_MS);
    killTimer.unref?.();
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.once("close", (code, signalName) => resolve({ code, signal: signalName }));
  });
  const outcome = await closed;

  if (killTimer) clearTimeout(killTimer);
  signal?.removeEventListener("abort", onAbort);

  const aborted = signal?.aborted === true;
  if (aborted || outcome.signal === "SIGTERM" || outcome.signal === "SIGINT" || outcome.code === 130) {
    return { kind: "cancelled", message: "Perplexity search was cancelled." };
  }

  if (spawnError?.code === "ENOENT") {
    return { kind: "error", message: INSTALL_HINT };
  }
  if (spawnError) {
    return { kind: "error", message: `failed to start \`pplx\`: ${spawnError.message}` };
  }
  if (stdoutOverflow) {
    return { kind: "error", message: `\`pplx\` produced more than ${STDOUT_LIMIT_BYTES} bytes of output` };
  }

  const parsed = parseStdout(stdout);
  const okResult = !parsed.malformed && isResult(parsed.object);

  if (outcome.code === 0) {
    if (okResult) return { kind: "ok", result: normalizeResult(parsed.object!) };
    return {
      kind: "error",
      message: errorMessageFrom(
        parsed,
        stderrTail,
        "`pplx` exited successfully but its output could not be parsed as a JSON result",
      ),
    };
  }

  if (outcome.code === 2) {
    const message = errorMessageFrom(parsed, stderrTail, "Perplexity authentication failed.");
    const withHint = message.includes("pplx login")
      ? message
      : `${message} Run \`pplx login\` in a terminal to authenticate.`;
    return { kind: "auth", message: withHint };
  }

  return {
    kind: "error",
    message: errorMessageFrom(
      parsed,
      stderrTail,
      `\`pplx\` exited with code ${outcome.code ?? "null"} and no error message`,
    ),
  };
}
