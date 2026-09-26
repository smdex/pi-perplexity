import type { CommandModule } from "yargs";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { clearAuth, loadAuth, saveAuth, type StoredAuth } from "../config.js";
import {
  BROWSER_PRESETS,
  SESSION_COOKIE_NAME,
  importBrowserCookies,
  hasSessionCookie,
  parsePastedCookies,
  type BrowserName,
} from "../auth/cookies.js";
import { fetchSessionInfo, loginInteractive } from "../auth/otp.js";
import { out } from "./util.js";

/**
 * pplx login [--paste | --browser B | --email/--otp | interactive OTP]
 *          | --status | --logout
 * Order tried: --paste → --browser → --email/--otp → interactive email OTP.
 * Cookie paths validate against /api/auth/session before the jar is saved.
 */

async function prompt(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(label);
  } finally {
    rl.close();
  }
}

/**
 * Secret prompt (OTP): the code must not echo to the terminal. Raw-mode key
 * reading with backspace/Ctrl-C handling; terminal state is ALWAYS restored
 * (finally). Falls back to a plain prompt when stdin is not a TTY (piped OTP).
 */
async function promptSecret(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return prompt(label);
  }
  process.stdout.write(label);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let data = "";
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      try {
        stdin.setRawMode(false);
      } catch {
        // already restored
      }
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const finish = (answer: string): void => {
      cleanup();
      resolve(answer);
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) {
          finish(data.trim());
          return; // Enter — submit
        }
        if (byte === 0x03) {
          cleanup();
          const interrupted = new Error("interrupted");
          interrupted.name = "AbortError"; // index.ts maps this to a quiet exit 130
          reject(interrupted);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          data = data.slice(0, -1); // Backspace
          continue;
        }
        data += String.fromCharCode(byte);
      }
    };
    try {
      stdin.setRawMode(true);
    } catch {
      // Raw mode unavailable (odd terminal) — fall back to the plain prompt.
      settled = true; // cleanup() is a no-op here; nothing was set up yet
      prompt("").then((answer) => resolve(answer.trim()), reject);
      return;
    }
    stdin.resume();
    stdin.on("data", onData);
  });
}

/** Read pasted login input: piped stdin when not a TTY, else lines until EOF/blank. */
async function readPastedInput(prompt: string): Promise<string> {
  let text = "";
  if (!process.stdin.isTTY) {
    return Bun.stdin.text().catch(() => "");
  }
  out(prompt);
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim() === "") break;
    text += `${line}\n`;
  }
  rl.close();
  return text;
}

/**
 * One-by-one fallback for bare values: ask for a cookie name (Enter = the session
 * token), then the bare value; repeat until the name is blank. TTY only — a piped
 * paste that parses to nothing gets guidance instead.
 */
async function promptCookiesOneByOne(): Promise<string[]> {
  const cookies: string[] = [];
  const seen = new Set<string>();
  out("enter cookies one at a time (empty name to finish):");
  for (;;) {
    const name = (await prompt("cookie name [__Secure-next-auth.session-token]: ")).trim();
    if (!name && cookies.length === 0) {
      const fallback = SESSION_COOKIE_NAME;
      const value = (await prompt(`value for ${fallback}: `)).trim();
      if (value) cookies.push(`${fallback}=${value}`);
      break;
    }
    if (!name) break;
    if (seen.has(name)) {
      out(pc.yellow(`  ${name} already entered — skipping`));
      continue;
    }
    const value = (await prompt(`value for ${name}: `)).trim();
    if (!value) continue;
    seen.add(name);
    cookies.push(`${name}=${value}`);
  }
  return cookies;
}

/** Validate a candidate jar against /api/auth/session; returns the auth profile or throws. */
async function validateJar(
  cookies: string[],
  source: StoredAuth["source"],
  opts?: { userAgent?: string | null },
): Promise<StoredAuth> {
  if (!hasSessionCookie(cookies)) {
    throw new Error(
      "cookies are missing __Secure-next-auth.session-token — copy the full cookie set from a logged-in browser (e.g. \"Copy as cURL\" in devtools, then paste it here)",
    );
  }
  const info = await fetchSessionInfo(cookies, undefined, opts?.userAgent ?? undefined);
  if (!info || !info.accountUuid) {
    throw new Error("cookies rejected: /api/auth/session returned no active session (expired or partial jar)");
  }
  return {
    kind: "cookies",
    cookies,
    accountUuid: info.accountUuid,
    sessionExpires: info.expires,
    email: info.email,
    bearerToken: null,
    source,
    createdAt: new Date().toISOString(),
    ...(opts?.userAgent ? { userAgent: opts.userAgent } : {}),
  };
}

function printLoggedIn(auth: StoredAuth): void {
  const who = auth.email ?? auth.accountUuid ?? "unknown account";
  out(`${pc.green("✓")} logged in as ${pc.bold(who)}${auth.sessionExpires ? ` (session expires ${auth.sessionExpires})` : ""}`);
}

export const loginCommand: CommandModule = {
  command: "login",
  describe: "authenticate: paste cookies, import from a browser, or email OTP",
  builder: (y) =>
    y
      .option("paste", { type: "boolean", describe: "paste cookies: a full curl command (\"Copy as cURL\"), a Cookie header, a headers list, or one name=value pair per line (stdin works when piped)" })
      .option("browser", {
        type: "string",
        choices: Object.keys(BROWSER_PRESETS) as BrowserName[],
        describe: "import cookies from a browser profile",
      })
      .option("profile", { type: "string", describe: "browser profile name (default: first profile with cookies)" })
      .option("profile-location", {
        type: "string",
        describe: "custom browser data dir, profile directory, or cookies database path (overrides the preset location)",
      })
      .option("email", { type: "string", describe: "email address for OTP login" })
      .option("otp", { type: "string", describe: "OTP code (also PPLX_OTP)" })
      .option("status", { type: "boolean", describe: "show stored credentials and session state" })
      .option("logout", { type: "boolean", describe: "clear stored credentials" })
      .conflicts("paste", ["browser", "email", "otp"])
      .conflicts("browser", ["email", "otp"]),
  handler: async (argv) => {
    if (argv.logout) {
      await clearAuth();
      out("logged out (stored credentials removed)");
      return;
    }
    if (argv.status) {
      const auth = await loadAuth();
      if (!auth) {
        out("not logged in");
        process.exitCode = 2;
        return;
      }
      out(
        [
          `source:      ${auth.source}`,
          `email:       ${auth.email ?? "—"}`,
          `account:     ${auth.accountUuid ?? "—"}`,
          `expires:     ${auth.sessionExpires ?? "—"}`,
          `stored at:   ${new Date(auth.createdAt).toISOString()}`,
          ...(auth.userAgent ? [`user-agent:  ${auth.userAgent}`] : []),
        ].join("\n"),
      );
      const info = await fetchSessionInfo(auth.cookies, undefined, auth.userAgent ?? undefined).catch(() => null);
      if (info?.accountUuid) {
        out(
          `live session: ${pc.green("valid")}${info.email ? ` (${info.email}${info.paymentTier ? `, ${info.paymentTier}` : ""})` : ""}`,
        );
      } else {
        out(`live session: ${pc.red("invalid or unreachable")} — if this persists, re-run ${pc.bold("pplx login")}`);
      }
      return;
    }

    if (argv.paste) {
      const text = await readPastedInput(
        "Paste a curl command (\"Copy as cURL\" from a logged-in perplexity.ai tab), a Cookie header, a headers list, or one name=value pair per line (blank line or Ctrl-D to finish):",
      );
      let { cookies, userAgent } = parsePastedCookies(text);
      if (cookies.length === 0 && text.trim().length > 0 && process.stdin.isTTY) {
        // Bare value(s) with no name= structure — fall back to prompting per cookie.
        out(pc.dim("no name=value pairs detected in the pasted input"));
        cookies = await promptCookiesOneByOne();
      }
      if (cookies.length === 0) {
        throw new Error(
          "no cookies found in the pasted input — paste a curl command (with -b/--cookie or a Cookie header), a Cookie header, or name=value lines",
        );
      }
      if (userAgent) out(pc.dim(`using captured user-agent: ${userAgent.slice(0, 60)}${userAgent.length > 60 ? "…" : ""}`));
      const auth = await validateJar(cookies, "paste", { userAgent });
      await saveAuth(auth);
      printLoggedIn(auth);
      return;
    }

    if (typeof argv.browser === "string") {
      const browser = argv.browser as BrowserName;
      const result = await importBrowserCookies(browser, {
        ...(typeof argv.profile === "string" ? { profile: argv.profile } : {}),
        ...(typeof argv["profile-location"] === "string" ? { profileLocation: argv["profile-location"] } : {}),
      });
      if (result.warning || !hasSessionCookie(result.cookies)) {
        throw new Error(result.warning ?? "imported cookies are missing the session token — is that browser logged in?");
      }
      const auth = await validateJar(result.cookies, browser);
      await saveAuth(auth);
      printLoggedIn(auth);
      return;
    }

    const auth = await loginInteractive(
      {
        promptEmail: () => prompt("Perplexity account email: "),
        promptOtp: (email) => promptSecret(`OTP code sent to ${email}: `),
      },
      undefined,
      {
        ...(typeof argv.email === "string" ? { email: argv.email } : {}),
        ...(typeof argv.otp === "string" ? { otp: argv.otp } : {}),
      },
    );
    printLoggedIn(auth);
  },
};
