/** JSON-RPC dispatch and the stdio loop, over a stub registry. */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { expect } from "expect";

import { createClient } from "@rodaddy/connectors-highlevel";

import {
  dispatch,
  PROTOCOL_VERSION,
  serve,
  type ServerContext,
} from "../src/server.ts";
import { TOOL_INDEX, type ToolDef } from "../src/tools/index.ts";

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/** A server over two stub tools; `calls` counts handler runs. */
function server() {
  const calls: string[] = [];
  const tool = (name: string, value: () => unknown): ToolDef => ({
    name,
    description: name,
    inputSchema,
    handler: async () => {
      calls.push(name);
      return value();
    },
  });
  const tools = [
    tool("ok", () => ({ hello: "world" })),
    tool("boom", () => {
      throw new TypeError("bad shape");
    }),
  ];
  const client = createClient({ account: "primary", token: "pit-test" });
  const ctx: ServerContext = {
    tools: { client, capability: "read" },
    registry: new Map(tools.map((t) => [t.name, t])),
  };
  return { ctx, calls };
}

const call = (ctx: ServerContext, name: string, args: unknown = {}) =>
  dispatch(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    ctx,
  );

void test("initialize, notifications and unknown methods", async () => {
  const { ctx } = server();
  expect(
    await dispatch({ jsonrpc: "2.0", id: 0, method: "initialize" }, ctx),
  ).toMatchObject({
    result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} } },
  });
  const note = { jsonrpc: "2.0", method: "notifications/initialized" };
  expect(await dispatch(note, ctx)).toBeUndefined();
  const unknown = await dispatch({ jsonrpc: "2.0", id: 2, method: "nope" }, ctx);
  expect(unknown).toMatchObject({ id: 2, error: { code: -32601 } });
});

void test("tools/list lists the registry; the default is the read allowlist", async () => {
  const { ctx } = server();
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  expect(await dispatch(list, ctx)).toMatchObject({
    result: {
      tools: [{ name: "ok", inputSchema }, { name: "boom" }],
    },
  });
  const all = await dispatch(list, { tools: ctx.tools });
  expect(all).toMatchObject({
    result: { tools: [...TOOL_INDEX.values()].map(({ name }) => ({ name })) },
  });
});

void test("tools/call returns text content, and tool failures as isError", async () => {
  const { ctx, calls } = server();
  expect(await call(ctx, "ok")).toMatchObject({
    result: {
      content: [{ type: "text", text: JSON.stringify({ hello: "world" }, null, 2) }],
    },
  });
  expect(await call(ctx, "boom")).toMatchObject({
    result: {
      isError: true,
      content: [{ text: "Tool 'boom' failed: TypeError: bad shape" }],
    },
  });
  expect(await call(ctx, "ok", { extra: 1 })).toMatchObject({
    result: { isError: true },
  });
  expect(calls).toEqual(["ok", "boom"]);
});

void test("an unlisted tool is refused", async () => {
  const { ctx, calls } = server();
  expect(await call(ctx, "delete_everything")).toMatchObject({
    error: { code: -32601 },
  });
  expect(calls).toEqual([]);
});

void test("serve answers each line and reports a parse error", async () => {
  const { ctx } = server();
  const input = new PassThrough();
  const output = new PassThrough();
  const done = serve({ ctx, input, output });
  input.end(
    'not json\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":9,"method":"initialize"}\n',
  );
  await done;
  const replies = String(output.read())
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  expect(replies).toMatchObject([
    { id: null, error: { code: -32700 } },
    { id: 9, result: { protocolVersion: PROTOCOL_VERSION } },
  ]);
});

void test("server.ts starts with a node shebang, so the npm bin runs under node", () => {
  const source = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
  expect(source.split("\n")[0]).toBe("#!/usr/bin/env node");
});

void test("the entry point boots and refuses a missing account without echoing env", () => {
  const entry = fileURLToPath(new URL("../src/server.ts", import.meta.url));
  const run = spawnSync(process.execPath, ["--conditions=@rodaddy/source", entry], {
    env: { PATH: process.env["PATH"] ?? "", GHL_MCP_TOKEN: "pit-test" },
    input: "",
    encoding: "utf8",
  });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("GHL_MCP_ACCOUNT must be one of");
  expect(run.stderr).not.toContain("pit-test");
});
