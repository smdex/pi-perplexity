import type { Argv, CommandModule } from "yargs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ORIGIN } from "../constants.js";
import { streamAsk, type AskOptions } from "../api/ask.js";
import { uploadFile } from "../api/uploads.js";
import { resolveSpace } from "../api/spaces.js";
import { libraryThreads, sidebarThreads } from "../api/graphql.js";
import { isTempExpired, isTempLive, listThreadStates, loadThreadState, saveThreadState, tempRemaining, type ThreadState } from "../config.js";
import { renderAnswer } from "../render/markdown.js";
import { StderrSpinner } from "../render/spinner.js";
import { copyToClipboard, out, run, threadSlugFromRef, warn } from "./util.js";

/**
 * pplx ask <query..> — streams the answer to stdout as snapshots arrive
 * (only the newly appended suffix is written; snapshots are full-state).
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
  space?: string;
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
  const streamToStdout = argv.stream !== false && !json;

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

    // --space targeting (verified: s-summary “Ask inside space” —
    // params.target_collection_uuid + target_thread_access_level:5 + query_source "collection")
    let space: string | undefined;
    if (argv.space) {
      const resolved = await resolveSpace(argv.space);
      if (!resolved) throw new Error(`space not found: ${argv.space} (see \`pplx spaces list\`)`);
      space = resolved.uuid;
    }

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

    // stream: write only the newly appended suffix (snapshots are full-state).
    // The webapp sometimes REWRITES already-shown text (chunk_starting_offset
    // updates shrink the text, it regrows later) — on shrink, resync by
    // reprinting the full snapshot instead of silently desyncing.
    let printed = "";
    let spinnerStopped = false;
    const onEvent = (partialAnswer: string): void => {
      if (!partialAnswer) return;
      if (!spinnerStopped) {
        spinnerStopped = true;
        spinner.stop();
      }
      if (streamToStdout && partialAnswer.startsWith(printed)) {
        const suffix = partialAnswer.slice(printed.length);
        process.stdout.write(suffix);
        printed = partialAnswer;
      }
    };

    const result = await streamAsk(
      {
        query,
        ...(argv.model ? { model: argv.model } : {}),
        ...(argv.recency ? { recency: argv.recency } : {}),
        ...(argv.sources && argv.sources.length > 0 ? { sources: argv.sources } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        incognito: argv.incognito ?? true,
        ...(followup ? { followup } : {}),
        ...(space ? { space } : {}),
        ...(mode === "research" ? { research: true } : {}),
      },
      { onEvent },
    );
    spinner.stop();

    // final flush: anything not yet printed (no-stream mode prints everything here)
    if (!json) {
      if (result.answer !== printed) {
        if (result.answer.startsWith(printed)) process.stdout.write(result.answer.slice(printed.length));
        else if (printed === "") process.stdout.write(result.answer);
        else {
          // Snapshot rewrote shown text (shrunk, then regrew differently) — the
          // streamed prefix is stale: reprint the corrected answer on a fresh line.
          process.stdout.write(`\n\n${result.answer}`);
        }
      }
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
    const incognito = argv.incognito ?? true;
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
  }
}

function askOptions(y: Argv): Argv {
  return y
    .positional("query", { type: "string", describe: "the question" })
    .option("model", { type: "string", describe: "model slug (see `pplx models`)" })
    .option("recency", { type: "string", choices: ["hour", "day", "week", "month", "year"], describe: "filter results by age" })
    .option("sources", { type: "array", string: true, describe: "source/connector ids, e.g. web scholar" })
    .option("attach", { type: "array", string: true, describe: "files to upload and attach" })
    .option("thread", { type: "string", describe: "thread slug or URL to continue" })
    .option("continue", { type: "boolean", describe: "continue the most recent live temp chat" })
    .option("incognito", {
      type: "boolean",
      default: true,
      describe: "temp chat: excluded from history, auto-deleted ~24h (use --no-incognito to keep)",
    })
    .option("space", { type: "string", describe: "target a space (title or uuid; the thread is created inside it)" })
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
    .option("stream", { type: "boolean", default: true, describe: "stream the answer while generating" });
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
