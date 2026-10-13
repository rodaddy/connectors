/**
 * The account's location and a one-call, read-only inventory
 * of it (after earlier tooling `audit.py`).
 *
 * @module
 */
import type { AccountClient } from "./accounts.ts";
import { callOperation, type CallArgs } from "./client/call.ts";
import { HighLevelApiError } from "./client/highlevel.ts";
import {
  asShape,
  HighLevelShapeError,
  readArray,
  readOptionalNumber,
  readOptionalString,
  readString,
  type Shape,
} from "./crm/shape.ts";
import { listWorkflows } from "./workflows/public.ts";

/** A location's postal address; GHL returns it as flat fields. */
export interface LocationAddress {
  line1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

/** The account's location. */
export interface Location {
  id: string;
  name: string;
  timezone?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: LocationAddress;
}

/** One audit area: its value, or why it could not be read (`status` for an HTTP error). */
export type AuditResult<T> =
  { ok: true; value: T } | { ok: false; error: string; status?: number };

/** {@link auditLocation}'s result; each area succeeds or fails on its own. */
export interface LocationAudit {
  customFields: AuditResult<string[]>;
  tags: AuditResult<string[]>;
  pipelines: AuditResult<{ name: string; stages: string[] }[]>;
  workflows: AuditResult<{ name: string; status: string }[]>;
  calendars: AuditResult<string[]>;
  funnels: AuditResult<string[]>;
  forms: AuditResult<string[]>;
  contactTotal: AuditResult<number>;
}

const TEXT_FIELDS = ["timezone", "email", "phone", "website"] as const;
const ADDRESS_FIELDS = [
  ["address", "line1"],
  ["city", "city"],
  ["state", "state"],
  ["postalCode", "postalCode"],
  ["country", "country"],
] as const;

function parseLocation(shape: Shape, field: string): Location {
  const location: Location = {
    id: readString(shape, "id", field),
    name: readString(shape, "name", field),
  };
  for (const key of TEXT_FIELDS) {
    const text = readOptionalString(shape, key);
    if (text !== undefined) location[key] = text;
  }
  const address: LocationAddress = {};
  for (const [from, to] of ADDRESS_FIELDS) {
    const text = readOptionalString(shape, from);
    if (text !== undefined) address[to] = text;
  }
  if (Object.keys(address).length > 0) location.address = address;
  return location;
}

/** Send one v2 operation and read the response as an object. */
async function send(
  client: AccountClient,
  operationId: string,
  args: CallArgs,
): Promise<Shape> {
  const response = await callOperation(client, { family: "v2", operationId }, args);
  return asShape(response, operationId);
}

/** Get the account's location (`GET /locations/{locationId}`). */
export async function getLocation(client: AccountClient): Promise<Location> {
  // operationId: get-location
  const response = await send(client, "get-location", {
    pathParams: { locationId: client.locationId },
  });
  return parseLocation(asShape(response.location, "location"), "location");
}

/** The item's `name`, or `undefined` for a nameless item (skipped, as `audit.py` printed what it had). */
function readName(item: unknown, field: string): string | undefined {
  return readOptionalString(asShape(item, field), "name");
}

/** The names in `shape[key]`, nameless items skipped. */
function readNames(shape: Shape, key: string, field: string): string[] {
  return readArray(shape, key, field, readName).filter(
    (name): name is string => name !== undefined,
  );
}

/** How a list pages: the start parameter and, when the server reports one, the total's key. */
interface Paging {
  start: "skip" | "offset";
  totalKey?: string;
}

/** A named list: its operation, whether the location goes in the path, and envelopes to try. */
interface NameList {
  operationId: string;
  inPath: boolean;
  keys: readonly [string, ...string[]];
  paging?: Paging;
}

/** Page size for the paged lists (GHL forms allow at most 50). */
const PAGE_SIZE = 50;
/** Stop after this many pages even if the server keeps answering full ones. */
const MAX_PAGES = 100;

const NAME_LISTS = {
  customFields: {
    operationId: "get-custom-fields",
    inPath: true,
    keys: ["customFields"],
  },
  tags: { operationId: "get-location-tags", inPath: true, keys: ["tags"] },
  calendars: { operationId: "get-calendars", inPath: false, keys: ["calendars"] },
  funnels: {
    operationId: "getFunnels",
    inPath: false,
    keys: ["funnels", "data"],
    paging: { start: "offset" },
  },
  forms: {
    operationId: "get-forms",
    inPath: false,
    keys: ["forms"],
    paging: { start: "skip", totalKey: "total" },
  },
} as const satisfies Record<string, NameList>;

/** GET one page of a list: its names and how many items it held. */
async function listPage(
  client: AccountClient,
  list: NameList,
  start: number,
): Promise<{ names: string[]; count: number; total: number | undefined }> {
  const { locationId } = client;
  const paged = list.paging ? { limit: PAGE_SIZE, [list.paging.start]: start } : {};
  const args = list.inPath
    ? { pathParams: { locationId } }
    : { query: { locationId, ...paged } };
  const response = await send(client, list.operationId, args);
  const key = list.keys.find((name) => Array.isArray(response[name])) ?? list.keys[0];
  const names = readNames(response, key, list.operationId);
  const count = Array.isArray(response[key]) ? response[key].length : 0;
  const totalKey = list.paging?.totalKey;
  const total =
    totalKey === undefined ? undefined : readOptionalNumber(response, totalKey);
  return { names, count, total };
}

/** GET a list and return its items' names, paging until a short page or the reported total. */
async function listNames(client: AccountClient, list: NameList): Promise<string[]> {
  const names: string[] = [];
  let seen = 0;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page = await listPage(client, list, seen);
    names.push(...page.names);
    seen += page.count;
    const done = !list.paging || page.count < PAGE_SIZE;
    if (done || (page.total !== undefined && seen >= page.total)) break;
  }
  return names;
}

async function listPipelines(
  client: AccountClient,
): Promise<{ name: string; stages: string[] }[]> {
  // operationId: get-pipelines
  const response = await send(client, "get-pipelines", {
    query: { locationId: client.locationId },
  });
  const pipelines = readArray(response, "pipelines", "pipelines", (item, field) => {
    const pipeline = asShape(item, field);
    const name = readOptionalString(pipeline, "name");
    return name === undefined
      ? undefined
      : { name, stages: readNames(pipeline, "stages", field) };
  });
  return pipelines.filter((pipeline) => pipeline !== undefined);
}

async function contactTotal(client: AccountClient): Promise<number> {
  // operationId: get-contacts
  const response = await send(client, "get-contacts", {
    query: { locationId: client.locationId, limit: 1 },
  });
  const total = readOptionalNumber(asShape(response.meta, "meta"), "total");
  if (total === undefined) throw new HighLevelShapeError("meta.total", "a number");
  return total;
}

async function settle<T>(run: () => Promise<T>): Promise<AuditResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error: unknown) {
    if (error instanceof HighLevelApiError) {
      return { ok: false, error: error.name, status: error.status };
    }
    return { ok: false, error: error instanceof Error ? error.name : String(error) };
  }
}

/**
 * Read the location's inventory: custom fields, tags, pipelines with stages,
 * workflows with status, calendars, funnels, forms and the contact total.
 * Areas run concurrently and fail independently, so one missing scope does
 * not sink the audit. GETs only.
 */
export async function auditLocation(client: AccountClient): Promise<LocationAudit> {
  // operationIds: get-custom-fields, get-location-tags, get-calendars, getFunnels, get-forms
  const names = (list: NameList) => settle(() => listNames(client, list));
  const workflows = async () =>
    (await listWorkflows(client)).map(({ name, status }) => ({ name, status }));
  const [customFields, tags, pipelines, flows, calendars, funnels, forms, total] =
    await Promise.all([
      names(NAME_LISTS.customFields),
      names(NAME_LISTS.tags),
      settle(() => listPipelines(client)),
      settle(workflows),
      names(NAME_LISTS.calendars),
      names(NAME_LISTS.funnels),
      names(NAME_LISTS.forms),
      settle(() => contactTotal(client)),
    ]);
  return {
    customFields,
    tags,
    pipelines,
    workflows: flows,
    calendars,
    funnels,
    forms,
    contactTotal: total,
  };
}
