import { DEFAULT_MODEL, MODELS } from "../constants.js";
import { readCache, writeCache } from "../config.js";
import { restGet } from "./http.js";

/**
 * Model catalog: GET /rest/models/config?config_schema=v1 (HAR capture
 * 2026-03-05, www.perplexity.ai_Archive [26-03-05 00-03-10].har entry #139 —
 * supersedes contract §H "no endpoint"). Fires on the webapp's homepage/mode
 * switch. Response shape (all fields optional — reverse-engineered):
 * {
 *   config_schema: "v1",
 *   models: { <slug>: {label, description, mode, provider} },   // full catalog
 *   config: [{label, non_reasoning_model, reasoning_model, subscription_tier,…}], // UI picker order
 *   default_models: { search: "pplx_pro", research: "pplx_alpha", … },
 *   agentic_research_compare_models: [slugs]
 * }
 * The ask body consumes slugs as `model_preference` (unchanged).
 */

const CACHE_KEY = "models-config";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // catalog changes only when Perplexity ships models

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
  /** Picker tier from the `config` array ("pro" | "max" | …) — null for slugs not in the picker. */
  subscriptionTier: string | null;
  /** This slug is the catalog default for its mode (default_models). */
  isDefault: boolean;
  /** Slug is the `config` picker's non_reasoning_model entry. */
  isNonReasoning: boolean;
  /** Slug is the `config` picker's reasoning_model entry. */
  isReasoning: boolean;
  /** Slug is the `config` picker's fast_model entry. */
  isFast: boolean;
}

/** One `config` picker slot: what the webapp UI actually shows (19 slots at capture). */
export interface PickerSlot {
  /** Slot display name ("Claude Opus 4.6", "Gemini 3 Flash", …). */
  label: string;
  subscriptionTier: string | null;
  /** Slot's non-reasoning slug (null when the slot is reasoning-only). */
  nonReasoning: string | null;
  /** Slot's reasoning slug (null when non-reasoning only). */
  reasoning: string | null;
  /** Slot's fast_model slug (null almost always). */
  fast: string | null;
}

export interface ModelCatalog {
  /** Catalog entries in picker order first (config array), then the rest alphabetically. */
  models: ModelEntry[];
  /** mode → default slug, e.g. { search: "pplx_pro", research: "pplx_alpha" }. */
  defaultModels: Record<string, string>;
  /** The `config` picker slots verbatim, in server order — the UI-visible subset. */
  picker: PickerSlot[];
}

interface RawModelInfo {
  label?: unknown;
  description?: unknown;
  mode?: unknown;
  provider?: unknown;
}

interface RawConfigEntry {
  label?: unknown;
  subscription_tier?: unknown;
  non_reasoning_model?: unknown;
  reasoning_model?: unknown;
  fast_model?: unknown;
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

  // Picker slots: capture them verbatim (order preserved) and derive per-slug
  // metadata (first-appearance order, tier, reasoning flags) from the references.
  const picker: PickerSlot[] = [];
  const order: string[] = [];
  const tierBySlug = new Map<string, string>();
  const reasoningBySlug = new Map<string, { non: boolean; full: boolean; fast: boolean }>();
  for (const rawEntry of rawConfig) {
    if (!isRecord(rawEntry)) continue;
    const entry = rawEntry as RawConfigEntry;
    const tier = str(entry.subscription_tier);
    const non = str(entry.non_reasoning_model);
    const full = str(entry.reasoning_model);
    const fast = str(entry.fast_model);
    // A slot with zero slug references is pure UI chrome — keep it out.
    if (!non && !full && !fast) continue;
    picker.push({ label: str(entry.label) ?? "", subscriptionTier: tier, nonReasoning: non, reasoning: full, fast });
    for (const [slug, role] of [
      [non, "non"],
      [full, "full"],
      [fast, "fast"],
    ] as const) {
      if (!slug || !Object.prototype.hasOwnProperty.call(rawModels, slug)) continue;
      if (!order.includes(slug)) order.push(slug);
      if (tier && !tierBySlug.has(slug)) tierBySlug.set(slug, tier);
      const prev = reasoningBySlug.get(slug) ?? { non: false, full: false, fast: false };
      reasoningBySlug.set(slug, {
        non: prev.non || role === "non",
        full: prev.full || role === "full",
        fast: prev.fast || role === "fast",
      });
    }
  }

  const flags = (slug: string): { non: boolean; full: boolean; fast: boolean } =>
    reasoningBySlug.get(slug) ?? { non: false, full: false, fast: false };

  // Picker slugs first (captured UI order), remaining catalog slugs alphabetical.
  const rest = Object.keys(rawModels)
    .filter((slug) => !order.includes(slug))
    .sort((a, b) => a.localeCompare(b));
  const models: ModelEntry[] = [];
  for (const slug of [...order, ...rest]) {
    const info = (isRecord(rawModels[slug]) ? rawModels[slug] : {}) as RawModelInfo;
    const { non, full, fast } = flags(slug);
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
      isFast: fast,
    });
  }
  return { models, defaultModels: defaults, picker };
}

/** Fetch the live catalog. Throws ApiError/AuthRequiredError on failure (like every other api module). */
export async function fetchModelCatalog(opts?: { signal?: AbortSignal | undefined }): Promise<ModelCatalog> {
  const cached = await readCache<ModelCatalog>(CACHE_KEY, CACHE_TTL_MS);
  if (cached && Array.isArray(cached.models) && cached.models.length > 0) return cached;
  const payload = await restGet<unknown>("/rest/models/config", { config_schema: "v1" }, opts?.signal);
  const catalog = parseModelsConfig(payload);
  if (catalog.models.length === 0) {
    throw new Error("models/config returned no models (unexpected response shape)");
  }
  await writeCache(CACHE_KEY, catalog).catch(() => {}); // cache is best-effort
  return catalog;
}

/** Live catalog, degrading to the bundled two-slug fallback when the fetch fails (offline etc.). */
export async function modelCatalogWithFallback(opts?: {
  signal?: AbortSignal | undefined;
}): Promise<{ catalog: ModelCatalog; degraded: boolean }> {
  try {
    return { catalog: await fetchModelCatalog(opts), degraded: false };
  } catch {
    const models: ModelEntry[] = MODELS.map((m) => ({
      id: m.id,
      label: m.display,
      description: null,
      mode: "search",
      provider: null,
      subscriptionTier: null,
      isDefault: m.id === DEFAULT_MODEL,
      isNonReasoning: false,
      isReasoning: false,
      isFast: false,
    }));
    return {
      catalog: { models, defaultModels: { search: DEFAULT_MODEL }, picker: [] },
      degraded: true,
    };
  }
}
