import { describe, expect, it } from "bun:test";
import {
  applyPatches,
  AskMerger,
  isTerminalEvent,
  parseAskEvent,
  readSseFrames,
  readSseJson,
  type AskEvent,
} from "../src/api/sse.js";
import { ASK1_SSE, ASK2_FOLLOWUP_SSE, ASK3_TRUNCATED_SSE, RESEARCH_SSE, SUBSCRIBE_SSE } from "./fixtures.js";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";

/** Live-captured 2026-09-23 image-mode ask (nanobanana2, signed S3 urls stubbed). */
const IMG_SSE: string = readFileSync(pathJoin(import.meta.dir, "img-sse-fixture.txt"), "utf8");

function streamOf(text: string, chunkSize = Infinity): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  if (chunkSize === Infinity) chunks.push(bytes);
  else for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.slice(i, i + chunkSize));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

/** Parse like `pplx ask` does: raw JSON → parseAskEvent (invalid snapshots dropped). */
async function askEvents(text: string, chunkSize?: number): Promise<AskEvent[]> {
  const raw = await collect(readSseJson(streamOf(text, chunkSize)));
  return raw.map(parseAskEvent).filter((ev): ev is AskEvent => ev !== null);
}

describe("readSseFrames", () => {
  it("splits the real CRLF stream into 6 frames ending at end_of_stream", async () => {
    const frames = await collect(readSseFrames(streamOf(ASK1_SSE)));
    expect(frames.length).toBe(6);
    expect(frames.slice(0, 5).every((f) => f.event === "message")).toBe(true);
    expect(frames[5].event).toBe("end_of_stream");
    expect(frames[5].data).toBe("{}");
  });

  it("tolerates LF-only line endings", async () => {
    const frames = await collect(readSseFrames(streamOf(ASK1_SSE.replaceAll("\r\n", "\n"))));
    expect(frames.length).toBe(6);
    expect(frames[5].event).toBe("end_of_stream");
  });

  it("handles byte splits mid-line (17-byte chunks)", async () => {
    const events = await askEvents(ASK1_SSE, 17);
    expect(events.length).toBe(5);
    expect(events[4].status).toBe("COMPLETED");
  });

  it("joins multi-line data fields", async () => {
    const sse = 'event: message\ndata: {"a":\ndata: 1}\n\n';
    const events = await collect(readSseJson(streamOf(sse)));
    expect(events).toEqual([{ a: 1 }]);
  });
});

describe("readSseJson termination", () => {
  it("yields the 5 message snapshots and stops at end_of_stream", async () => {
    const events = await askEvents(ASK1_SSE);
    expect(events.length).toBe(5);
    expect(events.map((e) => e.status)).toEqual(["PENDING", "PENDING", "PENDING", "PENDING", "COMPLETED"]);
  });

  it("never throws on a capture-truncated stream (unparseable tail is skipped)", async () => {
    const events = await askEvents(ASK3_TRUNCATED_SSE);
    expect(events.length).toBe(6); // 6 complete snapshots, 7th frame is truncated JSON
    expect(events.every((e) => e.status === "PENDING")).toBe(true);
  });

  it("returns immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(readSseJson(streamOf(ASK1_SSE), controller.signal));
    expect(events).toEqual([]);
  });
});

describe("isTerminalEvent", () => {
  it("is false for the PENDING final:true telemetry trap (contract §D)", async () => {
    const events = await askEvents(ASK1_SSE);
    expect(events[3].status).toBe("PENDING");
    expect(events[3].final).toBe(true);
    expect(isTerminalEvent(events[3])).toBe(false);
  });

  it("is true only for COMPLETED && final", async () => {
    const events = await askEvents(ASK1_SSE);
    expect(events[4].final_sse_message).toBe(true);
    expect(isTerminalEvent(events[4])).toBe(true);
    expect(isTerminalEvent(events[0])).toBe(false);
  });
});

describe("deep-research stream (RESEARCH_SSE, r-summary §3 event table)", () => {
  it("parses the 12 frames: 11 message events + end_of_stream", async () => {
    const frames = await collect(readSseFrames(streamOf(RESEARCH_SSE)));
    expect(frames.length).toBe(12);
    expect(frames.slice(0, 11).every((f) => f.event === "message")).toBe(true);
    expect(frames[11].event).toBe("end_of_stream");
    const events = await askEvents(RESEARCH_SSE);
    expect(events.length).toBe(11); // end_of_stream yields nothing
  });

  it("status lifecycle: PENDING × 10, COMPLETED only on the last message", async () => {
    const events = await askEvents(RESEARCH_SSE);
    expect(events.slice(0, 10).every((e) => e.status === "PENDING")).toBe(true);
    expect(events[10].status).toBe("COMPLETED");
  });

  it("event #9 (final:true, final_sse_message:false, still PENDING) is NOT terminal — the stream must run to #10", async () => {
    const events = await askEvents(RESEARCH_SSE);
    expect(events[9].final).toBe(true);
    expect(events[9].final_sse_message).toBe(false);
    expect(events[9].status).toBe("PENDING");
    expect(isTerminalEvent(events[9])).toBe(false);
    // terminal = last message: COMPLETED && final && final_sse_message
    expect(events[10].final).toBe(true);
    expect(events[10].final_sse_message).toBe(true);
    expect(isTerminalEvent(events[10])).toBe(true);
    // streamAsk's loop: count non-terminal events seen before the terminal one
    const before = events.filter((e, i) => i < 10 && isTerminalEvent(e));
    expect(before).toEqual([]); // nothing terminates early
  });

  it("merges the answer from ask_text_0_markdown blocks (the digit 4), via diff AND direct snapshots", async () => {
    const events = await askEvents(RESEARCH_SSE);
    const after9 = new AskMerger();
    for (const ev of events.slice(0, 10)) after9.merge(ev);
    expect(after9.answerText()).toBe("4"); // event #9 delivers chunks via diff_block
    const after10 = new AskMerger();
    for (const ev of events) after10.merge(ev);
    expect(after10.answerText()).toBe("4"); // event #10 direct markdown_block — no duplication
  });

  it("captures model pplx_alpha, thread slug, backend uuid, read_write_token", async () => {
    const merger = new AskMerger();
    for (const ev of await askEvents(RESEARCH_SSE)) merger.merge(ev);
    expect(merger.model).toBe("pplx_alpha");
    expect(merger.slug).toBe("00000047-0000-4000-8000-000000000000");
    expect(merger.lastBackendUuid).toBe("00000047-0000-4000-8000-000000000000");
    expect(merger.rwToken).toBe("00000041-0000-4000-8000-000000000000");
  });

  it("terminal text (workflow-steps JSON) never leaks as the answer — it backs the FINAL fallback", async () => {
    const events = await askEvents(RESEARCH_SSE);
    const terminal = events[10];
    expect(typeof terminal.text).toBe("string"); // steps JSON INITIAL_QUERY→LOAD_SKILL(research)→FINAL
    expect(terminal.text).toContain('"step_type": "FINAL"');
    // markdown blocks win over the steps JSON when present (priority §I: markdown → ask_text → steps)
    const merger = new AskMerger();
    merger.merge(terminal);
    expect(merger.answerText()).toBe("4");
  });

  it("fallback: skeleton markdown blocks → answer parsed from the terminal text steps JSON", () => {
    const finalAnswer = JSON.stringify({
      answer: "wrapped",
      chunks: ["wrapped"],
      web_results: [],
      structured_answer: [{ type: "markdown", text: "via structured_answer", chunks: ["via structured_answer"] }],
    });
    const steps = JSON.stringify([
      { step_type: "INITIAL_QUERY", content: { query: "q" } },
      { step_type: "LOAD_SKILL", content: { skill_names: ["research"] } },
      { step_type: "FINAL", content: { answer: finalAnswer } },
    ]);
    const merger = new AskMerger();
    merger.merge(
      parseAskEvent({
        status: "COMPLETED",
        final: true,
        final_sse_message: true,
        text: steps,
        blocks: [
          { intended_usage: "ask_text_0_markdown", markdown_block: { progress: "DONE" } }, // skeleton: no chunks/answer
          { intended_usage: "ask_text", markdown_block: { progress: "DONE" } },
        ],
      })!,
    );
    expect(merger.answerText()).toBe("via structured_answer");
  });

  it("fallback chain: ask_text block alone, then answer field, then FINAL.answer/chunks", () => {
    // ask_text only (no _0_markdown)
    const a = new AskMerger();
    a.merge(parseAskEvent({ blocks: [{ intended_usage: "ask_text", markdown_block: { chunks: ["ask_text answer"] } }] })!);
    expect(a.answerText()).toBe("ask_text answer");
    // no chunks → `answer` field
    const b = new AskMerger();
    b.merge(parseAskEvent({ blocks: [{ intended_usage: "ask_text_0_markdown", markdown_block: { answer: "field answer" } }] })!);
    expect(b.answerText()).toBe("field answer");
    // no markdown at all → FINAL.answer without structured_answer → its `answer` field
    const c = new AskMerger();
    c.merge(parseAskEvent({ text: JSON.stringify([{ step_type: "FINAL", content: { answer: JSON.stringify({ answer: "bare final" }) } }]) })!);
    expect(c.answerText()).toBe("bare final");
  });

  it("non-JSON terminal text stays raw (normal-search text is never mangled)", () => {
    const merger = new AskMerger();
    merger.merge(parseAskEvent({ status: "COMPLETED", final: true, text: "plain answer" })!);
    expect(merger.answerText()).toBe("plain answer");
  });
});

describe("AskMerger image-mode (live-captured nanobanana2 stream)", () => {
  async function merged(text: string): Promise<AskMerger> {
    const merger = new AskMerger();
    for (const ev of await askEvents(text)) merger.merge(ev);
    return merger;
  }

  it("extracts the generated image url, dims, filename, caption from the plan block", async () => {
    const merger = await merged(IMG_SSE);
    const images = merger.images();
    expect(images).toHaveLength(1);
    const img = images[0]!;
    expect(img.url).toMatch(/^https:\/\/user-gen-media-assets\.s3\.amazonaws\.com\/gemini_images\/00000049[^?]*\.png/);
    expect(img.filename).toBe("Small blue square icon"); // from download_info[].filename
    expect(img.caption).toBe("Small blue square icon"); // from GENERATE_IMAGE text step
    expect(img.width).toBe(1024);
    expect(img.height).toBe(1024);
    expect(img.thumbnailUrl).toMatch(/^https:\/\/user-gen-media-assets/);
  });

  it("answer text is the FINAL answer (Media generated: …), not the raw steps JSON", async () => {
    const merger = await merged(IMG_SSE);
    expect(merger.answerText()).toBe("Media generated: 'Small blue square icon'");
  });

  it("text asks carry no images (plan block absent)", async () => {
    const merger = await merged(ASK1_SSE);
    expect(merger.images()).toEqual([]);
  });
});

describe("AskMerger (real ask #1 stream)", () => {
  async function merged(text: string, upTo?: number): Promise<AskMerger> {
    const merger = new AskMerger();
    const events = await askEvents(text);
    for (const ev of (upTo === undefined ? events : events.slice(0, upTo))) merger.merge(ev);
    return merger;
  }

  it("captures read_write_token from the first event", async () => {
    expect((await merged(ASK1_SSE)).rwToken).toBe("00000068-0000-4000-8000-000000000000");
  });

  it("tracks backend_uuid (last event wins) and thread_url_slug", async () => {
    const merger = await merged(ASK1_SSE);
    expect(merger.lastBackendUuid).toBe("00000066-0000-4000-8000-000000000000");
    expect(merger.slug).toBe("00000066-0000-4000-8000-000000000000");
  });

  it("extracts the answer from workflow chunks without duplicating across snapshots", async () => {
    const afterDiff = await merged(ASK1_SSE, 4); // up to and including the PENDING final:true diff event
    expect(afterDiff.answerText()).toBe("OK");
    const afterCompleted = await merged(ASK1_SSE, 5);
    expect(afterCompleted.answerText()).toBe("OK"); // snapshot replace — no concatenation
    expect((await merged(ASK1_SSE)).answerText()).toBe("OK");
  });

  it("merges the diff_block patch to the same doc as the final COMPLETED block", async () => {
    const afterDiff = await merged(ASK1_SSE, 4);
    const afterCompleted = await merged(ASK1_SSE, 5);
    expect(afterDiff.workflow()).toEqual(afterCompleted.workflow()); // verified wire property
  });

  it("captures display_model and empty followups from the real stream", async () => {
    const merger = await merged(ASK1_SSE);
    expect(merger.model).toBe("gemini38flash");
    expect(merger.followups()).toEqual([]);
  });

  it("returns empty answer before any workflow block arrives", async () => {
    const merger = await merged(ASK1_SSE, 1);
    expect(merger.answerText()).toBe("");
  });

  it("follow-ups: same rules on the ask #2 stream (DONE answer, new backend uuid)", async () => {
    const merger = await merged(ASK2_FOLLOWUP_SSE);
    expect(merger.answerText()).toBe("DONE");
    expect(merger.lastBackendUuid).toBe("00000039-0000-4000-8000-000000000000");
    expect(merger.rwToken).toBe("00000068-0000-4000-8000-000000000000"); // constant per thread
  });

  it("reads non-empty followups from a followups block (synthetic supplement)", async () => {
    const merger = new AskMerger();
    merger.merge({
      blocks: [
        {
          intended_usage: "pending_followups",
          pending_followups_block: { followups: ["What next?", "Why?"] },
        },
      ],
    });
    expect(merger.followups()).toEqual(["What next?", "Why?"]);
  });
});

describe("applyPatches", () => {
  it("path \"\" replaces the whole document (the verified wire case)", () => {
    expect(applyPatches({ old: true }, [{ op: "replace", path: "", value: { new: 1 } }])).toEqual({ new: 1 });
  });

  it("ignores unresolvable paths", () => {
    const doc = { a: { b: 1 } };
    expect(applyPatches(doc, [{ op: "replace", path: "/x/y/z", value: 2 }])).toEqual({ a: { b: 1 } });
  });

  it("replaces, adds and removes nested members", () => {
    const doc = { a: { b: 1 }, list: [1, 2, 3] };
    const next = applyPatches(doc, [
      { op: "replace", path: "/a/b", value: 9 },
      { op: "add", path: "/a/c", value: "x" },
      { op: "remove", path: "/list/1" },
    ]) as Record<string, unknown>;
    expect(next.a).toEqual({ b: 9, c: "x" });
    expect(next.list).toEqual([1, 3]);
  });

  it("unescapes ~0/~1 tokens", () => {
    const next = applyPatches({}, [{ op: "add", path: "/a~1b~0c", value: 1 }]) as Record<string, unknown>;
    expect(next["a/b~c"]).toBe(1);
  });
});

describe("parseAskEvent (runtime validation — malformed snapshots must not crash)", () => {
  it("returns null for non-object payloads", () => {
    expect(parseAskEvent(null)).toBeNull();
    expect(parseAskEvent([1, 2])).toBeNull();
    expect(parseAskEvent("COMPLETED")).toBeNull();
    expect(parseAskEvent(5)).toBeNull();
  });

  it('survives {"blocks":{}} and {"blocks":[null]} — no crash, valid fields kept', () => {
    const a = parseAskEvent({ status: "PENDING", blocks: {} });
    expect(a?.status).toBe("PENDING"); // object-shaped blocks array is simply ignored
    expect(a?.blocks).toBeUndefined();
    const b = parseAskEvent({ blocks: [null, { intended_usage: "answer_tabs" }] });
    expect(b?.blocks).toEqual([{ intended_usage: "answer_tabs" }]);
  });

  it("drops malformed workflow arrays (null steps/items/payloads) while keeping valid items", () => {
    const ev = parseAskEvent({
      blocks: [
        {
          intended_usage: "workflow_root",
          workflow_block: {
            status: "WORKFLOW_COMPLETED",
            steps: [
              null,
              { title: "ok", items: [null, { type: "WORKFLOW_ITEM_TEXT", payload: null }] },
              { items: [{ payload: { text_payload: { chunks: ["OK", 7, null] } } }] },
              { items: "not-an-array" },
            ],
          },
        },
      ],
    });
    const merger = new AskMerger();
    merger.merge(ev!);
    expect(merger.answerText()).toBe("OK"); // valid chunk survived, garbage dropped
  });

  it("sanitizes diff patches (drops null patch objects, non-string op/path)", () => {
    const ev = parseAskEvent({
      blocks: [{ intended_usage: "workflow_root", diff_block: { field: "workflow_block", patches: [null, { op: "replace", path: "" }] } }],
    });
    expect(ev?.blocks?.[0]?.diff_block?.patches).toEqual([{ op: "replace", path: "" }]);
  });
});

describe("AskMerger direct-block replacement (snapshot semantics)", () => {
  it("a later direct snapshot REPLACES the doc for its usage — stale fields do not survive", () => {
    const merger = new AskMerger();
    merger.merge({
      // extra unknown field stands in for a stale snapshot field
      blocks: [{ intended_usage: "pending_followups", pending_followups_block: { followups: ["old question"] } }],
    });
    merger.merge({
      blocks: [{ intended_usage: "pending_followups", pending_followups_block: { followups: ["new question"] } }],
    });
    expect(merger.followups()).toEqual(["new question"]);
  });

  it("sources accumulate across web_results + sources_answer_mode blocks, deduped by url", () => {
    const merger = new AskMerger();
    merger.merge({
      blocks: [
        {
          intended_usage: "web_results",
          web_result_block: {
            web_results: [
              { name: "a", url: "https://a.example" },
              { name: "a dup", url: "https://a.example" },
            ],
          },
        },
      ],
    });
    merger.merge({
      blocks: [
        {
          intended_usage: "sources_answer_mode",
          sources_mode_block: { web_results: [{ name: "b", url: "https://b.example" }, { name: "a again", url: "https://a.example" }] },
        },
      ],
    });
    expect(merger.sources().map((s) => s.url)).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("applyPatches prototype-pollution guard", () => {
  it("rejects __proto__/prototype/constructor path segments and leaves Object.prototype clean", () => {
    const doc = { a: { b: 1 } };
    const next = applyPatches(doc, [
      { op: "add", path: "/__proto__/polluted", value: "x" },
      { op: "add", path: "/a/prototype/polluted", value: "x" },
      { op: "add", path: "/constructor/prototype/polluted", value: "x" },
    ]) as Record<string, unknown>;
    expect(next).toEqual({ a: { b: 1 } }); // patches ignored, nothing created
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // prototype NOT polluted
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("only patches own properties — a replace through the prototype chain is ignored", () => {
    const doc = {};
    const next = applyPatches(doc, [{ op: "replace", path: "/toString", value: "boom" }]) as Record<string, unknown>;
    expect(Object.hasOwn(next, "toString")).toBe(false);
    expect(next.toString).toBe(Object.prototype.toString);
  });
});

describe("subscribe stream (attachment processing)", () => {
  it("parses the real subscribe SSE and reports success", async () => {
    const events = await collect(
      readSseJson(streamOf(SUBSCRIBE_SSE)),
    );
    expect(events).toEqual([
      {
        file_uuid: "00000067-0000-4000-8000-000000000000",
        success: true,
        s3_url: "https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/12345678/00000067-0000-4000-8000-000000000000/test-upload.txt",
        final_sse_message: false,
      },
    ]);
  });
});
