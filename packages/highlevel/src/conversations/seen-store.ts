/**
 * Message-id dedupe for the inbound poll, so a message is handled once.
 *
 * @module
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Remembers which message ids were already handled. Methods may be sync or async. */
export interface SeenStore {
  has(id: string): boolean | Promise<boolean>;
  add(id: string): void | Promise<void>;
}

/** A {@link SeenStore} that lives only as long as the process. */
export class MemorySeenStore implements SeenStore {
  readonly #ids = new Set<string>();

  /** @returns Whether `id` was added before. */
  has(id: string): boolean {
    return this.#ids.has(id);
  }

  /** Remember `id`. */
  add(id: string): void {
    this.#ids.add(id);
  }
}

/** A {@link SeenStore} in a SQLite file (Node's built-in `node:sqlite`). Ids only, never bodies. */
export class SqliteSeenStore implements SeenStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;

  /**
   * @param path - The database file; its directory is created if missing.
   * @param now - Clock for `first_seen_at`, in epoch milliseconds (UTC instant).
   */
  constructor(path: string, now: () => number = Date.now) {
    this.#now = now;
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(
      "CREATE TABLE IF NOT EXISTS seen (message_id TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL)",
    );
  }

  /** @returns Whether `id` was added before. */
  has(id: string): boolean {
    const row = this.#db.prepare("SELECT 1 FROM seen WHERE message_id = ?").get(id);
    return row !== undefined;
  }

  /** Remember `id`; adding it again is a no-op. */
  add(id: string): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO seen (message_id, first_seen_at) VALUES (?, ?)")
      .run(id, new Date(this.#now()).toISOString());
  }

  /** Close the database file. */
  close(): void {
    this.#db.close();
  }
}
