import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yargs from "yargs";
import { configCommand } from "../src/commands/config.js";
import { askCommand, researchCommand } from "../src/commands/ask.js";
import { saveAuth, saveSettings, saveThreadState, settingsPath } from "../src/config.js";
import { ASK1_SSE, LANDING_BODY, SOURCES_BODY, jsonResponse, mockFetch } from "./fixtures.js";

let root: string;
let stub: ReturnType<typeof mockFetch>;
let requests: Array<Record<string, unknown>>;
let output: string;
let diagnostics: string;
let restoreOutput: () => void;
const originalEnv = { ...process.env };
const OPS_UUID = "00000056-0000-4000-8000-000000000000";
const TRANSLATOR_UUID = "00000064-0000-4000-8000-000000000000";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pplx-defaults-"));
  process.env.HOME = root;
  process.env.PPLX_CONFIG_DIR = join(root, "config");
  process.env.PPLX_CACHE_DIR = join(root, "cache");
  process.env.PPLX_COOKIE = "";
  await saveAuth({ kind: "cookies", cookies: ["__Secure-next-auth.session-token=fake"], accountUuid: "00000033-0000-4000-8000-000000000000",
    sessionExpires: null, email: null, bearerToken: null, source: "paste", createdAt: "2026-01-01T00:00:00Z" });
  requests = [];
  stub = mockFetch((url, init) => {
    if (url.includes("/rest/sources")) return jsonResponse(SOURCES_BODY);
    if (url.includes("/rest/spaces/landing")) return jsonResponse(LANDING_BODY);
    if (url.endsWith("/rest/sse/perplexity_ask")) {
      requests.push(JSON.parse(String(init?.body)).params);
      return new Response(ASK1_SSE, { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  output = "";
  diagnostics = "";
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => { output += String(chunk); return true; }) as typeof stdout;
  process.stderr.write = ((chunk: unknown) => { diagnostics += String(chunk); return true; }) as typeof stderr;
  restoreOutput = () => { process.stdout.write = stdout; process.stderr.write = stderr; };
});
afterEach(async () => {
  restoreOutput();
  stub.restore();
  for (const key of ["HOME", "PPLX_CONFIG_DIR", "PPLX_CACHE_DIR", "PPLX_COOKIE"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await rm(root, { recursive: true, force: true });
});

async function ask(flags: string[] = [], command = "ask") {
  await yargs([command, "question", ...flags]).command(askCommand).command(researchCommand)
    .exitProcess(false).strict().fail((msg, err) => { throw err ?? new Error(msg); }).parseAsync();
}

test("ask submits the persisted model and connected sources", async () => {
  await saveSettings({ model: "glm_5_3_thinking", sources: ["scholar", "google_drive"] });
  await ask();
  expect(requests[0]).toMatchObject({ model_preference: "glm_5_3_thinking", sources: ["scholar", "google_drive"], is_incognito: true });
  expect(output).toContain("OK");
});

test("configured spaces never silently change privacy or submit an unverified incognito combination", async () => {
  await saveSettings({ space: "Ops: linux" });
  await expect(ask()).rejects.toThrow(/--no-incognito.*--no-space/s);
  await expect(ask(["--incognito"])).rejects.toThrow(/--no-incognito.*--no-space/s);
  expect(requests).toEqual([]);
});

test("explicit model and sources replace defaults without consulting the configured connector", async () => {
  await saveSettings({ model: "saved-model", sources: ["unavailable"] });
  await ask(["--model", "explicit-model", "--sources", "web", "scholar"]);
  expect(requests[0]).toMatchObject({ model_preference: "explicit-model", sources: ["web", "scholar"] });
  expect(stub.calls.some(c => c.url.includes("/rest/sources"))).toBe(false);
});

test("--no-space and --sources web bypass configured scope for one invocation", async () => {
  await saveSettings({ space: "unavailable", sources: ["unavailable"] });
  await ask(["--no-space", "--sources", "web"]);
  expect(requests[0]).toMatchObject({ query_source: "home", sources: ["web"], is_incognito: true });
  expect(requests[0]?.target_collection_uuid).toBeUndefined();
  expect(stub.calls).toHaveLength(1);
});

test("configured space uses existing title semantics only with --no-incognito", async () => {
  await saveSettings({ space: "ops:" });
  await ask(["--no-incognito"]);
  expect(requests[0]).toMatchObject({ target_collection_uuid: OPS_UUID, query_source: "collection", is_incognito: false });
});

test("explicit space overrides a configured space", async () => {
  await saveSettings({ space: "unavailable" });
  await ask(["--space", "Translator", "--no-incognito"]);
  expect(requests[0]).toMatchObject({ target_collection_uuid: TRANSLATOR_UUID, is_incognito: false });
});

test("unavailable configured connectors fail closed before submitting", async () => {
  await saveSettings({ sources: ["unavailable"] });
  await expect(ask()).rejects.toThrow(/configured source.*unavailable.*pplx config/s);
  expect(requests).toEqual([]);
  expect(stub.calls[0]?.url).toContain("filter_by=connected");
});

test("unavailable configured spaces fail closed before submitting", async () => {
  await saveSettings({ space: "unavailable" });
  await expect(ask(["--no-incognito"])).rejects.toThrow(/configured space.*unavailable.*--no-space/s);
  expect(requests).toEqual([]);
});

test("catalog failures never fall back to a different scope", async () => {
  await saveSettings({ sources: ["google_drive"] });
  stub.restore();
  stub = mockFetch(() => jsonResponse({ error: "unavailable" }, [], 503));
  await expect(ask()).rejects.toThrow(/503/);
  expect(requests).toEqual([]);
});

test("research preserves its own engine while inheriting sources", async () => {
  await saveSettings({ model: "saved-model", sources: ["scholar"] });
  await ask(["--model", "explicit-model"], "research");
  expect(requests[0]).toMatchObject({ model_preference: "pplx_alpha", sources: ["scholar"] });
});

test("malformed settings never submit even with scope override flags", async () => {
  await writeFile(settingsPath(), '{"sources": "web"}');
  await expect(ask(["--sources", "web", "--no-space"])).rejects.toThrow(/sources/);
  expect(requests).toEqual([]);
});

test("followups warn that configured spaces apply only to new threads", async () => {
  await saveSettings({ space: "unavailable" });
  await saveThreadState({ slug: "existing", lastBackendUuid: "tail", readWriteToken: "fake", url: "https://example.invalid",
    updatedAt: new Date().toISOString(), createdAt: new Date().toISOString(), incognito: true });
  await ask(["--thread", "existing"]);
  expect(requests[0]).toMatchObject({ query_source: "followup", last_backend_uuid: "tail" });
  expect(requests[0]?.target_collection_uuid).toBeUndefined();
  expect(diagnostics).toMatch(/configured space.*only to new threads/);
  expect(stub.calls).toHaveLength(1);
});

test("an empty explicit source list errors rather than using configured connectors", async () => {
  await saveSettings({ sources: ["google_drive"] });
  await expect(ask(["--sources"])).rejects.toThrow(/--sources.*at least one/);
  expect(requests).toEqual([]);
});

test("empty explicit space rejects rather than silently selecting the saved space", async () => {
  await saveSettings({ space: "Ops: linux" });
  await expect(ask(["--space", "", "--no-incognito"])).rejects.toThrow(/--space.*non-empty/);
  expect(requests).toEqual([]);
});


test("unsetting persisted defaults restores the original built-ins", async () => {
  await saveSettings({ model: "saved-model", sources: ["scholar"], space: "Ops: linux" });
  for (const key of ["model", "sources", "space"]) {
    await yargs(["config", "unset", key]).command(configCommand).exitProcess(false).parseAsync();
  }
  await ask();
  expect(requests[0]).toMatchObject({ model_preference: "gemini38flash", sources: ["web"], is_incognito: true, query_source: "home" });
});
