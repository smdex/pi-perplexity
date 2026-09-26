export const ORIGIN = "https://www.perplexity.ai";
/**
 * Incognito ("temp") chats are dropped by Perplexity ~24h after creation
 * (assumption from observed behavior — not a captured contract). The local
 * thread registry uses this to expire continuation state.
 */
export const TEMP_TTL_MS = 24 * 60 * 60 * 1000;
export const API_VERSION = "2.18"; // ?version=2.18&source=default everywhere on /rest/*
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
export const BUILTIN_SOURCES = ["web", "scholar", "social", "finance"] as const;
export const DEFAULT_MODEL = "gemini38flash";
// Internal deep-research engine (r-summary §1): selected by swapping
// model_preference to "pplx_alpha" — NOT a user-selectable chat model.
export const RESEARCH_MODEL = "pplx_alpha";
// Bundled fallback for `pplx models` / --model completion: used only when the
// live /rest/models/config catalog is unreachable (contract §H). --model passes any string through.
export const MODELS: readonly { id: string; display: string; verified: true }[] = [
  { id: "gemini38flash", display: "Gemini 3.8 Flash", verified: true },
  { id: "glm_5_3_thinking", display: "GLM 5.3 Thinking", verified: true },
];
export const LOGIN_HELP =
  "Run `pplx login` (paste cookies from a logged-in browser, --browser import, or email OTP).";
