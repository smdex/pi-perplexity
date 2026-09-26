import { afterEach, beforeEach, describe, expect, test } from "./test-helpers.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerPerplexityConfigCommand } from "../src/commands/config.js";
import type { ModelCatalog } from "../src/search/models.js";

let loadConfig: (configPath?: string) => Promise<import("../src/config.js").PerplexityConfig>;
let saveConfig: (config: import("../src/config.js").PerplexityConfig, configPath?: string) => Promise<void>;

let tempDir: string;
let configPath: string;

const CATALOG: ModelCatalog = {
  models: [
    {
      id: "pplx_pro_upgraded",
      label: "Best (auto)",
      description: null,
      mode: "search",
      provider: "pplx",
      subscriptionTier: "pro",
      isDefault: true,
      isNonReasoning: true,
      isReasoning: false,
    },
    {
      id: "gpt54",
      label: "GPT-5.4",
      description: null,
      mode: "search",
      provider: "openai",
      subscriptionTier: "pro",
      isDefault: false,
      isNonReasoning: true,
      isReasoning: false,
    },
    {
      id: "pplx_alpha",
      label: "Deep Research",
      description: null,
      mode: "research",
      provider: "pplx",
      subscriptionTier: null,
      isDefault: false,
      isNonReasoning: false,
      isReasoning: false,
    },
  ],
  defaultModels: { search: "pplx_pro_upgraded" },
};

const OPTIONS = ["Best (auto) · pro — pplx_pro_upgraded", "GPT-5.4 · pro — gpt54", "Deep Research — pplx_alpha"];

function stubCatalog() {
  return async () => ({ options: OPTIONS, degraded: false, catalog: CATALOG });
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-perplexity-command-test-"));
  configPath = join(tempDir, "config.json");

  const mod = await import(`../src/config.js?t=${Date.now()}`);
  loadConfig = mod.loadConfig;
  saveConfig = mod.saveConfig;
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("perplexity-config command", () => {
  test("marks the configured model as current in the select options", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;

    await saveConfig({ model: "gpt54" }, configPath);

    registerPerplexityConfigCommand(
      {
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
          expect(name).toBe("perplexity-config");
          handler = command.handler;
        },
      } as any,
      {
        getConfigPath: () => configPath,
        loadConfig: () => loadConfig(configPath),
        saveConfig: (config) => saveConfig(config, configPath),
        loadCatalog: stubCatalog(),
      },
    );

    expect(handler).toBeDefined();

    let options: string[] = [];

    await handler!("", {
      ui: {
        select: async (_label: string, receivedOptions: string[]) => {
          options = receivedOptions;
          return "GPT-5.4 · pro — gpt54 [current]";
        },
        notify: () => undefined,
      },
    });

    expect(options).toContain("GPT-5.4 · pro — gpt54 [current]");
  });

  test("writes selected config to disk", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;

    registerPerplexityConfigCommand(
      {
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
          expect(name).toBe("perplexity-config");
          handler = command.handler;
        },
      } as any,
      {
        getConfigPath: () => configPath,
        loadConfig: () => loadConfig(configPath),
        saveConfig: (config) => saveConfig(config, configPath),
        loadCatalog: stubCatalog(),
      },
    );

    expect(handler).toBeDefined();

    const notifications: Array<{ message: string; level: string }> = [];
    await handler!("", {
      ui: {
        select: async () => "GPT-5.4 · pro — gpt54",
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    });

    const raw = await readFile(configPath, "utf8");
    expect(JSON.parse(raw)).toEqual({ model: "gpt54" });
    expect(notifications).toContainEqual({
      message: "Perplexity config saved:\nModel: gpt54",
      level: "info",
    });
  });

  test("degrades to the bundled model list when the live catalog fails", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const notifications: Array<{ message: string; level: string }> = [];

    registerPerplexityConfigCommand(
      {
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
          handler = command.handler;
        },
      } as any,
      {
        getConfigPath: () => configPath,
        loadConfig: () => loadConfig(configPath),
        saveConfig: (config) => saveConfig(config, configPath),
        loadCatalog: async () => ({
          options: ["Best (auto)", "Default Pro", "Deep Research"],
          degraded: true,
          catalog: null,
        }),
      },
    );

    await handler!("", {
      ui: {
        select: async () => "Default Pro",
        confirm: async () => true,
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    });

    expect(notifications.some((n) => n.level === "warning" && n.message.includes("live model catalog"))).toBe(true);

    const raw = await readFile(configPath, "utf8");
    expect(JSON.parse(raw)).toEqual({ model: "pplx_pro" });
  });

  test("--show prints the current config without invoking the catalog", async () => {
    let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
    let catalogCalls = 0;
    const notifications: Array<{ message: string; level: string }> = [];

    await saveConfig({ model: "gpt54" }, configPath);

    registerPerplexityConfigCommand(
      {
        registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
          handler = command.handler;
        },
      } as any,
      {
        getConfigPath: () => configPath,
        loadConfig: () => loadConfig(configPath),
        saveConfig: (config) => saveConfig(config, configPath),
        loadCatalog: async () => {
          catalogCalls += 1;
          return { options: [], degraded: false, catalog: null };
        },
      },
    );

    await handler!("--show", {
      ui: {
        select: async () => undefined,
        confirm: async () => undefined,
        notify: (message: string, level: string) => notifications.push({ message, level }),
      },
    });

    expect(catalogCalls).toBe(0);
    expect(notifications[0]?.level).toBe("info");
    expect(notifications[0]?.message).toContain("Model: gpt54");
  });
});
