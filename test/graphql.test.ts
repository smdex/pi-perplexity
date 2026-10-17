import { describe, expect, it } from "bun:test";
import {
  buildGraphQLBody,
  PERSISTED_HASHES,
  parseThreadPage,
  toThreadNode,
  type ThreadPage,
} from "../src/api/graphql.js";
import { REAL_LIBRARY_THREAD_NODE } from "./fixtures.js";

const REAL_CURSOR =
  "THC:eyJjIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAwIn0=";

describe("buildGraphQLBody", () => {
  it("sidebar: exact captured body (hash + variables)", () => {
    expect(buildGraphQLBody("SidebarRecentItemsRelayQuery", { first: 20, types: ["THREAD"] })).toEqual({
      operationName: "SidebarRecentItemsRelayQuery",
      variables: { first: 20, types: ["THREAD"] },
      extensions: {
        persistedQuery: { version: 1, sha256Hash: PERSISTED_HASHES.SidebarRecentItemsRelayQuery },
      },
    });
  });

  it("library: exact captured variables including the after cursor", () => {
    const body = buildGraphQLBody("LibraryThreadsRelayQuery", {
      includeSearchPreview: false,
      searchTerm: null,
      sortOrder: "NEWEST",
      statuses: null,
      threadTypes: null,
      sources: null,
      includeTemporary: null,
      after: REAL_CURSOR,
    });
    expect(body.extensions.persistedQuery.sha256Hash).toBe(PERSISTED_HASHES.LibraryThreadsRelayQuery);
    expect(body.variables).toEqual({
      includeSearchPreview: false,
      searchTerm: null,
      sortOrder: "NEWEST",
      statuses: null,
      threadTypes: null,
      sources: null,
      includeTemporary: null,
      after: REAL_CURSOR,
    });
  });

  it("space: exact captured variables", () => {
    const body = buildGraphQLBody("SpaceProjectThreadsRelayQuery", {
      spaceId: "00000056-0000-4000-8000-000000000000",
      ownThreadsOnly: false,
      searchTerm: null,
      groupType: "ALL",
      count: 25,
      cursor: null,
    });
    expect(body.operationName).toBe("SpaceProjectThreadsRelayQuery");
    expect(body.extensions.persistedQuery).toEqual({
      version: 1,
      sha256Hash: PERSISTED_HASHES.SpaceProjectThreadsRelayQuery,
    });
    expect(body.variables.spaceId).toBe("00000056-0000-4000-8000-000000000000");
  });

  it("hashes match the contract verbatim", () => {
    expect(PERSISTED_HASHES).toEqual({
      SidebarRecentItemsRelayQuery: "1dcb15dc33c957d936c0c77a6066ae587d21913b4247a53d71fe6ebc8b807e8a",
      LibraryThreadsRelayQuery: "1c1f9e86416eddf3dfed6ede99575a5cc241b59cf079f2e9295ed927f2908006",
      SpaceProjectThreadsRelayQuery: "db13bf755b93bc2645f536609fb6e70c4f7da4093a93fa103d9fa109bb31d066",
    });
  });
});

describe("toThreadNode", () => {
  it("maps a real library Thread node (from a-trace)", () => {
    const node = toThreadNode(REAL_LIBRARY_THREAD_NODE);
    expect(node.id).toBe("TH:eyJpIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAwIn0=");
    expect(node.contextUuid).toBe("00000052-0000-4000-8000-000000000000");
    expect(node.entryId).toBe("00000045-0000-4000-8000-000000000000");
    expect(node.slug).toBe("00000045-0000-4000-8000-000000000000"); // slug == entryId (verified)
    expect(node.readWriteToken).toBe("00000069-0000-4000-8000-000000000000");
    expect(node.status).toBe("COMPLETED");
    expect(node.displayModel).toBe("glm_5_3_thinking");
    expect(node.title).toContain("how much this costs");
    expect(node.spaceUuid).toBeNull();
    expect(node.updatedAt).toBe("2026-09-21T21:32:44.541303Z");
  });

  it("unwraps the sidebar node shape {title, activityAt, object: Thread}", () => {
    const node = toThreadNode(
      { ...(REAL_LIBRARY_THREAD_NODE as Record<string, unknown>), name: "inner name" },
      { title: "sidebar title", activityAt: "2026-09-21T22:00:00Z" },
    );
    expect(node.title).toBe("sidebar title");
    expect(node.updatedAt).toBe("2026-09-21T22:00:00Z");
  });

  it("tolerates garbage input", () => {
    const node = toThreadNode("nope");
    expect(node.entryId).toBeNull();
    expect(node.title).toBeNull();
  });
});

describe("parseThreadPage", () => {
  const edge = {
    cursor: REAL_CURSOR,
    node: { id: "TH:x", entryId: "uuid-1", name: "t", status: "COMPLETED", updatedAt: "2026-09-21T00:00:00Z" },
  };

  it("parses the library path (recentGroup.threads)", () => {
    const payload = {
      data: { viewer: { recentGroup: { threads: { edges: [edge], pageInfo: { endCursor: "C1", hasNextPage: true } } } } },
    };
    const page: ThreadPage = parseThreadPage(payload, "library");
    expect(page.threads.length).toBe(1);
    expect(page.threads[0].cursor).toBe(REAL_CURSOR);
    expect(page.threads[0].node.entryId).toBe("uuid-1");
    expect(page.endCursor).toBe("C1");
    expect(page.hasNextPage).toBe(true);
  });

  it("parses the space path (space.threadGroup.threads)", () => {
    const payload = {
      data: { viewer: { space: { threadGroup: { threads: { edges: [edge], pageInfo: { endCursor: null, hasNextPage: false } } } } } },
    };
    const page = parseThreadPage(payload, "space");
    expect(page.threads.length).toBe(1);
    expect(page.endCursor).toBeNull();
    expect(page.hasNextPage).toBe(false);
  });

  it("returns an empty page when keys are missing", () => {
    expect(parseThreadPage({}, "library")).toEqual({ threads: [], endCursor: null, hasNextPage: false });
    expect(parseThreadPage({ data: { viewer: {} } }, "space")).toEqual({
      threads: [],
      endCursor: null,
      hasNextPage: false,
    });
    expect(parseThreadPage(null, "library").threads).toEqual([]);
  });
});
