/**
 * Generate `catalog/rest-catalog.json` from the pinned upstream v2 (`apps/*.json`)
 * and v3 (`apps/v3/*-v3.json`) OpenAPI documents. `--out <dir>` writes elsewhere.
 *
 * @module
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ApiFamily, RestCatalog, RestEndpoint } from "../src/catalog/types.ts";
import { say } from "./out.ts";
import { extractEndpoints } from "./rest-spec.ts";
import { outDir, provenance, upstreamRoot, writeJson } from "./upstream.ts";

const FAMILY_DIRS: Record<ApiFamily, string> = { v2: "apps", v3: "apps/v3" };

async function familyEndpoints(family: ApiFamily): Promise<RestEndpoint[]> {
  const dir = FAMILY_DIRS[family];
  const files = (await readdir(join(upstreamRoot, dir)))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const endpoints: RestEndpoint[] = [];
  for (const file of files) {
    const spec: unknown = JSON.parse(
      await readFile(join(upstreamRoot, dir, file), "utf8"),
    );
    endpoints.push(...extractEndpoints(spec, { family, source: `${dir}/${file}` }));
  }
  return endpoints;
}

const sortKey = (e: RestEndpoint) =>
  `${e.family}\0${e.service}\0${e.path}\0${e.method}`;
const endpoints = [...(await familyEndpoints("v2")), ...(await familyEndpoints("v3"))];
endpoints.sort((left, right) => sortKey(left).localeCompare(sortKey(right)));

const catalog: RestCatalog = {
  provenance: await provenance("apps"),
  endpointCount: endpoints.length,
  services: [...new Set(endpoints.map((endpoint) => endpoint.service))].sort(),
  endpoints,
};

await writeJson(join(outDir(process.argv), "rest-catalog.json"), catalog);
const count = (family: ApiFamily) =>
  endpoints.filter((e) => e.family === family).length;
say(
  `Generated ${catalog.endpointCount} REST endpoints (v2 ${count("v2")}, v3 ${count("v3")}).`,
);
