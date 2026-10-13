/**
 * Errors the HighLevel client raises: the classifier that turns a failed
 * response into a kind and a clean message, and the timeout error. Every route
 * family answers failures in its own shape; one classifier reads them all.
 *
 * @module
 */

/** What went wrong with a failed HighLevel request. */
export type HighLevelErrorKind =
  | "auth"
  | "scope"
  | "not-found"
  | "validation"
  | "rate-limit"
  | "server"
  | "cloudflare"
  | "unknown";

/** The classifier's verdict on one failed response. */
export interface ClassifiedError {
  kind: HighLevelErrorKind;
  message: string;
}

interface FailedResponse {
  status: number;
  body: string;
  contentType: string;
}

interface Rule {
  kind: HighLevelErrorKind;
  matches: (response: FailedResponse) => boolean;
}

const SCOPE_PHRASE = "not authorized for this scope";

/** First match wins: Cloudflare before any status rule, scope before auth. */
const RULES: readonly Rule[] = [
  { kind: "cloudflare", matches: isCloudflarePage },
  {
    kind: "scope",
    matches: (r) => r.status === 401 && r.body.toLowerCase().includes(SCOPE_PHRASE),
  },
  { kind: "auth", matches: (r) => r.status === 401 || r.status === 403 },
  { kind: "not-found", matches: (r) => r.status === 404 },
  { kind: "validation", matches: (r) => r.status === 400 || r.status === 422 },
  { kind: "rate-limit", matches: (r) => r.status === 429 },
  { kind: "server", matches: (r) => r.status >= 500 && r.status <= 599 },
];

const FALLBACK_MESSAGES: Readonly<Record<HighLevelErrorKind, string>> = {
  auth: "HighLevel rejected the credentials",
  scope: "The token is not authorized for this scope",
  "not-found": "HighLevel found nothing at this path",
  validation: "HighLevel rejected the request as invalid",
  "rate-limit": "HighLevel rate limit reached",
  server: "HighLevel server error",
  cloudflare: "Cloudflare blocked the request before it reached HighLevel",
  unknown: "HighLevel API request failed",
};

/** Body fields that carry the failure's own message, in the order tried. */
const MESSAGE_KEYS = ["message", "error", "msg", "errors"] as const;

/** Phone-number-like digit runs and email addresses, replaced by {@link redactContactData}. */
const CONTACT_DATA = /\+?\d[\d\s().-]{8,}\d|[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;

/**
 * Replace phone-number-like digit runs and email addresses with `[redacted]`,
 * so text GHL echoes back never carries contact data into a message or log.
 *
 * @param text - Any text.
 * @returns The text with contact data redacted.
 */
export function redactContactData(text: string): string {
  return text.replace(CONTACT_DATA, "[redacted]");
}

/**
 * Classify a failed response.
 *
 * @param status - The HTTP status code.
 * @param bodyText - The raw response body.
 * @param contentType - The `Content-Type` header, or `null` when absent.
 * @returns The kind, and a message naming the kind and status, followed by the
 *   body's own text (see {@link extractMessage}) with contact data redacted
 *   ({@link redactContactData}). The raw body is never put in the message.
 */
export function classifyError(
  status: number,
  bodyText: string,
  contentType: string | null,
): ClassifiedError {
  const response = {
    status,
    body: bodyText,
    contentType: (contentType ?? "").toLowerCase(),
  };
  const kind = RULES.find((rule) => rule.matches(response))?.kind ?? "unknown";
  const detail = kind === "cloudflare" ? undefined : extractMessage(bodyText);
  const prefix = `${FALLBACK_MESSAGES[kind]} (status ${status})`;
  if (detail === undefined) return { kind, message: `${prefix}.` };
  return { kind, message: `${prefix}: ${redactContactData(detail)}` };
}

/** A request that did not answer within the client's `timeoutMs`. */
export class HighLevelTimeoutError extends Error {
  /** The HTTP method. */
  readonly method: string;
  /** The path below the base URL, without its query string (it can carry contact data). */
  readonly path: string;
  /** The timeout that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  /** @param details - The timed-out request's method, path and timeout. */
  constructor(details: { method: string; path: string; timeoutMs: number }) {
    const path = details.path.split(/[?#]/, 1)[0] ?? "";
    super(
      `HighLevel ${details.method} ${path} timed out after ${details.timeoutMs} ms.`,
    );
    this.name = "HighLevelTimeoutError";
    this.method = details.method;
    this.path = path;
    this.timeoutMs = details.timeoutMs;
  }
}

function isCloudflarePage(response: FailedResponse): boolean {
  if (!response.contentType.includes("text/html")) return false;
  const body = response.body.toLowerCase();
  return body.includes("cloudflare") || body.includes("error code: 1010");
}

/**
 * The failure's own text from a response body: the first of `message`,
 * `error`, `msg`, `errors` in a JSON body (arrays joined with "; "), or a
 * JSON string body. Not redacted.
 *
 * @param bodyText - The raw response body.
 * @returns The extracted text, or `undefined` when there is none.
 */
export function extractMessage(bodyText: string): string | undefined {
  const parsed = parseJson(bodyText);
  if (!isRecord(parsed)) return textOf(parsed);
  return MESSAGE_KEYS.map((key) => textOf(parsed[key])).find(
    (text) => text !== undefined,
  );
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (isRecord(value)) return textOf(value.message);
  if (!Array.isArray(value)) return undefined;
  const parts = value.map((item) => textOf(item)).filter((part) => part !== undefined);
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
