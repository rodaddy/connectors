/** loadRuntimeConfig: accepts a read-only config, refuses a write-enabled one. */
import { after, before, describe, test } from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "expect";

import { loadRuntimeConfig } from "../src/config/runtime.ts";

// The runner's temp dir in CI, else the OS temp dir (set TMPDIR to move it).
const tempRoot = join(process.env.RUNNER_TEMP ?? tmpdir(), "connectors");
let testRoot = "";

before(async () => {
  await mkdir(tempRoot, { recursive: true });
  testRoot = await mkdtemp(join(tempRoot, "config-test-"));
});

after(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

async function writeConfig(readOnly: boolean): Promise<string> {
  const path = join(testRoot, `runtime-${String(readOnly)}.json`);
  await writeFile(
    path,
    JSON.stringify({
      baseUrl: "https://services.leadconnectorhq.com",
      friendlyBusinessName: "Test Business",
      locationId: "location-1",
      privateIntegrationToken: "pit-test-token",
      readOnly,
    }),
    { mode: 0o600 },
  );
  return path;
}

describe("loadRuntimeConfig", () => {
  test("loads an explicitly read-only configuration", async () => {
    const config = await loadRuntimeConfig(await writeConfig(true));
    expect(config.locationId).toBe("location-1");
    expect(config.readOnly).toBe(true);
  });

  test("refuses a token file readable by group or others", async () => {
    const path = await writeConfig(true);
    await chmod(path, 0o644);
    await expect(loadRuntimeConfig(path)).rejects.toThrow(
      "HighLevel runtime config must not be readable by group or others (chmod 600).",
    );
  });

  test("rejects write-enabled configuration", async () => {
    const path = await writeConfig(false);
    await expect(loadRuntimeConfig(path)).rejects.toThrow(
      "must explicitly enable read-only mode",
    );
  });
});
