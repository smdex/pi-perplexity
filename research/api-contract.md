# Perplexity CLI — API Layer Implementation Contract

Single implementation contract distilled from live captures: `research/network/API-INDEX.md`,
`a-summary.md`, `b-summary.md`, `c-summary.md`, raw traces `a-trace.json` (36 entries),
`b-trace.json` (34), `c-trace.json` (45) + per-step dumps, and cookie evidence extracted from
repo-root HARs (`webapp-research.har`, `www.perplexity.ai_Archive [26-03-05 00-03-10].har`, …).
Captures: logged-in Pro web session, `gemini38flash`, incognito ON. Everything below was
spot-checked against raw trace JSON unless marked **[ASSUMPTION]**.

---

## 0. Global conventions

- **Origin**: `https://www.perplexity.ai`. All `/rest/*` calls append `?version=2.18&source=default`
  (merge into existing query strings).
- **Auth = session cookies. NO `Authorization`/Bearer header was observed on any captured
  web-client request.** (Verified: zero cookie-token hits in all three page-level traces because
  HttpOnly; HARs from devtools confirm the cookie jar.)
- Client-set headers on `/rest/*`:

  | Header | Value | Notes |
  |---|---|---|
  | `x-pplx-account` | account UUID (`user.id` from `/api/auth/session`) | sent on all `/rest/*`; response echoes `x-pplx-account-used` |
  | `x-request-id` | fresh `crypto.randomUUID()` per request | for ask: **must equal** `params.frontend_uuid` (observed equality in c-01) |
  | `x-app-apiclient` | `default` | observed on GETs; **[ASSUMPTION]** harmless on ask (absent in ask capture) |
  | `x-app-apiversion` | `2.18` | same caveat |
  | `x-perplexity-request-reason` | client label (`ask-query-state-provider`, `ask-input-inner-followup`, …) | telemetry; safe to send fixed value |
  | `x-perplexity-request-try-number` | `1` | telemetry |
  | `x-perplexity-request-endpoint` | absolute URL of the call itself | self-echo marker; **[ASSUMPTION]** optional |
  | `x-search-mode` | `search` \| `research` \| `asi` | only observed on ancillary homepage GETs, mirrors UI mode; not on ask |

- **Cookie names needed** (extracted from HAR request `Cookie` headers / `Set-Cookie`):

  | Cookie | Role | Required? |
  |---|---|---|
  | `__Secure-next-auth.session-token` | **the auth cookie** (NextAuth session JWT); `Set-Cookie` on every login, rotate observed | REQUIRED |
  | `next-auth.csrf-token` | CSRF pair for `/api/auth/*` login calls | REQUIRED during login |
  | `pplx.session-id`, `pplx.visitor-id` | per-session/per-visitor ids (set client-side too) | send if available; **[ASSUMPTION]** not auth-critical |
  | `cf_clearance`, `__cf_bm` | Cloudflare bot clearance (bound to UA+IP; short-lived) | can't be fabricated; see risk note |
  | `AWSALB`, `AWSALBCORS` | AWS ALB stickiness | optional, auto-rotate |
  | `next-auth.callback-url`, `g_state`, `pplx.*` prefs, `__stripe_mid`, `_dd_s`, … | UI/telemetry prefs | omit |

  **Login will discover them as follows:** the email-OTP flow (re-used from
  `src/auth/login.ts`, three calls against `/api/auth/*`, see §A) receives `Set-Cookie`
  headers on the `csrf` and final `signin-otp` responses. The CLI must persist
  `getSetCookie()` values (name=value pairs, 0600 file) — most importantly
  `__Secure-next-auth.session-token` — instead of only the JSON `token` body the old
  extension used. If session cookie is missing/expired (any 401/403 on `/rest/*`), clear the
  store and re-login. Cookie expiry: `/api/auth/session` returns `expires` (ISO) — use it as
  the session TTL. **[ASSUMPTION]** `cf_clearance` cannot be obtained programmatically; if
  Cloudflare challenges the CLI, fall back to cookie import from a browser profile
  (`pplx.session-id`-style export) — flag at runtime, don't crash.

- **Account-uuid discovery**: `GET https://www.perplexity.ai/api/auth/session` (no `version`
  params needed) → `{"user":{"id":"<account uuid>","email":…,"subscription_status":…,
  "payment_tier":…},"expires":"<ISO>"}`. `user.id` is exactly the `x-pplx-account` value
  (verified: `00000033-0000-4000-8000-000000000000` in both). `{}` body = logged out.
- Response of every `/rest/*` call echoes `x-pplx-account-used` — cheap session-liveness probe.
- UUIDs are `crypto.randomUUID()`; client-generated ones (`frontend_uuid`,
  `frontend_context_uuid`, presign key) need no server registration.

---

## A. Login (email OTP) — 3 sequential calls

Re-uses the flow proven in `src/auth/login.ts` (`AUTH_BASE_URL = https://www.perplexity.ai/api/auth`).
Browser sends a normal browser User-Agent; keep `Accept: application/json`.

1. `GET /api/auth/csrf`
   - Response: `{"csrfToken":"<hex>"}`. **Persist every `Set-Cookie`** (gives
     `next-auth.csrf-token`).
2. `POST /api/auth/signin-email` — body `{"email":"<email>","csrfToken":"<from step 1>"}`,
   `Content-Type: application/json`, send cookie from step 1. HTTP 2xx = OTP email sent.
3. `POST /api/auth/signin-otp` — body `{"email":…,"otp":"<code>","csrfToken":…}`, cookies
   from step 1. HTTP 2xx = logged in.
   - Response body: `{"token": …}`-ish (old ext extracts `token|accessToken|jwt|access_token`).
     **The CLI must additionally capture `Set-Cookie`** → `__Secure-next-auth.session-token`
     (HARs show 5–8 `Set-Cookie`s of exactly this name on login).
   - Then call `GET /api/auth/session` (§0) to resolve account uuid + expiry.

**[ASSUMPTION]** The JSON `token` from `signin-otp` is a JWT usable as Bearer for
`/rest/sse/perplexity_ask` (the old extension works this way), but the captured web client
never sends Bearer — the CLI contract is **cookie-first**; treat Bearer as untested fallback.

---

## B. `POST /rest/perplexity_ask/graphql` — GraphQL persisted queries

One endpoint, three operations. Headers: `Content-Type: application/json`, `x-pplx-account`.
(A few captured calls omitted `x-pplx-account` — Relay retries — **[ASSUMPTION]** it is
required; always send it.)

Body (verbatim shape):

```json
{
  "operationName": "<name>",
  "variables": { ... },
  "extensions": {
    "pplx": { "independentSidebarRollout": true },
    "persistedQuery": { "version": 1, "sha256Hash": "<hash>" }
  }
}
```

The `pplx.independentSidebarRollout` extension appeared on Sidebar + SpaceProject calls but
not on Library pages — **[ASSUMPTION]** omit it everywhere (server treats it as a feature
flag, not a cache key; persisted-query identity = operationName + hash).

### Persisted query hashes (verbatim, from a-trace entries 2/4/15)

| operationName | sha256Hash | Variables (captured verbatim) | Response path |
|---|---|---|---|
| `SidebarRecentItemsRelayQuery` | `1dcb15dc33c957d936c0c77a6066ae587d21913b4247a53d71fe6ebc8b807e8a` | `{"first":20,"types":["THREAD"]}` | `data.viewer.recentSidebarItems.items.edges[].node` |
| `LibraryThreadsRelayQuery` | `1c1f9e86416eddf3dfed6ede99575a5cc241b59cf079f2e9295ed927f2908006` | `{"includeSearchPreview":false,"searchTerm":null,"sortOrder":"NEWEST","statuses":null,"threadTypes":null,"sources":null,"includeTemporary":null,"after":"<endCursor|null>"}` | `data.viewer.recentGroup.threads.{edges,pageInfo}` |
| `SpaceProjectThreadsRelayQuery` | `db13bf755b93bc2645f536609fb6e70c4f7da4093a93fa103d9fa109bb31d066` | `{"spaceId":"<space uuid>","ownThreadsOnly":false,"searchTerm":null,"groupType":"ALL","count":25,"cursor":"<cursor|null>"}` | `data.viewer.space.threadGroup.threads.{edges,pageInfo}` |

### Thread node (verified keys, first Library node)

```
id ("TH:<base64>"), contextUUID, frontendContextUUID, entryId, readWriteToken, slug,
mode ("SEARCH"), variant ("THREAD"), displayModel {"modelID":"glm_5_3_thinking"},
isPinned, isArchived, name, status ("COMPLETED"), statusSummary, answerPreview,
isUnread, updatedAt (ISO-8601, "2026-09-07T16:42:48.680681Z"), space (object|null),
topAssets [], attachmentURLs [], taskSchedule null, __typename "Thread"
```

Sidebar nodes wrap the thread as `node.{title, activityAt, object:Thread}`.

### Pagination

- Library: page 25 edges; cursor `after` = previous `pageInfo.endCursor`; `hasNextPage` gates.
  Verified live (a-trace entry 10: second page fetched with
  `after = "THC:<redacted-cursor>"`).
  Cursor format: `THC:` + base64 of `{"s":"user_updated","d":{"t":<epoch-ms>,"c":"<uuid>"}}`
  (decoded). Treat as opaque regardless.
- Space threads: same `threads.{edges,pageInfo}` shape, cursor param named `cursor`.
- Group id `THG:<base64>` decodes to `{"s":"viewer","u":<numeric user id>,"g":"RECENT","m":null}` —
  numeric user id is available here if ever needed; thread `id` decodes to
  `{"c":"<contextUUID>"}`.
- **[ASSUMPTION]** Relay responses may contain incremental `data.viewer.__typename ===
  "RelayIncrementalPayload"`-style chunks under load; none captured. Parse `data.viewer.…`
  tolerantly (missing keys are legal).

---

## C. Spaces / projects

| Op | Call | Response (verified) |
|---|---|---|
| Spaces list (rich) | `GET /rest/spaces/landing/v2?limit=30&version=2.18&source=default` | `{sections:{invited:{items[],next_cursor,total_count}, pinned:{…}, main:{items:[Space],next_cursor,total_count}}}`; capture had `next_cursor:null` for 14 spaces. **[ASSUMPTION]** cursor is opaque string; page by passing it back (param name not captured — unknown-required-risk, see flag) |
| Spaces list (light) | `GET /rest/spaces/mentions?version=2.18&source=default` | `{"spaces":[{"uuid","title","emoji","appearance"}, …×N]}` — 14 items, no paging field observed. **Recommended for CLI** (simple, complete) |
| Spaces list (legacy) | `GET /rest/collections/list_user_collections?limit=30&offset=0&version=2.18&source=default` | top-level **JSON array** of Space objects; `offset` numeric paging |
| Threads in space | GraphQL `SpaceProjectThreadsRelayQuery` (§B) | see §B |
| Space detail | `GET /rest/collections/get_collection?collection_slug=<slug>&…` | single Space object |
| Space pins/scheduled/latest | `GET /rest/spaces/<uuid>/pins/threads?include_assets=true`, `…/scheduled_threads?include_assets=true`, `…/latest_update` | thread-list payloads |

Space object keys (verified from `list_user_collections` + landing): `uuid, title, emoji,
slug, url, description, instructions, suggested_queries[{query}], visual_concepts,
appearance, access (int), organization_uuid, thread_count, page_count, file_count, number,
has_next_page, updated_datetime, user_permission, is_pinned, space_type, model_selection, …`.

**URL + uuid semantics**:

- Thread page: `https://www.perplexity.ai/search/<uuid>` where uuid = the thread's **first
  entry** uuid. From GraphQL: `slug == entryId` (verified `7f09eb6e-ae04-…`). From SSE:
  `thread_url_slug == backend_uuid` of the first message (verified `e2e23ed7-f797-…`).
  Both are "the first entry uuid of the thread".
- Space page: `https://www.perplexity.ai/projects/<space-uuid>`; also exposed as
  `space.url = .../projects/<slug>` with slug `<title-slug>-<token>`
  (e.g. `translator-slug000000000000A1`). `collection_slug` params use the **slug form**;
  GraphQL/ask contexts use the **uuid form**.
- `context_uuid` (SSE) ≠ thread uuid: it is the thread container uuid (`<uuid>…` in c-01);
  entry-metadata endpoint uses it (`/rest/thread/<context_uuid>/entry-metadata`).

---

## D. Ask — `POST /rest/sse/perplexity_ask` (SSE)

Headers (verbatim set from c-01 entry 4):
`accept: text/event-stream`, `content-type: application/json`, `x-pplx-account`,
`x-request-id` (= `params.frontend_uuid`), plus the telemetry headers of §0.
`x-app-apiclient/x-app-apiversion` were NOT in the ask capture — **[ASSUMPTION]** optional.

### Request body — minimal working subset

Top level: `{ "params": {...}, "query_str": "<user message>" }`.

Verified-in-capture fields; **R** = treat as required, **O** = safe-to-omit candidate
(stripping is an assumption — nothing was verified by omission against the live server):

| Field | Captured value (ask #1) | Class | Notes |
|---|---|---|---|
| `params.version` | `"2.18"` | **R** | server API version; mismatches risk rejection |
| `query_str` | `"Reply with exactly OK"` | **R** | top-level, not in params |
| `params.mode` | `"copilot"` | **R** | constant for chat |
| `params.model_preference` | `"gemini38flash"` | **R** | model slug; display names are UI-only (b-summary) |
| `params.is_incognito` | `true` | **R** | keep `true` per repo policy |
| `params.sources` | `["web"]` | **R** | built-in ids: `web`, `scholar`, `social`, `finance`; connector ids like `google_drive` |
| `params.attachments` | `[]` / `[s3_object_url]` | **R** | always present; empty array for no files |
| `params.language` | `"en-US"` | **R** | UI locale |
| `params.timezone` | `"UTC"` | **R** | IANA tz |
| `params.search_focus` | `"internet"` | **R** | constant |
| `params.frontend_uuid` | uuid | **R** | must equal `x-request-id` header (verified equal) |
| `params.query_source` | `"home"` (new) / `"followup"` (follow-up) | **R** | |
| `params.is_related_query` | `false` | O | telemetry-ish |
| `params.is_sponsored` | `false` | O | |
| `params.prompt_source` | `"user"` | O | |
| `params.use_schematized_api` | `true` | R? | gates the block/workflow response shape — **unknown-required-risk**: omit only if `workflow_block` still arrives |
| `params.send_back_text_in_streaming_api` | `false` | O | |
| `params.supported_block_use_cases` | 30-string array | O | UI block catalog; **unknown-required-risk** for deep-research answer variants |
| `params.client_coordinates` | `null` | O | |
| `params.mentions` | `[]` | O | `@`-mentions |
| `params.dsl_query` | `"Reply with exactly OK"` (first msg only) | O | duplicate of query_str; first-message-only |
| `params.skip_search_enabled` | `true` | O | |
| `params.is_nav_suggestions_disabled` | `false` | O | |
| `params.source` | `"default"` | **R** | mirrors `source=default` query param |
| `params.always_search_override` / `params.override_no_search` | `false` | O | |
| `params.client_search_results_cache_key` | = `frontend_uuid` (first msg only) | O | |
| `params.should_ask_for_mcp_tool_confirmation` | `true` | O | |
| `params.supports_tool_approval_modal` | `true` | O | |
| `params.browser_agent_allow_once_from_toggle` / `force_enable_browser_agent` | `false` | O | |
| `params.supported_features` | `["browser_agent_permission_banner_v1.1"]` | O | |
| `params.extended_context` | `false` | O | |
| `params.local_workspace_directories` | `[]` | O | |
| `params.rum_session_id` | uuid | O | Datadog RUM telemetry — strip |
| `params.time_from_first_type` | `1776` (ms) | O | keystroke telemetry — strip |
| `params.local_search_enabled` | `false` | O | |

**Recommended CLI minimal body (new thread):**

```json
{
  "params": {
    "attachments": [],
    "language": "en-US",
    "timezone": "<IANA tz>",
    "search_focus": "internet",
    "sources": ["web"],
    "frontend_uuid": "<uuid>",
    "mode": "copilot",
    "model_preference": "<model slug>",
    "is_incognito": true,
    "query_source": "home",
    "source": "default",
    "use_schematized_api": true,
    "version": "2.18"
  },
  "query_str": "<message>"
}
```

**unknown-required-risk list** (present in every capture; could be mandatory server-side —
re-add if a stripped body 4xx/5xxes or degrades): `params.is_related_query`,
`params.is_sponsored`, `params.prompt_source`, `params.supported_block_use_cases`,
`params.use_schematized_api`, `params.skip_search_enabled`, `params.source`.
**[ASSUMPTION]** none of the `O` rows are validated server-side.

**Project/space targeting**: no dedicated captured field. Space routing in the UI happens via
thread context (`last_backend_uuid` chain) after `@`-mentioning a space in `mentions` —
**unknown-required-risk**: to start a thread *inside* a space, the web client presumably sends
the space uuid (likely in `mentions` or a `frontend_context_uuid` linkage) — not captured in
any c-trace (all asks were home/incognito). Do not guess; v1 CLI targets home threads only.

### Response — SSE wire format (verified byte-level from c-01)

```
event: message\r\n
data: <one-line JSON snapshot>\r\n
\r\n
… (repeat)
event: end_of_stream\r\n
data: {}\r\n
```

- `\r\n` line endings; data is a single line. **No `[DONE]` marker.**
- Observed event sequence (ask #1 and all other captures): `PENDING` ×3 → `PENDING,
  final:true` → `COMPLETED, final:true, final_sse_message:true` → `end_of_stream`.
  **Termination: stop on `status === "COMPLETED" && final === true`** (then drain to
  `end_of_stream`). The earlier `final:true` with `status:"PENDING"` carries only
  `telemetry_data` — never stop there.
- Every event carries `read_write_token` — grab it from the **first** event for follow-ups.
- Every event carries `backend_uuid` (this entry's uuid) and `thread_url_slug`.

### Snapshot top-level keys (verified, first event)

```
backend_uuid, context_uuid, uuid, frontend_context_uuid, frontend_uuid, display_model,
user_selected_model, mode ("COPILOT"), query_str, search_focus ("SearchFocus.INTERNET"),
search_mode ("SEARCH"), search_implementation_mode, message_mode ("FULL"), query_language
("en"), source, attachments, read_write_token, thread_url_slug, gpt4, text_completed,
blocks[], status, final, final_sse_message, cursor (uuid), reconnectable,
classifier_results, answer_modes, structured_answer_block_usages, rum_session_id
```
COMPLETED event adds `_extras` (`{next, country, subdomain, pro_search_mode:"reasoning",
subscription_tier:"pro", payment_tier:"paid", core_elapsed}`) and `async_rq_enabled:true`.

### Blocks — merge rules (CRITICAL deltas vs `architecture.md`)

`blocks[]` is an array keyed by `intended_usage`. Two arrival forms observed:

1. **Direct form** (COMPLETED event): `{"intended_usage":"workflow_root","workflow_block":{…}}`,
   `{"intended_usage":"answer_tabs","answer_tabs_block":{…}}`,
   `{"intended_usage":"pending_followups","pending_followups_block":{…}}`.
2. **Diff form** (the `PENDING final:true` event): block carries
   `diff_block: {"field":"workflow_block","patches":[{"op":"replace","path":"","value":{…full workflow_block…}}]}`
   — RFC-6902-shaped JSON Patch. Verified: `patches[0].value` deep-equals the final
   COMPLETED `workflow_block`. **Merge algorithm**: for each block, if it has
   `<field>_block` → upsert by `intended_usage` (replace); if it has `diff_block` → apply
   `patches` (op `replace`, path `""` = whole-document replace; tolerate deeper paths) onto
   the locally held `workflow_block` document.

`workflow_block` schema (verified):
`{version:"1.0", status:"WORKFLOW_COMPLETED", headline, started_at, completed_at,
predicted_completion_at, snapshots:[], steps[]}`; step `{status, title, items[], started_at,
completed_at, unnest_items, source_tier, id}`; item `{id, type:"WORKFLOW_ITEM_TEXT",
payload:{text_payload:{text, chunks:[], variant:"answer", is_streaming}}, display_mode,
variant}`.

**Answer text extraction priority** (gemini38flash; no `text` / `markdown_block` /
`ask_text` observed anywhere):
1. `blocks[workflow_root].workflow_block.steps[].items[].payload.text_payload.chunks[]`
   — join in order (chunks append across events; `text` field = joined text).
2. Fallback for older shapes: event `text`, then `markdown_block`, then `ask_text`
   (keep from architecture.md as tolerant fallbacks — unobserved here).

Other blocks: `answer_tabs_block.{modes:[{answer_mode_type:"ANSWER"|"IMAGE",has_preview}],
reformulated_queries:[]}`, `pending_followups_block.{followups:[]}`.

Sources/web results: **no `web_results`/`sources_list` block was observed on this model** —
source citations live in steps/items of other `intended_usage`s not yet captured, or must be
surfaced via `answer_tabs`/claims in future captures. **unknown-required-risk** for the
`sources` output section: keep the architecture.md accumulation logic as tolerant code path,
but expect it to be empty for gemini38flash-style answers.

---

## E. Follow-up flow (continue thread) — numbered sequence

Verified from c-03 (ask #2 body + SSE; chain re-verified in c-05 ask #3):

1. From the previous ask's **first SSE event**, persist `read_write_token` (constant for the
   whole thread: same `<uuid>…` reused on asks #2 and #3) and `backend_uuid` of the
   **last** completed entry (`<uuid>…` after ask #1, `<uuid>…` after ask #2).
2. Build body per §D minimal body, then:
   - add `params.last_backend_uuid` = previous entry's `backend_uuid` (NOT the thread slug);
   - add `params.read_write_token` = token from step 1;
   - set `params.query_source = "followup"` and add `params.followup_source = "link"`;
   - **remove** `frontend_context_uuid`, `dsl_query`, `client_search_results_cache_key`
     (first-message-only fields);
   - `frontend_uuid`/`x-request-id` = a fresh uuid per follow-up request.
3. POST to the same endpoint; response is a fresh SSE stream. Its events all carry the **new**
   entry's `backend_uuid` (verified: ask #2 stream ⇒ `<uuid>…`), same `thread_url_slug`,
   same `read_write_token`. Update the chain from step 1 and repeat.
4. Thread page URL = `/search/<thread_url_slug>` where `thread_url_slug` = the first entry's
   `backend_uuid` (stable across the thread).

**[ASSUMPTION]** Incognito threads can be continued identically (captures show exactly that:
`is_incognito:true` threads with full follow-up chain).

---

## F. File attachment flow — numbered sequence

Verified from c-04 (presign entry 38, S3 entry 39, subscribe entry 40) and c-05 ask #43:

1. Generate a client uuid `k` = `crypto.randomUUID()`.
2. `POST /rest/uploads/batch_create_upload_urls?version=2.18&source=default`
   — body (verbatim):
   ```json
   {"files":{"<k>":{"filename":"test-upload.txt","content_type":"text/plain",
     "source":"default","file_size":40,"force_image":false,"skip_parsing":false}}}
   ```
   Response: `{"results":{"<k>":{"s3_bucket_url":"https://ppl-ai-file-upload.s3.amazonaws.com/",
   "s3_object_url":"<final url>","fields":{acl, Content-Type, tagging, x-amz-meta-is_text_only,
   key, AWSAccessKeyId, x-amz-security-token, policy, signature}}}}`.
   `file_uuid` is **server-generated** inside `key`/`tagging` — extract it from `key`
   (pattern `web/direct-files/attachments/<user_id>/<file_uuid>/<filename>`) or the tagging XML;
   do not fabricate it.
3. `POST https://ppl-ai-file-upload.s3.amazonaws.com/` — `multipart/form-data` with **every**
   entry of `fields` **in order**, then `file` = file bytes (filename + content-type).
   Success = `204 No Content`. Presign fields carry expiring STS creds — upload promptly.
4. `POST /rest/sse/attachment_processing/subscribe` — headers `accept: text/event-stream`,
   `content-type: application/json`; body `{"file_uuids":["<file_uuid>"]}`. SSE (same wire
   format as §D): `data: {"file_uuid":…,"success":true,"s3_url":"<url>","final_sse_message":false}`
   then `event: end_of_stream`. Wait for `success:true` (poll-free). On `success:false` or
   error event: surface parse failure.
5. Reference in the ask body: `params.attachments = ["<s3_object_url from step 2>"]`
   (verbatim URL used in c-05). Nothing else about the file goes in the ask body.

---

## G. Minor / auxiliary endpoints (verified)

| Op | Call | Response |
|---|---|---|
| Session probe | `GET /api/auth/session` | `{user:{id,email,image,username,subscription_status,payment_tier,…},expires}` or `{}` |
| Client version | `GET /api/version` | `{"version":"8709aea"}` |
| Related follow-ups | `GET /rest/sse/related-queries/<thread_uuid>` | SSE; empty capture → `event: end_of_stream / data: {}` only |
| Rate limits | `GET /rest/rate-limit/status?version=2.18&source=default` | `{"free_queries":{"available":bool,…},"modes":{"agentic_research":{available,…},"labs":{…},…}}` |
| Thread metadata | `GET /rest/thread/<context_uuid>/entry-metadata?source=default&version=2.18` | `{artifact_entries:[],claim_entries:[],connector_source_ids:[],next_cursor,run_history_entries,source_entries,subagent_entries}` — **`source_entries` is the candidate sources feed per entry** |
| Connectors | `GET /rest/sources?limit=40&group_by_family=true&product_surface=computer&version=2.18&source=default` (variants: `filter_by=connected&no_limit=true&exclude_ineligible=true`, `filter_by=disconnected&popular=true&limit=10`) | `{engine_mode, next_cursor, sources:[{id, display_name, description, type, auth_type, icon_url, capabilities, …}]}` — ids: `web, scholar, social, finance, google_drive, github_mcp_direct, …` |
| Modes/skills menu | `GET /rest/computer/menu?limit=100&side_chat_available=false&version=2.18&source=default` (optionally `&collection_uuid=`) | `{featured_items:[{id:"deep-research"|"model-council"|…, title, action:{type:"skill",skill_id},…}], command_items:[{id:"search"|"incognito"|"model",…}], skills, plugin_items, next_cursor}` |
| Autosuggest | `POST /rest/autosuggest/list-autosuggest?version=2.18&source=default` — body `{"query":"","sources":["web"],"attachments":[],"search_mode":"search","source_tab_url":""}` | `{"results":[{"query":…},…]}`; `search_mode` mirrors mode selection |
| Pinned items | `GET /rest/pins?limit=50&version=2.18&source=default` | `{"items":[]}` |
| Billing gate/balance | `GET /rest/billing/credits/computer-submit-gate`, `GET /rest/billing/credits/balance` | credit balances; `GET /rest/billing/quota` may 403 (`USAGE_QUOTA_FEATURE_DISABLED`) — treat 403 as expected |

Deep research / model council: mode is client state surfaced as `search_mode`/skill ids; ask
body carries `search_mode` (field seen in SSE events; in the ask *request* it was not in the
captured incognito body — **unknown-required-risk**: deep-research submit body was never
captured; likely needs `search_mode:"research"` or `mode`/skill fields — do not ship
deep-research support on guesses).

---

## H. Models

**Endpoint found (HAR capture 2026-03-05, `www.perplexity.ai_Archive [26-03-05
00-03-10].har` entry #139 — supersedes the earlier "no endpoint" conclusion):**

`GET /rest/models/config?config_schema=v1&version=2.18&source=default` → 200 JSON:

- `models: { <slug>: {label, description, mode, provider|null} }` — the full catalog
  (61 slugs at capture time; 130 live on 2026-09-23). `mode` ∈ search, research,
  studio, study, agentic_research, asi, document_review, browser_agent.
- `config: [{label, description, subheading, has_new_tag, subscription_tier,
  non_reasoning_model|null, reasoning_model|null, text_only_model}]` — the UI picker
  order + per-slot tier ("pro"|"max"); a slug can appear in several slots.
- `default_models: { search:"pplx_pro", research:"pplx_alpha",
  agentic_research:"pplx_agentic_research", studio:"pplx_beta", study:"pplx_study",
  document_review:"pplx_document_review", browser_agent:"comet_browser_agent_sonnet",
  asi:"pplx_asi" }`
- `agentic_research_compare_models: [slugs]`

Slugs feed the ask body as `model_preference` (unchanged); SSE `display_model`
echoes the chosen slug. The CLI (`pplx models`) queries this endpoint live with a
24h cache and falls back to bundled slugs when offline.

---

## I. Consolidated assumption register

1. Cookie-auth-only contract; Bearer JWT fallback from `signin-otp` JSON is untested.
2. Stripping the `O`-class ask-body fields is untested (see risk list in §D).
3. `x-app-apiclient`/`x-app-apiversion` optional on ask; `x-perplexity-request-endpoint`
   and `-reason`/`-try-number` are inert telemetry.
4. Cloudflare (`cf_clearance`/`__cf_bm`) may hard-block non-browser UAs even with valid
   session cookies; mitigation = browser-like UA + browser-profile cookie import path.
5. `pplx.independentSidebarRollout` GraphQL extension is omittable.
6. Relay chunked/incremental GraphQL payloads beyond the captured shapes are unobserved.
7. Deep-research/research-mode ask body, space-targeted new threads, and non-incognito
   space routing were never captured — out of scope until a capture exists.
8. `sources` output for gemini38flash-style answers: no web_results block observed; source
   extraction must be tolerant and may legitimately be empty (see §D).
9. Session cookie rotation: HARs show periodic `Set-Cookie` of the session token; CLI should
   update its stored cookie jar from `Set-Cookie` on every response.
10. `spaces/landing/v2` next_cursor param name for page 2 was not captured (cursor itself
    was `null`); prefer `spaces/mentions` (no paging) or `list_user_collections` (offset).
