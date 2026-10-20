# Child agent role profiles

The control plane supports five optional operator-configured roles for **child
sessions**: `orchestrator`, `explorer`, `implementer`, `reviewer`, and
`ci`. These names select an approved model and agent harness. They do not
automatically spawn agents, grant permissions, or create credentials.

## Configure roles

Set `AGENT_ROLE_PROFILES` in the **control-plane service** configuration to
one JSON object. Each role is optional, but every requested role must have a
profile. Example:

```json
{
  "orchestrator": {
    "harness": "opencode",
    "model": "openai/gpt-5.4",
    "reasoningEffort": "high"
  },
  "explorer": {
    "harness": "opencode",
    "model": "google/gemini-2.5-pro"
  },
  "implementer": {
    "harness": "claude",
    "model": "anthropic/claude-sonnet-4-6"
  },
  "reviewer": {
    "harness": "opencode",
    "model": "openai/gpt-5.4"
  },
  "ci": {
    "harness": "opencode",
    "model": "openai/gpt-5.4"
  }
}
```

Use the model IDs available and **enabled** in your deployment, and verify
that the selected harness supports each model. `harness` is required and must
be `opencode`, `claude`, or `codex`; `model` and `reasoningEffort` are
optional. Keep the configuration to 8192 characters or fewer. When inserting
the JSON into an environment file, use the file format's proper one-line
quoting and escaping rules. Do not place provider credentials in this JSON.

> **VPS constraint:** The current implementation restricts Codex children
> to supported **Modal or Modal VM** sandbox backends. On a Linode/VPS
> executor, configure the `reviewer` role with OpenCode or Claude Agent
> instead; selecting Codex must fail rather than bypassing this safeguard.

## Request a role

A parent may request a child through the existing child-session API or
`spawn-child` tool. The request includes `role`, `title`, and `prompt`:

```json
{
  "role": "reviewer",
  "title": "Review implementation",
  "prompt": "Examine this pull request for correctness, safety, and regressions."
}
```

The control plane maps the role to its configured harness, model, and effort.
The child's title is prefixed with the role (for example,
`[reviewer] Review implementation`). The role is **not** a new authorization
identity or workspace permission. Existing parent/session authorization,
repository and team grants, child-count limits, provider-account selection,
model enablement, and harness/sandbox admission remain in force.

Explicit requests that disagree with operator-pinned `harness`, `model`,
or `reasoningEffort` are rejected with HTTP 409. Missing, malformed,
oversized, or unsupported role policies fail closed. A child with **no role**
retains the previous cross-harness delegation behavior, even when role
profiles are not configured.

## Recommended review sequence

1. Use `explorer` children for independent read-only repository analysis.
2. Assign separate files or packages to `implementer` children to avoid
   conflicting changes; require a focused branch and a pull request.
3. Use a distinct `reviewer` role to evaluate changes, with independent
   permission and model compatibility checks.
4. Use `ci` to inspect required checks and failures; the actual test suites
   run in GitHub Actions, not the permanent dashboard VPS.
5. Keep `orchestrator` responsible for task breakdown, integration, and
   reporting. Human review remains required where configured.

Child sessions are started only when their creation is explicitly authorized.
Role labels alone do not provide an autonomous scheduler or guarantee that
independent agents will coordinate. Do not assume a passing targeted CI check
also verifies a production rollout.

## Validation and rollout

The `Cross-harness child delegation` GitHub Actions workflow runs the
shared schema tests, role-policy tests, child-route tests, native harness
tool tests, relevant TypeScript checks, and formatting. Use its final
head-SHA results as evidence. Test role selection against each supported
harness before changing a production control-plane setting.

Related: [Child sessions](../packages/docs/content/docs/sessions/child-sessions.mdx),
[Executor host](../deploy/polytronx/runbooks/executor-host.md).
