/** The shared response readers: required fields fail loudly, optional ones degrade to undefined. */
import { describe, test } from "node:test";
import { expect } from "expect";

import {
  asShape,
  HighLevelShapeError,
  readArray,
  readOptionalNumber,
  readOptionalString,
  readString,
  readStrings,
} from "../src/crm/shape.ts";

void describe("shape readers", () => {
  void test("asShape rejects arrays, null and scalars", () => {
    for (const bad of [[], null, "x", 1]) {
      expect(() => asShape(bad, "contact")).toThrow(HighLevelShapeError);
    }
    expect(asShape({ id: "1" }, "contact")).toEqual({ id: "1" });
  });

  void test("readString names the failing field", () => {
    expect(() => readString({ id: 1 }, "id", "contact")).toThrow(
      "HighLevel response field contact.id is not a string.",
    );
    expect(readString({ id: "c1" }, "id", "contact")).toBe("c1");
  });

  void test("optional readers degrade to undefined or []", () => {
    const shape = { name: 3, value: "x", tags: ["a", 2, "b"] };
    expect(readOptionalString(shape, "name")).toBeUndefined();
    expect(readOptionalNumber(shape, "value")).toBeUndefined();
    expect(readStrings(shape, "tags")).toEqual(["a", "b"]);
    expect(readStrings(shape, "missing")).toEqual([]);
  });

  void test("readArray parses each element with its index in the field path", () => {
    const parse = (item: unknown, field: string) =>
      readString(asShape(item, field), "id", field);
    expect(readArray({ notes: [{ id: "n1" }] }, "notes", "body", parse)).toEqual([
      "n1",
    ]);
    expect(() =>
      readArray({ notes: [{ id: "n1" }, {}] }, "notes", "body", parse),
    ).toThrow("HighLevel response field body.notes[1].id is not a string.");
    expect(() => readArray({}, "notes", "body", parse)).toThrow(HighLevelShapeError);
  });
});
