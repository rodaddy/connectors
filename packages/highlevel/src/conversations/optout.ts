/**
 * Opt-out detection and drip response analysis, ported from an earlier
 * MCP server's `isOptOut` and `analyze_drip_responses`.
 *
 * @module
 */

/** Whole-message opt-out keywords, compared after {@link normalize}. */
const OPT_OUT_MESSAGES = new Set([
  "stop",
  "stopall",
  "stop all",
  "unsubscribe",
  "end",
  "quit",
  "cancel",
  "remove me",
  "opt out",
  "optout",
]);

/** HighLevel's synthetic carrier-opt-out message; a system marker, so it may carry a suffix. */
const DND_MARKER = "dnd enabled by customer";

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** The opt-out words of an earlier integration, matched at a word boundary anywhere. */
const OPT_OUT_WORDS = /\b(stop|unsubscribe|remove me|opt ?out)\b/;

/** Options for {@link isOptOut}. */
export interface OptOutOptions {
  /** Match whole-message keywords only; fails open on `Stop texting me`. Defaults to false. */
  strict?: boolean;
}

/**
 * Whether a message is an opt-out. The default fails SAFE, like the earlier integration:
 * `stop`, `unsubscribe`, `remove me` or `opt out` anywhere at a word
 * boundary (`Stop texting me`, `STOP. wrong number`; also `don't stop`),
 * a whole-message keyword (`END`, `quit`, ...), or HighLevel's
 * `DND enabled by customer` marker. `{ strict: true }` keeps only the
 * whole-message keywords and the marker.
 *
 * @param text - The message body.
 * @param options - `strict` for whole-message matching.
 * @returns True when the message opts out.
 */
export function isOptOut(text: string, options: OptOutOptions = {}): boolean {
  const normalized = normalize(text);
  const whole = OPT_OUT_MESSAGES.has(normalized) || normalized.startsWith(DND_MARKER);
  return whole || (options.strict !== true && OPT_OUT_WORDS.test(normalized));
}

/** One message of a conversation, as {@link analyzeResponses} reads it. */
export interface ResponseMessage {
  /** `inbound` or `outbound`; only inbound messages are counted. */
  direction: string;
  body?: string;
  /** ISO timestamp the message was added. */
  dateAdded: string;
}

/** The response signal over a set of messages. */
export interface ResponseAnalysis {
  /** Inbound messages. */
  inbound: number;
  /** Inbound messages that opt out. */
  optOuts: number;
  /** Inbound messages with text that do not opt out. */
  replies: number;
  /** `dateAdded` of the earliest reply. */
  firstReplyAt?: string;
}

/**
 * Split inbound messages into opt-outs and replies. Inbound messages with no
 * text count as inbound only.
 *
 * @param messages - The messages to scan, any order.
 * @returns The counts and the earliest reply time.
 */
export function analyzeResponses(
  messages: ReadonlyArray<ResponseMessage>,
): ResponseAnalysis {
  const inbound = messages.filter((message) => message.direction === "inbound");
  const withText = inbound.filter((message) => (message.body ?? "").trim() !== "");
  const optOuts = withText.filter((message) => isOptOut(message.body ?? ""));
  const replies = withText.filter((message) => !isOptOut(message.body ?? ""));
  const first = replies.reduce<ResponseMessage | undefined>(
    (earliest, message) =>
      earliest === undefined ||
      Date.parse(message.dateAdded) < Date.parse(earliest.dateAdded)
        ? message
        : earliest,
    undefined,
  );
  return {
    inbound: inbound.length,
    optOuts: optOuts.length,
    replies: replies.length,
    ...(first === undefined ? {} : { firstReplyAt: first.dateAdded }),
  };
}
