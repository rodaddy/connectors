/**
 * Phone numbers the location could buy (after earlier tooling
 * `scripts/ghl/number_watch.py`). Read-only: nothing here acquires a number.
 *
 * @module
 */
import type { AccountClient } from "./accounts.ts";
import { callOperation, type QueryValue } from "./client/call.ts";
import {
  asShape,
  readArray,
  readOptionalNumber,
  readOptionalString,
  readString,
} from "./crm/shape.ts";

/** One number the inventory offers. */
export interface AvailableNumber {
  /** E.164, e.g. `+16315550100`. */
  number: string;
  friendlyName?: string;
  /** The enabled capabilities, e.g. `["MMS", "SMS", "voice"]`. */
  capabilities?: string[];
  /** City or locality of the number. */
  locality?: string;
  /** Monthly price (GHL `price.price`), in the inventory's currency. */
  price?: number;
}

/** What {@link listAvailableNumbers} asks the inventory for. */
export interface AvailableNumberQuery {
  /** ISO country code; defaults to `US`. */
  countryCode?: string;
  /** Leading digits after the country code (GHL `firstPart`). */
  areaCode?: string;
  /** Trailing digits (GHL `lastPart`). */
  endsWith?: string;
  /** Digits anywhere in the number (GHL `anywhere`). */
  contains?: string;
  /** Number types, e.g. `["local"]`; sent comma-separated (GHL `numberTypes`). */
  numberTypes?: readonly string[];
  /** Only numbers with SMS (GHL `smsEnabled`). */
  smsEnabled?: boolean;
  /** Only numbers with MMS (GHL `mmsEnabled`). */
  mmsEnabled?: boolean;
  /** Only numbers with voice (GHL `voiceEnabled`). */
  voiceEnabled?: boolean;
  /** Keep at most this many; GHL has no limit parameter. */
  limit?: number;
}

/** {@link filterNumbers}' pattern. */
export interface NumberFilter {
  /** Trailing digits the number must end with. */
  endsWith?: string;
  /** North American area codes, any of which the number must start with (`+1<code>`). */
  areaCodes?: readonly string[];
}

/** Query option -> GHL query parameter, in the order they are sent. */
const QUERY_NAMES = [
  ["areaCode", "firstPart"],
  ["endsWith", "lastPart"],
  ["contains", "anywhere"],
  ["numberTypes", "numberTypes"],
  ["smsEnabled", "smsEnabled"],
  ["mmsEnabled", "mmsEnabled"],
  ["voiceEnabled", "voiceEnabled"],
] as const satisfies readonly (readonly [keyof AvailableNumberQuery, string])[];

function buildQuery(options: AvailableNumberQuery): Record<string, QueryValue> {
  const query: Record<string, QueryValue> = {
    countryCode: options.countryCode ?? "US",
  };
  for (const [option, name] of QUERY_NAMES) {
    const value = options[option];
    if (value === undefined) continue;
    query[name] = Array.isArray(value) ? value.join(",") : value;
  }
  return query;
}

function parseNumber(item: unknown, field: string): AvailableNumber {
  const shape = asShape(item, field);
  const entry: AvailableNumber = { number: readString(shape, "phoneNumber", field) };
  const friendlyName = readOptionalString(shape, "friendlyName");
  if (friendlyName !== undefined) entry.friendlyName = friendlyName;
  const flags = shape.capabilities;
  if (flags !== null && typeof flags === "object" && !Array.isArray(flags)) {
    entry.capabilities = Object.entries(flags)
      .filter(([, on]) => on === true)
      .map(([name]) => name);
  }
  const locality = readOptionalString(shape, "locality");
  if (locality !== undefined) entry.locality = locality;
  const pricing = shape.price;
  if (pricing !== null && typeof pricing === "object" && !Array.isArray(pricing)) {
    const price = readOptionalNumber(asShape(pricing, `${field}.price`), "price");
    if (price !== undefined) entry.price = price;
  }
  return entry;
}

/**
 * List numbers available to buy
 * (`GET /phone-system/numbers/location/{locationId}/available`).
 * GHL's own filtering is not trusted; pass the result through {@link filterNumbers}.
 *
 * @throws HighLevelShapeError when the response has no `numbers` array.
 */
export async function listAvailableNumbers(
  client: AccountClient,
  options: AvailableNumberQuery = {},
): Promise<AvailableNumber[]> {
  // operationId: available-numbers
  const response = await callOperation(
    client,
    { family: "v2", operationId: "available-numbers" },
    { pathParams: { locationId: client.locationId }, query: buildQuery(options) },
  );
  const numbers = readArray(
    asShape(response, "available-numbers"),
    "numbers",
    "available-numbers",
    parseNumber,
  );
  return options.limit === undefined ? numbers : numbers.slice(0, options.limit);
}
/** Keep only the numbers that really match `filter`; an empty filter keeps all. */
export function filterNumbers(
  numbers: readonly AvailableNumber[],
  filter: NumberFilter,
): AvailableNumber[] {
  const prefixes = (filter.areaCodes ?? []).map((code) => `+1${code}`);
  return numbers.filter(
    ({ number }) =>
      (prefixes.length === 0 || prefixes.some((prefix) => number.startsWith(prefix))) &&
      number.endsWith(filter.endsWith ?? ""),
  );
}
