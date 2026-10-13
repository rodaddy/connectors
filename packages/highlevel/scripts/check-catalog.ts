/**
 * Regenerate both catalogs into the temp workspace and fail on any drift from
 * the committed copies.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { say, warn } from "./out.ts";
import { catalogRoot } from "./upstream.ts";

const run = promisify(execFile);
const checkRoot = join(tmpdir(), "connectors-catalog-check");
const outputs = {
  "generate-rest.ts": "rest-catalog.json",
  "generate-webhooks.ts": "webhook-catalog.json",
};

await rm(checkRoot, { recursive: true, force: true });
const drifted: string[] = [];
for (const [script, file] of Object.entries(outputs)) {
  await run(process.execPath, [join(import.meta.dirname, script), "--out", checkRoot]);
  const fresh = await readFile(join(checkRoot, file), "utf8");
  const committed = await readFile(join(catalogRoot, file), "utf8");
  if (fresh !== committed) drifted.push(file);
}
await rm(checkRoot, { recursive: true, force: true });

if (drifted.length > 0) {
  warn(`Catalog drift in ${drifted.join(", ")}; run npm run catalog:generate.`);
  process.exitCode = 1;
} else {
  say("Committed catalogs match the pinned upstream.");
}
