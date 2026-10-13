/**
 * Email builder templates (after earlier tooling
 * `scripts/ghl/email_templates.py`): list them, create an empty HTML one, set
 * its content, and upsert by name. Writes need a client built with
 * `allowWrites: true`.
 *
 * @module
 */
import type { AccountClient } from "./accounts.ts";
import { callOperation, type CallArgs } from "./client/call.ts";
import {
  asShape,
  HighLevelShapeError,
  readArray,
  readOptionalString,
  type Shape,
} from "./crm/shape.ts";

/** One email builder template. */
export interface EmailTemplate {
  id: string;
  name: string;
}

/** What {@link setEmailTemplateContent} writes into a template. */
export interface EmailTemplateContent {
  templateId: string;
  html: string;
  /** Who GHL records as the editor; defaults to `connectors-highlevel`. */
  updatedBy?: string;
}

/** {@link upsertEmailTemplate}'s result: the template and whether it was new. */
export interface UpsertedEmailTemplate {
  template: EmailTemplate;
  created: boolean;
}

/** The keys a create response may carry the new id under, in the order tried. */
const CREATED_ID_KEYS = ["id", "templateId", "redirect", "_id"] as const;

async function send(
  client: AccountClient,
  operationId: string,
  args: CallArgs,
): Promise<Shape> {
  const response = await callOperation(client, { family: "v2", operationId }, args);
  return asShape(response, operationId);
}

/** A builder entry, or `undefined` when it has no name or id (skipped, as the script does). */
function parseBuilder(item: unknown, field: string): EmailTemplate | undefined {
  const shape = asShape(item, field);
  const name = readOptionalString(shape, "name");
  const id = readOptionalString(shape, "id") || readOptionalString(shape, "_id");
  return name && id ? { id, name } : undefined;
}

/** Templates per `GET /emails/builder` page. */
const PAGE_SIZE = 100;
/** Stop after this many pages even if the server keeps answering full ones. */
const MAX_PAGES = 100;

/**
 * List all the location's email builder templates (`GET /emails/builder`),
 * paging by `offset` until a short page.
 *
 * @throws HighLevelShapeError when a page has no `builders` array.
 */
export async function listEmailTemplates(
  client: AccountClient,
): Promise<EmailTemplate[]> {
  const templates: EmailTemplate[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // operationId: fetch-template
    const response = await send(client, "fetch-template", {
      query: {
        locationId: client.locationId,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      },
    });
    const builders = readArray(response, "builders", "fetch-template", parseBuilder);
    templates.push(...builders.filter((item) => item !== undefined));
    if (builders.length < PAGE_SIZE) break;
  }
  return templates;
}

/** The new template's id: `id`, `templateId`, the last segment of `redirect`, or `_id`. */
function createdId(response: Shape): string {
  for (const key of CREATED_ID_KEYS) {
    const value = readOptionalString(response, key);
    if (!value) continue;
    return key === "redirect"
      ? (value.replace(/\/+$/, "").split("/").pop() ?? "")
      : value;
  }
  throw new HighLevelShapeError("create-template.id", "a template id");
}

/**
 * Create an empty HTML builder template (`POST /emails/builder`).
 *
 * @throws HighLevelShapeError when the response carries no template id.
 */
export async function createEmailTemplate(
  client: AccountClient,
  template: { name: string },
): Promise<EmailTemplate> {
  // operationId: create-template
  const response = await send(client, "create-template", {
    body: { locationId: client.locationId, title: template.name, type: "html" },
  });
  return { id: createdId(response), name: template.name };
}

/** Replace a template's HTML (`POST /emails/builder/data`). */
export async function setEmailTemplateContent(
  client: AccountClient,
  content: EmailTemplateContent,
): Promise<void> {
  // operationId: update-template
  await send(client, "update-template", {
    body: {
      locationId: client.locationId,
      templateId: content.templateId,
      html: content.html,
      editorType: "html",
      updatedBy: content.updatedBy ?? "connectors-highlevel",
    },
  });
}

/**
 * Create the template named `name` if the location has none, then set its
 * HTML. The name is the upsert key: renaming creates a second template.
 */
export async function upsertEmailTemplate(
  client: AccountClient,
  template: { name: string; html: string },
): Promise<UpsertedEmailTemplate> {
  const existing = (await listEmailTemplates(client)).find(
    (item) => item.name === template.name,
  );
  const found = existing ?? (await createEmailTemplate(client, template));
  await setEmailTemplateContent(client, { templateId: found.id, html: template.html });
  return { template: found, created: existing === undefined };
}
