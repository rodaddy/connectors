/**
 * Shallow-fetch the pinned highlevel-api-docs commit into the temp workspace.
 * Idempotent: a checkout already at the pin is left alone.
 *
 * @module
 */
import { mkdir } from "node:fs/promises";

import { say } from "./out.ts";
import { git, UPSTREAM_COMMIT, UPSTREAM_URL, upstreamRoot } from "./upstream.ts";

async function currentHead(): Promise<string | null> {
  try {
    return await git(upstreamRoot, ["rev-parse", "HEAD"]);
  } catch (error: unknown) {
    say(`No usable checkout yet (${String(error).split("\n")[0]}).`);
    return null;
  }
}

await mkdir(upstreamRoot, { recursive: true });
if ((await currentHead()) !== UPSTREAM_COMMIT) {
  await git(upstreamRoot, ["init", "--quiet"]);
  await git(upstreamRoot, ["remote", "remove", "origin"]).catch(() => "");
  await git(upstreamRoot, ["remote", "add", "origin", UPSTREAM_URL]);
  await git(upstreamRoot, [
    "fetch",
    "--quiet",
    "--depth",
    "1",
    "origin",
    UPSTREAM_COMMIT,
  ]);
  await git(upstreamRoot, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
}

const head = await currentHead();
if (head !== UPSTREAM_COMMIT) {
  throw new Error(`Upstream checkout is at ${head}, not the pin ${UPSTREAM_COMMIT}.`);
}
say(`Upstream at ${UPSTREAM_COMMIT} in ${upstreamRoot}.`);
