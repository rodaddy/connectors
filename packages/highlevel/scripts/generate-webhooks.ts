/**
 * Generate `catalog/webhook-catalog.json` from the pinned upstream
 * `docs/webhook events/*.md`. `--out <dir>` writes elsewhere.
 *
 * @module
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { WebhookCatalog, WebhookEvent } from "../src/catalog/types.ts";
import { say, warn } from "./out.ts";
import { outDir, provenance, upstreamRoot, writeJson } from "./upstream.ts";

const WEBHOOK_DIR = "docs/webhook events";

function parseJsonFence(
  content: string,
  label: string,
): Record<string, unknown> | null {
  const fence = new RegExp(
    `#### ${label}\\s+\`\`\`json(?: json_schema)?\\s+([\\s\\S]*?)\`\`\``,
    "i",
  );
  const body = fence.exec(content)?.[1];
  if (body === undefined) return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch (error: unknown) {
    warn(`Unparseable ${label} block: ${String(error)}`);
    return null;
  }
}

function firstMatch(content: string, patterns: RegExp[], group: number): string | null {
  for (const pattern of patterns) {
    const value = pattern.exec(content)?.[group]?.trim();
    if (value !== undefined) return value;
  }
  return null;
}

function parseEvent(file: string, content: string): WebhookEvent {
  const title = firstMatch(content, [/^#\s+(.+)$/m], 1) ?? basename(file, ".md");
  const description =
    firstMatch(content, [/^Called[^\n]+$/m, /^Overview[^\n]*$/m], 0) ?? "";
  const example = parseJsonFence(content, "Example");
  const exampleType = typeof example?.["type"] === "string" ? example["type"] : null;
  return {
    event: exampleType ?? basename(file, ".md"),
    source: `${WEBHOOK_DIR}/${file}`,
    title,
    description,
    schema: parseJsonFence(content, "Schema"),
    example,
  };
}

const root = join(upstreamRoot, WEBHOOK_DIR);
const files = (await readdir(root)).filter((file) => file.endsWith(".md")).sort();
const events = await Promise.all(
  files.map(async (file) => parseEvent(file, await readFile(join(root, file), "utf8"))),
);
events.sort((left, right) => left.event.localeCompare(right.event));

const catalog: WebhookCatalog = {
  provenance: await provenance(WEBHOOK_DIR),
  eventCount: events.length,
  events,
};
await writeJson(join(outDir(process.argv), "webhook-catalog.json"), catalog);
say(`Generated ${catalog.eventCount} webhook events.`);
