/**
 * Contact tasks: list, create, update, complete and delete.
 *
 * @module
 */
import type { AccountClient } from "../accounts.ts";
import { callOperation } from "../client/call.ts";
import {
  asShape,
  HighLevelShapeError,
  readArray,
  readDeleted,
  readOptionalBoolean,
  readOptionalString,
  readString,
} from "./shape.ts";

/** One task on a contact. */
export interface Task {
  id: string;
  title: string;
  body?: string;
  /** ISO timestamp. */
  dueDate?: string;
  completed: boolean;
  contactId: string;
  assignedTo?: string;
}

/** Input for {@link createTask}. */
export interface CreateTaskInput {
  contactId: string;
  title: string;
  body?: string;
  /** ISO timestamp; GHL requires it. */
  dueDate: string;
  assignedTo?: string;
  /** Defaults to `false`. */
  completed?: boolean;
}

/** Identifies one task. */
export interface TaskRef {
  contactId: string;
  taskId: string;
}

/** Input for {@link updateTask}: the task plus the fields to change. */
export type UpdateTaskInput = TaskRef &
  Partial<
    Pick<CreateTaskInput, "title" | "body" | "dueDate" | "assignedTo" | "completed">
  >;

/** Parse one task; `contactId` fills in when the response omits it. */
function parseTask(value: unknown, field: string, contactId: string): Task {
  const shape = asShape(value, field);
  const completed = readOptionalBoolean(shape, "completed");
  if (completed === undefined)
    throw new HighLevelShapeError(`${field}.completed`, "a boolean");
  const body = readOptionalString(shape, "body");
  const dueDate = readOptionalString(shape, "dueDate");
  const assignedTo = readOptionalString(shape, "assignedTo");
  return {
    id: readString(shape, "id", field),
    title: readString(shape, "title", field),
    completed,
    contactId: readOptionalString(shape, "contactId") ?? contactId,
    ...(body === undefined ? {} : { body }),
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(assignedTo === undefined ? {} : { assignedTo }),
  };
}

function parseTaskResponse(response: unknown, contactId: string): Task {
  return parseTask(asShape(response, "response").task, "response.task", contactId);
}

/**
 * List a contact's tasks.
 *
 * @param client - The account client.
 * @param contactId - The contact.
 * @returns The contact's tasks.
 */
export async function listTasks(
  client: AccountClient,
  contactId: string,
): Promise<Task[]> {
  // operationId: get-all-tasks
  const response = await callOperation(
    client,
    { family: "v2", operationId: "get-all-tasks" },
    { pathParams: { contactId } },
  );
  return readArray(asShape(response, "response"), "tasks", "response", (item, field) =>
    parseTask(item, field, contactId),
  );
}

/**
 * Create a task on a contact.
 *
 * @param client - The account client (needs `allowWrites`).
 * @param input - The contact, title, due date and optional fields.
 * @returns The created task.
 */
export async function createTask(
  client: AccountClient,
  input: CreateTaskInput,
): Promise<Task> {
  const { contactId, completed = false, ...fields } = input;
  // operationId: create-task
  const response = await callOperation(
    client,
    { family: "v2", operationId: "create-task" },
    { pathParams: { contactId }, body: { ...fields, completed } },
  );
  return parseTaskResponse(response, contactId);
}

/**
 * Change a task's fields; only the fields given are sent.
 *
 * @param client - The account client (needs `allowWrites`).
 * @param input - The task and the fields to change.
 * @returns The updated task.
 */
export async function updateTask(
  client: AccountClient,
  input: UpdateTaskInput,
): Promise<Task> {
  const { contactId, taskId, ...fields } = input;
  // operationId: update-task
  const response = await callOperation(
    client,
    { family: "v2", operationId: "update-task" },
    { pathParams: { contactId, taskId }, body: fields },
  );
  return parseTaskResponse(response, contactId);
}

/**
 * Mark a task completed or open.
 *
 * @param client - The account client (needs `allowWrites`).
 * @param input - The task and its new completed state.
 * @returns The updated task.
 */
export async function completeTask(
  client: AccountClient,
  input: TaskRef & { completed: boolean },
): Promise<Task> {
  const { contactId, taskId, completed } = input;
  // operationId: update-task-completed
  const response = await callOperation(
    client,
    { family: "v2", operationId: "update-task-completed" },
    { pathParams: { contactId, taskId }, body: { completed } },
  );
  return parseTaskResponse(response, contactId);
}

/**
 * Delete a task.
 *
 * @param client - The account client (needs `allowWrites`).
 * @param ref - The task.
 * @returns Whether GHL reports the delete succeeded (`succeded`, or `succeeded`).
 * @throws HighLevelShapeError when neither field is a boolean.
 */
export async function deleteTask(
  client: AccountClient,
  ref: TaskRef,
): Promise<boolean> {
  // operationId: delete-task
  const response = await callOperation(
    client,
    { family: "v2", operationId: "delete-task" },
    { pathParams: { contactId: ref.contactId, taskId: ref.taskId } },
  );
  return readDeleted(response);
}
