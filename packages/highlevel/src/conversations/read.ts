/**
 * Read conversations and their messages. The conversations routes are on API
 * Version `2021-04-15` (the catalog's version; `2021-07-28` answers 404/422 on
 * `/conversations/search`, proven in earlier tooling `scripts/ghl/inbound.py`).
 *
 * @module
 */

import type { AccountClient } from "../accounts.ts";
import { callOperation, type QueryValue } from "../client/call.ts";
import {
  asShape,
  readArray,
  readOptionalNumber,
  readOptionalString,
  readString,
  type Shape,
} from "../crm/shape.ts";

/** A message or conversation direction. */
export type Direction = "inbound" | "outbound";

/** One conversation. `lastMessageDate` is epoch milliseconds. */
export interface Conversation {
  id: string;
  contactId: string;
  lastMessageDate?: number;
  lastMessageType?: string;
  lastMessageDirection?: Direction;
  unreadCount?: number;
  type?: string;
}

/** One message. `type` is GHL's `messageType` (e.g. `TYPE_SMS`). */
export interface Message {
  id: string;
  conversationId: string;
  contactId?: string;
  direction: Direction;
  type: string;
  body?: string;
  dateAdded: string;
  status?: string;
}

/** Options for {@link searchConversations}. */
export interface SearchConversationsOptions {
  contactId?: string;
  query?: string;
  /** Page size; GHL caps it at 50. Defaults to 20. */
  limit?: number;
  /** The previous page's `nextCursor`. */
  startAfterDate?: number;
  /** Order by last message date; defaults to `desc`. */
  sort?: "asc" | "desc";
}

/** One page of {@link searchConversations}. */
export interface ConversationPage {
  conversations: Conversation[];
  total?: number;
  /** Pass as `startAfterDate` for the next page; absent on the last page. */
  nextCursor?: number;
}

/** Options for {@link listMessages}. */
export interface ListMessagesOptions {
  conversationId: string;
  limit?: number;
  /** The previous page's `nextPage`. */
  lastMessageId?: string;
}

/** One page of {@link listMessages}. */
export interface MessagePage {
  messages: Message[];
  /** Pass as `lastMessageId` for the next page; absent on the last page. */
  nextPage?: string;
}

const CONVERSATIONS_VERSION = "2021-04-15";
const DEFAULT_LIMIT = 20;

/** Epoch ms for a GHL timestamp (ms number or ISO string); `undefined` when unreadable. */
export function epochMs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function readText(shape: Shape, key: string): string | undefined {
  const value = shape[key];
  return typeof value === "number" ? String(value) : readOptionalString(shape, key);
}

function readDirection(shape: Shape, key: string): Direction | undefined {
  const value = readOptionalString(shape, key)?.toLowerCase();
  return value === "inbound" || value === "outbound" ? value : undefined;
}

type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/** The defined fields of `fields`, so optional properties are omitted rather than `undefined`. */
function optional<T extends object>(fields: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Defined<T>;
}

function parseConversation(value: unknown, field: string): Conversation {
  const shape = asShape(value, field);
  return {
    id: readString(shape, "id", field),
    contactId: readString(shape, "contactId", field),
    ...optional({
      lastMessageDate: epochMs(shape["lastMessageDate"]),
      lastMessageType: readOptionalString(shape, "lastMessageType"),
      lastMessageDirection: readDirection(shape, "lastMessageDirection"),
      unreadCount: readOptionalNumber(shape, "unreadCount"),
      type: readText(shape, "type"),
    }),
  };
}

/** A message, or `undefined` for one with no inbound/outbound direction (skipped, like inbound.py). */
function parseMessage(value: unknown, field: string): Message | undefined {
  const shape = asShape(value, field);
  const direction = readDirection(shape, "direction");
  if (direction === undefined) return undefined;
  return {
    id: readString(shape, "id", field),
    conversationId: readString(shape, "conversationId", field),
    direction,
    type: readOptionalString(shape, "messageType") ?? readText(shape, "type") ?? "",
    dateAdded: readString(shape, "dateAdded", field),
    ...optional({
      contactId: readOptionalString(shape, "contactId"),
      body: readOptionalString(shape, "body"),
      status: readOptionalString(shape, "status"),
    }),
  };
}

/**
 * Search the account's conversations, ordered by last message date.
 *
 * @param client - The account client; its location is searched.
 * @param options - Filters, page size, sort, and the previous page's cursor.
 * @returns One page; `nextCursor` is set when the page came back full.
 * @throws HighLevelShapeError when the response is malformed.
 */
export async function searchConversations(
  client: AccountClient,
  options: SearchConversationsOptions = {},
): Promise<ConversationPage> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const query: Record<string, QueryValue> = {
    locationId: client.locationId,
    limit,
    sort: options.sort ?? "desc",
    sortBy: "last_message_date",
    ...optional({
      contactId: options.contactId,
      query: options.query,
      startAfterDate: options.startAfterDate,
    }),
  };
  // operationId: search-conversation
  const body = await callOperation(
    client,
    { family: "v2", operationId: "search-conversation" },
    { query, version: CONVERSATIONS_VERSION },
  );
  const shape = asShape(body, "response");
  const conversations = readArray(
    shape,
    "conversations",
    "response",
    parseConversation,
  );
  const full = conversations.length >= limit;
  const total = readOptionalNumber(shape, "total");
  // A full page pages from its last DEFINED date: lastMessageDate is optional.
  const dates = conversations
    .map((c) => c.lastMessageDate)
    .filter((d) => d !== undefined);
  const nextCursor = full ? dates.at(-1) : undefined;
  return { conversations, ...optional({ total, nextCursor }) };
}

/**
 * Read one conversation by id.
 *
 * @throws HighLevelShapeError when the response is malformed.
 */
export async function getConversation(
  client: AccountClient,
  id: string,
): Promise<Conversation> {
  // operationId: get-conversation
  const body = await callOperation(
    client,
    { family: "v2", operationId: "get-conversation" },
    { pathParams: { conversationId: id }, version: CONVERSATIONS_VERSION },
  );
  return parseConversation(body, "response");
}

/**
 * Read one page of a conversation's messages. GHL nests the list as
 * `messages.messages` or returns it flat as `messages`; both are read. A
 * message with no `inbound`/`outbound` direction (an activity or system
 * entry) is skipped, not an error.
 *
 * @throws HighLevelShapeError when the response is malformed.
 */
export async function listMessages(
  client: AccountClient,
  options: ListMessagesOptions,
): Promise<MessagePage> {
  // operationId: get-messages
  const body = await callOperation(
    client,
    { family: "v2", operationId: "get-messages" },
    {
      pathParams: { conversationId: options.conversationId },
      query: optional({ limit: options.limit, lastMessageId: options.lastMessageId }),
      version: CONVERSATIONS_VERSION,
    },
  );
  const outer = asShape(body, "response");
  const node = outer["messages"];
  const isNested = node !== null && typeof node === "object" && !Array.isArray(node);
  const envelope = isNested ? asShape(node, "response.messages") : outer;
  const field = isNested ? "response.messages" : "response";
  const messages = readArray(envelope, "messages", field, parseMessage).filter(
    (message) => message !== undefined,
  );
  const lastId = readOptionalString(envelope, "lastMessageId");
  const nextPage = envelope["nextPage"] === true ? lastId : undefined;
  return { messages, ...optional({ nextPage }) };
}
