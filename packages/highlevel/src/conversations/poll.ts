/**
 * Poll for new INBOUND messages: page through the conversations that moved
 * since a time, read their messages, keep inbound ones, and dedupe by id
 * through a {@link SeenStore}. Read-only; it sends nothing.
 *
 * @module
 */

import type { AccountClient } from "../accounts.ts";
import { HighLevelShapeError } from "../crm/shape.ts";
import {
  epochMs,
  listMessages,
  searchConversations,
  type Conversation,
  type Message,
} from "./read.ts";
import type { SeenStore } from "./seen-store.ts";

/** One new inbound message. `body` is personal data. */
export interface InboundEvent {
  messageId: string;
  conversationId: string;
  contactId: string;
  /** `SMS`, `Email`, or GHL's type without its `TYPE_` prefix (e.g. `WHATSAPP`). */
  channel: string;
  dateAdded: string;
  body?: string;
}

/** Options for {@link pollInbound}. */
export interface PollInboundOptions {
  /** Ignore messages at or before this time (epoch milliseconds). */
  since: number;
  seen: SeenStore;
  /** Keep only these channels (case-insensitive); all when omitted. */
  channels?: string[];
}

const SEARCH_PAGE_LIMIT = 50;
const CHANNEL_NAMES: Record<string, string> = { SMS: "SMS", EMAIL: "Email" };

function channelOf(type: string): string {
  const name = type.replace(/^TYPE_/, "");
  return CHANNEL_NAMES[name.toUpperCase()] ?? name;
}

function isAfter(date: number | undefined, since: number): boolean {
  return date === undefined || date > since;
}

/** Every conversation whose last message is after `since`, newest first, across pages. */
async function changedConversations(
  client: AccountClient,
  since: number,
): Promise<Conversation[]> {
  const changed: Conversation[] = [];
  let cursor: number | undefined;
  for (;;) {
    const after = cursor === undefined ? {} : { startAfterDate: cursor };
    const page = await searchConversations(client, {
      limit: SEARCH_PAGE_LIMIT,
      sort: "desc",
      ...after,
    });
    const fresh = page.conversations.filter((c) => isAfter(c.lastMessageDate, since));
    changed.push(...fresh);
    const next = page.nextCursor;
    const reachedOld = fresh.length < page.conversations.length;
    const full = page.conversations.length >= SEARCH_PAGE_LIMIT;
    if (full && next === undefined && !reachedOld) {
      // No date to page from: ending here would silently drop later pages.
      throw new HighLevelShapeError(
        "response.conversations[].lastMessageDate",
        "a date",
      );
    }
    const stalled = next === undefined || (cursor !== undefined && next >= cursor);
    if (reachedOld || stalled) return changed;
    cursor = next;
  }
}

/** The conversation's inbound messages after `since`, across message pages. */
async function inboundSince(
  client: AccountClient,
  conversationId: string,
  since: number,
): Promise<Message[]> {
  const inbound: Message[] = [];
  let lastMessageId: string | undefined;
  for (;;) {
    const after = lastMessageId === undefined ? {} : { lastMessageId };
    const page = await listMessages(client, { conversationId, ...after });
    const newer = page.messages.filter((m) => isAfter(epochMs(m.dateAdded), since));
    inbound.push(...newer.filter((m) => m.direction === "inbound"));
    if (newer.length < page.messages.length || page.nextPage === undefined) {
      return inbound;
    }
    lastMessageId = page.nextPage;
  }
}

function toEvent(message: Message, conversation: Conversation): InboundEvent {
  const event: InboundEvent = {
    messageId: message.id,
    conversationId: message.conversationId,
    contactId: message.contactId ?? conversation.contactId,
    channel: channelOf(message.type),
    dateAdded: message.dateAdded,
  };
  return message.body === undefined ? event : { ...event, body: message.body };
}

function byDate(a: InboundEvent, b: InboundEvent): number {
  return (epochMs(a.dateAdded) ?? 0) - (epochMs(b.dateAdded) ?? 0);
}

/**
 * Return the new inbound messages since `since`, oldest first, and mark each
 * one seen; ids already in `seen` are skipped. Conversation search is paged,
 * so more than 50 moved conversations are all read.
 *
 * Message bodies are personal data: this function never logs them, and
 * callers must not log them either.
 *
 * @param client - The account client; its location is polled.
 * @param options - The time floor, the seen store, and an optional channel filter.
 * @returns The new inbound events.
 * @throws HighLevelApiError on a non-2xx, so a failed poll never reads as "nothing new".
 * @throws HighLevelShapeError when a response is malformed, or a full search page has no `lastMessageDate` to page from.
 */
export async function pollInbound(
  client: AccountClient,
  options: PollInboundOptions,
): Promise<InboundEvent[]> {
  const wanted = options.channels?.map((name) => name.toUpperCase());
  const events: InboundEvent[] = [];
  for (const conversation of await changedConversations(client, options.since)) {
    const messages = await inboundSince(client, conversation.id, options.since);
    events.push(...messages.map((message) => toEvent(message, conversation)));
  }
  const fresh: InboundEvent[] = [];
  for (const event of events.sort(byDate)) {
    if (wanted && !wanted.includes(event.channel.toUpperCase())) continue;
    if (await options.seen.has(event.messageId)) continue;
    await options.seen.add(event.messageId);
    fresh.push(event);
  }
  return fresh;
}
