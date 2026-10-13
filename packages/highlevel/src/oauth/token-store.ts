/**
 * Where OAuth tokens live between requests, and the bridge that turns a store
 * into the client's {@link TokenProvider}.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { TokenProvider } from "../core/token.ts";
import { asShape, HighLevelShapeError, readString } from "../crm/shape.ts";
import { asUserType, type OAuthTokens, withIds } from "./oauth.ts";

/** Keyed token storage, e.g. one key per installed location. */
export interface TokenStore {
  get(key: string): Promise<OAuthTokens | undefined>;
  set(key: string, tokens: OAuthTokens): Promise<void>;
  delete(key: string): Promise<void>;
}

/** An in-process store; tokens are gone when the process ends. */
export class MemoryTokenStore implements TokenStore {
  readonly #tokens = new Map<string, OAuthTokens>();

  /** @returns The tokens for `key`, or `undefined`. */
  get(key: string): Promise<OAuthTokens | undefined> {
    return Promise.resolve(this.#tokens.get(key));
  }

  /** Replace the tokens for `key`. */
  set(key: string, tokens: OAuthTokens): Promise<void> {
    this.#tokens.set(key, { ...tokens });
    return Promise.resolve();
  }

  /** Forget the tokens for `key`. */
  delete(key: string): Promise<void> {
    this.#tokens.delete(key);
    return Promise.resolve();
  }
}

/** A token file is readable by more than its owner. */
export class TokenFileModeError extends Error {
  constructor(path: string, mode: number) {
    super(
      `Token file ${path} has mode ${mode.toString(8)}; it must be 600 or narrower.`,
    );
    this.name = "TokenFileModeError";
  }
}

/**
 * One JSON file holding every key's tokens. Writes are atomic (a 0600 temp
 * file in the same directory, fsync, rename) and serialized in this process;
 * a file whose mode is wider than 0600 is refused on read.
 */
export class FileTokenStore implements TokenStore {
  readonly #path: string;
  #queue: Promise<unknown> = Promise.resolve();

  /** @param path - The token file; its directory must exist. */
  constructor(path: string) {
    this.#path = path;
  }

  /** @returns The tokens for `key`, or `undefined`. */
  async get(key: string): Promise<OAuthTokens | undefined> {
    await this.#queue;
    return (await this.#readAll())[key];
  }

  /** Replace the tokens for `key`. */
  set(key: string, tokens: OAuthTokens): Promise<void> {
    return this.#update((all) => ({ ...all, [key]: tokens }));
  }

  /** Forget the tokens for `key`. */
  delete(key: string): Promise<void> {
    return this.#update(({ [key]: _gone, ...rest }) => rest);
  }

  #update(
    change: (all: Record<string, OAuthTokens>) => Record<string, OAuthTokens>,
  ): Promise<void> {
    const next = this.#queue.then(async () =>
      this.#writeAll(change(await this.#readAll())),
    );
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #readAll(): Promise<Record<string, OAuthTokens>> {
    let mode: number;
    try {
      mode = (await stat(this.#path)).mode & 0o777;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    if ((mode & ~0o600) !== 0) throw new TokenFileModeError(this.#path, mode);
    const root = asShape(JSON.parse(await readFile(this.#path, "utf8")), "tokens");
    return Object.fromEntries(
      Object.entries(root).map(([key, value]) => [
        key,
        parseStored(value, `tokens.${key}`),
      ]),
    );
  }

  async #writeAll(all: Record<string, OAuthTokens>): Promise<void> {
    const temp = join(dirname(this.#path), `.${randomUUID()}.tmp`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(all, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, this.#path);
    } catch (error: unknown) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}

/** Parse one stored entry; a hand-edited or corrupt file fails loudly. */
function parseStored(value: unknown, field: string): OAuthTokens {
  const shape = asShape(value, field);
  const expiresAt = shape["expiresAt"];
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
    throw new HighLevelShapeError(`${field}.expiresAt`, "a number");
  const userType = asUserType(shape["userType"]);
  if (userType === undefined)
    throw new HighLevelShapeError(`${field}.userType`, "Company or Location");
  const tokens: OAuthTokens = {
    accessToken: readString(shape, "accessToken", field),
    refreshToken: readString(shape, "refreshToken", field),
    expiresAt,
    scope: readString(shape, "scope", field),
    userType,
  };
  return withIds(tokens, shape);
}

/** Refresh 60 s before expiry so a request never leaves with a dying token. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Bridge a store to the client: a {@link TokenProvider} that returns the
 * stored access token, refreshing (and saving the rotated tokens) once it is
 * within 60 s of expiry. Concurrent calls share one refresh, because GHL
 * rotates the refresh token and a second refresh with the old one fails.
 *
 * @param refresh - e.g. `(t) => refreshTokens({ clientId, clientSecret,
 *   refreshToken: t.refreshToken, userType: t.userType })`: pass the stored
 *   `userType`, so a Company token is refreshed as Company.
 */
export function tokenProviderFrom(
  store: TokenStore,
  key: string,
  refresh: (tokens: OAuthTokens) => Promise<OAuthTokens>,
): TokenProvider {
  let inFlight: Promise<string> | undefined;
  const load = async (): Promise<OAuthTokens> => {
    const tokens = await store.get(key);
    if (tokens === undefined) throw new Error(`No OAuth tokens stored for ${key}.`);
    return tokens;
  };
  const fresh = (tokens: OAuthTokens): boolean =>
    tokens.expiresAt - Date.now() > REFRESH_MARGIN_MS;
  // Re-read inside the single flight: a caller whose read raced a finished
  // refresh would otherwise refresh again with the spent refresh token.
  const renew = async (): Promise<string> => {
    const current = await load();
    if (fresh(current)) return current.accessToken;
    const next = await refresh(current);
    await store.set(key, next);
    return next.accessToken;
  };
  return async () => {
    const tokens = await load();
    if (fresh(tokens)) return tokens.accessToken;
    inFlight ??= renew().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
