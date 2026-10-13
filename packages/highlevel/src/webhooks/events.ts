/**
 * Typed GoHighLevel webhook envelopes. GHL sends each event as one flat JSON
 * object: a `type`, a few envelope fields, and the event's own fields beside
 * them. The envelope fields are lifted out; everything else lands in `data`.
 *
 * @module
 */
import { asShape, readOptionalString, readString } from "../crm/shape.ts";
import type { WebhookEventName } from "./event-names.ts";

export type { WebhookEventName } from "./event-names.ts";
export { WEBHOOK_EVENT_NAMES } from "./event-names.ts";

/** One parsed webhook delivery. */
export interface WebhookEnvelope {
  /** The event type. Documented types (lifecycle `INSTALL`/`UNINSTALL`/`PLAN_CHANGE` included) are typed; others are kept as strings. */
  type: WebhookEventName | (string & {});
  locationId?: string;
  companyId?: string;
  /** ISO timestamp GHL stamped on the delivery. */
  timestamp?: string;
  /** GHL's id for this delivery; the replay guard keys on it. */
  webhookId?: string;
  /** Every other field of the payload. */
  data: Record<string, unknown>;
}

const ENVELOPE_KEYS = new Set([
  "type",
  "locationId",
  "companyId",
  "timestamp",
  "webhookId",
]);

/**
 * Parse a decoded webhook body into an envelope.
 *
 * @param value - The `JSON.parse`d body.
 * @returns The envelope.
 * @throws {HighLevelShapeError} when the body is not an object or has no string `type`.
 */
export function parseWebhookEnvelope(value: unknown): WebhookEnvelope {
  const shape = asShape(value, "webhook");
  const data = Object.fromEntries(
    Object.entries(shape).filter(([key]) => !ENVELOPE_KEYS.has(key)),
  );
  const envelope: WebhookEnvelope = {
    type: readString(shape, "type", "webhook"),
    data,
  };
  for (const key of ["locationId", "companyId", "timestamp", "webhookId"] as const) {
    const field = readOptionalString(shape, key);
    if (field !== undefined) envelope[key] = field;
  }
  return envelope;
}
