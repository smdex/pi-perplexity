import type { CommandModule } from "yargs";
import pc from "picocolors";
import { DEFAULT_MODEL } from "../constants.js";
import { modelCatalogWithFallback, type ModelEntry } from "../api/models.js";
import { out, run } from "./util.js";

/**
 * pplx models — GET /rest/models/config?config_schema=v1 (HAR capture 2026-03-05;
 * supersedes contract §H "client-bundled only"). Lists the live catalog (61 slugs
 * at capture, 130 live on 2026-09-23): picker models first in UI order, remaining
 * slugs alphabetically. The endpoint has NO availability/deprecation field — every
 * listed slug is at least nominally live (retired ones vanish server-side). To
 * mirror what the webapp UI shows, --picker lists only the `config` picker slots.
 * Offline/auth failures degrade to the bundled capture-verified slugs.
 * `--model` still passes any slug through.
 */

interface ModelsArgs {
  json?: boolean;
  all?: boolean;
  mode?: string;
  picker?: boolean;
}

export const modelsCommand: CommandModule = {
  command: "models",
  describe: "list model_preference slugs from /rest/models/config",
  builder: (y) =>
    y
      .option("json", { type: "boolean", describe: "print JSON" })
      .option("all", { type: "boolean", describe: "include non-search modes (studio, asi, browser agent, …)" })
      .option("mode", {
        type: "string",
        describe: "filter by mode (search, research, asi, …) — implies --all semantics",
      })
      .option("picker", {
        type: "boolean",
        describe: "only the picker slots the webapp UI shows (config array), not the full catalog",
      }),
  handler: async (argv) => {
    const args = argv as ModelsArgs;
    await run(args.json === true, async () => {
      const { catalog, degraded } = await modelCatalogWithFallback();

      if (args.picker === true) {
        // Picker view: the config slots exactly as the webapp renders them.
        const slots = catalog.picker.filter((s) => {
          if (args.mode) return [s.nonReasoning, s.reasoning, s.fast].some((slug) => {
            const m = catalog.models.find((x) => x.id === slug);
            return m?.mode === args.mode?.toLowerCase();
          });
          if (args.all === true) return true;
          // default picker view: search-mode slugs only
          return [s.nonReasoning, s.reasoning, s.fast].some((slug) => {
            const m = catalog.models.find((x) => x.id === slug);
            return m?.mode === "search";
          });
        });
        if (args.json) {
          out(JSON.stringify({ degraded, picker: slots }));
          return;
        }
        if (degraded) {
          out(pc.yellow("live catalog unavailable — picker not captured in the bundled fallback\n"));
          return;
        }
        if (slots.length === 0) {
          out("no picker slots");
          return;
        }
        const lines = slots.map((s) => {
          const tier = s.subscriptionTier ? ` [${s.subscriptionTier}]` : "";
          const parts = [
            ...(s.nonReasoning ? [s.nonReasoning] : []),
            ...(s.reasoning ? [`${s.reasoning} (thinking)`] : []),
            ...(s.fast ? [`${s.fast} (fast)`] : []),
          ];
          return `  ${pc.bold(s.label)}${tier}\n      ${parts.join("  ·  ")}`;
        });
        out(`${pc.bold(`webapp picker slots (${slots.length})`)}:\n${lines.join("\n")}`);
        out(
          pc.dim(
            "\nThese are the models the Perplexity web UI offers. The full catalog (pplx models --all) additionally contains legacy and internal slugs that still work via --model.",
          ),
        );
        return;
      }

      let models: ModelEntry[] = catalog.models;
      if (args.mode) {
        const want = args.mode.toLowerCase();
        models = models.filter((m) => m.mode === want);
      } else if (args.all !== true) {
        models = models.filter((m) => m.mode === "search");
      }
      if (args.json) {
        out(JSON.stringify({ degraded, defaultModels: catalog.defaultModels, picker: catalog.picker, models }));
        return;
      }
      if (degraded) {
        out(pc.yellow("live catalog unavailable — showing bundled capture-verified slugs:\n"));
      }
      if (models.length === 0) {
        out(`no models${args.mode ? ` in mode ${args.mode}` : ""}`);
        return;
      }
      const lines = models.map((m) => {
        const tier = m.subscriptionTier ? ` [${m.subscriptionTier}]` : "";
        const reasoning = m.isReasoning ? " (thinking)" : "";
        const defaultFor = Object.entries(catalog.defaultModels)
          .filter(([, slug]) => slug === m.id)
          .map(([mode]) => mode);
        const def = defaultFor.length > 0 ? ` (default: ${defaultFor.join(", ")})` : "";
        const provider = m.provider ? ` — ${m.provider.toLowerCase()}` : "";
        const desc = m.description ? `\n      ${m.description}` : "";
        return `  ${pc.bold(m.id)}${reasoning}${tier}${def}${provider}${desc}`;
      });
      out(`${pc.bold(`model_preference slugs (${models.length})`)}:\n${lines.join("\n")}`);
      out(
        pc.dim(
          "\nAny slug is accepted via --model (free-form passthrough). Slugs marked (default: …) are the server's default_models per mode; the ask command's default stays " +
            DEFAULT_MODEL +
            ". Use --picker for only the models the webapp UI shows.",
        ),
      );
    });
  },
};
