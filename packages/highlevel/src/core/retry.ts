/**
 * Retry and pacing as `fetch` wrappers for the client's `fetchImpl`:
 * `withRetry(limitFetch(fetch, createLimiter()))` sends every attempt through
 * the limiter and frees its slot while a retry waits. GoHighLevel allows 100
 * requests per 10 s and 200,000 per day per location; a 429 with
 * `x-ratelimit-daily-remaining: 0` cannot succeed today and is not retried (the
 * official SDK's rule). The rate-limit headers are not in the OpenAPI files, so
 * they are optional.
 *
 * A 502, 503 or 504 can arrive after GHL has already carried out the request,
 * so those are retried only for idempotent methods; a 429 means the request was
 * not processed and is retried for every method.
 *
 * @module
 */

import { setTimeout as delay } from "node:timers/promises";

import type { FetchLike } from "../client/highlevel.ts";

const RATE_LIMITED = 429;
const UNAVAILABLE_STATUSES = new Set([502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const DAILY_REMAINING_HEADER = "x-ratelimit-daily-remaining";

/** Options for {@link withRetry}. */
export interface RetryOptions {
  /** Total attempts, the first included. Defaults to 4. */
  maxAttempts?: number;
  /** Backoff base in milliseconds. Defaults to 500. */
  baseDelayMs?: number;
  /** Backoff ceiling, and the longest `Retry-After` waited for, in milliseconds. Defaults to 15,000. */
  maxDelayMs?: number;
  /** Waits between attempts; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Returns a number in [0, 1) for the jitter; injectable for tests. */
  random?: () => number;
  /** The current time in epoch milliseconds, for a `Retry-After` date. */
  now?: () => number;
}

type RetrySettings = Required<RetryOptions>;
type Input = Parameters<FetchLike>[0];
type Outcome = { response: Response } | { error: unknown };

interface AttemptContext {
  settings: RetrySettings;
  attempt: number;
  idempotent: boolean;
  init: RequestInit | undefined;
}

/**
 * Wrap a `fetch` so a 429 is retried for every method, and a 502, 503, 504 or
 * network error for GET, HEAD, PUT and DELETE only. The wait is `Retry-After`
 * (seconds or an HTTP date) when present, else exponential backoff with full
 * jitter. A daily-limit 429, a `Retry-After` longer than `maxDelayMs`, any
 * other status, and a body other than a string or none are never retried.
 * Once `init.signal` aborts no retry starts, and an abort during the wait
 * rejects with the signal's reason.
 *
 * @param fetchImpl - The `fetch` to wrap.
 * @param options - Attempts, backoff, and injectable `sleep`/`random`/`now`.
 * @returns A `fetch` that returns the last response, or throws the last error.
 * @throws The signal's reason when `init.signal` aborts during a wait.
 * @throws RangeError when `maxAttempts` is not a positive integer.
 */
export function withRetry(fetchImpl: FetchLike, options: RetryOptions = {}): FetchLike {
  const settings = resolveRetrySettings(options);
  return async (input, init) => {
    const replayable = isReplayable(input, init);
    const idempotent = IDEMPOTENT_METHODS.has(methodOf(input, init));
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await settle(fetchImpl, input, init);
      const context = { settings, attempt, idempotent, init };
      const final = !replayable || attempt >= settings.maxAttempts;
      const wait = final ? undefined : retryDelay(outcome, context);
      if (wait === undefined) {
        return finish(outcome);
      }
      if ("response" in outcome) {
        await outcome.response.body?.cancel();
      }
      await sleepUnlessAborted(settings.sleep(wait), init?.signal);
    }
  };
}

function resolveRetrySettings(options: RetryOptions): RetrySettings {
  const maxAttempts = options.maxAttempts ?? 4;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${maxAttempts}.`);
  }
  return {
    maxAttempts,
    baseDelayMs: options.baseDelayMs ?? 500,
    maxDelayMs: options.maxDelayMs ?? 15_000,
    sleep: options.sleep ?? ((ms) => delay(ms)),
    random: options.random ?? Math.random,
    now: options.now ?? Date.now,
  };
}

function methodOf(input: Input, init: RequestInit | undefined): string {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  return method.toUpperCase();
}

/** Only a string body, or none, can be sent again; a stream is spent after one send. */
function isReplayable(input: Input, init: RequestInit | undefined): boolean {
  if (input instanceof Request && input.body !== null) {
    return false;
  }
  const body = init?.body;
  return body === undefined || body === null || typeof body === "string";
}

async function settle(
  fetchImpl: FetchLike,
  input: Input,
  init: RequestInit | undefined,
): Promise<Outcome> {
  try {
    return { response: await fetchImpl(input, init) };
  } catch (error: unknown) {
    return { error };
  }
}

/** The wait before the next attempt, or `undefined` when this outcome is final. */
function retryDelay(outcome: Outcome, context: AttemptContext): number | undefined {
  if (context.init?.signal?.aborted) {
    return undefined;
  }
  if ("error" in outcome) {
    return context.idempotent ? backoff(context) : undefined;
  }
  const { response } = outcome;
  if (!isRetryableStatus(response, context.idempotent)) {
    return undefined;
  }
  const { now, maxDelayMs } = context.settings;
  const told = retryAfterMs(response, now);
  if (told === undefined) {
    return backoff(context);
  }
  return told <= maxDelayMs ? told : undefined;
}

function isRetryableStatus(response: Response, idempotent: boolean): boolean {
  if (response.status === RATE_LIMITED) {
    return !isDailyLimit(response);
  }
  return idempotent && UNAVAILABLE_STATUSES.has(response.status);
}

/** Wait for `sleeping`, rejecting with the signal's reason if it aborts first. */
async function sleepUnlessAborted(
  sleeping: Promise<void>,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (!signal) {
    return sleeping;
  }
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([sleeping, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function isDailyLimit(response: Response): boolean {
  const remaining = response.headers.get(DAILY_REMAINING_HEADER);
  return (
    response.status === RATE_LIMITED && remaining !== null && Number(remaining) <= 0
  );
}

/** `Retry-After` in milliseconds, from delta-seconds or an HTTP date. */
function retryAfterMs(response: Response, now: () => number): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now());
}

/** Full jitter: a random wait up to `base * 2^(attempt - 1)`, capped. */
function backoff({ settings, attempt }: AttemptContext): number {
  const ceiling = settings.baseDelayMs * 2 ** (attempt - 1);
  return Math.floor(settings.random() * Math.min(settings.maxDelayMs, ceiling));
}

function finish(outcome: Outcome): Response {
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.response;
}

/** Options for {@link createLimiter}. */
export interface LimiterOptions {
  /** Requests allowed in flight at once. Defaults to 8. */
  maxConcurrent?: number;
  /** Minimum milliseconds between request starts. Defaults to 100. */
  minIntervalMs?: number;
  /** Waits for the spacing; injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** The current time in epoch milliseconds; injectable for tests. */
  now?: () => number;
}

/** Caps concurrent tasks and spaces their starts. */
export interface Limiter {
  /** Run `task` once a slot is free and the spacing allows; resolves to its result. */
  schedule<T>(task: () => Promise<T>): Promise<T>;
}

/**
 * Create a limiter that runs at most `maxConcurrent` tasks at once and starts
 * them at least `minIntervalMs` apart, in arrival order. Share one per location.
 *
 * @param options - Concurrency, spacing, and injectable `sleep`/`now`.
 * @returns The limiter.
 * @throws RangeError when `maxConcurrent` is not a positive integer.
 */
export function createLimiter(options: LimiterOptions = {}): Limiter {
  const maxConcurrent = options.maxConcurrent ?? 8;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError(
      `maxConcurrent must be a positive integer, got ${maxConcurrent}.`,
    );
  }
  const minIntervalMs = options.minIntervalMs ?? 100;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const now = options.now ?? Date.now;
  const waiting: Array<() => void> = [];
  let active = 0;
  let nextStartAt = 0;

  const acquire = async (): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1;
    } else {
      // release() hands its slot straight to the first waiter.
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    const start = Math.max(now(), nextStartAt);
    nextStartAt = start + minIntervalMs;
    const wait = start - now();
    if (wait > 0) {
      await sleep(wait);
    }
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active -= 1;
    }
  };

  return {
    async schedule<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}

/**
 * Wrap a `fetch` so every request runs through `limiter`.
 *
 * @param fetchImpl - The `fetch` to wrap.
 * @param limiter - The limiter from {@link createLimiter}.
 * @returns A `fetch` that waits for a slot before sending.
 */
export function limitFetch(fetchImpl: FetchLike, limiter: Limiter): FetchLike {
  return (input, init) => limiter.schedule(() => fetchImpl(input, init));
}
