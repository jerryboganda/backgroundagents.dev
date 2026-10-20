import { describe, expect, it } from "vitest";
import { AgentRoleProfileError, resolveChildRoleProfile } from "./agent-role-profiles";

const configured = JSON.stringify({
  orchestrator: { harness: "opencode", model: "openai/gpt-5.4", reasoningEffort: "high" },
  explorer: { harness: "opencode", model: "google/gemini-2.5-pro" },
  implementer: { harness: "claude", model: "anthropic/claude-sonnet-4-6" },
  reviewer: { harness: "codex", model: "openai/gpt-5.4" },
  ci: { harness: "opencode" },
});

describe("operator-configured child agent roles", () => {
  it("leaves unlabelled child sessions unchanged, even when no policy exists", () => {
    const request = { harness: "claude" as const, model: "anthropic/claude-sonnet-4-6" };
    expect(resolveChildRoleProfile({}, request)).toEqual(request);
    expect(resolveChildRoleProfile({ AGENT_ROLE_PROFILES: "{bad" }, request)).toEqual(request);
  });

  it("allows independently configured harnesses and models for five roles", () => {
    const env = { AGENT_ROLE_PROFILES: configured };
    expect(resolveChildRoleProfile(env, { role: "explorer" })).toEqual({
      harness: "opencode",
      model: "google/gemini-2.5-pro",
      reasoningEffort: undefined,
    });
    expect(resolveChildRoleProfile(env, { role: "implementer" }).harness).toBe("claude");
    expect(resolveChildRoleProfile(env, { role: "reviewer" }).harness).toBe("codex");
    expect(resolveChildRoleProfile(env, { role: "orchestrator" }).reasoningEffort).toBe("high");
    expect(resolveChildRoleProfile(env, { role: "ci", model: "openai/gpt-5.4" })).toEqual({
      harness: "opencode",
      model: "openai/gpt-5.4",
      reasoningEffort: undefined,
    });
  });

  it("does not permit callers to override an operator-pinned harness or model", () => {
    const env = { AGENT_ROLE_PROFILES: configured };
    expect(() => resolveChildRoleProfile(env, { role: "reviewer", harness: "opencode" })).toThrow(
      /conflicting overrides/
    );
    expect(() =>
      resolveChildRoleProfile(env, { role: "explorer", model: "openai/gpt-5.4" })
    ).toThrow(/conflicting overrides/);
    expect(() =>
      resolveChildRoleProfile(env, { role: "orchestrator", reasoningEffort: "low" })
    ).toThrow(/conflicting overrides/);
    expect(resolveChildRoleProfile(env, { role: "reviewer", harness: "codex" })).toEqual({
      harness: "codex",
      model: "openai/gpt-5.4",
      reasoningEffort: undefined,
    });
  });

  it("fails closed for unset or malformed operator policies", () => {
    for (const env of [
      {},
      { AGENT_ROLE_PROFILES: "" },
      { AGENT_ROLE_PROFILES: "{broken" },
      { AGENT_ROLE_PROFILES: "[]" },
      { AGENT_ROLE_PROFILES: JSON.stringify({ explorer: { harness: "invalid" } }) },
      { AGENT_ROLE_PROFILES: JSON.stringify({ administrator: { harness: "opencode" } }) },
      { AGENT_ROLE_PROFILES: "a".repeat(9000) },
    ]) {
      expect(() => resolveChildRoleProfile(env, { role: "explorer" })).toThrow(
        AgentRoleProfileError
      );
    }
  });

  it("rejects roles with no profile rather than inheriting an unintended agent", () => {
    const policy = JSON.stringify({ explorer: { harness: "opencode" } });
    expect(() =>
      resolveChildRoleProfile(
        { AGENT_ROLE_PROFILES: policy },
        { role: "reviewer", harness: "claude" }
      )
    ).toThrow('No agent profile configured for role "reviewer"');
  });
});
