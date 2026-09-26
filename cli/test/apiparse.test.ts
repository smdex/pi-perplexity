import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSpaces, listSpacesMentions, resolveSpace } from "../src/api/spaces.js";
import { listConnectors } from "../src/api/sources.js";
import { saveAuth, type StoredAuth } from "../src/config.js";
import { LANDING_BODY, MENTIONS_BODY, mockFetch, SOURCES_BODY } from "./fixtures.js";

/**
 * Sources/spaces REST parsing over mocked fetch with fixtures trimmed from the
 * live captures (b-trace /rest/sources + /rest/spaces/mentions, a-trace
 * /rest/spaces/landing/v2). Also locks the captured query-string contract.
 */

let cfgDir: string;

beforeAll(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "pplx-parse-"));
  process.env.PPLX_CONFIG_DIR = cfgDir;
  const auth: StoredAuth = {
    kind: "cookies",
    cookies: ["__Secure-next-auth.session-token=tok"],
    accountUuid: "00000033-0000-4000-8000-000000000000",
    sessionExpires: null,
    email: null,
    bearerToken: null,
    source: "paste",
    createdAt: "2026-09-22T00:00:00.000Z",
  };
  await saveAuth(auth);
});

afterAll(async () => {
  delete process.env.PPLX_CONFIG_DIR;
  await rm(cfgDir, { recursive: true, force: true });
});

describe("listConnectors (/rest/sources)", () => {
  it("maps the captured body tolerantly and sends the captured query", async () => {
    const mocked = mockFetch(() => Response.json(SOURCES_BODY));
    try {
      const connectors = await listConnectors();
      expect(connectors).toEqual([
        { id: "finance", displayName: "Perplexity Finance", description: "Leverage institutional-grade market data, no setup required", authType: "none" },
        { id: "web", displayName: "Web", description: "Search across the entire Internet", authType: "none" },
        { id: "scholar", displayName: "Academic", description: "Search academic papers", authType: "none" },
        { id: "social", displayName: "Social", description: "Discussions and opinions", authType: "none" },
        { id: "google_drive", displayName: "Google Drive", description: "Get in-depth answers from your Google Drive content", authType: "oauth" },
      ]);
      expect(mocked.calls[0].url).toBe(
        "https://www.perplexity.ai/rest/sources?version=2.18&source=default&limit=40&group_by_family=true&product_surface=computer",
      );
    } finally {
      mocked.restore();
    }
  });

  it("connectedOnly switches to the captured connected-filter query", async () => {
    const mocked = mockFetch(() => Response.json({ sources: [] }));
    try {
      await listConnectors({ connectedOnly: true });
      expect(mocked.calls[0].url).toBe(
        "https://www.perplexity.ai/rest/sources?version=2.18&source=default&filter_by=connected&no_limit=true&exclude_ineligible=true&group_by_family=true&product_surface=computer",
      );
    } finally {
      mocked.restore();
    }
  });

  it("skips entries without an id; tolerates missing optional fields", async () => {
    const mocked = mockFetch(() =>
      Response.json({ sources: [{ display_name: "no id" }, { id: "bare" }, "not-a-record", null] }),
    );
    try {
      const connectors = await listConnectors();
      expect(connectors).toEqual([{ id: "bare", displayName: "bare", description: null, authType: null }]);
    } finally {
      mocked.restore();
    }
  });
});

describe("listSpacesMentions (/rest/spaces/mentions)", () => {
  it("maps the captured body to {uuid,title,emoji}", async () => {
    const mocked = mockFetch(() => Response.json(MENTIONS_BODY));
    try {
      const spaces = await listSpacesMentions();
      expect(spaces.length).toBe(4);
      expect(spaces[1]).toEqual({ uuid: "00000053-0000-4000-8000-000000000000", title: "Budgets", emoji: "1f4b3" });
      expect(mocked.calls[0].url).toBe("https://www.perplexity.ai/rest/spaces/mentions?version=2.18&source=default");
    } finally {
      mocked.restore();
    }
  });
});

describe("listSpaces (/rest/spaces/landing/v2)", () => {
  it("merges main+pinned+invited, main first, deduped by uuid; sends limit", async () => {
    const mocked = mockFetch(() => Response.json(LANDING_BODY));
    try {
      const spaces = await listSpaces();
      expect(spaces.map((s) => s.uuid)).toEqual(["00000064-0000-4000-8000-000000000000", "00000056-0000-4000-8000-000000000000"]);
      expect(spaces[1].title).toBe("Ops: linux");
      expect(spaces[1].emoji).toBe("1f5a5");
      expect(spaces[1].updatedAt).toBe("2026-09-21T21:10:00.000000");
      expect(mocked.calls[0].url).toBe("https://www.perplexity.ai/rest/spaces/landing/v2?version=2.18&source=default&limit=30");
    } finally {
      mocked.restore();
    }
  });
});

describe("resolveSpace", () => {
  it("resolves by exact uuid → exact title (case-insensitive) → unique title prefix", async () => {
    const mocked = mockFetch(() => Response.json(LANDING_BODY));
    try {
      expect((await resolveSpace("00000056-0000-4000-8000-000000000000"))?.uuid).toBe("00000056-0000-4000-8000-000000000000");
      expect((await resolveSpace("ops: linux"))?.uuid).toBe("00000056-0000-4000-8000-000000000000");
      expect((await resolveSpace("trans"))?.uuid).toBe("00000064-0000-4000-8000-000000000000");
      expect(await resolveSpace("no such space")).toBeNull();
    } finally {
      mocked.restore();
    }
  });
});
