import { afterEach, beforeEach, describe, expect, test } from "../test-helpers.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cachedCatalog,
  fetchModelCatalog,
  modelCatalogWithFallback,
  parseModelsConfig,
} from "../../src/search/models.js";

const originalCacheDir = process.env.PI_PERPLEXITY_CACHE_DIR;
let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "pi-perplexity-models-"));
  process.env.PI_PERPLEXITY_CACHE_DIR = cacheDir;
});

afterEach(async () => {
  if (originalCacheDir === undefined) {
    delete process.env.PI_PERPLEXITY_CACHE_DIR;
  } else {
    process.env.PI_PERPLEXITY_CACHE_DIR = originalCacheDir;
  }
  await rm(cacheDir, { recursive: true, force: true });
});

const SAMPLE_PAYLOAD = {
  models: {
    pplx_pro: { label: "Default Pro", mode: "search", provider: "pplx" },
    claude46opus: { label: "Claude Opus 4.6", mode: "search", provider: "anthropic" },
    gpt54: { label: "GPT-5.4", mode: "search", provider: "openai" },
    pplx_alpha: { label: "Deep Research", mode: "research", provider: "pplx" },
  },
  config: [
    { label: "Pro", subscription_tier: "pro", non_reasoning_model: "pplx_pro", reasoning_model: "claude46opus" },
    { label: "Pro", subscription_tier: "pro", non_reasoning_model: "gpt54", reasoning_model: "claude46opus" },
  ],
  default_models: { search: "pplx_pro", research: "pplx_alpha" },
};

describe("search/models", () => {
  test("parseModelsConfig orders picker slugs first and flags defaults", () => {
    const catalog = parseModelsConfig(SAMPLE_PAYLOAD);

    expect(catalog.models.map((model) => model.id)).toEqual([
      "pplx_pro",
      "claude46opus",
      "gpt54",
      "pplx_alpha",
    ]);
    expect(catalog.defaultModels).toEqual({ search: "pplx_pro", research: "pplx_alpha" });

    const pro = catalog.models.find((model) => model.id === "pplx_pro");
    expect(pro?.isDefault).toBe(true);
    expect(pro?.isNonReasoning).toBe(true);
    expect(pro?.isReasoning).toBe(false);
    expect(pro?.subscriptionTier).toBe("pro");

    const opus = catalog.models.find((model) => model.id === "claude46opus");
    expect(opus?.isReasoning).toBe(true);
    expect(opus?.isDefault).toBe(false);
  });

  test("parseModelsConfig tolerates missing/garbage payload", () => {
    for (const payload of [null, undefined, {}, { models: "nope" }, { models: {} }]) {
      const catalog = parseModelsConfig(payload);
      expect(catalog.models).toEqual([]);
      expect(catalog.defaultModels).toEqual({});
    }
  });

  test("fetchModelCatalog fetches via injected fetcher and writes the cache", async () => {
    let capturedPath = "";
    let capturedQuery = "";
    const fetcher = mock_fetcher(async (path, query) => {
      capturedPath = path;
      capturedQuery = JSON.stringify(query);
      return SAMPLE_PAYLOAD;
    });

    const catalog = await fetchModelCatalog(fetcher);
    expect(capturedPath).toBe("/rest/models/config");
    expect(capturedQuery).toBe(JSON.stringify({ config_schema: "v1" }));
    expect(catalog.models.length).toBe(4);

    // cache hit next time
    const cached = await cachedCatalog();
    expect(cached?.models.map((model) => model.id)).toEqual(catalog.models.map((model) => model.id));
  });

  test("modelCatalogWithFallback serves cache within TTL and degrades gracefully", async () => {
    let calls = 0;
    const fetcher = mock_fetcher(async () => {
      calls += 1;
      return SAMPLE_PAYLOAD;
    });

    const first = await modelCatalogWithFallback(fetcher);
    expect(first.degraded).toBe(false);
    expect(first.catalog?.models.length).toBe(4);
    expect(calls).toBe(1);

    // second call within TTL: served from cache, no fetch
    const second = await modelCatalogWithFallback(fetcher);
    expect(second.degraded).toBe(false);
    expect(calls).toBe(1);

    // stale cache -> refetch; failing fetcher -> degraded with stale cache cleared
    // (simulate TTL expiry by corrupting fetchedAt)
    const { readFile, writeFile } = await import("node:fs/promises");
    const cacheFile = join(cacheDir, "models-config.json");
    const cached = JSON.parse(await readFile(cacheFile, "utf8")) as { fetchedAt: number };
    await writeFile(cacheFile, JSON.stringify({ ...cached, fetchedAt: Date.now() - 25 * 60 * 60 * 1000 }));

    const failingFetcher = mock_fetcher(async () => {
      throw new Error("offline");
    });
    const third = await modelCatalogWithFallback(failingFetcher);
    expect(third.degraded).toBe(true);
    expect(third.catalog).toBeNull();
  });

  test("fetchModelCatalog throws when the payload has no models", async () => {
    const fetcher = mock_fetcher(async () => ({ models: {} }));
    await expect(fetchModelCatalog(fetcher)).rejects.toThrow("returned no models");
  });
});

/** Helper so the object-literal fetchers keep their inferred async signatures. */
function mock_fetcher(
  impl: (path: string, query: Record<string, string>, signal?: AbortSignal) => Promise<unknown>,
): (path: string, query: Record<string, string>, signal?: AbortSignal) => Promise<unknown> {
  return impl;
}
