/** HighLevelClient hardening: User-Agent, timeout, dry-run plans, token providers. */
import { describe, test } from "node:test";
import { expect } from "expect";

import {
  HighLevelClient,
  isDryRun,
  type HighLevelClientOptions,
} from "../src/client/highlevel.ts";
import { HighLevelTimeoutError } from "../src/core/errors.ts";

/** A client whose fetch records every request it is given. */
function recordingClient(options: Partial<HighLevelClientOptions> = {}): {
  client: HighLevelClient;
  requests: Request[];
} {
  const requests: Request[] = [];
  const client = new HighLevelClient({
    token: "test-token",
    ...options,
    fetchImpl: (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(Response.json({ ok: true }));
    },
  });
  return { client, requests };
}

describe("HighLevelClient User-Agent", () => {
  test("sends the default User-Agent", async () => {
    const { client, requests } = recordingClient();
    await client.request("/locations/location-1");
    expect(requests[0]?.headers.get("User-Agent")).toBe("connectors-highlevel/0.1");
  });

  test("honours a userAgent override", async () => {
    const { client, requests } = recordingClient({ userAgent: "custom/2.0" });
    await client.request("/locations/location-1");
    expect(requests[0]?.headers.get("User-Agent")).toBe("custom/2.0");
  });
});

describe("HighLevelClient timeout", () => {
  test("throws HighLevelTimeoutError when fetch never answers", async () => {
    const client = new HighLevelClient({
      token: "test-token",
      timeoutMs: 20,
      fetchImpl: () => new Promise<Response>(() => undefined),
    });

    const error: unknown = await client.request("/contacts/").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HighLevelTimeoutError);
    expect(error).toMatchObject({ method: "GET", path: "/contacts/", timeoutMs: 20 });
  });

  test("keeps the query string out of the timeout message and path", async () => {
    const client = new HighLevelClient({
      token: "test-token",
      timeoutMs: 20,
      fetchImpl: () => new Promise<Response>(() => undefined),
    });

    const path =
      "/contacts/search/duplicate?email=jane%40example.com&number=6305550199";
    const error: unknown = await client.request(path).catch((e: unknown) => e);
    expect(error).toMatchObject({
      path: "/contacts/search/duplicate",
      message: "HighLevel GET /contacts/search/duplicate timed out after 20 ms.",
    });
  });
});

describe("HighLevelClient dry-run", () => {
  const expectedPlan = {
    dryRun: true,
    request: {
      method: "POST",
      url: "https://services.leadconnectorhq.com/contacts/",
      headers: expect.objectContaining({
        authorization: "Bearer <redacted>",
      }) as unknown,
      body: { firstName: "Test" },
    },
  };

  test("a dryRun client plans a write without allowWrites and never fetches", async () => {
    const { client, requests } = recordingClient({ dryRun: true });
    const plan = await client.request("/contacts/", {
      method: "POST",
      body: { firstName: "Test" },
    });

    expect(plan).toEqual(expectedPlan);
    expect(JSON.stringify(plan)).not.toContain("test-token");
    expect(requests).toHaveLength(0);
  });

  test("a dryRun client still sends reads", async () => {
    const { client, requests } = recordingClient({ dryRun: true });
    await expect(client.request("/locations/location-1")).resolves.toEqual({
      ok: true,
    });
    expect(requests).toHaveLength(1);
  });

  test("a per-call dryRun plans the request and never fetches", async () => {
    const { client, requests } = recordingClient();
    const plan = await client.request("/contacts/", {
      method: "POST",
      body: { firstName: "Test" },
      dryRun: true,
    });

    expect(isDryRun(plan)).toBe(true);
    expect(plan).toEqual(expectedPlan);
    expect(JSON.stringify(plan)).not.toContain("test-token");
    expect(requests).toHaveLength(0);
  });
});

describe("HighLevelClient token provider", () => {
  test("calls a sync provider on every request", async () => {
    let calls = 0;
    const { client, requests } = recordingClient({
      token: () => `sync-token-${++calls}`,
    });
    await client.request("/locations/location-1");
    await client.request("/locations/location-1");

    expect(requests.map((r) => r.headers.get("Authorization"))).toEqual([
      "Bearer sync-token-1",
      "Bearer sync-token-2",
    ]);
  });

  test("awaits an async provider on every request", async () => {
    let calls = 0;
    const token = (): Promise<string> => Promise.resolve(`async-token-${++calls}`);
    const { client, requests } = recordingClient({ token });
    await client.request("/locations/location-1");
    await client.request("/locations/location-1");

    expect(requests.map((r) => r.headers.get("Authorization"))).toEqual([
      "Bearer async-token-1",
      "Bearer async-token-2",
    ]);
  });

  test("rejects a provider that returns an empty token", async () => {
    const { client, requests } = recordingClient({ token: () => " " });
    await expect(client.request("/locations/location-1")).rejects.toThrow(
      "A HighLevel access token is required.",
    );
    expect(requests).toHaveLength(0);
  });
});
