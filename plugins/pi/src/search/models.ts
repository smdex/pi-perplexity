import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Live model catalog: GET /rest/models/config?config_schema=v1 (same endpoint the
 * pplx CLI uses — HAR capture 2026-03-05). Response shape (all fields optional,
 * reverse-engineered):
 * {
 *   models: { <slug>: {label, description, mode, provider} },
 *   config: [{label, subscription_tier, non_reasoning_model, reasoning_model}],
 *   default_models: { search: "pplx_pro", research: "pplx_alpha", … }
 * }
 * The ask body consumes slugs as `model_preference`. Cached for 24h — the
 * catalog only changes when Perplexity ships models.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type ModelMode =
  | "search"
  | "research"
  | "studio"
  | "study"
  | "agentic_research"
  | "asi"
  | "document_review"
  | "browser_agent"
  | (string & {});

export interface ModelEntry {
  /** ask-body `model_preference` slug. */
  id: string;
  /** UI display name ("Claude Opus 4.6"). */
  label: string;
  description: string | null;
  mode: ModelMode;
  provider: string | null;
  subscriptionTier: string | null;
  isDefault: boolean;
  isNonReasoning: boolean;
  isReasoning: boolean;
}

export interface ModelCatalog {
  /** Picker slugs first (captured UI order), remaining catalog slugs alphabetical. */
  models: ModelEntry[];
  /** mode → default slug, e.g. { search: "pplx_pro", research: "pplx_alpha" }. */
  defaultModels: Record<string, string>;
}

interface RawModelInfo {
  label?: unknown;
  description?: unknown;
  mode?: unknown;
  provider?: unknown;
}

interface RawConfigEntry {
  subscription_tier?: unknown;
  non_reasoning_model?: unknown;
  reasoning_model?: unknown;
}

interface RawPayload {
  models?: unknown;
  config?: unknown;
  default_models?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse the raw /rest/models/config payload → ModelCatalog. Tolerant: unknown shapes degrade to an empty catalog. */
export function parseModelsConfig(payload: unknown): ModelCatalog {
  const raw = (isRecord(payload) ? payload : {}) as RawPayload;
  const rawModels = isRecord(raw.models) ? raw.models : {};
  const rawConfig = Array.isArray(raw.config) ? raw.config : [];
  const rawDefaults = isRecord(raw.default_models) ? raw.default_models : {};

  const defaults: Record<string, string> = {};
  for (const [mode, slug] of Object.entries(rawDefaults)) {
    const s = str(slug);
    if (s) defaults[mode] = s;
  }

  const order: string[] = [];
  const tierBySlug = new Map<string, string>();
  const reasoningBySlug = new Map<string, { non: boolean; full: boolean }>();
  for (const rawEntry of rawConfig) {
    if (!isRecord(rawEntry)) continue;
    const entry = rawEntry as RawConfigEntry;
    const tier = str(entry.subscription_tier);
    const non = str(entry.non_reasoning_model);
    const full = str(entry.reasoning_model);
    for (const slug of [non, full]) {
      if (!slug || !Object.prototype.hasOwnProperty.call(rawModels, slug)) continue;
      if (!order.includes(slug)) order.push(slug);
      if (tier && !tierBySlug.has(slug)) tierBySlug.set(slug, tier);
      const prev = reasoningBySlug.get(slug) ?? { non: false, full: false };
      reasoningBySlug.set(slug, {
        non: prev.non || slug === non,
        full: prev.full || slug === full,
      });
    }
  }

  const flags = (slug: string): { non: boolean; full: boolean } =>
    reasoningBySlug.get(slug) ?? { non: false, full: false };

  const rest = Object.keys(rawModels)
    .filter((slug) => !order.includes(slug))
    .sort((a, b) => a.localeCompare(b));
  const models: ModelEntry[] = [];
  for (const slug of [...order, ...rest]) {
    const info = (isRecord(rawModels[slug]) ? rawModels[slug] : {}) as RawModelInfo;
    const { non, full } = flags(slug);
    models.push({
      id: slug,
      label: str(info.label) ?? slug,
      description: str(info.description),
      mode: str(info.mode) ?? "search",
      provider: str(info.provider),
      subscriptionTier: tierBySlug.get(slug) ?? null,
      isDefault: Object.values(defaults).includes(slug),
      isNonReasoning: non,
      isReasoning: full,
    });
  }
  return { models, defaultModels: defaults };
}

function cachePath(): string {
  return process.env.PI_PERPLEXITY_CACHE_DIR
    ? join(process.env.PI_PERPLEXITY_CACHE_DIR, "models-config.json")
    : join(homedir(), ".cache", "pi-perplexity", "models-config.json");
}

async function readCache(): Promise<{ catalog: ModelCatalog; fetchedAt: number } | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf8")) as {
      catalog?: unknown;
      fetchedAt?: unknown;
    };
    if (
      !isRecord(parsed) ||
      !isRecord(parsed.catalog) ||
      typeof parsed.fetchedAt !== "number" ||
      !Array.isArray((parsed.catalog as { models?: unknown }).models)
    ) {
      return null;
    }
    // SAFETY: guard above proved catalog is a record whose `models` is an array;
    // the deeper ModelEntry fields stay optional by design (API is unstable).
    return { catalog: parsed.catalog as unknown as ModelCatalog, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

export async function writeCache(catalog: ModelCatalog): Promise<void> {
  const path = cachePath();
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify({ catalog, fetchedAt: Date.now() }, null, 2);
  await writeFile(path, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

/**
 * Fetch the live catalog through `fetcher` (injected — client.ts supplies the
 * Bun-subprocess transport). Throws when the response has no models.
 */
export async function fetchModelCatalog(
  fetcher: (path: string, query: Record<string, string>, signal?: AbortSignal) => Promise<unknown>,
  opts?: { signal?: AbortSignal },
): Promise<ModelCatalog> {
  const payload = await fetcher("/rest/models/config", { config_schema: "v1" }, opts?.signal);
  const catalog = parseModelsConfig(payload);
  if (catalog.models.length === 0) {
    throw new Error("models/config returned no models (unexpected response shape)");
  }
  await writeCache(catalog).catch(() => {}); // cache is best-effort
  return catalog;
}

/** Cached catalog if fresh, else null. */
export async function cachedCatalog(): Promise<ModelCatalog | null> {
  const cached = await readCache();
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
  const catalog = cached.catalog;
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) return null;
  return catalog;
}

/** Live catalog with 24h cache; degrades to null so callers can fall back to bundled slugs. */
export async function modelCatalogWithFallback(
  fetcher: (path: string, query: Record<string, string>, signal?: AbortSignal) => Promise<unknown>,
  opts?: { signal?: AbortSignal },
): Promise<{ catalog: ModelCatalog | null; degraded: boolean }> {
  const cached = await cachedCatalog();
  if (cached) return { catalog: cached, degraded: false };
  try {
    return { catalog: await fetchModelCatalog(fetcher, opts), degraded: false };
  } catch {
    return { catalog: null, degraded: true };
  }
}
