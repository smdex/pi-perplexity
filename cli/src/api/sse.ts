/**
 * SSE parsing + ask-snapshot merging for Perplexity's non-standard stream
 * (contract §D / c-summary): `event: message` + one-line JSON snapshots, CRLF
 * line endings, terminated by `event: end_of_stream` with `data: {}` — there is
 * NO `[DONE]` marker. The same parser serves the attachment `subscribe` stream.
 */

export interface SseFrame {
  event: string | null;
  data: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Buffer-decode the stream, split on `\n` (strip trailing `\r`), and flush a
 * frame at every blank line (plus any tail at EOF). `data:` lines accumulate —
 * multi-line data is tolerated; other fields are ignored except `event:`.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal | undefined,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let event: string | null = null;
  let dataLines: string[] = [];

  const flush = (): SseFrame | null => {
    if (dataLines.length === 0 && event === null) return null;
    const frame: SseFrame = { event, data: dataLines.join("\n") };
    event = null;
    dataLines = [];
    return frame;
  };

  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const raw = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line === "") {
          const frame = flush();
          if (frame) yield frame;
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        // other SSE fields (id:, retry:, comments) are ignored
      }
    }
    buffered += decoder.decode();
    // tail without a terminating blank line
    for (const line of buffered.split("\n")) {
      const stripped = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (stripped === "") continue;
      if (stripped.startsWith("event:")) event = event ?? stripped.slice(6).trim();
      else if (stripped.startsWith("data:")) dataLines.push(stripped.slice(5).replace(/^ /, ""));
    }
    const frame = flush();
    if (frame) yield frame;
  } finally {
    // Early return (terminal event / abort) — release the underlying stream.
    await reader.cancel().catch(() => {});
  }
}

/**
 * Yields parsed JSON (as `unknown` — callers MUST validate via parseAskEvent or
 * their own narrowing) for frames whose event is null or "message"; skips frames
 * with unparseable data. Returns after the `end_of_stream` frame (which itself
 * yields nothing). Abort signal → return immediately.
 */
export async function* readSseJson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal | undefined,
): AsyncGenerator<unknown> {
  for await (const frame of readSseFrames(body, signal)) {
    if (signal?.aborted) return;
    if (frame.event === "end_of_stream") return;
    if (frame.event !== null && frame.event !== "message") continue;
    if (frame.data.length === 0) continue;
    try {
      yield JSON.parse(frame.data);
    } catch {
      // tolerate partial/corrupt snapshots (capture-truncated streams hit this)
    }
  }
}

// ---- ask snapshot types (all loose: the API is reverse-engineered and unstable) ----

export interface JsonPatch {
  op?: string;
  path?: string;
  value?: unknown;
}

/** A JSON document a patch stream can target: object, or array via numeric-pointer paths. */
export type PatchableDoc = Record<string, unknown> | unknown[];

export interface TextPayload {
  text?: string;
  chunks?: string[];
  variant?: string;
  is_streaming?: boolean;
}

/** A generated image from an image-mode ask (plan block GENERATE_IMAGE_RESULTS). */
export interface GeneratedImage {
  url: string; // S3 presigned (short-lived!); download soon or lose it
  thumbnailUrl?: string;
  filename?: string; // from download_info[].filename (GENERATE_IMAGE file_name)
  caption?: string; // from the GENERATE_IMAGE text step (goal_id-matched)
  width?: number;
  height?: number;
}

/** Citation/web-result reference extracted from web_results / sources_answer_mode blocks. */
export interface WebResultRef {
  name?: string;
  url?: string;
  snippet?: string;
  timestamp?: string;
}

export interface WorkflowItem {
  id?: string;
  type?: string;
  payload?: { text_payload?: TextPayload };
}

export interface WorkflowStep {
  id?: string;
  status?: string;
  title?: string;
  items?: WorkflowItem[];
}

export interface WorkflowBlock {
  version?: string;
  status?: string;
  headline?: string;
  steps?: WorkflowStep[];
}

export interface MarkdownBlock {
  progress?: string;
  chunks?: string[];
  chunk_starting_offset?: number;
  answer?: string;
}

export interface AskBlock {
  intended_usage?: string;
  markdown_block?: MarkdownBlock;
  workflow_block?: WorkflowBlock;
  /** Image-mode plan (pro_search_steps / plan): assets with generated images. Readers isRecord-guard. */
  plan_block?: Record<string, unknown>;
  answer_tabs_block?: { modes?: { answer_mode_type?: string; has_preview?: boolean }[]; reformulated_queries?: string[] };
  pending_followups_block?: { followups?: string[] };
  diff_block?: { field?: string; patches?: JsonPatch[] };
  web_result_block?: { web_results?: WebResultRef[] };
  sources_mode_block?: { web_results?: WebResultRef[] };
}

export interface AskEvent {
  backend_uuid?: string;
  context_uuid?: string;
  frontend_uuid?: string;
  read_write_token?: string;
  thread_url_slug?: string;
  display_model?: string;
  status?: string;
  final?: boolean;
  final_sse_message?: boolean;
  text?: string;
  markdown_block?: unknown;
  ask_text?: unknown;
  blocks?: AskBlock[];
}

// ---- runtime validation (the SSE payload is attacker-shaped: never trust the cast) ----

function optString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function sanitizedTextPayload(raw: unknown): TextPayload | undefined {
  if (!isRecord(raw)) return undefined;
  const out: TextPayload = {};
  const text = optString(raw.text);
  if (text !== undefined) out.text = text;
  if (Array.isArray(raw.chunks)) out.chunks = raw.chunks.filter((c): c is string => typeof c === "string");
  const variant = optString(raw.variant);
  if (variant !== undefined) out.variant = variant;
  const streaming = optBoolean(raw.is_streaming);
  if (streaming !== undefined) out.is_streaming = streaming;
  return out;
}

function sanitizedItems(rawItems: unknown): WorkflowItem[] | undefined {
  if (!Array.isArray(rawItems)) return undefined;
  const items: WorkflowItem[] = [];
  for (const raw of rawItems) {
    if (!isRecord(raw)) continue;
    const item: WorkflowItem = {};
    const id = optString(raw.id);
    if (id !== undefined) item.id = id;
    const type = optString(raw.type);
    if (type !== undefined) item.type = type;
    if (isRecord(raw.payload)) {
      const payload = sanitizedTextPayload(raw.payload.text_payload);
      if (payload !== undefined) item.payload = { text_payload: payload };
    }
    items.push(item);
  }
  return items;
}

function sanitizedWorkflowBlock(raw: unknown): WorkflowBlock | undefined {
  if (!isRecord(raw)) return undefined;
  const block: WorkflowBlock = {};
  const version = optString(raw.version);
  if (version !== undefined) block.version = version;
  const status = optString(raw.status);
  if (status !== undefined) block.status = status;
  const headline = optString(raw.headline);
  if (headline !== undefined) block.headline = headline;
  if (Array.isArray(raw.steps)) {
    const steps: WorkflowStep[] = [];
    for (const rawStep of raw.steps) {
      if (!isRecord(rawStep)) continue;
      const step: WorkflowStep = {};
      const id = optString(rawStep.id);
      if (id !== undefined) step.id = id;
      const stepStatus = optString(rawStep.status);
      if (stepStatus !== undefined) step.status = stepStatus;
      const title = optString(rawStep.title);
      if (title !== undefined) step.title = title;
      const items = sanitizedItems(rawStep.items);
      if (items !== undefined) step.items = items;
      steps.push(step);
    }
    block.steps = steps;
  }
  return block;
}

function sanitizedBlock(raw: unknown): AskBlock | null {
  if (!isRecord(raw)) return null;
  const block: AskBlock = {};
  const usage = optString(raw.intended_usage);
  if (usage !== undefined) block.intended_usage = usage;
  const workflow = sanitizedWorkflowBlock(raw.workflow_block);
  if (workflow !== undefined) block.workflow_block = workflow;
  // markdown_block is isRecord-guarded by every reader (chunks/answer)
  if (isRecord(raw.markdown_block)) block.markdown_block = raw.markdown_block as MarkdownBlock;
  // plan_block (image-mode assets) — readers isRecord-guard everything they touch
  if (isRecord(raw.plan_block)) block.plan_block = raw.plan_block;
  // readers (followups/sources) isRecord-guard these themselves; pass through as records
  if (isRecord(raw.answer_tabs_block)) block.answer_tabs_block = raw.answer_tabs_block as NonNullable<AskBlock["answer_tabs_block"]>;
  if (isRecord(raw.pending_followups_block)) block.pending_followups_block = raw.pending_followups_block as NonNullable<AskBlock["pending_followups_block"]>;
  if (isRecord(raw.web_result_block)) block.web_result_block = raw.web_result_block as NonNullable<AskBlock["web_result_block"]>;
  if (isRecord(raw.sources_mode_block)) block.sources_mode_block = raw.sources_mode_block as NonNullable<AskBlock["sources_mode_block"]>;
  if (isRecord(raw.diff_block)) {
    const diff: NonNullable<AskBlock["diff_block"]> = {};
    const field = optString(raw.diff_block.field);
    if (field !== undefined) diff.field = field;
    if (Array.isArray(raw.diff_block.patches)) {
      const patches: JsonPatch[] = [];
      for (const rawPatch of raw.diff_block.patches) {
        if (!isRecord(rawPatch)) continue;
        const patch: JsonPatch = {};
        const op = optString(rawPatch.op);
        if (op !== undefined) patch.op = op;
        const path = optString(rawPatch.path);
        if (path !== undefined) patch.path = path;
        if ("value" in rawPatch) patch.value = rawPatch.value;
        patches.push(patch);
      }
      diff.patches = patches;
    }
    block.diff_block = diff;
  }
  return block;
}

/**
 * Validate + sanitize one raw SSE snapshot into an AskEvent, or null when the
 * payload is not an object (null, array, scalar…). Malformed blocks/arrays are
 * dropped — the API is unstable, so a bad snapshot is skipped rather than trusted.
 */
export function parseAskEvent(raw: unknown): AskEvent | null {
  if (!isRecord(raw)) return null;
  const ev: AskEvent = {};
  for (const key of ["backend_uuid", "context_uuid", "frontend_uuid", "read_write_token", "thread_url_slug", "display_model", "status"] as const) {
    const value = optString(raw[key]);
    if (value !== undefined) ev[key] = value;
  }
  const final = optBoolean(raw.final);
  if (final !== undefined) ev.final = final;
  const finalSse = optBoolean(raw.final_sse_message);
  if (finalSse !== undefined) ev.final_sse_message = finalSse;
  for (const key of ["text", "markdown_block", "ask_text"] as const) {
    const value = optString(raw[key]);
    if (value !== undefined) ev[key] = value;
  }
  if (Array.isArray(raw.blocks)) {
    const blocks: AskBlock[] = [];
    for (const rawBlock of raw.blocks) {
      const block = sanitizedBlock(rawBlock);
      if (block !== null) blocks.push(block);
    }
    ev.blocks = blocks;
  }
  return ev;
}

/**
 * Terminal ONLY on status COMPLETED && final (or final_sse_message — the
 * reliable terminal marker, r-summary §3). `final:true` alone appears one
 * event EARLY while still status PENDING (event #9 trap) — never stop there.
 */
export function isTerminalEvent(ev: AskEvent): boolean {
  return ev.status === "COMPLETED" && (ev.final === true || ev.final_sse_message === true);
}

function unescapeToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Path segments that must never be followed/assigned — they reach Object.prototype. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** Resolve a "/"-separated JSON pointer (~0 ~1 unescape) to the parent container + last key. */
function resolvePointer(
  doc: unknown,
  segments: string[],
  allowCreate: boolean,
): { parent: Record<string, unknown> | unknown[]; key: string | number } | null {
  let current: unknown = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i] ?? "";
    if (FORBIDDEN_SEGMENTS.has(seg)) return null; // prototype-pollution guard
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return null;
      current = current[idx];
    } else if (isRecord(current)) {
      const next = Object.hasOwn(current, seg) ? current[seg] : undefined;
      if (next === undefined) return null;
      current = next;
    } else {
      return null;
    }
  }
  const last = segments[segments.length - 1] ?? "";
  if (FORBIDDEN_SEGMENTS.has(last)) return null;
  if (Array.isArray(current)) {
    const idx = Number(last);
    if (!Number.isInteger(idx) || idx < 0) return null;
    return { parent: current, key: idx };
  }
  if (isRecord(current)) {
    // Only own properties are patchable — never read/write through the prototype
    // chain. "add" may still CREATE a new own property.
    if (!Object.hasOwn(current, last) && !(allowCreate && last.length > 0)) return null;
    return { parent: current, key: last };
  }
  return null;
}

/**
 * RFC-6902-shaped, tolerant: op replace/add with path "" → whole-document
 * replace (the only verified case — the PENDING-final diff patch). Deeper
 * paths resolve over plain objects/arrays; unknown paths ignore the patch.
 * op remove → delete when resolvable.
 */
export function applyPatches(target: unknown, patches: JsonPatch[]): PatchableDoc {
  let doc = target as PatchableDoc; // boundary cast: readers isRecord/isArray-guard everything they touch
  for (const patch of patches) {
    const op = patch.op ?? "replace";
    const rawPath = patch.path ?? "";
    if (rawPath === "" || rawPath === "/") {
      if (op === "remove") continue; // removing the whole doc is meaningless here
      doc = patch.value as PatchableDoc;
      continue;
    }
    const segments = rawPath.split("/").slice(1).map(unescapeToken); // absolute pointer: drop the leading ""
    const resolved = resolvePointer(doc, segments, op === "add");
    if (!resolved) continue; // tolerate unknown paths (and reject __proto__/prototype/constructor)
    const { parent, key } = resolved;
    if (Array.isArray(parent)) {
      const idx = key as number;
      if (op === "remove") parent.splice(idx, 1);
      else if (op === "add") parent.splice(idx, 0, patch.value);
      else parent[idx] = patch.value;
    } else {
      if (op === "remove") delete parent[key as string];
      else parent[key as string] = patch.value;
    }
  }
  return doc;
}

function firstNonEmpty(...values: (string | undefined | null)[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Deep Research terminal-event `text` (r-summary §3): a JSON string array of
 * workflow steps — extract the FINAL step's answer. `content.answer` is itself
 * a JSON string whose structured_answer[0].text (else `answer`/`chunks`) holds
 * the answer. Returns null when `text` is not that shape (normal-search text
 * or garbage stays raw for the caller to decide).
 */
function finalAnswerFromSteps(raw: string): string | null {
  let steps: unknown;
  try {
    steps = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(steps)) return null;
  for (const step of steps) {
    if (!isRecord(step) || step.step_type !== "FINAL" || !isRecord(step.content)) continue;
    const answer = step.content.answer;
    if (typeof answer !== "string" || answer.length === 0) continue;
    let doc: unknown;
    try {
      doc = JSON.parse(answer);
    } catch {
      return answer; // plain string, not JSON-wrapped — use it verbatim
    }
    if (!isRecord(doc)) return answer;
    const structured = doc.structured_answer;
    if (Array.isArray(structured)) {
      for (const part of structured) {
        if (isRecord(part) && typeof part.text === "string" && part.text.length > 0) return part.text;
      }
    }
    if (typeof doc.answer === "string" && doc.answer.length > 0) return doc.answer;
    if (Array.isArray(doc.chunks)) {
      const joined = doc.chunks.filter((c): c is string => typeof c === "string").join("");
      if (joined.length > 0) return joined;
    }
    return null; // JSON but no extractable text — do NOT surface raw JSON
  }
  return null;
}

/** Sanitize a merged doc by field name — mirrors what the direct-block path stores. */
function sanitizeFieldDoc(field: string, doc: unknown): Record<string, unknown> | WorkflowBlock | undefined {
  if (field === "workflow_block") {
    const sanitized = sanitizedWorkflowBlock(doc);
    return sanitized !== undefined ? sanitized : isRecord(doc) ? doc : undefined;
  }
  return isRecord(doc) ? doc : undefined; // readers of the other fields isRecord-guard everything they touch
}

/**
 * Merges incremental ask snapshots. Snapshot semantics: a later full block
 * REPLACES the earlier one for its intended_usage (never concatenates — chunks
 * are full state); a diff_block applies JSON patches onto the stored doc named
 * by `diff_block.field`.
 */
/** Steps array doc from a plan-style block (pro_search_steps / plan). */
interface PlanDoc {
  steps: Array<Record<string, unknown>>;
}

function planDocOf(value: unknown): PlanDoc | null {
  if (!isRecord(value) || !Array.isArray(value.steps)) return null;
  return { steps: value.steps.filter((s): s is Record<string, unknown> => isRecord(s)) };
}

export class AskMerger {
  private readWriteToken: string | null = null;
  private backendUuid: string | null = null;
  private threadUrlSlug: string | null = null;
  private displayModel: string | null = null;
  private fallbackText: string | null = null;
  private fallbackMarkdown: string | null = null;
  private fallbackAskText: string | null = null;
  /** Parsed steps from the terminal event's `text` JSON array (image asks carry caption/file_name here). */
  private textSteps: Array<Record<string, unknown>> = [];
  /** intended_usage → { [field_block]: doc } */
  private readonly docs = new Map<string, Record<string, unknown>>();

  merge(ev: AskEvent): void {
    this.readWriteToken = this.readWriteToken ?? firstNonEmpty(ev.read_write_token);
    // OVERWRITE per event: the final value is the last entry's uuid (next follow-up's last_backend_uuid).
    const backend = firstNonEmpty(ev.backend_uuid);
    if (backend) this.backendUuid = backend;
    this.threadUrlSlug = this.threadUrlSlug ?? firstNonEmpty(ev.thread_url_slug);
    this.displayModel = this.displayModel ?? firstNonEmpty(ev.display_model);
    // Deep Research carries the answer in the terminal event's top-level `text`
    // as a workflow-steps JSON array (r-summary §3): extract the FINAL answer
    // so the raw steps JSON is never surfaced as the answer text.
    const text = firstNonEmpty(ev.text);
    if (text) this.fallbackText = this.fallbackText ?? finalAnswerFromSteps(text) ?? text;
    if (text && this.textSteps.length === 0) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) this.textSteps = parsed.filter((s): s is Record<string, unknown> => isRecord(s));
      } catch {
        // not a steps array — fine, text asks carry plain markdown
      }
    }
    if (!this.fallbackMarkdown && typeof ev.markdown_block === "string" && ev.markdown_block.length > 0) {
      this.fallbackMarkdown = ev.markdown_block;
    }
    if (!this.fallbackAskText && typeof ev.ask_text === "string" && ev.ask_text.length > 0) {
      this.fallbackAskText = ev.ask_text;
    }
    for (const block of ev.blocks ?? []) {
      const usage = block.intended_usage;
      if (!usage) continue;
      const current = this.docs.get(usage) ?? {};
      if (block.diff_block) {
        const field = typeof block.diff_block.field === "string" ? block.diff_block.field : "";
        const patches = Array.isArray(block.diff_block.patches) ? block.diff_block.patches : [];
        const existing = current[field];
        this.docs.set(usage, { ...current, [field]: sanitizeFieldDoc(field, applyPatches(existing, patches)) });
      } else {
        // Direct form: snapshots are full state — REPLACE the stored doc for this
        // usage so stale fields from an earlier snapshot cannot survive.
        const next: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(block)) {
          if (key === "intended_usage") continue;
          next[key] = value;
        }
        this.docs.set(usage, next);
      }
    }
  }

  get rwToken(): string | null {
    return this.readWriteToken;
  }

  get lastBackendUuid(): string | null {
    return this.backendUuid;
  }

  get slug(): string | null {
    return this.threadUrlSlug;
  }

  get model(): string | null {
    return this.displayModel;
  }

  workflow(): WorkflowBlock | null {
    const doc = this.docs.get("workflow_root");
    const wf = doc?.workflow_block;
    return isRecord(wf) ? (wf as WorkflowBlock) : null;
  }

  followups(): string[] {
    const doc = this.docs.get("pending_followups");
    const block = doc?.pending_followups_block;
    if (isRecord(block) && Array.isArray(block.followups)) {
      return block.followups.filter((f): f is string => typeof f === "string");
    }
    return [];
  }

  /**
   * Answer text priority: workflow steps/items text_payload (normal search;
   * text ?? chunks joined) → ask_text_0_markdown → ask_text markdown blocks
   * (deep research) → event-captured text (FINAL-extracted for DR) →
   * markdown_block → ask_text → "".
   */
  answerText(): string {
    const wf = this.workflow();
    const parts: string[] = [];
    for (const step of wf?.steps ?? []) {
      for (const item of step.items ?? []) {
        const payload = item.payload?.text_payload;
        if (!payload) continue;
        const text = firstNonEmpty(payload.text);
        if (text) {
          parts.push(text);
          continue;
        }
        if (Array.isArray(payload.chunks)) {
          parts.push(payload.chunks.join(""));
        }
      }
    }
    const joined = parts.join("");
    if (joined.length > 0) return joined;
    const markdown = this.markdownAnswer("ask_text_0_markdown") ?? this.markdownAnswer("ask_text");
    if (markdown !== null) return markdown;
    return this.fallbackText ?? this.fallbackMarkdown ?? this.fallbackAskText ?? "";
  }

  /** Deep-research markdown block (chunks full-state, else the `answer` field); null when empty. */
  private markdownAnswer(usage: string): string | null {
    const doc = this.docs.get(usage)?.markdown_block;
    if (!isRecord(doc)) return null;
    if (Array.isArray(doc.chunks)) {
      const joined = doc.chunks.filter((c): c is string => typeof c === "string").join("");
      if (joined.length > 0) return joined;
    }
    return typeof doc.answer === "string" && doc.answer.length > 0 ? doc.answer : null;
  }

  private collectWebResults(list: unknown, out: WebResultRef[], seen: Set<string>): void {
    if (!Array.isArray(list)) return;
    for (const raw of list) {
      if (!isRecord(raw)) continue;
      const ref: WebResultRef = {
        ...(typeof raw.name === "string" ? { name: raw.name } : {}),
        ...(typeof raw.url === "string" ? { url: raw.url } : {}),
        ...(typeof raw.snippet === "string" ? { snippet: raw.snippet } : {}),
        ...(typeof raw.timestamp === "string" ? { timestamp: raw.timestamp } : {}),
      };
      const key = ref.url ?? ref.name ?? "";
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      out.push(ref);
    }
  }

  /** Citations from the merged web_results / sources_answer_mode blocks (may be empty — contract §I.8). */
  sources(): WebResultRef[] {
    const out: WebResultRef[] = [];
    const seen = new Set<string>();
    const webResults = this.docs.get("web_results")?.web_result_block;
    if (isRecord(webResults)) this.collectWebResults(webResults.web_results, out, seen);
    const sourcesMode = this.docs.get("sources_answer_mode")?.sources_mode_block;
    if (isRecord(sourcesMode)) this.collectWebResults(sourcesMode.web_results, out, seen);
    return out;
  }

  /**
   * Generated images from image-mode asks (pro_search_steps / plan block steps
   * with GENERATE_IMAGE_RESULTS assets). Live-captured 2026-09-23 (nanobanana2):
   * urls are S3-presigned with X-Amz-Expires ≈ 2084s (~35min) — surface/download
   * them promptly. Empty for text asks.
   */
  images(): GeneratedImage[] {
    // Assets live in the pro_search_steps plan block (live-captured); check
    // the plain "plan" usage too in case variants put them there.
    const docs: PlanDoc[] = [];
    for (const usage of ["pro_search_steps", "plan"]) {
      const doc = planDocOf(this.docs.get(usage)?.plan_block);
      if (doc) docs.push(doc);
    }
    const out: GeneratedImage[] = [];
    const seen = new Set<string>();
    for (const doc of docs) {
      for (const step of doc.steps) {
        if (!isRecord(step)) continue;
        // caption/file_name live in the text steps' GENERATE_IMAGE content, keyed by goal_id
        const results = isRecord(step.generate_image_results_content)
          ? step.generate_image_results_content
          : undefined;
        const goalId = optStringOf(results?.goal_id);
        const genStep = this.textSteps.find(
          (s) =>
            optStringOf(s.step_type) === "GENERATE_IMAGE" &&
            isRecord(s.content) &&
            optStringOf(s.content.goal_id) === goalId &&
            goalId !== undefined,
        );
        const genContent = isRecord(genStep?.content) ? genStep.content : undefined;
        const caption = optStringOf(genContent?.caption);
        const filename = optStringOf(genContent?.file_name);
        if (!Array.isArray(step.assets)) continue;
        for (const asset of step.assets) {
          if (!isRecord(asset)) continue;
          const img = isRecord(asset.generated_image) ? asset.generated_image : undefined;
          const url = optStringOf(img?.url);
          if (!url || seen.has(url)) continue;
          seen.add(url);
          // download_info carries the display filename for this same url
          const downloads = Array.isArray(asset.download_info) ? asset.download_info : [];
          const dlName = downloads.find(
            (d) => isRecord(d) && optStringOf(d.url) === url && optStringOf(d.filename) !== undefined,
          );
          const thumbnailUrl = optStringOf(img?.thumbnail_url);
          const dlFilename = optStringOf((dlName as Record<string, unknown> | undefined)?.filename);
          out.push({
            url,
            ...(thumbnailUrl ? { thumbnailUrl } : {}),
            ...(dlFilename ? { filename: dlFilename } : filename ? { filename } : {}),
            ...(caption ? { caption } : {}),
            ...(typeof img?.image_width === "number" ? { width: img.image_width } : {}),
            ...(typeof img?.image_height === "number" ? { height: img.image_height } : {}),
          });
        }
      }
    }
    return out;
  }
}

function optStringOf(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
