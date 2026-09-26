#!/usr/bin/env bun
/**
 * pplx — Perplexity CLI.
 * Command surface (all handlers live in src/commands/*); this file only wires
 * the yargs tree, the async completion machinery, and error → exit-code mapping
 * (0 ok / 1 error / 2 auth — with a `pplx login` hint).
 */
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import pc from "picocolors";

import { AuthRequiredError } from "./api/http.js";
import { LOGIN_HELP } from "./constants.js";
import { buildCompletion } from "./complete.js";
import { askCommand, researchCommand } from "./commands/ask.js";
import { chatsCommand } from "./commands/chats.js";
import { completionCommand } from "./commands/completion.js";
import { connectorsCommand } from "./commands/connectors.js";
import { loginCommand } from "./commands/login.js";
import { modelsCommand } from "./commands/models.js";
import { spacesCommand } from "./commands/spaces.js";
import { tempCommand } from "./commands/temp.js";
import { sweepTempThreads } from "./config.js";

const y = yargs(hideBin(process.argv))
  .scriptName("pplx")
  .usage("pplx <command> [options]")
  .version("0.1.0")
  .option("cookie", {
    type: "string",
    hidden: true,
    description: "Cookie header override (also PPLX_COOKIE)",
  })
  // Single integration point for requestContext (plan §4.13): export early so
  // every handler sees it.
  .middleware((argv) => {
    if (typeof argv.cookie === "string" && argv.cookie.length > 0) {
      process.env.PPLX_COOKIE = argv.cookie;
    }
  })
  .command(askCommand)
  .command(researchCommand)
  .command(chatsCommand)
  .command(spacesCommand)
  .command(tempCommand)
  .command(connectorsCommand)
  .command(modelsCommand)
  .command(loginCommand)
  .command(completionCommand)
  .demandCommand(1, LOGIN_HELP)
  .strict();

// Async stale-temp-chat sweep: fire-and-forget on every launch. The server
// deleted these chats ~24h after creation; local state (tokens + content) is
// removed in the background and can never block or fail the command itself.
sweepTempThreads();

/** Map an error to a message + exit code (0 ok / 1 error / 2 auth) and print it. */
function reportAndSetCode(msg: string | null, err?: Error): number {
  // Ctrl-C / SIGTERM during a stream: exit quietly with the conventional code.
  if (err instanceof Error && err.name === "AbortError") {
    process.stderr.write("\npplx: interrupted\n");
    return 130;
  }
  if (err instanceof AuthRequiredError) {
    // AuthRequiredError messages already embed the login hint.
    process.stderr.write(`${pc.red("pplx:")} ${err.message}\n`);
    return 2;
  }
  if (err instanceof Error) {
    process.stderr.write(`${pc.red("pplx:")} ${err.message}\n`);
    return 1;
  }
  // yargs parse errors (unknown command/option, missing positional…)
  process.stderr.write(`${pc.red("pplx:")} ${msg ?? "unknown error"}\n${pc.dim("try: pplx --help")}\n`);
  return 1;
}

buildCompletion(y)
  .fail((msg, err) => {
    // Hard-exit: a non-exiting fail handler lets yargs keep parsing (running
    // the command after a validation error) and leaks unhandled rejections.
    process.exit(reportAndSetCode(msg ?? null, err));
  })
  .parseAsync()
  .catch(() => {
    // .fail already reported + exited; this only guards against yargs calling
    // back without going through .fail.
    if (!process.exitCode) process.exitCode = 1;
  });
