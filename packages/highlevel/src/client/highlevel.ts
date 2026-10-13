/**
 * The official GoHighLevel API client, authenticated with a Private
 * Integration token. Read-only unless built with `allowWrites: true`.
 *
 * @module
 */

import {
  classifyError,
  HighLevelTimeoutError,
  type HighLevelErrorKind,
} from "../core/errors.ts";
import { resolveToken, type TokenProvider } from "../core/token.ts";
import { READ_ONLY_INITS } from "./read-intent.ts";

const DEFAULT_BASE_URL = "https://services.leadconnectorhq.com";
const DEFAULT_API_VERSION = "2021-07-28";
// GET /conversations/search accepts only this Version (conversations.json).
const CONVERSATION_SEARCH_VERSION = "2021-04-15";
const DEFAULT_TIMEOUT_MS = 30_000;
// Cloudflare answers error 1010 to a default client User-Agent.
const DEFAULT_USER_AGENT = "connectors-highlevel/0.1";
const REDACTED_AUTHORIZATION = "Bearer <redacted>";
const READ_METHODS = new Set(["GET", "HEAD"]);
// Statuses that never carry a body.
const BODYLESS_STATUSES = new Set([204, 205, 304]);

/** A `fetch`-compatible function, injectable so tests never touch the network. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Options for {@link HighLevelClient}. */
export interface HighLevelClientOptions {
  /**
   * The Private Integration token sent as `Authorization: Bearer`, or a
   * provider called on every request (nothing is cached).
   */
  token: string | TokenProvider;
  /** API base URL; defaults to `https://services.leadconnectorhq.com`. */
  baseUrl?: string;
  /** Opt in to non-`GET`/`HEAD` requests. Defaults to `false`. */
  allowWrites?: boolean;
  /** The `fetch` to use; defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** The `User-Agent` header; defaults to `connectors-highlevel/0.1`. */
  userAgent?: string;
  /** Per-request timeout in milliseconds; defaults to 30000. */
  timeoutMs?: number;
  /**
   * Plan every write instead of sending it: a write resolves to a
   * {@link DryRunResult} and `fetch` never runs. Reads are still sent. Writes
   * are planned even without `allowWrites`, because nothing is sent.
   */
  dryRun?: boolean;
}

/** What a dry-run would have sent. The token is redacted. */
export interface DryRunResult {
  dryRun: true;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
}

/**
 * Whether a request result is a dry-run plan rather than a response.
 *
 * @param value - A value returned by {@link HighLevelClient.request}.
 * @returns `true` for a {@link DryRunResult}.
 */
export function isDryRun(value: unknown): value is DryRunResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { dryRun?: unknown }).dryRun === true
  );
}

/** A JSON object body, serialized by {@link HighLevelClient.request}. */
export type JsonObject = Record<string, unknown>;

/**
 * `RequestInit` whose `body` may also be a plain object. A plain object is
 * sent as JSON; any other body passes through untouched.
 */
export type HighLevelRequestInit = Omit<RequestInit, "body"> & {
  body?: RequestInit["body"] | JsonObject;
  /**
   * Plan this request instead of sending it, whatever its method. Planned
   * writes need no `allowWrites`, because nothing is sent.
   */
  dryRun?: boolean;
};

/** A workflow as returned by the official workflow list. */
export interface WorkflowSummary {
  id: string;
  name: string;
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  locationId: string;
}

interface WorkflowListResponse {
  workflows: WorkflowSummary[];
}

/** An opportunity pipeline and its stages. */
export interface Pipeline {
  id: string;
  name: string;
  stages: Array<{ id: string; name: string; position?: number }>;
}

/** A location custom field definition. */
export interface CustomField {
  id: string;
  name: string;
  fieldKey?: string;
  dataType?: string;
}

/** One page of an opportunity search. */
export interface OpportunitySearchResult {
  opportunities: unknown[];
  meta?: { total?: number; nextPageUrl?: string | null };
}

/** One page of a conversation search. */
export interface ConversationSearchResult {
  conversations: unknown[];
  total?: number;
}

/** One page of a contact list. */
export interface ContactListResult {
  contacts: unknown[];
  meta?: { total?: number; nextPageUrl?: string | null };
}

/** Paging for the list and search helpers. `limit` defaults to 20. */
export interface PagingOptions {
  limit?: number;
  /** The cursor value; sent as `startAfterDate` by `searchConversations`. */
  startAfter?: string;
  startAfterId?: string;
}

/** A response and its HTTP status, from {@link HighLevelClient.requestWithStatus}. */
export interface HighLevelResponse<T> {
  status: number;
  data: T;
}

/**
 * A non-2xx response from the GoHighLevel API, carrying its status, raw body,
 * and the classifier's kind and message.
 */
export class HighLevelApiError extends Error {
  /** The HTTP status code. */
  readonly status: number;
  /** The raw response body text. */
  readonly responseBody: string;
  /** What went wrong, from {@link classifyError}. */
  readonly kind: HighLevelErrorKind;

  /**
   * @param message - The error message.
   * @param status - The HTTP status code.
   * @param responseBody - The raw response body text.
   * @param kind - The classified kind; defaults to `"unknown"`.
   */
  constructor(
    message: string,
    status: number,
    responseBody: string,
    kind: HighLevelErrorKind = "unknown",
  ) {
    super(message);
    this.name = "HighLevelApiError";
    this.status = status;
    this.responseBody = responseBody;
    this.kind = kind;
  }
}

interface PreparedRequest {
  method: string;
  path: string;
  init: HighLevelRequestInit;
  apiVersion: string;
}

/** The official GoHighLevel API client. */
export class HighLevelClient {
  readonly #token: string | TokenProvider;
  readonly #baseUrl: string;
  readonly #allowWrites: boolean;
  readonly #fetch: FetchLike;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #dryRun: boolean;

  /**
   * @param options - Token or provider, base URL, write opt-in, `fetch`,
   *   User-Agent, timeout and dry-run mode.
   * @throws Error when a token string is empty.
   */
  constructor(options: HighLevelClientOptions) {
    if (typeof options.token === "string" && !options.token.trim()) {
      throw new Error("A HighLevel access token is required.");
    }

    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#allowWrites = options.allowWrites ?? false;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#dryRun = options.dryRun ?? false;
  }

  /**
   * Send one request and parse the JSON response. A planned request (per-call
   * `dryRun: true`, or a write on a `dryRun` client) resolves to a
   * {@link DryRunResult} without calling `fetch`; check with {@link isDryRun}.
   *
   * @param path - Path below the base URL, starting with `/`, including any query string.
   * @param init - Request options; a plain-object `body` is sent as JSON.
   * @param apiVersion - The `Version` header; defaults to `2021-07-28`.
   * @returns The parsed JSON response (`undefined` for `HEAD`, 204 or an empty
   *   body), or the dry-run plan.
   * @throws Error when `path` does not start with `/`.
   * @throws Error when a write is attempted without `allowWrites: true` or dry-run.
   * @throws HighLevelApiError when the response is not 2xx.
   * @throws HighLevelTimeoutError when no response arrives within `timeoutMs`.
   */
  request(
    path: string,
    init: HighLevelRequestInit & { dryRun: true },
    apiVersion?: string,
  ): Promise<DryRunResult>;
  request<T>(
    path: string,
    init?: HighLevelRequestInit,
    apiVersion?: string,
  ): Promise<T>;
  async request<T>(
    path: string,
    init: HighLevelRequestInit = {},
    apiVersion?: string,
  ): Promise<T> {
    return (await this.requestWithStatus<T>(path, init, apiVersion)).data;
  }

  /**
   * {@link HighLevelClient.request}, also returning the HTTP status. A dry-run
   * plan comes back with status 0 and the {@link DryRunResult} as `data`.
   * `request` calls this, so a subclass that guards requests overrides this.
   *
   * @param path - Path below the base URL, including any query string.
   * @param init - Request options; a plain-object `body` is sent as JSON.
   * @param apiVersion - The `Version` header; defaults to `2021-07-28`.
   * @returns The status and the parsed JSON response.
   * @throws Error, HighLevelApiError or HighLevelTimeoutError, as for `request`.
   */
  async requestWithStatus<T>(
    path: string,
    init: HighLevelRequestInit = {},
    apiVersion = DEFAULT_API_VERSION,
  ): Promise<HighLevelResponse<T>> {
    requireRootedPath(path);
    const method = (init.method ?? "GET").toUpperCase();
    // Only callOperation marks a catalog read-only POST; no public init field can.
    const isWrite = !READ_METHODS.has(method) && !READ_ONLY_INITS.has(init);
    const prepared = { method, path, init, apiVersion };
    if (init.dryRun === true || (this.#dryRun && isWrite)) {
      return { status: 0, data: this.#plan(prepared) as T };
    }
    if (isWrite && !this.#allowWrites) {
      throw new Error(
        `Blocked ${method} request in read-only mode. Construct the client with allowWrites: true to opt in.`,
      );
    }
    return this.#send<T>(prepared, `Bearer ${await resolveToken(this.#token)}`);
  }

  #build(prepared: PreparedRequest, authorization: string): RequestInit {
    const headers = new Headers(prepared.init.headers);
    headers.set("Accept", "application/json");
    headers.set("Authorization", authorization);
    headers.set("Version", prepared.apiVersion);
    headers.set("User-Agent", this.#userAgent);
    const { body: rawBody, dryRun: _dryRun, ...rest } = prepared.init;
    const body = encodeBody(rawBody, headers);
    return {
      ...rest,
      method: prepared.method,
      headers,
      ...(body === undefined ? {} : { body }),
    };
  }

  #plan(prepared: PreparedRequest): DryRunResult {
    const built = this.#build(prepared, REDACTED_AUTHORIZATION);
    return {
      dryRun: true,
      request: {
        method: prepared.method,
        url: `${this.#baseUrl}${prepared.path}`,
        headers: Object.fromEntries(new Headers(built.headers).entries()),
        body: prepared.init.body,
      },
    };
  }

  async #send<T>(
    prepared: PreparedRequest,
    authorization: string,
  ): Promise<HighLevelResponse<T>> {
    const built = this.#build(prepared, authorization);
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = built.signal ? AbortSignal.any([built.signal, timeout]) : timeout;
    try {
      const sent = this.#fetch(`${this.#baseUrl}${prepared.path}`, {
        ...built,
        signal,
      });
      const response = await raceAbort(sent, signal);
      await throwIfFailed(response);
      return {
        status: response.status,
        data: (await readJson(response, prepared)) as T,
      };
    } catch (error: unknown) {
      if (!timeout.aborted) throw error;
      const { method, path } = prepared;
      throw new HighLevelTimeoutError({ method, path, timeoutMs: this.#timeoutMs });
    }
  }

  /**
   * List the workflows of a location (official API, `Version: v3`).
   *
   * @param locationId - The location to list.
   * @returns The workflows.
   * @throws Error when the location id is empty.
   */
  async listWorkflows(locationId: string): Promise<WorkflowSummary[]> {
    requireLocationId(locationId);
    const query = new URLSearchParams({ locationId });
    const result = await this.request<WorkflowListResponse>(
      `/workflows/?${query.toString()}`,
      {},
      "v3",
    );
    return result.workflows;
  }

  /**
   * Fetch a location.
   *
   * @param locationId - The location to fetch.
   * @returns The `{ location }` response.
   * @throws Error when the location id is empty.
   */
  async getLocation(locationId: string): Promise<{ location: unknown }> {
    requireLocationId(locationId);
    return this.request<{ location: unknown }>(
      `/locations/${encodeURIComponent(locationId)}`,
    );
  }

  /**
   * List a location's custom fields.
   *
   * @param locationId - The location.
   * @returns The custom fields, or an empty array.
   * @throws Error when the location id is empty.
   */
  async getCustomFields(locationId: string): Promise<CustomField[]> {
    requireLocationId(locationId);
    const result = await this.request<{ customFields?: CustomField[] }>(
      `/locations/${encodeURIComponent(locationId)}/customFields`,
    );
    return result.customFields ?? [];
  }

  /**
   * List a location's custom values.
   *
   * @param locationId - The location.
   * @returns The custom values, or an empty array.
   * @throws Error when the location id is empty.
   */
  async getCustomValues(locationId: string): Promise<unknown[]> {
    requireLocationId(locationId);
    const result = await this.request<{ customValues?: unknown[] }>(
      `/locations/${encodeURIComponent(locationId)}/customValues`,
    );
    return result.customValues ?? [];
  }

  /**
   * List a location's opportunity pipelines.
   *
   * @param locationId - The location.
   * @returns The pipelines, or an empty array.
   * @throws Error when the location id is empty.
   */
  async getPipelines(locationId: string): Promise<Pipeline[]> {
    requireLocationId(locationId);
    const query = new URLSearchParams({ locationId });
    const result = await this.request<{ pipelines?: Pipeline[] }>(
      `/opportunities/pipelines?${query.toString()}`,
    );
    return result.pipelines ?? [];
  }

  /**
   * Search a location's opportunities, one page at a time.
   *
   * @param locationId - The location.
   * @param paging - `limit` (default 20) and the cursor pair `startAfter` + `startAfterId`.
   * @returns One page of opportunities.
   * @throws Error when the location id is empty.
   */
  async searchOpportunities(
    locationId: string,
    paging: PagingOptions = {},
  ): Promise<OpportunitySearchResult> {
    requireLocationId(locationId);
    const query = new URLSearchParams({ location_id: locationId });
    query.set("limit", String(paging.limit ?? 20));
    setCursor(query, paging);
    return this.request<OpportunitySearchResult>(
      `/opportunities/search?${query.toString()}`,
    );
  }

  /**
   * Search a location's conversations, one page at a time (`Version: 2021-04-15`,
   * the only version the route accepts).
   *
   * @param locationId - The location.
   * @param paging - `limit` (default 20) and `startAfter`, sent as the
   *   `startAfterDate` cursor.
   * @returns One page of conversations.
   * @throws Error when the location id is empty.
   */
  async searchConversations(
    locationId: string,
    paging: PagingOptions = {},
  ): Promise<ConversationSearchResult> {
    requireLocationId(locationId);
    const query = new URLSearchParams({ locationId });
    query.set("limit", String(paging.limit ?? 20));
    if (paging.startAfter) query.set("startAfterDate", paging.startAfter);
    return this.request<ConversationSearchResult>(
      `/conversations/search?${query.toString()}`,
      {},
      CONVERSATION_SEARCH_VERSION,
    );
  }

  /**
   * List a location's contacts, one page at a time.
   *
   * @param locationId - The location.
   * @param paging - `limit` (default 20) and the cursor pair `startAfter` + `startAfterId`.
   * @returns One page of contacts.
   * @throws Error when the location id is empty.
   */
  async getContacts(
    locationId: string,
    paging: PagingOptions = {},
  ): Promise<ContactListResult> {
    requireLocationId(locationId);
    const query = new URLSearchParams({ locationId });
    query.set("limit", String(paging.limit ?? 20));
    setCursor(query, paging);
    return this.request<ContactListResult>(`/contacts/?${query.toString()}`);
  }
}

/** Refuse a path that could move the request (and its token) to another host. */
function requireRootedPath(path: string): void {
  if (!path.startsWith("/")) {
    throw new Error('HighLevel request path must start with "/".');
  }
}

/** Set the `startAfter` + `startAfterId` cursor pair, each only when given. */
function setCursor(query: URLSearchParams, paging: PagingOptions): void {
  if (paging.startAfter) query.set("startAfter", paging.startAfter);
  if (paging.startAfterId) query.set("startAfterId", paging.startAfterId);
}

function requireLocationId(locationId: string): void {
  if (!locationId.trim()) {
    throw new Error("A HighLevel location ID is required.");
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object") return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Serialize a plain-object body as JSON and set its Content-Type; pass any other body through. */
function encodeBody(
  body: HighLevelRequestInit["body"],
  headers: Headers,
): RequestInit["body"] {
  if (!isPlainObject(body)) return body;
  headers.set("Content-Type", "application/json");
  return JSON.stringify(body);
}

async function throwIfFailed(response: Response): Promise<void> {
  if (response.ok) return;
  const responseBody = await response.text();
  const contentType = response.headers.get("content-type");
  const { kind, message } = classifyError(response.status, responseBody, contentType);
  throw new HighLevelApiError(message, response.status, responseBody, kind);
}

/** Parse a 2xx body as JSON; `undefined` for `HEAD`, a bodyless status or an empty body. */
async function readJson(
  response: Response,
  prepared: PreparedRequest,
): Promise<unknown> {
  if (prepared.method === "HEAD" || BODYLESS_STATUSES.has(response.status)) {
    return undefined;
  }
  const text = await response.text();
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

/** Reject when `signal` aborts, even if the injected `fetch` ignores the signal. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([promise, aborted]);
}
