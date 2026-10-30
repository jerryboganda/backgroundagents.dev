import app from "./app";
import { consumeSlackCompletions } from "./completion/consumer";
import { consumeSlackEvents, pruneProcessedSlackDeliveries } from "./events/consumer";

export default {
  fetch: app.fetch,
  queue: async (batch: MessageBatch<unknown>, env: Parameters<typeof consumeSlackEvents>[1]) => {
    if (batch.queue === `open-inspect-slack-events-${env.DEPLOYMENT_NAME}`)
      await consumeSlackEvents(batch as Parameters<typeof consumeSlackEvents>[0], env);
    else if (batch.queue === `open-inspect-slack-completion-${env.DEPLOYMENT_NAME}`)
      await consumeSlackCompletions(batch, env);
    else {
      console.error("slack.queue_unknown", batch.queue);
      batch.retryAll();
    }
  },
  scheduled: (_event: ScheduledEvent, env: Parameters<typeof pruneProcessedSlackDeliveries>[0]) =>
    pruneProcessedSlackDeliveries(env),
};
