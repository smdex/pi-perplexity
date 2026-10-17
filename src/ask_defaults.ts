import { BUILTIN_SOURCES } from "./constants.js";
import { resolveSpace } from "./api/spaces.js";
import { listConnectors } from "./api/sources.js";
import type { PplxSettings } from "./config.js";

/**
 * Default resolution for `pplx ask` / `pplx research` (spec docs/pplx-cli-spec.md §3).
 * Precedence per field: explicit invocation flag → persisted setting → the
 * command's built-in default (applied later by buildAskBody).
 *
 * Fail-closed rules:
 * - A configured source that is not builtin and not connected is an error —
 *   never a silent scope change, and the request is never submitted.
 * - A configured/unflagged space that does not resolve is an error with a
 *   `pplx config` fix hint; --no-space bypasses it for one invocation.
 * - Incognito space targeting is unverified; require --no-incognito rather
 *   than silently changing privacy or submitting an unsupported combination.
 */

export interface AskDefaultsInput {
  /** "research" forces its own engine and ignores model settings/flags. */
  mode?: "search" | "research";
  /** Explicit --model (empty string counts as unset). */
  model?: string;
  /** Explicit --sources — REPLACES any configured list, never validated against the catalog. */
  sources?: string[];
  /** Explicit --space (title or uuid). */
  space?: string;
  /** --no-space: bypass the configured default space for this invocation. */
  noSpace?: boolean;
  /** Explicit --incognito / --no-incognito; undefined = user did not choose. */
  incognito?: boolean;
  /** --thread <ref> set (follow-up): configured spaces are skipped with a warning. */
  thread?: string;
  /** --continue set (follow-up). */
  continueThread?: boolean;
}

export interface ResolvedAskDefaults {
  model: string | undefined;
  sources: string[] | undefined;
  /** Resolved space uuid, or undefined when no space targets this ask. */
  space: string | undefined;
  /** Effective incognito value (built-in default true). */
  incognito: boolean;
  /** True when a configured default space was skipped because this is a follow-up. */
  ignoredConfiguredSpace: boolean;
}

function isBuiltin(id: string): boolean {
  return (BUILTIN_SOURCES as readonly string[]).includes(id);
}

/** Validate configured (not flagged) sources against builtin ids + the connected catalog. */
async function resolveConfiguredSources(
  configured: string[],
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const custom = configured.filter((id) => !isBuiltin(id));
  if (custom.length === 0) return [...configured]; // offline-safe: builtins need no catalog
  const connected = await listConnectors({ connectedOnly: true, signal });
  const available = new Set([...connected.map((c) => c.id), ...(BUILTIN_SOURCES as readonly string[])]);
  const missing = configured.filter((id) => !available.has(id));
  if (missing.length > 0) {
    throw new Error(
      `configured source${missing.length > 1 ? "s" : ""} ${missing.map((m) => `"${m}"`).join(", ")} ` +
        `not available (see \`pplx connectors\`) — fix with \`pplx config set sources …\` ` +
        `or override this run with --sources`,
    );
  }
  return [...configured];
}

/** Resolve a space ref to its uuid with an origin-aware not-found error. */
async function resolveSpaceRef(
  ref: string,
  origin: "flag" | "settings",
  signal: AbortSignal | undefined,
): Promise<string> {
  const resolved = await resolveSpace(ref, signal);
  if (resolved) return resolved.uuid;
  if (origin === "settings") {
    throw new Error(
      `configured space "${ref}" not found (see \`pplx spaces list\`) — ` +
        `\`pplx config unset space\` to remove it or --no-space to bypass it once`,
    );
  }
  throw new Error(`space not found: ${ref} (see \`pplx spaces list\`)`);
}

export async function resolveAskDefaults(
  input: AskDefaultsInput,
  settings: PplxSettings,
  opts?: { signal?: AbortSignal | undefined },
): Promise<ResolvedAskDefaults> {
  const signal = opts?.signal;

  // --model: flag wins over setting; research keeps its own engine (command-specific).
  const model =
    input.mode === "research" ? undefined : input.model || settings.model || undefined;

  // --sources: an explicit list REPLACES the configured one and is passed through
  // unvalidated (current flag semantics); configured lists are verified fail-closed.
  if (input.sources?.length === 0) {
    throw new Error("--sources requires at least one source id; use --sources web to bypass configured connectors");
  }
  const explicitSources = input.sources;
  const sources = explicitSources
    ? [...explicitSources]
    : settings.sources
      ? await resolveConfiguredSources(settings.sources, signal)
      : undefined;

  // --space / --no-space: flag wins; --no-space bypasses the configured default;
  // follow-ups skip the CONFIGURED space (space targeting is for new threads) but
  // honor an explicit --space, matching pre-settings behavior.
  if (input.space !== undefined && input.space.trim().length === 0) {
    throw new Error("--space requires a non-empty title or uuid; use --no-space to bypass the configured space");
  }
  if (input.noSpace === true && input.space) {
    throw new Error("--no-space cannot be combined with --space");
  }
  let ignoredConfiguredSpace = false;
  let space: string | undefined;
  const followup = Boolean(input.thread) || input.continueThread === true;
  if (input.space) {
    space = await resolveSpaceRef(input.space, "flag", signal);
  } else if (settings.space && !input.noSpace) {
    if (followup) {
      ignoredConfiguredSpace = true; // caller warns; the request stays followup-shaped
    } else {
      space = await resolveSpaceRef(settings.space, "settings", signal);
    }
  }

  // Space + incognito is unverified: never silently switch to library history.
  const incognito = input.incognito ?? true;
  if (space !== undefined && incognito) {
    throw new Error(
      "temp chats inside a space are unverified on the API — pass --no-incognito " +
        "(thread is created inside the space and kept in your library) or bypass the " +
        "space with --no-space (or `pplx config unset space`)",
    );
  }

  return { model, sources, space, incognito, ignoredConfiguredSpace };
}
