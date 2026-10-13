/**
 * Loads and validates a read-only HighLevel runtime config file.
 *
 * @module
 */

import { readFile, stat } from "node:fs/promises";

// Group and other permission bits: a file holding a PIT must have none.
const SHARED_MODE_BITS = 0o077;

/** A validated, explicitly read-only HighLevel runtime config. */
export interface RuntimeConfig {
  baseUrl: string;
  friendlyBusinessName: string;
  locationId: string;
  privateIntegrationToken: string;
  readOnly: true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function validate(value: Record<string, unknown>): RuntimeConfig {
  const { baseUrl, friendlyBusinessName, locationId, privateIntegrationToken } = value;
  if (baseUrl !== "https://services.leadconnectorhq.com") {
    throw new Error("HighLevel runtime config has an unexpected API base URL.");
  }
  if (!isNonBlankString(locationId)) {
    throw new Error("HighLevel runtime config requires a location ID.");
  }
  if (!isNonBlankString(friendlyBusinessName)) {
    throw new Error("HighLevel runtime config requires a friendly business name.");
  }
  if (
    typeof privateIntegrationToken !== "string" ||
    !/^pit-[A-Za-z0-9-]+$/.test(privateIntegrationToken)
  ) {
    throw new Error("HighLevel runtime config requires a valid PIT.");
  }
  if (value.readOnly !== true) {
    throw new Error("HighLevel runtime config must explicitly enable read-only mode.");
  }
  return {
    baseUrl,
    friendlyBusinessName,
    locationId,
    privateIntegrationToken,
    readOnly: true,
  };
}

/**
 * Read a runtime config JSON file and validate it.
 *
 * @param path - Path to the JSON config file.
 * @returns The validated config.
 * @throws Error when the file is readable by group or others, is not a JSON
 *   object, or any field is missing or invalid, or `readOnly` is not exactly
 *   `true`.
 */
export async function loadRuntimeConfig(path: string): Promise<RuntimeConfig> {
  if (((await stat(path)).mode & SHARED_MODE_BITS) !== 0) {
    throw new Error(
      "HighLevel runtime config must not be readable by group or others (chmod 600).",
    );
  }
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isObject(value)) {
    throw new Error("HighLevel runtime config must be a JSON object.");
  }
  return validate(value);
}
