import type { Argv, CommandModule } from "yargs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ORIGIN } from "../constants.js";
import { streamAsk, type AskOptions } from "../api/ask.js";
import { uploadFile } from "../api/uploads.js";
import { resolveAskDefaults } from "../ask_defaults.js";
import { libraryThreads, sidebarThreads } from "../api/graphql.js";
import { isTempExpired, isTempLive, listThreadStates, loadSettings, loadThreadState, saveThreadState, tempRemaining, type ThreadState } from "../config.js";
import { renderAnswer } from "../render/markdown.js";
import { AnswerStreamPrinter } from "../render/answer-stream.js";
import { StderrSpinner } from "../render/spinner.js";
import { copyToClipboard, out, run, threadSlugFromRef, warn } from "./util.js";

/**
 * pplx ask <query..> — previews snapshots in a terminal; pipes get the final answer.
 * pplx research <query..> — same flow on the deep-research engine:
 * model_preference "pplx_alpha" (verified r-summary §1), no cache key;
 * longer runtime, separate quota family (agentic_research).
 */

interface AskArgs {
  query: string[];
  model?: string;
  recency?: AskOptions["recency"];
  sources?: string[];
  attach?: string[];
  thread?: string;
  incognito?: boolean;
  space?: string | false;
  json?: boolean;
  copy?: boolean;
  stream?: boolean;
  continue?: boolean;
  saveImages?: string;
  save?: string;
}

/** Human remaining lifetime of a live temp chat ("23h", "12m", "expired"). */
export { tempRemaining } from "../config.js";

/** Resolve --thread into a follow-up context: local state first, GraphQL fallback second. */
async function resolveFollowup(
  ref: string,
): Promise<{ followup: { lastBackendUuid: string; readWriteToken: string }; slug: string }> {
  const slug = threadSlugFromRef(ref);
  if (!slug) throw new Error(`could not parse a thread slug from: ${ref}`);

  const state = await loadThreadState(slug);
  if (state) {
    if (isTempExpired(state)) {
      throw new Error(
        `temp chat ${slug} expired — Perplexity deletes incognito threads ~24h after creation; start a new one: pplx ask "…"`,
      );
    }
    return { followup: { lastBackendUuid: state.lastBackendUuid, readWriteToken: state.readWriteToken }, slug };
  }

  // No local state (ask made elsewhere / cache cleared): best-effort GraphQL lookup.
  const [sidebar, library] = await Promise.all([
    sidebarThreads().catch(() => []),
    libraryThreads().catch(() => ({ threads: [], endCursor: null, hasNextPage: false })),
  ]);
  const node = [...sidebar, ...library.threads.map((t) => t.node)].find(
    (n) => n.entryId === slug || n.slug === slug || n.contextUuid === slug,
  );
  if (node?.readWriteToken && node.entryId) {
    warn(
      `no local state for this thread — continuing from its FIRST entry; earlier turns are still visible to the server but the reply chain may be incomplete`,
    );
    return { followup: { lastBackendUuid: node.entryId, readWriteToken: node.readWriteToken }, slug };
  }
  throw new Error(
    `thread ${slug} not found in local state or recent history (chats created by other clients may be too old or incognito)`,
  );
}

async function executeAsk(argv: AskArgs, mode: "search" | "research"): Promise<void> {
  const query = argv.query.join(" ").trim();
  if (!query) throw new Error("query is required (pplx ask \"your question\")");
  const json = argv.json === true;
  const streamToStdout = argv.stream !== false && !json && process.stdout.isTTY === true;

  const printer = new AnswerStreamPrinter(process.stdout);
  const abort = new AbortController();
  const interrupt = (): void => abort.abort(new DOMException("interrupted", "AbortError"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const spinner = new StderrSpinner();
  spinner.start(mode === "research" ? "running deep research (may take minutes)…" : "asking Perplexity…");

  try {
    // --thread follow-up context; --continue picks the most recent live temp chat
    let followup: AskOptions["followup"];
    let slug: string | null = null;
    let priorState: ThreadState | null = null;
    if (argv.thread) {
      const resolved = await resolveFollowup(argv.thread);
      followup = resolved.followup;
      slug = resolved.slug;
      priorState = await loadThreadState(slug);
    } else if (argv.continue === true) {
      const live = (await listThreadStates()).find((s) => isTempLive(s)); // listThreadStates sorts by updatedAt desc
      if (!live) {
        throw new Error(`no live temp chat to continue — start one: pplx ask "…" (temp chats live ~24h)`);
      }
      followup = { lastBackendUuid: live.lastBackendUuid, readWriteToken: live.readWriteToken };
      slug = live.slug;
      priorState = live;
      if (!json) process.stderr.write(`continuing temp chat ${live.slug} (${tempRemaining(live)} left)\n`);
    }

    const defaults = await resolveAskDefaults({
      mode,
      ...(argv.model ? { model: argv.model } : {}),
      ...(argv.sources ? { sources: argv.sources } : {}),
      ...(typeof argv.space === "string" ? { space: argv.space } : {}),
      ...(argv.space === false ? { noSpace: true } : {}),
      ...(argv.incognito !== undefined ? { incognito: argv.incognito } : {}),
      ...(argv.thread ? { thread: argv.thread } : {}),
      ...(argv.continue ? { continueThread: true } : {}),
    }, await loadSettings());
    if (defaults.ignoredConfiguredSpace) {
      warn("configured space applies only to new threads; continuing the existing thread without retargeting it");
    }
    const { space } = defaults;

    // --attach uploads: presign → S3 POST → subscribe SSE
    let attachments: string[] | undefined;
    if (argv.attach && argv.attach.length > 0) {
      spinner.update(`uploading ${argv.attach.length} file(s)…`);
      const uploaded: string[] = [];
      for (const file of argv.attach) {
        const result = await uploadFile(file);
        uploaded.push(result.s3ObjectUrl);
      }
      attachments = uploaded;
    }

    const onEvent = (partialAnswer: string): void => {
      if (partialAnswer) spinner.stop();
      if (streamToStdout) printer.update(partialAnswer);
    };

    const result = await streamAsk(
      {
        query,
        ...(defaults.model ? { model: defaults.model } : {}),
        ...(argv.recency ? { recency: argv.recency } : {}),
        ...(defaults.sources ? { sources: defaults.sources } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        incognito: defaults.incognito,
        ...(followup ? { followup } : {}),
        ...(space ? { space } : {}),
        ...(mode === "research" ? { research: true } : {}),
      },
      { onEvent, signal: abort.signal },
    );
    spinner.stop();

    if (!json) {
      printer.finish(result.answer);
      process.stdout.write("\n\n");
      // The answer text was already written above (streamed or flushed) — the
      // trailing block carries only sources / follow-ups / meta (plan §4.9).
      out(renderAnswer(result, { followups: true, answer: false }));
    } else {
      out(JSON.stringify(result));
    }

    if (argv.copy) {
      await copyToClipboard(result.answer);
      process.stderr.write("answer copied to clipboard\n");
    }

    // --save-images: download generated images immediately (S3 urls expire ~35min)
    if (argv.saveImages && result.images.length > 0) {
      const dir = argv.saveImages.length === 0 ? "." : argv.saveImages;
      await mkdir(dir, { recursive: true });
      for (const [i, img] of result.images.entries()) {
        const name = img.filename ?? `pplx-image-${slug ?? "ask"}-${i + 1}.png`;
        const safe = name.replace(/[/\\?%*:|"<>]/g, "_");
        try {
          const image = new URL(img.url);
          // ponytail: host allowlist, not a full SSRF policy — widen if Perplexity adds image CDNs
          if (image.protocol !== "https:" || !/(^|\.)amazonaws\.com$|(^|\.)perplexity\.ai$/.test(image.hostname)) {
            throw new Error(`refusing to fetch image from ${image.hostname}`);
          }
          const res = await fetch(image);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          await writeFile(join(dir, safe), bytes);
          process.stderr.write(`saved image ${i + 1} → ${join(dir, safe)}\n`);
        } catch (err) {
          warn(`failed to save image ${i + 1} (${err instanceof Error ? err.message : String(err)}) — copy its url from the Images section now`);
        }
      }
    }

    // --save: dump the final reply to a file — exactly what stdout printed
    // (answer + trailing sources/meta block), or the JSON result in --json mode
    if (argv.save) {
      const text = json
        ? JSON.stringify(result)
        : `${result.answer}\n\n${renderAnswer(result, { followups: true, answer: false })}`;
      await mkdir(dirname(argv.save), { recursive: true });
      await writeFile(argv.save, text);
      process.stderr.write(`saved reply → ${argv.save}\n`);
    }

    // persist thread state for --thread follow-ups + `chats show`
    const finalSlug = slug ?? (result.threadUrl ? threadSlugFromRef(result.threadUrl) : null);
    const incognito = defaults.incognito;
    if (finalSlug && result.readWriteToken && result.backendUuid) {
      await saveThreadState({
        slug: finalSlug,
        readWriteToken: result.readWriteToken,
        lastBackendUuid: result.backendUuid,
        url: `${ORIGIN}/search/${finalSlug}`,
        updatedAt: new Date().toISOString(),
        // TTL anchor is the FIRST message: follow-ups reuse the existing anchor
        ...(incognito
          ? { incognito: true, createdAt: priorState?.createdAt ?? new Date().toISOString() }
          : {}),
        query,
        answer: result.answer,
        ...(result.model ? { model: result.model } : {}),
        followups: result.followups,
        sources: result.sources,
        ...(result.images.length > 0 ? { images: result.images } : {}),
      });
      if (!json) {
        if (incognito) {
          const left = tempRemaining({
            slug: finalSlug,
            readWriteToken: result.readWriteToken,
            lastBackendUuid: result.backendUuid,
            url: `${ORIGIN}/search/${finalSlug}`,
            updatedAt: new Date().toISOString(),
            incognito: true,
            ...(priorState?.createdAt ? { createdAt: priorState.createdAt } : { createdAt: new Date().toISOString() }),
          });
          process.stderr.write(
            `temp chat ${finalSlug} (expires in ${left}; auto-deleted from history) — continue: pplx ask --continue "…" or --thread ${finalSlug}\n`,
          );
        } else {
          process.stderr.write(`follow up: pplx ask --thread ${finalSlug} "…"\n`);
        }
      }
    } else if (!json) {
      process.stderr.write("note: no thread url in stream — follow-ups unavailable for this answer\n");
    }
  } finally {
    spinner.stop();
    printer.restore();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

function askOptions(y: Argv): Argv {
  return y
    .positional("query", { type: "string", describe: "the question" })
    .option("model", { type: "string", describe: "model slug (overrides saved model; see `pplx models`)" })
    .option("recency", { type: "string", choices: ["hour", "day", "week", "month", "year"], describe: "filter results by age" })
    .option("sources", { type: "array", string: true, describe: "replace saved sources; use --sources web to bypass configured connectors" })
    .option("attach", { type: "array", string: true, describe: "files to upload and attach" })
    .option("thread", { type: "string", describe: "thread slug or URL to continue" })
    .option("continue", { type: "boolean", describe: "continue the most recent live temp chat" })
    .option("incognito", {
      type: "boolean",
      default: true,
      describe: "temp chat: excluded from history, auto-deleted ~24h (use --no-incognito to keep)",
    })
    .option("space", { type: "string", describe: "space title/uuid (requires --no-incognito); --no-space bypasses saved space" })
    .option("json", { type: "boolean", describe: "print a single JSON result" })
    .option("copy", { type: "boolean", describe: "copy the final answer to the clipboard" })
    .option("save-images", {
      type: "string",
      describe: "download generated images to this dir (urls expire ~35min; default .)",
    })
    .option("save", {
      type: "string",
      describe: "write the final reply (answer + sources/meta, or JSON with --json) to this file",
    })
    .option("stream", { type: "boolean", default: true, describe: "preview the answer while generating in a terminal (pipes receive only the final result)" });
}

export const askCommand: CommandModule = {
  command: "ask <query..>",
  describe: "ask Perplexity a question; streams the answer to stdout",
  builder: (y) => askOptions(y),
  handler: (argv) => {
    // SAFETY: yargs types argv as a loose record; askOptions above declares the exact flags
    const args = argv as unknown as AskArgs;
    return run(args.json === true, () => executeAsk(args, "search"));
  },
};

export const researchCommand: CommandModule = {
  command: "research <query..>",
  describe: "deep-research ask on the pplx_alpha engine (runs longer than a normal ask)",
  builder: (y) => askOptions(y),
  handler: (argv) => {
    // SAFETY: same shared askOptions schema guarantees the shape
    const args = argv as unknown as AskArgs;
    return run(args.json === true, () => executeAsk(args, "research"));
  },
};
