/** toE164: the earlier tooling to_e164 rules, refusing what it cannot normalize. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { InvalidPhoneError, toE164 } from "../src/conversations/phone.ts";

void describe("toE164", () => {
  void test("adds +1 to a 10-digit US number and strips punctuation", () => {
    expect(toE164("(555) 010-0199")).toBe("+15550100199");
    expect(toE164(" 555.010.0199 ")).toBe("+15550100199");
  });

  void test("adds + to an 11-digit number that starts with 1", () => {
    expect(toE164("1-555-010-0199")).toBe("+15550100199");
  });

  void test("passes a + number through, cleaned of separators", () => {
    expect(toE164("+44 20 7946 0000")).toBe("+442079460000");
  });

  void test("refuses what it cannot normalize, without echoing the number", () => {
    for (const bad of [
      "",
      "555-0199",
      "25550100199",
      "+1234567",
      "+1234567890123456",
    ]) {
      expect(() => toE164(bad)).toThrow(InvalidPhoneError);
    }
    expect(() => toE164("555-0199")).not.toThrow(/0199/);
  });

  void test("refuses an unsupported default country", () => {
    expect(() => toE164("5550100199", "GB")).toThrow(InvalidPhoneError);
    expect(toE164("5550100199", "CA")).toBe("+15550100199");
  });
});
