/** Contact notes: request shape, Version, parsing, relations (D8), and guards. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { type AccountClient, createClient } from "../src/accounts.ts";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
} from "../src/crm/notes.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";

interface Seen {
  method?: string;
  url?: URL;
  version?: string | null;
  body?: unknown;
  calls: number;
  /** `METHOD /path` for every request, in order. */
  lines: string[];
}

const NOTE = {
  id: "n1",
  body: "<p>Hi</p>",
  bodyText: "Hi",
  contactId: "c1",
  dateAdded: "2026-10-07T00:00:00.000Z",
  pinned: false,
  userId: "u1",
  relations: [
    { objectKey: "opportunity", recordId: "o1" },
    { objectKey: "task", recordId: "t1" },
  ],
};

function client(seen: Seen, reply: unknown, allowWrites = true): AccountClient {
  return createClient({
    account: "primary",
    token: "pit-test",
    allowWrites,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      seen.calls += 1;
      seen.lines.push(`${request.method} ${new URL(request.url).pathname}`);
      seen.method = request.method;
      seen.url = new URL(request.url);
      seen.version = request.headers.get("Version");
      const text = await request.text();
      seen.body = text ? JSON.parse(text) : undefined;
      return Response.json(reply);
    },
  });
}

function fresh(): Seen {
  return { calls: 0, lines: [] };
}

function expectRequest(seen: Seen, method: string, path: string): void {
  expect([seen.method, seen.url?.pathname, seen.version]).toEqual([
    method,
    path,
    "2021-07-28",
  ]);
}

describe("listNotes", () => {
  test("GETs the contact's notes and parses relations", async () => {
    const seen = fresh();
    const notes = await listNotes(client(seen, { notes: [NOTE] }), "c 1");
    expectRequest(seen, "GET", "/contacts/c%201/notes");
    expect(seen.url?.search).toBe("");
    expect(seen.body).toBeUndefined();
    expect(notes).toEqual([{ ...NOTE, opportunityIds: ["o1"] }]);
  });

  test("throws HighLevelShapeError on a malformed response", async () => {
    const reply = { notes: [{ id: "n1", body: "x" }] };
    await expect(listNotes(client(fresh(), reply), "c1")).rejects.toThrow(
      HighLevelShapeError,
    );
  });
});

describe("getNote", () => {
  test("GETs one note; a note without relations has empty lists", async () => {
    const seen = fresh();
    const reply = { note: { id: "n1", contactId: "c1", body: "b" } };
    const note = await getNote(client(seen, reply), { contactId: "c1", noteId: "n1" });
    expectRequest(seen, "GET", "/contacts/c1/notes/n1");
    expect(note).toEqual({ ...reply.note, opportunityIds: [], relations: [] });
  });
});

describe("createNote", () => {
  test("POSTs body, userId and an opportunity relation", async () => {
    const seen = fresh();
    const note = await createNote(client(seen, { note: NOTE }), {
      contactId: "c1",
      body: "Hi",
      opportunityId: "o1",
      userId: "u1",
    });
    expectRequest(seen, "POST", "/contacts/c1/notes");
    expect(seen.body).toEqual({
      body: "Hi",
      userId: "u1",
      relations: [{ objectKey: "opportunity", recordId: "o1" }],
    });
    expect(note.opportunityIds).toEqual(["o1"]);
  });

  test("sends no relations without an opportunity", async () => {
    const seen = fresh();
    await createNote(client(seen, { note: NOTE }), { contactId: "c1", body: "Hi" });
    expect(seen.body).toEqual({ body: "Hi" });
  });

  test("a blank body throws before fetch", async () => {
    const seen = fresh();
    await expect(
      createNote(client(seen, { note: NOTE }), { contactId: "c1", body: "  \n" }),
    ).rejects.toThrow("A note body must not be blank.");
    expect(seen.calls).toBe(0);
  });

  test("is blocked before fetch without allowWrites", async () => {
    const seen = fresh();
    await expect(
      createNote(client(seen, { note: NOTE }, false), { contactId: "c1", body: "Hi" }),
    ).rejects.toThrow("Blocked POST request in read-only mode.");
    expect(seen.calls).toBe(0);
  });
});

describe("updateNote", () => {
  const ref = { contactId: "c1", noteId: "n1", body: "New" };

  test("PUTs the body and keeps relations when opportunityId is undefined", async () => {
    const seen = fresh();
    await updateNote(client(seen, { note: NOTE }), ref);
    expectRequest(seen, "PUT", "/contacts/c1/notes/n1");
    expect(seen.body).toEqual({ body: "New" });
  });

  test("null clears the opportunity link and keeps the task relation", async () => {
    const cleared = fresh();
    await updateNote(client(cleared, { note: NOTE }), { ...ref, opportunityId: null });
    expect(cleared.lines).toEqual([
      "GET /contacts/c1/notes/n1",
      "PUT /contacts/c1/notes/n1",
    ]);
    expect(cleared.body).toEqual({
      body: "New",
      relations: [{ objectKey: "task", recordId: "t1" }],
    });
  });

  test("a string replaces the opportunity link and keeps the task relation", async () => {
    const linked = fresh();
    await updateNote(client(linked, { note: NOTE }), { ...ref, opportunityId: "o2" });
    expect(linked.body).toEqual({
      body: "New",
      relations: [
        { objectKey: "task", recordId: "t1" },
        { objectKey: "opportunity", recordId: "o2" },
      ],
    });
  });
});

describe("deleteNote", () => {
  const ref = { contactId: "c1", noteId: "n1" };

  test("DELETEs and reads GHL's succeded spelling", async () => {
    const seen = fresh();
    expect(await deleteNote(client(seen, { succeded: true }), ref)).toBe(true);
    expectRequest(seen, "DELETE", "/contacts/c1/notes/n1");
  });

  test("also accepts succeeded, and rejects a missing flag", async () => {
    expect(await deleteNote(client(fresh(), { succeeded: false }), ref)).toBe(false);
    await expect(deleteNote(client(fresh(), {}), ref)).rejects.toThrow(
      HighLevelShapeError,
    );
  });
});
