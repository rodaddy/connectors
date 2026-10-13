/**
 * Call any official catalog operation by id or by route, through a
 * {@link HighLevelClient} (so its `allowWrites` guard still applies).
 *
 * @module
 */
import {
  findOperation,
  findRoute,
  type OperationRef,
  type RouteRef,
} from "../catalog/index.ts";
import type { ApiFamily, RestEndpoint } from "../catalog/types.ts";
import {
  type DryRunResult,
  type HighLevelClient,
  type HighLevelRequestInit,
  isDryRun,
  type JsonObject,
} from "./highlevel.ts";
import { READ_ONLY_INITS, TEMPLATE_LOCATIONS } from "./read-intent.ts";

const FALLBACK_API_VERSION = "2021-07-28";
/** A family's own `Version` value, where it has one. v2 has none (it lists dates). */
const FAMILY_VERSIONS: Partial<Record<ApiFamily, string>> = { v3: "v3" };
/** Path params whose value is a location id; the account guard checks them. */
const LOCATION_PARAMS = new Set(["locationId", "location_id", "altId"]);

/** A query value; an array repeats the parameter once per item. */
export type QueryValue = string | number | boolean | ReadonlyArray<string | number>;

/** Arguments for {@link callOperation}. */
export interface CallArgs {
  /** Values for the path's `{name}` segments; each is URL-encoded and must be non-blank. */
  pathParams?: Record<string, string>;
  query?: Record<string, QueryValue>;
  body?: JsonObject;
  /**
   * The `Version` header. Defaults to the family's own version when the
   * endpoint lists it (`v3` for v3), else the endpoint's first listed version,
   * else the family's own version, else `2021-07-28`.
   */
  version?: string;
}

/** Arguments that cannot satisfy the resolved endpoint. */
export class CallArgumentError extends Error {
  /**
   * @param message - Which argument is missing.
   */
  constructor(message: string) {
    super(message);
    this.name = "CallArgumentError";
  }
}

/**
 * The client planned the request instead of sending it (a write on a
 * `dryRun` client). Thrown so a typed helper never parses a plan as a
 * GoHighLevel response; the plan is on {@link HighLevelDryRunPlanned.plan}.
 */
export class HighLevelDryRunPlanned extends Error {
  /** What would have been sent; the token is redacted. */
  readonly plan: DryRunResult;

  /**
   * @param plan - The dry-run plan the client returned.
   */
  constructor(plan: DryRunResult) {
    super(
      `Dry run: planned ${plan.request.method} ${plan.request.url}; nothing was sent.`,
    );
    this.name = "HighLevelDryRunPlanned";
    this.plan = plan;
  }
}

function resolveEndpoint(ref: OperationRef | RouteRef): RestEndpoint {
  return "operationId" in ref ? findOperation(ref) : findRoute(ref);
}

function pathValue(
  endpoint: RestEndpoint,
  values: Record<string, string>,
  name: string,
): string {
  const value = values[name];
  if (value === undefined || value.trim() === "") {
    throw new CallArgumentError(
      `Missing path parameter "${name}" for ${endpoint.path}.`,
    );
  }
  return value;
}

function fillPath(endpoint: RestEndpoint, values: Record<string, string>): string {
  return endpoint.path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    encodeURIComponent(pathValue(endpoint, values, name)),
  );
}

/** The values bound to the template's location-type params, for the account guard. */
function templateLocations(
  endpoint: RestEndpoint,
  values: Record<string, string>,
): string[] {
  const names = [...endpoint.path.matchAll(/\{([^}]+)\}/g)].map(
    (match) => match[1] ?? "",
  );
  return names
    .filter((name) => LOCATION_PARAMS.has(name))
    .map((name) => values[name] ?? "");
}

function queryString(
  endpoint: RestEndpoint,
  query: Record<string, QueryValue>,
): string {
  const missing = endpoint.requiredQueryParams.filter(
    (name) => query[name] === undefined,
  );
  if (missing.length > 0) {
    throw new CallArgumentError(
      `Missing required query parameter(s) ${missing.join(", ")} for ${endpoint.path}.`,
    );
  }
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) params.append(name, String(item));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function defaultVersion(endpoint: RestEndpoint): string {
  const own = FAMILY_VERSIONS[endpoint.family];
  if (own !== undefined && endpoint.apiVersions.includes(own)) return own;
  return endpoint.apiVersions[0] ?? own ?? FALLBACK_API_VERSION;
}

function buildInit(endpoint: RestEndpoint, args: CallArgs): HighLevelRequestInit {
  const init: HighLevelRequestInit = {
    method: endpoint.method,
    ...(args.body ? { body: args.body } : {}),
  };
  // The catalog marks POST searches read-only; the client then sends them without allowWrites.
  if (endpoint.readOnly) READ_ONLY_INITS.add(init);
  TEMPLATE_LOCATIONS.set(init, templateLocations(endpoint, args.pathParams ?? {}));
  return init;
}

/**
 * Resolve an operation from the catalog, build its URL, and send it. An
 * account client checks the template's location params (`{locationId}`,
 * `{location_id}`, `{altId}` wherever they sit) as well as the query and body.
 *
 * @param client - The client that sends the request and enforces `allowWrites`.
 * @param ref - `{ family, operationId }` or `{ method, path }` (a path template).
 * @param args - Path params, query, JSON body, and an optional `Version`.
 * @returns The parsed JSON response.
 * @throws CatalogLookupError when the operation is unknown or ambiguous.
 * @throws CallArgumentError when a path param is missing or blank, or a required query param is missing.
 * @throws HighLevelDryRunPlanned when a `dryRun` client planned the request instead of sending it.
 */
export async function callOperation<T = unknown>(
  client: HighLevelClient,
  ref: OperationRef | RouteRef,
  args: CallArgs = {},
): Promise<T> {
  const endpoint = resolveEndpoint(ref);
  const path = fillPath(endpoint, args.pathParams ?? {});
  const query = queryString(endpoint, args.query ?? {});
  const version = args.version ?? defaultVersion(endpoint);
  const init = buildInit(endpoint, args);
  const { status, data } = await client.requestWithStatus<T>(
    `${path}${query}`,
    init,
    version,
  );
  if (status === 0 && isDryRun(data)) throw new HighLevelDryRunPlanned(data);
  return data;
}
