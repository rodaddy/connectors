/**
 * Typed contact helpers. Every helper fills the
 * location from the account client and parses the response through the
 * shared readers; write helpers need a client built with `allowWrites: true`.
 *
 * @module
 */
import type { AccountClient } from "../accounts.ts";
import { callOperation, type CallArgs } from "../client/call.ts";
import type { JsonObject } from "../client/highlevel.ts";
import {
  asShape,
  HighLevelShapeError,
  readArray,
  readOptionalBoolean,
  readOptionalNumber,
  readOptionalString,
  readString,
  readStrings,
  type Shape,
} from "./shape.ts";

/** The person fields a contact carries and a caller may set. */
export interface ContactFields {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
}

/** A contact as the helpers return it; `name` is `contactName`, else `name`, else first + last. */
export interface Contact extends ContactFields {
  id: string;
  tags: string[];
  dateAdded?: string;
  dateUpdated?: string;
}

/** Fields for creating or upserting a contact. */
export interface ContactInput extends ContactFields {
  tags?: string[];
  source?: string;
}

/** Options for {@link searchContacts}; `limit` defaults to 20. */
export interface SearchContactsOptions {
  query?: string;
  limit?: number;
  page?: number;
}

/** Fields {@link updateContact} may change; `UpdateContactDto` has no `companyName`. */
export type ContactPatch = Partial<Omit<ContactInput, "companyName">>;

/**
 * GHL's paging cursor, the pair `startAfter` (epoch ms) + `startAfterId`.
 * A page returns it as `nextStartAfter` + `nextStartAfterId`; pass both back.
 */
export interface PageCursor {
  startAfter?: number | undefined;
  startAfterId?: string | undefined;
}

/** The next-page cursor a page carries, read from GHL's `meta`. */
export interface NextPageCursor {
  nextStartAfter?: number;
  nextStartAfterId?: string;
}

/** Options for {@link listContacts}; `limit` defaults to 20. */
export interface ListContactsOptions extends PageCursor {
  limit?: number;
}

/** Query entries for a cursor, in `startAfterId`, `startAfter` order; unset parts are left out. */
export function cursorQuery(cursor: PageCursor): Record<string, string | number> {
  return {
    ...(cursor.startAfterId === undefined ? {} : { startAfterId: cursor.startAfterId }),
    ...(cursor.startAfter === undefined ? {} : { startAfter: cursor.startAfter }),
  };
}

/** Read the next-page cursor from a response's optional `meta`. */
export function readNextCursor(meta: unknown, field: string): NextPageCursor {
  const shape = meta === undefined ? {} : asShape(meta, field);
  const startAfter = readOptionalNumber(shape, "startAfter");
  const startAfterId = readOptionalString(shape, "startAfterId");
  return {
    ...(startAfter === undefined ? {} : { nextStartAfter: startAfter }),
    ...(startAfterId === undefined ? {} : { nextStartAfterId: startAfterId }),
  };
}

/** A contact input that names nobody: no name, firstName, email or phone. */
export class ContactInputError extends Error {
  constructor() {
    super("A contact needs at least one of name, firstName, email or phone.");
    this.name = "ContactInputError";
  }
}

const TEXT_FIELDS = ["firstName", "lastName", "email", "phone", "companyName"] as const;
const DATE_FIELDS = ["dateAdded", "dateUpdated"] as const;

function parseContact(value: unknown, field: string): Contact {
  const shape = asShape(value, field);
  const contact: Contact = {
    id: readString(shape, "id", field),
    tags: readStrings(shape, "tags"),
  };
  for (const key of [...TEXT_FIELDS, ...DATE_FIELDS]) {
    const text = readOptionalString(shape, key);
    if (text !== undefined) contact[key] = text;
  }
  const joined = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
  const name =
    readOptionalString(shape, "contactName") ??
    readOptionalString(shape, "name") ??
    (joined || undefined);
  if (name !== undefined) contact.name = name;
  return contact;
}

function readTag(item: unknown, field: string): string {
  if (typeof item !== "string") throw new HighLevelShapeError(field, "a string");
  return item;
}

/** Send one v2 contacts operation and read the response as an object. */
async function send(
  client: AccountClient,
  operationId: string,
  args: CallArgs,
): Promise<Shape> {
  return asShape(
    await callOperation(client, { family: "v2", operationId }, args),
    operationId,
  );
}

async function sendForContact(
  client: AccountClient,
  operationId: string,
  args: CallArgs,
): Promise<Contact> {
  const response = await send(client, operationId, args);
  return parseContact(response.contact, `${operationId}.contact`);
}

function withLocation(client: AccountClient, input: ContactInput): JsonObject {
  if (!input.name && !input.firstName && !input.email && !input.phone) {
    throw new ContactInputError();
  }
  return { ...input, locationId: client.locationId };
}

/** Search the location's contacts (`POST /contacts/search`); `total` when GHL reports it. */
export async function searchContacts(
  client: AccountClient,
  options: SearchContactsOptions = {},
): Promise<{ contacts: Contact[]; total?: number }> {
  const body: JsonObject = {
    locationId: client.locationId,
    pageLimit: options.limit ?? 20,
  };
  if (options.query !== undefined) body.query = options.query;
  if (options.page !== undefined) body.page = options.page;
  // operationId: search-contacts-advanced
  const response = await send(client, "search-contacts-advanced", { body });
  const contacts = readArray(response, "contacts", "search", parseContact);
  const total = readOptionalNumber(response, "total");
  return total === undefined ? { contacts } : { contacts, total };
}

/** Read one contact (`GET /contacts/{contactId}`). */
export async function getContact(
  client: AccountClient,
  contactId: string,
): Promise<Contact> {
  // operationId: get-contact
  return sendForContact(client, "get-contact", { pathParams: { contactId } });
}

/**
 * Create a contact in the location (`POST /contacts/`).
 * @throws ContactInputError before any request when the input names nobody.
 */
export async function createContact(
  client: AccountClient,
  input: ContactInput,
): Promise<Contact> {
  // operationId: create-contact
  return sendForContact(client, "create-contact", {
    body: withLocation(client, input),
  });
}

/** Change a contact's fields (`PUT /contacts/{contactId}`). */
export async function updateContact(
  client: AccountClient,
  contactId: string,
  patch: ContactPatch,
): Promise<Contact> {
  // operationId: update-contact
  return sendForContact(client, "update-contact", {
    pathParams: { contactId },
    body: { ...patch },
  });
}

/**
 * Create the contact, or update the one GHL matches (`POST /contacts/upsert`);
 * `created` is GHL's `new` flag.
 * @throws ContactInputError before any request when the input names nobody.
 */
export async function upsertContact(
  client: AccountClient,
  input: ContactInput,
): Promise<{ contact: Contact; created: boolean }> {
  // operationId: upsert-contact
  const response = await send(client, "upsert-contact", {
    body: withLocation(client, input),
  });
  return {
    contact: parseContact(response.contact, "upsert-contact.contact"),
    created: readOptionalBoolean(response, "new") ?? false,
  };
}

async function changeTags(
  client: AccountClient,
  operationId: "add-tags" | "remove-tags",
  change: { contactId: string; tags: string[] },
): Promise<string[]> {
  const response = await send(client, operationId, {
    pathParams: { contactId: change.contactId },
    body: { tags: change.tags },
  });
  return readArray(response, "tags", operationId, readTag);
}

/** Add tags to a contact (`POST /contacts/{contactId}/tags`); returns the resulting tags. */
export async function addContactTags(
  client: AccountClient,
  contactId: string,
  tags: string[],
): Promise<string[]> {
  // operationId: add-tags
  return changeTags(client, "add-tags", { contactId, tags });
}

/** Remove tags from a contact (`DELETE /contacts/{contactId}/tags`); returns the resulting tags. */
export async function removeContactTags(
  client: AccountClient,
  contactId: string,
  tags: string[],
): Promise<string[]> {
  // operationId: remove-tags
  return changeTags(client, "remove-tags", { contactId, tags });
}

/**
 * List the location's contacts a page at a time (`GET /contacts/`).
 * @deprecated GHL deprecates this endpoint; prefer {@link searchContacts}. Kept because existing callers page with it.
 */
export async function listContacts(
  client: AccountClient,
  options: ListContactsOptions = {},
): Promise<{ contacts: Contact[] } & NextPageCursor> {
  const query: CallArgs["query"] = {
    locationId: client.locationId,
    limit: options.limit ?? 20,
    ...cursorQuery(options),
  };
  // operationId: get-contacts
  const response = await send(client, "get-contacts", { query });
  const contacts = readArray(response, "contacts", "list", parseContact);
  return { contacts, ...readNextCursor(response.meta, "list.meta") };
}
