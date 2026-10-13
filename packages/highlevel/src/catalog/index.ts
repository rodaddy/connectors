/**
 * The committed official REST catalog and lookups into it.
 *
 * @module
 */
import catalogJson from "../../catalog/rest-catalog.json" with { type: "json" };

import type { ApiFamily, HttpMethod, RestCatalog, RestEndpoint } from "./types.ts";

/** Every official v2 and v3 operation, from the pinned upstream commit. */
export const restCatalog = catalogJson as unknown as RestCatalog;

/** Find an operation by id. `service` disambiguates ids upstream reuses across modules. */
export interface OperationRef {
  family: ApiFamily;
  operationId: string;
  service?: string;
}

/** Find an operation by method and path template. `family` disambiguates routes in both. */
export interface RouteRef {
  method: HttpMethod;
  path: string;
  family?: ApiFamily;
}

/** A catalog lookup that matched no operation, or more than one. */
export class CatalogLookupError extends Error {
  /**
   * @param message - What was looked up and why it failed.
   */
  constructor(message: string) {
    super(message);
    this.name = "CatalogLookupError";
  }
}

function exactlyOne(matches: RestEndpoint[], label: string): RestEndpoint {
  const [first, ...rest] = matches;
  if (first === undefined) throw new CatalogLookupError(`Unknown operation ${label}.`);
  if (rest.length > 0) {
    const where = matches.map((e) => `${e.family}/${e.service}`).join(", ");
    throw new CatalogLookupError(`Ambiguous operation ${label}: ${where}.`);
  }
  return first;
}

/**
 * Find one operation by family and operation id.
 *
 * @param ref - Family, operation id, and optionally the service.
 * @returns The endpoint.
 * @throws CatalogLookupError when none or several match.
 */
export function findOperation(ref: OperationRef): RestEndpoint {
  const matches = restCatalog.endpoints.filter(
    (e) =>
      e.family === ref.family &&
      e.operationId === ref.operationId &&
      (ref.service === undefined || e.service === ref.service),
  );
  return exactlyOne(matches, `${ref.family} ${ref.operationId}`);
}

/**
 * Find one operation by method and path template, e.g. `/contacts/{contactId}`.
 *
 * @param ref - Method, path template, and optionally the family.
 * @returns The endpoint.
 * @throws CatalogLookupError when none or several match.
 */
export function findRoute(ref: RouteRef): RestEndpoint {
  const matches = restCatalog.endpoints.filter(
    (e) =>
      e.method === ref.method &&
      e.path === ref.path &&
      (ref.family === undefined || e.family === ref.family),
  );
  return exactlyOne(matches, `${ref.method} ${ref.path}`);
}
