/** withRetry and the limiter: which outcomes retry, how long they wait, and the concurrency cap. */
import { describe, test } from "node:test";
import { expect } from "expect";

import type { FetchLike } from "../src/client/highlevel.ts";
import type { RetryOptions } from "../src/core/retry.ts";
import { createLimiter, limitFetch, withRetry } from "../src/core/retry.ts";

type Step = Response | Error;

const URL_ = "https://services.leadconnectorhq.com/contacts/";
const POST = { method: "POST", body: '{"a":1}' };

const status = (code: number, headers: Record<string, string> = {}): Response =>
  new Response(null, { status: code, headers });

/** The result of a request that was sent once and not retried. */
const once = (code: number) => ({ status: code, calls: 1, waits: [] });

/** A fetch answering each call with the next step (the last repeats), counting calls. */
function scripted(steps: Step[]): { fetchImpl: FetchLike; calls: () => number } {
  let calls = 0;
  const fetchImpl: FetchLike = () => {
    const step = steps[Math.min(calls, steps.length - 1)] ?? status(200);
    calls += 1;
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step);
  };
  return { fetchImpl, calls: () => calls };
}

/** A sleep that records its waits and returns at once. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: (ms) => (waits.push(ms), Promise.resolve()) };
}

/** Send one request through withRetry over `steps`. */
async function run(
  steps: Step[],
  { init, ...options }: RetryOptions & { init?: RequestInit } = {},
) {
  const { fetchImpl, calls } = scripted(steps);
  const { sleep, waits } = recordingSleep();
  const response = await withRetry(fetchImpl, { sleep, ...options })(URL_, init);
  return { status: response.status, calls: calls(), waits };
}

describe("withRetry", () => {
  test("retries a 429 and honours Retry-After seconds", async () => {
    const result = await run([status(429, { "Retry-After": "3" }), status(200)]);
    expect(result).toEqual({ status: 200, calls: 2, waits: [3000] });
  });

  test("honours Retry-After as an HTTP date", async () => {
    const now = Date.parse("2026-10-07T12:00:00Z");
    const retryAfter = { "Retry-After": new Date(now + 7000).toUTCString() };
    const result = await run([status(503, retryAfter), status(200)], {
      now: () => now,
    });
    expect(result.waits).toEqual([7000]);
  });

  test("backs off exponentially with full jitter, capped", async () => {
    const options = { random: () => 0.5, maxAttempts: 7, maxDelayMs: 4000 };
    const result = await run([status(502)], options);
    expect(result.waits).toEqual([250, 500, 1000, 2000, 2000, 2000]);
  });

  test("returns the last response once max attempts are used", async () => {
    const result = await run([status(504)], { random: () => 0 });
    expect(result).toEqual({ status: 504, calls: 4, waits: [0, 0, 0] });
  });

  test("does not retry a 429 when the daily limit is exhausted", async () => {
    const daily = { "x-ratelimit-daily-remaining": "0", "Retry-After": "1" };
    expect(await run([status(429, daily), status(200)])).toEqual(once(429));
  });

  for (const code of [500, 400, 401, 404, 422]) {
    test(`does not retry a ${code}`, async () => {
      expect(await run([status(code), status(200)])).toEqual(once(code));
    });
  }

  test("retries a network error for GET", async () => {
    const result = await run([new TypeError("fetch failed"), status(200)]);
    expect(result).toMatchObject({ status: 200, calls: 2 });
  });

  test("does not retry a network error for POST", async () => {
    const sent = run([new TypeError("fetch failed"), status(200)], { init: POST });
    await expect(sent).rejects.toThrow("fetch failed");
  });

  test("retries a 429 for a POST with a string body", async () => {
    expect((await run([status(429), status(201)], { init: POST })).status).toBe(201);
  });

  for (const code of [502, 503, 504]) {
    test(`does not retry a ${code} for a POST (it may have been processed)`, async () => {
      expect(await run([status(code), status(201)], { init: POST })).toEqual(
        once(code),
      );
    });
  }

  test("does not retry once the signal is aborted", async () => {
    const init = { signal: AbortSignal.abort() };
    expect(await run([status(429), status(200)], { init })).toEqual(once(429));
  });

  test("stops waiting when the signal aborts during the sleep", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = scripted([status(429), status(200)]);
    const sleep = () => (
      controller.abort(new Error("gave up")),
      new Promise<void>(() => {})
    );
    const sent = withRetry(fetchImpl, { sleep })(URL_, { signal: controller.signal });
    await expect(sent).rejects.toThrow("gave up");
    expect(calls()).toBe(1);
  });

  test("gives up when Retry-After is longer than maxDelayMs", async () => {
    const retryAfter = { "Retry-After": "20" };
    const result = await run([status(429, retryAfter), status(200)], {
      maxDelayMs: 15_000,
    });
    expect(result).toEqual(once(429));
  });

  test("does not retry when the body cannot be sent twice", async () => {
    const init = { method: "PUT", body: new Uint8Array([1, 2]) };
    expect(await run([status(429), status(200)], { init })).toEqual(once(429));
  });
});

/** Let pending promise callbacks run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("createLimiter", () => {
  test("caps the requests in flight", async () => {
    const pending: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: FetchLike = () =>
      new Promise((resolve) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        pending.push(() => ((inFlight -= 1), resolve(status(200))));
      });
    const limiter = createLimiter({ maxConcurrent: 2, minIntervalMs: 0 });
    const limited = limitFetch(fetchImpl, limiter);

    const all = Promise.all(Array.from({ length: 5 }, () => limited(URL_)));
    await flush();
    expect(inFlight).toBe(2);
    while (pending.length > 0) {
      pending.shift()?.();
      await flush();
    }
    expect((await all).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(peak).toBe(2);
  });

  test("spaces request starts by minIntervalMs", async () => {
    const { sleep, waits } = recordingSleep();
    const limiter = createLimiter({ minIntervalMs: 100, sleep, now: () => 1000 });
    const limited = limitFetch(() => Promise.resolve(status(200)), limiter);
    await Promise.all([limited(URL_), limited(URL_), limited(URL_)]);
    expect(waits).toEqual([100, 200]);
  });

  test("composes with withRetry", async () => {
    const { fetchImpl, calls } = scripted([status(429), status(200)]);
    const limited = limitFetch(fetchImpl, createLimiter({ minIntervalMs: 0 }));
    const response = await withRetry(limited, recordingSleep())(URL_);
    expect([response.status, calls()]).toEqual([200, 2]);
  });
});
