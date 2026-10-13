/** callOperation: resolve from the catalog, fill the path, check query, pick Version. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { createClient } from "../src/accounts.ts";
import { HighLevelClient, type HighLevelRequestInit } from "../src/client/highlevel.ts";
import {
  CallArgumentError,
  callOperation,
  HighLevelDryRunPlanned,
} from "../src/client/call.ts";
import { createNote } from "../src/crm/notes.ts";

interface Seen {
  url?: URL;
  method?: string;
  version?: string | null;
  body?: string;
}

function client(seen: Seen, allowWrites = false): HighLevelClient {
  return new HighLevelClient({
    token: "test-token",
    allowWrites,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      seen.url = new URL(request.url);
      seen.method = request.method;
      seen.version = request.headers.get("Version");
      seen.body = await request.text();
      return Response.json({ ok: true });
    },
  });
}

describe("callOperation", () => {
  test("fills and URL-encodes path params and uses the endpoint's version", async () => {
    const seen: Seen = {};
    await callOperation(
      client(seen),
      { family: "v3", operationId: "get-contact" },
      { pathParams: { contactId: "a/b c" } },
    );
    expect(seen.url?.pathname).toBe("/contacts/a%2Fb%20c");
    expect(seen.version).toBe("v3");
  });

  test("resolves a route, sends query, and honors an explicit version", async () => {
    const seen: Seen = {};
    await callOperation(
      client(seen),
      { method: "GET", path: "/contacts/", family: "v2" },
      { query: { locationId: "loc-1", tags: ["x", "y"] }, version: "2099-01-01" },
    );
    expect(seen.url?.search).toBe("?locationId=loc-1&tags=x&tags=y");
    expect(seen.version).toBe("2099-01-01");
  });

  test("falls back to 2021-07-28 when the endpoint lists no version", async () => {
    const seen: Seen = {};
    await callOperation(
      client(seen),
      { family: "v2", operationId: "get-email-by-id" },
      { pathParams: { id: "e1" } },
    );
    expect(seen.version).toBe("2021-07-28");
  });

  test("prefers the family's own version, listed or not", async () => {
    const seen: Seen = {};
    const c = client(seen);
    await callOperation(
      c,
      { family: "v3", operationId: "getWidget" },
      { pathParams: { id: "w1" } },
    );
    expect(seen.version).toBe("v3");
    await callOperation(
      c,
      { family: "v3", operationId: "get-email-by-id" },
      { pathParams: { id: "e1" } },
    );
    expect(seen.version).toBe("v3");
  });

  test("treats an empty or whitespace path param as missing", async () => {
    const ref = { family: "v3", operationId: "get-contact" } as const;
    for (const contactId of ["", "  "]) {
      await expect(
        callOperation(client({}), ref, { pathParams: { contactId } }),
      ).rejects.toThrow(CallArgumentError);
    }
  });

  test("names a missing path param", async () => {
    await expect(
      callOperation(client({}), { family: "v3", operationId: "get-contact" }),
    ).rejects.toThrow('Missing path parameter "contactId"');
  });

  test("names a missing required query param", async () => {
    await expect(
      callOperation(client({}), { method: "GET", path: "/contacts/", family: "v2" }),
    ).rejects.toThrow("Missing required query parameter(s) locationId");
  });

  test("rejects an unknown operation", async () => {
    await expect(
      callOperation(client({}), { family: "v2", operationId: "no-such-op" }),
    ).rejects.toThrow("Unknown operation v2 no-such-op");
  });

  test("blocks a write without allowWrites and sends it with allowWrites", async () => {
    const ref = { family: "v2", operationId: "create-note" } as const;
    const args = { pathParams: { contactId: "c1" }, body: { body: "hi" } };
    await expect(callOperation(client({}), ref, args)).rejects.toThrow(
      "Blocked POST request in read-only mode",
    );
    const seen: Seen = {};
    await callOperation(client(seen, true), ref, args);
    expect([seen.method, seen.body]).toEqual(["POST", '{"body":"hi"}']);
  });

  test("sends a catalog read-only POST search on a read-only client", async () => {
    const seen: Seen = {};
    const ref = { family: "v2", operationId: "search-contacts-advanced" } as const;
    await callOperation(client(seen), ref, { body: { pageLimit: 1 } });
    expect([seen.method, seen.url?.pathname, seen.body]).toEqual([
      "POST",
      "/contacts/search",
      '{"pageLimit":1}',
    ]);
  });

  test("a dry-run client sends a read-only POST and still plans a write POST", async () => {
    let calls = 0;
    const dry = new HighLevelClient({
      token: "test-token",
      dryRun: true,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ ok: true });
      },
    });
    const search = { family: "v2", operationId: "search-contacts-advanced" } as const;
    expect(await callOperation(dry, search, { body: {} })).toEqual({ ok: true });
    const note = { family: "v2", operationId: "create-note" } as const;
    await expect(
      callOperation(dry, note, { pathParams: { contactId: "c1" } }),
    ).rejects.toThrow(HighLevelDryRunPlanned);
    expect(calls).toBe(1);
  });

  test("a typed helper on a dry-run client rejects with the plan", async () => {
    let calls = 0;
    const dry = createClient({
      account: "primary",
      token: "pit-test",
      dryRun: true,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    const planned = await createNote(dry, { contactId: "c1", body: "hi" }).catch(
      (error: unknown) => error,
    );
    expect(planned).toBeInstanceOf(HighLevelDryRunPlanned);
    const { request } = (planned as HighLevelDryRunPlanned).plan;
    expect([request.method, new URL(request.url).pathname]).toEqual([
      "POST",
      "/contacts/c1/notes",
    ]);
    expect(calls).toBe(0);
  });

  test("a raw request cannot claim readOnly to skip the write guard", async () => {
    let calls = 0;
    const raw = new HighLevelClient({
      token: "test-token",
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ ok: true });
      },
    });
    const init = { method: "POST", readOnly: true } as HighLevelRequestInit;
    await expect(raw.request("/x/search", init)).rejects.toThrow("Blocked POST");
    expect(calls).toBe(0);
  });
});
