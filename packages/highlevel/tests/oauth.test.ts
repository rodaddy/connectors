/** OAuth: authorize URL, form-encoded token calls, parsing, secret-free errors. */
import { describe, test } from "node:test";
import { expect } from "expect";

import {
  authorizeUrl,
  exchangeCode,
  HighLevelOAuthError,
  locationToken,
  refreshTokens,
  type OAuthTokens,
} from "../src/oauth/oauth.ts";
import type { FetchLike } from "../src/client/highlevel.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";

const SECRET = "fake-client-secret";
const TOKEN_BODY = {
  access_token: "fake-access",
  refresh_token: "fake-refresh-2",
  expires_in: 86_399,
  scope: "contacts.readonly",
  userType: "Location",
  locationId: "loc-1",
  companyId: "co-1",
  userId: "user-1",
};

interface Recorded {
  request?: Request;
  form?: URLSearchParams;
}

/** A fetch that records the request and answers `body` with `status`. */
function stubFetch(seen: Recorded, body: unknown, status = 200): FetchLike {
  return async (input, init) => {
    seen.request = new Request(input, init);
    seen.form = new URLSearchParams(await seen.request.text());
    return Response.json(body, { status });
  };
}

describe("authorizeUrl", () => {
  test("builds the choose-location URL with code, scopes, state and version", () => {
    const url = new URL(
      authorizeUrl({
        clientId: "client-1",
        redirectUri: "https://example.test/cb",
        scopes: ["contacts.readonly", "locations.readonly"],
        state: "state-1",
        versionId: "ver-1",
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://marketplace.gohighlevel.com/oauth/chooselocation",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "https://example.test/cb",
      scope: "contacts.readonly locations.readonly",
      state: "state-1",
      version_id: "ver-1",
    });
  });
});

/** Exchange `code-1` for tokens through `fetchImpl`. */
function exchange(fetchImpl: FetchLike): Promise<OAuthTokens> {
  return exchangeCode({
    clientId: "client-1",
    clientSecret: SECRET,
    code: "code-1",
    redirectUri: "https://example.test/cb",
    fetchImpl,
  });
}

describe("exchangeCode", () => {
  test("posts the authorization_code form and parses the tokens", async () => {
    const seen: Recorded = {};
    const before = Date.now();
    const { expiresAt, ...rest } = await exchange(stubFetch(seen, TOKEN_BODY));
    expect(seen.request?.method).toBe("POST");
    expect(seen.request?.url).toBe("https://services.leadconnectorhq.com/oauth/token");
    expect(seen.request?.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(Object.fromEntries(seen.form ?? [])).toEqual({
      client_id: "client-1",
      client_secret: SECRET,
      user_type: "Location",
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://example.test/cb",
    });
    expect(rest).toEqual({
      accessToken: "fake-access",
      refreshToken: "fake-refresh-2",
      scope: "contacts.readonly",
      userType: "Location",
      locationId: "loc-1",
      companyId: "co-1",
      userId: "user-1",
    });
    expect(expiresAt).toBeGreaterThanOrEqual(before + 86_399_000);
  });

  const failures: Array<[string, FetchLike, number | undefined]> = [
    [
      "an error status",
      stubFetch({}, { error: "invalid_grant", echo: SECRET }, 401),
      401,
    ],
    [
      "a network failure",
      () => Promise.reject(new TypeError(`failed ${SECRET}`)),
      undefined,
    ],
  ];
  for (const [what, fetchImpl, status] of failures) {
    test(`${what} throws without the secret or the response body`, async () => {
      const error: unknown = await exchange(fetchImpl).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(HighLevelOAuthError);
      expect((error as HighLevelOAuthError).status).toBe(status);
      expect(String(error)).not.toContain(SECRET);
      expect(String(error)).not.toContain("invalid_grant");
    });
  }

  test("a response without a refresh token throws HighLevelShapeError", async () => {
    const { refresh_token: _dropped, ...partial } = TOKEN_BODY;
    await expect(exchange(stubFetch({}, partial))).rejects.toThrow(HighLevelShapeError);
  });
});

describe("refreshTokens", () => {
  test("posts the refresh_token form with the requested user type", async () => {
    const seen: Recorded = {};
    const tokens = await refreshTokens({
      clientId: "client-1",
      clientSecret: SECRET,
      refreshToken: "fake-refresh-1",
      userType: "Company",
      fetchImpl: stubFetch(seen, { ...TOKEN_BODY, userType: undefined }),
    });
    expect(seen.request?.url).toBe("https://services.leadconnectorhq.com/oauth/token");
    expect(Object.fromEntries(seen.form ?? [])).toEqual({
      client_id: "client-1",
      client_secret: SECRET,
      user_type: "Company",
      grant_type: "refresh_token",
      refresh_token: "fake-refresh-1",
    });
    expect(tokens.refreshToken).toBe("fake-refresh-2");
    expect(tokens.userType).toBe("Company");
  });
});

describe("locationToken", () => {
  test("posts companyId and locationId with the agency bearer and Version", async () => {
    const seen: Recorded = {};
    const tokens = await locationToken({
      agencyAccessToken: "fake-agency",
      companyId: "co-1",
      locationId: "loc-1",
      fetchImpl: stubFetch(seen, TOKEN_BODY),
    });
    expect(seen.request?.method).toBe("POST");
    expect(seen.request?.url).toBe(
      "https://services.leadconnectorhq.com/oauth/locationToken",
    );
    expect(seen.request?.headers.get("authorization")).toBe("Bearer fake-agency");
    expect(seen.request?.headers.get("version")).toBe("2021-07-28");
    expect(Object.fromEntries(seen.form ?? [])).toEqual({
      companyId: "co-1",
      locationId: "loc-1",
    });
    expect(tokens.locationId).toBe("loc-1");
  });
});

describe("locationToken response", () => {
  test("parses the location-token schema, which has no refresh token", async () => {
    // Shape of GetLocationAccessTokenSuccessfulResponseDto (oauth.json).
    const body = {
      access_token: "fake-location-access",
      token_type: "Bearer",
      expires_in: 86_399,
      scope: "contacts.readonly",
      locationId: "loc-1",
      planId: "plan-1",
      userId: "user-1",
      appId: "app-1",
      versionId: "ver-1",
    };
    const { expiresAt, ...rest } = await locationToken({
      agencyAccessToken: "fake-agency",
      companyId: "co-1",
      locationId: "loc-1",
      fetchImpl: stubFetch({}, body),
    });
    expect(rest).toEqual({
      accessToken: "fake-location-access",
      scope: "contacts.readonly",
      userType: "Location",
      locationId: "loc-1",
      userId: "user-1",
    });
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  test("refreshTokens requires the stored token's userType", () => {
    const options = { clientId: "c", clientSecret: SECRET, refreshToken: "r" };
    // @ts-expect-error userType is required so a Company token is never refreshed as Location.
    const call = (): Promise<OAuthTokens> => refreshTokens(options);
    expect(typeof call).toBe("function");
  });
});
