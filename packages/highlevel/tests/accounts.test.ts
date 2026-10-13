/** Account profiles and the account guard: another account's location never reaches fetch. */
import { describe, test } from "node:test";
import { expect } from "expect";

import {
  ACCOUNTS,
  AccountClient,
  AccountMismatchError,
  createClient,
} from "../src/accounts.ts";
import { callOperation } from "../src/client/call.ts";

const PRIMARY = ACCOUNTS.primary.locationId;
const SECONDARY = ACCOUNTS.secondary.locationId;

/** A primary-account client whose fetch counts calls and answers `{}`. */
function primaryClient(calls: string[]): AccountClient {
  return createClient({
    account: "primary",
    token: "test-token",
    allowWrites: true,
    fetchImpl: (input) => {
      calls.push(new Request(input).url);
      return Promise.resolve(Response.json({}));
    },
  });
}

describe("createClient", () => {
  test("fixes the account and location from the profile", () => {
    const client = primaryClient([]);
    expect(client.account).toBe("primary");
    expect(client.locationId).toBe(PRIMARY);
  });

  test("rejects an unknown account at the type level and at runtime", () => {
    expect(() =>
      // @ts-expect-error -- "acme" is not an AccountName.
      createClient({ account: "acme", token: "test-token" }),
    ).toThrow("Unknown HighLevel account: acme.");
  });
});

describe("the account guard", () => {
  const otherLocationRequests: Array<[string, string, object?]> = [
    ["query locationId", `/contacts/?locationId=${SECONDARY}`],
    ["query location_id", `/opportunities/search?location_id=${SECONDARY}`],
    ["query altId", `/forms/?altId=${SECONDARY}&altType=location`],
    ["path segment", `/locations/${SECONDARY}/customFields`],
    ["body field", "/contacts/", { locationId: SECONDARY, firstName: "Test" }],
  ];

  for (const [where, path, body] of otherLocationRequests) {
    test(`rejects the other account's location in the ${where} before fetch`, async () => {
      const calls: string[] = [];
      const init = body === undefined ? {} : { method: "POST", body: { ...body } };
      await expect(primaryClient(calls).request(path, init)).rejects.toThrow(
        AccountMismatchError,
      );
      expect(calls).toEqual([]);
    });
  }

  test("names both accounts in the error", async () => {
    await expect(primaryClient([]).getPipelines(SECONDARY)).rejects.toThrow(
      /for primary .* belongs to secondary/,
    );
  });

  test("rejects a location in a JSON string body", async () => {
    const calls: string[] = [];
    const body = JSON.stringify({ locationId: SECONDARY });
    await expect(
      primaryClient(calls).request("/contacts/", { method: "POST", body }),
    ).rejects.toThrow(AccountMismatchError);
    expect(calls).toEqual([]);
  });

  test("passes the client's own location in query, path and body", async () => {
    const calls: string[] = [];
    const client = primaryClient(calls);
    await client.getContacts(client.locationId);
    await client.getCustomFields(client.locationId);
    await client.request("/contacts/", {
      method: "POST",
      body: { locationId: PRIMARY },
    });
    expect(calls).toHaveLength(3);
  });

  test("rejects the other account's location in any {locationId} path segment", async () => {
    const calls: string[] = [];
    const ref = { family: "v2", operationId: "create-post" } as const;
    const args = { pathParams: { locationId: SECONDARY }, body: { summary: "x" } };
    await expect(callOperation(primaryClient(calls), ref, args)).rejects.toThrow(
      AccountMismatchError,
    );
    expect(calls).toEqual([]);
  });

  test("reads location ids from the template, not literal or other segments", async () => {
    const calls: string[] = [];
    const client = primaryClient(calls);
    await callOperation(client, { family: "v2", operationId: "search-locations" });
    await callOperation(
      client,
      { family: "v3", operationId: "get-service-location-by-id" },
      { pathParams: { serviceLocationId: "svc-1" } },
    );
    await callOperation(
      client,
      { family: "v2", operationId: "create-post" },
      { pathParams: { locationId: PRIMARY }, body: {} },
    );
    expect(calls.map((url) => new URL(url).pathname)).toEqual([
      "/locations/search",
      "/calendars/services/locations/svc-1",
      `/social-media-posting/${PRIMARY}/posts`,
    ]);
  });
});
