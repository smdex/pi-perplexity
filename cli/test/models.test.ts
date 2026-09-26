import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModelsConfig, fetchModelCatalog, modelCatalogWithFallback } from "../src/api/models.js";
import { DEFAULT_MODEL } from "../src/constants.js";
import { saveAuth, type StoredAuth } from "../src/config.js";
import { mockFetch } from "./fixtures.js";
import CAPTURE from "./fixtures/models-config-capture.json";

/**
 * Model catalog — GET /rest/models/config?config_schema=v1. Parsing is tested
 * against the VERBATIM capture (test/fixtures/models-config-capture.json, HAR
 * 2026-03-05 entry #139); fetch/cache/fallback over a mocked global fetch.
 */

let cfgDir: string;

beforeAll(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "pplx-models-"));
  process.env.PPLX_CONFIG_DIR = cfgDir;
  process.env.PPLX_CACHE_DIR = join(cfgDir, "cache");
  const auth: StoredAuth = {
    kind: "cookies",
    cookies: ["__Secure-next-auth.session-token=tok"],
    accountUuid: "00000033-0000-4000-8000-000000000000",
    sessionExpires: null,
    email: "user@example.com",
    bearerToken: null,
    source: "paste",
    createdAt: "2026-09-22T00:00:00.000Z",
  };
  await saveAuth(auth);
});

afterAll(async () => {
  delete process.env.PPLX_CONFIG_DIR;
  delete process.env.PPLX_CACHE_DIR;
  await rm(cfgDir, { recursive: true, force: true });
});

describe("parseModelsConfig (verbatim capture)", () => {
  const catalog = parseModelsConfig(CAPTURE);

  it("parses all captured models", () => {
    expect(catalog.models.length).toBe(61);
  });

  it("keeps picker (config) order first, then alphabetical", () => {
    expect(catalog.models[0]?.id).toBe("experimental"); // first picker entry (Sonar)
    expect(catalog.models[1]?.id).toBe("comet_browser_agent_sonnet");
    const ordered = catalog.models.slice(0, 24).map((m) => m.id);
    const rest = catalog.models.slice(24).map((m) => m.id);
    expect([...rest].sort((a, b) => a.localeCompare(b))).toEqual(rest); // tail is sorted
    expect(new Set([...ordered, ...rest]).size).toBe(61); // no dups
  });

  it("extracts label/description/mode/provider", () => {
    const gpt52 = catalog.models.find((m) => m.id === "gpt52");
    expect(gpt52).toMatchObject({
      label: "GPT-5.2",
      description: "OpenAI's latest model",
      mode: "search",
      provider: "OPENAI",
    });
    const alpha = catalog.models.find((m) => m.id === "pplx_alpha");
    expect(alpha).toMatchObject({ label: "Deep research", mode: "research", provider: "PERPLEXITY" });
    expect(alpha?.subscriptionTier).toBeNull(); // not in the picker config
  });

  it("carries subscription tier + reasoning flags from the picker config", () => {
    const opus = catalog.models.find((m) => m.id === "claude46opus");
    expect(opus).toMatchObject({ subscriptionTier: "max", isNonReasoning: true, isReasoning: false });
    const opusT = catalog.models.find((m) => m.id === "claude46opusthinking");
    expect(opusT).toMatchObject({ subscriptionTier: "max", isNonReasoning: false, isReasoning: true });
  });

  it("parses default_models per mode", () => {
    expect(catalog.defaultModels).toMatchObject({
      search: "pplx_pro",
      research: "pplx_alpha",
      agentic_research: "pplx_agentic_research",
    });
    const pro = catalog.models.find((m) => m.id === "pplx_pro");
    expect(pro?.isDefault).toBe(true);
    expect(catalog.models.find((m) => m.id === "gpt52")?.isDefault).toBe(false);
  });

  it("parses picker slots in server order with slug references", () => {
    expect(catalog.picker.length).toBe(12);
    const first = catalog.picker[0];
    expect(first).toMatchObject({
      label: "Sonar",
      subscriptionTier: "pro",
      nonReasoning: "experimental",
      reasoning: null,
      fast: null,
    });
    // gemini slot pairs non-reasoning + thinking under one label
    const gemini = catalog.picker.find((s) => s.nonReasoning === "gemini30flash");
    expect(gemini).toMatchObject({ label: "Gemini 3 Flash", reasoning: "gemini30flash_high" });
  });

  it("marks fast_model slugs (legacy field — null in the capture)", () => {
    expect(catalog.models.every((m) => m.isFast === false)).toBe(true);
  });

  it("is tolerant of garbage payloads", () => {
    for (const junk of [null, undefined, 42, {}, { models: "nope" }, { models: { x: null }, config: [1, "a"] }]) {
      const catalog2 = parseModelsConfig(junk);
      expect(Array.isArray(catalog2.models)).toBe(true);
      expect(catalog2.defaultModels).toEqual({});
      expect(catalog2.picker).toEqual([]);
    }
  });
});

describe("fetchModelCatalog + fallback (mocked fetch)", () => {
  it("fetches /rest/models/config?config_schema=v1 with rest query params", async () => {
    const mocked = mockFetch(() => Response.json(CAPTURE));
    try {
      const catalog = await fetchModelCatalog();
      expect(catalog.models.length).toBe(61);
      expect(mocked.calls[0]?.url).toBe(
        "https://www.perplexity.ai/rest/models/config?version=2.18&source=default&config_schema=v1",
      );
    } finally {
      mocked.restore();
    }
  });

  it("caches for 24h: second call does no network round-trip", async () => {
    // Keep fetch mocked across both calls; the second must be served from disk.
    const mocked = mockFetch(() => Response.json(CAPTURE));
    try {
      await fetchModelCatalog();
      const afterFirst = mocked.calls.length;
      await fetchModelCatalog();
      expect(mocked.calls.length).toBe(afterFirst);
    } finally {
      mocked.restore();
    }
  });

  it("modelCatalogWithFallback degrades to bundled slugs on fetch failure (fresh cache dir)", async () => {
    // Fresh cache dir → guaranteed cache miss; fetch then fails like an offline run.
    const fresh = await mkdtemp(join(tmpdir(), "pplx-models-fb-"));
    const prevCache = process.env.PPLX_CACHE_DIR;
    process.env.PPLX_CACHE_DIR = join(fresh, "cache");
    const mocked = mockFetch(() => Promise.reject(new TypeError("offline")));
    try {
      const { catalog, degraded } = await modelCatalogWithFallback();
      expect(degraded).toBe(true);
      expect(catalog.models.map((m) => m.id)).toEqual(["gemini38flash", "glm_5_3_thinking"]);
      expect(catalog.models.find((m) => m.id === DEFAULT_MODEL)?.isDefault).toBe(true);
    } finally {
      mocked.restore();
      if (prevCache === undefined) delete process.env.PPLX_CACHE_DIR;
      else process.env.PPLX_CACHE_DIR = prevCache;
      await rm(fresh, { recursive: true, force: true });
    }
  });
});
