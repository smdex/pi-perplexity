import { restGet } from "./http.js";

/**
 * Sources / connectors: GET /rest/sources (b-summary, contract §G).
 * Query variants verbatim from captures — `product_surface=computer` was
 * present on every observed call.
 */

export interface Connector {
  id: string;
  displayName: string;
  description: string | null;
  authType: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function listConnectors(opts?: {
  connectedOnly?: boolean;
  signal?: AbortSignal | undefined;
}): Promise<Connector[]> {
  const query = opts?.connectedOnly
    ? { filter_by: "connected", no_limit: "true", exclude_ineligible: "true", group_by_family: "true", product_surface: "computer" }
    : { limit: 40, group_by_family: "true", product_surface: "computer" };
  const payload = await restGet<unknown>("/rest/sources", query, opts?.signal);
  const sources = isRecord(payload) && Array.isArray(payload.sources) ? payload.sources : [];
  const connectors: Connector[] = [];
  for (const raw of sources) {
    if (!isRecord(raw)) continue;
    const id = str(raw.id);
    if (!id) continue;
    connectors.push({
      id,
      displayName: str(raw.display_name) ?? id,
      description: str(raw.description),
      authType: str(raw.auth_type),
    });
  }
  return connectors;
}
