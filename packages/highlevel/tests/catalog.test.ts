/** The catalog generator's extraction rules, and the committed catalog itself. */
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";
import { expect } from "expect";

import {
  extractEndpoints,
  pathParamsOf,
  WRITE_POST_EXCLUSIONS,
} from "../scripts/rest-spec.ts";
import { findOperation, findRoute, restCatalog } from "../src/catalog/index.ts";

const fixture: unknown = JSON.parse(
  await readFile(new URL("fixtures/mini-v3.json", import.meta.url), "utf8"),
);
const [read, write, ...extra] = extractEndpoints(fixture, {
  family: "v3",
  source: "apps/v3/widgets-v3.json",
});

describe("extractEndpoints", () => {
  test("emits one endpoint per HTTP method and skips extensions", () => {
    expect(extra).toEqual([]);
    expect([read?.method, write?.method]).toEqual(["GET", "POST"]);
  });

  test("extracts family, service, path params, query params and scopes", () => {
    expect(read).toMatchObject({
      family: "v3",
      service: "widgets",
      operationId: "get-item",
      pathParams: ["locationId", "itemId"],
      queryParams: ["expand", "userId"],
      requiredQueryParams: ["userId"],
      apiVersions: ["v3"],
      scopes: ["widgets.readonly"],
      accessContexts: ["sub-account"],
      hasBody: false,
      readOnly: true,
    });
  });

  test("an operation with no security has empty scopes, and a body is detected", () => {
    expect(write).toMatchObject({
      scopes: [],
      accessContexts: [],
      apiVersions: [],
      hasBody: true,
      readOnly: false,
    });
  });

  test("marks a POST search read-only and leaves a POST create a write", () => {
    const post = (operationId: string, summary: string) => ({
      post: { operationId, summary, requestBody: {} },
    });
    const spec = {
      paths: {
        "/w/search": post("search-widgets", "Search Widgets"),
        "/w/list": post("widget-feed", "List widgets"),
        "/w": post("create-widget", "Create widget"),
        "/oauth/token": post("get-access-token", "Get Access Token"),
      },
    };
    const flags = extractEndpoints(spec, { family: "v2", source: "apps/w.json" }).map(
      (e) => [e.operationId, e.readOnly],
    );
    expect(flags).toEqual([
      ["search-widgets", true],
      ["widget-feed", true],
      ["create-widget", false],
      ["get-access-token", false],
    ]);
  });

  test("pathParamsOf reads the {name} segments in order", () => {
    expect(pathParamsOf("/a/{x}/b/{y}")).toEqual(["x", "y"]);
    expect(pathParamsOf("/a")).toEqual([]);
  });
});

/** Every POST the generator marks read-only, as sorted `family operationId`. */
const READ_ONLY_POSTS = [
  "v2 filter-users-by-email",
  "v2 get-available-shipping-zones",
  "v2 get-posts",
  "v2 get-social-media-statistics",
  "v2 get-tags-by-ids",
  "v2 google-get-keyword-ideas",
  "v2 search-contacts-advanced",
  "v2 search-object-records",
  "v2 search-opportunities-advanced",
  "v2 task-search",
  "v3 fetchCalendarList",
  "v3 filter-users-by-email",
  "v3 get-available-shipping-zones",
  "v3 get-comment-list",
  "v3 get-posts",
  "v3 get-statistics",
  "v3 get-tags-by-ids",
  "v3 google-get-keyword-ideas",
  "v3 search-contacts-advanced",
  "v3 search-object-records",
  "v3 search-opportunities-advanced",
  "v3 task-search",
];

describe("committed catalog", () => {
  test("holds every v2 and v3 operation of the pinned commit", () => {
    const count = (family: string) =>
      restCatalog.endpoints.filter((e) => e.family === family).length;
    expect(restCatalog.provenance.upstreamCommit).toBe(
      "0af86a4cbd48c66a4071c7e509d1079f9f10ed17",
    );
    expect([count("v2"), count("v3")]).toEqual([576, 627]);
    expect(restCatalog.endpointCount).toBe(1203);
  });

  test("excluded POSTs stay writes and POST searches are read-only", () => {
    const flagsOf = (ids: ReadonlySet<string> | string[]) =>
      restCatalog.endpoints
        .filter((e) => [...ids].includes(e.operationId ?? ""))
        .map((e) => e.readOnly);
    const excluded = flagsOf(WRITE_POST_EXCLUSIONS);
    expect(excluded.length).toBeGreaterThanOrEqual(WRITE_POST_EXCLUSIONS.size);
    expect(excluded.every((flag) => !flag)).toBe(true);
    const searches = ["search-contacts-advanced", "search-opportunities-advanced"];
    expect(flagsOf(searches)).toEqual([true, true, true, true]);
  });

  test("pins the exact read-only POSTs, so a repin that swaps one needs review", () => {
    const readPosts = restCatalog.endpoints
      .filter((e) => e.method === "POST" && e.readOnly)
      .map((e) => `${e.family} ${e.operationId ?? ""}`)
      .toSorted();
    expect(readPosts).toEqual(READ_ONLY_POSTS);
  });

  test("finds by operation id and by route, and rejects ambiguity", () => {
    const byId = findOperation({ family: "v3", operationId: "get-contact" });
    expect(byId.path).toBe("/contacts/{contactId}");
    expect(findRoute({ method: "GET", path: byId.path, family: "v2" }).family).toBe(
      "v2",
    );
    expect(() => findRoute({ method: "GET", path: byId.path })).toThrow("Ambiguous");
    expect(() => findOperation({ family: "v2", operationId: "list-invoices" })).toThrow(
      "Ambiguous",
    );
  });
});
