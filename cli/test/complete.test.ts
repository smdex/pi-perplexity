import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs, { type Argv } from "yargs";
import {
  buildCompletion,
  cached,
  candidateSources,
  completionHandler,
  completionScript,
  pendingOption,
  shellQuote,
} from "../src/complete.js";
import { saveThreadState } from "../src/config.js";

/**
 * Completion tests — zero network: candidateSources entries are stubbed, the
 * TTL cache is redirected to a temp dir via PPLX_CACHE_DIR.
 */

let cacheDir: string;
const savedSources = { ...candidateSources };

beforeAll(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "pplx-complete-test-"));
  process.env.PPLX_CACHE_DIR = cacheDir;
});

afterAll(async () => {
  Object.assign(candidateSources, savedSources);
  delete process.env.PPLX_CACHE_DIR;
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
});

describe("pendingOption", () => {
  it("matrix from cli-libs.md", () => {
    // completing a flag itself → null (flag completion)
    expect(pendingOption({ _: ["pplx", "ask"], mo: true }, "--mo")).toBeNull();
    // scalar option value pending
    expect(pendingOption({ _: ["pplx", "ask"], model: "" }, "")).toBe("model");
    expect(pendingOption({ _: ["pplx", "ask"], space: "Mone" }, "Mone")).toBe("space");
    // array option: last element pending
    expect(pendingOption({ _: ["pplx", "ask"], sources: ["we"] }, "we")).toBe("sources");
    // positional word → null
    expect(pendingOption({ _: ["pplx", "ask"] }, "wha")).toBeNull();
    // filled scalar (not current word) → null
    expect(pendingOption({ _: ["pplx", "ask"], model: "gemini38flash" }, "wha")).toBeNull();
  });
});

describe("cached", () => {
  it("misses → fetches and stores; hits → serves from cache without refetching", async () => {
    let fetches = 0;
    const fetcher = async (): Promise<string[]> => {
      fetches++;
      return ["a", "b"];
    };
    expect(await cached("t-hitmiss", fetcher)).toEqual(["a", "b"]);
    expect(fetches).toBe(1);
    expect(await cached("t-hitmiss", fetcher)).toEqual(["a", "b"]);
    expect(fetches).toBe(1); // TTL hit — no refetch
  });

  it("expired entries refetch (mtime older than TTL)", async () => {
    let fetches = 0;
    const fetcher = async (): Promise<string[]> => {
      fetches++;
      return ["fresh"];
    };
    expect(await cached("t-expired", fetcher)).toEqual(["fresh"]);
    const path = join(cacheDir, "t-expired.json");
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await utimes(path, old, old);
    expect(await cached("t-expired", fetcher)).toEqual(["fresh"]);
    expect(fetches).toBe(2);
  });

  it("fetcher errors degrade to empty candidates", async () => {
    expect(await cached("t-error", async () => Promise.reject(new Error("offline")))).toEqual([]);
  });
});

describe("getCompletion (yargs instance, stubbed sources)", () => {
  function parser(): Argv {
    const y = yargs([])
      .scriptName("pplx")
      .command("ask <query..>", "ask", (y2) =>
        y2
          .positional("query", { type: "string" })
          .option("model", { type: "string" })
          .option("thread", { type: "string" }),
      )
      .command("models", "models")
      .demandCommand(1)
      .strict();
    return buildCompletion(y);
  }

  function getCompletion(y: Argv, args: string[]): Promise<string[]> {
    return new Promise((resolve) => {
      y.getCompletion(args, (err, completions) => {
        if (err) throw err;
        resolve([...completions]);
      });
    });
  }

  it("completes --model values from the static candidate source", async () => {
    const comps = await getCompletion(parser(), ["pplx", "ask", "--model", ""]);
    expect(comps).toContain("gemini38flash");
    expect(comps).toContain("glm_5_3_thinking");
  });

  it("prefix-filters candidates (--model gem → gemini38flash only)", async () => {
    const comps = await getCompletion(parser(), ["pplx", "ask", "--model", "gem"]);
    expect(comps).toEqual(["gemini38flash"]);
  });

  it("completes --thread from local thread states (offline path)", async () => {
    await saveThreadState({
      slug: "e2e23ed7-f797-4af0",
      readWriteToken: "tok",
      lastBackendUuid: "e2e23ed7-f797-4af0",
      url: "https://www.perplexity.ai/search/e2e23ed7-f797-4af0",
      updatedAt: new Date().toISOString(),
    });
    candidateSources.thread = async () => ["local-slug-1"]; // stub: no sidebar fetch
    const comps = await getCompletion(parser(), ["pplx", "ask", "--thread", ""]);
    expect(comps).toEqual(["local-slug-1"]);
  });

  it("falls back to default subcommand completion elsewhere", async () => {
    const comps = await getCompletion(parser(), ["pplx", ""]);
    // fish/zsh suffix candidates with "\t<desc>"; match on the command word itself
    expect(comps.some((c) => c.split("\t")[0] === "ask")).toBe(true);
    expect(comps.some((c) => c.split("\t")[0] === "models")).toBe(true);
    expect(comps.some((c) => c.startsWith("__pplx_completions__"))).toBe(false); // machinery stays hidden
  });

  it("network failure in a candidate source degrades to empty candidates", async () => {
    candidateSources.model = async () => Promise.reject(new Error("offline"));
    const comps = await getCompletion(parser(), ["pplx", "ask", "--model", ""]);
    expect(comps).toEqual([]);
    candidateSources.model = savedSources.model;
  });
});

describe("completionScript", () => {
  it("emits per-shell scripts that call --get-yargs-completions", async () => {
    const bash = completionScript("bash", "/usr/local/bin/pplx");
    expect(bash).toContain("complete -o bashdefault -o default -F _pplx_yargs_completions pplx");
    expect(bash).toContain("/usr/local/bin/pplx --get-yargs-completions");
    const zsh = completionScript("zsh", "pplx");
    expect(zsh).toContain("#compdef pplx");
    expect(zsh).toContain("compdef _pplx_yargs_completions pplx");
    const fish = completionScript("fish", "pplx");
    expect(fish).toContain("complete -f -c pplx");
  });
});

describe("shellQuote (generated scripts must not execute metacharacters)", () => {
  it("leaves plain paths bare", () => {
    expect(shellQuote("/usr/local/bin/pplx")).toBe("/usr/local/bin/pplx");
    expect(shellQuote("pplx")).toBe("pplx");
    expect(shellQuote("./node_modules/.bin/pplx")).toBe("./node_modules/.bin/pplx");
  });

  it("single-quotes paths with spaces/quotes/semicolons (bash/zsh/fish compatible)", () => {
    expect(shellQuote("/opt/my app/pplx")).toBe("'/opt/my app/pplx'");
    expect(shellQuote("p'; rm -rf /")).toBe("'p'\\''; rm -rf /'");
    expect(shellQuote("$(reboot)")).toBe("'$(reboot)'");
  });

  it("generated scripts embed the quoted path", () => {
    const bash = completionScript("bash", "/opt/my app/pplx");
    expect(bash).toContain("'/opt/my app/pplx' --get-yargs-completions");
    expect(bash).not.toContain("/opt/my app/pplx --get-yargs-completions"); // never unquoted
    const zsh = completionScript("zsh", "x;y");
    expect(zsh).toContain("'x;y' --get-yargs-completions");
    const fish = completionScript("fish", "a b");
    expect(fish).toContain("'a b' --get-yargs-completions");
  });
});

describe("completionHandler arg-order tolerance", () => {
  it("works with the runtime order (filter 3rd, done 4th) and the old docs order (done 3rd)", async () => {
    // runtime v18 order: (current, argv, completionFilter, done)
    const seenA: string[][] = [];
    completionHandler("gem", { model: "gem" }, () => {}, (comps: string[]) => seenA.push(comps));
    // old docs order: (current, argv, done, completionFilter) — arity distinguishes
    const seenB: string[][] = [];
    completionHandler("gem", { model: "gem" }, (comps: string[]) => seenB.push(comps), () => {});
    await new Promise((resolve) => setTimeout(resolve, 0)); // candidate fetch is microtask-async
    expect(seenA).toContainEqual(["gemini38flash"]);
    expect(seenB).toContainEqual(["gemini38flash"]);
  });

  it("flags fall back to completionFilter", () => {
    let filtered = false;
    completionHandler("--m", { _: ["pplx", "ask"] }, () => {
      filtered = true;
    }, () => {});
    expect(filtered).toBe(true);
  });
});
