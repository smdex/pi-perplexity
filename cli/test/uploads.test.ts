import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadFile } from "../src/api/uploads.js";
import { saveAuth, type StoredAuth } from "../src/config.js";
import { mockFetch } from "./fixtures.js";

/**
 * Upload flow (presign → S3 POST → subscribe SSE) over a mocked fetch, using
 * the wire shapes from research/network/c-summary.md / c-04/c-05. Includes the
 * exfil guard: a hostile presign response must never receive file bytes.
 */

const FILE_UUID = "00000067-0000-4000-8000-000000000000";
const BUCKET = "https://ppl-ai-file-upload.s3.amazonaws.com/";
const OBJECT_URL = `${BUCKET}web/direct-files/attachments/12345678/${FILE_UUID}/test-upload.txt`;
const PRESIGN_FIELDS: Record<string, string> = {
  acl: "private",
  "Content-Type": "text/plain",
  tagging:
    "<Tagging><TagSet><Tag><Key>Expiry</Key><Value>90</Value></Tag><Tag><Key>file_uuid</Key><Value>00000067-0000-4000-8000-000000000000</Value></Tag></TagSet></Tagging>",
  "x-amz-meta-is_text_only": "true",
  key: `web/direct-files/attachments/12345678/${FILE_UUID}/test-upload.txt`,
  AWSAccessKeyId: "FIXTURE-AWS-ACCESS-KEY",
  "x-amz-security-token": "FIXTURE-SESSION-TOKEN",
  policy: "FIXTURE-POLICY",
  signature: "FIXTURE-SIGNATURE",
};

let cfgDir: string;
let uploadDir: string;
let uploadPath: string;

beforeAll(async () => {
  cfgDir = await mkdtemp(join(tmpdir(), "pplx-upl-"));
  process.env.PPLX_CONFIG_DIR = cfgDir;
  const auth: StoredAuth = {
    kind: "cookies",
    cookies: ["__Secure-next-auth.session-token=tok"],
    accountUuid: "00000033-0000-4000-8000-000000000000",
    sessionExpires: null,
    email: null,
    bearerToken: null,
    source: "paste",
    createdAt: "2026-09-22T00:00:00.000Z",
  };
  await saveAuth(auth);

  uploadDir = await mkdtemp(join(tmpdir(), "pplx-upl-file-"));
  uploadPath = join(uploadDir, "test-upload.txt");
  await writeFile(uploadPath, "hello perplexity, this is an upload test\n", { encoding: "utf8" });
});

afterAll(async () => {
  delete process.env.PPLX_CONFIG_DIR;
  await rm(cfgDir, { recursive: true, force: true });
  await rm(uploadDir, { recursive: true, force: true });
});

interface UploadMockOpts {
  bucketUrl?: string;
  objectUrl?: string;
  presignBody?: unknown; // override the whole presign response
  s3Status?: number;
  subscribeSse?: string;
}

/** Mock the three upload endpoints (presign echoes back the request's client key). */
function uploadMock(opts: UploadMockOpts = {}) {
  return mockFetch((url, init) => {
    if (url.includes("/rest/uploads/batch_create_upload_urls")) {
      if (opts.presignBody !== undefined) return Response.json(opts.presignBody);
      const body = JSON.parse(String(init?.body)) as { files: Record<string, unknown> };
      const key = Object.keys(body.files)[0] ?? "";
      return Response.json({
        results: { [key]: { s3_bucket_url: opts.bucketUrl ?? BUCKET, s3_object_url: opts.objectUrl ?? OBJECT_URL, fields: PRESIGN_FIELDS } },
      });
    }
    if (url.startsWith(BUCKET)) return new Response(null, { status: opts.s3Status ?? 204 });
    if (url.includes("/rest/sse/attachment_processing/subscribe")) {
      return new Response(
        opts.subscribeSse ??
          `event: message\r\ndata: {"file_uuid": "${FILE_UUID}", "success": true, "s3_url": "${OBJECT_URL}", "final_sse_message": false}\r\n\r\nevent: end_of_stream\r\ndata: {}\r\n\r\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("uploadFile happy path", () => {
  it("presign → S3 POST → subscribe SSE; returns the file uuid + s3 url", async () => {
    const mocked = uploadMock();
    try {
      const result = await uploadFile(uploadPath);
      expect(result).toEqual({ fileUuid: FILE_UUID, s3ObjectUrl: OBJECT_URL });

      // presign carried version=2.18&source=default (captured WITH params)
      expect(mocked.calls[0].url).toBe("https://www.perplexity.ai/rest/uploads/batch_create_upload_urls?version=2.18&source=default");
      const presignBody = JSON.parse(String(mocked.calls[0].init?.body)) as {
        files: Record<string, { filename: string; content_type: string; file_size: number }>;
      };
      const entry = Object.values(presignBody.files)[0];
      expect(entry).toMatchObject({ filename: "test-upload.txt", content_type: "text/plain", file_size: 41 });

      // S3 POST: exact presigned origin, multipart form with every field + the file, no redirects
      const s3 = mocked.calls[1];
      expect(s3.url).toBe(BUCKET);
      expect(s3.init?.redirect).toBe("error");
      expect(s3.init?.method).toBe("POST");
      const form = s3.init?.body as FormData;
      expect(form.get("key")).toBe(PRESIGN_FIELDS.key);
      expect(form.get("policy")).toBe(PRESIGN_FIELDS.policy);
      expect((form.get("file") as File).name).toBe("test-upload.txt");

      // subscribe carried the extracted file_uuid
      expect(mocked.calls[2].url).toBe("https://www.perplexity.ai/rest/sse/attachment_processing/subscribe");
      expect(JSON.parse(String(mocked.calls[2].init?.body))).toEqual({ file_uuids: [FILE_UUID] });
    } finally {
      mocked.restore();
    }
  });
});

describe("uploadFile exfil guard (hostile presign responses)", () => {
  it("rejects an s3_bucket_url on another origin — and never fetches it", async () => {
    const mocked = uploadMock({ bucketUrl: "https://evil.example.com/upload" });
    try {
      await expect(uploadFile(uploadPath)).rejects.toThrow("must be https://ppl-ai-file-upload.s3.amazonaws.com");
      expect(mocked.calls.map((c) => c.url)).not.toContain("https://evil.example.com/upload");
    } finally {
      mocked.restore();
    }
  });

  it("rejects an s3_object_url on another origin", async () => {
    const mocked = uploadMock({ objectUrl: "http://ppl-ai-file-upload.s3.amazonaws.com.evil.io/x" });
    try {
      await expect(uploadFile(uploadPath)).rejects.toThrow("s3_object_url must be https://ppl-ai-file-upload.s3.amazonaws.com");
    } finally {
      mocked.restore();
    }
  });

  it("rejects a non-https presign url", async () => {
    const mocked = uploadMock({ bucketUrl: "http://ppl-ai-file-upload.s3.amazonaws.com/" });
    try {
      await expect(uploadFile(uploadPath)).rejects.toThrow("s3_bucket_url must be https://ppl-ai-file-upload.s3.amazonaws.com");
    } finally {
      mocked.restore();
    }
  });
});

describe("uploadFile failure modes", () => {
  it("throws step 1 when the presign response misses urls/fields", async () => {
    const mocked = uploadMock({ presignBody: { results: {} } });
    try {
      await expect(uploadFile(uploadPath)).rejects.toThrow("step 1");
    } finally {
      mocked.restore();
    }
  });

  it("throws step 2 on a non-2xx S3 response", async () => {
    const mocked = uploadMock({ s3Status: 403 });
    try {
      await expect(uploadFile(uploadPath)).rejects.toThrow("step 2, S3 POST");
    } finally {
      mocked.restore();
    }
  });

  it("throws step 3 when the server reports success:false", async () => {
    const mocked = uploadMock({
      subscribeSse: `event: message\r\ndata: {"file_uuid": "${FILE_UUID}", "success": false, "error": "corrupt pdf"}\r\n\r\nevent: end_of_stream\r\ndata: {}\r\n\r\n`,
    });
    try {
      await expect(uploadFile(uploadPath)).rejects.toThrow("corrupt pdf");
    } finally {
      mocked.restore();
    }
  });

  it("throws step 3 when the stream ends without success", async () => {
    const mocked = uploadMock({
      subscribeSse: `event: message\r\ndata: {"file_uuid": "${FILE_UUID}", "final_sse_message": false}\r\n\r\nevent: end_of_stream\r\ndata: {}\r\n\r\n`,
    });
    try {
      await expect(uploadFile(uploadPath)).rejects.toThrow("ended without success");
    } finally {
      mocked.restore();
    }
  });
});
