/** Opt-out detection and the drip response analysis. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { analyzeResponses, isOptOut } from "../src/conversations/optout.ts";

void describe("isOptOut", () => {
  void test("matches whole-message keywords in any case and punctuation", () => {
    for (const text of [
      "STOP",
      "stop.",
      " Unsubscribe! ",
      "END",
      "quit",
      "Cancel",
      "STOPALL",
      "Stop all",
      "remove me",
      "Opt-Out",
      "optout",
    ]) {
      expect([text, isOptOut(text)]).toEqual([text, true]);
    }
  });

  void test("matches HighLevel's DND marker", () => {
    expect(isOptOut("DND enabled by customer")).toBe(true);
    expect(isOptOut("DnD enabled by customer for SMS")).toBe(true);
  });

  void test("by default matches stop, unsubscribe, remove me, opt out anywhere at a word boundary", () => {
    for (const text of [
      "Stop texting me",
      "STOP. wrong number",
      "please unsubscribe me",
      "Please remove me from this list",
      "I want to opt-out now",
      "please don't stop",
    ]) {
      expect([text, isOptOut(text)]).toEqual([text, true]);
    }
  });

  void test("by default does not match other words or a keyword inside a word", () => {
    for (const text of ["the end is near", "can I cancel?", "stopping by later", ""]) {
      expect([text, isOptOut(text)]).toEqual([text, false]);
    }
  });

  void test("strict mode matches whole-message keywords only", () => {
    expect(isOptOut("STOP.", { strict: true })).toBe(true);
    expect(isOptOut("DND enabled by customer", { strict: true })).toBe(true);
    for (const text of ["Stop texting me", "please don't stop", "the end is near"]) {
      expect([text, isOptOut(text, { strict: true })]).toEqual([text, false]);
    }
  });
});

void describe("analyzeResponses", () => {
  void test("counts inbound, opt-outs and replies, and finds the first reply", () => {
    const result = analyzeResponses([
      { direction: "outbound", body: "hi", dateAdded: "2026-10-01T10:00:00Z" },
      { direction: "inbound", body: "Sounds good", dateAdded: "2026-10-03T10:00:00Z" },
      { direction: "inbound", body: "STOP", dateAdded: "2026-10-01T11:00:00Z" },
      { direction: "inbound", body: "who is this", dateAdded: "2026-10-02T09:00:00Z" },
      { direction: "inbound", dateAdded: "2026-10-01T12:00:00Z" },
    ]);
    expect(result).toEqual({
      inbound: 4,
      optOuts: 1,
      replies: 2,
      firstReplyAt: "2026-10-02T09:00:00Z",
    });
  });

  void test("has no firstReplyAt when nobody replied", () => {
    expect(
      analyzeResponses([
        { direction: "inbound", body: "stop", dateAdded: "2026-10-01T00:00:00Z" },
      ]),
    ).toEqual({ inbound: 1, optOuts: 1, replies: 0 });
  });
});
