# Perplexity Web API — CLI Implementation Index

Consolidated from live network captures (2026-09-21/22/23, logged-in Pro account, BrowserOS neo).
Raw traces: `a-trace.json` (threads/spaces), `b-trace.json` (chat options), `c-trace.json` (ask/continue/attach), `r-trace.json` (deep research), `t-trace.json` (thread lifecycle CRUD), `s-trace.json` (space CRUD + ask-inside-space) + per-step dumps.
Full details in `a-summary.md`, `b-summary.md`, `c-summary.md`, `r-summary.md`, `t-summary.md`, `s-summary.md`.

## Base

- Origin `https://www.perplexity.ai`; all REST calls append `?version=2.18&source=default`
- Auth: session cookies (no Bearer). Client-set headers: `x-pplx-account` (account uuid), `x-request-id`, `x-app-apiclient: default`, `x-app-apiversion: 2.18`
- GraphQL POSTs additionally send `X-Pplx-Account` + persisted-query hash

## CLI capability → endpoint map

| CLI command | Endpoint(s) |
|---|---|
| `list threads` | `POST /rest/perplexity_ask/graphql` — `LibraryThreadsRelayQuery`, 25/page, cursor `after` = `pageInfo.endCursor` (sha256 `1c1f9e86…`) |
| `list threads` (sidebar, recent 20) | same — `SidebarRecentItemsRelayQuery` (sha256 `1dcb15dc…`) |
| `list spaces` | `GET /rest/spaces/landing/v2?limit=30` (`sections.main.items[]`, `next_cursor`) or `GET /rest/spaces/mentions` (uuid+title+emoji) |
| `list threads in space` | GraphQL `SpaceProjectThreadsRelayQuery` vars `{spaceId, count:25, cursor}` (sha256 `db13bf75…`); legacy `GET /rest/collections/list_collection_threads?collection_slug=&offset=` |
| `list models` | `GET /rest/models/config?config_schema=v1` — full catalog `{models:{slug:{label,description,mode,provider}}, config:[picker slots], default_models:{mode:slug}}` (HAR 2026-03-05; supersedes the earlier "client-bundled, no endpoint" note). Slugs go in the ask body as `model_preference` |
| `list connectors` | `GET /rest/sources?limit=40&group_by_family=true` (+ `filter_by=connected&no_limit=true` / `filter_by=disconnected&popular=true&limit=10`) — ids like `google_drive`, `notion_mcp` |
| `set incognito` | **client-only state** → ask body `is_incognito: bool` |
| `set deep research` | **client-only mode** → ask body `model_preference: "pplx_alpha"` + NO `client_search_results_cache_key` (verified r-summary.md); ancillary calls carry `search_mode: "research"`; menu skill ids (`deep-research`, `model-council`) from `GET /rest/computer/menu`; quota family `agentic_research` in `GET /rest/rate-limit/status` |
| `set project` | project = space uuid from `/rest/spaces/mentions`; goes in ask context (space/thread routing via `last_backend_uuid` chain) |
| `new chat / send` | `POST /rest/sse/perplexity_ask` (SSE) — full body in `c-summary.md` |
| ask inside a space | same ask endpoint + `params.target_collection_uuid` + `params.target_thread_access_level:5` + `query_source:"collection"` (s-summary.md §Ask inside space; `mentions: []` unchanged) |
| `chats rename` | `POST /rest/thread/set_thread_title` body `{context_uuid, title, read_write_token}` → 204 (t-summary.md) |
| `chats pin` / `chats unpin` | `POST /rest/thread/batch_pin_threads` / `batch_unpin_threads` body `{context_uuids:[…]}` → 200 `{succeeded,failed}` (t-summary.md) |
| `chats delete` | `DELETE /rest/thread/delete_thread_by_entry_uuid` body `{entry_uuid, read_write_token}` → 200 `{status:"success"}` — **entry_uuid = the URL slug uuid, NOT context_uuid** (t-summary.md) |
| `spaces create` | `POST /rest/collections/create_collection` body per capture → 200 full space object (s-summary.md) |
| `spaces rename` | `POST /rest/collections/edit_collection/<uuid>` body `{title}` (partial update) → 200 (s-summary.md) |
| `spaces delete` | `DELETE /rest/collections/delete_collection/<uuid>` no body → 200 null (s-summary.md) |
| thread archive / move-to-space | NOT captured (no UI entry / picker canceled) |
| `continue thread` | same endpoint + `params.last_backend_uuid` (prev entry uuid) + `params.read_write_token` (from first SSE event) + `query_source:"followup"` |
| `attach file` | 1) `POST /rest/uploads/batch_create_upload_urls` → 2) S3 multipart POST (`ppl-ai-file-upload.s3.amazonaws.com`, 204) → 3) `POST /rest/sse/attachment_processing/subscribe` until `success:true` → ask body `attachments:["<s3_object_url>"]` |
| thread metadata | `GET /rest/thread/<contextUUID>/entry-metadata` |

## Key formats

- Thread URL: `/search/<uuid>` — uuid = **first entry** `backend_uuid` = SSE `thread_url_slug`
- Space URL: `/projects/<uuid>`; slug `<title>-<token>` for `collection_slug` params
- Relay cursors: opaque `THC:<base64>`; thread node has `contextUUID, entryId, readWriteToken, slug, name, updatedAt, displayModel`

## SSE protocol (deltas vs architecture.md)

1. Format: `event: message` + snapshot JSON; ends with `event: end_of_stream` + `data: {}` — **no `[DONE]`**
2. Done = `status:"COMPLETED" && final:true` (earlier `final:true` with `status:"PENDING"` is a trap — carries telemetry only)
3. Answer text (gemini38flash): `blocks[workflow_root].workflow_block.steps[].items[].payload.text_payload.chunks[]` — no `text`/`markdown_block`/`ask_text`
4. Deep Research (pplx_alpha): `blocks[ask_text_0_markdown|ask_text].markdown_block.chunks[]` → terminal event top-level `text` = workflow-steps JSON with `FINAL.answer.structured_answer` fallback (r-summary.md §3)
4. `read_write_token` arrives in every SSE event — persist it for follow-ups
