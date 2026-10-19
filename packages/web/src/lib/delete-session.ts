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
  try {
    const response = await browserApiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    // Already gone (a second request after the first finished): the session is deleted, which is what was asked.
    if (response.status === 404) return true;
    if (!response.ok) {
      toast.error(await sessionActionErrorMessage(response, "Failed to delete session"));
      return false;
    }

    return true;
  } catch {
    toast.error("Failed to delete session");
    return false;
  }
}
