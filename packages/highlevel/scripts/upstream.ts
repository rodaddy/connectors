/**
 * The pinned upstream GoHighLevel API docs and where the generators read and write.
 *
 * @module
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { format } from "prettier";

import type { CatalogProvenance } from "../src/catalog/types.ts";

/** The one pin: the highlevel-api-docs commit every committed catalog is built from. */
export const UPSTREAM_COMMIT = "0af86a4cbd48c66a4071c7e509d1079f9f10ed17";

/** The upstream repository. */
export const UPSTREAM_URL = "https://github.com/GoHighLevel/highlevel-api-docs";

/**
 * The shallow checkout of the pinned commit, under the OS temp dir. Set
 * `HIGHLEVEL_UPSTREAM_ROOT` to put it elsewhere (another host, a CI runner).
 */
export const upstreamRoot =
  process.env["HIGHLEVEL_UPSTREAM_ROOT"] ?? join(tmpdir(), "highlevel-api-docs");

/** The committed catalog directory of this package. */
export const catalogRoot = resolve(import.meta.dirname, "../catalog");

const run = promisify(execFile);

/**
 * Run git in a directory and return its trimmed stdout.
 *
 * @param cwd - The working directory.
 * @param args - The git arguments.
 * @returns The trimmed stdout.
 */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

/**
 * Provenance of the upstream checkout. Refuses a checkout that is not the pin.
 *
 * @param sourceRoot - The upstream-relative directory the catalog was read from.
 * @returns The provenance; `generatedAt` is the upstream commit date, so output is stable.
 * @throws Error when the checkout's HEAD is not {@link UPSTREAM_COMMIT}.
 */
export async function provenance(sourceRoot: string): Promise<CatalogProvenance> {
  const upstreamCommit = await git(upstreamRoot, ["rev-parse", "HEAD"]);
  if (upstreamCommit !== UPSTREAM_COMMIT) {
    throw new Error(
      `Upstream HEAD ${upstreamCommit} is not the pin ${UPSTREAM_COMMIT}.`,
    );
  }
  return {
    generatedAt: await git(upstreamRoot, ["show", "-s", "--format=%cI", "HEAD"]),
    upstreamCommit,
    upstreamDescribe: await git(upstreamRoot, ["describe", "--tags", "--always"]),
    sourceRoot,
  };
}

/**
 * Write a value as Prettier-formatted JSON, creating the directory.
 *
 * @param path - The file to write.
 * @param value - The value to serialize.
 */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const text = await format(JSON.stringify(value), { parser: "json", printWidth: 88 });
  await writeFile(path, text);
}

/**
 * The output directory: `--out <dir>` on the command line, else the catalog root.
 *
 * @param argv - The script arguments.
 * @returns The directory to write into.
 */
export function outDir(argv: string[]): string {
  const index = argv.indexOf("--out");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value === undefined ? catalogRoot : resolve(value);
}
