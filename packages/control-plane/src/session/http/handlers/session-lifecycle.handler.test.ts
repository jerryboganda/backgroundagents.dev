import { describe, expect, it, vi } from "vitest";
import { createMockSession } from "../../../sandbox/lifecycle/test-helpers";
import type { MessageRepository } from "../../message-repository";
import type { SandboxStateReader } from "../../sandbox-ports";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SessionStatusService } from "../../session-status-service";
import type { SessionTitleService } from "../../title-service";
import { SessionLifecycleHandler } from "./session-lifecycle.handler";

function createPurgeHandler(
  options: { session?: ReturnType<typeof createMockSession> | null; destroyError?: Error } = {}
) {
  const calls: string[] = [];
  const session = options.session === undefined ? createMockSession() : options.session;
  const handler = new SessionLifecycleHandler(
    { getSession: () => session } as SessionCoreRepository,
    {} as SandboxStateReader,
    { getPendingOrProcessingCount: () => 0 } as MessageRepository,
    {} as SessionStatusService,
    {} as SessionTitleService,
    {
      cancelSandbox: vi.fn(),
      preserveForArchive: vi.fn(),
      destroyForDelete: vi.fn(async () => {
        calls.push("destroy");
        if (options.destroyError) throw options.destroyError;
      }),
    },
    "session-do-id",
    async () => {
      calls.push("cancel");
    },
    async () => {
      calls.push("purge");
    }
  );
  return { handler, calls };
}

describe("SessionLifecycleHandler.purge", () => {
  it("cancels live work, destroys the sandbox and workspace, then purges the data, in that order", async () => {
    const { handler, calls } = createPurgeHandler({
      session: createMockSession({ status: "active" }),
    });

    const response = await handler.purge();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "purged", existed: true });
    expect(calls).toEqual(["cancel", "destroy", "purge"]);
  });

  it("does not cancel a session that is already finished", async () => {
    const { handler, calls } = createPurgeHandler({
      session: createMockSession({ status: "archived" }),
    });

    expect((await handler.purge()).status).toBe(200);
    expect(calls).toEqual(["destroy", "purge"]);
  });

  it("answers 502 and removes no data when the sandbox or its workspace is not confirmed gone", async () => {
    const { handler, calls } = createPurgeHandler({
      session: createMockSession({ status: "archived" }),
      destroyError: new Error("The provider still holds a saved workspace for this session"),
    });

    const response = await handler.purge();

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The provider still holds a saved workspace for this session",
    });
    expect(calls).toEqual(["destroy"]);
  });

  it("is safe to repeat: a session already emptied answers 200 and touches nothing", async () => {
    const { handler, calls } = createPurgeHandler({ session: null });

    const response = await handler.purge();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "purged", existed: false });
    expect(calls).toEqual([]);
  });
});

function createHandler() {
  const beginTransition = vi.fn<SessionStatusService["beginTransition"]>();
  const confirmIndexStatus = vi.fn<SessionStatusService["confirmIndexStatus"]>();
  const preserveForArchive = vi.fn(async () => undefined);
  const handler = new SessionLifecycleHandler(
    { getSession: () => createMockSession() } as SessionCoreRepository,
    {} as SandboxStateReader,
    { getPendingOrProcessingCount: () => 0 } as MessageRepository,
    { beginTransition, confirmIndexStatus } as unknown as SessionStatusService,
    {} as SessionTitleService,
    { cancelSandbox: vi.fn(), preserveForArchive, destroyForDelete: vi.fn() },
    "session-do-id",
    vi.fn()
  );
  return { handler, beginTransition, confirmIndexStatus, preserveForArchive };
}

describe("SessionLifecycleHandler.archive", () => {
  it("archives successfully without participant authorization", async () => {
    const { handler, beginTransition, preserveForArchive } = createHandler();
    beginTransition.mockResolvedValue(true);

    const response = await handler.archive();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "archived", outcome: "archived" });
    expect(beginTransition).toHaveBeenCalledWith("archived");
    expect(preserveForArchive).toHaveBeenCalledOnce();
    expect(beginTransition.mock.invocationCallOrder[0]).toBeLessThan(
      preserveForArchive.mock.invocationCallOrder[0]
    );
  });

  it("does not preserve when the synchronous local transition fails", async () => {
    const { handler, beginTransition, preserveForArchive, confirmIndexStatus } = createHandler();
    beginTransition.mockImplementation(() => {
      throw new Error("local status write failed");
    });

    await expect(handler.archive()).rejects.toThrow("local status write failed");

    expect(preserveForArchive).not.toHaveBeenCalled();
    expect(confirmIndexStatus).not.toHaveBeenCalled();
  });
});
