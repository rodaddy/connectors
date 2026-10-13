/** The read-tool allowlist: each tool's request, parsing, and argument checks. */
import { test } from "node:test";
import { expect } from "expect";

import {
  ACCOUNTS,
  createClient,
  HighLevelShapeError,
} from "@rodaddy/connectors-highlevel";

import { checkArgs, TOOL_INDEX, ToolArgumentError } from "../src/tools/index.ts";

const LOC = ACCOUNTS.primary.locationId;

/** Run one tool on a client whose fetch records `METHOD path?query Version`. */
async function run(name: string, args: Record<string, unknown>, reply: unknown = {}) {
  const lines: string[] = [];
  const client = createClient({
    account: "primary",
    token: "pit-test",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const version = request.headers.get("Version") ?? "";
      lines.push(`${request.method} ${url.pathname}${url.search} ${version}`);
      return Response.json(reply);
    },
  });
  const tool = TOOL_INDEX.get(name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  checkArgs(tool, args);
  const ctx = { client, capability: "read" as const };
  const value = await tool.handler(args, ctx).catch((error: unknown) => error);
  return { lines, value };
}

void test("each tool sends one request scoped to the client's location", async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["get_location", {}, `GET /locations/${LOC} 2021-07-28`],
    ["list_workflows", {}, `GET /workflows/?locationId=${LOC} v3`],
    ["get_pipelines", {}, `GET /opportunities/pipelines?locationId=${LOC} 2021-07-28`],
    ["get_custom_fields", {}, `GET /locations/${LOC}/customFields 2021-07-28`],
    [
      "get_contacts",
      { limit: 5 },
      `GET /contacts/?locationId=${LOC}&limit=5 2021-07-28`,
    ],
    ["get_contact", { contactId: "c1" }, "GET /contacts/c1 2021-07-28"],
    ["list_notes", { contactId: "c1" }, "GET /contacts/c1/notes 2021-07-28"],
    ["get_opportunity", { opportunityId: "o1" }, "GET /opportunities/o1 2021-07-28"],
  ];
  for (const [name, args, line] of cases) {
    expect((await run(name, args)).lines).toEqual([line]);
  }
  const audit = await run("audit_location", {});
  expect(audit.lines.length).toBeGreaterThan(5);
  expect(audit.lines.every((line) => line.startsWith("GET "))).toBe(true);
});

void test("search_opportunities passes filters through and parses the page", async () => {
  const opp = { id: "o1", name: "Deal", pipelineId: "p1", pipelineStageId: "s1" };
  const reply = { opportunities: [{ ...opp, status: "won" }], meta: { total: 1 } };
  const { lines, value } = await run("search_opportunities", { status: "won" }, reply);
  expect(lines).toEqual([
    `GET /opportunities/search?location_id=${LOC}&status=won&limit=20 2021-07-28`,
  ]);
  expect(value).toMatchObject({
    total: 1,
    opportunities: [{ id: "o1", status: "won" }],
  });
});

void test("get_contacts and search_opportunities page by the startAfter pair", async () => {
  const cursor = { startAfter: 1700000000000, startAfterId: "x9" };
  const contacts = await run("get_contacts", { limit: 2, ...cursor }, { contacts: [] });
  const opps = await run("search_opportunities", cursor, { opportunities: [] });
  for (const line of [contacts.lines[0], opps.lines[0]]) {
    expect(line).toMatch(/[?&]startAfter=1700000000000[& ]/);
    expect(line).toMatch(/[?&]startAfterId=x9[& ]/);
  }
});

void test("search_conversations pages by startAfterDate", async () => {
  const args = { contactId: "c1", limit: 3, startAfterDate: 9 };
  const { lines } = await run("search_conversations", args, { conversations: [] });
  expect(lines[0]).toMatch(/^GET \/conversations\/search\?locationId=\w+&limit=3&/);
  expect(lines[0]).toMatch(/contactId=c1&startAfterDate=9 2021-04-15$/);
});

void test("a malformed response rejects with HighLevelShapeError", async () => {
  const { value } = await run("get_opportunity", { opportunityId: "o1" }, { id: "o1" });
  expect(value).toBeInstanceOf(HighLevelShapeError);
});

void test("checkArgs refuses missing, unknown, mistyped and off-enum arguments", () => {
  const contact = TOOL_INDEX.get("get_contact");
  const search = TOOL_INDEX.get("search_opportunities");
  if (contact === undefined || search === undefined) throw new Error("missing tools");
  for (const args of [{}, { contactId: 7 }, { contactId: "c1", locationId: "x" }]) {
    expect(() => checkArgs(contact, args)).toThrow(ToolArgumentError);
  }
  expect(() => checkArgs(search, { status: "maybe" })).toThrow("status must be");
});
