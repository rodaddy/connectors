/**
 * Classify a failed send: carrier codes and GHL's refusal
 * text become one typed kind. Phone numbers and emails are redacted from the
 * reason.
 *
 * @module
 */
import { HighLevelApiError } from "../client/highlevel.ts";
import { extractMessage, redactContactData } from "../core/errors.ts";

/** Why a send failed. */
export type SendErrorKind =
  "a2p-unregistered" | "opted-out" | "invalid-number" | "rate-limit" | "unknown";

/** A classified send failure. `message` has phone numbers and emails redacted. */
export interface SendErrorClass {
  kind: SendErrorKind;
  code?: string;
  message: string;
}

/** First match wins; `code` is reported when the pattern matched it. */
const SEND_ERROR_RULES: ReadonlyArray<{
  kind: SendErrorKind;
  code?: string;
  pattern: RegExp;
}> = [
  { kind: "a2p-unregistered", code: "30034", pattern: /30034/ },
  { kind: "opted-out", pattern: /dnd enabled by customer/i },
  { kind: "opted-out", code: "21610", pattern: /21610|unsubscribed recipient/i },
  {
    kind: "invalid-number",
    code: "21211",
    pattern: /21211|invalid ['"]?to['"]? phone/i,
  },
  { kind: "invalid-number", code: "21614", pattern: /21614|not a valid mobile/i },
];

const RATE_LIMIT: SendErrorClass = { kind: "rate-limit", code: "429", message: "" };

function errorText(error: unknown): string {
  if (error instanceof HighLevelApiError) {
    const reason = extractMessage(error.responseBody) ?? error.responseBody;
    return `HTTP ${error.status}: ${reason}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classify a send failure: carrier `30034` is an unregistered A2P number
 * (`SmsNotRegistered` in earlier tooling `ghl_sms.py`), `DND enabled by
 * customer` an opt-out, an invalid `To` an invalid number, and a
 * {@link HighLevelApiError} of kind `rate-limit` a rate limit.
 *
 * @param error - What {@link sendMessage} threw.
 * @returns The kind, the matched code, and GHL's reason with contact data redacted.
 */
export function classifySendError(error: unknown): SendErrorClass {
  const message = redactContactData(errorText(error));
  const rule = SEND_ERROR_RULES.find((candidate) => candidate.pattern.test(message));
  if (rule !== undefined) {
    return {
      kind: rule.kind,
      ...(rule.code === undefined ? {} : { code: rule.code }),
      message,
    };
  }
  const limited = error instanceof HighLevelApiError && error.kind === "rate-limit";
  return limited ? { ...RATE_LIMIT, message } : { kind: "unknown", message };
}
