import pc from "picocolors";

import { AuthRequiredError } from "../api/http.js";

/** Shared helpers for command handlers (printing, errors, refs). */

export function out(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function warn(text: string): void {
  process.stderr.write(`${pc.yellow("warning:")} ${text}\n`);
}

/**
 * Run a handler; on failure, `--json` commands print `{"error": …}` + set
 * exitCode (2 auth, 1 other) and swallow (streams flush naturally); non-json
 * rethrows for the index.ts fail-handler.
 */
export async function run(json: boolean, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (json) {
      const message = error instanceof Error ? error.message : String(error);
      out(JSON.stringify({ error: message }));
      process.exitCode = error instanceof AuthRequiredError ? 2 : 1;
      return;
    }
    throw error;
  }
}

/** Extract the thread slug from a bare uuid, /search/<uuid> URL, or URL with query. */
export function threadSlugFromRef(ref: string): string {
  const match = ref.match(/\/search\/([0-9a-f-]{36})/i);
  if (match?.[1]) return match[1];
  return ref.trim();
}

/** Copy text to the clipboard via clipboardy; throws with a readable message on failure. */
export async function copyToClipboard(text: string): Promise<void> {
  const clipboardy = (await import("clipboardy")).default;
  await clipboardy.write(text);
}

/**
 * Typed confirmation for destructive commands: without --yes, print the prompt
 * on stderr and require the exact expected word on stdin (one line, trimmed).
 * Returns true when confirmed. Reads nothing (fails closed) when stdin is a
 * TTY-less empty pipe. Exits 1 with a hint when declined.
 */
export async function confirmTyped(expected: string, prompt: string, opts?: { yes?: boolean }): Promise<boolean> {
  if (opts?.yes) return true;
  process.stderr.write(`${prompt}\nType ${JSON.stringify(expected)} to confirm (or rerun with --yes): `);
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin });
  const answer = await new Promise<string>((resolve) => {
    rl.once("line", (line) => resolve(String(line).trim()));
    rl.once("close", () => resolve(""));
  });
  rl.close();
  if (answer === expected) return true;
  process.stderr.write("aborted\n");
  process.exitCode = 1;
  return false;
}
