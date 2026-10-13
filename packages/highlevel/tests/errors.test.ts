/** The error classifier, HighLevelApiError.kind, and the tryRequest adapter. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { AccountMismatchError, createClient } from "../src/accounts.ts";
import { HighLevelApiError, HighLevelClient } from "../src/client/highlevel.ts";
import { classifyError, HighLevelTimeoutError } from "../src/core/errors.ts";
import { tryRequest } from "../src/core/result.ts";

const JSON_TYPE = "application/json";
const CLOUDFLARE_PAGE =
  "<!DOCTYPE html><html><title>Access denied | Cloudflare</title><p>error code: 1010</p></html>";

describe("classifyError", () => {
  const cases = [
    {
      status: 403,
      body: CLOUDFLARE_PAGE,
      type: "text/html; charset=UTF-8",
      kind: "cloudflare",
    },
    {
      status: 401,
      body: '{"message":"The token is not authorized for this scope."}',
      type: JSON_TYPE,
      kind: "scope",
    },
    { status: 401, body: '{"message":"Invalid JWT"}', type: JSON_TYPE, kind: "auth" },
    { status: 403, body: "", type: null, kind: "auth" },
    {
      status: 404,
      body: '{"message":"Contact not found"}',
      type: JSON_TYPE,
      kind: "not-found",
    },
    {
      status: 400,
      body: '{"error":"Bad Request"}',
      type: JSON_TYPE,
      kind: "validation",
    },
    {
      status: 429,
      body: '{"message":"Too many requests"}',
      type: JSON_TYPE,
      kind: "rate-limit",
    },
    { status: 502, body: "Bad gateway", type: "text/plain", kind: "server" },
    { status: 418, body: "", type: null, kind: "unknown" },
  ] as const;

  for (const { status, body, type, kind } of cases) {
    test(`${status} ${type ?? "(no type)"} is ${kind}`, () => {
      expect(classifyError(status, body, type).kind).toBe(kind);
    });
  }

  test("a 422 joins a message array", () => {
    const body =
      '{"message":["email must be an email","phone is invalid"],"statusCode":422}';
    expect(classifyError(422, body, JSON_TYPE)).toEqual({
      kind: "validation",
      message:
        "HighLevel rejected the request as invalid (status 422): email must be an email; phone is invalid",
    });
  });

  test("reads `errors` objects when there is no message", () => {
    const body = '{"errors":[{"message":"name is required"}]}';
    expect(classifyError(400, body, JSON_TYPE).message).toBe(
      "HighLevel rejected the request as invalid (status 400): name is required",
    );
  });

  test("a Cloudflare page gets the fixed message, not the HTML", () => {
    expect(classifyError(403, CLOUDFLARE_PAGE, "text/html").message).toBe(
      "Cloudflare blocked the request before it reached HighLevel (status 403).",
    );
  });
});

/** A client whose fetch answers with `response`, counting calls. */
function answering(response: () => Response): {
  client: HighLevelClient;
  calls: number[];
} {
  const calls: number[] = [];
  const client = new HighLevelClient({
    token: "test-token",
    fetchImpl: () => {
      calls.push(1);
      return Promise.resolve(response());
    },
  });
  return { client, calls };
}

describe("tryRequest", () => {
  test("returns ok with the status and data on a 2xx", async () => {
    const { client } = answering(() => Response.json({ id: "c1" }, { status: 201 }));
    expect(await tryRequest(client, "/contacts/c1")).toEqual({
      ok: true,
      status: 201,
      data: { id: "c1" },
    });
  });

  test("returns the classified error instead of throwing on a non-2xx", async () => {
    const body = '{"message":"Contact not found"}';
    const { client } = answering(
      () => new Response(body, { status: 404, headers: { "content-type": JSON_TYPE } }),
    );
    const result = await tryRequest(client, "/contacts/missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.error).toBeInstanceOf(HighLevelApiError);
    expect(result.error).toMatchObject({
      kind: "not-found",
      message: "HighLevel found nothing at this path (status 404): Contact not found",
      responseBody: body,
    });
  });

  test("a timeout still throws", async () => {
    const client = new HighLevelClient({
      token: "test-token",
      timeoutMs: 10,
      fetchImpl: () => new Promise<Response>(() => undefined),
    });
    await expect(tryRequest(client, "/contacts/slow")).rejects.toBeInstanceOf(
      HighLevelTimeoutError,
    );
  });

  test("an account client keeps its guard through the adapter", async () => {
    const calls: number[] = [];
    const client = createClient({
      account: "primary",
      token: "pit-test",
      fetchImpl: () => {
        calls.push(1);
        return Promise.resolve(Response.json({}));
      },
    });
    await expect(
      tryRequest(client, "/locations/SecondaryLocation001"),
    ).rejects.toBeInstanceOf(AccountMismatchError);
    expect(calls).toHaveLength(0);
  });
});
