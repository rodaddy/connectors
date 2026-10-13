/**
 * Send a message to a contact on any channel. Message
 * bodies and phone numbers are never logged.
 *
 * @module
 */
import type { AccountClient } from "../accounts.ts";
import { callOperation, CallArgumentError } from "../client/call.ts";
import type { JsonObject } from "../client/highlevel.ts";
import {
  asShape,
  HighLevelShapeError,
  readOptionalString,
  readString,
} from "../crm/shape.ts";
import { toE164 } from "./phone.ts";

/** A channel `POST /conversations/messages` sends on. */
export type MessageChannel =
  "SMS" | "Email" | "WhatsApp" | "IG" | "FB" | "Custom" | "Live_Chat";

/** What to send; the location comes from the client. */
export interface SendMessageOptions {
  contactId: string;
  channel: MessageChannel;
  /** The text; sent as GHL's `message`. */
  body?: string;
  subject?: string;
  html?: string;
  /** Normalized to E.164. */
  fromNumber?: string;
  /** Normalized to E.164. */
  toNumber?: string;
  /** Attachment URLs. */
  attachments?: string[];
  /** Epoch seconds to send at. */
  scheduledTimestamp?: number;
}

/** The sent message's ids. */
export interface SentMessage {
  messageId: string;
  conversationId: string;
  status?: string;
}

type ContentField = "body" | "subject" | "html";

/** Per channel: every group must have at least one field set. */
const REQUIRED_FIELDS: Record<
  MessageChannel,
  ReadonlyArray<ReadonlyArray<ContentField>>
> = {
  SMS: [["body"]],
  Email: [["subject"], ["body", "html"]],
  WhatsApp: [],
  IG: [],
  FB: [],
  Custom: [],
  Live_Chat: [],
};

function validate(options: SendMessageOptions): void {
  for (const group of REQUIRED_FIELDS[options.channel]) {
    if (!group.some((field) => (options[field] ?? "") !== "")) {
      throw new CallArgumentError(
        `A ${options.channel} message needs ${group.join(" or ")}.`,
      );
    }
  }
}

function requestBody(options: SendMessageOptions): JsonObject {
  const fields: JsonObject = {
    type: options.channel,
    contactId: options.contactId,
    message: options.body,
    subject: options.subject,
    html: options.html,
    fromNumber:
      options.fromNumber === undefined ? undefined : toE164(options.fromNumber),
    toNumber: options.toNumber === undefined ? undefined : toE164(options.toNumber),
    attachments: options.attachments,
    scheduledTimestamp: options.scheduledTimestamp,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

function parseSent(value: unknown): SentMessage {
  const shape = asShape(value, "response");
  const messageId = ["messageId", "msgId", "id"]
    .map((key) => readOptionalString(shape, key))
    .find((id) => id !== undefined && id !== "");
  if (messageId === undefined)
    throw new HighLevelShapeError("response.messageId", "a string");
  const status = readOptionalString(shape, "status");
  return {
    messageId,
    conversationId: readString(shape, "conversationId", "response"),
    ...(status === undefined ? {} : { status }),
  };
}

/**
 * Send one message to a contact.
 *
 * @param client - The account client; must allow writes.
 * @param options - Contact, channel and content.
 * @returns The message and conversation ids.
 * @throws CallArgumentError when the channel's required fields are missing; nothing is sent.
 * @throws InvalidPhoneError when `fromNumber` or `toNumber` cannot be normalized.
 * @throws HighLevelApiError when GHL refuses; classify it with `classifySendError`.
 * @throws HighLevelDryRunPlanned (from `callOperation`) on a `dryRun` client: nothing is sent and the plan is never parsed as a sent message.
 */
export async function sendMessage(
  client: AccountClient,
  options: SendMessageOptions,
): Promise<SentMessage> {
  validate(options);
  // operationId: send-a-new-message (v2, POST /conversations/messages)
  const response = await callOperation(
    client,
    { family: "v2", operationId: "send-a-new-message" },
    { body: requestBody(options), version: "2021-04-15" },
  );
  return parseSent(response);
}
