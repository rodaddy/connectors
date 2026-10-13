/** Contact helpers: request shape (method, URL, body, Version) and response parsing. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { ACCOUNTS, createClient, type AccountClient } from "../src/accounts.ts";
import {
  addContactTags,
  ContactInputError,
  createContact,
  getContact,
  listContacts,
  removeContactTags,
  searchContacts,
  updateContact,
  upsertContact,
} from "../src/crm/contacts.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";

const LOCATION = ACCOUNTS.primary.locationId;
const EMAIL = "ada@example.test";
const RAW = {
  id: "c1",
  firstName: "Ada",
  lastName: "Byron",
  tags: ["a"],
  email: EMAIL,
};
const PARSED = { ...RAW, name: "Ada Byron" };

/** What the stubbed fetch saw: `"METHOD /path?query"`, the Version header and the JSON body. */
interface Seen {
  request?: string;
  version?: string | null;
  body?: unknown;
}

function stub(
  reply: unknown,
  allowWrites = true,
): { client: AccountClient; seen: Seen[] } {
  const seen: Seen[] = [];
  const client = createClient({
    account: "primary",
    token: "pit-test",
    allowWrites,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = await request.text();
      seen.push({
        request: `${request.method} ${url.pathname}${url.search}`,
        version: request.headers.get("Version"),
        body: text ? JSON.parse(text) : undefined,
      });
      return Response.json(reply);
    },
  });
  return { client, seen };
}

function sent(request: string, body?: unknown): Seen[] {
  return [{ request, version: "2021-07-28", body }];
}

void describe("contacts", () => {
  void test("searchContacts posts locationId, pageLimit 20, query, page; reads total", async () => {
    const { client, seen } = stub({ contacts: [RAW], total: 7 });
    const result = await searchContacts(client, { query: "ada", page: 2 });
    const body = { locationId: LOCATION, pageLimit: 20, query: "ada", page: 2 };
    expect(seen).toEqual(sent("POST /contacts/search", body));
    expect(result).toEqual({ contacts: [PARSED], total: 7 });
  });

  void test("searchContacts sends its POST on a client without allowWrites", async () => {
    const { client, seen } = stub({ contacts: [RAW] }, false);
    expect(await searchContacts(client)).toEqual({ contacts: [PARSED] });
    const body = { locationId: LOCATION, pageLimit: 20 };
    expect(seen).toEqual(sent("POST /contacts/search", body));
  });

  void test("getContact prefers contactName for name", async () => {
    const { client, seen } = stub({ contact: { ...RAW, contactName: "ada b" } });
    expect(await getContact(client, "c1")).toEqual({ ...PARSED, name: "ada b" });
    expect(seen).toEqual(sent("GET /contacts/c1"));
  });

  void test("createContact adds locationId to the body", async () => {
    const { client, seen } = stub({ contact: RAW });
    expect(await createContact(client, { firstName: "Ada" })).toEqual(PARSED);
    expect(seen).toEqual(
      sent("POST /contacts/", { firstName: "Ada", locationId: LOCATION }),
    );
  });

  void test("create and upsert refuse an input that names nobody, before fetch", async () => {
    const { client, seen } = stub({ contact: RAW });
    await expect(createContact(client, { companyName: "Acme" })).rejects.toThrow(
      ContactInputError,
    );
    await expect(upsertContact(client, { tags: ["x"] })).rejects.toThrow(
      ContactInputError,
    );
    expect(seen).toEqual([]);
  });

  void test("updateContact puts the patch; companyName is not an update field", async () => {
    const { client, seen } = stub({ contact: RAW, succeded: true });
    expect(await updateContact(client, "c1", { lastName: "Lovelace" })).toEqual(PARSED);
    expect(seen).toEqual(sent("PUT /contacts/c1", { lastName: "Lovelace" }));
    // UpdateContactDto has no companyName (R3 P2 #33).
    // @ts-expect-error companyName is not accepted by updateContact
    await updateContact(client, "c1", { companyName: "Acme" });
  });

  void test("parseContact falls back contactName, then name, then first + last", async () => {
    const { client } = stub({ contact: { id: "c1", name: "Ada L", firstName: "Ada" } });
    expect((await getContact(client, "c1")).name).toBe("Ada L");
  });

  void test("upsertContact adds locationId and reads new as created", async () => {
    const { client, seen } = stub({ new: true, contact: RAW });
    const result = await upsertContact(client, { email: EMAIL, source: "test" });
    const body = { email: EMAIL, source: "test", locationId: LOCATION };
    expect(seen).toEqual(sent("POST /contacts/upsert", body));
    expect(result).toEqual({ contact: PARSED, created: true });
  });

  void test("add and remove tags send the tags and return the result", async () => {
    const added = stub({ tags: ["a", "b"] });
    expect(await addContactTags(added.client, "c1", ["b"])).toEqual(["a", "b"]);
    expect(added.seen).toEqual(sent("POST /contacts/c1/tags", { tags: ["b"] }));
    const removed = stub({ tags: ["a"] });
    expect(await removeContactTags(removed.client, "c1", ["b"])).toEqual(["a"]);
    expect(removed.seen).toEqual(sent("DELETE /contacts/c1/tags", { tags: ["b"] }));
  });

  void test("listContacts pages with the startAfter + startAfterId pair", async () => {
    const meta = { startAfter: 1700000000000, startAfterId: "c9" };
    const first = stub({ contacts: [RAW], meta });
    const page = await listContacts(first.client, { limit: 5 });
    expect(first.seen).toEqual(sent(`GET /contacts/?locationId=${LOCATION}&limit=5`));
    expect(page).toEqual({
      contacts: [PARSED],
      nextStartAfter: 1700000000000,
      nextStartAfterId: "c9",
    });
    const second = stub({ contacts: [] });
    const cursor = {
      startAfter: page.nextStartAfter,
      startAfterId: page.nextStartAfterId,
    };
    expect(await listContacts(second.client, { limit: 5, ...cursor })).toEqual({
      contacts: [],
    });
    const url = `GET /contacts/?locationId=${LOCATION}&limit=5&startAfterId=c9&startAfter=1700000000000`;
    expect(second.seen).toEqual(sent(url));
  });

  void test("malformed responses throw HighLevelShapeError", async () => {
    const noId = stub({ contact: { firstName: "Ada" } }).client;
    await expect(getContact(noId, "c1")).rejects.toThrow(HighLevelShapeError);
    const noList = stub({ total: 1 }).client;
    await expect(searchContacts(noList)).rejects.toThrow(HighLevelShapeError);
    const badTag = stub({ tags: [1] }).client;
    await expect(addContactTags(badTag, "c1", ["b"])).rejects.toThrow(
      HighLevelShapeError,
    );
  });

  void test("a write without allowWrites is blocked before fetch", async () => {
    const { client, seen } = stub({ contact: RAW }, false);
    await expect(createContact(client, { email: EMAIL })).rejects.toThrow(
      "Blocked POST",
    );
    expect(seen).toEqual([]);
  });
});
