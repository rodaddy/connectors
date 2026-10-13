/**
 * The tool registry: an explicit allowlist. A tool
 * not defined here cannot be called. Every tool maps onto a typed helper of
 * `@rodaddy/connectors-highlevel`, so the location always comes from the
 * account client and never from tool arguments.
 *
 * @module
 */
import * as ghl from "@rodaddy/connectors-highlevel";

import type { Capability } from "../policy.ts";

/** What a tool handler runs against. */
export interface ToolContext {
  /** The account-bound client; read-only in this release. */
  client: ghl.AccountClient;
  capability: Capability;
}

/** A tool's arguments, already checked against its schema by {@link checkArgs}. */
export type ToolArgs = Readonly<Record<string, unknown>>;

/** A JSON Schema for a tool's arguments; unknown arguments are refused. */
export interface InputSchema {
  type: "object";
  properties: Record<string, { type: string; enum?: string[] }>;
  required?: string[];
  additionalProperties: false;
}

/** One allowlisted tool. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: InputSchema;
  handler: (args: ToolArgs, ctx: ToolContext) => Promise<unknown>;
}

/** The arguments do not match the tool's schema. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

/**
 * Check `args` against the tool's schema: required keys present, no unknown
 * keys, each value of its declared type and enum.
 *
 * @throws ToolArgumentError naming the first bad argument.
 */
export function checkArgs(tool: ToolDef, args: ToolArgs): void {
  const { properties, required = [] } = tool.inputSchema;
  const missing = required.find((key) => args[key] === undefined);
  if (missing !== undefined) throw new ToolArgumentError(`${missing} is required.`);
  for (const [key, value] of Object.entries(args)) {
    const spec = properties[key];
    if (spec === undefined) throw new ToolArgumentError(`Unknown argument: ${key}.`);
    const allowed = spec.enum?.includes(String(value)) ?? true;
    if (typeof value !== spec.type || !allowed) {
      const choices = spec.enum === undefined ? "" : ` (${spec.enum.join(", ")})`;
      throw new ToolArgumentError(`${key} must be a ${spec.type}${choices}.`);
    }
  }
}

const S = { type: "string" };
const N = { type: "number" };
const STATUS = { type: "string", enum: ["open", "won", "lost", "abandoned", "all"] };
// prettier-ignore
const OPPORTUNITY_FILTERS = {
  contactId: S, pipelineId: S, stageId: S, status: STATUS, query: S, limit: N, startAfter: N, startAfterId: S,
};

/** A PIT tool; `properties` keys are the helper's option names, so checked args pass through. */
function pit(
  name: string,
  description: string,
  handler: ToolDef["handler"],
  schema: Pick<InputSchema, "properties" | "required"> = { properties: {} },
): ToolDef {
  const inputSchema: InputSchema = {
    type: "object",
    additionalProperties: false,
    ...schema,
  };
  return { name, description, inputSchema, handler };
}

const id = (key: string) => ({ properties: { [key]: S }, required: [key] });

/** The read tools, in `tools/list` order. Write tools are a later release. */
export const TOOLS: readonly ToolDef[] = [
  pit("get_location", "Read the account's location profile.", (_a, ctx) =>
    ghl.getLocation(ctx.client),
  ),
  pit(
    "audit_location",
    "One-call inventory: custom fields, tags, pipelines, workflows, calendars, funnels, forms, contact total; each area succeeds or fails on its own.",
    (_a, ctx) => ghl.auditLocation(ctx.client),
  ),
  pit("list_workflows", "List the location's workflows.", (_a, ctx) =>
    ghl.listWorkflows(ctx.client),
  ),
  pit("get_pipelines", "List opportunity pipelines and their stages.", (_a, ctx) =>
    ghl.listPipelines(ctx.client),
  ),
  pit("get_custom_fields", "List the location's custom fields.", (_a, ctx) =>
    ctx.client.getCustomFields(ctx.client.locationId),
  ),
  // GET /contacts/; searchContacts is a POST, which the read-only client refuses.
  pit(
    "get_contacts",
    "List contacts a page at a time; pass nextStartAfter + nextStartAfterId back as startAfter + startAfterId.",
    (args, ctx) => ghl.listContacts(ctx.client, args as ghl.ListContactsOptions),
    { properties: { limit: N, startAfter: N, startAfterId: S } },
  ),
  pit(
    "get_contact",
    "Read one contact.",
    (args, ctx) => ghl.getContact(ctx.client, args["contactId"] as string),
    id("contactId"),
  ),
  pit(
    "list_notes",
    "List every note on a contact.",
    (args, ctx) => ghl.listNotes(ctx.client, args["contactId"] as string),
    id("contactId"),
  ),
  pit(
    "search_opportunities",
    "Search opportunities; pass nextStartAfter + nextStartAfterId back as startAfter + startAfterId.",
    (args, ctx) => ghl.searchOpportunities(ctx.client, args as ghl.OpportunitySearch),
    { properties: OPPORTUNITY_FILTERS },
  ),
  pit(
    "get_opportunity",
    "Read one opportunity.",
    (args, ctx) => ghl.getOpportunity(ctx.client, args["opportunityId"] as string),
    id("opportunityId"),
  ),
  pit(
    "search_conversations",
    "Search conversations, newest first; pass nextCursor back as startAfterDate.",
    (args, ctx) =>
      ghl.searchConversations(ctx.client, args as ghl.SearchConversationsOptions),
    { properties: { contactId: S, query: S, limit: N, startAfterDate: N } },
  ),
];

/** The allowlist, by tool name. */
export const TOOL_INDEX: ReadonlyMap<string, ToolDef> = new Map(
  TOOLS.map((tool) => [tool.name, tool]),
);
