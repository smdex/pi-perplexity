import type { CommandModule } from "yargs";
import { libraryThreads, sidebarThreads, type ThreadNode } from "../api/graphql.js";
import { restGet } from "../api/http.js";
import { deleteThread, pinThreads, setThreadTitle, unpinThreads } from "../api/threads.js";
import type { WebResultRef } from "../api/sse.js";
import { listThreadStates, loadThreadState, type ThreadState } from "../config.js";
import { renderThreadDetail, renderThreadTable } from "../render/markdown.js";
import { confirmTyped, copyToClipboard, out, run } from "./util.js";

/**
 * pplx chats list|show|rename|delete|pin|unpin (alias: threads).
 * `show` renders full thread markdown: question + answer (locally recorded
 * exchange when this CLI made it, otherwise the server-side preview) +
 * citations (locally recorded blocks, else /rest/thread/<ctx>/entry-metadata).
 */

/** Synthesize a ThreadNode from local thread state (incognito threads never hit GraphQL history). */
function nodeFromState(state: ThreadState): ThreadNode {
  return {
    id: null,
    contextUuid: null,
    entryId: state.slug,
    readWriteToken: state.readWriteToken,
    slug: state.slug,
    title: state.query ?? state.slug,
    status: "COMPLETED",
    answerPreview: state.answer ?? null,
    updatedAt: state.updatedAt,
    displayModel: state.model ?? null,
    spaceUuid: null,
  };
}

/** Find a thread by uuid/slug/contextUuid, exact title, or unique title prefix. */
export async function resolveThread(ref: string): Promise<ThreadNode | null> {
  const [sidebar, library, localStates] = await Promise.all([
    sidebarThreads().catch(() => []),
    libraryThreads().catch(() => ({ threads: [], endCursor: null, hasNextPage: false })),
    listThreadStates(),
  ]);
  const nodes = [...sidebar, ...library.threads.map((t) => t.node)];
  const byId = nodes.find((n) => n.entryId === ref || n.slug === ref || n.contextUuid === ref || n.id === ref);
  if (byId) return byId;
  const needle = ref.toLowerCase();
  const byTitle = nodes.find((n) => (n.title ?? "").toLowerCase() === needle);
  if (byTitle) return byTitle;
  // locally recorded threads (incognito: absent from GraphQL history)
  const local = localStates.find((s) => s.slug === ref || s.url === ref || (s.query ?? "").toLowerCase() === needle);
  if (local) return nodeFromState(local);
  const localPrefixes = localStates.filter((s) => (s.query ?? "").toLowerCase().startsWith(needle));
  if (localPrefixes.length === 1) return nodeFromState(localPrefixes[0]);
  const prefixes = nodes.filter((n) => (n.title ?? "").toLowerCase().startsWith(needle));
  return prefixes.length === 1 ? prefixes[0] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Collect {name,url,snippet,timestamp} objects nested (≤2 deep) under the given key. */
function collectRefs(value: unknown, depth: number, out: WebResultRef[], seen: Set<string>): void {
  if (depth < 0 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, depth - 1, out, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  const url = str(record.url);
  if (url) {
    if (!seen.has(url)) {
      seen.add(url);
      const name = str(record.name);
      const snippet = str(record.snippet);
      const timestamp = str(record.timestamp);
      out.push({
        ...(name !== null ? { name } : {}),
        ...(snippet !== null ? { snippet } : {}),
        ...(timestamp !== null ? { timestamp } : {}),
        url,
      });
    }
    return;
  }
  for (const child of Object.values(record)) {
    if (child !== null && typeof child === "object") collectRefs(child, depth - 1, out, seen);
  }
}

/**
 * GET /rest/thread/<context_uuid>/entry-metadata — the only captured
 * thread-detail endpoint (contract §G). Response body itself was never
 * captured; source_entries is parsed tolerantly and may legitimately be empty.
 */
async function fetchEntrySources(contextUuid: string): Promise<WebResultRef[]> {
  const payload = await restGet<unknown>(`/rest/thread/${contextUuid}/entry-metadata`).catch(() => null);
  if (!isRecord(payload)) return [];
  const out: WebResultRef[] = [];
  collectRefs(payload.source_entries, 2, out, new Set());
  return out;
}

export const chatsCommand: CommandModule = {
  command: ["chats", "threads"],
  describe: "list and inspect threads",
  builder: (y) =>
    y
      .command(
        "list",
        "list recent threads",
        (y3) =>
          y3
            .option("limit", { type: "number", default: 25, describe: "max threads per page" })
            .option("next", { type: "string", describe: "endCursor from the previous page" })
            .option("json", { type: "boolean", describe: "print JSON" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const page = await libraryThreads({
              after: argv.next ?? null,
            });
            const threads = page.threads.map((t) => t.node).slice(0, argv.limit ?? 25);
            if (argv.json) {
              out(JSON.stringify(threads));
            } else {
              if (threads.length === 0) {
                out("no threads found");
                return;
              }
              out(renderThreadTable(threads));
              if (page.hasNextPage && page.endCursor) {
                process.stderr.write(`more: pplx chats list --next ${page.endCursor}\n`);
              }
            }
          });
        },
      )
      .command(
        "show <ref>",
        "show one thread (uuid, slug, or unique title prefix)",
        (y3) =>
          y3
            .positional("ref", { type: "string", describe: "thread uuid, slug, or unique title prefix" })
            .option("json", { type: "boolean", describe: "print JSON" })
            .option("copy", { type: "boolean", describe: "copy the rendered markdown to the clipboard" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const ref = String(argv.ref ?? "");
            const node = await resolveThread(ref);
            if (!node) {
              throw new Error(`thread not found: ${ref} (try \`pplx chats list\` for ids/titles)`);
            }
            const slug = node.entryId ?? node.slug;
            const state = slug ? await loadThreadState(slug) : null;
            let sources = state?.sources ?? [];
            if (sources.length === 0 && node.contextUuid) {
              sources = await fetchEntrySources(node.contextUuid);
            }
            const markdown = renderThreadDetail(node, {
              ...(state?.query ? { query: state.query } : {}),
              ...(state?.answer ? { answer: state.answer } : {}),
              ...(state?.followups && state.followups.length > 0 ? { followups: state.followups } : {}),
              sources,
              ...(state?.answer ? {} : { answerIsPreview: true }),
            });
            if (argv.json) {
              out(JSON.stringify({ node, locallyRecorded: state !== null, sources }));
            } else {
              out(markdown);
            }
            if (argv.copy) {
              await copyToClipboard(argv.json ? JSON.stringify({ node, locallyRecorded: state !== null, sources }) : markdown);
            }
          });
        },
      )
      .command(
        "rename <ref> <title>",
        "rename a thread",
        (y3) =>
          y3
            .positional("ref", { type: "string", describe: "thread URL/slug uuid, context_uuid, or unique title prefix" })
            .positional("title", { type: "string", describe: "new title" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const node = await resolveThread(String(argv.ref ?? ""));
            if (!node) throw new Error(`thread not found: ${argv.ref} (try \`pplx chats list\`)`);
            if (!node.contextUuid) throw new Error("no context_uuid for this thread (incognito/local-only threads are not in server history)");
            if (!node.readWriteToken) throw new Error("no read_write_token for this thread (rerun after \`pplx chats list\` refreshes it)");
            const title = String(argv.title ?? "").trim();
            if (!title) throw new Error("title is required");
            await setThreadTitle(node.contextUuid, title, node.readWriteToken);
            out(argv.json ? JSON.stringify({ renamed: true, ref: argv.ref, title }) : `renamed to "${title}"`);
          });
        },
      )
      .command(
        ["pin <ref>", "unpin <ref>"],
        "pin/unpin a thread",
        (y3) => y3.positional("ref", { type: "string", describe: "thread URL/slug uuid, context_uuid, or unique title prefix" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const node = await resolveThread(String(argv.ref ?? ""));
            if (!node) throw new Error(`thread not found: ${argv.ref} (try \`pplx chats list\`)`);
            if (!node.contextUuid) throw new Error("no context_uuid for this thread (incognito/local-only threads are not in server history)");
            const pinned = argv._.includes("pin");
            const result = pinned ? await pinThreads([node.contextUuid]) : await unpinThreads([node.contextUuid]);
            if (result.failed.length > 0) throw new Error(`failed to ${pinned ? "pin" : "unpin"}: ${result.failed.join(", ")}`);
            out(argv.json ? JSON.stringify({ pinned, contextUuid: node.contextUuid }) : pinned ? "pinned" : "unpinned");
          });
        },
      )
      .command(
        "delete <ref>",
        "delete a thread permanently",
        (y3) =>
          y3
            .positional("ref", { type: "string", describe: "thread URL/slug uuid, context_uuid, or unique title prefix" })
            .option("yes", { type: "boolean", describe: "skip the typed confirmation" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const node = await resolveThread(String(argv.ref ?? ""));
            if (!node) throw new Error(`thread not found: ${argv.ref} (try \`pplx chats list\`)`);
            const slug = node.entryId ?? node.slug;
            if (!slug) throw new Error("no slug/URL uuid for this thread — cannot delete (needs the /search/<uuid> identifier)");
            if (!node.readWriteToken) throw new Error("no read_write_token for this thread (rerun after \`pplx chats list\` refreshes it)");
            const label = node.title ? `"${node.title}"` : `thread`;
            const ok = await confirmTyped(slug, `Delete ${label} permanently?`, { yes: argv.yes === true });
            if (!ok) return;
            await deleteThread(slug, node.readWriteToken);
            out(argv.json ? JSON.stringify({ deleted: true, slug }) : `deleted ${slug}`);
          });
        },
      )
      .demandCommand(1, "Specify a chats subcommand: list, show, rename, pin, unpin, or delete"),
  handler: () => {
    // demandCommand in the builder guarantees a subcommand runs; this parent
    // handler exists only to satisfy the CommandModule type.
  },
};

