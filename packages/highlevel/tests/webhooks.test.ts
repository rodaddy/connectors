/** Webhook verification: Ed25519 first, legacy RSA opt-in, freshness, replay. */
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, test } from "node:test";
import { expect } from "expect";

import {
  createMemoryReplayStore,
  verifyWebhook,
  type VerifyWebhookOptions,
} from "../src/webhooks/verify.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const ed = generateKeyPairSync("ed25519");
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeys = {
  ed25519: ed.publicKey.export({ format: "pem", type: "spki" }).toString(),
  rsa: rsa.publicKey.export({ format: "pem", type: "spki" }).toString(),
};

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "ContactCreate",
    locationId: "loc-test",
    timestamp: "2026-10-07T11:58:00Z",
    webhookId: "wh-1",
    id: "contact-test",
    ...overrides,
  });
}

function edSign(raw: string): string {
  return sign(null, Buffer.from(raw), ed.privateKey).toString("base64");
}

function rsaSign(raw: string): string {
  return sign("sha256", Buffer.from(raw), rsa.privateKey).toString("base64");
}

function run(raw: string, extra: Partial<VerifyWebhookOptions>) {
  return verifyWebhook({
    rawBody: raw,
    headers: {},
    now: () => NOW,
    publicKeys,
    ...extra,
  });
}

void describe("verifyWebhook", () => {
  void test("accepts a good Ed25519 delivery and parses the envelope", async () => {
    const raw = body();
    const result = await run(raw, {
      rawBody: new TextEncoder().encode(raw),
      headers: { "X-GHL-Signature": edSign(raw) },
    });
    expect(result).toEqual({
      ok: true,
      scheme: "ed25519",
      event: {
        type: "ContactCreate",
        locationId: "loc-test",
        timestamp: "2026-10-07T11:58:00Z",
        webhookId: "wh-1",
        data: { id: "contact-test" },
      },
    });
  });

  void test("accepts the raw 32-byte Ed25519 key in base64", async () => {
    const der = ed.publicKey.export({ format: "der", type: "spki" });
    const raw = body();
    const result = await run(raw, {
      headers: { "x-ghl-signature": edSign(raw) },
      publicKeys: { ed25519: der.subarray(12).toString("base64") },
    });
    expect(result.ok).toBe(true);
  });

  void test("rejects a tampered body as bad-signature", async () => {
    const signature = edSign(body());
    const result = await run(body({ id: "other" }), {
      headers: { "x-ghl-signature": signature },
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  void test("rejects a missing or empty signature header", async () => {
    expect(await run(body(), {})).toEqual({ ok: false, reason: "missing-signature" });
    expect(await run(body(), { headers: { "x-ghl-signature": " " } })).toEqual({
      ok: false,
      reason: "missing-signature",
    });
  });

  void test("rejects stale, far-future and timestamp-less deliveries", async () => {
    for (const timestamp of [
      "2026-10-07T11:54:59Z",
      "2026-10-07T12:05:01Z",
      undefined,
    ]) {
      const raw = body({ timestamp });
      const result = await run(raw, { headers: { "x-ghl-signature": edSign(raw) } });
      expect(result).toEqual({ ok: false, reason: "stale" });
    }
    const raw = body({ timestamp: "2026-10-07T11:00:00Z" });
    const wide = await run(raw, {
      headers: { "x-ghl-signature": edSign(raw) },
      maxAgeMs: 2 * 60 * 60 * 1000,
    });
    expect(wide.ok).toBe(true);
  });

  void test("rejects a replayed webhookId, and remembers only after passing", async () => {
    const replayStore = createMemoryReplayStore(() => NOW);
    const raw = body();
    const options = { headers: { "x-ghl-signature": edSign(raw) }, replayStore };
    const bad = await run(raw, {
      ...options,
      headers: { "x-ghl-signature": edSign("x") },
    });
    expect(bad).toEqual({ ok: false, reason: "bad-signature" });
    expect((await run(raw, options)).ok).toBe(true);
    expect(await run(raw, options)).toEqual({ ok: false, reason: "replayed" });
  });

  void test("refuses a delivery with no webhookId when a replay store is set", async () => {
    const raw = body({ webhookId: undefined });
    const result = await run(raw, {
      headers: { "x-ghl-signature": edSign(raw) },
      replayStore: createMemoryReplayStore(() => NOW),
    });
    expect(result).toEqual({ ok: false, reason: "malformed" });
  });

  void test("memory replay store forgets an id after its ttl", async () => {
    let clock = 0;
    const store = createMemoryReplayStore(() => clock);
    expect(await store.rememberIfNew("wh-1", 10)).toBe(true);
    expect(await store.rememberIfNew("wh-1", 10)).toBe(false);
    clock = 10;
    expect(await store.rememberIfNew("wh-1", 10)).toBe(true);
  });

  void test("legacy RSA is refused by default and verified when allowed", async () => {
    const raw = body();
    const headers = { "x-wh-signature": rsaSign(raw) };
    expect(await run(raw, { headers })).toEqual({
      ok: false,
      reason: "missing-signature",
    });
    const allowed = await run(raw, { headers, allowLegacyRsa: true });
    expect(allowed).toMatchObject({ ok: true, scheme: "rsa" });
    const forged = await run(raw, {
      headers: { "x-wh-signature": edSign(raw) },
      allowLegacyRsa: true,
    });
    expect(forged).toEqual({ ok: false, reason: "bad-signature" });
  });

  void test("legacy RSA defaults to GHL's published key", async () => {
    const raw = body();
    const result = await run(raw, {
      headers: { "x-wh-signature": rsaSign(raw) },
      allowLegacyRsa: true,
      publicKeys: {},
    });
    expect(result).toEqual({ ok: false, reason: "bad-signature" });
  });

  void test("rejects signed but malformed JSON or a body without a type", async () => {
    for (const raw of ["{not json", "[]", JSON.stringify({ timestamp: "x" })]) {
      const result = await run(raw, { headers: { "x-ghl-signature": edSign(raw) } });
      expect(result).toEqual({ ok: false, reason: "malformed" });
    }
  });

  void test("throws when an Ed25519 delivery arrives with no Ed25519 key", async () => {
    const raw = body();
    await expect(
      run(raw, { headers: { "x-ghl-signature": edSign(raw) }, publicKeys: {} }),
    ).rejects.toThrow("publicKeys.ed25519");
  });

  void test("two concurrent deliveries of one webhookId: exactly one passes", async () => {
    const replayStore = createMemoryReplayStore(() => NOW);
    const raw = body();
    const options = { headers: { "x-ghl-signature": edSign(raw) }, replayStore };
    const results = await Promise.all([run(raw, options), run(raw, options)]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: "replayed" });
  });

  void test("falls back to legacy RSA when no Ed25519 key is set and RSA is allowed", async () => {
    const raw = body();
    const headers = { "x-ghl-signature": edSign(raw), "x-wh-signature": rsaSign(raw) };
    const rsaOnly = { rsa: publicKeys.rsa };
    const result = await run(raw, {
      headers,
      allowLegacyRsa: true,
      publicKeys: rsaOnly,
    });
    expect(result).toMatchObject({ ok: true, scheme: "rsa" });
    await expect(run(raw, { headers, publicKeys: rsaOnly })).rejects.toThrow(
      "publicKeys.ed25519",
    );
  });
});
