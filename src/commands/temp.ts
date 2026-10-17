import type { CommandModule } from "yargs";
import { cleanupTempThreads, isTempLive, listThreadStates, tempRemaining, type ThreadState } from "../config.js";
import { relTime, singleLine, truncate } from "../render/markdown.js";
import { out, run } from "./util.js";

/**
 * pplx temp list|cleanup — manage incognito ("temp") chats.
 *
 * `ask` creates temp chats by default (is_incognito: true): they never enter
 * library history and Perplexity deletes them ~24h after creation. The local
 * registry under $PPLX_CACHE_DIR/threads/ holds their continuation tokens so
 * `ask --continue` / `ask --thread <slug>` can keep working in the same chat
 * across invocations while it lives. Every CLI launch sweeps expired entries
 * asynchronously; `temp cleanup` does it synchronously on demand.
 */

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(Math.max(0, width - s.length));
}

/** Remaining lifetime of a temp chat: "23h" / "12m" / "expired" / "unknown". */
export function remaining(state: ThreadState, now: Date = new Date()): string {
  return tempRemaining(state, now);
}

/** EXPIRES | UPDATED | MODEL | TITLE | SLUG — temp chat table (no color). */
export function renderTempTable(states: ThreadState[], now: Date = new Date()): string {
  const header = `${padRight("EXPIRES", 8)}  ${padRight("UPDATED", 10)}  ${padRight("MODEL", 16)}  ${padRight("TITLE", 40)}  SLUG`;
  const lines = states.map((s) => {
    const left = remaining(s, now);
    const expired = left === "expired";
    const model = singleLine(s.model) || "—";
    const title = truncate(singleLine(s.query) || "(untitled)", 38);
    const row = `${padRight(left, 8)}  ${padRight(relTime(s.updatedAt), 10)}  ${padRight(model, 16)}  ${padRight(title, 40)}  ${s.slug}`;
    return expired ? `${row}  (stale — server already deleted this chat)` : row;
  });
  return [header, ...lines].join("\n");
}

export const tempCommand: CommandModule = {
  command: "temp",
  describe: "manage incognito (temp) chats — list live ones or purge expired state",
  builder: (y) =>
    y
      .command(
        "list",
        "list live temp chats (created by this CLI, ~24h server lifetime)",
        (y3) =>
          y3
            .option("all", { type: "boolean", describe: "also show expired entries (state not yet swept)" })
            .option("json", { type: "boolean", describe: "print JSON" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const states = (await listThreadStates()).filter((s) => s.incognito === true);
            const shown = argv.all === true ? states : states.filter((s) => isTempLive(s));
            if (argv.json) {
              out(JSON.stringify(shown.map((s) => ({ ...s, readWriteToken: undefined }))));
            } else {
              if (shown.length === 0) {
                out(argv.all === true ? "no temp chats recorded" : "no live temp chats (expired ones are swept on every launch)");
                return;
              }
              out(renderTempTable(shown));
              process.stderr.write(`continue the latest: pplx ask --continue "…"\n`);
            }
          });
        },
      )
      .command(
        "cleanup",
        "delete local state for expired temp chats (the server already deleted them)",
        (y3) => y3.option("json", { type: "boolean", describe: "print JSON" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const removed = await cleanupTempThreads();
            if (argv.json) {
              out(JSON.stringify({ removed, count: removed.length }));
            } else {
              out(removed.length === 0 ? "nothing to clean" : `removed ${removed.length} expired temp chat(s):`);
              for (const slug of removed) out(`  ${slug}`);
            }
          });
        },
      )
      .demandCommand(1, "Specify a temp subcommand: list or cleanup"),
  handler: () => {
    // demandCommand in the builder guarantees a subcommand runs; this parent
    // handler exists only to satisfy the CommandModule type.
  },
};
