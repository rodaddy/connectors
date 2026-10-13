/** Token stores: memory, the atomic 0600 file store, and the refreshing provider. */
import { after, describe, test } from "node:test";
import { expect } from "expect";
import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { OAuthTokens } from "../src/oauth/oauth.ts";
import {
  FileTokenStore,
  MemoryTokenStore,
  TokenFileModeError,
  tokenProviderFrom,
} from "../src/oauth/token-store.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";

// HIGHLEVEL_TEST_TMP overrides the root; the fallback is the package's gitignored .test-tmp/.
const ROOT = join(
  process.env.HIGHLEVEL_TEST_TMP ?? join(import.meta.dirname, "../.test-tmp"),
  `token-store-${randomUUID()}`,
);
after(() => rm(ROOT, { recursive: true, force: true }));

function tokens(expiresInMs: number, suffix = "1"): OAuthTokens {
  return {
    accessToken: `fake-access-${suffix}`,
    refreshToken: `fake-refresh-${suffix}`,
    expiresAt: Date.now() + expiresInMs,
    scope: "contacts.readonly",
    userType: "Location",
    locationId: "loc-1",
  };
}

async function freshDir(): Promise<string> {
  const dir = join(ROOT, randomUUID());
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("MemoryTokenStore", () => {
  test("gets, sets and deletes by key", async () => {
    const store = new MemoryTokenStore();
    const value = tokens(3_600_000);
    await store.set("loc-1", value);
    expect(await store.get("loc-1")).toEqual(value);
    await store.delete("loc-1");
    expect(await store.get("loc-1")).toBeUndefined();
  });
});

describe("FileTokenStore", () => {
  test("round-trips keys in a 0600 file and leaves no temp file", async () => {
    const dir = await freshDir();
    const path = join(dir, "tokens.json");
    const store = new FileTokenStore(path);
    expect(await store.get("loc-1")).toBeUndefined();
    await Promise.all([
      store.set("loc-1", tokens(1000)),
      store.set("loc-2", tokens(1000, "2")),
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["tokens.json"]);
    const reread = new FileTokenStore(path);
    expect((await reread.get("loc-2"))?.accessToken).toBe("fake-access-2");
    await reread.delete("loc-1");
    expect(await new FileTokenStore(path).get("loc-1")).toBeUndefined();
    expect(await new FileTokenStore(path).get("loc-2")).toBeDefined();
  });

  test("refuses to read a file wider than 0600", async () => {
    const path = join(await freshDir(), "tokens.json");
    await new FileTokenStore(path).set("loc-1", tokens(1000));
    await chmod(path, 0o644);
    await expect(new FileTokenStore(path).get("loc-1")).rejects.toThrow(
      TokenFileModeError,
    );
  });

  test("a corrupt entry throws HighLevelShapeError", async () => {
    const path = join(await freshDir(), "tokens.json");
    await writeFile(path, JSON.stringify({ "loc-1": { accessToken: "x" } }), {
      mode: 0o600,
    });
    await expect(new FileTokenStore(path).get("loc-1")).rejects.toThrow(
      HighLevelShapeError,
    );
  });
});

describe("tokenProviderFrom", () => {
  test("returns the stored token without refreshing while it is fresh", async () => {
    const store = new MemoryTokenStore();
    await store.set("loc-1", tokens(120_000));
    let refreshes = 0;
    const provider = tokenProviderFrom(store, "loc-1", () => {
      refreshes += 1;
      return Promise.resolve(tokens(3_600_000, "2"));
    });
    expect(await provider()).toBe("fake-access-1");
    expect(refreshes).toBe(0);
  });

  test("refreshes once within 60 s of expiry and saves the rotated tokens", async () => {
    const store = new MemoryTokenStore();
    await store.set("loc-1", tokens(30_000));
    const seen: string[] = [];
    const provider = tokenProviderFrom(store, "loc-1", (current) => {
      seen.push(current.refreshToken);
      return Promise.resolve(tokens(3_600_000, "2"));
    });
    expect(await Promise.all([provider(), provider()])).toEqual([
      "fake-access-2",
      "fake-access-2",
    ]);
    expect(await provider()).toBe("fake-access-2");
    expect(seen).toEqual(["fake-refresh-1"]);
    expect((await store.get("loc-1"))?.refreshToken).toBe("fake-refresh-2");
  });

  test("a read that raced a finished refresh does not refresh again", async () => {
    const inner = new MemoryTokenStore();
    const stale = tokens(30_000);
    await inner.set("loc-1", stale);
    let staleReads = 0;
    const store = {
      get: (key: string) =>
        staleReads-- > 0 ? Promise.resolve(stale) : inner.get(key),
      set: (key: string, value: OAuthTokens) => inner.set(key, value),
      delete: (key: string) => inner.delete(key),
    };
    let refreshes = 0;
    const provider = tokenProviderFrom(store, "loc-1", () => {
      refreshes += 1;
      return Promise.resolve(tokens(3_600_000, "2"));
    });
    expect(await provider()).toBe("fake-access-2");
    staleReads = 1;
    expect(await provider()).toBe("fake-access-2");
    expect(refreshes).toBe(1);
  });

  test("throws when nothing is stored for the key", async () => {
    const provider = tokenProviderFrom(new MemoryTokenStore(), "loc-9", () =>
      Promise.reject(new Error("unreachable")),
    );
    await expect(Promise.resolve(provider())).rejects.toThrow(
      "No OAuth tokens stored for loc-9.",
    );
  });
});
