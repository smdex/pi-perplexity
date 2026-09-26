import { afterEach, describe, expect, it } from "bun:test";
import { StderrSpinner } from "../src/render/spinner.js";

/**
 * Spinner write discipline: stop() is idempotent — the clear sequence
 * (\r + spaces + \r) erases the first N screen columns, so emitting it when no
 * spinner is visible corrupts co-terminal answer output (the `pplx ask` race).
 */

function captureStderr(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: () => void (process.stderr.write = original) };
}

afterEach(() => {
  delete process.env.PPLX_NO_SPINNER;
});

describe("StderrSpinner", () => {
  it("clears the line exactly once on the first stop, then stops silently", () => {
    const saved = process.stderr.isTTY;
    (process.stderr as { isTTY: boolean }).isTTY = true;
    const { lines, restore } = captureStderr();
    try {
      const spinner = new StderrSpinner();
      spinner.start("working");
      spinner.stop();
      spinner.stop();
      spinner.stop();
      // The clear write is "\r" + spaces + "\r" — starts with \r, no glyph/text.
      const clears = lines.filter((l) => l.startsWith("\r") && l.trim().length === 0).length;
      expect(clears).toBe(1); // 3 stops → exactly ONE clear write
    } finally {
      restore();
      (process.stderr as { isTTY: unknown }).isTTY = saved;
    }
  });

  it("start after stop spins again and the next stop clears once more", () => {
    const saved = process.stderr.isTTY;
    (process.stderr as { isTTY: boolean }).isTTY = true;
    const { lines, restore } = captureStderr();
    try {
      const spinner = new StderrSpinner();
      spinner.start("one");
      spinner.stop();
      spinner.start("two");
      spinner.stop();
      const clears = lines.filter((l) => l.trimEnd().length === 0 && l.startsWith("\r")).length;
      expect(clears).toBe(2);
      expect(lines.some((l) => l.includes("one"))).toBe(true);
      expect(lines.some((l) => l.includes("two"))).toBe(true);
    } finally {
      restore();
      (process.stderr as { isTTY: unknown }).isTTY = saved;
    }
  });

  it("non-TTY stderr: stop writes nothing (and never the clear sequence)", () => {
    const saved = process.stderr.isTTY;
    (process.stderr as { isTTY: boolean }).isTTY = false;
    const { lines, restore } = captureStderr();
    try {
      const spinner = new StderrSpinner();
      spinner.start("working");
      spinner.stop();
      spinner.stop();
      expect(lines.filter((l) => l.includes("\r")).length).toBe(0);
    } finally {
      restore();
      (process.stderr as { isTTY: unknown }).isTTY = saved;
    }
  });

  it("PPLX_NO_SPINNER=1 disables rendering entirely", () => {
    process.env.PPLX_NO_SPINNER = "1";
    const saved = process.stderr.isTTY;
    (process.stderr as { isTTY: boolean }).isTTY = true;
    const { lines, restore } = captureStderr();
    try {
      const spinner = new StderrSpinner();
      spinner.start("working");
      spinner.stop();
      expect(lines.length).toBe(0);
    } finally {
      restore();
      (process.stderr as { isTTY: unknown }).isTTY = saved;
    }
  });
});
