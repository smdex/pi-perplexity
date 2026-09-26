import { restDelete, restPost } from "./http.js";

/**
 * Thread lifecycle writes — live-captured t-series (2026-09-23, t-summary.md).
 * All endpoints carry ?version=2.18&source=default + cookie auth.
 *
 * Identifier semantics (t-summary "Thread-identifier semantics"):
 * - set_thread_title / batch_pin_threads / batch_unpin_threads → context_uuid
 * - delete_thread_by_entry_uuid → the thread URL slug (= first-entry
 *   backend_uuid = GraphQL node slug/entryId), NOT context_uuid
 * - read_write_token: required for rename + delete; comes from SSE ask events
 *   and from LibraryThreadsRelayQuery Thread nodes (readWriteToken field).
 */

export interface SetThreadTitleBody {
  context_uuid: string;
  title: string;
  read_write_token: string;
}

export interface BatchThreadsBody {
  context_uuids: string[];
}

export interface DeleteThreadBody {
  /** NAMING TRAP: the server calls this `entry_uuid`, but it must carry the
   * thread URL slug uuid (first message backend_uuid == GraphQL node `slug` /
   * `entryId`), NOT the thread's context_uuid and not any later entry's uuid.
   * Sending context_uuid here silently deletes nothing / errors. */
  entry_uuid: string;
  read_write_token: string;
}

export function buildSetThreadTitleBody(contextUuid: string, title: string, readWriteToken: string): SetThreadTitleBody {
  return { context_uuid: contextUuid, title, read_write_token: readWriteToken };
}

export function buildBatchThreadsBody(contextUuids: string[]): BatchThreadsBody {
  return { context_uuids: [...contextUuids] };
}

export function buildDeleteThreadBody(slugUuid: string, readWriteToken: string): DeleteThreadBody {
  return { entry_uuid: slugUuid, read_write_token: readWriteToken };
}

/** POST /rest/thread/set_thread_title → 204 No Content. */
export async function setThreadTitle(
  contextUuid: string,
  title: string,
  readWriteToken: string,
  signal?: AbortSignal | undefined,
): Promise<void> {
  await restPost<unknown>("/rest/thread/set_thread_title", buildSetThreadTitleBody(contextUuid, title, readWriteToken), signal);
}

/** Loose — response shape per t-03 capture: {"succeeded":[…],"failed":[]}. */
export interface BatchResult {
  succeeded: string[];
  failed: string[];
}

async function batchThreads(path: string, contextUuids: string[], signal?: AbortSignal | undefined): Promise<BatchResult> {
  const result = await restPost<Partial<BatchResult>>(path, buildBatchThreadsBody(contextUuids), signal);
  return { succeeded: result.succeeded ?? [], failed: result.failed ?? [] };
}

/** POST /rest/thread/batch_pin_threads → 200 {"succeeded":[…],"failed":[]}. */
export function pinThreads(contextUuids: string[], signal?: AbortSignal | undefined): Promise<BatchResult> {
  return batchThreads("/rest/thread/batch_pin_threads", contextUuids, signal);
}

/** POST /rest/thread/batch_unpin_threads → 200 same shape (separate endpoint, not a toggle). */
export function unpinThreads(contextUuids: string[], signal?: AbortSignal | undefined): Promise<BatchResult> {
  return batchThreads("/rest/thread/batch_unpin_threads", contextUuids, signal);
}

/** DELETE /rest/thread/delete_thread_by_entry_uuid → 200 {"status":"success"}.
 * Takes the URL SLUG uuid — see DeleteThreadBody for the entry_uuid trap. */
export async function deleteThread(
  slugUuid: string,
  readWriteToken: string,
  signal?: AbortSignal | undefined,
): Promise<void> {
  await restDelete<unknown>("/rest/thread/delete_thread_by_entry_uuid", buildDeleteThreadBody(slugUuid, readWriteToken), signal);
}
