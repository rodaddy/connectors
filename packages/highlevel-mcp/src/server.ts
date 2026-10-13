#!/usr/bin/env node
/**
 * The MCP server: JSON-RPC 2.0 over stdio, one message per line (after
 * an earlier MCP server). Methods:
 * `initialize`, `tools/list`, `tools/call`; notifications get no reply.
 * Logs go to stderr and never carry a token or a message body.
 *
 * @module
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { createClient } from "@rodaddy/connectors-highlevel";

import { loadConfig, McpConfigError } from "./config.ts";
import {
  checkArgs,
  TOOL_INDEX,
  type ToolContext,
  type ToolDef,
} from "./tools/index.ts";

/** The MCP protocol revision this server speaks. */
export const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "highlevel-mcp", version: "0.1.0" };

/** A JSON-RPC reply. */
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: unknown; result: unknown }
  | { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };

/** What {@link dispatch} serves: the tool context and the allowlist. */
export interface ServerContext {
  tools: ToolContext;
  /** The allowlist; defaults to {@link TOOL_INDEX}. */
  registry?: ReadonlyMap<string, ToolDef>;
}

type Params = Readonly<Record<string, unknown>>;
type Method = (params: Params, ctx: ServerContext) => unknown;

/** A JSON-RPC error a method raises; becomes the reply's `error`. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Params =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});

const METHODS: Record<string, Method> = {
  initialize: () => ({
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  }),
  "tools/list": (_params, ctx) => ({
    tools: [...(ctx.registry ?? TOOL_INDEX).values()].map(
      ({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }),
    ),
  }),
  "tools/call": callTool,
};

async function callTool(params: Params, ctx: ServerContext): Promise<unknown> {
  const name = typeof params["name"] === "string" ? params["name"] : "";
  const tool = (ctx.registry ?? TOOL_INDEX).get(name);
  if (tool === undefined)
    throw new RpcError(-32601, `Tool not found or not allowed: ${name}`);
  const args = isRecord(params["arguments"]) ? params["arguments"] : {};
  try {
    checkArgs(tool, args);
    return textResult(JSON.stringify(await tool.handler(args, ctx.tools), null, 2));
  } catch (error: unknown) {
    const reason =
      error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
    return textResult(`Tool '${name}' failed: ${reason}`, true);
  }
}

function methodFor(name: unknown): Method {
  const known = typeof name === "string" && Object.hasOwn(METHODS, name);
  const method = known ? METHODS[name] : undefined;
  if (method === undefined)
    throw new RpcError(-32601, `Method not found: ${String(name)}`);
  return method;
}

/**
 * Answer one parsed JSON-RPC message.
 *
 * @returns The reply, or `undefined` for a notification.
 */
export async function dispatch(
  message: unknown,
  ctx: ServerContext,
): Promise<JsonRpcResponse | undefined> {
  const request = isRecord(message) ? message : {};
  const id = request["id"];
  if (id === undefined) return undefined;
  try {
    const params = isRecord(request["params"]) ? request["params"] : {};
    return {
      jsonrpc: "2.0",
      id,
      result: await methodFor(request["method"])(params, ctx),
    };
  } catch (error: unknown) {
    const code = error instanceof RpcError ? error.code : -32603;
    const text = error instanceof Error ? error.message : "Internal error";
    return { jsonrpc: "2.0", id, error: { code, message: text } };
  }
}

/** Streams for {@link serve}. */
export interface ServeOptions {
  ctx: ServerContext;
  input: Readable;
  output: Writable;
}

/** Read newline-delimited JSON-RPC from `input` and write each reply to `output`. */
export async function serve({ ctx, input, output }: ServeOptions): Promise<void> {
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let reply: JsonRpcResponse | undefined;
    try {
      reply = await dispatch(JSON.parse(line), ctx);
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      reply = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      };
    }
    if (reply !== undefined) output.write(`${JSON.stringify(reply)}\n`);
  }
}

async function main(): Promise<void> {
  const config = await loadConfig({ env: process.env });
  const client = createClient({ account: config.account, token: config.token });
  process.stderr.write(
    `[highlevel-mcp] ready: account ${config.account}, capability ${config.capability}\n`,
  );
  const tools: ToolContext = { client, capability: config.capability };
  await serve({ ctx: { tools }, input: process.stdin, output: process.stdout });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const text =
      error instanceof McpConfigError
        ? error.message
        : `[highlevel-mcp] fatal: ${String(error)}`;
    process.stderr.write(`${text}\n`);
    process.exitCode = 1;
  });
}
