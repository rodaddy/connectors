/** Email builder: list, create, set content, upsert by name. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { createClient } from "../src/accounts.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";
import {
  createEmailTemplate,
  listEmailTemplates,
  setEmailTemplateContent,
  upsertEmailTemplate,
} from "../src/emails.ts";

interface Seen {
  call: string;
  version: string | null;
  body: unknown;
}

/** A client whose fetch answers by `METHOD path`; `list` answers the template list by URL. */
function fake(
  replies: Record<string, unknown>,
  allowWrites = true,
  list?: (url: URL) => unknown,
) {
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
        call: `${request.method} ${url.pathname}${url.search}`,
        version: request.headers.get("Version"),
        body: text ? JSON.parse(text) : undefined,
      });
      const key = `${request.method} ${url.pathname}`;
      if (list && key === LIST) return Response.json(list(url));
      return Response.json(replies[key] ?? {});
    },
  });
  return { client, seen, loc: client.locationId };
}

const LIST = "GET /emails/builder";
const CREATE = "POST /emails/builder";
const DATA = "POST /emails/builder/data";

describe("email templates", () => {
  test("listEmailTemplates reads id or _id and skips nameless entries", async () => {
    const { client, seen, loc } = fake({
      [LIST]: {
        builders: [{ id: "t1", name: "A" }, { _id: "t2", name: "B" }, { id: "t3" }],
      },
    });
    expect(await listEmailTemplates(client)).toEqual([
      { id: "t1", name: "A" },
      { id: "t2", name: "B" },
    ]);
    expect(seen).toEqual([
      {
        call: `GET /emails/builder?locationId=${loc}&limit=100&offset=0`,
        version: "2021-07-28",
        body: undefined,
      },
    ]);
  });

  test("a list without builders is a shape error", async () => {
    const { client } = fake({ [LIST]: { templates: [] } });
    await expect(listEmailTemplates(client)).rejects.toThrow(HighLevelShapeError);
  });

  for (const [reply, id] of [
    [{ id: "a1" }, "a1"],
    [{ templateId: "a2" }, "a2"],
    [{ redirect: "https://app.example/builder/a3/" }, "a3"],
    [{ _id: "a4" }, "a4"],
  ] as const) {
    test(`createEmailTemplate reads the id from ${Object.keys(reply)[0]}`, async () => {
      const { client, seen, loc } = fake({ [CREATE]: reply });
      expect(await createEmailTemplate(client, { name: "N" })).toEqual({
        id,
        name: "N",
      });
      expect(seen[0]).toEqual({
        call: CREATE,
        version: "2021-07-28",
        body: { locationId: loc, title: "N", type: "html" },
      });
    });
  }

  test("a create response with no id is a shape error", async () => {
    const { client } = fake({ [CREATE]: { traceId: "x" } });
    await expect(createEmailTemplate(client, { name: "N" })).rejects.toThrow(
      HighLevelShapeError,
    );
  });

  test("setEmailTemplateContent posts the html as the html editor", async () => {
    const { client, seen, loc } = fake({ [DATA]: { ok: true } });
    await setEmailTemplateContent(client, { templateId: "t1", html: "<p>x</p>" });
    expect(seen[0]).toEqual({
      call: DATA,
      version: "2021-07-28",
      body: {
        locationId: loc,
        templateId: "t1",
        html: "<p>x</p>",
        editorType: "html",
        updatedBy: "connectors-highlevel",
      },
    });
  });

  test("upsert updates an existing template by exact name", async () => {
    const { client, seen } = fake({ [LIST]: { builders: [{ id: "t1", name: "A" }] } });
    expect(await upsertEmailTemplate(client, { name: "A", html: "h" })).toEqual({
      template: { id: "t1", name: "A" },
      created: false,
    });
    expect(seen.map((s) => s.call.split("?")[0])).toEqual([LIST, DATA]);
  });

  test("upsert creates a missing template, then sets its content", async () => {
    const { client, seen } = fake({
      [LIST]: { builders: [{ id: "t1", name: "a" }] },
      [CREATE]: { redirect: "/builder/t9" },
    });
    expect(await upsertEmailTemplate(client, { name: "A", html: "h" })).toEqual({
      template: { id: "t9", name: "A" },
      created: true,
    });
    expect(seen.map((s) => s.call.split("?")[0])).toEqual([LIST, CREATE, DATA]);
    expect(seen[2]?.body).toMatchObject({ templateId: "t9", html: "h" });
  });

  test("upsert pages the list and matches a template on the second page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
    }));
    const pages = [{ builders: full }, { builders: [{ id: "t2", name: "A" }] }];
    const { client, seen, loc } = fake({}, true, (url) =>
      url.searchParams.get("offset") === "0" ? pages[0] : pages[1],
    );
    expect(await upsertEmailTemplate(client, { name: "A", html: "h" })).toEqual({
      template: { id: "t2", name: "A" },
      created: false,
    });
    expect(seen.map((s) => s.call)).toEqual([
      `${LIST}?locationId=${loc}&limit=100&offset=0`,
      `${LIST}?locationId=${loc}&limit=100&offset=100`,
      DATA,
    ]);
  });

  test("creating without allowWrites is blocked before fetch", async () => {
    const { client, seen } = fake({}, false);
    await expect(createEmailTemplate(client, { name: "N" })).rejects.toThrow(
      /read-only mode/,
    );
    expect(seen).toHaveLength(0);
  });
});
