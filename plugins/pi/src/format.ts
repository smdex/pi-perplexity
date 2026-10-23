import type { AskResultJson } from "./pplx.js";
import { threadSlugFromRef } from "./pplx.js";

/**
 * LLM-facing formatting of a `pplx ask --json` result. Numbered citations,
 * images, follow-ups, and a Meta section whose Session ID line teaches the
 * model how to continue the conversation on the next tool call.
 */

const MAX_SNIPPET_CHARS = 240;

function truncateSnippet(snippet: string): string {
  const normalized = snippet.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SNIPPET_CHARS) return normalized;
  return `${normalized.slice(0, MAX_SNIPPET_CHARS - 1)}…`;
}

function relAge(timestamp: string | undefined, now: Date): string {
  if (!timestamp) return "unknown age";
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return "unknown age";
  const seconds = Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function singleLine(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** Slug of a thread url, or undefined when no thread url was returned. */
export function threadSlugFromUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const slug = threadSlugFromRef(url);
  return slug ? slug : undefined;
}

/** Number of sources actually rendered for a given total and requested limit. */
export function effectiveSourceCount(total: number, limit?: number): number {
  const sourceLimit =
    typeof limit === "number" && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : total;
  return Math.min(sourceLimit, total);
}

function sourceLines(result: AskResultJson, limit: number | undefined, now: Date): string {
  const sources = (result.sources ?? []).slice(0, effectiveSourceCount(result.sources?.length ?? 0, limit));
  if (sources.length === 0) return "0 sources\n(no sources returned)";
  const rendered = sources
    .map((source, index) => {
      const title = singleLine(source.name) || "Untitled source";
      const lines = [`[${index + 1}] ${title} (${relAge(source.timestamp, now)})`];
      const url = singleLine(source.url);
      if (url) lines.push(`    ${url}`);
      const snippet = truncateSnippet(source.snippet ?? "");
      if (snippet) lines.push(`    ${snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");
  return `${sources.length} sources\n${rendered}`;
}

function followupsSection(followups: string[] | undefined): string {
  if (!followups || followups.length === 0) return "";
  const items = followups.map((followup, i) => `${i + 1}. ${singleLine(followup)}`).join("\n");
  return `## Follow-ups\n${items}`;
}

function imagesSection(images: AskResultJson["images"]): string {
  if (!images || images.length === 0) return "";
  const lines = images.map((image, i) => {
    const label = image.caption
      ? `"${singleLine(image.caption)}"`
      : image.filename
        ? singleLine(image.filename)
        : `image ${i + 1}`;
    const dims = image.width && image.height ? `${image.width}x${image.height}` : "";
    const parts = [`[${i + 1}] ${label}${dims ? ` (${dims})` : ""}`, `    ${image.url}`];
    if (image.filename) parts.push(`    suggested filename: ${singleLine(image.filename)}`);
    parts.push("    note: url expires in ~35min (S3 presigned) — download or copy it now");
    return parts.join("\n");
  });
  return `## Images\n${lines.join("\n")}`;
}

/** Format an AskResultJson for the model: ## Answer / ## Sources / ## Images / ## Follow-ups / ## Meta. */
export function formatAskResult(result: AskResultJson, limit?: number, now: Date = new Date()): string {
  const sections: string[] = [`## Answer\n${result.answer.trim() || "No answer returned."}`];
  sections.push(`## Sources\n${sourceLines(result, limit, now)}`);

  const images = imagesSection(result.images);
  if (images) sections.push(images);
  const followups = followupsSection(result.followups);
  if (followups) sections.push(followups);

  const meta = ["## Meta", "Provider: perplexity (pplx CLI)", `Model: ${result.model ?? "unknown"}`];
  const slug = threadSlugFromUrl(result.threadUrl);
  if (slug) {
    meta.push(
      `Session ID: ${slug} — pass thread="${slug}" (or continue=true for the latest session) on the next perplexity_search call to continue this conversation`,
    );
  }
  sections.push(meta.join("\n"));

  return sections.join("\n\n");
}
