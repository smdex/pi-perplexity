/**
 * TOON output rendering: serializes result payloads as Token-Oriented Object
 * Notation by default. When `TOON_TRU_BIN` is set, the payload's JSON form is
 * piped through that external binary (JSON on stdin, TOON on stdout) instead
 * of using the built-in encoder; on any binary failure we fall back to the
 * in-process encoder so output is never lost.
 */
import { spawn } from "node:child_process";

import { encode as toonEncode } from "@toon-format/toon";

import { errorMessage } from "../util.js";

const PIPE_TIMEOUT_MS = 10_000;

export type ToonEncoder = (data: unknown) => string;
export type BinPipe = (bin: string, input: string) => Promise<string>;

export interface ToonRenderDeps {
  encode: ToonEncoder;
  pipeThrough: BinPipe;
}

export const defaultToonDeps: ToonRenderDeps = {
  encode: (data) => toonEncode(data),
  pipeThrough: pipeThroughBinary,
};

function pipeThroughBinary(bin: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(bin, { stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`${bin} timed out after ${PIPE_TIMEOUT_MS}ms`));
      }
    }, PIPE_TIMEOUT_MS);
    const finish = (settle: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        settle();
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => finish(() => reject(error)));
    child.on("close", (code: number | null) =>
      finish(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        const detail = stderr.trim().slice(0, 200);
        reject(new Error(`${bin} exited with status ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
      }),
    );
    // The binary may exit without reading all of stdin; ignore the resulting EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export async function renderToon(payload: unknown, deps: ToonRenderDeps = defaultToonDeps): Promise<string> {
  const bin = process.env.TOON_TRU_BIN?.trim();
  if (bin) {
    try {
      return await deps.pipeThrough(bin, JSON.stringify(payload));
    } catch (error) {
      process.stderr.write(
        `warning: TOON_TRU_BIN (${bin}) failed, using built-in TOON encoder: ${errorMessage(error)}\n`,
      );
    }
  }
  return deps.encode(payload);
}
