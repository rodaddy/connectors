/** Launch configuration and the capability envelope. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { loadConfig, McpConfigError } from "../src/config.ts";
import { decideWrite } from "../src/policy.ts";

const noFile = async () => {
  throw new Error("no file expected");
};

describe("loadConfig", () => {
  void test("capability defaults to read", async () => {
    const env = { GHL_MCP_ACCOUNT: "primary", GHL_MCP_TOKEN: "pit-test" };
    expect(await loadConfig({ env, readText: noFile })).toEqual({
      account: "primary",
      capability: "read",
      token: "pit-test",
    });
  });

  void test("reads the token file; an explicit READ capability is accepted", async () => {
    const env = {
      GHL_MCP_ACCOUNT: "secondary",
      GHL_MCP_CAPABILITY: "READ",
      GHL_MCP_TOKEN_FILE: "/t",
    };
    const config = await loadConfig({
      env,
      readText: async (path) => (path === "/t" ? "pit-file\n" : ""),
    });
    expect(config).toEqual({
      account: "secondary",
      capability: "read",
      token: "pit-file",
    });
  });

  void test("refuses settings that would do nothing until write tools ship", async () => {
    const base = { GHL_MCP_ACCOUNT: "primary", GHL_MCP_TOKEN: "pit-test" };
    const cases: [Record<string, string>, string][] = [
      [{ ...base, GHL_MCP_CAPABILITY: "write" }, "no write tools"],
      [{ ...base, GHL_MCP_CAPABILITY: "Elevated" }, "no write tools"],
    ];
    for (const [env, message] of cases) {
      const loading = loadConfig({ env, readText: noFile });
      await expect(loading).rejects.toThrow(McpConfigError);
      await expect(loading).rejects.toThrow(message);
    }
  });

  void test("each invalid input fails with a message naming the variable", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ GHL_MCP_TOKEN: "pit-test" }, "GHL_MCP_ACCOUNT"],
      [
        {
          GHL_MCP_ACCOUNT: "primary",
          GHL_MCP_CAPABILITY: "root",
          GHL_MCP_TOKEN: "pit-test",
        },
        "GHL_MCP_CAPABILITY",
      ],
      [{ GHL_MCP_ACCOUNT: "primary" }, "is required"],
      [
        {
          GHL_MCP_ACCOUNT: "primary",
          GHL_MCP_TOKEN: "pit-test",
          GHL_MCP_TOKEN_FILE: "/t",
        },
        "not both",
      ],
      [{ GHL_MCP_ACCOUNT: "primary", GHL_MCP_TOKEN_FILE: "/t" }, "could not be read"],
    ];
    for (const [env, message] of cases) {
      const loading = loadConfig({ env, readText: noFile });
      await expect(loading).rejects.toThrow(McpConfigError);
      await expect(loading).rejects.toThrow(message);
    }
    const empty = loadConfig({
      env: { GHL_MCP_ACCOUNT: "primary", GHL_MCP_TOKEN_FILE: "/t" },
      readText: async () => " \n",
    });
    await expect(empty).rejects.toThrow("is empty");
  });
});

describe("decideWrite", () => {
  void test("refuses below the tier's capability and names the relaunch", () => {
    expect(
      decideWrite({ tier: "safe", capability: "read", dryRunRequested: false }),
    ).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("GHL_MCP_CAPABILITY=write"),
    });
    expect(
      decideWrite({ tier: "elevated", capability: "write", dryRunRequested: false })
        .allowed,
    ).toBe(false);
  });

  void test("within the envelope a write runs for real unless dryRun is asked", () => {
    expect(
      decideWrite({ tier: "safe", capability: "write", dryRunRequested: false }),
    ).toEqual({ allowed: true, dryRun: false });
    expect(
      decideWrite({ tier: "elevated", capability: "elevated", dryRunRequested: true }),
    ).toEqual({ allowed: true, dryRun: true });
  });
});
