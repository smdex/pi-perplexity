import { restDelete, restGet, restPost } from "./http.js";

/**
 * Spaces/projects. List + read endpoints (contract §C) and CRUD writes
 * (s-series live capture, 2026-09-23, s-summary.md) — all /rest/collections/*
 * calls carry ?version=2.18&source=default + cookie auth.
 */

export interface Space {
  uuid: string;
  title: string;
  emoji: string | null;
}

/** Rich landing item (loose — keys beyond uuid/title/emoji are kept as-is where trivial). */
export interface SpaceItem extends Space {
  slug: string | null;
  url: string | null;
  description: string | null;
  threadCount: number | null;
  updatedAt: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toItem(raw: unknown): SpaceItem | null {
  if (!isRecord(raw)) return null;
  const uuid = str(raw.uuid);
  const title = str(raw.title);
  if (!uuid || !title) return null;
  const threadCount = typeof raw.thread_count === "number" ? raw.thread_count : null;
  return {
    uuid,
    title,
    emoji: str(raw.emoji),
    slug: str(raw.slug),
    url: str(raw.url),
    description: str(raw.description),
    threadCount,
    updatedAt: str(raw.updated_datetime),
  };
}

/**
 * GET /rest/spaces/landing/v2?limit=30 — `sections.{main,pinned,invited}.items`
 * (capture had empty pinned/invited; merge all three, main first, dedupe by uuid).
 */
export async function listSpaces(opts?: { limit?: number; signal?: AbortSignal | undefined }): Promise<SpaceItem[]> {
  const payload = await restGet<unknown>("/rest/spaces/landing/v2", { limit: opts?.limit ?? 30 }, opts?.signal);
  const sections = isRecord(payload) && isRecord(payload.sections) ? payload.sections : {};
  const items: SpaceItem[] = [];
  const seen = new Set<string>();
  for (const key of ["main", "pinned", "invited"]) {
    const section = isRecord(sections[key]) ? sections[key] : {};
    const list = Array.isArray(section.items) ? section.items : [];
    for (const raw of list) {
      const item = toItem(raw);
      if (item && !seen.has(item.uuid)) {
        seen.add(item.uuid);
        items.push(item);
      }
    }
  }
  return items;
}

/** GET /rest/spaces/mentions — light list, complete, no paging (recommended for name lookups). */
export async function listSpacesMentions(signal?: AbortSignal | undefined): Promise<Space[]> {
  const payload = await restGet<unknown>("/rest/spaces/mentions", undefined, signal);
  const spaces = isRecord(payload) && Array.isArray(payload.spaces) ? payload.spaces : [];
  return spaces
    .map((raw) => toItem(raw))
    .filter((s): s is SpaceItem => s !== null)
    .map((s) => ({ uuid: s.uuid, title: s.title, emoji: s.emoji }));
}

/** Resolve a space by exact uuid → exact (case-insensitive) title → unique title prefix. */
export async function resolveSpace(ref: string, signal?: AbortSignal | undefined): Promise<SpaceItem | null> {
  const all = await listSpaces({ signal });
  const byUuid = all.find((s) => s.uuid === ref);
  if (byUuid) return byUuid;
  const needle = ref.toLowerCase();
  const byTitle = all.find((s) => s.title.toLowerCase() === needle);
  if (byTitle) return byTitle;
  const prefixes = all.filter((s) => s.title.toLowerCase().startsWith(needle));
  return prefixes.length === 1 ? prefixes[0] : null;
}

/** Create body verbatim from s-01-create-post.json (defaults = web client's). */
export interface CreateSpaceInput {
  title: string;
  description?: string;
  emoji?: string; // hex without leading U+ ("1f4c1" = 📁)
  instructions?: string;
}

export interface CreateSpaceBody {
  title: string;
  description: string;
  emoji: string;
  /** Capture sends null (empty appearance picker state). */
  appearance: null;
  instructions: string;
  access: number;
  project_brain_auto_update_enabled: boolean;
  creation_context: { entry_point: string; creation_method: string };
}

export function buildCreateSpaceBody(input: CreateSpaceInput): CreateSpaceBody {
  return {
    title: input.title,
    description: input.description ?? "",
    emoji: input.emoji ?? "1f4c1",
    appearance: null,
    instructions: input.instructions ?? "",
    access: 1,
    project_brain_auto_update_enabled: false,
    creation_context: { entry_point: "sidebarHeader", creation_method: "blank" },
  };
}

/** POST /rest/collections/create_collection → 200 full space object (uuid, url/slug). */
export async function createSpace(input: CreateSpaceInput, signal?: AbortSignal | undefined): Promise<SpaceItem> {
  const raw = await restPost<unknown>("/rest/collections/create_collection", buildCreateSpaceBody(input), signal);
  const item = toItem(raw);
  if (!item) throw new Error("create_collection: response missing uuid/title");
  return item;
}

/** POST /rest/collections/edit_collection/<uuid> — partial update body {title}. → 200 {"title":…}. */
export async function renameSpace(uuid: string, title: string, signal?: AbortSignal | undefined): Promise<void> {
  await restPost<unknown>(`/rest/collections/edit_collection/${uuid}`, { title }, signal);
}

/** DELETE /rest/collections/delete_collection/<uuid> — no body. → 200 null. */
export async function deleteSpace(uuid: string, signal?: AbortSignal | undefined): Promise<void> {
  await restDelete<unknown>(`/rest/collections/delete_collection/${uuid}`, undefined, signal);
}
