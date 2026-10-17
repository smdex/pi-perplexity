import type { CommandModule } from "yargs";
import { spaceThreads } from "../api/graphql.js";
import { createSpace, deleteSpace, listSpaces, renameSpace, resolveSpace } from "../api/spaces.js";
import { renderSpaceTable, renderThreadTable } from "../render/markdown.js";
import { confirmTyped, out, run } from "./util.js";

/**
 * pplx spaces list|threads|create|rename|delete. CRUD writes use the
 * /rest/collections/* contracts live-captured in s-summary.md (2026-09-23).
 */
export const spacesCommand: CommandModule = {
  command: "spaces",
  describe: "list, inspect, and manage spaces",
  builder: (y) =>
    y
      .command(
        "list",
        "list all spaces",
        (y2) => y2.option("json", { type: "boolean", describe: "print JSON" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const spaces = await listSpaces();
            if (argv.json) {
              out(JSON.stringify(spaces));
              return;
            }
            if (spaces.length === 0) {
              out("no spaces found");
              return;
            }
            out(renderSpaceTable(spaces));
          });
        },
      )
      .command(
        "threads <ref>",
        "list threads in a space (title or uuid)",
        (y2) =>
          y2
            .positional("ref", { type: "string", describe: "space title or uuid" })
            .option("limit", { type: "number", default: 25, describe: "max threads per page" })
            .option("next", { type: "string", describe: "cursor from the previous page" })
            .option("json", { type: "boolean", describe: "print JSON" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const space = await resolveSpace(String(argv.ref ?? ""));
            if (!space) throw new Error(`space not found or ambiguous: ${argv.ref} (see \`pplx spaces list\`)`);
            const page = await spaceThreads(space.uuid, { cursor: argv.next ?? null, count: argv.limit ?? 25 });
            const threads = page.threads.map((t) => t.node).slice(0, argv.limit ?? 25);
            if (argv.json) {
              out(JSON.stringify(threads));
            } else {
              if (threads.length === 0) {
                out(`no threads in "${space.title}"`);
                return;
              }
              out(renderThreadTable(threads));
              if (page.hasNextPage && page.endCursor) {
                process.stderr.write(`more: pplx spaces threads "${space.title}" --next ${page.endCursor}\n`);
              }
            }
          });
        },
      )
      .command(
        "create <title>",
        "create a space",
        (y2) =>
          y2
            .positional("title", { type: "string", describe: "space title" })
            .option("desc", { type: "string", describe: "space description", default: "" })
            .option("emoji", { type: "string", describe: "hex codepoint without U+ (default 1f4c1 = 📁)", default: "1f4c1" })
            .option("instructions", { type: "string", describe: "custom instructions for the space", default: "" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const title = String(argv.title ?? "").trim();
            if (!title) throw new Error("title is required");
            const space = await createSpace({
              title,
              description: argv.desc ?? "",
              emoji: argv.emoji,
              instructions: argv.instructions ?? "",
            });
            if (argv.json) out(JSON.stringify(space));
            else out(`created "${space.title}" — ${space.url ?? space.uuid}`);
          });
        },
      )
      .command(
        "rename <ref> <title>",
        "rename a space",
        (y2) =>
          y2
            .positional("ref", { type: "string", describe: "space title or uuid" })
            .positional("title", { type: "string", describe: "new title" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const space = await resolveSpace(String(argv.ref ?? ""));
            if (!space) throw new Error(`space not found or ambiguous: ${argv.ref} (see \`pplx spaces list\`)`);
            const title = String(argv.title ?? "").trim();
            if (!title) throw new Error("title is required");
            await renameSpace(space.uuid, title);
            out(argv.json ? JSON.stringify({ renamed: true, uuid: space.uuid, title }) : `renamed "${space.title}" to "${title}"`);
          });
        },
      )
      .command(
        "delete <ref>",
        "delete a space permanently (its threads go with it)",
        (y2) =>
          y2
            .positional("ref", { type: "string", describe: "space title or uuid" })
            .option("yes", { type: "boolean", describe: "skip the typed confirmation" }),
        async (argv) => {
          await run(argv.json === true, async () => {
            const space = await resolveSpace(String(argv.ref ?? ""));
            if (!space) throw new Error(`space not found or ambiguous: ${argv.ref} (see \`pplx spaces list\`)`);
            const ok = await confirmTyped(space.title, `Delete space "${space.title}" permanently?`, {
              yes: argv.yes === true,
            });
            if (!ok) return;
            await deleteSpace(space.uuid);
            out(argv.json ? JSON.stringify({ deleted: true, uuid: space.uuid }) : `deleted "${space.title}"`);
          });
        },
      )
      .demandCommand(1, "Specify a spaces subcommand: list, threads, create, rename, or delete"),
  handler: () => {
    // demandCommand in the builder guarantees a subcommand runs; this parent
    // handler exists only to satisfy the CommandModule type.
  },
};
