/** SeenStore: memory and SQLite remember ids; SQLite survives a reopen. */
import { after, describe, test } from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect } from "expect";

import {
  MemorySeenStore,
  SqliteSeenStore,
} from "../../src/conversations/seen-store.ts";

/** `HIGHLEVEL_TEST_TMP` when set, else the package's gitignored `.test-tmp/`. */
const ROOT =
  process.env["HIGHLEVEL_TEST_TMP"] ??
  join(import.meta.dirname, "..", "..", ".test-tmp");
const DIR = join(ROOT, `seen-store-${process.pid}`);

void describe("SeenStore", () => {
  after(() => rmSync(DIR, { recursive: true, force: true }));

  void test("MemorySeenStore remembers added ids", () => {
    const store = new MemorySeenStore();
    expect(store.has("m1")).toBe(false);
    store.add("m1");
    expect(store.has("m1")).toBe(true);
    expect(store.has("m2")).toBe(false);
  });

  void test("SqliteSeenStore persists ids across a reopen and ignores repeats", () => {
    mkdirSync(DIR, { recursive: true });
    const path = join(DIR, "nested", "seen.sqlite");
    const first = new SqliteSeenStore(path);
    expect(first.has("m1")).toBe(false);
    first.add("m1");
    first.add("m1");
    first.close();
    const second = new SqliteSeenStore(path);
    expect(second.has("m1")).toBe(true);
    expect(second.has("m2")).toBe(false);
    second.close();
  });
});
