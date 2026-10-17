import type { CommandModule } from "yargs";
import { loadSettings, parseSettings, saveSettings, SETTING_KEYS, type PplxSettings, type SettingKey } from "../config.js";
import { out, run } from "./util.js";

/**
 * pplx config — persistent defaults for `pplx ask` (spec docs/pplx-cli-spec.md §3):
 * `config [get [key]]`, `config set <key> <value..>`, `config unset <key>`.
 * Settings live at ~/.config/pplx-cli/config.json (PPLX_CONFIG_DIR override),
 * separate from auth. Explicit ask flags always win over stored values.
 */

interface ConfigArgs {
  action?: string;
  key?: string;
  value?: string[];
  json?: boolean;
}

function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}

function requireKey(raw: unknown): SettingKey {
  const key = typeof raw === "string" ? raw : "";
  if (!isSettingKey(key)) {
    throw new Error(`unknown setting ${JSON.stringify(key)} — valid keys: ${SETTING_KEYS.join(", ")}`);
  }
  return key;
}

/** Human one-line form of a stored value (arrays join with spaces). */
function formatValue(value: string | string[] | undefined): string {
  if (value === undefined) return "(not set)";
  return Array.isArray(value) ? value.join(" ") : value;
}

function listAll(settings: PplxSettings, json: boolean): void {
  if (json) {
    out(JSON.stringify(settings));
    return;
  }
  const entries = SETTING_KEYS.filter((key) => settings[key] !== undefined);
  if (entries.length === 0) {
    out("no defaults configured — pplx config set <key> <value>");
    return;
  }
  out(entries.map((key) => `${key}: ${formatValue(settings[key])}`).join("\n"));
}

async function executeConfig(argv: ConfigArgs): Promise<void> {
  const json = argv.json === true;
  const settings = await loadSettings();
  const action = argv.action ?? "get";

  if (action === "get") {
    if (argv.key === undefined) {
      listAll(settings, json);
      return;
    }
    const key = requireKey(argv.key);
    const value = settings[key];
    out(json ? JSON.stringify(value ?? null) : `${key}: ${formatValue(value)}`);
    return;
  }

  if (action === "set") {
    const key = requireKey(argv.key);
    const values = argv.value ?? [];
    if (values.length === 0) {
      throw new Error(`pplx config set ${key} <value…> — a value is required`);
    }
    if (key !== "sources" && values.length > 1) {
      throw new Error(`setting "${key}" takes exactly one value (got ${values.length})`);
    }
    // parseSettings inside saveSettings rejects empty strings / empty arrays.
    const next = parseSettings(
      key === "model"
        ? { ...settings, model: values[0] }
        : key === "sources"
          ? { ...settings, sources: [...values] }
          : { ...settings, space: values[0] },
    );
    await saveSettings(next);
    out(json ? JSON.stringify(next) : `set ${key}=${formatValue(next[key])}`);
    return;
  }

  if (action === "unset") {
    const key = requireKey(argv.key);
    if (settings[key] === undefined) {
      out(json ? JSON.stringify(settings) : `${key} is not set`);
      return;
    }
    const next: PplxSettings = { ...settings };
    if (key === "model") delete next.model;
    else if (key === "sources") delete next.sources;
    else delete next.space;
    await saveSettings(next);
    out(json ? JSON.stringify(next) : `unset ${key}`);
    return;
  }

  throw new Error(`unknown config action "${action}" — use get, set, or unset`);
}

export const configCommand: CommandModule = {
  command: "config [action] [key] [value..]",
  describe: "persistent defaults: model, sources, space (explicit ask flags win)",
  builder: (y) =>
    y
      .positional("action", { type: "string", describe: "get | set | unset (omit to list)" })
      .positional("key", { type: "string", describe: `setting key (${SETTING_KEYS.join(" | ")})` })
      .positional("value", { type: "string", describe: "one value for model/space; one or more ids for sources" })
      .option("json", { type: "boolean", describe: "print JSON" })
      .epilog(
        [
          "Examples:",
          "  pplx config set model glm_5_3_thinking",
          "  pplx config set sources web scholar",
          '  pplx config set space "Budgets"',
          "  pplx config get",
          "  pplx config unset space",
          "",
          "Explicit flags override defaults per run: --model, --sources (replaces the list), --space;",
          "Use --sources web to bypass configured connectors; --no-space bypasses a configured space.",
          "Space targeting requires --no-incognito (keeps the thread in your library).",
        ].join("\n"),
      ),
  handler: (argv) => {
    // SAFETY: positional/option schema above guarantees the shape
    const args = argv as unknown as ConfigArgs;
    return run(args.json === true, () => executeConfig(args));
  },
};
