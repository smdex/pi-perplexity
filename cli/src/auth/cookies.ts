import { Database } from "bun:sqlite";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Cookie import: paste parsing (cookie header / curl / headers list), Firefox-family
 *  sqlite, Chromium-family sqlite (best-effort decryption), browser preset discovery. */

export type BrowserName =
  | "firefox"
  | "zen"
  | "librewolf"
  | "waterfox"
  | "chromium"
  | "chrome"
  | "brave"
  | "vivaldi"
  | "edge"
  | "opera"
  | "browseros";

export interface ParsedCookieInput {
  cookies: string[];
  /** user-agent captured from a curl command / headers list (cf_clearance is UA-bound). */
  userAgent: string | null;
}

export interface ImportResult {
  cookies: string[];
  sessionTokenFound: boolean;
  warning: string | null;
}

export const SESSION_COOKIE_NAME = "__Secure-next-auth.session-token";

export function hasSessionCookie(cookies: string[]): boolean {
  return cookies.some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyResult(warning: string): ImportResult {
  return { cookies: [], sessionTokenFound: false, warning };
}

function resultFrom(cookies: string[], emptyWarning: string): ImportResult {
  return {
    cookies,
    sessionTokenFound: hasSessionCookie(cookies),
    warning: cookies.length > 0 ? null : emptyWarning,
  };
}

// ---------------------------------------------------------------- paste parsing

/** Pull `-b/--cookie $'...'` or `-b "..."` payloads out of a curl command line. */
function extractCurlCookieBodies(command: string): string[] {
  const bodies: string[] = [];
  const re = /(?:^|\s)(?:-b|--cookie)(?:\s|=)("([^"\\]|\\.)*"|'[^']*'|\$'[^']*'|[^\s]+)/g;
  for (const m of command.matchAll(re)) {
    let raw = m[1] ?? "";
    if (raw.startsWith("$'")) {
      raw = raw.slice(2, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      raw = raw.slice(1, -1);
    } else if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\\\'/g, "'");
    }
    bodies.push(raw);
  }
  return bodies;
}

/** Parse `-H "Cookie: …"` (or `-H 'cookie: …'`) header values out of a curl command. */
function extractCurlHeaderCookieBodies(command: string): string[] {
  const bodies: string[] = [];
  const re = /(?:^|\s)-H(?:\s|=)("([^"\\]|\\.)*"|'[^']*'|\$'[^']*'|[^\s]+)/g;
  for (const m of command.matchAll(re)) {
    let raw = m[1] ?? "";
    if (raw.startsWith("$'")) {
      raw = raw.slice(2, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      raw = raw.slice(1, -1);
    } else if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      raw = raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (/^cookie\s*:/i.test(raw)) bodies.push(raw.replace(/^cookie\s*:/i, ""));
  }
  return bodies;
}

/** True when the text looks like a curl invocation ("curl …" possibly shell-continued). */
export function looksLikeCurlCommand(text: string): boolean {
  return /(^|\n)\s*curl\s/.test(text);
}

/** Parse a single cookie body: Cookie header, one-per-line pairs, or Netscape cookies.txt. */
function parseCookieBodyLines(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (name: string, value: string): void => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return;
    if (seen.has(trimmedName)) return;
    seen.add(trimmedName);
    out.push(`${trimmedName}=${value.trim()}`);
  };

  const addNetscape = (line: string): void => {
    const fields = line.split("\t");
    if (fields.length < 7) return;
    add(fields[5] ?? "", fields.slice(6).join("\t"));
  };

  /** Strip an optional case-insensitive "Cookie:" header prefix (people copy the whole header). */
  const stripCookiePrefix = (line: string): string =>
    /^cookie\s*:\s*/i.test(line) ? line.replace(/^cookie\s*:\s*/i, "") : line;

  for (const line of body.split(/\r?\n/)) {
    const trimmed = stripCookiePrefix(line.trim());
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("#HttpOnly_")) {
      addNetscape(trimmed.slice("#HttpOnly_".length));
    } else if (trimmed.startsWith("#")) {
      continue; // comment
    } else if (trimmed.includes("\t")) {
      addNetscape(trimmed);
    } else {
      // raw Cookie header form or a single name=value line
      for (const piece of trimmed.split(";")) {
        const eq = piece.indexOf("=");
        if (eq <= 0) continue;
        add(piece.slice(0, eq), piece.slice(eq + 1));
      }
    }
  }

  return out;
}

/**
 * Parse a pasted curl command into its pieces. Understands `-b/--cookie` (any
 * quoting style, including `$'…'`), `-H "Cookie: …"`, `-A/--user-agent` and
 * `-H "User-Agent: …"`. `hasCookies` says whether any cookie source was found —
 * URLs alone don't count. Returns null when the text is not a curl command.
 */
export function parseCurlCommand(text: string): { cookies: string[]; userAgent: string | null; hasCookies: boolean } | null {
  const joined = text.replace(/\\\r?\n/g, " "); // shell line continuations → single line
  if (!looksLikeCurlCommand(joined)) return null;

  const bodies = [...extractCurlCookieBodies(joined), ...extractCurlHeaderCookieBodies(joined)];
  const cookies: string[] = [];
  const seen = new Set<string>();
  for (const body of bodies) {
    for (const cookie of parseCookieBodyLines(body)) {
      const name = cookie.slice(0, cookie.indexOf("="));
      if (seen.has(name)) continue;
      seen.add(name);
      cookies.push(cookie);
    }
  }

  let userAgent: string | null = null;
  const uaFlag = joined.match(/(?:^|\s)(?:-A|--user-agent)(?:\s|=)("([^"]*)"|'([^']*)'|[^\s]+)/);
  if (uaFlag) userAgent = (uaFlag[2] ?? uaFlag[3] ?? uaFlag[1] ?? "").trim() || null;
  for (const h of joined.matchAll(/-H(?:\s|=)("([^"]*)"|'([^']*)'|\$'[^']*'|[^\s]+)/g)) {
    const raw = h[2] ?? h[3] ?? h[1] ?? "";
    const m = raw.match(/^user-agent\s*:\s*(.+?)\s*$/i);
    if (m?.[1]) userAgent = m[1];
  }

  return { cookies, userAgent, hasCookies: bodies.length > 0 };
}

/**
 * Parse arbitrary pasted login input: a curl command ("Copy as cURL" in every
 * browser's devtools), a Cookie header, a headers list, Netscape cookies.txt, or
 * one-per-line name=value pairs. Captures the user-agent when present so the
 * Cloudflare-bound cookies (cf_clearance, __cf_bm) can be replayed faithfully.
 */
export function parsePastedCookies(text: string): ParsedCookieInput {
  const joined = text.replace(/\\\r?\n/g, " ");
  if (looksLikeCurlCommand(joined)) {
    const parsed = parseCurlCommand(joined);
    if (parsed && parsed.hasCookies) return { cookies: parsed.cookies, userAgent: parsed.userAgent };
  }

  // Headers list ("Cookie: …" / "User-Agent: …" lines) — Cookie lines feed the jar,
  // a User-Agent line is captured.
  const cookies: string[] = [];
  const seen = new Set<string>();
  let userAgent: string | null = null;
  let sawHeader = false;

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    sawHeader = true;
    const name = m[1] ?? "";
    const value = m[2] ?? "";
    if (/^cookie$/i.test(name)) {
      for (const cookie of parseCookieBodyLines(value)) {
        const cn = cookie.slice(0, cookie.indexOf("="));
        if (seen.has(cn)) continue;
        seen.add(cn);
        cookies.push(cookie);
      }
    } else if (/^user-agent$/i.test(name)) {
      userAgent = value;
    }
  }
  if (sawHeader) return { cookies, userAgent };

  return { cookies: parseCookieBodyLines(text), userAgent: null };
}

// ---------------------------------------------------------------- firefox

/**
 * perplexity.ai cookie hosts: the auth session token lives on the host-only domain
 * `www.perplexity.ai` (observed in live Firefox-family and Chromium-family DBs), while
 * `cf_clearance`/`__cf_bm` sit on `.perplexity.ai` and `pplx.edge-*` on either. Exact
 * suffix match on "perplexity.ai" — evilperplexity.com or perplexity.ai.evil.io must
 * never match.
 */
export function isPerplexityHost(host: string): boolean {
  return host === "perplexity.ai" || host.endsWith(".perplexity.ai");
}

const FIREFOX_HOST_SQL =
  "host = 'perplexity.ai' OR host LIKE '%.perplexity.ai'"; // LIKE-escaped suffix below

/** Read perplexity.ai cookies from a firefox-family cookies.sqlite file. Never throws. */
export function readFirefoxCookiesAt(dbPath: string): ImportResult {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    return emptyResult(`could not open Firefox cookie database (${errorMessage(error)}) — use \`pplx login --paste\``);
  }
  try {
    const rows = db
      .query(`SELECT host, name, value FROM moz_cookies WHERE ${FIREFOX_HOST_SQL} ORDER BY rowid`)
      .all() as Array<{ host: unknown; name: unknown; value: unknown }>;
    const cookies: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (typeof row.host !== "string" || !isPerplexityHost(row.host)) continue; // defense in depth (lookalike TLDs)
      if (typeof row.name === "string" && row.name.length > 0 && typeof row.value === "string" && row.value.length > 0) {
        if (seen.has(row.name)) continue; // first occurrence wins per name
        seen.add(row.name);
        cookies.push(`${row.name}=${row.value}`);
      }
    }
    return resultFrom(cookies, "no perplexity.ai cookies found in this browser profile — is it logged in?");
  } catch (error) {
    return emptyResult(`could not read Firefox cookie database (${errorMessage(error)}) — use \`pplx login --paste\``);
  } finally {
    db.close();
  }
}

interface BrowserPreset {
  label: string;
  /** Firefox-family: profiles root (one level per profile). Chromium-family: data dir (profiles inside). */
  kind: "firefox" | "chromium";
  /** Platform → candidate roots. First existing wins unless --profile-location overrides. */
  roots: Partial<Record<NodeJS.Platform, string[]>>;
}

const p = (...parts: string[]): string => join(homedir(), ...parts);

/** Preset data locations for every supported browser (Linux/macOS; Windows later). */
export const BROWSER_PRESETS: Record<BrowserName, BrowserPreset> = {
  firefox: {
    label: "Firefox",
    kind: "firefox",
    roots: {
      linux: [p(".mozilla", "firefox")],
      darwin: [p("Library", "Application Support", "Firefox", "Profiles")],
    },
  },
  zen: {
    label: "Zen",
    kind: "firefox",
    roots: {
      linux: [p(".zen")],
      darwin: [p("Library", "Application Support", "zen")],
    },
  },
  librewolf: {
    label: "LibreWolf",
    kind: "firefox",
    roots: {
      linux: [p(".librewolf"), p(".var", "io.gitlab.librewolf_community", ".librewolf")],
      darwin: [p("Library", "Application Support", "LibreWolf")],
    },
  },
  waterfox: {
    label: "Waterfox",
    kind: "firefox",
    roots: {
      linux: [p(".waterfox")],
      darwin: [p("Library", "Application Support", "Waterfox")],
    },
  },
  chromium: {
    label: "Chromium",
    kind: "chromium",
    roots: {
      linux: [p(".config", "chromium")],
      darwin: [p("Library", "Application Support", "Chromium")],
    },
  },
  chrome: {
    label: "Chrome",
    kind: "chromium",
    roots: {
      linux: [p(".config", "google-chrome")],
      darwin: [p("Library", "Application Support", "Google", "Chrome")],
    },
  },
  brave: {
    label: "Brave",
    kind: "chromium",
    roots: {
      linux: [p(".config", "BraveSoftware", "Brave-Browser")],
      darwin: [p("Library", "Application Support", "BraveSoftware", "Brave-Browser")],
    },
  },
  vivaldi: {
    label: "Vivaldi",
    kind: "chromium",
    roots: {
      linux: [p(".config", "vivaldi")],
      darwin: [p("Library", "Application Support", "Vivaldi")],
    },
  },
  edge: {
    label: "Edge",
    kind: "chromium",
    roots: {
      linux: [p(".config", "microsoft-edge")],
      darwin: [p("Library", "Application Support", "Microsoft Edge")],
    },
  },
  opera: {
    label: "Opera",
    kind: "chromium",
    roots: {
      linux: [p(".config", "opera")],
      darwin: [p("Library", "Application Support", "com.operasoftware.Opera")],
    },
  },
  browseros: {
    label: "BrowserOS",
    kind: "chromium",
    roots: {
      linux: [p(".config", "browseros"), p(".config", "browser-claw")],
      darwin: [p("Library", "Application Support", "BrowserOS")],
    },
  },
};

// ---------------------------------------------------------------- chromium / browseros

const CHROMIUM_KEY = pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1"); // Linux/Chromium key derivation
const CHROMIUM_IV = Buffer.alloc(16, 0x20); // 16 × " "

/** Decrypt a Chromium cookie value blob. Returns null when the blob is undecryptable. */
function decryptChromiumValue(blob: Uint8Array, hostKey: string): string | null {
  const buf = Buffer.from(blob);
  if (buf.length === 0) return "";
  const version = buf.subarray(0, 3).toString("latin1");
  if (version !== "v10" && version !== "v11") {
    return buf.toString("utf8"); // unencrypted value
  }
  if (version === "v11" || buf.length < 3 + 16) {
    return null; // app-bound encryption — not decryptable offline
  }
  try {
    const decipher = createDecipheriv("aes-128-cbc", CHROMIUM_KEY, CHROMIUM_IV);
    let plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
    // Newer Chromium prefixes the plaintext with SHA-256(host); strip it when present.
    const digest = createHash("sha256").update(hostKey).digest();
    if (plain.subarray(0, 32).equals(digest) || (plain.length > 32 && (plain[0] ?? 0) < 0x20)) {
      plain = plain.subarray(32);
    }
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

/** Read perplexity.ai cookies from a Chromium-style Cookies sqlite file. Never throws. */
export function readChromiumCookiesAt(dbPath: string): ImportResult {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (error) {
    return emptyResult(`could not open Chromium cookie database (${errorMessage(error)}) — use \`pplx login --paste\``);
  }
  try {
    const rows = db
      .query(
        `SELECT host_key, name, value, encrypted_value FROM cookies WHERE host_key = 'perplexity.ai' OR host_key LIKE '%.perplexity.ai' ORDER BY rowid`,
      )
      .all() as Array<{ host_key: unknown; name: unknown; value: unknown; encrypted_value: unknown }>;
    const cookies: string[] = [];
    const seen = new Set<string>();
    let failed = 0;
    for (const row of rows) {
      const hostKey = typeof row.host_key === "string" ? row.host_key : "";
      if (!isPerplexityHost(hostKey)) continue; // defense in depth (lookalike TLDs)
      const name = typeof row.name === "string" ? row.name : "";
      if (name.length === 0 || seen.has(name)) continue; // first occurrence wins per name
      let value: string | null = typeof row.value === "string" && row.value.length > 0 ? row.value : null;
      if (value === null && row.encrypted_value instanceof Uint8Array && row.encrypted_value.byteLength > 0) {
        value = decryptChromiumValue(row.encrypted_value, hostKey);
        if (value === null) {
          failed++;
          continue;
        }
      }
      if (value && value.length > 0) {
        seen.add(name);
        cookies.push(`${name}=${value}`);
      }
    }
    if (failed > 0) {
      return {
        cookies,
        sessionTokenFound: hasSessionCookie(cookies),
        warning: `${failed} cookie value(s) in this browser profile are encrypted with app-bound/OS-keychain encryption and could not be decrypted — use \`pplx login --paste\` with cookies copied from the browser instead.`,
      };
    }
    return resultFrom(cookies, "no perplexity.ai cookies found in this browser profile — is it logged in?");
  } catch (error) {
    return emptyResult(`could not read Chromium cookie database (${errorMessage(error)}) — use \`pplx login --paste\``);
  } finally {
    db.close();
  }
}

function chromiumDataDirs(browser: BrowserName): string[] {
  return BROWSER_PRESETS[browser].roots[process.platform] ?? [];
}

function findChromiumCookiesDb(browser: BrowserName, profile?: string): string | null {
  const profileDir = profile ?? "Default";
  for (const base of chromiumDataDirs(browser)) {
    for (const relative of [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")]) {
      const candidate = join(base, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function listDirs(base: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

/** Firefox-family: every profile dir under the preset roots (or the override dir). */
async function findFirefoxCookiesDb(browser: BrowserName, profile?: string, profileLocation?: string): Promise<string | null> {
  const bases = profileLocation ? [profileLocation] : (BROWSER_PRESETS[browser].roots[process.platform] ?? []);
  for (const base of bases) {
    // The override may point at a profile dir itself (containing cookies.sqlite directly).
    const direct = join(base, "cookies.sqlite");
    if (existsSync(direct)) return direct;
    const dirs = await listDirs(base);
    const candidates = profile ? dirs.filter((dir) => dir === profile || dir.endsWith(`.${profile}`)) : dirs;
    for (const dir of candidates) {
      const dbPath = join(base, dir, "cookies.sqlite");
      if (existsSync(dbPath)) return dbPath;
    }
  }
  return null;
}

// ---------------------------------------------------------------- entry point

/** Resolve the label used in user-facing messages. */
function browserLabel(browser: BrowserName): string {
  return BROWSER_PRESETS[browser].label;
}

/**
 * Import perplexity.ai cookies from a browser profile. Always resolves — failures
 * (missing profile, locked DB, undecryptable values) come back as warnings, never throws.
 * Firefox-family DBs are read directly; Chromium-family value decryption is best-effort
 * (v10 "peanuts"/keyring keys work offline; app-bound v11 blobs do not).
 *
 * `profileLocation` overrides the preset data dir: pass the data dir itself, a profile
 * directory, or the cookies database file directly.
 */
export async function importBrowserCookies(
  browser: BrowserName,
  opts?: { profile?: string; profileLocation?: string },
): Promise<ImportResult> {
  const profile = opts?.profile;
  const location = opts?.profileLocation?.trim() || undefined;
  const kind = BROWSER_PRESETS[browser].kind;

  let dbPath: string | null = null;
  if (location) {
    const asFile = location.endsWith(".sqlite") || location.endsWith("Cookies");
    if (asFile && existsSync(location)) {
      dbPath = location;
    } else if (kind === "firefox") {
      dbPath = await findFirefoxCookiesDb(browser, profile, location);
    } else {
      // Chromium-family: location may be the data dir or a profile dir.
      const direct = [join(location, "Network", "Cookies"), join(location, "Cookies")].find((c) => existsSync(c));
      if (direct) {
        dbPath = direct;
      } else {
        // Treat the location as a data dir and search profiles inside.
        for (const dir of await listDirs(location)) {
          const candidate = profile && dir !== profile
            ? null
            : [join(location, dir, "Network", "Cookies"), join(location, dir, "Cookies")].find((c) => existsSync(c));
          if (candidate) {
            dbPath = candidate;
            break;
          }
        }
      }
    }
  } else {
    dbPath = kind === "firefox" ? await findFirefoxCookiesDb(browser, profile) : findChromiumCookiesDb(browser, profile);
  }

  if (!dbPath) {
    const where = location ? `'${location}'` : `for the '${browserLabel(browser)}' profile`;
    return emptyResult(
      `${browserLabel(browser)} cookie database not found ${where}${profile ? ` (profile '${profile}')` : ""} — is that browser installed and logged in? Otherwise use \`pplx login --paste\`.`,
    );
  }

  // Copy the DB to a temp dir first so a running browser's DB lock can't block reads.
  const tmp = await mkdtemp(join(tmpdir(), "pplx-cookies-"));
  try {
    const copyPath = join(tmp, kind === "firefox" ? "cookies.sqlite" : "Cookies");
    await copyFile(dbPath, copyPath);
    return kind === "firefox" ? readFirefoxCookiesAt(copyPath) : readChromiumCookiesAt(copyPath);
  } catch (error) {
    return emptyResult(`could not copy ${browserLabel(browser)} cookie database (${errorMessage(error)}) — close the browser or use \`pplx login --paste\``);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
