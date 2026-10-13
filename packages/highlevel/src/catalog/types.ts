/**
 * Types for the generated GoHighLevel catalogs: the official REST endpoints,
 * the webhook events, and the MCP tools.
 *
 * @module
 */

/** An HTTP method an official catalog endpoint can use. */
export type HttpMethod =
  "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

/** Where a generated catalog came from: the upstream docs commit and when it was built. */
export interface CatalogProvenance {
  generatedAt: string;
  upstreamCommit: string;
  upstreamDescribe: string;
  sourceRoot: string;
}

/** The official OpenAPI family of an operation: `apps/*.json` (v2) or `apps/v3/*-v3.json` (v3). */
export type ApiFamily = "v2" | "v3";

/** One operation from the official GoHighLevel v2 or v3 OpenAPI documents. */
export interface RestEndpoint {
  family: ApiFamily;
  service: string;
  source: string;
  path: string;
  method: HttpMethod;
  operationId: string | null;
  summary: string | null;
  tags: string[];
  scopes: string[];
  accessContexts: string[];
  apiVersions: string[];
  /** The `{name}` segments of `path`, in order. */
  pathParams: string[];
  queryParams: string[];
  requiredQueryParams: string[];
  hasBody: boolean;
  /**
   * The operation changes nothing: GET/HEAD, or a POST search/list/get per
   * the generator's rule (`scripts/rest-spec.ts`). A read-only client may send it.
   */
  readOnly: boolean;
}

/** The full official REST endpoint catalog. */
export interface RestCatalog {
  provenance: CatalogProvenance;
  endpointCount: number;
  services: string[];
  endpoints: RestEndpoint[];
}

/** One webhook event GoHighLevel can deliver, with its schema and example. */
export interface WebhookEvent {
  event: string;
  source: string;
  title: string;
  description: string;
  schema: Record<string, unknown> | null;
  example: Record<string, unknown> | null;
}

/** The full webhook event catalog. */
export interface WebhookCatalog {
  provenance: CatalogProvenance;
  eventCount: number;
  events: WebhookEvent[];
}

/** One tool exposed by the GoHighLevel MCP server. */
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** The MCP tool catalog, captured from a live MCP endpoint. */
export interface McpCatalog {
  provenance: Omit<CatalogProvenance, "upstreamCommit" | "upstreamDescribe"> & {
    endpoint: string;
  };
  toolCount: number;
  tools: McpTool[];
}
