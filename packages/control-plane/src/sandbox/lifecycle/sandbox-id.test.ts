import { describe, expect, it } from "vitest";
import { buildSandboxIdForSession } from "./manager";
import type { SessionRow } from "../../session/types";

const session = (repo_owner: string | null, repo_name: string | null) =>
  ({ id: "abc123", repo_owner, repo_name }) as unknown as SessionRow;

describe("buildSandboxIdForSession", () => {
  it("replaces characters the executor rejects, such as the dot in a repository name", () => {
    const id = buildSandboxIdForSession(session("jerryboganda", "backgroundagents.dev"), 17);
    expect(id).toBe("sandbox-jerryboganda-backgroundagents-dev-17");
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  });

  it("stays within 128 characters for a long repository name", () => {
    const id = buildSandboxIdForSession(session("o", "r".repeat(300)), 1792331319051);
    expect(id.length).toBeLessThanOrEqual(128);
  });
});
