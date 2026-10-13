/** Opportunity helpers: request shape, parsing, ensure-open, and the write guard. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { ACCOUNTS, createClient } from "../src/accounts.ts";
import * as opps from "../src/crm/opportunities.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";

const LOC = ACCOUNTS.primary.locationId;
const PARSED = {
  id: "o1",
  name: "Deal",
  status: "open",
  pipelineId: "p1",
  pipelineStageId: "s1",
  contactId: "c1",
  monetaryValue: 500,
};
const OPP = { ...PARSED, extra: "dropped" };
const WANTED = {
  contactId: "c1",
  pipelineId: "p1",
  pipelineStageId: "s1",
  name: "Deal",
};

/** A client whose fetch answers `replies` in order and records each request. */
function stub(replies: unknown[], allowWrites = false) {
  const seen: { line: string; body: unknown }[] = [];
  const client = createClient({
    account: "primary",
    token: "pit-test",
    allowWrites,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const text = await request.text();
      const version = request.headers.get("Version") ?? "none";
      seen.push({
        line: `${request.method} ${url.pathname}${url.search} ${version}`,
        body: text ? JSON.parse(text) : undefined,
      });
      return Response.json(replies[seen.length - 1] ?? {});
    },
  });
  return { client, seen, lines: () => seen.map((s) => s.line) };
}

void describe("opportunities", () => {
  void test("searchOpportunities sends filters on location_id and parses the page", async () => {
    const { client, lines } = stub([
      { opportunities: [OPP], meta: { total: 7, startAfterId: "o1" } },
    ]);
    const search = { contactId: "c1", stageId: "s1", status: "open" } as const;
    const page = await opps.searchOpportunities(client, {
      ...search,
      startAfterId: "o0",
    });
    expect(lines()).toEqual([
      `GET /opportunities/search?location_id=${LOC}&contact_id=c1&pipeline_stage_id=s1&status=open&limit=20&startAfterId=o0 2021-07-28`,
    ]);
    expect(page).toEqual({ opportunities: [PARSED], total: 7, nextStartAfterId: "o1" });
  });

  void test("searchOpportunities pages with the startAfter + startAfterId pair", async () => {
    const meta = { total: 2, startAfter: 1700000000000, startAfterId: "o1" };
    const { client, lines } = stub([
      { opportunities: [OPP], meta },
      { opportunities: [] },
    ]);
    const page = await opps.searchOpportunities(client, { limit: 1 });
    expect(page).toEqual({
      opportunities: [PARSED],
      total: 2,
      nextStartAfter: 1700000000000,
      nextStartAfterId: "o1",
    });
    const cursor = {
      startAfter: page.nextStartAfter,
      startAfterId: page.nextStartAfterId,
    };
    await opps.searchOpportunities(client, { limit: 1, ...cursor });
    expect(lines()[1]).toBe(
      `GET /opportunities/search?location_id=${LOC}&limit=1&startAfter=1700000000000&startAfterId=o1 2021-07-28`,
    );
  });

  void test("setOpportunityStatus sends lostReasonId and reads succeded", async () => {
    const { client, seen } = stub([{ succeded: false }, {}], true);
    const change = { id: "o1", status: "lost", lostReasonId: "r1" } as const;
    expect(await opps.setOpportunityStatus(client, change)).toBe(false);
    expect(seen[0]?.body).toEqual({ status: "lost", lostReasonId: "r1" });
    await expect(opps.setOpportunityStatus(client, change)).rejects.toThrow(
      HighLevelShapeError,
    );
  });

  void test("search maps pipeline, query and limit; no meta means no cursor", async () => {
    const { client, lines } = stub([{ opportunities: [] }]);
    const search = { pipelineId: "p1", query: "acme co", limit: 5 };
    expect(await opps.searchOpportunities(client, search)).toEqual({
      opportunities: [],
    });
    expect(lines()).toEqual([
      `GET /opportunities/search?location_id=${LOC}&pipeline_id=p1&q=acme+co&limit=5 2021-07-28`,
    ]);
  });

  void test("a malformed opportunity throws HighLevelShapeError", async () => {
    const { client } = stub([{ opportunities: [{ id: "o1" }] }]);
    await expect(opps.searchOpportunities(client)).rejects.toThrow(HighLevelShapeError);
  });

  void test("getOpportunity GETs one opportunity and parses its envelope", async () => {
    const { client, lines } = stub([{ opportunity: OPP }]);
    expect(await opps.getOpportunity(client, "o 1")).toEqual(PARSED);
    expect(lines()).toEqual(["GET /opportunities/o%201 2021-07-28"]);
  });

  void test("a missing opportunity envelope throws HighLevelShapeError", async () => {
    const { client } = stub([{ id: "o1" }]);
    await expect(opps.getOpportunity(client, "o1")).rejects.toThrow(
      HighLevelShapeError,
    );
  });

  void test("create, update, move and status send the right requests", async () => {
    const replies = [OPP, OPP, OPP].map((opportunity) => ({ opportunity }));
    const { client, seen, lines } = stub([...replies, { succeded: true }], true);
    expect(await opps.createOpportunity(client, WANTED)).toEqual(PARSED);
    const patch = { monetaryValue: 9 };
    expect(await opps.updateOpportunity(client, "o1", patch)).toEqual(PARSED);
    await opps.moveOpportunityStage(client, { id: "o1", pipelineStageId: "s2" });
    await opps.setOpportunityStatus(client, { id: "o1", status: "won" });
    expect(lines()).toEqual([
      "POST /opportunities/ 2021-07-28",
      "PUT /opportunities/o1 2021-07-28",
      "PUT /opportunities/o1 2021-07-28",
      "PUT /opportunities/o1/status 2021-07-28",
    ]);
    expect(seen.map((s) => s.body)).toEqual([
      { ...WANTED, status: "open", locationId: LOC },
      { monetaryValue: 9 },
      { pipelineStageId: "s2" },
      { status: "won" },
    ]);
  });

  void test("createOpportunity keeps a given status; a bad reply throws", async () => {
    const { client, seen } = stub([{ id: "o1" }], true);
    const fields = { ...WANTED, status: "won", assignedTo: "u1" } as const;
    await expect(opps.createOpportunity(client, fields)).rejects.toThrow(
      HighLevelShapeError,
    );
    expect(seen[0]?.body).toEqual({ ...fields, locationId: LOC });
  });

  void test("ensureOpenOpportunity returns an existing open one without writing", async () => {
    const { client, lines } = stub([{ opportunities: [OPP] }], true);
    const result = await opps.ensureOpenOpportunity(client, { ...WANTED, name: "New" });
    expect(result).toEqual({ opportunity: PARSED, created: false });
    expect(lines()).toEqual([
      `GET /opportunities/search?location_id=${LOC}&contact_id=c1&pipeline_id=p1&status=open&limit=20 2021-07-28`,
    ]);
  });

  void test("ensureOpenOpportunity creates one when none is open", async () => {
    const won = { ...OPP, status: "won" };
    const { client, seen } = stub(
      [{ opportunities: [won] }, { opportunity: OPP }],
      true,
    );
    const result = await opps.ensureOpenOpportunity(client, WANTED);
    expect(result).toEqual({ opportunity: PARSED, created: true });
    expect(seen[1]?.line).toBe("POST /opportunities/ 2021-07-28");
    expect(seen[1]?.body).toEqual({ ...WANTED, status: "open", locationId: LOC });
  });

  void test("a write without allowWrites is blocked before fetch", async () => {
    const { client, seen } = stub([]);
    const change = { id: "o1", status: "lost" } as const;
    await expect(opps.setOpportunityStatus(client, change)).rejects.toThrow(
      "read-only",
    );
    await expect(opps.createOpportunity(client, WANTED)).rejects.toThrow("read-only");
    expect(seen).toHaveLength(0);
  });
});
