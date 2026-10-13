/** Public workflows: list (Version v3), enroll and remove a contact. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { createClient } from "../src/accounts.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";
import {
  enrollContactInWorkflow,
  listWorkflows,
  removeContactFromWorkflow,
} from "../src/workflows/public.ts";

interface Seen {
  method: string;
  url: URL;
  version: string | null;
  body: string;
}

function fake(reply: unknown, allowWrites = true) {
  const seen: Seen[] = [];
  const client = createClient({
    account: "primary",
    token: "pit-test",
    allowWrites,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      seen.push({
        method: request.method,
        url: new URL(request.url),
        version: request.headers.get("Version"),
        body: await request.text(),
      });
      return Response.json(reply);
    },
  });
  return { client, seen };
}

describe("workflows", () => {
  test("listWorkflows sends Version v3 and parses metadata", async () => {
    const { client, seen } = fake({
      workflows: [
        { id: "w1", name: "Intake", status: "published", version: 3, updatedAt: "t" },
        { id: "w2", name: "Draft", status: "draft" },
      ],
    });
    expect(await listWorkflows(client)).toEqual([
      { id: "w1", name: "Intake", status: "published", version: 3, updatedAt: "t" },
      { id: "w2", name: "Draft", status: "draft" },
    ]);
    expect(seen[0]?.method).toBe("GET");
    expect(`${seen[0]?.url.pathname}${seen[0]?.url.search}`).toBe(
      `/workflows/?locationId=${client.locationId}`,
    );
    expect(seen[0]?.version).toBe("v3");
  });

  test("a workflow without a status is a shape error", async () => {
    const { client } = fake({ workflows: [{ id: "w1", name: "x" }] });
    await expect(listWorkflows(client)).rejects.toThrow(HighLevelShapeError);
  });

  test("enroll posts eventStartTime to the contact's workflow path", async () => {
    const { client, seen } = fake({ succeded: true });
    const result = await enrollContactInWorkflow(client, {
      contactId: "c1",
      workflowId: "w1",
      eventStartTime: "2026-10-07T09:00:00Z",
    });
    expect(result).toEqual({ succeeded: true });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url.pathname).toBe("/contacts/c1/workflow/w1");
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      eventStartTime: "2026-10-07T09:00:00Z",
    });
    expect(seen[0]?.version).toBe("2021-07-28");
  });

  test("remove sends DELETE with an empty body and reads succeded", async () => {
    const { client, seen } = fake({ succeded: false });
    const result = await removeContactFromWorkflow(client, {
      contactId: "c1",
      workflowId: "w1",
    });
    expect(result).toEqual({ succeeded: false });
    expect(seen[0]?.method).toBe("DELETE");
    expect(seen[0]?.url.pathname).toBe("/contacts/c1/workflow/w1");
    expect(seen[0]?.body).toBe("{}");
    expect(seen[0]?.version).toBe("2021-07-28");
  });

  test("an enrollment response without succeded is a shape error", async () => {
    const { client } = fake({});
    await expect(
      enrollContactInWorkflow(client, { contactId: "c1", workflowId: "w1" }),
    ).rejects.toThrow(HighLevelShapeError);
  });

  test("enrolling without allowWrites is blocked before fetch", async () => {
    const { client, seen } = fake({ succeded: true }, false);
    await expect(
      enrollContactInWorkflow(client, { contactId: "c1", workflowId: "w1" }),
    ).rejects.toThrow(/read-only mode/);
    expect(seen).toHaveLength(0);
  });
});
