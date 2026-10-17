import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TEMP_TTL_MS } from "./constants.js";
import type { GeneratedImage, WebResultRef } from "./api/sse.js";

/**
 * Disk layout for the CLI. Config: ~/.config/pplx-cli/ (override PPLX_CONFIG_DIR).
 * Cache: ~/.cache/pplx/ (override PPLX_CACHE_DIR). Env vars are read at call time.
 */

export interface StoredAuth {
  kind: "cookies";
  cookies: string[]; // "name=value" pairs; jar. Must contain __Secure-next-auth.session-token
  accountUuid: string | null; // GET /api/auth/session → user.id (the x-pplx-account value)
  sessionExpires: string | null; // ISO from /api/auth/session
  email: string | null;
  bearerToken: string | null; // signin-otp JSON token — stored, unused by default (contract §I.1)
  source: "paste" | "firefox" | "zen" | "librewolf" | "waterfox" | "chromium" | "chrome" | "brave" | "vivaldi" | "edge" | "opera" | "browseros" | "otp";
  createdAt: string; // ISO
  /** Captured browser user-agent (curl/headers paste) — cf_clearance is UA-bound. */
  userAgent?: string;
}

export interface ThreadState {
  slug: string; // thread_url_slug (first entry backend_uuid)
  readWriteToken: string; // from first SSE event
  lastBackendUuid: string; // final SSE event's backend_uuid
  url: string; // ORIGIN + "/search/" + slug
  updatedAt: string; // ISO
  /** Locally recorded last exchange (written by `pplx ask`, read by `pplx chats show`). */
  query?: string;
  answer?: string;
  model?: string;
  followups?: string[];
  sources?: WebResultRef[];
  /** Generated images recorded from image-mode asks (urls expire — kept for reference). */
  images?: GeneratedImage[];
  /** Incognito thread: absent from server history, auto-deleted ~24h after creation. */
  incognito?: boolean;
  /** First-message timestamp (ISO) — the TTL anchor for incognito threads. */
  createdAt?: string;
}

function configDir(): string {
  return process.env.PPLX_CONFIG_DIR ?? join(homedir(), ".config", "pplx-cli");
}

function cacheDir(): string {
  return process.env.PPLX_CACHE_DIR ?? join(homedir(), ".cache", "pplx");
}

export function authPath(): string {
  return join(configDir(), "auth.json");
}

export function cachePath(key: string): string {
  return join(cacheDir(), `${key}.json`);
}

/** Cache dir for thread state — created 0700: files hold continuation tokens + Q/A content. */
export function threadStateDir(): string {
  return join(cacheDir(), "threads");
}

export function threadStatePath(slug: string): string {
  // Slugs are uuids in practice; keep path traversal out regardless.
  const safe = slug.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(threadStateDir(), `${safe}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const AUTH_SOURCES = new Set([
  "firefox", "zen", "librewolf", "waterfox", "chromium", "chrome", "brave", "vivaldi", "edge", "opera", "browseros", "otp",
]);

function normalizeAuth(parsed: unknown): StoredAuth | null {
  if (!isRecord(parsed)) return null;
  const { cookies, source } = parsed;
  if (parsed.kind !== "cookies" || !Array.isArray(cookies) || !cookies.every((c) => typeof c === "string")) {
    return null;
  }
  return {
    kind: "cookies",
    cookies: [...cookies],
    accountUuid: nonEmptyString(parsed.accountUuid),
    sessionExpires: nonEmptyString(parsed.sessionExpires),
    email: nonEmptyString(parsed.email),
    bearerToken: nonEmptyString(parsed.bearerToken),
    source: typeof source === "string" && AUTH_SOURCES.has(source) ? (source as StoredAuth["source"]) : "paste",
    createdAt: nonEmptyString(parsed.createdAt) ?? new Date().toISOString(),
    ...(nonEmptyString(parsed.userAgent) ? { userAgent: nonEmptyString(parsed.userAgent) as string } : {}),
  };
}

/** Load the stored auth profile. Returns null if missing or corrupt. */
export async function loadAuth(): Promise<StoredAuth | null> {
  try {
    const raw = await readFile(authPath(), "utf8");
    return normalizeAuth(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Persist the auth profile with 0600 permissions (also enforced when the file already exists). */
export async function saveAuth(auth: StoredAuth): Promise<void> {
  const path = authPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  // writeFile mode only applies on create; enforce on existing files too.
  await chmod(path, 0o600);
}

/** Delete the stored auth file. No-op if missing. */
export async function clearAuth(): Promise<void> {
  await rm(authPath(), { force: true });
}

export function cookieHeader(cookies: string[]): string {
  return cookies.join("; ");
}

/** Parse each Set-Cookie "name=value; attrs" → replace by name, keep order, append new names. */
export function upsertCookie(jar: string[], setCookie: string[]): string[] {
  const next = [...jar];
  for (const raw of setCookie) {
    const pair = raw.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name.length === 0) continue;
    const entry = `${name}=${value}`;
    const index = next.findIndex((existing) => {
      const e = existing.indexOf("=");
      return e > 0 && existing.slice(0, e) === name;
    });
    if (index >= 0) next[index] = entry;
    else next.push(entry);
  }
  return next;
}

/** Read a cached JSON value. Returns null if absent, expired (by file mtime), or corrupt. */
export async function readCache<T>(key: string, maxAgeMs: number): Promise<T | null> {
  const path = cachePath(key);
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > maxAgeMs) return null;
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeCache(key: string, value: unknown): Promise<void> {
  const path = cachePath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
}

function isThreadState(value: unknown): value is ThreadState {
  if (!isRecord(value)) return false;
  return (
    typeof value.slug === "string" &&
    typeof value.readWriteToken === "string" &&
    typeof value.lastBackendUuid === "string" &&
    typeof value.url === "string" &&
    typeof value.updatedAt === "string"
  );
}

export async function saveThreadState(state: ThreadState): Promise<void> {
  const path = threadStatePath(state.slug);
  // 0700 dir + 0600 file: thread state carries the read_write_token (a credential)
  // plus prompts/answers/sources — it must not be world-readable.
  await mkdir(threadStateDir(), { recursive: true, mode: 0o700 });
  await chmod(threadStateDir(), 0o700).catch(() => {}); // mode applies on create only
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600); // writeFile mode only applies on create
}

export async function loadThreadState(slug: string): Promise<ThreadState | null> {
  try {
    const parsed = JSON.parse(await readFile(threadStatePath(slug), "utf8"));
    return isThreadState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** All stored thread states, most recently updated first. Corrupt entries are ignored. */
export async function listThreadStates(): Promise<ThreadState[]> {
  const dir = threadStateDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const states: ThreadState[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (isThreadState(parsed)) states.push(parsed);
    } catch {
      // ignore corrupt entries
    }
  }
  return states.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** True when an incognito thread's 24h server-side lifetime has lapsed. */
export function isTempExpired(state: ThreadState, now: Date = new Date()): boolean {
  if (state.incognito !== true) return false;
  const anchor = Date.parse(state.createdAt ?? "");
  if (Number.isNaN(anchor)) return false;
  return now.getTime() - anchor > TEMP_TTL_MS;
}

/** True when an incognito thread still has server-side lifetime left. */
export function isTempLive(state: ThreadState, now: Date = new Date()): boolean {
  return state.incognito === true && !isTempExpired(state, now);
}

/** Human remaining lifetime of a temp chat: "23h" / "12m" / "expired" / "unknown" / "—" (non-temp). */
export function tempRemaining(state: ThreadState, now: Date = new Date()): string {
  if (state.incognito !== true) return "—";
  const anchor = Date.parse(state.createdAt ?? "");
  if (Number.isNaN(anchor)) return "unknown";
  const left = TEMP_TTL_MS - (now.getTime() - anchor);
  if (left <= 0) return "expired";
  const hours = Math.floor(left / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(left / 60_000))}m`;
}

/**
 * Delete state FILES for expired incognito threads (the server already deleted
 * the chat ~24h after creation; the tokens and content are dead weight and the
 * read_write_token is a credential). Files are removed by their actual
 * directory entry — not reconstructed from the slug — so a file whose name
 * doesn't match its inner slug can't survive the sweep. Returns the removed
 * slugs. Corrupt or missing files are ignored — cleanup must never throw.
 */
export async function cleanupTempThreads(now: Date = new Date()): Promise<string[]> {
  const dir = threadStateDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (!isThreadState(parsed) || !isTempExpired(parsed, now)) continue;
      await rm(join(dir, name), { force: true });
      removed.push(parsed.slug);
    } catch {
      // best-effort: an unreadable/unremovable file must not abort the sweep
    }
  }
  return removed;
}

/** Async launch-time sweep (fire-and-forget on every `pplx` run). */
export function sweepTempThreads(): void {
  void cleanupTempThreads().catch(() => {});
}
