/**
 * The launch capability envelope (after an earlier
 * MCP server). The server is bounded by the capability it
 * was started with, not by per-call prompts; `dryRun` is a per-call probe,
 * never a default (K07).
 *
 * @module
 */

/** What the server may do: `read` < `write` < `elevated`. */
export type Capability = "read" | "write" | "elevated";

/** How much a write tool needs: `safe` needs `write`, `elevated` needs `elevated`. */
export type WriteTier = "safe" | "elevated";

/** Every capability, lowest first. */
export const CAPABILITIES: readonly Capability[] = ["read", "write", "elevated"];

const NEEDS: Record<WriteTier, Capability> = { safe: "write", elevated: "elevated" };

/**
 * Read a capability name, case-insensitively; unset or blank is `read`.
 *
 * @returns The capability, or `undefined` when the name is not one.
 */
export function parseCapability(raw: string | undefined): Capability | undefined {
  const name = raw?.trim().toLowerCase() || "read";
  return CAPABILITIES.find((capability) => capability === name);
}

/** Whether a write may run, and whether it runs as a dry run. */
export interface WriteDecision {
  allowed: boolean;
  dryRun: boolean;
  reason?: string;
}

/** Inputs to {@link decideWrite}. */
export interface WriteRequest {
  tier: WriteTier;
  capability: Capability;
  dryRunRequested: boolean;
}

/** Decide whether a write tool may execute under the launch capability. */
export function decideWrite(request: WriteRequest): WriteDecision {
  const need = NEEDS[request.tier];
  if (CAPABILITIES.indexOf(request.capability) < CAPABILITIES.indexOf(need)) {
    return {
      allowed: false,
      dryRun: true,
      reason: `This ${request.tier} action needs capability '${need}'; the server was launched with '${request.capability}'. Restart with GHL_MCP_CAPABILITY=${need}.`,
    };
  }
  return { allowed: true, dryRun: request.dryRunRequested };
}
