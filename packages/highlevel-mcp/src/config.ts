/**
 * The launch configuration, read once from `GHL_MCP_*` and validated at boot.
 *
 * @module
 */
import { readFile } from "node:fs/promises";

import { ACCOUNTS, type AccountName } from "@rodaddy/connectors-highlevel";

import { CAPABILITIES, parseCapability, type Capability } from "./policy.ts";

/** The validated launch configuration. */
export interface McpConfig {
  account: AccountName;
  capability: Capability;
  token: string;
}

/** The environment is invalid; the message says which variable and why, never a value. */
export class McpConfigError extends Error {
  constructor(message: string) {
    super(`highlevel-mcp: ${message}`);
    this.name = "McpConfigError";
  }
}

/** Inputs to {@link loadConfig}. */
export interface LoadConfigOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Reads `GHL_MCP_TOKEN_FILE`; defaults to `fs.readFile` as UTF-8. */
  readText?: (path: string) => Promise<string>;
}

/**
 * Read and validate `GHL_MCP_ACCOUNT`, `GHL_MCP_CAPABILITY` (default `read`),
 * and exactly one of `GHL_MCP_TOKEN` / `GHL_MCP_TOKEN_FILE`.
 *
 * Until write tools ship, a capability above `read` is refused rather than
 * accepted and silently ignored.
 *
 * @throws McpConfigError on any invalid or missing input.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<McpConfig> {
  const { env } = options;
  const account = env["GHL_MCP_ACCOUNT"]?.trim() ?? "";
  if (!Object.hasOwn(ACCOUNTS, account)) {
    const names = Object.keys(ACCOUNTS).join("|");
    throw new McpConfigError(`GHL_MCP_ACCOUNT must be one of ${names}.`);
  }
  const capability = parseCapability(env["GHL_MCP_CAPABILITY"]);
  if (capability === undefined) {
    throw new McpConfigError(
      `GHL_MCP_CAPABILITY must be one of ${CAPABILITIES.join("|")}.`,
    );
  }
  refuseInert(capability);
  const token = await readToken(
    env,
    options.readText ?? ((path) => readFile(path, "utf8")),
  );
  return { account: account as AccountName, capability, token };
}

/** Refuse launch settings that this release cannot act on. */
function refuseInert(capability: Capability): void {
  if (capability !== "read") {
    throw new McpConfigError(
      `GHL_MCP_CAPABILITY=${capability} has no effect: this release has no write tools. Use read or leave it unset.`,
    );
  }
}

async function readToken(
  env: LoadConfigOptions["env"],
  readText: (path: string) => Promise<string>,
): Promise<string> {
  const inline = env["GHL_MCP_TOKEN"]?.trim();
  const path = env["GHL_MCP_TOKEN_FILE"]?.trim();
  if (inline && path) {
    throw new McpConfigError("set GHL_MCP_TOKEN or GHL_MCP_TOKEN_FILE, not both.");
  }
  if (inline) return inline;
  if (!path)
    throw new McpConfigError("GHL_MCP_TOKEN or GHL_MCP_TOKEN_FILE is required.");
  const text = await readText(path).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    throw new McpConfigError(`GHL_MCP_TOKEN_FILE could not be read: ${reason}`);
  });
  const token = text.trim();
  if (!token) throw new McpConfigError("GHL_MCP_TOKEN_FILE is empty.");
  return token;
}
