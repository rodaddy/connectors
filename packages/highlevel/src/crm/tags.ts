/**
 * Location tags: list, create, and ensure-by-name.
 *
 * @module
 */
import type { AccountClient } from "../accounts.ts";
import { callOperation } from "../client/call.ts";
import { asShape, readArray, readString } from "./shape.ts";

/** One location tag. */
export interface Tag {
  id: string;
  name: string;
}

/** One result of {@link ensureTags}. */
export interface EnsuredTag {
  tag: Tag;
  /** `true` when this call created the tag. */
  created: boolean;
}

function parseTag(value: unknown, field: string): Tag {
  const shape = asShape(value, field);
  return { id: readString(shape, "id", field), name: readString(shape, "name", field) };
}

/**
 * List the location's tags.
 *
 * @param client - The account client; its location is used.
 * @returns Every tag in the location.
 */
export async function listTags(client: AccountClient): Promise<Tag[]> {
  // operationId: get-location-tags
  const response = await callOperation(
    client,
    { family: "v2", operationId: "get-location-tags" },
    { pathParams: { locationId: client.locationId } },
  );
  return readArray(asShape(response, "response"), "tags", "response", parseTag);
}

/**
 * Create one tag in the location.
 *
 * @param client - The account client (needs `allowWrites`).
 * @param name - The tag name.
 * @returns The created tag.
 */
export async function createTag(client: AccountClient, name: string): Promise<Tag> {
  // operationId: create-tag
  const response = await callOperation(
    client,
    { family: "v2", operationId: "create-tag" },
    { pathParams: { locationId: client.locationId }, body: { name } },
  );
  return parseTag(asShape(response, "response").tag, "response.tag");
}

/**
 * Make sure each named tag exists: match existing tags by case-insensitive
 * name, create only the missing ones, never touch an existing tag.
 *
 * @param client - The account client (needs `allowWrites` when a tag is missing).
 * @param names - The tag names, in the order results are returned.
 * @returns One result per name: the tag and whether it was created.
 */
export async function ensureTags(
  client: AccountClient,
  names: readonly string[],
): Promise<EnsuredTag[]> {
  const byName = new Map(
    (await listTags(client)).map((tag) => [tag.name.toLowerCase(), tag]),
  );
  const results: EnsuredTag[] = [];
  for (const name of names) {
    const existing = byName.get(name.toLowerCase());
    if (existing) {
      results.push({ tag: existing, created: false });
      continue;
    }
    const tag = await createTag(client, name);
    byName.set(name.toLowerCase(), tag);
    results.push({ tag, created: true });
  }
  return results;
}
