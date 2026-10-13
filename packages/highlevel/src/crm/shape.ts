/**
 * Small readers for GoHighLevel response bodies. Every typed helper parses
 * what GHL returns through these, so a changed or malformed response fails
 * loudly with the field that broke instead of flowing on as `undefined`.
 *
 * @module
 */

/** A GHL response did not have the shape a typed helper expects. */
export class HighLevelShapeError extends Error {
  /** Dotted path of the field that failed, e.g. `contact.id`. */
  readonly field: string;

  constructor(field: string, expected: string) {
    super(`HighLevel response field ${field} is not ${expected}.`);
    this.name = "HighLevelShapeError";
    this.field = field;
  }
}

/** A JSON object as GHL returns it. */
export type Shape = Record<string, unknown>;

/**
 * Read `value` as an object.
 * @throws {HighLevelShapeError} when it is not a plain object.
 */
export function asShape(value: unknown, field: string): Shape {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HighLevelShapeError(field, "an object");
  }
  return value as Shape;
}

/**
 * Read a required string field.
 * @throws {HighLevelShapeError} when it is missing or not a string.
 */
export function readString(shape: Shape, key: string, field: string): string {
  const value = shape[key];
  if (typeof value !== "string")
    throw new HighLevelShapeError(`${field}.${key}`, "a string");
  return value;
}

/** Read an optional string field; anything that is not a string reads as `undefined`. */
export function readOptionalString(shape: Shape, key: string): string | undefined {
  const value = shape[key];
  return typeof value === "string" ? value : undefined;
}

/** Read an optional number field; anything that is not a finite number reads as `undefined`. */
export function readOptionalNumber(shape: Shape, key: string): number | undefined {
  const value = shape[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read an optional boolean field; anything that is not a boolean reads as `undefined`. */
export function readOptionalBoolean(shape: Shape, key: string): boolean | undefined {
  const value = shape[key];
  return typeof value === "boolean" ? value : undefined;
}

/** Read an optional string array; non-string entries are dropped, a missing field is `[]`. */
export function readStrings(shape: Shape, key: string): string[] {
  const value = shape[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * Read a required array field and parse each element.
 * @throws {HighLevelShapeError} when the field is not an array, or an element fails `parse`.
 */
export function readArray<T>(
  shape: Shape,
  key: string,
  field: string,
  parse: (item: unknown, field: string) => T,
): T[] {
  const value = shape[key];
  if (!Array.isArray(value))
    throw new HighLevelShapeError(`${field}.${key}`, "an array");
  return value.map((item, index) => parse(item, `${field}.${key}[${index}]`));
}

/**
 * Read a delete or status reply's success flag: GHL's `succeded` spelling, else `succeeded`.
 * @throws {HighLevelShapeError} when neither field is a boolean.
 */
export function readDeleted(response: unknown): boolean {
  const shape = asShape(response, "response");
  const value =
    readOptionalBoolean(shape, "succeded") ?? readOptionalBoolean(shape, "succeeded");
  if (value === undefined)
    throw new HighLevelShapeError("response.succeded", "a boolean");
  return value;
}
