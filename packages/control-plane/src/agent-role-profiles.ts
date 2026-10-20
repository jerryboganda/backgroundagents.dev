/**
 * Operator-controlled execution profiles for child agent roles.
 *
 * A role never creates credentials or bypasses session admission. It selects a
 * harness/model which the existing child-session admission path validates.
 * The profile string is deployment configuration (not an end-user preference).
 */
import {
  agentRoleProfilesSchema,
  type AgentRole,
  type SpawnChildSessionRequest,
} from "@open-inspect/shared/types/session-api";
import type { EnvConfig } from "./types";

export class AgentRoleProfileError extends Error {
  readonly status = 409;
}

type RoleSelection = Pick<SpawnChildSessionRequest, "harness" | "model" | "reasoningEffort">;

type RoleRequest = RoleSelection & { role?: AgentRole };

export function resolveChildRoleProfile(
  config: Pick<EnvConfig, "AGENT_ROLE_PROFILES">,
  requested: RoleRequest
): RoleSelection {
  if (!requested.role) return requested;

  const source = config.AGENT_ROLE_PROFILES;
  if (!source || source.length > 8192) {
    throw new AgentRoleProfileError(
      "Agent role profiles are unavailable or oversized. Configure AGENT_ROLE_PROFILES."
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new AgentRoleProfileError("AGENT_ROLE_PROFILES contains invalid JSON.");
  }

  const checked = agentRoleProfilesSchema.safeParse(parsed);
  if (!checked.success) {
    throw new AgentRoleProfileError("AGENT_ROLE_PROFILES has an invalid role or selection.");
  }

  const profile = checked.data[requested.role];
  if (!profile) {
    throw new AgentRoleProfileError(`No agent profile configured for role "${requested.role}".`);
  }

  for (const key of ["harness", "model", "reasoningEffort"] as const) {
    const requestedValue = requested[key];
    const configuredValue = profile[key];
    if (
      configuredValue !== undefined &&
      requestedValue !== undefined &&
      configuredValue !== requestedValue
    ) {
      throw new AgentRoleProfileError(
        `Role "${requested.role}" requires its configured ${key}; conflicting overrides are not allowed.`
      );
    }
  }

  return {
    harness: profile.harness,
    model: profile.model ?? requested.model,
    reasoningEffort: profile.reasoningEffort ?? requested.reasoningEffort,
  };
}
