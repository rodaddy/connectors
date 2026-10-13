/**
 * Location custom fields: list, create, ensure-by-name.
 * Custom values (H04, H22) follow in a later PR.
 *
 * @module
 */
import type { AccountClient } from "../accounts.ts";
import { callOperation } from "../client/call.ts";
import {
  asShape,
  readArray,
  readDeleted,
  readOptionalString,
  readString,
  readStrings,
} from "./shape.ts";

/** The record type a custom field belongs to. */
export type CustomFieldModel = "contact" | "opportunity";

/** One location custom field. */
export interface CustomField {
  id: string;
  name: string;
  fieldKey?: string;
  dataType?: string;
  model?: string;
  placeholder?: string;
  /** Picklist options; absent when the field has none. */
  options?: string[];
}

/** What {@link createCustomField} and {@link ensureCustomFields} create. */
export interface CustomFieldSpec {
  name: string;
  /** GHL data type, e.g. `TEXT`, `LARGE_TEXT`, `SINGLE_OPTIONS`. */
  dataType: string;
  /** Defaults to `contact`. */
  model?: CustomFieldModel;
  placeholder?: string;
  /** Picklist options; sent as `options`, read back from `picklistOptions`. */
  options?: string[];
}

/** One result of {@link ensureCustomFields}. */
export interface EnsuredCustomField {
  field: CustomField;
  /** `true` when this call created the field. */
  created: boolean;
}

function parseCustomField(value: unknown, field: string): CustomField {
  const shape = asShape(value, field);
  const fieldKey = readOptionalString(shape, "fieldKey");
  const dataType = readOptionalString(shape, "dataType");
  const model = readOptionalString(shape, "model");
  const placeholder = readOptionalString(shape, "placeholder");
  const options = readStrings(shape, "picklistOptions");
  return {
    id: readString(shape, "id", field),
    name: readString(shape, "name", field),
    ...(fieldKey === undefined ? {} : { fieldKey }),
    ...(dataType === undefined ? {} : { dataType }),
    ...(model === undefined ? {} : { model }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(options.length > 0 ? { options } : {}),
  };
}

/**
 * The create body as earlier tooling `custom_fields.py` sends it: `model`
 * defaults to `contact`, `options` only when there are some.
 */
function customFieldBody(spec: CustomFieldSpec): Record<string, unknown> {
  const { name, dataType, placeholder, options = [] } = spec;
  return {
    name,
    dataType,
    model: spec.model ?? "contact",
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(options.length > 0 ? { options: [...options] } : {}),
  };
}

/**
 * List the location's custom fields.
 *
 * @param client - The account client; its location is used.
 * @param options - `model` limits the list to contact or opportunity fields.
 * @returns The custom fields.
 */
export async function listCustomFields(
  client: AccountClient,
  options: { model?: CustomFieldModel } = {},
): Promise<CustomField[]> {
  // operationId: get-custom-fields
  const response = await callOperation(
    client,
    { family: "v2", operationId: "get-custom-fields" },
    {
      pathParams: { locationId: client.locationId },
      ...(options.model === undefined ? {} : { query: { model: options.model } }),
    },
  );
  return readArray(
    asShape(response, "response"),
    "customFields",
    "response",
    parseCustomField,
  );
}

/**
 * Create one custom field in the location.
 *
 * @param client - The account client (needs `allowWrites`).
 * @param spec - Name, data type, and optional model, placeholder and options.
 * @returns The created field.
 */
export async function createCustomField(
  client: AccountClient,
  spec: CustomFieldSpec,
): Promise<CustomField> {
  // operationId: create-custom-field (service locations; the id repeats in v2)
  const response = await callOperation(
    client,
    { family: "v2", operationId: "create-custom-field", service: "locations" },
    { pathParams: { locationId: client.locationId }, body: customFieldBody(spec) },
  );
  return parseCustomField(
    asShape(response, "response").customField,
    "response.customField",
  );
}

/** The match key for {@link ensureCustomFields}: lower-cased name plus model. */
function fieldKey(name: string, model: string | undefined): string {
  return `${model ?? "contact"}:${name.toLowerCase()}`;
}

/**
 * Make sure each field exists: match existing fields by case-insensitive name
 * and model (a field without a model counts as `contact`), create only the
 * missing ones, never modify an existing field.
 *
 * @param client - The account client (needs `allowWrites` when a field is missing).
 * @param specs - The fields, in the order results are returned.
 * @returns One result per spec: the field and whether it was created.
 */
export async function ensureCustomFields(
  client: AccountClient,
  specs: readonly CustomFieldSpec[],
): Promise<EnsuredCustomField[]> {
  const fields = await listCustomFields(client);
  const known = new Map(
    fields.map((field) => [fieldKey(field.name, field.model), field]),
  );
  const results: EnsuredCustomField[] = [];
  for (const spec of specs) {
    const key = fieldKey(spec.name, spec.model);
    const existing = known.get(key);
    if (existing) {
      results.push({ field: existing, created: false });
      continue;
    }
    const field = await createCustomField(client, spec);
    known.set(key, field);
    results.push({ field, created: true });
  }
  return results;
}

/** One location custom value. */
export interface CustomValue {
  id: string;
  name: string;
  value: string;
  fieldKey?: string;
}

/** Input for {@link updateCustomValue}. */
export interface UpdateCustomValueInput {
  id: string;
  name: string;
  value: string;
}
function parseCustomValue(value: unknown, field: string): CustomValue {
  const shape = asShape(value, field);
  const fieldKey = readOptionalString(shape, "fieldKey");
  return {
    id: readString(shape, "id", field),
    name: readString(shape, "name", field),
    value: readString(shape, "value", field),
    ...(fieldKey === undefined ? {} : { fieldKey }),
  };
}

/**
 * List the location's custom values.
 *
 * @param client - The account client; its location is used.
 * @returns The custom values.
 */
export async function listCustomValues(client: AccountClient): Promise<CustomValue[]> {
  // operationId: get-custom-values
  const response = await callOperation(
    client,
    { family: "v2", operationId: "get-custom-values" },
    { pathParams: { locationId: client.locationId } },
  );
  return readArray(
    asShape(response, "response"),
    "customValues",
    "response",
    parseCustomValue,
  );
}

/**
 * Create one custom value in the location.
 *
 * @param client - The account client (needs `allowWrites`).
 * @param input - The value's name and value.
 * @returns The created custom value.
 */
export async function createCustomValue(
  client: AccountClient,
  input: { name: string; value: string },
): Promise<CustomValue> {
  // operationId: create-custom-value
  const response = await callOperation(
    client,
    { family: "v2", operationId: "create-custom-value" },
    { pathParams: { locationId: client.locationId }, body: { ...input } },
  );
  return parseCustomValue(
    asShape(response, "response").customValue,
    "response.customValue",
  );
}

/**
 * Replace a custom value's name and value.
 *
 * @param client - The account client (needs `allowWrites`).
 * @param input - The custom value id, name and value.
 * @returns The updated custom value.
 */
export async function updateCustomValue(
  client: AccountClient,
  input: UpdateCustomValueInput,
): Promise<CustomValue> {
  const { id, name, value } = input;
  // operationId: update-custom-value
  const response = await callOperation(
    client,
    { family: "v2", operationId: "update-custom-value" },
    { pathParams: { locationId: client.locationId, id }, body: { name, value } },
  );
  return parseCustomValue(
    asShape(response, "response").customValue,
    "response.customValue",
  );
}

/**
 * Delete a custom value.
 *
 * @param client - The account client (needs `allowWrites`).
 * @param id - The custom value id.
 * @returns Whether GHL reports the delete succeeded (`succeded`, or `succeeded`).
 * @throws HighLevelShapeError when neither field is a boolean.
 */
export async function deleteCustomValue(
  client: AccountClient,
  id: string,
): Promise<boolean> {
  // operationId: delete-custom-value
  const response = await callOperation(
    client,
    { family: "v2", operationId: "delete-custom-value" },
    { pathParams: { locationId: client.locationId, id } },
  );
  return readDeleted(response);
}
