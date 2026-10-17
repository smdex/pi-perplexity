import { describe, expect, test } from "./test-helpers.js";

import { formatAskResult, threadSlugFromUrl } from "../src/format.js";
import type { AskResultJson } from "../src/pplx.js";

const NOW = new Date("2026-10-17T00:00:00.000Z");

function baseResult(overrides: Partial<AskResultJson> = {}): AskResultJson {
  return {
    answer: "Sky is blue because molecules scatter short wavelengths.",
    threadUrl: "https://www.perplexity.ai/search/3f2b8c1a-4d5e-4f6a-9b7c-1d2e3f4a5b6c",
    model: "gemini38flash",
    sources: [
      {
        name: "NASA",
        url: "https://nasa.gov/why-sky-blue",
        snippet: "Rayleigh scattering",
        timestamp: "2026-10-17T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("threadSlugFromUrl", () => {
  test("extracts the slug from a thread url", () => {
    expect(threadSlugFromUrl("https://www.perplexity.ai/search/3f2b8c1a-4d5e-4f6a-9b7c-1d2e3f4a5b6c")).toBe(
      "3f2b8c1a-4d5e-4f6a-9b7c-1d2e3f4a5b6c",
    );
  });

  test("returns undefined for a missing url", () => {
    expect(threadSlugFromUrl(null)).toBe(undefined);
    expect(threadSlugFromUrl(undefined)).toBe(undefined);
  });
});

describe("formatAskResult", () => {
  test("renders answer, numbered sources, and meta with session guidance", () => {
    const text = formatAskResult(baseResult(), undefined, NOW);

    expect(text).toContain("## Answer\nSky is blue because molecules scatter short wavelengths.");
    expect(text).toContain("## Sources\n1 sources");
    expect(text).toContain("[1] NASA (just now)");
    expect(text).toContain("    https://nasa.gov/why-sky-blue");
    expect(text).toContain("    Rayleigh scattering");
    expect(text).toContain("Provider: perplexity (pplx CLI)");
    expect(text).toContain("Model: gemini38flash");
    expect(text).toContain(
      'Session ID: 3f2b8c1a-4d5e-4f6a-9b7c-1d2e3f4a5b6c — pass thread="3f2b8c1a-4d5e-4f6a-9b7c-1d2e3f4a5b6c" (or continue=true for the latest session) on the next perplexity_search call to continue this conversation',
    );
  });

  test("limit truncates the source list without touching the answer", () => {
    const text = formatAskResult(
      baseResult({
        sources: [
          { name: "One", url: "https://one.example", timestamp: "2026-10-17T00:00:00.000Z" },
          { name: "Two", url: "https://two.example", timestamp: "2026-10-17T00:00:00.000Z" },
          { name: "Three", url: "https://three.example", timestamp: "2026-10-17T00:00:00.000Z" },
        ],
      }),
      2,
      NOW,
    );

    expect(text).toContain("[1] One");
    expect(text).toContain("[2] Two");
    expect(text).not.toContain("[3] Three");
    expect(text).toContain("Sky is blue");
  });

  test("empty sources are stated explicitly, not omitted", () => {
    const text = formatAskResult(baseResult({ sources: [] }), undefined, NOW);
    expect(text).toContain("## Sources\n0 sources\n(no sources returned)");
  });

  test("images and follow-ups get their own sections", () => {
    const text = formatAskResult(
      baseResult({
        followups: ["Why are sunsets red?"],
        images: [{ url: "https://s3.example/img.png", filename: "sky.png", width: 512, height: 512 }],
      }),
      undefined,
      NOW,
    );

    expect(text).toContain("## Follow-ups\n1. Why are sunsets red?");
    expect(text).toContain("## Images\n[1] sky.png (512x512)");
    expect(text).toContain("    https://s3.example/img.png");
  });

  test("missing model and thread degrade to explicit unknowns", () => {
    const text = formatAskResult(baseResult({ model: null, threadUrl: null }), undefined, NOW);
    expect(text).toContain("Model: unknown");
    expect(text).not.toContain("Session ID:");
  });
});
