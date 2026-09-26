import { describe, expect, it } from "bun:test";
import { AskMerger, parseAskEvent, readSseJson } from "../src/api/sse.js";
import { relTime, renderAnswer, renderSources, renderSpaceTable, renderThreadDetail, renderThreadTable, singleLine, spaceEmoji, truncate } from "../src/render/markdown.js";
import type { AskResult } from "../src/api/ask.js";
import type { ThreadNode } from "../src/api/graphql.js";
import { ASK3_TRUNCATED_SSE } from "./fixtures.js";

/** Merge a raw SSE string the way `pplx ask` does — fixture blocks from c-trace. */
async function mergeStream(raw: string): Promise<AskMerger> {
  const merger = new AskMerger();
  for await (const parsed of readSseJson(new Blob([raw]).stream())) {
    const ev = parseAskEvent(parsed);
    if (ev) merger.merge(ev);
  }
  return merger;
}

const NOW = new Date("2026-09-21T23:50:00Z");

describe("relTime", () => {
  it("buckets: just now / minutes / hours / days / months / years", () => {
    expect(relTime("2026-09-21T23:49:40Z", NOW)).toBe("just now");
    expect(relTime("2026-09-21T23:47:00Z", NOW)).toBe("3m ago");
    expect(relTime("2026-09-21T20:50:00Z", NOW)).toBe("3h ago");
    expect(relTime("2026-09-19T23:50:00Z", NOW)).toBe("2d ago");
    expect(relTime("2026-04-01T00:00:00Z", NOW)).toBe("5mo ago");
    expect(relTime("2025-09-21T23:50:00Z", NOW)).toBe("1y ago");
  });
  it("null → unknown; invalid → raw input", () => {
    expect(relTime(null)).toBe("unknown");
    expect(relTime(undefined)).toBe("unknown");
    expect(relTime("not-a-date")).toBe("not-a-date");
  });
});

describe("truncate / singleLine", () => {
  it("keeps short strings, cuts long ones with ellipsis", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a".repeat(50), 10)).toHaveLength(10);
    expect(truncate("a".repeat(50), 10).endsWith("…")).toBe(true);
  });
  it("singleLine collapses newlines and tabs", () => {
    expect(singleLine("how much\ndoes\tthis  cost?")).toBe("how much does this cost?");
    expect(singleLine(null)).toBe("");
  });
});

describe("renderThreadTable", () => {
  const base: ThreadNode = {
    id: "TH:x",
    contextUuid: "ctx-1",
    entryId: "00000045-0000",
    readWriteToken: "tok",
    slug: "00000045-0000",
    title: "how much this costs in germany?\n- frame: frame-alpha",
    status: "COMPLETED",
    answerPreview: "Here's the German-market price breakdown…",
    updatedAt: "2026-09-21T21:32:44Z",
    displayModel: "glm_5_3_thinking",
    spaceUuid: null,
  };

  it("renders header + one single-line row per thread with all columns", () => {
    const text = renderThreadTable([base]);
    const lines = text.split("\n");
    expect(lines[0].startsWith("UPDATED")).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("glm_5_3_thinking");
    expect(lines[1]).toContain("how much this costs in germany? - frame"); // newline collapsed, truncated
    expect(lines[1]).toContain("00000045-0000");
    expect(lines[1]).toMatch(/\d+[hdm] ago/); // relative to real clock
  });

  it("tolerates null fields (dashes, untitled)", () => {
    const bare: ThreadNode = {
      id: null, contextUuid: null, entryId: null, readWriteToken: null, slug: null,
      title: null, status: null, answerPreview: null, updatedAt: null, displayModel: null, spaceUuid: null,
    };
    const lines = renderThreadTable([bare]).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("—");
    expect(lines[1]).toContain("(untitled)");
    expect(lines[1]).toContain("unknown");
  });
});

describe("renderSpaceTable / spaceEmoji", () => {
  it("decodes hex emoji codepoints and renders uuid column", () => {
    const text = renderSpaceTable([
      { uuid: "00000053-0000", title: "Budgets", emoji: "1f4b3" },
      { uuid: "00000064-0000", title: "Translator", emoji: null },
    ]);
    const lines = text.split("\n");
    expect(lines[0]).toContain("TITLE");
    expect(lines[0]).toContain("UUID");
    expect(lines[1]).toContain("💳"); // U+1F4B3 credit card
    expect(lines[1]).toContain("Budgets");
    expect(lines[1]).toContain("00000053-0000");
    expect(lines[2]).toContain("Translator");
  });
  it("passes literal emoji through", () => {
    expect(spaceEmoji("🔥")).toBe("🔥");
    expect(spaceEmoji(null)).toBe("  ");
  });
});

describe("renderSources — citations from fixture blocks (ASK3 attachment stream)", () => {
  it("extracts web_results from merged blocks and renders numbered citations", async () => {
    const merger = await mergeStream(ASK3_TRUNCATED_SSE);
    const sources = merger.sources();
    expect(sources.length).toBeGreaterThanOrEqual(1);
    const first = sources[0];
    expect(first.url).toContain("test-upload.txt");
    expect(first.name).toBe("test-upload.txt");

    const text = renderSources(sources);
    expect(text).toMatch(/^\[1\] test-upload\.txt \(unknown age\)$/m);
    expect(text).toContain("https://ppl-ai-file-upload.s3.amazonaws.com/");
  });

  it("renders empty string for no sources", () => {
    expect(renderSources([])).toBe("");
  });
});

describe("renderAnswer", () => {
  const result: AskResult = {
    answer: "OK",
    readWriteToken: "tok",
    backendUuid: "e2e23ed7-f797-4af0",
    threadUrl: "https://www.perplexity.ai/search/e2e23ed7-f797-4af0",
    followups: ["What about shipping?", "EU shops?"],
    model: "gemini38flash",
    sources: [{ name: "Docs", url: "https://example.com", snippet: "snip" }],
    images: [],
  };

  it("renders Answer, Sources, Follow-ups, Meta sections", () => {
    const text = renderAnswer(result);
    expect(text).toContain("## Answer\nOK");
    expect(text).toContain("[1] Docs");
    expect(text).toContain("## Follow-ups\n1. What about shipping?\n2. EU shops?");
    expect(text).toContain("## Meta\nModel: gemini38flash");
    expect(text).toContain("Thread: https://www.perplexity.ai/search/e2e23ed7-f797-4af0");
  });

  it("omits empty sections (no sources, no followups)", () => {
    const text = renderAnswer({
      ...result,
      sources: [],
      followups: [],
      threadUrl: null,
    });
    expect(text).not.toContain("## Sources");
    expect(text).not.toContain("## Follow-ups");
    expect(text).not.toContain("Thread:");
    expect(text).toContain("Model: gemini38flash");
  });

  it("answer:false omits the Answer section (streaming already wrote the text)", () => {
    const text = renderAnswer(result, { followups: true, answer: false });
    expect(text).not.toContain("## Answer");
    expect(text).not.toContain("\nOK"); // answer text nowhere in the trailing block
    expect(text).toContain("[1] Docs");
    expect(text).toContain("## Follow-ups");
    expect(text).toContain("## Meta");
  });

  it("renders generated images with caption, dims, filename, and expiry note", () => {
    const text = renderAnswer({
      ...result,
      answer: "Media generated: 'Small blue square icon'",
      images: [
        {
          url: "https://user-gen-media-assets.s3.amazonaws.com/gemini_images/abc.png?X-Amz-Signature=FIXTURESIGV4AAAA000000000000",
          caption: "Small blue square icon",
          filename: "blue_icon.png",
          width: 1024,
          height: 1024,
        },
      ],
    });
    expect(text).toContain("## Images");
    expect(text).toContain('[1] "Small blue square icon" (1024x1024)');
    expect(text).toContain("https://user-gen-media-assets.s3.amazonaws.com/gemini_images/abc.png");
    expect(text).toContain("suggested filename: blue_icon.png");
    expect(text).toContain("expires in ~35min");
    // images absent → section absent
    expect(renderAnswer(result)).not.toContain("## Images");
  });
});

describe("renderThreadDetail — `chats show` markdown", () => {
  const node: ThreadNode = {
    id: "TH:x",
    contextUuid: "00000052-0000",
    entryId: "00000045-0000",
    readWriteToken: "ff8b8b66",
    slug: "00000045-0000",
    title: "how much this costs in germany?",
    status: "COMPLETED",
    answerPreview: "Here's the German-market price breakdown…",
    updatedAt: "2026-09-21T21:32:44Z",
    displayModel: "glm_5_3_thinking",
    spaceUuid: null,
  };

  it("remote thread: question + preview answer + note + url", () => {
    const text = renderThreadDetail(node);
    expect(text).toContain("# how much this costs in germany?");
    expect(text).toContain("Model: glm_5_3_thinking");
    expect(text).toContain("https://www.perplexity.ai/search/00000045-0000");
    expect(text).toContain("## Question\nhow much this costs in germany?");
    expect(text).toContain("Here's the German-market price breakdown…");
    expect(text).toContain("*(preview only — no full-answer endpoint was captured)*");
    expect(text).not.toContain("## Sources");
  });

  it("locally recorded thread: full answer + citations + follow-ups, no preview note", () => {
    const text = renderThreadDetail(node, {
      query: "how much this costs in germany?",
      answer: "Roughly €230–260.",
      followups: ["Cheaper alternatives?"],
      sources: [{ name: "Shop", url: "https://shop.example", snippet: "prices" }],
    });
    expect(text).toContain("## Answer\nRoughly €230–260.");
    expect(text).not.toContain("preview only");
    expect(text).toContain("[1] Shop");
    expect(text).toContain("## Follow-ups\n1. Cheaper alternatives?");
  });
});
