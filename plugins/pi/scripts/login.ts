import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { beginEmailOtpLogin, completeEmailOtpLogin } from "../src/auth/login.js";
import type { StoredToken } from "../src/search/types.js";

const OUTPUT_PATH = join(process.cwd(), ".auth.json");

interface ParsedArgs {
  email?: string;
  otp?: string;
  help: boolean;
}

function normalizeInput(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function firstDefinedEnv(...keys: string[]): string | null {
  for (const key of keys) {
    const value = normalizeInput(process.env[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

function usage(): string {
  return [
    "Usage: bun run scripts/login.ts [email] [otp]",
    "       bun run scripts/login.ts --email you@example.com [--otp 123456]",
    "",
    "Env vars:",
    "  PERPLEXITY_EMAIL      Default email",
    "  PERPLEXITY_OTP        Default OTP",
    "  PI_PERPLEXITY_EMAIL   Default email",
    "  PI_PERPLEXITY_OTP     Default OTP",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { help: false };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }

    if (token === "--email") {
      const email = normalizeInput(argv[index + 1]);
      if (email) {
        parsed.email = email;
      }
      index += 1;
      continue;
    }

    if (token === "--otp") {
      const otp = normalizeInput(argv[index + 1]);
      if (otp) {
        parsed.otp = otp;
      }
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  if (!parsed.email) {
    const email = normalizeInput(positionals[0]);
    if (email) {
      parsed.email = email;
    }
  }

  if (!parsed.otp) {
    const otp = normalizeInput(positionals[1]);
    if (otp) {
      parsed.otp = otp;
    }
  }

  return parsed;
}

async function prompt(question: string): Promise<string | null> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return normalizeInput(await rl.question(question));
  } finally {
    rl.close();
  }
}

async function saveLocalToken(token: StoredToken): Promise<void> {
  await writeFile(OUTPUT_PATH, `${JSON.stringify(token, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(OUTPUT_PATH, 0o600);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    stdout.write(`${usage()}\n`);
    return;
  }

  const email =
    args.email ??
    firstDefinedEnv("PERPLEXITY_EMAIL", "PI_PERPLEXITY_EMAIL") ??
    (await prompt("Perplexity email: "));

  if (!email) {
    throw new Error("Email is required.");
  }

  const session = await beginEmailOtpLogin(email);
  let otp = args.otp ?? firstDefinedEnv("PERPLEXITY_OTP", "PI_PERPLEXITY_OTP");

  if (!otp) {
    stdout.write(`OTP sent to ${session.email}.\n`);
    otp = await prompt("Enter OTP: ");
  }

  if (!otp) {
    throw new Error("OTP is required to complete login.");
  }

  const { token: access, cookies } = await completeEmailOtpLogin(session, otp);
  if (!access) {
    throw new Error("Login succeeded but returned no access token.");
  }
  await saveLocalToken({ type: "oauth", access, email: session.email });
  if (cookies.length > 0) {
    stdout.write(`Captured ${cookies.length} auth cookies alongside the token.\n`);
  }
  stdout.write(`Saved login data to ${OUTPUT_PATH}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Login failed: ${message}`);
  process.exitCode = 1;
});
