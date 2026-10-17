import { ORIGIN } from "../constants.js";
import type { AskResult } from "../api/ask.js";
import type { GeneratedImage, WebResultRef } from "../api/sse.js";
import type { ThreadNode } from "../api/graphql.js";

/**
 * Plain-text markdown renderers (no ANSI — stdout may be piped). The source
 * formatting mirrors the pi extension's src/search/format.ts: numbered
 * citations with relative age, url, and a truncated snippet.
 */

export function relTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (iso === null || iso === undefined) return "unknown";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const diffSeconds = Math.floor((now.getTime() - parsed) / 1000);
  if (diffSeconds < 60) return "just now";
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Truncate to max chars, appending "…" when cut. Whole-string safe (no mid-newline concerns after singleLine). */
export function truncate(s: string, max: number): string {
  const normalized = s.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

/** Collapse newlines/tabs so table cells and previews stay one line. */
export function singleLine(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** UPDATED | MODEL | TITLE | UUID — thread list table (no color). */
export function renderThreadTable(threads: ThreadNode[]): string {
  const header = `${pad("UPDATED", 10)}  ${pad("MODEL", 16)}  ${pad("TITLE", 42)}  UUID`;
  const lines = threads.map((t) => {
    const updated = relTime(t.updatedAt);
    const model = singleLine(t.displayModel) || "—";
    const title = truncate(singleLine(t.title) || "(untitled)", 40);
    return `${pad(updated, 10)}  ${pad(model, 16)}  ${pad(title, 42)}  ${t.entryId ?? t.slug ?? t.id ?? ""}`;
  });
  return [header, ...lines].join("\n");
}

/** Render a space emoji given either a hex codepoint ("1f30e") or a literal character. */
export function spaceEmoji(emoji: string | null | undefined): string {
  if (!emoji) return "  ";
  if (/^[0-9a-f]{1,6}$/i.test(emoji)) {
    const code = Number.parseInt(emoji, 16);
    if (code > 0 && code <= 0x10ffff) {
      try {
        return String.fromCodePoint(code);
      } catch {
        return "  ";
      }
    }
  }
  return emoji;
}

/** EMOJI | TITLE | UUID — space list table. Accepts {uuid,title,emoji} shapes (SpaceItem included). */
export function renderSpaceTable(spaces: { uuid: string; title: string; emoji: string | null }[]): string {
  const header = `${pad("", 2)}  ${pad("TITLE", 42)}  UUID`;
  const lines = spaces.map((s) => `${pad(spaceEmoji(s.emoji), 2)}  ${pad(truncate(s.title, 40), 42)}  ${s.uuid}`);
  return [header, ...lines].join("\n");
}

/** Numbered citations in the extension format.ts style: [n] Title (age) / url / snippet. */
export function renderSources(sources: WebResultRef[]): string {
  if (sources.length === 0) return "";
  return sources
    .map((source, index) => {
      const title = singleLine(source.name) || "Untitled source";
      const lines = [`[${index + 1}] ${title} (${source.timestamp ? relTime(source.timestamp) : "unknown age"})`];
      const url = singleLine(source.url);
      if (url) lines.push(`    ${url}`);
      const snippet = truncate(source.snippet ?? "", 240);
      if (snippet) lines.push(`    ${snippet}`);
      return lines.join("\n");
    })
    .join("\n");
}

function followupsBlock(followups: string[]): string {
  if (followups.length === 0) return "";
  const items = followups.map((f, i) => `${i + 1}. ${singleLine(f)}`).join("\n");
  return `## Follow-ups\n${items}`;
}

/** Generated images from image-mode asks. URLs are S3-presigned and short-lived
 *  (~35min) — printed first-class with caption, dims, filename, and the deadline. */
export function renderImages(images: GeneratedImage[]): string {
  if (images.length === 0) return "";
  const lines = images.map((img, i) => {
    const label = img.caption ? `"${singleLine(img.caption)}"` : img.filename ? singleLine(img.filename) : `image ${i + 1}`;
    const dims = img.width && img.height ? `${img.width}x${img.height}` : "";
    const parts = [`[${i + 1}] ${label}${dims ? ` (${dims})` : ""}`];
    parts.push(`    ${img.url}`);
    if (img.filename) parts.push(`    suggested filename: ${img.filename}`);
    parts.push(`    note: url expires in ~35min (S3 presigned) — download or copy it now`);
    return parts.join("\n");
  });
  return `## Images\n${lines.join("\n")}`;
}

/** `pplx ask` output: ## Answer (+ ## Sources, ## Follow-ups) + ## Meta. `answer: false` omits the Answer section (streaming mode already wrote the text). */
export function renderAnswer(result: AskResult, opts?: { followups?: boolean; answer?: boolean }): string {
  const sections: string[] = [];
  if (opts?.answer !== false) {
    sections.push(`## Answer\n${result.answer.trim() || "No answer returned."}`);
  }
  const sources = renderSources(result.sources);
  if (sources) sections.push(`## Sources\n${sources}`);
  const images = renderImages(result.images);
  if (images) sections.push(images);
  if (opts?.followups !== false) {
    const block = followupsBlock(result.followups);
    if (block) sections.push(block);
  }
  const meta = ["## Meta", `Model: ${result.model ?? "unknown"}`];
  if (result.threadUrl) meta.push(`Thread: ${result.threadUrl}`);
  sections.push(meta.join("\n"));
  return sections.join("\n\n");
}

/** Extra locally-recorded data for `chats show` (from a previous `pplx ask`). */
export interface ThreadDetailExtras {
  query?: string;
  answer?: string;
  followups?: string[];
  sources?: WebResultRef[];
  /** Answer shown is only the server-side preview (no full-answer endpoint exists). */
  answerIsPreview?: boolean;
}

/** `pplx chats show` — full thread markdown: question + answer + citations + meta. */
export function renderThreadDetail(node: ThreadNode, extras?: ThreadDetailExtras): string {
  const head: string[] = [`# ${singleLine(node.title) || "(untitled thread)"}`];
  const metaBits = [
    `Updated: ${relTime(node.updatedAt)}`,
    node.displayModel ? `Model: ${node.displayModel}` : null,
    node.status ? `Status: ${node.status}` : null,
  ].filter((x): x is string => x !== null);
  head.push(metaBits.join(" · "));
  const slug = node.entryId ?? node.slug;
  if (slug) head.push(`${ORIGIN}/search/${slug}`);

  const question = extras?.query ?? node.title ?? "";
  const sections: string[] = [head.join("\n")];
  sections.push(`## Question\n${singleLine(question) || "(unknown question)"}`);

  const isPreview = extras?.answerIsPreview === true || !extras?.answer;
  let answer = extras?.answer ?? node.answerPreview ?? "";
  const previewNote = isPreview ? "\n\n*(preview only — no full-answer endpoint was captured)*" : "";
  if (!answer) answer = "(no answer preview available)";
  sections.push(`## Answer\n${answer.trim()}${previewNote}`);

  const sources = renderSources(extras?.sources ?? []);
  if (sources) sections.push(`## Sources\n${sources}`);
  const block = followupsBlock(extras?.followups ?? []);
  if (block) sections.push(block);
  return sections.join("\n\n");
}
