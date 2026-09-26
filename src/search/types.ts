// --- SSE event types (all fields optional per AGENTS.md: API is unstable) ---

export interface StreamEvent {
  status?: string;
  final?: boolean;
  text?: string;
  blocks?: StreamBlock[];
  sources_list?: StreamSource[];
  display_model?: string;
  user_selected_model?: string;
  uuid?: string;
  error_code?: string;
  error_message?: string;
  /** Thread continuation: last entry uuid → next follow-up's last_backend_uuid (each event overwrites). */
  backend_uuid?: string;
  /** Read-write token for follow-ups (first non-empty wins). */
  read_write_token?: string;
  /** Thread URL slug — the stable session id used for --thread continuation. */
  thread_url_slug?: string;
}

export interface StreamBlock {
  intended_usage?: string;
  markdown_block?: {
    answer?: string;
    chunks?: string[];
    chunk_starting_offset?: number;
  };
  web_result_block?: {
    web_results?: WebResult[];
  };
}

export interface WebResult {
  name?: string;
  url?: string;
  snippet?: string;
  timestamp?: string;
}

export interface StreamSource {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
}

// --- Auth types ---

export interface StoredToken {
  type: "oauth";
  access?: string;
  email?: string;
  /** Cookie jar captured at OTP login (session cookie et al) — sent alongside Bearer. */
  cookies?: string[];
  /** User-Agent the cookies were issued for (cf_clearance is UA-bound). */
  userAgent?: string;
}

// --- Search result (output of client, input to formatter) ---

export interface SearchResult {
  answer: string;
  sources: WebResult[];
  displayModel?: string;
  uuid?: string;
  /** Thread URL slug — pass as `thread` to continue this conversation. */
  slug?: string;
  /** Follow-up credential pair (with backendUuid) captured from the stream. */
  readWriteToken?: string;
  backendUuid?: string;
}

// --- Error types ---

export type SearchErrorCode = "AUTH" | "RATE_LIMIT" | "NETWORK" | "STREAM" | "EMPTY";

export class SearchError extends Error {
  constructor(
    public readonly code: SearchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SearchError";
  }
}

export type AuthErrorCode = "NO_TOKEN" | "EXTRACTION_FAILED";

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
