/** sendMessage, against a stubbed fetch with a fake token. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { createClient, type AccountClient } from "../src/accounts.ts";
import { CallArgumentError } from "../src/client/call.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";
import { sendMessage } from "../src/conversations/send.ts";

interface Seen {
  calls: number;
  method?: string;
  url?: URL;
  version?: string | null;
  body?: unknown;
}

function client(seen: Seen, reply: unknown, allowWrites = true): AccountClient {
  return createClient({
    account: "primary",
    token: "pit-test",
    allowWrites,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      seen.calls += 1;
      seen.method = request.method;
      seen.url = new URL(request.url);
      seen.version = request.headers.get("Version");
      seen.body = await request.json();
      return Response.json(reply);
    },
  });
}

const SENT = { messageId: "m1", conversationId: "cv1", status: "pending" };

void describe("sendMessage", () => {
  void test("posts an SMS with E.164 numbers and Version 2021-04-15", async () => {
    const seen: Seen = { calls: 0 };
    const result = await sendMessage(client(seen, SENT), {
      contactId: "c1",
      channel: "SMS",
      body: "hello",
      fromNumber: "(555) 010-0100",
      toNumber: "5550100199",
    });
    expect(seen.method).toBe("POST");
    expect(`${seen.url?.pathname}${seen.url?.search}`).toBe("/conversations/messages");
    expect(seen.version).toBe("2021-04-15");
    expect(seen.body).toEqual({
      type: "SMS",
      contactId: "c1",
      message: "hello",
      fromNumber: "+15550100100",
      toNumber: "+15550100199",
    });
    expect(result).toEqual(SENT);
  });

  void test("sends Email fields and reads the msgId fallback", async () => {
    const seen: Seen = { calls: 0 };
    const result = await sendMessage(
      client(seen, { msgId: "m2", conversationId: "cv2" }),
      {
        contactId: "c1",
        channel: "Email",
        subject: "Hi",
        html: "<p>x</p>",
        attachments: ["https://example.invalid/a.pdf"],
        scheduledTimestamp: 1_800_000_000,
      },
    );
    expect(seen.body).toEqual({
      type: "Email",
      contactId: "c1",
      subject: "Hi",
      html: "<p>x</p>",
      attachments: ["https://example.invalid/a.pdf"],
      scheduledTimestamp: 1_800_000_000,
    });
    expect(result).toEqual({ messageId: "m2", conversationId: "cv2" });
  });

  void test("validates per-channel required fields before fetch", async () => {
    const seen: Seen = { calls: 0 };
    const sms = sendMessage(client(seen, SENT), { contactId: "c1", channel: "SMS" });
    await expect(sms).rejects.toThrow(CallArgumentError);
    const email = sendMessage(client(seen, SENT), {
      contactId: "c1",
      channel: "Email",
      body: "x",
    });
    await expect(email).rejects.toThrow("needs subject");
    const noBody = sendMessage(client(seen, SENT), {
      contactId: "c1",
      channel: "Email",
      subject: "s",
    });
    await expect(noBody).rejects.toThrow("needs body or html");
    expect(seen.calls).toBe(0);
  });

  void test("throws HighLevelShapeError on a malformed response", async () => {
    const seen: Seen = { calls: 0 };
    const sent = sendMessage(client(seen, { conversationId: "cv1" }), {
      contactId: "c1",
      channel: "SMS",
      body: "x",
    });
    await expect(sent).rejects.toThrow(HighLevelShapeError);
  });

  void test("on a dryRun client never sends and never parses the plan as a sent message", async () => {
    const seen: Seen = { calls: 0 };
    const dry = createClient({
      account: "primary",
      token: "pit-test",
      allowWrites: true,
      dryRun: true,
      fetchImpl: async () => {
        seen.calls += 1;
        return Response.json(SENT);
      },
    });
    const sent = sendMessage(dry, { contactId: "c1", channel: "SMS", body: "x" });
    await expect(sent).rejects.toThrow();
    expect(seen.calls).toBe(0);
  });

  void test("is blocked before fetch without allowWrites", async () => {
    const seen: Seen = { calls: 0 };
    const sent = sendMessage(client(seen, SENT, false), {
      contactId: "c1",
      channel: "SMS",
      body: "x",
    });
    await expect(sent).rejects.toThrow("read-only mode");
    expect(seen.calls).toBe(0);
  });
});
