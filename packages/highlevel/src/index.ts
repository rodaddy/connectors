/**
 * `@rodaddy/connectors-highlevel`: the one common GoHighLevel library.
 *
 * @module
 */

export * from "./accounts.ts";
export * from "./catalog/index.ts";
export * from "./catalog/types.ts";
export * from "./client/call.ts";
export * from "./client/highlevel.ts";
export * from "./config/runtime.ts";
export * from "./core/errors.ts";
export * from "./crm/shape.ts";
export * from "./core/result.ts";
export * from "./core/retry.ts";
export * from "./core/token.ts";
export * from "./crm/contacts.ts";
export * from "./crm/notes.ts";
export * from "./crm/opportunities.ts";
export * from "./crm/pipelines.ts";
export * from "./crm/tasks.ts";
export * from "./conversations/optout.ts";
export * from "./conversations/phone.ts";
export * from "./conversations/poll.ts";
export * from "./conversations/read.ts";
export * from "./conversations/seen-store.ts";
export * from "./conversations/send-errors.ts";
export * from "./conversations/send.ts";
export * from "./locations.ts";
export * from "./oauth/oauth.ts";
export * from "./oauth/token-store.ts";
export * from "./webhooks/events.ts";
export * from "./webhooks/verify.ts";
export * from "./workflows/public.ts";
export * from "./crm/custom.ts";
export * from "./crm/tags.ts";
export * from "./emails.ts";
export * from "./phone-numbers.ts";

// The typed modules own these names; the client's older helper types of the
// same name stay reachable from "./client/highlevel.ts" only.
export type { CustomField } from "./crm/custom.ts";
export type { Pipeline } from "./crm/pipelines.ts";
export type { WorkflowSummary } from "./workflows/public.ts";

/** The published package name, exported so consumers and tests can assert which SDK they loaded. */
export const SDK_NAME = "@rodaddy/connectors-highlevel";
