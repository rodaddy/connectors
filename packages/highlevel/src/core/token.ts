/**
 * Token supply for the HighLevel client: a fixed string, or a provider called
 * on every request. Callers fetch tokens (from a vault, an env var, a refresh
 * flow); this library never does and caches nothing.
 *
 * @module
 */

/** Returns the access token for one request; called again for every request. */
export type TokenProvider = () => Promise<string> | string;

/**
 * Resolve a token or provider to the token for this request.
 *
 * @param token - A token string, or a provider to call now.
 * @returns The non-empty token.
 * @throws Error when the token is empty.
 */
export async function resolveToken(token: string | TokenProvider): Promise<string> {
  const value = typeof token === "string" ? token : await token();
  if (!value.trim()) {
    throw new Error("A HighLevel access token is required.");
  }
  return value;
}
