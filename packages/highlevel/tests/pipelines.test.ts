/** Pipeline helpers: list request, parsing, and resolve by id or name. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { ACCOUNTS, createClient } from "../src/accounts.ts";
import * as pipes from "../src/crm/pipelines.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";

const NEW = { id: "s1", name: "New", position: 0 };
const REPLIED = { id: "s2", name: "Replied", position: 1 };
const BODY = {
  pipelines: [
    { id: "p1", name: "Outreach", stages: [NEW, REPLIED] },
    { id: "p2", name: "Sales" },
  ],
};

/** A client whose fetch answers `reply` and records each request line. */
function stub(reply: unknown) {
  const lines: string[] = [];
  const client = createClient({
    account: "primary",
    token: "pit-test",
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const version = request.headers.get("Version") ?? "none";
      lines.push(`${request.method} ${url.pathname}${url.search} ${version}`);
      return Response.json(reply);
    },
  });
  return { client, lines };
}

void describe("pipelines", () => {
  void test("listPipelines GETs the location's pipelines and parses stages", async () => {
    const { client, lines } = stub(BODY);
    expect(await pipes.listPipelines(client)).toEqual([
      { id: "p1", name: "Outreach", stages: [NEW, REPLIED] },
      { id: "p2", name: "Sales", stages: [] },
    ]);
    const loc = ACCOUNTS.primary.locationId;
    expect(lines).toEqual([
      `GET /opportunities/pipelines?locationId=${loc} 2021-07-28`,
    ]);
  });

  void test("a malformed pipeline throws HighLevelShapeError", async () => {
    const { client } = stub({ pipelines: [{ id: "p1" }] });
    await expect(pipes.listPipelines(client)).rejects.toThrow(HighLevelShapeError);
  });

  void test("resolvePipeline matches a case-insensitive name or an id", async () => {
    const { client } = stub(BODY);
    const wanted = { pipeline: " outreach ", stage: "REPLIED" };
    const byName = await pipes.resolvePipeline(client, wanted);
    expect(byName.pipeline.id).toBe("p1");
    expect(byName.stage).toEqual({ id: "s2", name: "Replied" });
    const byId = await pipes.resolvePipeline(client, { pipeline: "p2" });
    expect(byId).toEqual({ pipeline: { id: "p2", name: "Sales", stages: [] } });
  });

  void test("a miss throws PipelineNotFoundError listing what exists", async () => {
    const { client } = stub(BODY);
    await expect(pipes.resolvePipeline(client, { pipeline: "Nope" })).rejects.toThrow(
      'HighLevel pipeline "Nope" not found. Available: Outreach, Sales.',
    );
    const stageMiss = pipes.resolvePipeline(client, { pipeline: "p1", stage: "Won" });
    await expect(stageMiss).rejects.toThrow(pipes.PipelineNotFoundError);
    await expect(stageMiss).rejects.toThrow(
      'stage "Won" in pipeline "Outreach" not found. Available: New, Replied.',
    );
  });
});
