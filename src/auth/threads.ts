import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Local continuation registry for Perplexity threads (mirrors the pplx CLI's
 * $PPLX_CACHE_DIR/threads/ layout). Every completed search writes a state file
 * so a later tool call can continue the same conversation:
 *   - `thread: "<slug>"` — continue a specific conversation,
 *   - `continue: true`   — continue the most recent incognito ("temp") chat.
 * Incognito chats are server-deleted ~24h after creation; entries carry a
 * createdAt TTL anchor so stale state is swept automatically.
 */

export const TEMP_TTL_MS = 24 * 60 * 60 * 1000;

export interface ThreadState {
  /** thread_url_slug from the SSE stream — the stable session id. */
  slug: string;
  /** Follow-up credential from the stream (first event). */
  readWriteToken: string;
  /** Last entry uuid → next follow-up's last_backend_uuid. */
  lastBackendUuid: string;
  /** Human-viewable thread URL (ORIGIN + /search/ + slug). */
  url: string;
  updatedAt: string;
  /** First query (context label for /perplexity-threads listing). */
  query?: string;
  model?: string;
  /** Incognito thread: server deletes it ~24h after createdAt. */
  incognito?: boolean;
  /** TTL anchor = first message timestamp (ISO). */
  createdAt?: string;
}

const STATE_DIR = join(homedir(), ".cache", "pi-perplexity", "threads");

export function threadStateDir(): string {
  return process.env.PI_PERPLEXITY_CACHE_DIR
    ? join(process.env.PI_PERPLEXITY_CACHE_DIR, "threads")
    : STATE_DIR;
}

function statePath(slug: string): string {
  // Slugs are uuids, but sanitize anyway — the value flows from a remote stream.
  const safe = slug.replace(/[^0-9a-zA-Z._-]/g, "_");
  return join(threadStateDir(), `${safe}.json`);
}

function isThreadState(value: unknown): value is ThreadState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.slug === "string" &&
    typeof candidate.readWriteToken === "string" &&
    typeof candidate.lastBackendUuid === "string" &&
    typeof candidate.url === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

/** Persist a thread state file (0700 dir / 0600 file — holds the read_write_token credential). */
export async function saveThreadState(state: ThreadState): Promise<void> {
  const dir = threadStateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {}); // mode applies on create only
  const path = statePath(state.slug);
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600); // writeFile mode applies on create only
}

export async function loadThreadState(slug: string): Promise<ThreadState | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(slug), "utf8"));
    return isThreadState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** All stored thread states, most recently updated first. Corrupt entries are ignored. */
export async function listThreadStates(): Promise<ThreadState[]> {
  let names: string[];
  try {
    names = await readdir(threadStateDir());
  } catch {
    return [];
  }
  const states: ThreadState[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(threadStateDir(), name), "utf8"));
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

/** Remaining server-side lifetime for an incognito thread (null when not incognito or no anchor). */
export function tempRemaining(state: ThreadState, now: Date = new Date()): number | null {
  if (state.incognito !== true) return null;
  const anchor = Date.parse(state.createdAt ?? "");
  if (Number.isNaN(anchor)) return null;
  return Math.max(0, TEMP_TTL_MS - (now.getTime() - anchor));
}

/** Compact human duration ("23h 42m", "5m", "expired"). */
export function formatRemaining(ms: number | null): string {
  if (ms === null) return "";
  if (ms <= 0) return "expired";
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m left`;
  return `${minutes}m left`;
}

/** Delete state files for expired incognito threads (the server already deleted the chat). */
export async function cleanupTempThreads(now: Date = new Date()): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(threadStateDir());
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await readFile(join(threadStateDir(), name), "utf8"));
      if (!isThreadState(parsed) || !isTempExpired(parsed, now)) continue;
      await rm(join(threadStateDir(), name), { force: true });
      removed.push(parsed.slug);
    } catch {
      // best-effort: never throw from the sweep
    }
  }
  return removed;
}
