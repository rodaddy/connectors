/** Contact tasks: request shape per operation, parsing, malformed responses, write guard. */
import { describe, test } from "node:test";
import { expect } from "expect";

import { createClient, type AccountClient } from "../src/accounts.ts";
import { HighLevelShapeError } from "../src/crm/shape.ts";
import {
  completeTask,
  createTask,
  deleteTask,
  listTasks,
  updateTask,
} from "../src/crm/tasks.ts";

interface Seen {
  method?: string;
  url?: URL;
  version?: string | null;
  body?: unknown;
}

const TASK = { id: "t1", title: "Call back", completed: false, contactId: "c1" };

function stub(
  reply: unknown,
  allowWrites = true,
): { client: AccountClient; seen: Seen } {
  const seen: Seen = {};
  const client = createClient({
    account: "primary",
    token: "pit-test",
    allowWrites,
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      seen.method = request.method;
      seen.url = new URL(request.url);
      seen.version = request.headers.get("Version");
      const text = await request.text();
      seen.body = text ? JSON.parse(text) : undefined;
      return Response.json(reply);
    },
  });
  return { client, seen };
}

void describe("tasks", () => {
  void test("listTasks GETs the contact's tasks and parses them", async () => {
    const { client, seen } = stub({
      tasks: [
        { ...TASK, body: "b", dueDate: "2026-10-08T00:00:00Z", assignedTo: "u1" },
      ],
    });
    const tasks = await listTasks(client, "c1");
    expect(seen.method).toBe("GET");
    expect(`${seen.url?.pathname}${seen.url?.search}`).toBe("/contacts/c1/tasks");
    expect(seen.version).toBe("2021-07-28");
    expect(tasks).toEqual([
      { ...TASK, body: "b", dueDate: "2026-10-08T00:00:00Z", assignedTo: "u1" },
    ]);
  });

  void test("createTask POSTs completed:false by default and parses the task", async () => {
    const { client, seen } = stub({
      task: { id: "t1", title: "Call back", completed: false },
    });
    const task = await createTask(client, {
      contactId: "c1",
      title: "Call back",
      dueDate: "2026-10-08T00:00:00Z",
    });
    expect(seen.method).toBe("POST");
    expect(seen.url?.pathname).toBe("/contacts/c1/tasks");
    expect(seen.version).toBe("2021-07-28");
    expect(seen.body).toEqual({
      title: "Call back",
      dueDate: "2026-10-08T00:00:00Z",
      completed: false,
    });
    expect(task).toEqual(TASK);
  });

  void test("updateTask PUTs only the given fields", async () => {
    const { client, seen } = stub({ task: { ...TASK, title: "New" } });
    const task = await updateTask(client, {
      contactId: "c1",
      taskId: "t1",
      title: "New",
    });
    expect(seen.method).toBe("PUT");
    expect(seen.url?.pathname).toBe("/contacts/c1/tasks/t1");
    expect(seen.version).toBe("2021-07-28");
    expect(seen.body).toEqual({ title: "New" });
    expect(task.title).toBe("New");
  });

  void test("completeTask PUTs the completed flag", async () => {
    const { client, seen } = stub({ task: { ...TASK, completed: true } });
    const task = await completeTask(client, {
      contactId: "c1",
      taskId: "t1",
      completed: true,
    });
    expect(seen.method).toBe("PUT");
    expect(seen.url?.pathname).toBe("/contacts/c1/tasks/t1/completed");
    expect(seen.version).toBe("2021-07-28");
    expect(seen.body).toEqual({ completed: true });
    expect(task.completed).toBe(true);
  });

  void test("deleteTask DELETEs the task", async () => {
    const { client, seen } = stub({ succeded: true });
    expect(await deleteTask(client, { contactId: "c1", taskId: "t1" })).toBe(true);
    expect(seen.method).toBe("DELETE");
    expect(seen.url?.pathname).toBe("/contacts/c1/tasks/t1");
    expect(seen.version).toBe("2021-07-28");
    expect(seen.body).toBeUndefined();
  });

  void test("deleteTask rejects a reply without a succeded flag", async () => {
    const { client } = stub({});
    await expect(deleteTask(client, { contactId: "c1", taskId: "t1" })).rejects.toThrow(
      HighLevelShapeError,
    );
  });

  void test("a task without a completed flag throws HighLevelShapeError", async () => {
    const { client } = stub({ tasks: [{ id: "t1", title: "x" }] });
    await expect(listTasks(client, "c1")).rejects.toThrow(HighLevelShapeError);
  });

  void test("a write without allowWrites is blocked before fetch", async () => {
    const { client, seen } = stub({ task: TASK }, false);
    await expect(deleteTask(client, { contactId: "c1", taskId: "t1" })).rejects.toThrow(
      "Blocked DELETE request in read-only mode",
    );
    expect(seen.method).toBeUndefined();
  });
});
