import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BROWSER_PRESETS,
  hasSessionCookie,
  importBrowserCookies,
  parseCurlCommand,
  parsePastedCookies,
  readChromiumCookiesAt,
  readFirefoxCookiesAt,
  SESSION_COOKIE_NAME,
} from "../src/auth/cookies.js";

const SESSION = SESSION_COOKIE_NAME;

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------- paste parsing

describe("parsePastedCookies", () => {
  it("parses a raw Cookie header", () => {
    expect(parsePastedCookies("a=b; c=d; __Secure-next-auth.session-token=v")).toEqual({
      cookies: ["a=b", "c=d", "__Secure-next-auth.session-token=v"],
      userAgent: null,
    });
  });

  it("keeps '=' inside values (JWT-style)", () => {
    expect(parsePastedCookies("session=aaa.bbb.ccc")).toEqual({ cookies: ["session=aaa.bbb.ccc"], userAgent: null });
  });

  it("parses one-per-line name=value lists", () => {
    expect(parsePastedCookies("a=1\nb=2\n")).toEqual({ cookies: ["a=1", "b=2"], userAgent: null });
  });

  it("parses Netscape cookies.txt lines (7 tab-separated fields)", () => {
    const line = ".perplexity.ai\tTRUE\t/\tTRUE\t1893456000\t__Secure-next-auth.session-token\tjwt.value=here";
    expect(parsePastedCookies(`# Netscape HTTP Cookie File\n${line}\n`)).toEqual({
      cookies: ["__Secure-next-auth.session-token=jwt.value=here"],
      userAgent: null,
    });
  });

  it("parses #HttpOnly_ prefixed Netscape lines", () => {
    const line = "#HttpOnly_.perplexity.ai\tTRUE\t/\tTRUE\t0\tname\tval";
    expect(parsePastedCookies(line)).toEqual({ cookies: ["name=val"], userAgent: null });
  });

  it("skips comments, blank lines, and garbage", () => {
    expect(parsePastedCookies("# comment\n\nnot-a-cookie\n=x\na=1")).toEqual({ cookies: ["a=1"], userAgent: null });
  });

  it("first occurrence wins per name", () => {
    expect(parsePastedCookies("a=1; a=2\na=3")).toEqual({ cookies: ["a=1"], userAgent: null });
  });

  it("strips an optional case-insensitive 'Cookie:' header prefix", () => {
    expect(parsePastedCookies("Cookie: __Secure-next-auth.session-token=v; a=1")).toEqual({
      cookies: ["__Secure-next-auth.session-token=v", "a=1"],
      userAgent: null,
    });
    expect(parsePastedCookies("cookie: a=1")).toEqual({ cookies: ["a=1"], userAgent: null });
    expect(parsePastedCookies("COOKIE : a=1")).toEqual({ cookies: ["a=1"], userAgent: null });
    // a name that merely starts with "cookie" is NOT a prefix
    expect(parsePastedCookies("cookies=yum")).toEqual({ cookies: ["cookies=yum"], userAgent: null });
  });

  it("parses a full curl command with -b cookie payload", () => {
    const input = `curl --url 'https://www.perplexity.ai/rest/x?version=2.18&source=default' \\
  -H 'accept: */*' \\
  -b 'a=1; ${SESSION}=tok; c=3' \\
  -H 'user-agent: TestUA/1.0'`;
    expect(parsePastedCookies(input)).toEqual({
      cookies: ["a=1", `${SESSION}=tok`, "c=3"],
      userAgent: "TestUA/1.0",
    });
  });

  it("parses a curl command with -H 'Cookie: …' (browser 'Copy as cURL' style)", () => {
    const input = `curl 'https://www.perplexity.ai/rest/y' \\
  -H 'cookie: ${SESSION}=tok; a=1; a=override-skipped' \\
  -H 'sec-ch-ua: "Chromium";v="151"' \\
  -H 'user-agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/151.0.0.0'`; // header lines ignored
    const parsed = parsePastedCookies(input);
    expect(parsed.cookies).toEqual([`${SESSION}=tok`, "a=1"]);
    expect(parsed.userAgent).toBe("Mozilla/5.0 (X11; Linux x86_64) Chrome/151.0.0.0");
  });

  it("curl --cookie as separate argument and $'…' quoting", () => {
    const input = `curl https://www.perplexity.ai \\
  --cookie $'x=1\ny=2' \\
  -A CurlAgent/8`;
    expect(parsePastedCookies(input)).toEqual({ cookies: ["x=1", "y=2"], userAgent: "CurlAgent/8" });
  });

  it("curl command with -H Cookie: and a User-Agent flag keeps header UA precedence", () => {
    const input = `curl 'https://x' -H 'Cookie: a=1' -A FlagAgent/1`;
    expect(parsePastedCookies(input)).toEqual({ cookies: ["a=1"], userAgent: "FlagAgent/1" });
  });

  it("a headers list feeds the jar and captures the user-agent", () => {
    const input = `accept: */*\nCookie: ${SESSION}=tok; a=1\nUser-Agent: HeadersUA/2\n`;
    expect(parsePastedCookies(input)).toEqual({ cookies: [`${SESSION}=tok`, "a=1"], userAgent: "HeadersUA/2" });
  });

  it("curl command without any cookie source yields no cookies", () => {
    const parsed = parsePastedCookies("curl 'https://www.perplexity.ai/rest/x' -H 'accept: */*'");
    expect(parsed).toEqual({ cookies: [], userAgent: null });
    expect(parseCurlCommand("curl 'https://www.perplexity.ai/rest/x' -H 'accept: */*'")?.hasCookies).toBeFalse();
  });

  it("line continuations and single-quoted curl cookies with JSON-ish values", () => {
    const input = `curl --url 'https://www.perplexity.ai/' \\
  -b '${SESSION}=jwt.value; g_state={"i_l":0}'`;
    expect(parsePastedCookies(input).cookies).toEqual([`${SESSION}=jwt.value`, 'g_state={"i_l":0}']);
  });

  it("double-quoted curl cookies with escaped quotes are unescaped", () => {
    const escaped = `${SESSION}=jwt.value; g_state={\\"i_l\\":0}`; // literal backslashes, as bash -b "…\"…\"…" delivers
    const input = `curl 'https://www.perplexity.ai/' -b "${escaped}"`;
    expect(parsePastedCookies(input).cookies).toEqual([`${SESSION}=jwt.value`, 'g_state={"i_l":0}']);
  });
});

describe("hasSessionCookie", () => {
  it("detects the session token cookie", () => {
    expect(hasSessionCookie([`${SESSION}=x`, "other=y"])).toBeTrue();
    expect(hasSessionCookie(["other=y"])).toBeFalse();
    expect(hasSessionCookie([])).toBeFalse();
  });
});

// ---------------------------------------------------------------- firefox sqlite

const MOZ_COOKIES_SCHEMA = `CREATE TABLE moz_cookies (
  id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT,
  host TEXT, path TEXT DEFAULT '/', expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER,
  isSecure INTEGER DEFAULT 0, isHttpOnly INTEGER DEFAULT 0)`;

describe("readFirefoxCookiesAt", () => {
  it("reads perplexity cookies from a fixture cookies.sqlite, filtering by host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pplx-ffx-"));
    const dbPath = join(dir, "cookies.sqlite");
    const db = new Database(dbPath);
    db.run(MOZ_COOKIES_SCHEMA);
    db.run("INSERT INTO moz_cookies (name, value, host) VALUES (?, ?, ?)", [SESSION, "tok", ".perplexity.ai"]);
    db.run("INSERT INTO moz_cookies (name, value, host) VALUES (?, ?, ?)", ["pplx.session-id", "sid", "perplexity.ai"]);
    db.run("INSERT INTO moz_cookies (name, value, host) VALUES (?, ?, ?)", ["other", "x", "example.com"]);
    db.run("INSERT INTO moz_cookies (name, value, host) VALUES (?, ?, ?)", ["empty", "", ".perplexity.ai"]);
    // attacker-controlled lookalike host must NOT match
    db.run("INSERT INTO moz_cookies (name, value, host) VALUES (?, ?, ?)", ["evil", "1", "evilperplexity.com"]);
    db.run("INSERT INTO moz_cookies (name, value, host) VALUES (?, ?, ?)", ["evil", "2", "perplexity.ai.evil.io"]);
    // duplicate cookie name: first row wins
    db.run("INSERT INTO moz_cookies (name, value, host) VALUES (?, ?, ?)", ["pplx.session-id", "older", ".perplexity.ai"]);
    db.close();

    const result = readFirefoxCookiesAt(dbPath);
    expect(result.cookies).toEqual([`${SESSION}=tok`, "pplx.session-id=sid"]);
    expect(result.sessionTokenFound).toBeTrue();
    expect(result.warning).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });

  it("warns when no perplexity cookies exist in the profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pplx-ffx-"));
    const dbPath = join(dir, "cookies.sqlite");
    const db = new Database(dbPath);
    db.run(MOZ_COOKIES_SCHEMA);
    db.run("INSERT INTO moz_cookies (name, value, host) VALUES (?, ?, ?)", ["other", "x", "example.com"]);
    db.close();

    const result = readFirefoxCookiesAt(dbPath);
    expect(result.cookies).toEqual([]);
    expect(result.sessionTokenFound).toBeFalse();
    expect(nonEmptyString(result.warning)).toBeTrue();
    await rm(dir, { recursive: true, force: true });
  });

  it("warns (does not throw) on a missing database file", () => {
    const result = readFirefoxCookiesAt(join(tmpdir(), "pplx-no-such-dir", "cookies.sqlite"));
    expect(result.cookies).toEqual([]);
    expect(result.sessionTokenFound).toBeFalse();
    expect(nonEmptyString(result.warning)).toBeTrue();
  });

  it("warns (does not throw) on a non-sqlite file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pplx-ffx-"));
    const path = join(dir, "cookies.sqlite");
    await writeFile(path, "definitely not sqlite", { encoding: "utf8" });
    const result = readFirefoxCookiesAt(path);
    expect(result.cookies).toEqual([]);
    expect(result.sessionTokenFound).toBeFalse();
    expect(nonEmptyString(result.warning)).toBeTrue();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("importBrowserCookies", () => {
  it("firefox with an unknown profile → warning result, no throw", async () => {
    const result = await importBrowserCookies("firefox", { profile: "zz-no-such-profile" });
    expect(result.cookies).toEqual([]);
    expect(result.sessionTokenFound).toBeFalse();
    expect(nonEmptyString(result.warning)).toBeTrue();
  });

  it("chromium with an unknown profile → warning result, no throw", async () => {
    const result = await importBrowserCookies("chromium", { profile: "zz-no-such-profile" });
    expect(result.cookies).toEqual([]);
    expect(result.sessionTokenFound).toBeFalse();
    expect(nonEmptyString(result.warning)).toBeTrue();
  });

  it("browseros with an unknown profile → warning result, no throw", async () => {
    const result = await importBrowserCookies("browseros", { profile: "zz-no-such-profile" });
    expect(result.cookies).toEqual([]);
    expect(nonEmptyString(result.warning)).toBeTrue();
  });
});

// ---------------------------------------------------------------- chromium sqlite

const CHROMIUM_KEY = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
const CHROMIUM_IV = Buffer.alloc(16, 0x20); // 16 × " "

function encryptV10(plain: string): Uint8Array {
  const cipher = createCipheriv("aes-128-cbc", CHROMIUM_KEY, CHROMIUM_IV);
  return new Uint8Array(Buffer.concat([Buffer.from("v10", "latin1"), cipher.update(plain, "utf8"), cipher.final()]));
}

describe("readChromiumCookiesAt", () => {
  async function fixture(
    rows: Array<{ name: string; value?: string; encrypted?: Uint8Array; host?: string }>,
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pplx-chr-"));
    const path = join(dir, "Cookies");
    const db = new Database(path);
    db.run("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)");
    for (const row of rows) {
      db.run("INSERT INTO cookies (host_key, name, value, encrypted_value) VALUES (?, ?, ?, ?)", [
        row.host ?? ".perplexity.ai",
        row.name,
        row.value ?? "",
        row.encrypted ?? new Uint8Array(0),
      ]);
    }
    db.close();
    return path;
  }

  it("decrypts v10 (peanuts key) cookie values and keeps plaintext ones", async () => {
    const path = await fixture([
      { name: SESSION, encrypted: encryptV10("tok-plain") },
      { name: "plain", value: "visible" },
    ]);
    const result = readChromiumCookiesAt(path);
    expect(result.cookies).toEqual([`${SESSION}=tok-plain`, "plain=visible"]);
    expect(result.sessionTokenFound).toBeTrue();
    expect(result.warning).toBeNull();
  });

  it("ignores lookalike hosts and keeps the first value per duplicate name", async () => {
    const path = await fixture([
      { name: "a", value: "first" },
      { name: "a", value: "second" },
      { name: "evil", value: "x", host: "evilperplexity.com" },
    ]);
    const result = readChromiumCookiesAt(path);
    expect(result.cookies).toEqual(["a=first"]);
  });

  it("returns a warning (not a throw) for undecryptable v11 app-bound values", async () => {
    const path = await fixture([
      { name: SESSION, encrypted: new Uint8Array(Buffer.from("v11junkjunkjunkjunkjunk", "latin1")) },
    ]);
    const result = readChromiumCookiesAt(path);
    expect(result.cookies).toEqual([]);
    expect(result.sessionTokenFound).toBeFalse();
    expect(result.warning).toContain("paste");
  });
});
