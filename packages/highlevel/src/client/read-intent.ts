/**
 * Per-request intents only `callOperation` may set. They are keyed by
 * the request's init object, so nothing travels in the public
 * `HighLevelRequestInit` and nothing reaches `fetch`. This module is internal:
 * it is not exported from the package index.
 *
 * @module
 */

/**
 * Inits for catalog operations marked `readOnly` (POST searches). The client
 * sends these without `allowWrites` and does not plan them on a dry-run client.
 */
export const READ_ONLY_INITS = new WeakSet<object>();

/**
 * The location ids bound to location-type params (`locationId`, `location_id`,
 * `altId`) of the endpoint template, per init. The account guard checks these
 * instead of guessing location segments from the path.
 */
export const TEMPLATE_LOCATIONS = new WeakMap<object, readonly string[]>();
