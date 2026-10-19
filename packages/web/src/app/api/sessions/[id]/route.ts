import { settingsProxy } from "@/lib/settings-proxy";

export const { GET, DELETE } = settingsProxy(
  ({ id }: { id: string }) => `/sessions/${encodeURIComponent(id)}`,
  "session snapshot",
  { DELETE: "delete session" }
);
