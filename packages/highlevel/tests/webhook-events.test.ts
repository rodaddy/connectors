/** Webhook event names generated from the catalog, and the parsed envelope. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { WEBHOOK_EVENT_NAMES, parseWebhookEnvelope } from "../src/webhooks/events.ts";

void describe("webhook events", () => {
  void test("event names come from the catalog, deduplicated", () => {
    expect(WEBHOOK_EVENT_NAMES).toContain("ContactCreate");
    expect(WEBHOOK_EVENT_NAMES).toContain("INSTALL");
    expect(new Set(WEBHOOK_EVENT_NAMES).size).toBe(WEBHOOK_EVENT_NAMES.length);
  });

  void test("parseWebhookEnvelope keeps unknown types and leaves absent fields out", () => {
    expect(
      parseWebhookEnvelope({ type: "INSTALL", companyId: "co-1", appId: "a" }),
    ).toEqual({ type: "INSTALL", companyId: "co-1", data: { appId: "a" } });
  });
});

void describe("webhook event names", () => {
  void test("come from the doc file names, with the lifecycle types GHL sends", () => {
    for (const name of [
      "AppointmentUpdate",
      "AppointmentDelete",
      "ConversationUnreadUpdate",
      "INSTALL",
      "UNINSTALL",
      "PLAN_CHANGE",
    ])
      expect(WEBHOOK_EVENT_NAMES).toContain(name);
    for (const name of ["AppInstall", "AppUninstall", "PlanChange"])
      expect(WEBHOOK_EVENT_NAMES).not.toContain(name);
  });
});
