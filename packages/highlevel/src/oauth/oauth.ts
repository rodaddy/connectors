/**
 * GoHighLevel Marketplace OAuth: the authorize URL, the code exchange, the
 * refresh, and the agency-to-location token. These calls run before a client
 * has a token, so they post form bodies with `fetch` directly.
 *
 * @module
 */

import type { FetchLike } from "../client/highlevel.ts";
import {
  asShape,
  HighLevelShapeError,
  readOptionalString,
  readString,
  type Shape,
} from "../crm/shape.ts";

const MARKETPLACE_URL = "https://marketplace.gohighlevel.com";
const API_BASE_URL = "https://services.leadconnectorhq.com";
// Cloudflare answers error 1010 to a default client User-Agent (as in client/highlevel.ts).
const USER_AGENT = "connectors-highlevel/0.1";
// O02: an earlier auditor gives the token endpoint 10 s.
const TIMEOUT_MS = 10_000;
// Catalog get-location-access-token apiVersions.
const LOCATION_TOKEN_VERSION = "2021-07-28";

/** Who a token acts for: an agency (Company) or one sub-account (Location). */
export type UserType = "Company" | "Location";

/** Tokens GHL issued, parsed. */
export interface OAuthTokens {
  /** Bearer token for API calls. */
  accessToken: string;
  /** Single-use: GHL rotates it on every refresh. */
  refreshToken: string;
  /** When `accessToken` expires, in ms since the epoch. */
  expiresAt: number;
  /** Space-separated granted scopes. */
  scope: string;
  userType: UserType;
  locationId?: string;
  companyId?: string;
  userId?: string;
}

/**
 * A location token minted from an agency token. GHL's response
 * (`GetLocationAccessTokenSuccessfulResponseDto`) carries no refresh token:
 * mint a new one from the agency token when it expires.
 */
export type LocationAccessToken = Omit<OAuthTokens, "refreshToken">;

/** GHL refused or failed an OAuth request. The message never carries a secret or a body. */
export class HighLevelOAuthError extends Error {
  /** The HTTP status, when GHL answered. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "HighLevelOAuthError";
    this.status = status;
  }
}

/** The client credentials every token request sends. */
export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  userType?: UserType;
  fetchImpl?: FetchLike;
}

/**
 * Build the Marketplace authorize (choose-location) URL.
 * Same URL as the official SDK (`ghl-sdk dist/lib/code/oauth/oauth.js:18-25`),
 * plus `state` and the optional `version_id` (O01, an earlier auditor `src/oauth.ts:25-36`).
 */
export function authorizeUrl(options: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  versionId?: string;
  baseUrl?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    scope: options.scopes.join(" "),
    state: options.state,
  });
  if (options.versionId !== undefined) params.set("version_id", options.versionId);
  return `${options.baseUrl ?? MARKETPLACE_URL}/oauth/chooselocation?${params.toString()}`;
}

/** Exchange an authorization code for tokens (catalog get-access-token, `POST /oauth/token`). */
export async function exchangeCode(
  options: ClientCredentials & { code: string; redirectUri: string },
): Promise<OAuthTokens> {
  const body = await tokenGrant(options, {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
  });
  return parseTokens(body, options.userType ?? "Location");
}

/**
 * Refresh tokens (catalog get-access-token, `POST /oauth/token`). GHL rotates
 * refresh tokens: the returned `refreshToken` replaces the old one, which is
 * dead after this call. Persist the result before using it. `userType` is
 * required: pass the stored token's (`tokens.userType`), so a Company token is
 * never refreshed as a Location one.
 */
export async function refreshTokens(
  options: ClientCredentials & { refreshToken: string; userType: UserType },
): Promise<OAuthTokens> {
  const body = await tokenGrant(options, {
    grant_type: "refresh_token",
    refresh_token: options.refreshToken,
  });
  return parseTokens(body, options.userType);
}

/**
 * Mint a location token from an agency token (catalog get-location-access-token).
 * @throws {HighLevelShapeError} when the access token or `expires_in` is missing.
 */
export async function locationToken(options: {
  agencyAccessToken: string;
  companyId: string;
  locationId: string;
  fetchImpl?: FetchLike;
}): Promise<LocationAccessToken> {
  const body = await postForm({
    path: "/oauth/locationToken",
    form: { companyId: options.companyId, locationId: options.locationId },
    headers: {
      Authorization: `Bearer ${options.agencyAccessToken}`,
      Version: LOCATION_TOKEN_VERSION,
    },
    fetchImpl: options.fetchImpl ?? fetch,
  });
  return parseAccess(asShape(body, "token"), "Location");
}

/** `POST /oauth/token` with the client credentials plus one grant; resolves the raw body. */
function tokenGrant(
  options: ClientCredentials,
  grant: Record<string, string>,
): Promise<unknown> {
  const form = {
    client_id: options.clientId,
    client_secret: options.clientSecret,
    user_type: options.userType ?? "Location",
    ...grant,
  };
  return postForm({
    path: "/oauth/token",
    form,
    fetchImpl: options.fetchImpl ?? fetch,
  });
}

interface FormRequest {
  path: string;
  form: Record<string, string>;
  headers?: Record<string, string>;
  fetchImpl: FetchLike;
}

/** POST a form body; resolves the parsed JSON for the caller's own parser. */
async function postForm(request: FormRequest): Promise<unknown> {
  let response: Response;
  try {
    response = await request.fetchImpl(`${API_BASE_URL}${request.path}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
        ...request.headers,
      },
      body: new URLSearchParams(request.form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.name : "unknown";
    throw new HighLevelOAuthError(`HighLevel POST ${request.path} failed: ${reason}.`);
  }
  if (!response.ok) {
    throw new HighLevelOAuthError(
      `HighLevel POST ${request.path} answered ${response.status}.`,
      response.status,
    );
  }
  return response.json();
}

/** @returns `value` when it is a {@link UserType}, else `undefined`. */
export function asUserType(value: unknown): UserType | undefined {
  return value === "Company" || value === "Location" ? value : undefined;
}

/** Copy the optional `locationId`/`companyId`/`userId` strings from `shape` onto `tokens`. */
export function withIds<T extends LocationAccessToken>(tokens: T, shape: Shape): T {
  for (const id of ["locationId", "companyId", "userId"] as const) {
    const value = readOptionalString(shape, id);
    if (value !== undefined) tokens[id] = value;
  }
  return tokens;
}

/**
 * Parse the fields every token response shares (no refresh token).
 * @throws {HighLevelShapeError} when the access token or `expires_in` is missing.
 */
function parseAccess(shape: Shape, fallbackUserType: UserType): LocationAccessToken {
  const expiresIn = shape["expires_in"];
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn))
    throw new HighLevelShapeError("token.expires_in", "a number");
  const access: LocationAccessToken = {
    accessToken: readString(shape, "access_token", "token"),
    expiresAt: Date.now() + Math.max(0, expiresIn) * 1000,
    scope: readOptionalString(shape, "scope") ?? "",
    userType: asUserType(shape["userType"]) ?? fallbackUserType,
  };
  return withIds(access, shape);
}

/**
 * Parse a `/oauth/token` response.
 * @throws {HighLevelShapeError} when a token or `expires_in` is missing.
 */
function parseTokens(body: unknown, fallbackUserType: UserType): OAuthTokens {
  const shape = asShape(body, "token");
  const refreshToken = readString(shape, "refresh_token", "token");
  return { ...parseAccess(shape, fallbackUserType), refreshToken };
}
