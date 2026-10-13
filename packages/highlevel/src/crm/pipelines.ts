/**
 * Typed pipeline helpers: list the account's pipelines and resolve one (and a
 * stage) by id or name. Pipelines are never created here.
 *
 * @module
 */
import type { AccountClient } from "../accounts.ts";
import { callOperation } from "../client/call.ts";
import { asShape, readArray, readOptionalNumber, readString } from "./shape.ts";

/** One stage of a pipeline. */
export interface PipelineStage {
  id: string;
  name: string;
  position?: number;
}

/** One pipeline and its stages. */
export interface Pipeline {
  id: string;
  name: string;
  stages: PipelineStage[];
}

/** A pipeline or stage asked for by id or name does not exist. */
export class PipelineNotFoundError extends Error {
  /** What was asked for, e.g. `pipeline "Outreach"`. */
  readonly requested: string;
  /** The names that exist where it was looked for. */
  readonly available: string[];

  constructor(requested: string, available: string[]) {
    const names = available.join(", ") || "(none)";
    super(`HighLevel ${requested} not found. Available: ${names}.`);
    this.name = "PipelineNotFoundError";
    this.requested = requested;
    this.available = available;
  }
}

function parseStage(value: unknown, field: string): PipelineStage {
  const shape = asShape(value, field);
  const position = readOptionalNumber(shape, "position");
  return {
    id: readString(shape, "id", field),
    name: readString(shape, "name", field),
    ...(position === undefined ? {} : { position }),
  };
}

function parsePipeline(value: unknown, field: string): Pipeline {
  const shape = asShape(value, field);
  const hasStages = shape.stages !== undefined;
  return {
    id: readString(shape, "id", field),
    name: readString(shape, "name", field),
    stages: hasStages ? readArray(shape, "stages", field, parseStage) : [],
  };
}

/**
 * List the account's pipelines with their stages.
 *
 * @throws HighLevelShapeError when the response is not a pipeline list.
 */
export async function listPipelines(client: AccountClient): Promise<Pipeline[]> {
  // operationId: get-pipelines (GET /opportunities/pipelines)
  const raw = await callOperation(
    client,
    { family: "v2", operationId: "get-pipelines" },
    { query: { locationId: client.locationId } },
  );
  return readArray(asShape(raw, "response"), "pipelines", "response", parsePipeline);
}

function findByIdOrName<T extends { id: string; name: string }>(
  items: T[],
  wanted: string,
): T | undefined {
  const key = wanted.trim().toLowerCase();
  return items.find(
    (item) => item.id === wanted || item.name.trim().toLowerCase() === key,
  );
}

/**
 * Find a pipeline, and optionally one of its stages, by id or case-insensitive name.
 *
 * @throws PipelineNotFoundError naming what was asked and listing what exists.
 */
export async function resolvePipeline(
  client: AccountClient,
  wanted: { pipeline: string; stage?: string },
): Promise<{ pipeline: Pipeline; stage?: { id: string; name: string } }> {
  const pipelines = await listPipelines(client);
  const pipeline = findByIdOrName(pipelines, wanted.pipeline);
  if (!pipeline) {
    const names = pipelines.map((item) => item.name);
    throw new PipelineNotFoundError(`pipeline "${wanted.pipeline}"`, names);
  }
  if (wanted.stage === undefined) return { pipeline };
  const stage = findByIdOrName(pipeline.stages, wanted.stage);
  if (!stage) {
    const where = `stage "${wanted.stage}" in pipeline "${pipeline.name}"`;
    throw new PipelineNotFoundError(
      where,
      pipeline.stages.map((item) => item.name),
    );
  }
  return { pipeline, stage: { id: stage.id, name: stage.name } };
}
