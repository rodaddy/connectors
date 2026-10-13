/** HighLevelClient: read-only guard, headers, JSON body, Version override, errors. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { HighLevelApiError, HighLevelClient } from "../src/client/highlevel.ts";

interface Observed {
  request?: Request;
  body?: string;
}

/** A client whose fetch records the request and answers with `response`. */
function recordingClient(
  observed: Observed,
  options: { allowWrites?: boolean; response?: () => Response } = {},
): HighLevelClient {
  return new HighLevelClient({
    token: "test-token",
    allowWrites: options.allowWrites ?? false,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      observed.request = request;
      observed.body = await request.text();
      return options.response?.() ?? Response.json({ ok: true });
    },
  });
}

describe("HighLevelClient", () => {
  test("rejects an empty token", () => {
    expect(() => new HighLevelClient({ token: " " })).toThrow(
      "A HighLevel access token is required.",
    );
  });

  test("blocks mutations by default", async () => {
    const client = new HighLevelClient({
      token: "test-token",
      fetchImpl: () => Promise.reject(new Error("fetch must not run")),
    });

    await expect(client.request("/contacts/", { method: "POST" })).rejects.toThrow(
      "Blocked POST request in read-only mode",
    );
  });

  test("lists workflows with the v3 header", async () => {
    let observedUrl = "";
    let observedAuthorization = "";
    let observedVersion = "";
    const client = new HighLevelClient({
      token: "test-token",
      fetchImpl: (input, init) => {
        const request = new Request(input, init);
        observedUrl = request.url;
        observedAuthorization = request.headers.get("Authorization") ?? "";
        observedVersion = request.headers.get("Version") ?? "";
        return Promise.resolve(Response.json({ workflows: [] }));
      },
    });

    await expect(client.listWorkflows("location-1")).resolves.toEqual([]);
    expect(observedUrl).toBe(
      "https://services.leadconnectorhq.com/workflows/?locationId=location-1",
    );
    expect(observedAuthorization).toBe("Bearer test-token");
    expect(observedVersion).toBe("v3");
  });

  test("allows a write when built with allowWrites: true", async () => {
    const observed: Observed = {};
    const client = recordingClient(observed, { allowWrites: true });

    await expect(client.request("/contacts/", { method: "post" })).resolves.toEqual({
      ok: true,
    });
    expect(observed.request?.method).toBe("POST");
  });

  test("sends a plain-object body as JSON with Content-Type", async () => {
    const observed: Observed = {};
    const client = recordingClient(observed, { allowWrites: true });

    await client.request("/contacts/", {
      method: "POST",
      body: { firstName: "Test", tags: ["a"] },
    });
    expect(observed.request?.headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(observed.body ?? "")).toEqual({ firstName: "Test", tags: ["a"] });
  });

  test("passes a string body through untouched", async () => {
    const observed: Observed = {};
    const client = recordingClient(observed, { allowWrites: true });

    await client.request("/contacts/", {
      method: "POST",
      body: "raw=1",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(observed.body).toBe("raw=1");
    expect(observed.request?.headers.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
  });

  test("defaults Version to 2021-07-28 and honours a per-call override", async () => {
    const observed: Observed = {};
    const client = recordingClient(observed);

    await client.request("/locations/location-1");
    expect(observed.request?.headers.get("Version")).toBe("2021-07-28");
    await client.request("/locations/location-1", {}, "2099-01-01");
    expect(observed.request?.headers.get("Version")).toBe("2099-01-01");
    expect(observed.request?.headers.get("Accept")).toBe("application/json");
  });

  test("a failed response throws HighLevelApiError with status, body and kind", async () => {
    const client = recordingClient(
      {},
      { response: () => new Response('{"message":"nope"}', { status: 422 }) },
    );

    const error: unknown = await client.request("/contacts/").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HighLevelApiError);
    expect(error).toMatchObject({
      name: "HighLevelApiError",
      status: 422,
      responseBody: '{"message":"nope"}',
      kind: "validation",
      message: "HighLevel rejected the request as invalid (status 422): nope",
    });
  });

  test("redacts phone numbers and emails from the error message, keeps the raw body", async () => {
    const body =
      '{"message":"Invalid To number +1 (630) 555-0199 for jane.doe@example.com"}';
    const client = recordingClient(
      {},
      { response: () => new Response(body, { status: 400 }) },
    );

    const error: unknown = await client.request("/contacts/").catch((e: unknown) => e);
    expect(error).toMatchObject({
      message:
        "HighLevel rejected the request as invalid (status 400): Invalid To number [redacted] for [redacted]",
      responseBody: body,
    });
  });

  test("refuses a path that does not start with / before fetch", async () => {
    const observed: Observed = {};
    const client = recordingClient(observed);

    await expect(client.request(".attacker.example/x")).rejects.toThrow(
      'HighLevel request path must start with "/".',
    );
    expect(observed.request).toBeUndefined();
  });

  test("returns undefined for HEAD and for a 204 or empty 2xx body", async () => {
    const responses = [
      () => new Response(null, { status: 204 }),
      () => new Response("", { status: 200 }),
    ];
    for (const response of responses) {
      const client = recordingClient({}, { allowWrites: true, response });
      await expect(client.request("/contacts/c1", { method: "DELETE" })).resolves.toBe(
        undefined,
      );
    }
    const head = recordingClient(
      {},
      { response: () => new Response("{", { status: 200 }) },
    );
    await expect(head.request("/contacts/", { method: "HEAD" })).resolves.toBe(
      undefined,
    );
  });
});

describe("HighLevelClient legacy helpers", () => {
  test("encode the location id in the path", async () => {
    const observed: Observed = {};
    const client = recordingClient(observed);

    await client.getLocation("a/b?c");
    expect(observed.request?.url).toBe(
      "https://services.leadconnectorhq.com/locations/a%2Fb%3Fc",
    );
    await client.getCustomFields("a/b");
    expect(observed.request?.url).toBe(
      "https://services.leadconnectorhq.com/locations/a%2Fb/customFields",
    );
    await client.getCustomValues("a/b");
    expect(observed.request?.url).toBe(
      "https://services.leadconnectorhq.com/locations/a%2Fb/customValues",
    );
  });

  test("searchConversations sends Version 2021-04-15 and the startAfterDate cursor", async () => {
    const observed: Observed = {};
    const client = recordingClient(observed);

    await client.searchConversations("loc-1", {
      limit: 5,
      startAfter: "1700000000000",
    });
    expect(observed.request?.url).toBe(
      "https://services.leadconnectorhq.com/conversations/search?locationId=loc-1&limit=5&startAfterDate=1700000000000",
    );
    expect(observed.request?.headers.get("Version")).toBe("2021-04-15");
  });

  test("searchOpportunities and getContacts forward startAfter and startAfterId", async () => {
    const observed: Observed = {};
    const client = recordingClient(observed);
    const paging = { limit: 2, startAfter: "1700000000000", startAfterId: "x1" };

    await client.searchOpportunities("loc-1", paging);
    expect(observed.request?.url).toBe(
      "https://services.leadconnectorhq.com/opportunities/search?location_id=loc-1&limit=2&startAfter=1700000000000&startAfterId=x1",
    );
    await client.getContacts("loc-1", paging);
    expect(observed.request?.url).toBe(
      "https://services.leadconnectorhq.com/contacts/?locationId=loc-1&limit=2&startAfter=1700000000000&startAfterId=x1",
    );
  });
});
