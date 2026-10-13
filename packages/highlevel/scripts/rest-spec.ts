/**
 * Pure extraction of catalog endpoints from one OpenAPI document, so the
 * generator's rules are unit-testable on a fixture.
 *
 * @module
 */
import type { ApiFamily, HttpMethod, RestEndpoint } from "../src/catalog/types.ts";

type JsonObject = Record<string, unknown>;

const HTTP_METHODS: ReadonlySet<string> = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
]);
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
const READ_OPERATION_ID =
  /(^|-)(search|query|find|list|get|lookup|count|filter|export)(-|$)/i;
const READ_SUMMARY = /^(Search|Get|List|Find)/;

/**
 * POSTs whose operationId or summary reads like a search but that change
 * state, so they stay writes. Keyed by operationId (the same in v2 and v3).
 */
export const WRITE_POST_EXCLUSIONS: ReadonlySet<string> = new Set([
  // "Create offline user list job": "list" is the noun; it creates a job.
  "google-create-offline-user-list-job",
  // "Get Access Token": exchanges a code or refresh token and mints a token.
  "get-access-token",
  // "Get Location Access Token from Agency Token": mints a location token.
  "get-location-access-token",
]);

/**
 * Whether an operation only reads: GET/HEAD, or a POST whose operationId or
 * summary says it searches, lists or gets, minus {@link WRITE_POST_EXCLUSIONS}.
 *
 * @param method - The HTTP method.
 * @param operationId - The spec's operationId, if any.
 * @param summary - The spec's summary, if any.
 * @returns `true` when the operation changes nothing.
 */
export function isReadOnlyOperation(
  method: HttpMethod,
  operationId: string | null,
  summary: string | null,
): boolean {
  if (READ_METHODS.has(method)) return true;
  if (method !== "POST") return false;
  if (operationId !== null && WRITE_POST_EXCLUSIONS.has(operationId)) return false;
  return READ_OPERATION_ID.test(operationId ?? "") || READ_SUMMARY.test(summary ?? "");
}

/** Where an OpenAPI document came from. */
export interface SpecSource {
  family: ApiFamily;
  /** The upstream-relative file, e.g. `apps/v3/contacts-v3.json`. */
  source: string;
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asObject) : [];
}

function accessContextsOf(description: string): string[] {
  const contexts: string[] = [];
  if (/Agency/i.test(description)) contexts.push("agency");
  if (/Sub-Account|Location/i.test(description)) contexts.push("sub-account");
  return contexts;
}

function securityDetails(operation: JsonObject, schemes: JsonObject) {
  const scopes = new Set<string>();
  const accessContexts = new Set<string>();
  for (const entry of asObjects(operation["security"])) {
    for (const [schemeName, scopeValue] of Object.entries(entry)) {
      for (const scope of asStrings(scopeValue)) scopes.add(scope);
      const description = asObject(schemes[schemeName])["description"];
      const text = typeof description === "string" ? description : "";
      for (const context of accessContextsOf(text)) {
        accessContexts.add(context);
      }
    }
  }
  return { scopes: [...scopes].sort(), accessContexts: [...accessContexts].sort() };
}

function versionsOf(parameters: JsonObject[]): string[] {
  const values = new Set<string>();
  for (const parameter of parameters) {
    if (String(parameter["name"]).toLowerCase() !== "version") continue;
    const schema = asObject(parameter["schema"]);
    for (const version of asStrings(schema["enum"])) values.add(version);
    if (typeof schema["default"] === "string") values.add(schema["default"]);
  }
  return [...values].sort();
}

function queryNames(parameters: JsonObject[], requiredOnly: boolean): string[] {
  return parameters
    .filter((p) => p["in"] === "query" && (!requiredOnly || p["required"] === true))
    .map((p) => String(p["name"]));
}

/**
 * The `{name}` segments of an OpenAPI path, in order.
 *
 * @param path - An OpenAPI path template.
 * @returns The parameter names.
 */
export function pathParamsOf(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? "");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toEndpoint(
  base: SpecSource & { service: string; path: string; method: HttpMethod },
  operation: JsonObject,
  schemes: JsonObject,
): RestEndpoint {
  const parameters = asObjects(operation["parameters"]);
  const operationId = stringOrNull(operation["operationId"]);
  const summary = stringOrNull(operation["summary"]);
  return {
    ...base,
    operationId,
    summary,
    tags: asStrings(operation["tags"]).sort(),
    ...securityDetails(operation, schemes),
    apiVersions: versionsOf(parameters),
    pathParams: pathParamsOf(base.path),
    queryParams: queryNames(parameters, false),
    requiredQueryParams: queryNames(parameters, true),
    hasBody: operation["requestBody"] !== undefined,
    readOnly: isReadOnlyOperation(base.method, operationId, summary),
  };
}

/**
 * Every operation of one OpenAPI document as catalog endpoints.
 *
 * @param spec - The parsed OpenAPI document.
 * @param from - Its family and upstream-relative source file.
 * @returns The endpoints, in document order.
 */
export function extractEndpoints(spec: unknown, from: SpecSource): RestEndpoint[] {
  const document = asObject(spec);
  const schemes = asObject(asObject(document["components"])["securitySchemes"]);
  const file = from.source.split("/").at(-1) ?? from.source;
  const service = file.replace(/(-v3)?\.json$/, "");
  const endpoints: RestEndpoint[] = [];
  for (const [path, item] of Object.entries(asObject(document["paths"]))) {
    for (const [name, operation] of Object.entries(asObject(item))) {
      if (!HTTP_METHODS.has(name)) continue;
      const method = name.toUpperCase() as HttpMethod;
      const base = { ...from, service, path, method };
      endpoints.push(toEndpoint(base, asObject(operation), schemes));
    }
  }
  return endpoints;
}
