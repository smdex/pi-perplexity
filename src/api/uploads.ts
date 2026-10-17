import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { apiPost, ApiError, restPost } from "./http.js";
import { readSseJson } from "./sse.js";

/**
 * File attachment flow (contract §F, verified c-04/c-05):
 * presign → S3 multipart POST (204) → attachment_processing/subscribe SSE until
 * success:true. The ask body then references only the s3_object_url.
 */

export interface UploadResult {
  fileUuid: string;
  s3ObjectUrl: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
};

/** The ONLY origin presign URLs may point at (exfil guard — verified in c-trace). */
const UPLOAD_ORIGIN = "https://ppl-ai-file-upload.s3.amazonaws.com";

/** Presign URLs must be HTTPS on the exact expected S3 origin — a hostile/malformed
 * API response must never send local file bytes to another host. */
function assertUploadUrl(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Upload failed (step 1): presign ${label} is not a valid URL`);
  }
  if (parsed.origin !== UPLOAD_ORIGIN) {
    throw new Error(`Upload failed (step 1): presign ${label} must be ${UPLOAD_ORIGIN}, got ${parsed.origin}`);
  }
}

function contentTypeFor(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return CONTENT_TYPES[filename.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** file_uuid lives in `fields.key` = "web/direct-files/attachments/<user_id>/<file_uuid>/<filename>". */
function fileUuidFromKey(key: string): string | null {
  const segments = key.split("/").filter((s) => s.length > 0);
  // attachments/<user>/<file_uuid>/<name> → file_uuid is segment -2 counting the name
  const uuid = segments.length >= 2 ? segments[segments.length - 2] : null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuid && uuidRe.test(uuid) ? uuid : null;
}

interface PresignResult {
  s3BucketUrl: string;
  s3ObjectUrl: string;
  fields: Record<string, string>;
}

/**
 * Upload one file: presign → S3 POST (FormData + Blob) → subscribe SSE.
 * Errors carry the failing step number.
 */
export async function uploadFile(filePath: string, signal?: AbortSignal | undefined): Promise<UploadResult> {
  // Step 1: presign
  const filename = basename(filePath);
  const contentType = contentTypeFor(filename);
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new Error(`Upload failed (step 1, read file): ${error instanceof Error ? error.message : String(error)}`);
  }
  const key = crypto.randomUUID();
  const presignPayload = await restPost<unknown>("/rest/uploads/batch_create_upload_urls", {
    files: {
      [key]: {
        filename,
        content_type: contentType,
        source: "default",
        file_size: bytes.byteLength,
        force_image: false,
        skip_parsing: false,
      },
    },
  }, signal).catch((error: unknown) => {
    throw new Error(`Upload failed (step 1, presign): ${error instanceof Error ? error.message : String(error)}`);
  });
  const results = isRecord(presignPayload) && isRecord(presignPayload.results) ? presignPayload.results : {};
  const entry = isRecord(results[key]) ? results[key] : null;
  if (!entry || typeof entry.s3_bucket_url !== "string" || typeof entry.s3_object_url !== "string" || !isRecord(entry.fields)) {
    throw new Error("Upload failed (step 1): presign response missing s3 urls/fields");
  }
  const presign: PresignResult = {
    s3BucketUrl: entry.s3_bucket_url,
    s3ObjectUrl: entry.s3_object_url,
    fields: Object.fromEntries(
      Object.entries(entry.fields).filter((entry2): entry2 is [string, string] => typeof entry2[1] === "string"),
    ),
  };
  const fileUuid = fileUuidFromKey(String(presign.fields.key ?? ""));
  if (!fileUuid) throw new Error("Upload failed (step 1): could not extract file_uuid from presign key");
  assertUploadUrl(presign.s3BucketUrl, "s3_bucket_url");
  assertUploadUrl(presign.s3ObjectUrl, "s3_object_url");

  // Step 2: S3 multipart POST — every presign field IN ORDER, then the file Blob.
  const form = new FormData();
  for (const [name, value] of Object.entries(presign.fields)) {
    form.append(name, value);
  }
  form.append("file", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
  let s3Response: Response;
  try {
    // redirect: "error" — the validated origin must be the final destination too
    s3Response = await fetch(presign.s3BucketUrl, {
      method: "POST",
      body: form,
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new Error(`Upload failed (step 2, S3 POST): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!(s3Response.status >= 200 && s3Response.status < 300)) {
    const text = await s3Response.text().catch(() => "");
    throw new ApiError(s3Response.status, `Upload failed (step 2, S3 POST): HTTP ${s3Response.status}`, text.slice(0, 300));
  }

  // Step 3: wait for server-side parse via subscribe SSE (success === true).
  const subscribe = await apiPost(
    "/rest/sse/attachment_processing/subscribe",
    { file_uuids: [fileUuid] },
    { Accept: "text/event-stream" },
    { sse: true, signal },
  );
  if (!subscribe.body) throw new Error("Upload failed (step 3): subscribe stream empty");
  let success = false;
  for await (const raw of readSseJson(subscribe.body, signal)) {
    if (!isRecord(raw)) continue; // non-object snapshots are skipped
    const eventFileUuid = typeof raw.file_uuid === "string" ? raw.file_uuid : undefined;
    if (eventFileUuid !== undefined && eventFileUuid !== fileUuid) continue;
    if (raw.success === true) {
      success = true;
      break;
    }
    if (raw.success === false) {
      throw new Error(`Upload failed (step 3): server could not parse the file${typeof raw.error === "string" ? `: ${raw.error}` : ""}`);
    }
  }
  if (!success) throw new Error("Upload failed (step 3): subscribe stream ended without success");

  return { fileUuid, s3ObjectUrl: presign.s3ObjectUrl };
}
