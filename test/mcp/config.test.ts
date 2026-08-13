import { afterEach, beforeEach, describe, expect, test } from "../test-helpers.js";

import { parseFlags, resolveMcpConfig, type McpConfigDeps } from "../../src/mcp/config.js";
import type { PerplexityConfig } from "../../src/config.js";

const ENV_KEYS = [
  "PI_PERPLEXITY_MODEL",
  "PI_PERPLEXITY_DEEP_MODEL",
  "MCP_TRANSPORT",
  "MCP_HOST",
  "MCP_PORT",
  "MCP_PATH",
  "PORT",
  "PI_PERPLEXITY_ALLOW_PUBLIC",
] as const;

const original: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of ENV_KEYS) original[key] = process.env[key];
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

function deps(fileConfig: PerplexityConfig = {}): McpConfigDeps {
  return {
    loadConfig: async () => fileConfig,
    resolveDefaultModel: (cfg) => process.env.PI_PERPLEXITY_MODEL?.trim() || cfg.model || "pplx_pro_upgraded",
    getConfigPath: () => "/unused/config.json",
  };
}

describe("parseFlags", () => {
  test("parses model, deep-model, transport, and help", () => {
    const flags = parseFlags(["--model", "gpt54", "--deep-model", "sonnet5", "--transport", "http", "--help"]);
    expect(flags).toMatchObject({ model: "gpt54", deepModel: "sonnet5", transport: "http", help: true });
  });

  test("rejects invalid transport", () => {
    expect(() => parseFlags(["--transport", "sse"])).toThrow(/must be "stdio" or "http"/);
  });

  test("rejects non-positive port", () => {
    expect(() => parseFlags(["--port", "0"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--port", "abc"])).toThrow(/positive integer/);
  });

  test("allow-public defaults false", () => {
    expect(parseFlags([]).allowPublic).toBe(false);
    expect(parseFlags(["--allow-public"]).allowPublic).toBe(true);
  });
});

describe("resolveMcpConfig model precedence", () => {
  test("flag overrides env, env overrides file, file overrides default", async () => {
    const cfg = await resolveMcpConfig([], deps({ model: "file-model" }));
    expect(cfg.model).toBe("file-model");

    process.env.PI_PERPLEXITY_MODEL = "env-model";
    expect((await resolveMcpConfig([], deps({ model: "file-model" }))).model).toBe("env-model");

    expect((await resolveMcpConfig(["--model", "flag-model"], deps({ model: "file-model" }))).model).toBe("flag-model");
  });

  test("default model when nothing set", async () => {
    expect((await resolveMcpConfig([], deps({}))).model).toBe("pplx_pro_upgraded");
  });
});

describe("resolveMcpConfig deepModel precedence", () => {
  test("flag > env > default pplx_alpha", async () => {
    expect((await resolveMcpConfig([], deps())).deepModel).toBe("pplx_alpha");

    process.env.PI_PERPLEXITY_DEEP_MODEL = "env-deep";
    expect((await resolveMcpConfig([], deps())).deepModel).toBe("env-deep");

    expect((await resolveMcpConfig(["--deep-model", "flag-deep"], deps())).deepModel).toBe("flag-deep");
  });
});

describe("resolveMcpConfig transport", () => {
  test("defaults to stdio", async () => {
    expect((await resolveMcpConfig([], deps())).runOptions.transport).toBe("stdio");
  });

  test("flag overrides env", async () => {
    process.env.MCP_TRANSPORT = "http";
    expect((await resolveMcpConfig([], deps())).runOptions.transport).toBe("http");
    expect((await resolveMcpConfig(["--transport", "stdio"], deps())).runOptions.transport).toBe("stdio");
  });

  test("rejects invalid MCP_TRANSPORT env", async () => {
    process.env.MCP_TRANSPORT = "sse";
    await expect(resolveMcpConfig([], deps())).rejects.toThrow(/must be "stdio" or "http"/);
  });
});

describe("resolveMcpConfig HTTP loopback guard", () => {
  test("loopback host allowed", async () => {
    const cfg = await resolveMcpConfig(["--transport", "http", "--host", "127.0.0.1"], deps());
    expect(cfg.runOptions.transport).toBe("http");
    expect(cfg.runOptions.host).toBe("127.0.0.1");
  });

  test("non-loopback host rejected without opt-in", async () => {
    await expect(resolveMcpConfig(["--transport", "http", "--host", "0.0.0.0"], deps())).rejects.toThrow(
      /non-loopback/,
    );
  });

  test("non-loopback host allowed with --allow-public", async () => {
    const cfg = await resolveMcpConfig(["--transport", "http", "--host", "0.0.0.0", "--allow-public"], deps());
    expect(cfg.runOptions.host).toBe("0.0.0.0");
  });

  test("non-loopback host allowed with PI_PERPLEXITY_ALLOW_PUBLIC=1", async () => {
    process.env.PI_PERPLEXITY_ALLOW_PUBLIC = "1";
    const cfg = await resolveMcpConfig(["--transport", "http", "--host", "10.0.0.1"], deps());
    expect(cfg.runOptions.host).toBe("10.0.0.1");
  });

  test("stdio ignores host entirely", async () => {
    const cfg = await resolveMcpConfig(["--host", "0.0.0.0"], deps());
    expect(cfg.runOptions.transport).toBe("stdio");
    expect(cfg.runOptions).not.toHaveProperty("host");
  });

  test("http assembles port and path with defaults", async () => {
    const cfg = await resolveMcpConfig(["--transport", "http", "--port", "8080"], deps());
    expect(cfg.runOptions).toMatchObject({ transport: "http", port: 8080, path: "/mcp", host: "127.0.0.1" });
  });
});
