/** getLocation and the one-call location audit. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { ACCOUNTS, createClient } from "../src/accounts.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";
import { auditLocation, getLocation } from "../src/locations.ts";

const loc = ACCOUNTS.primary.locationId;

interface Seen {
  method: string;
  route: string;
  version: string | null;
}

/**
 * A client whose fetch answers by path; a number answers with that HTTP
 * status, a function answers from the request URL.
 */
function fake(routes: Record<string, unknown>) {
  const seen: Seen[] = [];
  const client = createClient({
    account: "primary",
    token: "pit-test",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const route = `${url.pathname}${url.search}`;
      seen.push({
        method: request.method,
        route,
        version: request.headers.get("Version"),
      });
      const answer = routes[url.pathname];
      const reply = typeof answer === "function" ? answer(url) : answer;
      if (typeof reply === "number") return Response.json({}, { status: reply });
      return Response.json(reply ?? {});
    },
  });
  return { client, seen };
}

describe("getLocation", () => {
  test("reads the location and folds the flat address", async () => {
    const location = {
      id: loc,
      name: "Example Co",
      timezone: "America/New_York",
      phone: "+1",
    };
    const flat = { address: "1 Main", city: "Hauppauge", country: "US" };
    const { client, seen } = fake({
      [`/locations/${loc}`]: { location: { ...location, ...flat } },
    });
    expect(await getLocation(client)).toEqual({
      id: loc,
      name: "Example Co",
      timezone: "America/New_York",
      phone: "+1",
      address: { line1: "1 Main", city: "Hauppauge", country: "US" },
    });
    expect(seen).toEqual([
      { method: "GET", route: `/locations/${loc}`, version: "2021-07-28" },
    ]);
  });

  test("a response without a location is a shape error", async () => {
    const { client } = fake({});
    await expect(getLocation(client)).rejects.toThrow(HighLevelShapeError);
  });
});

describe("auditLocation", () => {
  test("reads every area concurrently; one failure stays in its area", async () => {
    const { client, seen } = fake({
      [`/locations/${loc}/customFields`]: { customFields: [{ name: "Budget" }] },
      [`/locations/${loc}/tags`]: 403,
      "/opportunities/pipelines": {
        pipelines: [{ name: "Sales", stages: [{ name: "New" }] }],
      },
      "/workflows/": { workflows: [{ id: "w1", name: "Intake", status: "draft" }] },
      "/calendars/": { calendars: [{ name: "Intro" }] },
      "/funnels/funnel/list": { data: [{ name: "Landing" }] },
      "/forms/": { forms: [] },
      "/contacts/": { contacts: [], meta: { total: 42 } },
    });
    expect(await auditLocation(client)).toEqual({
      customFields: { ok: true, value: ["Budget"] },
      tags: { ok: false, error: "HighLevelApiError", status: 403 },
      pipelines: { ok: true, value: [{ name: "Sales", stages: ["New"] }] },
      workflows: { ok: true, value: [{ name: "Intake", status: "draft" }] },
      calendars: { ok: true, value: ["Intro"] },
      funnels: { ok: true, value: ["Landing"] },
      forms: { ok: true, value: [] },
      contactTotal: { ok: true, value: 42 },
    });
    const q = `?locationId=${loc}`;
    expect(seen.map((s) => `${s.method} ${s.route} ${s.version}`).sort()).toEqual(
      [
        `GET /locations/${loc}/customFields 2021-07-28`,
        `GET /locations/${loc}/tags 2021-07-28`,
        `GET /opportunities/pipelines${q} 2021-07-28`,
        `GET /workflows/${q} v3`,
        `GET /calendars/${q} 2021-04-15`,
        `GET /funnels/funnel/list${q}&limit=50&offset=0 2021-07-28`,
        `GET /forms/${q}&limit=50&skip=0 2021-07-28`,
        `GET /contacts/${q}&limit=1 2021-07-28`,
      ].sort(),
    );
  });

  test("a malformed area reports a shape error, not a crash", async () => {
    const { client } = fake({ "/contacts/": { meta: {} } });
    const audit = await auditLocation(client);
    expect(audit.contactTotal).toEqual({ ok: false, error: "HighLevelShapeError" });
  });
});

describe("auditLocation paging and nameless items", () => {
  /** `count` items named `${prefix}<n>` from `start`, the page the query asks for. */
  const page = (prefix: string, start: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ name: `${prefix}${start + i}` }));

  test("pages forms by skip until total, funnels by offset until a short page", async () => {
    const { client, seen } = fake({
      "/forms/": (url: URL) => {
        const skip = Number(url.searchParams.get("skip"));
        return { forms: page("f", skip, skip === 0 ? 50 : 3), total: 53 };
      },
      "/funnels/funnel/list": (url: URL) => {
        const offset = Number(url.searchParams.get("offset"));
        return { funnels: page("u", offset, offset === 0 ? 50 : 1), count: 51 };
      },
    });
    const audit = await auditLocation(client);
    expect(audit.forms).toEqual({
      ok: true,
      value: page("f", 0, 53).map((f) => f.name),
    });
    expect(audit.funnels).toEqual({
      ok: true,
      value: page("u", 0, 51).map((f) => f.name),
    });
    const routes = seen.map((s) => s.route).filter((r) => /forms|funnels/.test(r));
    expect(routes.sort()).toEqual(
      [
        `/forms/?locationId=${loc}&limit=50&skip=0`,
        `/forms/?locationId=${loc}&limit=50&skip=50`,
        `/funnels/funnel/list?locationId=${loc}&limit=50&offset=0`,
        `/funnels/funnel/list?locationId=${loc}&limit=50&offset=50`,
      ].sort(),
    );
  });

  test("a nameless item is skipped, not a whole-area failure", async () => {
    const { client } = fake({
      [`/locations/${loc}/tags`]: { tags: [{ name: "vip" }, { id: "t2" }] },
      "/opportunities/pipelines": {
        pipelines: [{ name: "Sales", stages: [{ id: "s1" }, { name: "Won" }] }, {}],
      },
    });
    const audit = await auditLocation(client);
    expect(audit.tags).toEqual({ ok: true, value: ["vip"] });
    expect(audit.pipelines).toEqual({
      ok: true,
      value: [{ name: "Sales", stages: ["Won"] }],
    });
  });
});
