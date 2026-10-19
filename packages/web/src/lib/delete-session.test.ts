import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toastError: vi.fn(),
  toastLoading: vi.fn(() => "t1"),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: mocks.fetch }));
vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, loading: mocks.toastLoading, success: mocks.toastSuccess },
}));

import { deleteSession } from "./delete-session";

describe("deleteSession", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.toastError.mockReset();
    mocks.toastLoading.mockClear();
    mocks.toastSuccess.mockReset();
  });

  it("succeeds on 200", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(deleteSession("abc")).resolves.toBe(true);
    expect(mocks.fetch).toHaveBeenCalledWith("/api/sessions/abc", { method: "DELETE" });
    // A progress toast shows while the delete runs, and the same toast becomes the result.
    expect(mocks.toastLoading).toHaveBeenCalledOnce();
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Session deleted", { id: "t1" });
  });

  it("treats a session that is already gone as deleted, without an error toast", async () => {
    mocks.fetch.mockResolvedValue(new Response("{}", { status: 404 }));
    await expect(deleteSession("abc")).resolves.toBe(true);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("reports a real failure", async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 502 }));
    await expect(deleteSession("abc")).resolves.toBe(false);
    expect(mocks.toastError).toHaveBeenCalled();
  });
});
