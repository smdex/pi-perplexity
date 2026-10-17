import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat, utimes, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authPath,
  cachePath,
  clearAuth,
  cleanupTempThreads,
  cookieHeader,
  isTempExpired,
  isTempLive,
  loadAuth,
  loadThreadState,
  listThreadStates,
  readCache,
  saveAuth,
  saveThreadState,
  tempRemaining,
  threadStatePath,
  upsertCookie,
  writeCache,
  type StoredAuth,
  type ThreadState,
} from "../src/config.js";

let cfgDir: string;
let cacheRoot: string;

beforeAll(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "pplx-cfg-"));
  cacheRoot = await mkdtemp(join(tmpdir(), "pplx-cache-"));
  process.env.PPLX_CONFIG_DIR = cfgDir;
  process.env.PPLX_CACHE_DIR = cacheRoot;
});

afterAll(async () => {
  delete process.env.PPLX_CONFIG_DIR;
  delete process.env.PPLX_CACHE_DIR;
  await rm(cfgDir, { recursive: true, force: true });
  await rm(cacheRoot, { recursive: true, force: true });
});

function sampleAuth(): StoredAuth {
  return {
    kind: "cookies",
    cookies: ["__Secure-next-auth.session-token=tok", "pplx.session-id=sid"],
    accountUuid: "00000033-0000-4000-8000-000000000000",
    sessionExpires: "2027-01-01T00:00:00.000Z",
    email: "user@example.com",
    bearerToken: null,
    source: "paste",
    createdAt: "2026-09-22T00:00:00.000Z",
  };
}

function sampleThread(slug: string, updatedAt: string): ThreadState {
  return {
    slug,
    readWriteToken: `rwt-${slug}`,
    lastBackendUuid: `uuid-${slug}`,
    url: `https://www.perplexity.ai/search/${slug}`,
    updatedAt,
  };
}

describe("paths", () => {
  it("authPath respects PPLX_CONFIG_DIR", () => {
    expect(authPath()).toBe(join(cfgDir, "auth.json"));
  });

  it("cachePath and threadStatePath respect PPLX_CACHE_DIR", () => {
    expect(cachePath("spaces")).toBe(join(cacheRoot, "spaces.json"));
    expect(threadStatePath("abc-123")).toBe(join(cacheRoot, "threads", "abc-123.json"));
  });

  it("threadStatePath sanitizes unsafe slugs (no path separators survive)", () => {
    expect(threadStatePath("../../etc/passwd")).toBe(join(cacheRoot, "threads", ".._.._etc_passwd.json"));
  });
});

describe("auth store", () => {
  it("saveAuth/loadAuth round-trips", async () => {
    const auth = sampleAuth();
    await saveAuth(auth);
    expect(await loadAuth()).toEqual(auth);
  });

  it("auth file has 0600 permissions, even when the file pre-exists with 0644", async () => {
    await writeFile(authPath(), "x\n", { mode: 0o644 });
    await saveAuth(sampleAuth());
    const info = await stat(authPath());
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("loadAuth returns null for missing file", async () => {
    await clearAuth();
    expect(await loadAuth()).toBeNull();
  });

  it("loadAuth returns null for corrupt JSON", async () => {
    await writeFile(authPath(), "{not json", { encoding: "utf8" });
    expect(await loadAuth()).toBeNull();
  });

  it("loadAuth returns null when the shape is wrong", async () => {
    await writeFile(authPath(), JSON.stringify({ kind: "cookies", cookies: "not-an-array" }), { encoding: "utf8" });
    expect(await loadAuth()).toBeNull();
    await writeFile(authPath(), JSON.stringify({ kind: "bearer", cookies: [] }), { encoding: "utf8" });
    expect(await loadAuth()).toBeNull();
  });

  it("clearAuth removes the file and is a no-op when missing", async () => {
    await saveAuth(sampleAuth());
    await clearAuth();
    expect(await loadAuth()).toBeNull();
    await clearAuth(); // must not throw
  });
});

describe("cookie helpers", () => {
  it("cookieHeader joins with '; '", () => {
    expect(cookieHeader(["a=1", "b=2"])).toBe("a=1; b=2");
    expect(cookieHeader([])).toBe("");
  });

  it("upsertCookie replaces by name, keeps order, appends new names", () => {
    const jar = ["a=1", "b=2"];
    const next = upsertCookie(jar, ["b=3; Path=/; Secure", "c=4"]);
    expect(next).toEqual(["a=1", "b=3", "c=4"]);
    expect(jar).toEqual(["a=1", "b=2"]); // input not mutated
  });

  it("upsertCookie skips malformed set-cookies", () => {
    expect(upsertCookie(["a=1"], ["novalue", "=x", ""])).toEqual(["a=1"]);
  });
});

describe("cache", () => {
  it("writeCache/readCache round-trips within TTL", async () => {
    await writeCache("models", ["gemini38flash"]);
    expect(await readCache<string[]>("models", 60_000)).toEqual(["gemini38flash"]);
  });

  it("readCache returns null when expired (mtime older than maxAge)", async () => {
    await writeCache("spaces", { spaces: [] });
    const old = new Date(Date.now() - 120_000);
    await utimes(cachePath("spaces"), old, old);
    expect(await readCache("spaces", 60_000)).toBeNull();
  });

  it("readCache returns null for missing, corrupt, and empty values", async () => {
    expect(await readCache("nope", 60_000)).toBeNull();
    await writeFile(cachePath("bad"), "not-json", { encoding: "utf8" });
    expect(await readCache("bad", 60_000)).toBeNull();
  });
});

describe("thread state", () => {
  it("save/load round-trips", async () => {
    const state = sampleThread("slug-a", "2026-09-22T10:00:00.000Z");
    await saveThreadState(state);
    expect(await loadThreadState("slug-a")).toEqual(state);
  });

  it("loadThreadState returns null for missing or corrupt files", async () => {
    expect(await loadThreadState("missing")).toBeNull();
    await writeFile(threadStatePath("corrupt"), "}{", { encoding: "utf8" });
    expect(await loadThreadState("corrupt")).toBeNull();
  });

  it("thread state dir is 0700 and files are 0600 — even when they pre-exist wider", async () => {
    const state = sampleThread("perm-check", "2026-09-22T10:00:00.000Z");
    await saveThreadState(state);
    await saveThreadState(state); // second save exercises the chmod-on-existing path
    const dirInfo = await stat(join(cacheRoot, "threads"));
    expect(dirInfo.mode & 0o777).toBe(0o700);
    const fileInfo = await stat(threadStatePath("perm-check"));
    expect(fileInfo.mode & 0o777).toBe(0o600);
    // a pre-existing 0644 file gets tightened on the next save
    await writeFile(threadStatePath("perm-check"), "{}\n", { mode: 0o644 });
    await saveThreadState(state);
    expect((await stat(threadStatePath("perm-check"))).mode & 0o777).toBe(0o600);
  });

  it("listThreadStates returns all states, newest first, ignoring corrupt files", async () => {
    await saveThreadState(sampleThread("t-old", "2026-09-01T00:00:00.000Z"));
    await saveThreadState(sampleThread("t-new", "2026-09-22T00:00:00.000Z"));
    await writeFile(threadStatePath("t-garbage"), "not json", { encoding: "utf8" });
    const states = (await listThreadStates()).filter((s) => s.slug.startsWith("t-"));
    expect(states.map((s) => s.slug)).toEqual(["t-new", "t-old"]);
  });
});

describe("temp (incognito) thread lifecycle", () => {
  const NOW = new Date("2026-09-23T12:00:00.000Z");

  function tempThread(slug: string, createdAt: string): ThreadState {
    return {
      ...sampleThread(slug, createdAt),
      incognito: true,
      createdAt,
    };
  }

  it("isTempExpired: only incognito threads past 24h; missing anchor never expires", () => {
    const live = tempThread("tmp-live", "2026-09-23T00:00:00.000Z"); // 12h old
    const dead = tempThread("tmp-dead", "2026-09-21T00:00:00.000Z"); // 2.5d old
    const persistent = sampleThread("tmp-persist", "2026-09-01T00:00:00.000Z"); // non-incognito
    const noAnchor = tempThread("tmp-noanchor", "2026-09-01T00:00:00.000Z");
    delete noAnchor.createdAt;
    expect(isTempExpired(live, NOW)).toBe(false);
    expect(isTempExpired(dead, NOW)).toBe(true);
    expect(isTempExpired(persistent, NOW)).toBe(false); // persistent threads never expire locally
    expect(isTempExpired(noAnchor, NOW)).toBe(false); // unknown anchor → treat as live
  });

  it("isTempLive / tempRemaining: hours, minutes, expired, unknown, non-temp", () => {
    const fresh = tempThread("tmp-fresh", "2026-09-23T11:00:00.000Z"); // 1h old → 23h left
    const almost = tempThread("tmp-almost", "2026-09-22T12:30:00.000Z"); // 23.5h old → 30m left
    const dead = tempThread("tmp-dead2", "2026-09-21T00:00:00.000Z");
    expect(isTempLive(fresh, NOW)).toBe(true);
    expect(isTempLive(dead, NOW)).toBe(false);
    expect(tempRemaining(fresh, NOW)).toBe("23h");
    expect(tempRemaining(almost, NOW)).toBe("30m");
    expect(tempRemaining(dead, NOW)).toBe("expired");
    expect(tempRemaining(sampleThread("p", "2026-09-23T00:00:00.000Z"), NOW)).toBe("—");
    const noAnchor = tempThread("tmp-na", "2026-09-23T00:00:00.000Z");
    delete noAnchor.createdAt;
    expect(tempRemaining(noAnchor, NOW)).toBe("unknown");
  });

  it("cleanupTempThreads removes only expired incognito state files", async () => {
    await saveThreadState(tempThread("tmp-clean-dead", "2026-09-21T00:00:00.000Z")); // expired
    await saveThreadState(tempThread("tmp-clean-live", "2026-09-23T11:00:00.000Z")); // live
    await saveThreadState(sampleThread("tmp-clean-persist", "2026-09-01T00:00:00.000Z")); // old but persistent

    const removed = await cleanupTempThreads(NOW);

    expect(removed).toEqual(["tmp-clean-dead"]);
    expect(await loadThreadState("tmp-clean-dead")).toBeNull();
    expect(await loadThreadState("tmp-clean-live")).not.toBeNull();
    expect(await loadThreadState("tmp-clean-persist")).not.toBeNull();
  });

  it("cleanupTempThreads removes the actual FILE even when its name doesn't match the inner slug", async () => {
    // Regression: reconstructing the path from the slug let mismatched files survive the sweep.
    const state = tempThread("mismatched-slug", "2026-09-21T00:00:00.000Z"); // expired
    await writeFile(threadStatePath("totally-different-name"), JSON.stringify(state), { encoding: "utf8" });

    const removed = await cleanupTempThreads(NOW);

    expect(removed).toEqual(["mismatched-slug"]);
    await expect(readFile(threadStatePath("totally-different-name"), "utf8")).rejects.toThrow();
  });
});
