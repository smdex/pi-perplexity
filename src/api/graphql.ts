import { apiPost } from "./http.js";

/**
 * Persisted-query GraphQL against POST /rest/perplexity_ask/graphql
 * (captured WITHOUT query params — hashes and variables verbatim from
 * a-trace entries 2/4/15, contract §B).
 */

export interface ThreadNode {
  id: string | null; // opaque "TH:<base64>"
  contextUuid: string | null;
  entryId: string | null; // first-entry uuid == slug == thread page uuid
  readWriteToken: string | null;
  slug: string | null;
  title: string | null; // node.name (sidebar wrapper uses node.title)
  status: string | null;
  answerPreview: string | null;
  updatedAt: string | null; // ISO
  displayModel: string | null; // displayModel.modelID
  spaceUuid: string | null;
}

export interface ThreadPage {
  threads: { cursor: string | null; node: ThreadNode }[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export const PERSISTED_HASHES = {
  SidebarRecentItemsRelayQuery: "1dcb15dc33c957d936c0c77a6066ae587d21913b4247a53d71fe6ebc8b807e8a",
  LibraryThreadsRelayQuery: "1c1f9e86416eddf3dfed6ede99575a5cc241b59cf079f2e9295ed927f2908006",
  SpaceProjectThreadsRelayQuery: "db13bf755b93bc2645f536609fb6e70c4f7da4093a93fa103d9fa109bb31d066",
} as const;

export type OperationName = keyof typeof PERSISTED_HASHES;

export interface GraphQLBody {
  operationName: string;
  variables: Record<string, unknown>;
  extensions: { persistedQuery: { version: 1; sha256Hash: string } };
}

/** Exact contract §B body shape. The `pplx.independentSidebarRollout` extension is omittable (§I.5). */
export function buildGraphQLBody(
  operation: OperationName,
  variables: Record<string, unknown>,
): GraphQLBody {
  return {
    operationName: operation,
    variables,
    extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED_HASHES[operation] } },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** POST one persisted query. Base headers already carry x-pplx-account. Throws on GraphQL errors. */
export async function graphqlPost<T>(
  operation: OperationName,
  variables: Record<string, unknown>,
  signal?: AbortSignal | undefined,
): Promise<T> {
  const response = await apiPost(
    "/rest/perplexity_ask/graphql",
    buildGraphQLBody(operation, variables),
    {},
    { signal },
  );
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) throw new Error(`GraphQL ${operation}: unparseable response`);
  if (payload.data === undefined && Array.isArray(payload.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    const message = isRecord(first) && typeof first.message === "string" ? first.message : JSON.stringify(first);
    throw new Error(`GraphQL ${operation} failed: ${message}`);
  }
  return payload as T;
}

/**
 * Tolerant Thread mapping (contract §I.6: Relay payloads may vary — every field
 * optional). `sidebar` carries the wrapper's {title, activityAt} when the node
 * comes from SidebarRecentItemsRelayQuery ({title, activityAt, object: Thread}).
 */
export function toThreadNode(raw: unknown, sidebar?: { title?: unknown; activityAt?: unknown }): ThreadNode {
  if (!isRecord(raw)) {
    return {
      id: null, contextUuid: null, entryId: null, readWriteToken: null, slug: null,
      title: str(sidebar?.title) ?? null, status: null, answerPreview: null, updatedAt: str(sidebar?.activityAt),
      displayModel: null, spaceUuid: null,
    };
  }
  const displayModel = isRecord(raw.displayModel) ? raw.displayModel : {};
  const space = isRecord(raw.space) ? raw.space : {};
  return {
    id: str(raw.id),
    contextUuid: str(raw.contextUUID),
    entryId: str(raw.entryId),
    readWriteToken: str(raw.readWriteToken),
    slug: str(raw.slug),
    title: str(sidebar?.title) ?? str(raw.name),
    status: str(raw.status),
    answerPreview: str(raw.answerPreview),
    updatedAt: str(sidebar?.activityAt) ?? str(raw.updatedAt),
    displayModel: str(displayModel.modelID),
    spaceUuid: str(space.uuid),
  };
}

/**
 * Parse `data.viewer.recentGroup.threads` (library) or
 * `data.viewer.space.threadGroup.threads` (space). Missing keys → empty page.
 */
export function parseThreadPage(payload: unknown, path: "library" | "space"): ThreadPage {
  const empty: ThreadPage = { threads: [], endCursor: null, hasNextPage: false };
  if (!isRecord(payload)) return empty;
  const data = isRecord(payload.data) ? payload.data : {};
  const viewer = isRecord(data.viewer) ? data.viewer : {};
  const group =
    path === "library"
      ? isRecord(viewer.recentGroup)
        ? viewer.recentGroup
        : {}
      : isRecord(viewer.space) && isRecord(viewer.space.threadGroup)
        ? viewer.space.threadGroup
        : {};
  const threads = isRecord(group.threads) ? group.threads : {};
  const edges = Array.isArray(threads.edges) ? threads.edges : [];
  const pageInfo = isRecord(threads.pageInfo) ? threads.pageInfo : {};
  return {
    threads: edges
      .map((edge) => (isRecord(edge) ? { cursor: str(edge.cursor), node: toThreadNode(edge.node) } : null))
      .filter((e): e is { cursor: string | null; node: ThreadNode } => e !== null),
    endCursor: str(pageInfo.endCursor),
    hasNextPage: pageInfo.hasNextPage === true,
  };
}

/** Sidebar recent threads: `data.viewer.recentSidebarItems.items.edges[].node` = {title, activityAt, object}. */
export async function sidebarThreads(opts?: { first?: number; signal?: AbortSignal | undefined }): Promise<ThreadNode[]> {
  const payload = await graphqlPost<unknown>(
    "SidebarRecentItemsRelayQuery",
    { first: opts?.first ?? 20, types: ["THREAD"] },
    opts?.signal,
  );
  if (!isRecord(payload)) return [];
  const data = isRecord(payload.data) ? payload.data : {};
  const viewer = isRecord(data.viewer) ? data.viewer : {};
  const items = isRecord(viewer.recentSidebarItems) ? viewer.recentSidebarItems : {};
  const edges = isRecord(items.items) && Array.isArray(items.items.edges) ? items.items.edges : [];
  return edges
    .map((edge) => {
      if (!isRecord(edge) || !isRecord(edge.node)) return null;
      const node = edge.node;
      return toThreadNode(node.object, { title: node.title, activityAt: node.activityAt });
    })
    .filter((n): n is ThreadNode => n !== null);
}

/** Library/history threads, 25/page; cursor `after` = previous pageInfo.endCursor. */
export async function libraryThreads(opts?: {
  after?: string | null;
  searchTerm?: string | null;
  signal?: AbortSignal | undefined;
}): Promise<ThreadPage> {
  const payload = await graphqlPost<unknown>(
    "LibraryThreadsRelayQuery",
    {
      includeSearchPreview: false,
      searchTerm: opts?.searchTerm ?? null,
      sortOrder: "NEWEST",
      statuses: null,
      threadTypes: null,
      sources: null,
      includeTemporary: null,
      after: opts?.after ?? null,
    },
    opts?.signal,
  );
  return parseThreadPage(payload, "library");
}

/** Threads inside one space (space uuid, not slug). */
export async function spaceThreads(
  spaceId: string,
  opts?: { cursor?: string | null; count?: number; signal?: AbortSignal | undefined },
): Promise<ThreadPage> {
  const payload = await graphqlPost<unknown>(
    "SpaceProjectThreadsRelayQuery",
    {
      spaceId,
      ownThreadsOnly: false,
      searchTerm: null,
      groupType: "ALL",
      count: opts?.count ?? 25,
      cursor: opts?.cursor ?? null,
    },
    opts?.signal,
  );
  return parseThreadPage(payload, "space");
}
