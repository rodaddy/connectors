/** Location tags: list, create, ensure-by-name, malformed responses, write guard. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { ACCOUNTS, createClient, type AccountClient } from "../src/accounts.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";
import { createTag, ensureTags, listTags } from "../src/crm/tags.ts";

interface Call {
  method: string;
  path: string;
  version: string | null;
  body?: unknown;
}

const BASE = `/locations/${ACCOUNTS.primary.locationId}/tags`;

/** A client whose fetch records each call and answers from `replies` in order. */
function stub(
  replies: unknown[],
  allowWrites = true,
): { client: AccountClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = createClient({
    account: "primary",
    token: "pit-test",
    allowWrites,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = await request.text();
      calls.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        version: request.headers.get("Version"),
        ...(text ? { body: JSON.parse(text) as unknown } : {}),
      });
      return Response.json(replies[calls.length - 1]);
    },
  });
  return { client, calls };
}

void describe("tags", () => {
  void test("listTags GETs the client's location tags and parses them", async () => {
    const { client, calls } = stub([
      { tags: [{ id: "g1", name: "VIP", locationId: "x" }] },
    ]);
    expect(await listTags(client)).toEqual([{ id: "g1", name: "VIP" }]);
    expect(calls).toEqual([{ method: "GET", path: BASE, version: "2021-07-28" }]);
  });

  void test("createTag POSTs the name and parses the tag", async () => {
    const { client, calls } = stub([{ tag: { id: "g2", name: "new" } }]);
    expect(await createTag(client, "new")).toEqual({ id: "g2", name: "new" });
    expect(calls).toEqual([
      { method: "POST", path: BASE, version: "2021-07-28", body: { name: "new" } },
    ]);
  });

  void test("ensureTags matches case-insensitively and creates only the missing", async () => {
    const { client, calls } = stub([
      { tags: [{ id: "g1", name: "VIP" }] },
      { tag: { id: "g2", name: "li-reply" } },
    ]);
    const results = await ensureTags(client, ["vip", "li-reply", "LI-REPLY"]);
    expect(results).toEqual([
      { tag: { id: "g1", name: "VIP" }, created: false },
      { tag: { id: "g2", name: "li-reply" }, created: true },
      { tag: { id: "g2", name: "li-reply" }, created: false },
    ]);
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(calls[1]?.body).toEqual({ name: "li-reply" });
  });

  void test("a tag without an id throws HighLevelShapeError", async () => {
    const { client } = stub([{ tags: [{ name: "VIP" }] }]);
    await expect(listTags(client)).rejects.toThrow(HighLevelShapeError);
  });

  void test("a write without allowWrites is blocked before fetch", async () => {
    const { client, calls } = stub([], false);
    await expect(createTag(client, "x")).rejects.toThrow(
      "Blocked POST request in read-only mode",
    );
    expect(calls).toEqual([]);
  });
});
