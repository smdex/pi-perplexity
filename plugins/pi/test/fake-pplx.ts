import { afterEach } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Fake `pplx` executable: records its argv, then behaves per `mode`. */
export interface FakePplx {
  dir: string;
  argvFile: string;
  killedFile: string;
  pidFile: string;
  result: Record<string, unknown>;
}

export async function createFakePplx(mode?: string): Promise<FakePplx> {
  const dir = mkdtempSync(join(tmpdir(), "pplx-fake-"));
  const argvFile = join(dir, "argv.json");
  const killedFile = join(dir, "killed");
  const pidFile = join(dir, "pid.json");
  const result = {
    answer: "Sky is blue because molecules scatter short wavelengths (Rayleigh scattering).",
    readWriteToken: "rw-token",
    backendUuid: "backend-uuid",
    threadUrl: "https://www.perplexity.ai/search/3f2b8c1a-4d5e-4f6a-9b7c-1d2e3f4a5b6c",
    followups: ["Why are sunsets red?"],
    model: "gemini38flash",
    sources: [
      {
        name: "NASA",
        url: "https://nasa.gov/why-sky-blue",
        snippet: "Rayleigh scattering…",
        timestamp: new Date(Date.now() - 3_600_000).toISOString(),
      },
    ],
    images: [],
  };
  const script = `#!${process.execPath}
const fs = require("node:fs");
const mode = ${JSON.stringify(mode ?? "ok")};
const argvFile = ${JSON.stringify(argvFile)};
fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify(process.pid));
fs.writeFileSync(argvFile, JSON.stringify(process.argv.slice(2)));
if (mode === "hang" || mode === "stubborn") {
  process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(killedFile)}, "term"); if (mode !== "stubborn") process.exit(143); });
  setInterval(() => {}, 1000);
} else if (mode === "auth") {
  process.stdout.write(JSON.stringify({ error: "Not logged in. Run pplx login (paste cookies from a logged-in browser)." }) + "\\n");
  process.exit(2);
} else if (mode === "fail") {
  process.stdout.write(JSON.stringify({ error: "HTTP 500: preview" }) + "\\n");
  process.exit(1);
} else if (mode === "cwd") {
  process.stdout.write(JSON.stringify({ answer: process.cwd() }));
} else if (mode === "unicode") {
  const bytes = Buffer.from(JSON.stringify({ answer: "你好 🌍" }));
  const cut = bytes.indexOf(Buffer.from("🌍")) + 1;
  process.stdout.write(bytes.subarray(0, cut));
  setTimeout(() => process.stdout.write(bytes.subarray(cut)), 50);
} else if (mode === "bad-source") {
  process.stdout.write(JSON.stringify({ answer: "ok", sources: [{ name: 42 }] }));
} else if (mode === "garbage") {
  process.stdout.write("this is not json\\n");
  process.exit(0);
} else {
  process.stdout.write(JSON.stringify(${JSON.stringify(result)}) + "\\n");
}
`;
  writeFileSync(join(dir, "pplx"), script);
  chmodSync(join(dir, "pplx"), 0o755);
  return { dir, argvFile, killedFile, pidFile, result };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** Register a cleanup for this test file (dirs, env restores). */
export function cleanup(fn: () => void): void {
  cleanups.push(fn);
}

export function removeDirSoon(path: string): void {
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
}

/** Put a directory first on PATH (or replace PATH entirely) for one test. */
export function withPath(path: string, opts?: { replace?: boolean }): void {
  const original = process.env.PATH;
  process.env.PATH = opts?.replace === true ? path : `${path}${delimiter}${original}`;
  cleanups.push(() => {
    process.env.PATH = original;
  });
}

export async function readJson(file: string): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(file, "utf8"));
}

export async function exists(file: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Wait until `predicate` is true, or fail after `timeoutMs`. */
export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
