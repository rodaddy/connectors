/**
 * Verify a GoHighLevel webhook delivery: signature, freshness, replay.
 *
 * Ed25519 on `x-ghl-signature` is the current scheme. RSA-SHA256 on
 * `x-wh-signature` is legacy (the official SDK marks it deprecated) and is
 * refused unless `allowLegacyRsa` is set. Both sign the raw request body.
 *
 * @module
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";

import { HighLevelShapeError } from "../crm/shape.ts";
import { parseWebhookEnvelope, type WebhookEnvelope } from "./events.ts";

/** The current signature header (Ed25519, base64). */
export const ED25519_SIGNATURE_HEADER = "x-ghl-signature";
/** The legacy signature header (RSA-SHA256, base64). */
export const RSA_SIGNATURE_HEADER = "x-wh-signature";
/**
 * GHL's published legacy RSA webhook key, copied from the pinned upstream docs
 * `highlevel-api-docs/docs/oauth/WebhookAuthentication.md:41-54` (an earlier integration's
 * `ghl-followup-auditor/src/config.ts:28-41` embeds the same key). The official
 * SDK ships NO Ed25519 key: it reads `options.publicKey` or the
 * `WEBHOOK_SIGNATURE_PUBLIC_KEY` env (`lib/webhook/webhook-manager.js:197-199`),
 * so the Ed25519 key is always the caller's to pass.
 */
export const GHL_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Remembers delivery ids so a replayed delivery is refused. */
export interface ReplayStore {
  /**
   * Atomically remember `id` for `ttlMs` unless it is already remembered and
   * unexpired (Redis `SET NX PX` semantics). Check and write must be one step:
   * a GHL retry racing the original must not see "new" twice.
   *
   * @returns `true` when `id` was new and is now remembered, `false` when it was already there.
   */
  rememberIfNew(id: string, ttlMs: number): boolean | Promise<boolean>;
}

/** Why a delivery was refused. */
export type WebhookRejection =
  "missing-signature" | "bad-signature" | "stale" | "replayed" | "malformed";

/** The outcome of {@link verifyWebhook}. */
export type WebhookVerification =
  | { ok: true; scheme: "ed25519" | "rsa"; event: WebhookEnvelope }
  | { ok: false; reason: WebhookRejection };

/** Input to {@link verifyWebhook}. */
export interface VerifyWebhookOptions {
  /** The body exactly as received; never a re-serialized parse. */
  rawBody: string | Uint8Array;
  /** Request headers; names are matched case-insensitively. */
  headers: Record<string, string | undefined>;
  /** Clock in epoch ms; defaults to `Date.now`. */
  now?: () => number;
  /** Oldest (or furthest-future) timestamp accepted; default 5 minutes. */
  maxAgeMs?: number;
  /** Accept the legacy RSA `x-wh-signature`; default false. */
  allowLegacyRsa?: boolean;
  /** Ed25519: PEM, or the raw 32-byte key (base64/hex). RSA: PEM, default {@link GHL_RSA_PUBLIC_KEY}. */
  publicKeys?: { ed25519?: string; rsa?: string };
  /** When given, a `webhookId` already seen is refused and new ones are remembered. */
  replayStore?: ReplayStore;
}

type Signed = { scheme: "ed25519" | "rsa"; signature: Buffer };

function header(
  headers: VerifyWebhookOptions["headers"],
  name: string,
): string | undefined {
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = match?.[1]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

// Ed25519 wins when its header is present, except when no Ed25519 key is
// configured and an allowed legacy RSA signature can be checked instead.
function pickSignature(options: VerifyWebhookOptions): Signed | undefined {
  const ed25519 = header(options.headers, ED25519_SIGNATURE_HEADER);
  const rsa =
    options.allowLegacyRsa === true
      ? header(options.headers, RSA_SIGNATURE_HEADER)
      : undefined;
  const hasEd25519Key = (options.publicKeys?.ed25519?.trim() ?? "") !== "";
  if (ed25519 !== undefined && (hasEd25519Key || rsa === undefined)) {
    return { scheme: "ed25519", signature: Buffer.from(ed25519, "base64") };
  }
  if (rsa === undefined) return undefined;
  return { scheme: "rsa", signature: Buffer.from(rsa, "base64") };
}

function ed25519Key(publicKey: string | undefined): KeyObject {
  const trimmed = publicKey?.trim();
  if (trimmed === undefined || trimmed === "") {
    throw new Error("An x-ghl-signature webhook needs publicKeys.ed25519.");
  }
  if (trimmed.includes("-----BEGIN")) return createPublicKey(trimmed);
  const raw = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (raw.length !== 32) {
    throw new Error("publicKeys.ed25519 must be PEM or a 32-byte key in base64/hex.");
  }
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

function checkSignature(
  body: Buffer,
  signed: Signed,
  keys: VerifyWebhookOptions["publicKeys"],
): boolean {
  // Key problems are configuration errors and throw. A signature of the wrong
  // length or encoding makes verify() return false, not throw.
  const key =
    signed.scheme === "ed25519"
      ? ed25519Key(keys?.ed25519)
      : createPublicKey(keys?.rsa ?? GHL_RSA_PUBLIC_KEY);
  const algorithm = signed.scheme === "ed25519" ? null : "sha256";
  return verify(algorithm, body, key, signed.signature);
}

const MALFORMED = [TypeError, SyntaxError, HighLevelShapeError];

function decode(body: Buffer): WebhookEnvelope | undefined {
  try {
    return parseWebhookEnvelope(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    );
  } catch (error: unknown) {
    // Bad UTF-8 (TypeError), bad JSON (SyntaxError), or no string `type`.
    if (MALFORMED.some((kind) => error instanceof kind)) return undefined;
    throw error;
  }
}

function isFresh(
  timestamp: string | undefined,
  now: number,
  maxAgeMs: number,
): boolean {
  // No parseable timestamp means freshness cannot be proven: refuse it.
  const at = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  return Number.isFinite(at) && Math.abs(now - at) <= maxAgeMs;
}

async function checkReplay(
  store: ReplayStore,
  webhookId: string | undefined,
  maxAgeMs: number,
): Promise<WebhookRejection | undefined> {
  if (webhookId === undefined) return "malformed";
  // A delivery past the freshness window is refused as stale, so the id only
  // has to outlive the window on either side of now.
  return (await store.rememberIfNew(webhookId, 2 * maxAgeMs)) ? undefined : "replayed";
}

/**
 * Verify one webhook delivery and parse its envelope. Order: signature over the
 * raw bytes, JSON shape, freshness, replay; an id is remembered only after the rest pass.
 *
 * @param options - The delivery and the verification policy.
 * @returns The scheme and envelope, or the reason it was refused.
 * @throws Error when an Ed25519 delivery arrives with no `publicKeys.ed25519`
 *   and no allowed legacy RSA signature to fall back to, or a configured key
 *   cannot be parsed.
 */
export async function verifyWebhook(
  options: VerifyWebhookOptions,
): Promise<WebhookVerification> {
  const body = Buffer.from(options.rawBody);
  const signed = pickSignature(options);
  if (signed === undefined) return { ok: false, reason: "missing-signature" };
  if (!checkSignature(body, signed, options.publicKeys)) {
    return { ok: false, reason: "bad-signature" };
  }
  const event = decode(body);
  if (event === undefined) return { ok: false, reason: "malformed" };
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!isFresh(event.timestamp, (options.now ?? Date.now)(), maxAgeMs)) {
    return { ok: false, reason: "stale" };
  }
  if (options.replayStore !== undefined) {
    const reason = await checkReplay(options.replayStore, event.webhookId, maxAgeMs);
    if (reason !== undefined) return { ok: false, reason };
  }
  return { ok: true, scheme: signed.scheme, event };
}

/** An in-process {@link ReplayStore}; several receivers need a shared one. `now` is epoch ms. */
export function createMemoryReplayStore(now: () => number = Date.now): ReplayStore {
  const expiries = new Map<string, number>();
  return {
    rememberIfNew(id, ttlMs) {
      const at = now();
      for (const [key, expiresAt] of expiries)
        if (expiresAt <= at) expiries.delete(key);
      if (expiries.has(id)) return false;
      expiries.set(id, at + ttlMs);
      return true;
    },
  };
}
