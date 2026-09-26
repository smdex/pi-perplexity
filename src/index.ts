import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerPerplexityConfigCommand } from "./commands/config.js";
import { registerPerplexityCommands, registerPerplexityThreadsCommand } from "./commands/login.js";

import { authenticate, type AuthCredentials } from "./auth/login.js";
import {
  cleanupTempThreads,
  isTempLive,
  listThreadStates,
  loadThreadState,
  saveThreadState,
} from "./auth/threads.js";
import { loadConfig, resolveDefaultModel } from "./config.js";
import { effectiveSourceCount, formatForLLM } from "./search/format.js";
import { searchPerplexity } from "./search/client.js";
import { renderPerplexityCall } from "./render/call.js";
import { renderPerplexityResult } from "./render/result.js";
import { errorMessage } from "./util.js";
import { AuthError, SearchError } from "./search/types.js";

/** Extract a thread slug from a bare uuid, a /search/<uuid> URL, or a full thread URL. */
function threadSlugFromRef(ref: string): string {
  const match = ref.match(/\/search\/([0-9a-f-]{36})/i);
  if (match?.[1]) return match[1];
  return ref.trim();
}

export default function (pi: ExtensionAPI) {
  registerPerplexityCommands(pi);
  registerPerplexityConfigCommand(pi);
  registerPerplexityThreadsCommand(pi);
  pi.registerTool({
    name: "perplexity_search",
    label: "Perplexity Search",
    description:
      "Search the web using Perplexity. Pass thread (a session id) or continue=true to keep the same Perplexity conversation across calls.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      thread: Type.Optional(
        Type.String({
          description:
            "Session id (thread_url_slug from a previous result's Meta section, or a perplexity.ai/search/<id> URL) — continue that conversation",
        }),
      ),
      continue: Type.Optional(
        Type.Boolean({
          description:
            "Continue the most recent live Perplexity session instead of starting a new one",
        }),
      ),
      recency: Type.Optional(
        StringEnum(["hour", "day", "week", "month", "year"] as const, {
          description: "Filter results by recency",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max sources to return", minimum: 1, maximum: 50 }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model slug (live catalog: anything from GET /rest/models/config — see /perplexity-config)",
        }),
      ),
    }),
    renderCall: renderPerplexityCall,
    renderResult: renderPerplexityResult,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const start = Date.now();
      let sourceCount = 0;

      try {
        onUpdate?.({
          content: [{ type: "text", text: "Authenticating with Perplexity..." }],
          details: { toolCallId },
        });

        const promptInput = async (label: string, placeholder: string): Promise<string | null | undefined> => {
          if (!ctx?.ui?.input) {
            return undefined;
          }

          return ctx.ui.input(label, placeholder);
        };

        const credentials: AuthCredentials = await authenticate({
          ...(signal !== undefined ? { signal } : {}),
          promptForEmail: async () => promptInput("Perplexity email", "you@example.com"),
          promptForOtp: async (email) => promptInput(`Enter OTP sent to ${email}`, "123456"),
        });

        if (signal?.aborted) {
          return {
            content: [{ type: "text", text: "Perplexity search was cancelled." }],
            details: { sourceCount: 0, queryMs: Date.now() - start },
          };
        }

        onUpdate?.({
          content: [{ type: "text", text: "Querying Perplexity..." }],
          details: { toolCallId },
        });

        // --- follow-up resolution (thread ref > continue flag) ---
        void cleanupTempThreads().catch(() => undefined); // fire-and-forget TTL sweep
        let followup: { lastBackendUuid: string; readWriteToken: string } | undefined;
        let priorCreatedAt: string | undefined;
        let continuedSession: string | null = null;

        if (typeof params.thread === "string" && params.thread.trim().length > 0) {
          const slug = threadSlugFromRef(params.thread);
          const state = await loadThreadState(slug);
          if (state) {
            followup = { lastBackendUuid: state.lastBackendUuid, readWriteToken: state.readWriteToken };
            priorCreatedAt = state.createdAt;
            continuedSession = state.slug;
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: `No local session state for thread "${slug}". Sessions can only be continued in the same environment where they were started (incognito chats are also deleted server-side after ~24h). Start a new search instead, or pass continue=true.`,
                },
              ],
              details: { sourceCount: 0, queryMs: Date.now() - start, isError: true },
            };
          }
        } else if (params.continue === true) {
          const live = (await listThreadStates()).find((state) => isTempLive(state));
          if (!live) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    'No live Perplexity session to continue. Start one with a plain query (its Meta section will include a "Session ID" you can pass as thread later).',
                },
              ],
              details: { sourceCount: 0, queryMs: Date.now() - start, isError: true },
            };
          }
          followup = { lastBackendUuid: live.lastBackendUuid, readWriteToken: live.readWriteToken };
          priorCreatedAt = live.createdAt;
          continuedSession = live.slug;
        }

        const config = await loadConfig();
        const model = resolveDefaultModel(config);

        const result = await searchPerplexity(
          {
            query: params.query,
            model,
            ...(params.recency !== undefined ? { recency: params.recency } : {}),
            ...(followup ? { followup } : {}),
          },
          credentials,
          signal,
        );

        const formatted = formatForLLM(result, params.limit);
        sourceCount = effectiveSourceCount(result.sources.length, params.limit);

        // persist thread state for continuation (needs slug + rwToken + last backend uuid)
        const finalSlug = result.slug ?? (continuedSession && result.readWriteToken && result.backendUuid ? continuedSession : null);
        if (finalSlug && result.readWriteToken && result.backendUuid) {
          const now = new Date().toISOString();
          await saveThreadState({
            slug: finalSlug,
            readWriteToken: result.readWriteToken,
            lastBackendUuid: result.backendUuid,
            url: `https://www.perplexity.ai/search/${finalSlug}`,
            updatedAt: now,
            query: params.query,
            ...(result.displayModel ? { model: result.displayModel } : {}),
            incognito: true,
            createdAt: priorCreatedAt ?? now,
          }).catch(() => undefined);
        }

        return {
          content: [{ type: "text", text: formatted }],
          details: {
            model: result.displayModel,
            sourceCount,
            queryMs: Date.now() - start,
            uuid: result.uuid,
            ...(result.slug ? { thread: result.slug } : {}),
            ...(continuedSession ? { continued: continuedSession } : {}),
            authSource: credentials.source,
          },
        };
      } catch (error) {
        const queryMs = Date.now() - start;

        if (error instanceof AuthError) {
          return {
            content: [{ type: "text", text: `Authentication failed: ${error.message}` }],
            details: { sourceCount, queryMs, isError: true },
          };
        }

        if (error instanceof SearchError) {
          return {
            content: [{ type: "text", text: `Perplexity search failed: ${error.message}` }],
            details: { sourceCount, queryMs, isError: true },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Perplexity search failed: ${errorMessage(error)}`,
            },
          ],
          details: { sourceCount, queryMs, isError: true },
        };
      }
    },
  });
}
