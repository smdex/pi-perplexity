import { afterEach, beforeEach, describe, expect, test } from "../test-helpers.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cleanupTempThreads,
  formatRemaining,
  isTempExpired,
  isTempLive,
  listThreadStates,
  loadThreadState,
  saveThreadState,
  tempRemaining,
  TEMP_TTL_MS,
  type ThreadState,
} from "../../src/auth/threads.js";

const originalCacheDir = process.env.PI_PERPLEXITY_CACHE_DIR;
let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "pi-perplexity-threads-"));
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

function makeState(overrides: Partial<ThreadState> = {}): ThreadState {
  return {
    slug: "00000000-0000-4000-8000-000000000001",
    readWriteToken: "rw",
    lastBackendUuid: "be",
    url: "https://www.perplexity.ai/search/00000000-0000-4000-8000-000000000001",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("auth/threads", () => {
  test("save/load round-trips and rejects corrupt files", async () => {
    const state = makeState({ query: "test query" });
    await saveThreadState(state);
    expect(await loadThreadState(state.slug)).toEqual(state);

    // unknown slug -> null
    expect(await loadThreadState("99999999-9999-4999-8999-999999999999")).toBeNull();

    // corrupt file -> null (not a throw)
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(cacheDir, "threads", "bad.json"), "{nope");
    expect(await loadThreadState("bad")).toBeNull();
  });

  test("listThreadStates sorts by updatedAt desc and skips junk", async () => {
    await saveThreadState(makeState({ slug: "a0000000-0000-4000-8000-00000000000a", updatedAt: "2026-01-01T00:00:00Z" }));
    await saveThreadState(makeState({ slug: "b0000000-0000-4000-8000-00000000000b", updatedAt: "2026-01-02T00:00:00Z" }));

    const states = await listThreadStates();
    expect(states).toHaveLength(2);
    expect(states[0].slug).toBe("b0000000-0000-4000-8000-00000000000b");
    expect(states[1].slug).toBe("a0000000-0000-4000-8000-00000000000a");
  });

  test("temp expiry honors the 24h TTL from createdAt", () => {
    const now = new Date();
    const fresh = makeState({ incognito: true, createdAt: new Date(now.getTime() - 60_000).toISOString() });
    const stale = makeState({ incognito: true, createdAt: new Date(now.getTime() - TEMP_TTL_MS - 60_000).toISOString() });
    const permanent = makeState({ incognito: false });

    expect(isTempExpired(fresh, now)).toBe(false);
    expect(isTempLive(fresh, now)).toBe(true);
    expect(isTempExpired(stale, now)).toBe(true);
    expect(isTempLive(stale, now)).toBe(false);
    // non-incognito threads never expire
    expect(isTempExpired(permanent, now)).toBe(false);
    expect(isTempLive(permanent, now)).toBe(false);
    // missing anchor -> not expired (conservative)
    expect(isTempExpired(makeState({ incognito: true }), now)).toBe(false);
  });

  test("tempRemaining/formatRemaining report remaining TTL", () => {
    const now = new Date();
    const fresh = makeState({ incognito: true, createdAt: new Date(now.getTime() - 30 * 60_000).toISOString() });
    const remaining = tempRemaining(fresh, now);
    expect(remaining).not.toBe(null);
    expect(Math.round(((remaining ?? 0) - (TEMP_TTL_MS - 30 * 60_000)) / 1000)).toBe(0);
    expect(/h .*m left/.test(formatRemaining(remaining))).toBe(true);
    expect(formatRemaining(0)).toBe("expired");
    expect(formatRemaining(null)).toBe("");
  });

  test("cleanupTempThreads removes only expired incognito entries", async () => {
    const now = new Date();
    const keep = makeState({
      slug: "10000000-0000-4000-8000-000000000001",
      incognito: true,
      createdAt: new Date(now.getTime() - 60_000).toISOString(),
    });
    const drop = makeState({
      slug: "20000000-0000-4000-8000-000000000002",
      incognito: true,
      createdAt: new Date(now.getTime() - TEMP_TTL_MS - 60_000).toISOString(),
    });
    const permanent = makeState({
      slug: "30000000-0000-4000-8000-000000000003",
    });
    await saveThreadState(keep);
    await saveThreadState(drop);
    await saveThreadState(permanent);

    const removed = await cleanupTempThreads(now);
    expect(removed).toEqual(["20000000-0000-4000-8000-000000000002"]);
    expect(await loadThreadState(keep.slug)).not.toBeNull();
    expect(await loadThreadState(drop.slug)).toBeNull();
    expect(await loadThreadState(permanent.slug)).not.toBeNull();
  });
});
