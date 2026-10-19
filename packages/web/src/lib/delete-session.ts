import { toast } from "sonner";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { sessionActionErrorMessage } from "./session-action-error";

/**
 * Permanently deletes a session via the API: its sandbox, saved workspace, files and history.
 *
 * Returns `true` when the request succeeds. Callers are responsible for
 * updating any client-side caches or navigation state.
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  // Stopping the sandbox and emptying its workspace can take a while, so say so instead of leaving a dead screen.
  const progress = toast.loading("Deleting session… stopping its sandbox and removing its files");
  try {
    const response = await browserApiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    // Already gone (a second request after the first finished): the session is deleted, which is what was asked.
    if (response.status === 404) {
      toast.success("Session deleted", { id: progress });
      return true;
    }
    if (!response.ok) {
      toast.error(await sessionActionErrorMessage(response, "Failed to delete session"), {
        id: progress,
      });
      return false;
    }

    toast.success("Session deleted", { id: progress });
    return true;
  } catch {
    toast.error("Failed to delete session", { id: progress });
    return false;
  }
}
