import { afterEach, describe, expect, test, mock } from "../test-helpers.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthCredentials } from "../../src/auth/login.js";

const creds: AuthCredentials = { jwt: "test-jwt", cookies: ["session=test"], userAgent: "test-agent", email: null, source: "cookies" };
const originalFetch = globalThis.fetch;
let dir = "";
let upload: typeof import("../../src/search/upload.js").uploadAttachments;
let presign: ReturnType<typeof mock>;

describe("uploadAttachments", () => {
  afterEach(async () => {
    mock.restore();
    globalThis.fetch = originalFetch;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function setup(reply: (body: any) => unknown) {
    dir = await mkdtemp(join(tmpdir(), "pi-upload-"));
    await writeFile(join(dir, "a.txt"), "alpha");
    await writeFile(join(dir, "b.txt"), "beta");
    presign = mock(async (_url: string, headers: Record<string, string>, body: any) => reply(body));
    mock.module("../../src/search/client.js", () => ({ restPostJson: presign }));
    upload = (await import(`../../src/search/upload.js?t=${Date.now()}`)).uploadAttachments;
  }

  test("batches presign once, authenticates, uploads fields before file, returns input order", async () => {
    let payload: any;
    const resultById: Record<string, any> = {};
    await setup((body) => {
      payload = body;
      for (const id of Object.keys(body.files)) resultById[id] = { s3_bucket_url: "https://s3.example/upload", s3_object_url: `object-${Object.keys(resultById).length}`, fields: { key: "x", policy: "y" } };
      return { results: resultById };
    });
    const requests: RequestInit[] = [];
    globalThis.fetch = (async (_url: any, init?: RequestInit) => { requests.push(init!); return new Response(null, { status: 204 }); }) as any;
    const urls = await upload([{ path: join(dir, "a.txt") }, { path: join(dir, "b.txt") }], creds);
    expect(presign.mock.calls).toHaveLength(1);
    const [url, headers] = presign.mock.calls[0] as any[];
    expect(url).toContain("batch_create_upload_urls");
    expect(headers.Authorization).toBe("Bearer test-jwt");
    expect(headers.Cookie).toBe("session=test");
    expect(Object.values(payload.files).map((f: any) => f)).toEqual([
      { filename: "a.txt", content_type: "text/plain", source: "default", file_size: 5, force_image: false, skip_parsing: false },
      { filename: "b.txt", content_type: "text/plain", source: "default", file_size: 4, force_image: false, skip_parsing: false },
    ]);
    expect(urls).toEqual(["object-0", "object-1"]);
    expect(requests).toHaveLength(2);
    const form = requests[0].body as FormData;
    expect(Array.from(form.keys())).toEqual(["key", "policy", "file"]);
    expect(requests[0].headers).toBe(undefined);
  });

  for (const [name, item, message] of [
    ["item error", { error: "bad" }, "bad"], ["rate limit", { rate_limited: true }, "rate limited"],
  ] as const) test(`rejects ${name}`, async () => {
    await setup((body) => ({ results: Object.fromEntries(Object.keys(body.files).map((id) => [id, item])) }));
    await expect(upload([{ path: join(dir, "a.txt") }], creds)).rejects.toThrow(message);
  });

  test("rejects S3 non-2xx", async () => {
    await setup((body) => ({ results: Object.fromEntries(Object.keys(body.files).map((id) => [id, { s3_bucket_url: "https://s3.example", s3_object_url: "object", fields: {} }])) }));
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as any;
    await expect(upload([{ path: join(dir, "a.txt") }], creds)).rejects.toThrow("HTTP 500");
  });

  test("rejects unreadable and empty files", async () => {
    await setup(() => ({ results: {} }));
    await expect(upload([{ path: join(dir, "missing.txt") }], creds)).rejects.toThrow("Could not read attachment file");
    const empty = join(dir, "empty.txt"); await writeFile(empty, "");
    await expect(upload([{ path: empty }], creds)).rejects.toThrow("Attachment file is empty");
  });
});
