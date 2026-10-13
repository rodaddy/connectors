/**
 * Typed opportunity helpers: search, get, create, update, move stage, set
 * status, and ensure one open opportunity per contact on a pipeline.
 *
 * @module
 */
import type { AccountClient } from "../accounts.ts";
import { callOperation, type CallArgs } from "../client/call.ts";
import { readNextCursor, type NextPageCursor, type PageCursor } from "./contacts.ts";
import { asShape, readArray, readDeleted, readOptionalNumber } from "./shape.ts";
import { readOptionalString, readString } from "./shape.ts";

/** The statuses GHL stores on an opportunity. */
export type OpportunityStatus = "open" | "won" | "lost" | "abandoned";

/** One opportunity, parsed from a GHL response. */
export interface Opportunity {
  id: string;
  name: string;
  status: string;
  pipelineId: string;
  pipelineStageId: string;
  contactId?: string;
  monetaryValue?: number;
  source?: string;
  assignedTo?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Filters and paging for {@link searchOpportunities}; `limit` defaults to 20. */
export interface OpportunitySearch extends PageCursor {
  contactId?: string;
  pipelineId?: string;
  stageId?: string;
  status?: OpportunityStatus | "all";
  query?: string;
  limit?: number;
}

/** One search page; the next cursor is GHL's `meta.startAfter` + `meta.startAfterId`. */
export interface OpportunityPage extends NextPageCursor {
  opportunities: Opportunity[];
  total?: number;
}

/**
 * Fields for {@link createOpportunity} (GHL `CreateDto`, minus `locationId`,
 * which comes from the client); `status` defaults to `open`.
 */
export interface NewOpportunity {
  name: string;
  pipelineId: string;
  pipelineStageId: string;
  contactId: string;
  status?: OpportunityStatus;
  monetaryValue?: number;
  assignedTo?: string;
}

/** Fields {@link updateOpportunity} may change (GHL `UpdateOpportunityDto`). */
export type OpportunityPatch = Partial<Omit<NewOpportunity, "contactId">>;

const TEXT = ["contactId", "source", "assignedTo", "createdAt", "updatedAt"] as const;

/** Parse one opportunity object; `field` names it in errors. */
export function parseOpportunity(value: unknown, field: string): Opportunity {
  const shape = asShape(value, field);
  const opportunity: Opportunity = {
    id: readString(shape, "id", field),
    name: readString(shape, "name", field),
    status: readString(shape, "status", field),
    pipelineId: readString(shape, "pipelineId", field),
    pipelineStageId: readString(shape, "pipelineStageId", field),
  };
  for (const key of TEXT) {
    const text = readOptionalString(shape, key);
    if (text !== undefined) opportunity[key] = text;
  }
  const monetaryValue = readOptionalNumber(shape, "monetaryValue");
  if (monetaryValue !== undefined) opportunity.monetaryValue = monetaryValue;
  return opportunity;
}

/** Call a v2 operation that answers `{ opportunity }` and parse it. */
async function callForOpportunity(
  client: AccountClient,
  operationId: string,
  args: CallArgs,
): Promise<Opportunity> {
  const raw = await callOperation(client, { family: "v2", operationId }, args);
  return parseOpportunity(asShape(raw, "response").opportunity, "opportunity");
}

/**
 * Search the account's opportunities, one page at a time. Page until a page
 * comes back short or empty.
 *
 * @throws HighLevelShapeError when the response is not an opportunity list.
 */
export async function searchOpportunities(
  client: AccountClient,
  search: OpportunitySearch = {},
): Promise<OpportunityPage> {
  const entries = Object.entries({
    location_id: client.locationId,
    contact_id: search.contactId,
    pipeline_id: search.pipelineId,
    pipeline_stage_id: search.stageId,
    status: search.status,
    q: search.query,
    limit: search.limit ?? 20,
    startAfter: search.startAfter,
    startAfterId: search.startAfterId,
  }).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  // operationId: search-opportunity (GET /opportunities/search)
  const raw = await callOperation(
    client,
    { family: "v2", operationId: "search-opportunity" },
    { query: Object.fromEntries(entries) },
  );
  const shape = asShape(raw, "response");
  const opportunities = readArray(shape, "opportunities", "response", parseOpportunity);
  const meta = shape.meta === undefined ? {} : asShape(shape.meta, "response.meta");
  const total = readOptionalNumber(meta, "total");
  return {
    opportunities,
    ...(total === undefined ? {} : { total }),
    ...readNextCursor(meta, "response.meta"),
  };
}

/** Fetch one opportunity by id. */
export async function getOpportunity(
  client: AccountClient,
  id: string,
): Promise<Opportunity> {
  // operationId: get-opportunity (GET /opportunities/{id})
  return callForOpportunity(client, "get-opportunity", { pathParams: { id } });
}

/** Create an opportunity in the account's location. */
export async function createOpportunity(
  client: AccountClient,
  fields: NewOpportunity,
): Promise<Opportunity> {
  const body = {
    ...fields,
    status: fields.status ?? "open",
    locationId: client.locationId,
  };
  // operationId: create-opportunity (POST /opportunities/)
  return callForOpportunity(client, "create-opportunity", { body });
}

/** Change an opportunity; only the fields in `patch` are sent. */
export async function updateOpportunity(
  client: AccountClient,
  id: string,
  patch: OpportunityPatch,
): Promise<Opportunity> {
  // operationId: update-opportunity (PUT /opportunities/{id})
  const args = { pathParams: { id }, body: { ...patch } };
  return callForOpportunity(client, "update-opportunity", args);
}

/** Move an opportunity to another stage (and pipeline, when given). */
export async function moveOpportunityStage(
  client: AccountClient,
  move: { id: string; pipelineStageId: string; pipelineId?: string },
): Promise<Opportunity> {
  const { id, ...patch } = move;
  return updateOpportunity(client, id, patch);
}

/**
 * Set an opportunity's status through the dedicated status endpoint
 * (`UpdateStatusDto`: `status`, optional `lostReasonId`).
 *
 * @returns GHL's `succeded` flag.
 * @throws HighLevelShapeError when the reply carries no success flag.
 */
export async function setOpportunityStatus(
  client: AccountClient,
  change: { id: string; status: OpportunityStatus; lostReasonId?: string },
): Promise<boolean> {
  const { id, ...body } = change;
  // operationId: update-opportunity-status (PUT /opportunities/{id}/status)
  const response = await callOperation(
    client,
    { family: "v2", operationId: "update-opportunity-status" },
    { pathParams: { id }, body },
  );
  return readDeleted(response);
}

/**
 * Return the contact's open opportunity on a pipeline, else create one at
 * `pipelineStageId`. An existing open opportunity is never moved (ported from
 * earlier tooling `scripts/outreach-replies/watch.py` `ensure_opportunity`).
 */
export async function ensureOpenOpportunity(
  client: AccountClient,
  wanted: {
    contactId: string;
    pipelineId: string;
    pipelineStageId: string;
    name: string;
  },
): Promise<{ opportunity: Opportunity; created: boolean }> {
  const { contactId, pipelineId } = wanted;
  const search = { contactId, pipelineId, status: "open" } as const;
  const { opportunities } = await searchOpportunities(client, search);
  const open = opportunities.find((o) => o.status.trim().toLowerCase() === "open");
  if (open) return { opportunity: open, created: false };
  const opportunity = await createOpportunity(client, { ...wanted, status: "open" });
  return { opportunity, created: true };
}
