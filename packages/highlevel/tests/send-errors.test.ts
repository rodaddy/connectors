/** classifySendError: the carrier and GHL refusal shapes, by table. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { HighLevelApiError } from "../src/client/highlevel.ts";
import { classifyError } from "../src/core/errors.ts";
import { classifySendError } from "../src/conversations/send-errors.ts";

function apiError(status: number, body: unknown): HighLevelApiError {
  const text = JSON.stringify(body);
  const { kind, message } = classifyError(status, text, "application/json");
  return new HighLevelApiError(message, status, text, kind);
}

void describe("classifySendError", () => {
  void test("classifies the carrier shapes by table", () => {
    const cases: Array<[unknown, string, string | undefined]> = [
      [
        apiError(400, { message: "Error 30034: not A2P registered" }),
        "a2p-unregistered",
        "30034",
      ],
      [apiError(400, { error: "DND enabled by customer" }), "opted-out", undefined],
      [
        apiError(400, { message: "21610: unsubscribed recipient" }),
        "opted-out",
        "21610",
      ],
      [
        apiError(400, { msg: "Error 21614: not a valid mobile" }),
        "invalid-number",
        "21614",
      ],
      [
        apiError(400, { message: ["Invalid 'To' Phone Number"] }),
        "invalid-number",
        "21211",
      ],
      [apiError(429, { message: "Slow down" }), "rate-limit", "429"],
      [new Error("too many requests"), "unknown", undefined],
      [new Error("socket hang up"), "unknown", undefined],
      ["weird", "unknown", undefined],
    ];
    for (const [error, kind, code] of cases) {
      const result = classifySendError(error);
      expect([result.kind, result.code]).toEqual([kind, code]);
    }
  });

  void test("redacts phone numbers from the message and does not match codes inside them", () => {
    const result = classifySendError(
      apiError(400, { message: "cannot reach +16300340199 or jane@example.com" }),
    );
    expect(result).toEqual({
      kind: "unknown",
      message: "HTTP 400: cannot reach [redacted] or [redacted]",
    });
  });
});
