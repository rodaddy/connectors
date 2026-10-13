/** Custom fields: request shape, parsing, ensure-by-name, write guard. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { ACCOUNTS, createClient, type AccountClient } from "../src/accounts.ts";
import {
  createCustomField,
  createCustomValue,
  deleteCustomValue,
  ensureCustomFields,
  listCustomFields,
  listCustomValues,
  updateCustomValue,
} from "../src/crm/custom.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";

interface Seen {
  method: string;
  path: string;
  version: string | null;
  body: unknown;
}

const LOC = `/locations/${ACCOUNTS.primary.locationId}`;

function stub(
  replies: unknown[],
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
        method: request.method,
        path: `${url.pathname}${url.search}`,
        version: request.headers.get("Version"),
        body: text ? JSON.parse(text) : undefined,
      });
      return Response.json(replies[seen.length - 1]);
    },
  });
  return { client, seen };
}

void describe("custom fields", () => {
  void test("listCustomFields GETs with the model filter and parses picklistOptions", async () => {
    const { client, seen } = stub([
      {
        customFields: [
          { id: "f1", name: "Niche", fieldKey: "contact.niche", dataType: "TEXT" },
          {
            id: "f2",
            name: "Type",
            dataType: "SINGLE_OPTIONS",
            picklistOptions: ["A", "B"],
          },
        ],
      },
    ]);
    const fields = await listCustomFields(client, { model: "contact" });
    expect(seen[0]).toMatchObject({
      method: "GET",
      path: `${LOC}/customFields?model=contact`,
      version: "2021-07-28",
    });
    expect(fields).toEqual([
      { id: "f1", name: "Niche", fieldKey: "contact.niche", dataType: "TEXT" },
      { id: "f2", name: "Type", dataType: "SINGLE_OPTIONS", options: ["A", "B"] },
    ]);
  });

  void test("createCustomField POSTs model contact and options as custom_fields.py does", async () => {
    const { client, seen } = stub([
      { customField: { id: "f3", name: "Type", picklistOptions: ["A"] } },
    ]);
    const field = await createCustomField(client, {
      name: "Type",
      dataType: "SINGLE_OPTIONS",
      options: ["A"],
    });
    expect(seen[0]).toEqual({
      method: "POST",
      path: `${LOC}/customFields`,
      version: "2021-07-28",
      body: {
        name: "Type",
        dataType: "SINGLE_OPTIONS",
        model: "contact",
        options: ["A"],
      },
    });
    expect(field).toEqual({ id: "f3", name: "Type", options: ["A"] });
  });

  void test("createCustomField leaves out empty options", async () => {
    const { client, seen } = stub([{ customField: { id: "f4", name: "Deal" } }]);
    await createCustomField(client, {
      name: "Deal",
      dataType: "TEXT",
      model: "opportunity",
      options: [],
    });
    expect(seen[0]?.body).toEqual({
      name: "Deal",
      dataType: "TEXT",
      model: "opportunity",
    });
  });

  void test("ensureCustomFields matches by case-insensitive name, creates only missing, keeps spec order", async () => {
    const { client, seen } = stub([
      { customFields: [{ id: "f1", name: "niche", dataType: "LARGE_TEXT" }] },
      { customField: { id: "f9", name: "LinkedIn" } },
    ]);
    const results = await ensureCustomFields(client, [
      { name: "LinkedIn", dataType: "TEXT" },
      { name: "Niche", dataType: "TEXT" },
    ]);
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${LOC}/customFields`,
      `POST ${LOC}/customFields`,
    ]);
    expect(results).toEqual([
      { field: { id: "f9", name: "LinkedIn" }, created: true },
      { field: { id: "f1", name: "niche", dataType: "LARGE_TEXT" }, created: false },
    ]);
  });

  void test("ensureCustomFields matches on name plus model", async () => {
    const { client, seen } = stub([
      { customFields: [{ id: "f1", name: "Niche", model: "contact" }] },
      { customField: { id: "f2", name: "Niche", model: "opportunity" } },
    ]);
    const results = await ensureCustomFields(client, [
      { name: "Niche", dataType: "TEXT", model: "opportunity" },
      { name: "niche", dataType: "TEXT" },
    ]);
    expect(seen.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(seen[1]?.body).toEqual({
      name: "Niche",
      dataType: "TEXT",
      model: "opportunity",
    });
    expect(results.map((result) => [result.field.id, result.created])).toEqual([
      ["f2", true],
      ["f1", false],
    ]);
  });

  void test("a field without an id throws HighLevelShapeError", async () => {
    const { client } = stub([{ customFields: [{ name: "Niche" }] }]);
    await expect(listCustomFields(client)).rejects.toThrow(HighLevelShapeError);
  });

  void test("ensureCustomFields without allowWrites lists, then blocks the create before fetch", async () => {
    const { client, seen } = stub([{ customFields: [] }], false);
    await expect(
      ensureCustomFields(client, [{ name: "Niche", dataType: "TEXT" }]),
    ).rejects.toThrow("Blocked POST request in read-only mode");
    expect(seen.map((request) => request.method)).toEqual(["GET"]);
  });
});

const VALUE = { id: "v1", name: "Review link", value: "https://example.test" };

void describe("custom values", () => {
  void test("listCustomValues GETs and parses", async () => {
    const { client, seen } = stub([
      { customValues: [{ ...VALUE, fieldKey: "{{ custom_values.review_link }}" }] },
    ]);
    const values = await listCustomValues(client);
    expect(seen[0]).toMatchObject({
      method: "GET",
      path: `${LOC}/customValues`,
      version: "2021-07-28",
    });
    expect(values).toEqual([{ ...VALUE, fieldKey: "{{ custom_values.review_link }}" }]);
  });

  void test("createCustomValue POSTs name and value", async () => {
    const { client, seen } = stub([{ customValue: VALUE }]);
    const value = await createCustomValue(client, {
      name: VALUE.name,
      value: VALUE.value,
    });
    expect(seen[0]).toEqual({
      method: "POST",
      path: `${LOC}/customValues`,
      version: "2021-07-28",
      body: { name: VALUE.name, value: VALUE.value },
    });
    expect(value).toEqual(VALUE);
  });

  void test("updateCustomValue PUTs name and value to the value's id", async () => {
    const { client, seen } = stub([{ customValue: { ...VALUE, value: "new" } }]);
    const value = await updateCustomValue(client, { ...VALUE, value: "new" });
    expect(seen[0]).toEqual({
      method: "PUT",
      path: `${LOC}/customValues/v1`,
      version: "2021-07-28",
      body: { name: VALUE.name, value: "new" },
    });
    expect(value.value).toBe("new");
  });

  void test("deleteCustomValue DELETEs the value", async () => {
    const { client, seen } = stub([{ succeeded: true }]);
    expect(await deleteCustomValue(client, "v1")).toBe(true);
    expect(seen[0]).toEqual({
      method: "DELETE",
      path: `${LOC}/customValues/v1`,
      version: "2021-07-28",
      body: undefined,
    });
  });

  void test("deleteCustomValue reads succeded and rejects a missing flag", async () => {
    expect(await deleteCustomValue(stub([{ succeded: false }]).client, "v1")).toBe(
      false,
    );
    await expect(deleteCustomValue(stub([{}]).client, "v1")).rejects.toThrow(
      HighLevelShapeError,
    );
  });

  void test("a created value without a value throws HighLevelShapeError", async () => {
    const { client } = stub([{ customValue: { id: "v1", name: "x" } }]);
    await expect(createCustomValue(client, { name: "x", value: "" })).rejects.toThrow(
      HighLevelShapeError,
    );
  });
});
