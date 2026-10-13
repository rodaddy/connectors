/**
 * Account profiles and the account guard: a client built for one account
 * refuses any request that names another account's location (D4).
 *
 * @module
 */

import {
  HighLevelClient,
  type HighLevelClientOptions,
  type HighLevelRequestInit,
  type HighLevelResponse,
} from "./client/highlevel.ts";
import { TEMPLATE_LOCATIONS } from "./client/read-intent.ts";

/**
 * The GoHighLevel accounts this package knows. Edit this union and
 * {@link ACCOUNTS} to list your own sub-accounts (locations).
 */
export type AccountName = "primary" | "secondary";

/** One account's location and a display label. */
export interface AccountProfile {
  locationId: string;
  label: string;
}

/**
 * The account profiles. Tokens are never stored here; callers pass them in.
 * The location ids below are placeholders: replace them with your own.
 */
export const ACCOUNTS: Record<AccountName, AccountProfile> = {
  primary: {
    locationId: "PrimaryLocation00001",
    label: "Primary account",
  },
  secondary: {
    locationId: "SecondaryLocation001",
    label: "Secondary account",
  },
};

/** Query parameters and body fields that carry a location id. */
const LOCATION_KEYS = ["locationId", "location_id", "altId"] as const;
/** For a raw request (no endpoint template): path segments whose next segment is a location id. */
const LOCATION_PATH_PREFIXES = new Set(["locations", "location"]);

/** A request named a location that belongs to a different account than the client's. */
export class AccountMismatchError extends Error {
  /** The account the client was built for. */
  readonly account: AccountName;
  /** The location the request named. */
  readonly requestedLocationId: string;

  /**
   * @param account - The account the client was built for.
   * @param requestedLocationId - The location the request named.
   */
  constructor(account: AccountName, requestedLocationId: string) {
    const owner = accountForLocation(requestedLocationId) ?? "an unknown account";
    super(
      `Account mismatch: this client is for ${account} (${ACCOUNTS[account].locationId}) but the request names location ${requestedLocationId}, which belongs to ${owner}. Never use one account's token against another account's location.`,
    );
    this.name = "AccountMismatchError";
    this.account = account;
    this.requestedLocationId = requestedLocationId;
  }
}

/** Options for {@link createClient}: the client options plus the account it is for. */
export type CreateClientOptions = HighLevelClientOptions & {
  /** The account whose token this is; fixes the client's location. */
  account: AccountName;
};

/** A {@link HighLevelClient} bound to one account; every request is checked against its location. */
export class AccountClient extends HighLevelClient {
  /** The account this client is for. */
  readonly account: AccountName;
  /** The account's location id, for helpers that need a location. */
  readonly locationId: string;

  /**
   * @param options - Client options plus the account.
   * @throws Error when the account name is unknown.
   */
  constructor(options: CreateClientOptions) {
    const { account, ...clientOptions } = options;
    const profile = profileFor(account);
    super(clientOptions);
    this.account = account;
    this.locationId = profile.locationId;
  }

  /**
   * Send one request after checking every location it carries. `request`
   * goes through here too, so both entry points are guarded.
   *
   * For a `callOperation` request the path check uses the endpoint template's
   * `{locationId}`/`{location_id}`/`{altId}` params, wherever they sit.
   *
   * @throws AccountMismatchError when the path, query or body names another location; fetch does not run.
   */
  override async requestWithStatus<T>(
    path: string,
    init: HighLevelRequestInit = {},
    apiVersion?: string,
  ): Promise<HighLevelResponse<T>> {
    for (const locationId of locationsIn(path, init)) {
      if (locationId !== this.locationId) {
        throw new AccountMismatchError(this.account, locationId);
      }
    }
    return super.requestWithStatus<T>(path, init, apiVersion);
  }
}

/**
 * Build a client for one account, its location fixed from the profile.
 *
 * @param options - The account, its token, and the usual client options.
 * @returns The account-bound client.
 * @throws Error when the account name is unknown.
 */
export function createClient(options: CreateClientOptions): AccountClient {
  return new AccountClient(options);
}

function profileFor(account: string): AccountProfile {
  if (!Object.hasOwn(ACCOUNTS, account)) {
    throw new Error(`Unknown HighLevel account: ${account}.`);
  }
  return ACCOUNTS[account as AccountName];
}

function accountForLocation(locationId: string): AccountName | undefined {
  const names = Object.keys(ACCOUNTS) as AccountName[];
  return names.find((name) => ACCOUNTS[name].locationId === locationId);
}

/**
 * Every location id a request carries, in its path, query and body. A
 * `callOperation` request names its path locations from the endpoint
 * template; a raw request falls back to the segment after `locations`.
 */
function locationsIn(path: string, init: HighLevelRequestInit): string[] {
  const url = new URL(path, "https://guard.invalid");
  const fromPath = TEMPLATE_LOCATIONS.get(init) ?? locationsAfterPrefix(url.pathname);
  const fromQuery = LOCATION_KEYS.flatMap((key) => url.searchParams.getAll(key));
  return [...fromPath, ...fromQuery, ...locationsInBody(init.body)].filter(Boolean);
}

function locationsAfterPrefix(pathname: string): string[] {
  const segments = pathname.split("/").map((segment) => decodeURIComponent(segment));
  return segments.filter(
    (_, index) => index > 0 && LOCATION_PATH_PREFIXES.has(segments[index - 1] ?? ""),
  );
}

function locationsInBody(body: HighLevelRequestInit["body"]): string[] {
  const fields = typeof body === "string" ? parseJsonObject(body) : body;
  if (fields === null || typeof fields !== "object" || !isRecord(fields)) return [];
  return LOCATION_KEYS.map((key) => fields[key]).filter(
    (value): value is string => typeof value === "string",
  );
}

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isRecord(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
