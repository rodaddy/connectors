/**
 * A status-returning adapter over {@link HighLevelClient}, for callers ported
 * from the Python `call()` that returned `(status, body)` and never raised on
 * an HTTP status.
 *
 * @module
 */

import {
  HighLevelApiError,
  type HighLevelClient,
  type HighLevelRequestInit,
} from "../client/highlevel.ts";

/** The outcome of {@link tryRequest}: the data, or the classified API error. */
export type HighLevelResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: HighLevelApiError };

/**
 * Send one request and return its outcome instead of throwing on a non-2xx.
 * A dry-run plan comes back as `{ ok: true, status: 0, data: plan }`.
 *
 * @param client - The client to send through (an account client keeps its guard).
 * @param path - Path below the base URL, including any query string.
 * @param init - Request options, as for {@link HighLevelClient.request}.
 * @param apiVersion - The `Version` header; the client default when omitted.
 * @returns `ok: true` with status and data, or `ok: false` with the error.
 * @throws Error for anything that has no HTTP status: the read-only guard,
 *   the account guard, a timeout, a network failure.
 */
export async function tryRequest<T>(
  client: HighLevelClient,
  path: string,
  init: HighLevelRequestInit = {},
  apiVersion?: string,
): Promise<HighLevelResult<T>> {
  try {
    const { status, data } = await client.requestWithStatus<T>(path, init, apiVersion);
    return { ok: true, status, data };
  } catch (error: unknown) {
    if (error instanceof HighLevelApiError) {
      return { ok: false, status: error.status, error };
    }
    throw error;
  }
}
