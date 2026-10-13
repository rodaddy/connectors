/** Conversations read: request shape, Version 2021-04-15, parsing, envelope normalizing. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { ACCOUNTS } from "../../src/accounts.ts";
import { HighLevelShapeError } from "../../src/crm/shape.ts";
import {
  getConversation,
  listMessages,
  searchConversations,
} from "../../src/conversations/read.ts";
import { stubClient } from "./stub.ts";

const LOCATION = ACCOUNTS.primary.locationId;
const parsedA = {
  id: "a",
  contactId: "ct-a",
  lastMessageDate: 200,
  lastMessageType: "TYPE_SMS",
  lastMessageDirection: "inbound",
  unreadCount: 2,
  type: "TYPE_PHONE",
};
const parsedB = { id: "b", contactId: "ct-b", lastMessageDate: 100 };
const parsedMessage = {
  id: "m1",
  conversationId: "cv1",
  contactId: "ct1",
  direction: "inbound",
  type: "TYPE_SMS",
  body: "hello",
  dateAdded: "2026-10-01T10:00:00.000Z",
  status: "delivered",
};
const message = { ...parsedMessage, type: 2, messageType: "TYPE_SMS" };

void describe("searchConversations", () => {
  void test("sends the location, filters, sort and cursor on Version 2021-04-15", async () => {
    const { client, sent } = stubClient(() => ({
      conversations: [{ ...parsedA, fullName: "dropped" }, parsedB],
      total: 9,
    }));
    const page = await searchConversations(client, {
      contactId: "ct-a",
      query: "smith",
      limit: 2,
      startAfterDate: 300,
    });
    expect(sent[0]?.method).toBe("GET");
    expect(sent[0]?.url.pathname).toBe("/conversations/search");
    expect(Object.fromEntries(sent[0]?.url.searchParams ?? [])).toEqual({
      locationId: LOCATION,
      limit: "2",
      sort: "desc",
      sortBy: "last_message_date",
      contactId: "ct-a",
      query: "smith",
      startAfterDate: "300",
    });
    expect(sent[0]?.version).toBe("2021-04-15");
    expect(page).toEqual({
      conversations: [parsedA, parsedB],
      total: 9,
      nextCursor: 100,
    });
  });

  void test("a full page whose last conversation has no date pages from the last defined date", async () => {
    const { client } = stubClient(() => ({
      conversations: [parsedA, { id: "c", contactId: "ct-c" }],
    }));
    const page = await searchConversations(client, { limit: 2 });
    expect(page.nextCursor).toBe(200);
  });

  void test("a short page has no cursor", async () => {
    const { client } = stubClient(() => ({ conversations: [parsedA] }));
    const page = await searchConversations(client, { limit: 50 });
    expect(page.nextCursor).toBeUndefined();
  });

  void test("a malformed response throws HighLevelShapeError", async () => {
    const { client } = stubClient(() => ({ conversations: "nope" }));
    await expect(searchConversations(client)).rejects.toThrow(HighLevelShapeError);
  });
});

void describe("getConversation", () => {
  void test("reads one conversation by id", async () => {
    const { client, sent } = stubClient(() => ({
      id: "cv/1",
      contactId: "c",
      type: 1,
    }));
    const result = await getConversation(client, "cv/1");
    expect(sent[0]?.method).toBe("GET");
    expect(sent[0]?.url.pathname).toBe("/conversations/cv%2F1");
    expect(sent[0]?.version).toBe("2021-04-15");
    expect(result).toEqual({ id: "cv/1", contactId: "c", type: "1" });
  });
});

void describe("listMessages", () => {
  void test("reads the nested envelope and returns the next page id", async () => {
    const { client, sent } = stubClient(() => ({
      messages: { lastMessageId: "m1", nextPage: true, messages: [message] },
    }));
    const page = await listMessages(client, {
      conversationId: "cv1",
      limit: 20,
      lastMessageId: "m0",
    });
    expect(sent[0]?.url.pathname).toBe("/conversations/cv1/messages");
    expect(sent[0]?.url.search).toBe("?limit=20&lastMessageId=m0");
    expect(sent[0]?.version).toBe("2021-04-15");
    expect(page).toEqual({ messages: [parsedMessage], nextPage: "m1" });
  });

  void test("reads the flat envelope; no next page when nextPage is false", async () => {
    const flat = { lastMessageId: "m1", nextPage: false, messages: [message] };
    const { client } = stubClient(() => flat);
    const page = await listMessages(client, { conversationId: "cv1" });
    expect(page).toEqual({ messages: [parsedMessage] });
  });

  void test("skips a message without an inbound/outbound direction", async () => {
    const { client } = stubClient(() => ({
      messages: [{ ...message, id: "sys", direction: 3 }, message],
    }));
    const page = await listMessages(client, { conversationId: "cv1" });
    expect(page).toEqual({ messages: [parsedMessage] });
  });

  void test("a message without an id throws HighLevelShapeError", async () => {
    const { client } = stubClient(() => ({ messages: [{ ...message, id: 3 }] }));
    await expect(listMessages(client, { conversationId: "cv1" })).rejects.toThrow(
      HighLevelShapeError,
    );
  });
});
