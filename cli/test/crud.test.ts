import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAskBody } from "../src/api/ask.js";
import { buildCreateSpaceBody } from "../src/api/spaces.js";
import { candidateSources, completionHandler } from "../src/complete.js";
import {
  buildBatchThreadsBody,
  buildDeleteThreadBody,
  buildSetThreadTitleBody,
} from "../src/api/threads.js";
import { saveThreadState } from "../src/config.js";
import { resolveThread } from "../src/commands/chats.js";

/**
 * CRUD wire-shape tests — bodies verified verbatim against
 * research/network/t-*.json and s-*.json captures (see t-summary.md /
 * s-summary.md). Zero network: ref resolution runs with empty auth + cache
 * dirs so it falls back to locally written thread state.
 */

let configDir: string;
let cacheDir: string;

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), "pplx-crud-cfg-"));
  cacheDir = await mkdtemp(join(tmpdir(), "pplx-crud-cache-"));
  // empty config dir → requestContext throws AuthRequiredError (no live fetch);
  // cache dir receives the fixture thread state written below.
  process.env.PPLX_CONFIG_DIR = configDir;
  process.env.PPLX_CACHE_DIR = cacheDir;
  await saveThreadState({
    slug: "00000050-0000-4000-8000-000000000000",
    readWriteToken: "00000062-0000-4000-8000-000000000000",
    lastBackendUuid: "00000050-0000-4000-8000-000000000000",
    url: "https://www.perplexity.ai/search/00000050-0000-4000-8000-000000000000",
    updatedAt: "2026-09-23T12:00:00Z",
    query: "pplx-cli-capture-test-thread",
    answer: "OK",
  });
});

afterAll(async () => {
  delete process.env.PPLX_CONFIG_DIR;
  delete process.env.PPLX_CACHE_DIR;
  await rm(configDir, { recursive: true, force: true }).catch(() => {});
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
});

describe("thread CRUD bodies (t-summary.md)", () => {
  it("set_thread_title: {context_uuid, title, read_write_token} — verbatim t-02", () => {
    expect(
      buildSetThreadTitleBody(
        "00000042-0000-4000-8000-000000000000",
        "pplx-cli-capture-test-renamed",
        "00000062-0000-4000-8000-000000000000",
      ),
    ).toEqual({
      context_uuid: "00000042-0000-4000-8000-000000000000",
      title: "pplx-cli-capture-test-renamed",
      read_write_token: "00000062-0000-4000-8000-000000000000",
    });
  });

  it("batch pin/unpin: {context_uuids:[…]} — verbatim t-03/t-03c", () => {
    expect(buildBatchThreadsBody(["00000042-0000-4000-8000-000000000000"])).toEqual({
      context_uuids: ["00000042-0000-4000-8000-000000000000"],
    });
    expect(Object.keys(buildBatchThreadsBody(["a"]))).toEqual(["context_uuids"]);
  });

  it("delete_thread_by_entry_uuid: entry_uuid carries the SLUG uuid, not context_uuid — verbatim t-04 trap", () => {
    const slug = "00000050-0000-4000-8000-000000000000"; // URL uuid / first-entry backend_uuid
    const contextUuid = "00000042-0000-4000-8000-000000000000";
    const body = buildDeleteThreadBody(slug, "00000062-0000-4000-8000-000000000000");
    expect(body).toEqual({
      entry_uuid: slug,
      read_write_token: "00000062-0000-4000-8000-000000000000",
    });
    // the naming trap, asserted: slug ≠ context_uuid and the slug is what ships
    expect(body.entry_uuid).not.toBe(contextUuid);
    expect(Object.keys(body).sort()).toEqual(["entry_uuid", "read_write_token"]);
  });
});

describe("space CRUD bodies (s-summary.md)", () => {
  it("create_collection: exact captured shape (s-01-create-post.json)", () => {
    expect(buildCreateSpaceBody({ title: "CLI-CAPTURE-TEST" })).toEqual({
      title: "CLI-CAPTURE-TEST",
      description: "",
      emoji: "1f4c1",
      appearance: null, // capture sends null, not ""
      instructions: "",
      access: 1,
      project_brain_auto_update_enabled: false,
      creation_context: { entry_point: "sidebarHeader", creation_method: "blank" },
    });
  });

  it("create_collection: desc/emoji/instructions overrides pass through", () => {
    const body = buildCreateSpaceBody({ title: "T", description: "D", emoji: "1f4a5", instructions: "I" });
    expect(body.description).toBe("D");
    expect(body.emoji).toBe("1f4a5");
    expect(body.instructions).toBe("I");
    expect(body.access).toBe(1); // never overridden
  });
  // rename = POST /rest/collections/edit_collection/<uuid> body {title} only;
  // delete = DELETE /rest/collections/delete_collection/<uuid> no body —
  // both one-liners in api/spaces.ts, no builder to test.
});

describe("ask --space body (s-summary 'Ask inside space')", () => {
  const uuid = "00000036-0000-4000-8000-000000000000";

  it("sets target_collection_uuid + target_thread_access_level 5 + query_source collection", () => {
    const { params } = buildAskBody({ query: "hi", space: uuid });
    expect(params.target_collection_uuid).toBe(uuid);
    expect(params.target_thread_access_level).toBe(5);
    expect(params.query_source).toBe("collection");
  });

  it("mentions stay absent (space targeting is NOT mention-based)", () => {
    const { params } = buildAskBody({ query: "hi", space: uuid });
    expect("mentions" in params).toBe(false);
  });

  it("no space → no space params at all", () => {
    const { params } = buildAskBody({ query: "hi" });
    expect("target_collection_uuid" in params).toBe(false);
    expect("target_thread_access_level" in params).toBe(false);
    expect(params.query_source).toBe("home");
  });

  it("follow-up inside a space keeps the uuid; query_source stays followup", () => {
    const { params } = buildAskBody({
      query: "next",
      space: uuid,
      followup: { lastBackendUuid: "00000066-0000-4000-8000-000000000000", readWriteToken: "t" },
    });
    expect(params.target_collection_uuid).toBe(uuid);
    expect(params.query_source).toBe("followup");
    expect(params.last_backend_uuid).toBe("00000066-0000-4000-8000-000000000000");
  });
});

describe("chats <ref> resolution", () => {
  it("resolves a slug uuid from local thread state (offline)", async () => {
    const node = await resolveThread("00000050-0000-4000-8000-000000000000");
    expect(node).not.toBeNull();
    expect(node?.slug).toBe("00000050-0000-4000-8000-000000000000");
    expect(node?.readWriteToken).toBe("00000062-0000-4000-8000-000000000000");
  });

  it("resolves a full /search/<uuid> URL", async () => {
    const node = await resolveThread("https://www.perplexity.ai/search/00000050-0000-4000-8000-000000000000");
    expect(node?.slug).toBe("00000050-0000-4000-8000-000000000000");
  });

  it("resolves the recorded query (thread title) exactly and by unique prefix", async () => {
    expect((await resolveThread("pplx-cli-capture-test-thread"))?.slug).toBe(
      "00000050-0000-4000-8000-000000000000",
    );
    expect((await resolveThread("pplx-cli-capture"))?.slug).toBe("00000050-0000-4000-8000-000000000000");
  });

  it("unknown ref → null", async () => {
    expect(await resolveThread("no-such-thread-anywhere")).toBeNull();
  });
});

describe("positional <ref> completion dispatch", () => {
  const saved = candidateSources.chatRef;
  it("`chats rename myt<TAB>` serves chatRef candidates, not flag completion", async () => {
    candidateSources.chatRef = () => Promise.resolve(["my thread", "other"]);
    let got: string[] | undefined;
    let filtered = false;
    completionHandler(
      "my ",
      { _: ["chats", "rename", "my"], ref: "my" },
      () => {
        filtered = true;
      },
      (c: string[]) => {
        got = c;
      },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(["my thread"]);
    expect(filtered).toBe(false);
  });
  it("`chats list<TAB>` still falls through to default completion", () => {
    let filtered = false;
    completionHandler("list", { _: ["chats"] }, () => {
      filtered = true;
    }, undefined);
    expect(filtered).toBe(true);
  });
  candidateSources.chatRef = saved;
});
