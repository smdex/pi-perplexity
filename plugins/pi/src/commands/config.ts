import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  getConfigPath as defaultGetConfigPath,
  loadConfig as defaultLoadConfig,
  saveConfig as defaultSaveConfig,
  type PerplexityConfig,
} from "../config.js";
import { authenticate } from "../auth/login.js";
import { modelCatalogWithFallback, type ModelCatalog } from "../search/models.js";
import { restGetJson } from "../search/client.js";

/** Bundled fallback when the live catalog can't be fetched (offline, no auth). */
const FALLBACK_MODELS: { value: string; label: string }[] = [
  { value: "pplx_pro_upgraded", label: "Best (auto)" },
  { value: "pplx_pro", label: "Default Pro" },
  { value: "pplx_alpha", label: "Deep Research" },
];

function labelFor(entry: {
  label: string;
  mode: string;
  subscriptionTier: string | null;
  isReasoning: boolean;
  isDefault: boolean;
  provider: string | null;
}): string {
  const parts: string[] = [entry.label];
  if (entry.isDefault) parts.push("default");
  if (entry.subscriptionTier) parts.push(entry.subscriptionTier);
  if (entry.mode && entry.mode !== "search") parts.push(entry.mode);
  if (entry.isReasoning) parts.push("reasoning");
  if (entry.provider) parts.push(entry.provider);
  return parts.filter(Boolean).join(" · ");
}

function formatCurrentConfig(config: { model?: string }): string {
  const model = config.model ?? "pplx_pro_upgraded (default)";
  return `Model: ${model}`;
}

function parseSelectedModel(selected: string): string {
  return selected.replace(/ \[current\]$/, "");
}

/**
 * Fetch the live model catalog and render the picker options
 * ("Claude Opus 4.6 · pro · claude46opus — claude46opus"). Degrades to the
 * bundled fallback list when the fetch fails.
 */
async function loadModelOptions(
  cwdlessAuth: () => Promise<{ jwt: string; cookies: string[]; userAgent: string | null }>,
): Promise<{ options: string[]; degraded: boolean; catalog: ModelCatalog | null }> {
  try {
    const credentials = await cwdlessAuth();
    const { catalog, degraded } = await modelCatalogWithFallback((path, query, signal) =>
      restGetJson(
        {
          jwt: credentials.jwt,
          cookies: credentials.cookies,
          userAgent: credentials.userAgent,
          email: null,
          source: "cookies",
        },
        path,
        query,
        signal,
      ),
    );
    if (catalog && catalog.models.length > 0) {
      const options = catalog.models.map((model) => {
        const pretty = labelFor(model);
        return pretty === model.id ? pretty : `${pretty} — ${model.id}`;
      });
      const current = catalog.models.find((model) => model.isDefault);
      if (current && !options.some((option) => option.endsWith(`— ${current.id}`))) {
        // default slug not in the picker — prepend it
        options.unshift(`${labelFor(current)} — ${current.id}`);
      }
      return { options, degraded, catalog };
    }
  } catch {
    // fall through to the bundled list
  }
  return { options: FALLBACK_MODELS.map((model) => model.label), degraded: true, catalog: null };
}

/** Map a picked option back to its model slug via the catalog (or fallback slugs by label). */
function resolvePickedModel(selected: string, catalog: ModelCatalog | null): string {
  const normalized = parseSelectedModel(selected);
  const byFullOption = catalog?.models.find(
    (model) =>
      normalized === model.id ||
      normalized.endsWith(`— ${model.id}`) ||
      normalized === labelFor(model),
  );
  if (byFullOption) return byFullOption.id;
  const fallback = FALLBACK_MODELS.find((model) => model.label === normalized);
  return fallback?.value ?? normalized;
}

interface ConfigCommandDeps {
  getConfigPath: () => string;
  loadConfig: () => Promise<PerplexityConfig>;
  saveConfig: (config: PerplexityConfig) => Promise<void>;
  /** Catalog source; defaults to live fetch via authenticate + restGetJson. */
  loadCatalog?: () => Promise<{ options: string[]; degraded: boolean; catalog: ModelCatalog | null }>;
}

export function registerPerplexityConfigCommand(
  pi: ExtensionAPI,
  deps: ConfigCommandDeps = {
    getConfigPath: defaultGetConfigPath,
    loadConfig: defaultLoadConfig,
    saveConfig: defaultSaveConfig,
  },
): void {
  const loadOptions =
    deps.loadCatalog ??
    (() =>
      loadModelOptions(() => authenticate()));
  pi.registerCommand("perplexity-config", {
    description: "Configure Perplexity search defaults",
    handler: async (args, ctx) => {
      if (args.trim() === "--help" || args.trim() === "-h") {
        ctx.ui.notify(
          `Usage: /perplexity-config [--show]\n\nInteractively set the default model (live catalog from Perplexity).\nConfig stored at: ${deps.getConfigPath()}`,
          "info",
        );
        return;
      }

      try {
        const config = await deps.loadConfig();

        if (args.trim() === "--show") {
          ctx.ui.notify(`Perplexity config (${deps.getConfigPath()}):\n${formatCurrentConfig(config)}`, "info");
          return;
        }

        const { options, degraded, catalog } = await loadOptions();
        const currentOption = catalog?.models.find((model) => model.id === config.model);
        const optionList = currentOption
          ? options.map((option) => (option.endsWith(`— ${currentOption.id}`) ? `${option} [current]` : option))
          : options;

        if (degraded) {
          ctx.ui.notify(
            "Could not fetch the live model catalog (offline or not logged in) — showing the bundled model list.",
            "warning",
          );
        }

        const selected = await ctx.ui.select("Default model", optionList);
        if (selected === undefined || selected === null) {
          ctx.ui.notify("Perplexity config unchanged.", "info");
          return;
        }
        const selectedModel = resolvePickedModel(selected, catalog);

        config.model = selectedModel;

        await deps.saveConfig(config);
        ctx.ui.notify(`Perplexity config saved:\n${formatCurrentConfig(config)}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Failed to save Perplexity config: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
