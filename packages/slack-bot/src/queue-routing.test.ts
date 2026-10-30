import { describe, expect, it, vi } from "vitest";

const { events, completions, prune } = vi.hoisted(() => ({
  events: vi.fn(async () => {}),
  completions: vi.fn(async () => {}),
  prune: vi.fn(async () => {}),
}));
vi.mock("./events/consumer", () => ({
  consumeSlackEvents: events,
  pruneProcessedSlackDeliveries: prune,
}));
vi.mock("./completion/consumer", () => ({ consumeSlackCompletions: completions }));

import worker from "./index";
import type { Env } from "./types";

describe("Slack queue routing", () => {
  const env = { DEPLOYMENT_NAME: "test" } as Env;
  const batch = (queue: string) => ({ queue, messages: [], retryAll: vi.fn() });

  it("routes only the two configured production queues", async () => {
    const eventBatch = batch("open-inspect-slack-events-test");
    await worker.queue(eventBatch as unknown as MessageBatch<unknown>, env);
    expect(events).toHaveBeenCalledWith(eventBatch, env);

    const completionBatch = batch("open-inspect-slack-completion-test");
    await worker.queue(completionBatch as unknown as MessageBatch<unknown>, env);
    expect(completions).toHaveBeenCalledWith(completionBatch, env);

    const unknown = batch("open-inspect-slack-events-dlq-test");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await worker.queue(unknown as unknown as MessageBatch<unknown>, env);
    } finally {
      error.mockRestore();
    }
    expect(unknown.retryAll).toHaveBeenCalledOnce();
    expect(events).toHaveBeenCalledOnce();
    expect(completions).toHaveBeenCalledOnce();
  });

  it("runs the retention sweep on the scheduled trigger", async () => {
    await worker.scheduled({} as ScheduledEvent, env);
    expect(prune).toHaveBeenCalledWith(env);
  });
});
