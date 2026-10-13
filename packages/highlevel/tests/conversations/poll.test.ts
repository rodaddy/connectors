/** pollInbound: pages past 50 conversations, keeps new inbound, orders, dedupes. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { HighLevelShapeError } from "../../src/crm/shape.ts";
import { pollInbound } from "../../src/conversations/poll.ts";
import { MemorySeenStore } from "../../src/conversations/seen-store.ts";
import { stubClient } from "./stub.ts";

const SINCE = Date.parse("2026-10-01T00:00:00Z");
const at = (hour: number) => new Date(SINCE + hour * 3_600_000).toISOString();
const conv = (n: number) => ({
  id: `cv${n}`,
  contactId: `ct${n}`,
  lastMessageDate: SINCE + n,
});
const msg = (id: string, cv: string, direction: string, date: string) => ({
  id,
  conversationId: cv,
  direction,
  messageType: id.startsWith("e") ? "TYPE_EMAIL" : "TYPE_SMS",
  body: `body ${id}`,
  dateAdded: date,
});

/** Page 1: 50 moved conversations (cv51..cv2); page 2: cv1 moved, cv0 did not. */
function search(url: URL): unknown {
  const cursor = url.searchParams.get("startAfterDate");
  if (cursor === null) {
    return { conversations: Array.from({ length: 50 }, (_, i) => conv(51 - i)) };
  }
  return { conversations: [conv(1), { ...conv(0), lastMessageDate: SINCE }] };
}

function messages(url: URL): unknown {
  const cv = url.pathname.split("/")[2] ?? "";
  if (cv === "cv1" && url.searchParams.get("lastMessageId") === null) {
    return {
      messages: {
        lastMessageId: "s1b",
        nextPage: true,
        messages: [msg("s1b", cv, "inbound", at(3))],
      },
    };
  }
  if (cv === "cv1") {
    return {
      messages: {
        nextPage: false,
        messages: [msg("e1a", cv, "inbound", at(1)), msg("old", cv, "inbound", at(-1))],
      },
    };
  }
  if (cv === "cv2")
    return {
      messages: [msg("s2", cv, "outbound", at(4)), msg("s2in", cv, "inbound", at(2))],
    };
  return { messages: [] };
}

const respond = (url: URL) =>
  url.pathname === "/conversations/search" ? search(url) : messages(url);

void describe("pollInbound", () => {
  void test("pages search and messages, keeps new inbound, oldest first", async () => {
    const { client, sent } = stubClient(respond);
    const events = await pollInbound(client, {
      since: SINCE,
      seen: new MemorySeenStore(),
    });
    const searches = sent.filter((s) => s.url.pathname === "/conversations/search");
    expect(searches.map((s) => s.url.searchParams.get("startAfterDate"))).toEqual([
      null,
      String(SINCE + 2),
    ]);
    expect(sent.every((s) => s.method === "GET" && s.version === "2021-04-15")).toBe(
      true,
    );
    expect(sent.some((s) => s.url.pathname === "/conversations/cv0/messages")).toBe(
      false,
    );
    expect(events.map((e) => e.messageId)).toEqual(["e1a", "s2in", "s1b"]);
    expect(events[0]).toEqual({
      messageId: "e1a",
      conversationId: "cv1",
      contactId: "ct1",
      channel: "Email",
      dateAdded: at(1),
      body: "body e1a",
    });
  });

  void test("skips ids already seen and marks new ones seen", async () => {
    const seen = new MemorySeenStore();
    seen.add("s2in");
    const { client } = stubClient(respond);
    const first = await pollInbound(client, { since: SINCE, seen });
    expect(first.map((e) => e.messageId)).toEqual(["e1a", "s1b"]);
    expect(await pollInbound(client, { since: SINCE, seen })).toEqual([]);
  });

  void test("filters by channel, case-insensitively", async () => {
    const { client } = stubClient(respond);
    const events = await pollInbound(client, {
      since: SINCE,
      seen: new MemorySeenStore(),
      channels: ["sms"],
    });
    expect(events.map((e) => e.messageId)).toEqual(["s2in", "s1b"]);
  });
});

void describe("pollInbound paging guard", () => {
  void test("a full page with no cursor throws instead of ending the poll early", async () => {
    const undated = Array.from({ length: 50 }, (_, i) => ({
      id: `u${i}`,
      contactId: "c",
    }));
    const { client } = stubClient((url) =>
      url.pathname === "/conversations/search"
        ? { conversations: undated }
        : { messages: [] },
    );
    const poll = pollInbound(client, { since: SINCE, seen: new MemorySeenStore() });
    await expect(poll).rejects.toThrow(HighLevelShapeError);
  });
});
