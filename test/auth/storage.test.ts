import { afterEach, describe, expect, mock, test } from "../test-helpers.js";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

async function importStorageModule() {
  return import(`../../src/auth/storage.js?test=${crypto.randomUUID()}`);
}

const originalCliConfigDir = process.env.PPLX_CONFIG_DIR;

afterEach(() => {
  mock.restore();
  if (originalCliConfigDir === undefined) {
    delete process.env.PPLX_CONFIG_DIR;
  } else {
    process.env.PPLX_CONFIG_DIR = originalCliConfigDir;
  }
});

async function makeHome(): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), "pi-perplexity-storage-"));
  mock.module("node:os", () => ({
    homedir: () => homeDir,
  }));
  return homeDir;
}

describe("auth/storage", () => {
  test("saveToken enforces 0600 permissions even when token file already exists", async () => {
    const homeDir = await makeHome();
    const tokenPath = join(homeDir, ".config", "pi-perplexity", "auth.json");

    try {
      await mkdir(dirname(tokenPath), { recursive: true });
      await writeFile(tokenPath, '{"type":"oauth","access":"old"}\n', {
        encoding: "utf8",
        mode: 0o644,
      });

      const { saveToken } = await importStorageModule();
      await saveToken({ type: "oauth", access: "new-token" });

      const fileMode = (await stat(tokenPath)).mode & 0o777;
      expect(fileMode).toBe(0o600);

      const saved = JSON.parse(await readFile(tokenPath, "utf8")) as {
        type: string;
        access: string;
      };
      expect(saved.type).toBe("oauth");
      expect(saved.access).toBe("new-token");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("loadToken returns null for missing or corrupt files", async () => {
    const homeDir = await makeHome();
    try {
      const { loadToken } = await importStorageModule();
      expect(await loadToken()).toBeNull();

      const tokenPath = join(homeDir, ".config", "pi-perplexity", "auth.json");
      await mkdir(dirname(tokenPath), { recursive: true });
      await writeFile(tokenPath, "{not json");
      expect(await loadToken()).toBeNull();

      await writeFile(tokenPath, '{"type":"pat","access":"x"}\n');
      expect(await loadToken()).toBeNull();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("loadCliCookies reads the pplx CLI jar and requires a session cookie", async () => {
    const homeDir = await makeHome();
    const cliDir = join(homeDir, "pplx-cli");
    process.env.PPLX_CONFIG_DIR = cliDir;
    try {
      const { loadCliCookies } = await importStorageModule();
      expect(await loadCliCookies()).toBeNull();

      // jar without the session cookie is rejected
      await mkdir(cliDir, { recursive: true });
      await writeFile(
        join(cliDir, "auth.json"),
        JSON.stringify({ kind: "cookies", cookies: ["cf_clearance=x"], userAgent: "UA" }),
      );
      expect(await loadCliCookies()).toBeNull();

      await writeFile(
        join(cliDir, "auth.json"),
        JSON.stringify({
          kind: "cookies",
          cookies: ["__Secure-next-auth.session-token=s1", "cf_clearance=x"],
          userAgent: "Mozilla/5.0 CliUA",
          email: "cli@example.com",
        }),
      );
      const jar = await loadCliCookies();
      expect(jar).not.toBeNull();
      expect(jar?.cookies).toHaveLength(2);
      expect(jar?.userAgent).toBe("Mozilla/5.0 CliUA");
      expect(jar?.email).toBe("cli@example.com");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test("loadCredentials prefers own jar, enriches from CLI jar, or falls back to CLI jar", async () => {
    const homeDir = await makeHome();
    const cliDir = join(homeDir, "pplx-cli");
    process.env.PPLX_CONFIG_DIR = cliDir;
    const tokenPath = join(homeDir, ".config", "pi-perplexity", "auth.json");
    try {
      const { loadCredentials, saveToken } = await importStorageModule();

      // no credentials at all
      expect(await loadCredentials()).toBeNull();

      // CLI jar alone
      await mkdir(cliDir, { recursive: true });
      await writeFile(
        join(cliDir, "auth.json"),
        JSON.stringify({
          kind: "cookies",
          cookies: ["__Secure-next-auth.session-token=cli"],
          userAgent: "UA-CLI",
        }),
      );
      let creds = await loadCredentials();
      expect(creds?.access).toBe("");
      expect(creds?.cookies).toEqual(["__Secure-next-auth.session-token=cli"]);
      expect(creds?.userAgent).toBe("UA-CLI");

      // own token without jar -> enriched with CLI jar
      await saveToken({ type: "oauth", access: "own-token", email: "me@example.com" });
      creds = await loadCredentials();
      expect(creds?.access).toBe("own-token");
      expect(creds?.cookies).toEqual(["__Secure-next-auth.session-token=cli"]);
      expect(creds?.userAgent).toBe("UA-CLI");
      expect(creds?.email).toBe("me@example.com");

      // own token WITH jar -> CLI jar ignored
      await saveToken({
        type: "oauth",
        access: "own-token",
        cookies: ["__Secure-next-auth.session-token=own"],
      });
      creds = await loadCredentials();
      expect(creds?.cookies).toEqual(["__Secure-next-auth.session-token=own"]);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
