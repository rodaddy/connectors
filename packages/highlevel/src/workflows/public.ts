/**
 * Public-API workflows: list the location's workflows and
 * add or remove a contact. The public API returns metadata only, never the
 * triggers or actions; enrolling needs a client built with `allowWrites: true`.
 *
 * @module
 */
import type { AccountClient } from "../accounts.ts";
import { callOperation } from "../client/call.ts";
import {
  asShape,
  HighLevelShapeError,
  readArray,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readString,
} from "../crm/shape.ts";

/** One workflow's metadata. */
export interface WorkflowSummary {
  id: string;
  name: string;
  status: string;
  version?: number;
  updatedAt?: string;
}

/** Which contact to put into (or take out of) which workflow. */
export interface WorkflowEnrollment {
  contactId: string;
  workflowId: string;
  /** ISO time the workflow's event starts, e.g. `2021-06-23T03:30:00+01:00`. */
  eventStartTime?: string;
}

function parseWorkflow(value: unknown, field: string): WorkflowSummary {
  const shape = asShape(value, field);
  const workflow: WorkflowSummary = {
    id: readString(shape, "id", field),
    name: readString(shape, "name", field),
    status: readString(shape, "status", field),
  };
  const version = readOptionalNumber(shape, "version");
  if (version !== undefined) workflow.version = version;
  const updatedAt = readOptionalString(shape, "updatedAt");
  if (updatedAt !== undefined) workflow.updatedAt = updatedAt;
  return workflow;
}

/**
 * List the location's workflows (`GET /workflows/`, Version v3 as proven live).
 *
 * @throws HighLevelShapeError when the response has no `workflows` array.
 */
export async function listWorkflows(client: AccountClient): Promise<WorkflowSummary[]> {
  // operationId: get-workflow
  const response = await callOperation(
    client,
    { family: "v2", operationId: "get-workflow" },
    { query: { locationId: client.locationId }, version: "v3" },
  );
  return readArray(
    asShape(response, "workflows"),
    "workflows",
    "workflows",
    parseWorkflow,
  );
}

async function sendEnrollment(
  client: AccountClient,
  operationId: string,
  enrollment: WorkflowEnrollment,
): Promise<{ succeeded: boolean }> {
  const { contactId, workflowId, eventStartTime } = enrollment;
  const response = await callOperation(
    client,
    { family: "v2", operationId },
    {
      pathParams: { contactId, workflowId },
      body: eventStartTime === undefined ? {} : { eventStartTime },
    },
  );
  // GHL spells the field `succeded`.
  const succeeded = readOptionalBoolean(asShape(response, operationId), "succeded");
  if (succeeded === undefined) {
    throw new HighLevelShapeError(`${operationId}.succeded`, "a boolean");
  }
  return { succeeded };
}

/** Add a contact to a workflow (`POST /contacts/{contactId}/workflow/{workflowId}`). */
export async function enrollContactInWorkflow(
  client: AccountClient,
  enrollment: WorkflowEnrollment,
): Promise<{ succeeded: boolean }> {
  // operationId: add-contact-to-workflow
  return sendEnrollment(client, "add-contact-to-workflow", enrollment);
}

/** Remove a contact from a workflow (`DELETE /contacts/{contactId}/workflow/{workflowId}`). */
export async function removeContactFromWorkflow(
  client: AccountClient,
  enrollment: WorkflowEnrollment,
): Promise<{ succeeded: boolean }> {
  // operationId: delete-contact-from-workflow
  return sendEnrollment(client, "delete-contact-from-workflow", enrollment);
}
