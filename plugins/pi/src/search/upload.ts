import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AuthCredentials } from "../auth/login.js";
import { PERPLEXITY_API_VERSION, PERPLEXITY_USER_AGENT } from "../constants.js";
import { restPostJson } from "./client.js";

const MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", xml: "application/xml", html: "text/html", js: "text/javascript", ts: "text/typescript", py: "text/x-python", pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};
type Presigned = { s3_bucket_url?: string; s3_object_url?: string; fields?: Record<string, unknown>; rate_limited?: boolean; error?: unknown };

export async function uploadAttachments(files: { path: string }[], creds: AuthCredentials, signal?: AbortSignal): Promise<string[]> {
  if (!files.length) return [];
  const inputs = await Promise.all(files.map(async ({ path }) => {
    let bytes: Buffer;
    try { bytes = await readFile(path); } catch { throw new Error(`Could not read attachment file: ${path}`); }
    if (!bytes.length) throw new Error(`Attachment file is empty: ${path}`);
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    return { path, bytes, id: randomUUID(), contentType: MIME[ext] ?? "application/octet-stream" };
  }));
  const payload = { files: Object.fromEntries(inputs.map((f) => [f.id, { filename: f.path.split(/[\\/]/).pop() ?? f.path, content_type: f.contentType, source: "default", file_size: f.bytes.length, force_image: false, skip_parsing: false }])) };
  const url = `https://www.perplexity.ai/rest/uploads/batch_create_upload_urls?version=${PERPLEXITY_API_VERSION}&source=default`;
  const headers = { Cookie: creds.cookies.join("; "), "Content-Type": "application/json", "User-Agent": creds.userAgent ?? PERPLEXITY_USER_AGENT, "X-App-ApiClient": "default", "X-App-ApiVersion": PERPLEXITY_API_VERSION, ...(creds.jwt ? { Authorization: `Bearer ${creds.jwt}` } : {}) };
  let parsed: { results?: Record<string, Presigned> };
  try { parsed = await restPostJson(url, headers, payload, signal) as typeof parsed; } catch (error) { throw new Error(`Attachment presign request failed: ${error instanceof Error ? error.message : String(error)}`); }
  return Promise.all(inputs.map(async (f) => {
    const item = parsed.results?.[f.id];
    if (!item || item.error || item.rate_limited || !item.s3_bucket_url || !item.s3_object_url || !item.fields) throw new Error(`Could not prepare attachment ${f.path}${item?.rate_limited ? ": upload rate limited" : item?.error ? `: ${String(item.error)}` : "."}`);
    const form = new FormData();
    for (const [key, value] of Object.entries(item.fields)) if (typeof value === "string") form.append(key, value);
    form.append("file", new Blob([new Uint8Array(f.bytes)], { type: f.contentType }), f.path.split(/[\\/]/).pop() ?? f.path);
    const uploaded = await fetch(item.s3_bucket_url, { method: "POST", body: form, signal: signal ?? null });
    if (!uploaded.ok) throw new Error(`Uploading attachment ${f.path} failed (HTTP ${uploaded.status}).`);
    return item.s3_object_url!;
  }));
}
