/**
 * Contact notes (H14 + D8). A note links an opportunity through the
 * undocumented `relations` field, which GHL stores and returns as sent.
 *
 * @module
 */
import type { AccountClient } from "../accounts.ts";
import { callOperation } from "../client/call.ts";
import type { JsonObject } from "../client/highlevel.ts";
import {
  asShape,
  readArray,
  readDeleted,
  readOptionalBoolean,
  readOptionalString,
  readString,
} from "./shape.ts";

/** One `relations` entry on a note, e.g. `{ objectKey: "opportunity", recordId }`. */
export interface NoteRelation {
  objectKey: string;
  recordId: string;
}

/** A contact note as GHL returns it. */
export interface Note {
  id: string;
  contactId: string;
  body: string;
  bodyText?: string | undefined;
  dateAdded?: string | undefined;
  pinned?: boolean | undefined;
  userId?: string | undefined;
  /** Record ids of the `relations` entries whose objectKey is `opportunity`. */
  opportunityIds: string[];
  /** Every relation, opportunity or not, as GHL returned it. */
  relations: NoteRelation[];
}

/** Identifies one note on one contact. */
export interface NoteRef {
  contactId: string;
  noteId: string;
}

/** Input for {@link createNote}. */
export interface CreateNoteInput {
  contactId: string;
  body: string;
  /** Links the note to this opportunity (D8). */
  opportunityId?: string;
  userId?: string;
}

/** Input for {@link updateNote}. */
export interface UpdateNoteInput extends NoteRef {
  body: string;
  /**
   * A string replaces the opportunity link, `null` removes it, `undefined` keeps
   * every relation. Either change reads the note first and keeps its
   * non-opportunity relations (e.g. `task`), because GHL replaces the whole array.
   */
  opportunityId?: string | null;
}

const OPPORTUNITY = "opportunity";

function parseRelation(item: unknown, field: string): NoteRelation {
  const shape = asShape(item, field);
  return {
    objectKey: readString(shape, "objectKey", field),
    recordId: readString(shape, "recordId", field),
  };
}

function parseNote(value: unknown, field: string): Note {
  const shape = asShape(value, field);
  const relations = Array.isArray(shape.relations)
    ? readArray(shape, "relations", field, parseRelation)
    : [];
  return {
    id: readString(shape, "id", field),
    contactId: readString(shape, "contactId", field),
    body: readString(shape, "body", field),
    bodyText: readOptionalString(shape, "bodyText"),
    dateAdded: readOptionalString(shape, "dateAdded"),
    pinned: readOptionalBoolean(shape, "pinned"),
    userId: readOptionalString(shape, "userId"),
    opportunityIds: relations
      .filter((relation) => relation.objectKey === OPPORTUNITY)
      .map((relation) => relation.recordId),
    relations,
  };
}

function readNote(response: unknown): Note {
  return parseNote(asShape(response, "response").note, "note");
}

/** `kept` plus a link to `opportunityId` when it is a string. */
function withOpportunity(
  kept: readonly NoteRelation[],
  opportunityId: string | null,
): JsonObject[] {
  const relations: JsonObject[] = kept.map((relation) => ({ ...relation }));
  if (opportunityId !== null) {
    relations.push({ objectKey: OPPORTUNITY, recordId: opportunityId });
  }
  return relations;
}

/** `{ relations }` for a new note: just the opportunity link, when there is one. */
function relationsFor(opportunityId: string | undefined): JsonObject {
  return opportunityId === undefined
    ? {}
    : { relations: withOpportunity([], opportunityId) };
}

/** The note's non-opportunity relations with the link set or removed (read first). */
async function mergedRelations(
  client: AccountClient,
  input: UpdateNoteInput & { opportunityId: string | null },
): Promise<JsonObject[]> {
  const note = await getNote(client, input);
  const kept = note.relations.filter((relation) => relation.objectKey !== OPPORTUNITY);
  return withOpportunity(kept, input.opportunityId);
}

function requireBody(body: string): string {
  if (body.trim() === "") throw new Error("A note body must not be blank.");
  return body;
}

/**
 * List every note on a contact.
 *
 * @param client - The account client.
 * @param contactId - The contact whose notes to list.
 * @returns The parsed notes.
 * @throws HighLevelShapeError when the response is not `{ notes: [...] }`.
 */
export async function listNotes(
  client: AccountClient,
  contactId: string,
): Promise<Note[]> {
  // operationId: get-all-notes
  const response = await callOperation(
    client,
    { family: "v2", operationId: "get-all-notes" },
    { pathParams: { contactId } },
  );
  return readArray(asShape(response, "response"), "notes", "response", parseNote);
}

/**
 * Get one note.
 *
 * @param client - The account client.
 * @param ref - The contact and note ids.
 * @returns The parsed note.
 * @throws HighLevelShapeError when the response is not `{ note }`.
 */
export async function getNote(client: AccountClient, ref: NoteRef): Promise<Note> {
  // operationId: get-note
  const response = await callOperation(
    client,
    { family: "v2", operationId: "get-note" },
    { pathParams: { contactId: ref.contactId, id: ref.noteId } },
  );
  return readNote(response);
}

/**
 * Add a note to a contact, optionally linked to an opportunity.
 *
 * @param client - The account client (needs `allowWrites`).
 * @param input - Contact, body, and optional opportunity and user.
 * @returns The created note.
 * @throws Error when the body is blank (before any request).
 */
export async function createNote(
  client: AccountClient,
  input: CreateNoteInput,
): Promise<Note> {
  const body: JsonObject = {
    body: requireBody(input.body),
    ...(input.userId === undefined ? {} : { userId: input.userId }),
    ...relationsFor(input.opportunityId),
  };
  // operationId: create-note
  const response = await callOperation(
    client,
    { family: "v2", operationId: "create-note" },
    { pathParams: { contactId: input.contactId }, body },
  );
  return readNote(response);
}

/**
 * Replace a note's body; `opportunityId` sets, clears (`null`), or keeps (`undefined`)
 * the opportunity link. Setting or clearing reads the note first so its other
 * relations survive (`GET` then `PUT`).
 *
 * @param client - The account client (needs `allowWrites`).
 * @param input - Contact, note, new body, and the optional opportunity link.
 * @returns The updated note.
 * @throws Error when the body is blank (before any request).
 */
export async function updateNote(
  client: AccountClient,
  input: UpdateNoteInput,
): Promise<Note> {
  const body: JsonObject = { body: requireBody(input.body) };
  const { opportunityId } = input;
  if (opportunityId !== undefined) {
    body.relations = await mergedRelations(client, { ...input, opportunityId });
  }
  // operationId: update-note
  const response = await callOperation(
    client,
    { family: "v2", operationId: "update-note" },
    { pathParams: { contactId: input.contactId, id: input.noteId }, body },
  );
  return readNote(response);
}

/**
 * Delete a note.
 *
 * @param client - The account client (needs `allowWrites`).
 * @param ref - The contact and note ids.
 * @returns Whether GHL reports the delete succeeded (its `succeded`, or `succeeded`).
 * @throws HighLevelShapeError when neither field is a boolean.
 */
export async function deleteNote(
  client: AccountClient,
  ref: NoteRef,
): Promise<boolean> {
  // operationId: delete-note
  const response = await callOperation(
    client,
    { family: "v2", operationId: "delete-note" },
    { pathParams: { contactId: ref.contactId, id: ref.noteId } },
  );
  return readDeleted(response);
}
