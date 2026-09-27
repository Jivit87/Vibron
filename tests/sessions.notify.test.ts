import { afterEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ warning: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { notifySession } = await import("@/lib/client/notify");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("notifySession", () => {
  it("uses the Electron preload's native notification when it exists", () => {
    const notify = vi.fn();
    vi.stubGlobal("window", { electronAPI: { notify } });
    notifySession({ tone: "approval", title: 'Session "A" needs your approval', body: "rm -rf build" });
    expect(notify).toHaveBeenCalledWith({ title: 'Session "A" needs your approval', body: "rm -rf build" });
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("falls back to an in-app toast with an Open action in a browser", () => {
    vi.stubGlobal("window", {});
    const onOpen = vi.fn();
    notifySession({ tone: "done", title: "done!", onOpen });
    expect(toast.success).toHaveBeenCalledWith("done!", expect.objectContaining({ action: expect.objectContaining({ label: "Open" }) }));
    toast.success.mock.calls[0][1].action.onClick();
    expect(onOpen).toHaveBeenCalled();

    notifySession({ tone: "error", title: "failed", body: "boom" });
    expect(toast.error).toHaveBeenCalledWith("failed", expect.objectContaining({ description: "boom" }));
  });

  it("falls back to the toast when the native bridge throws or rejects", async () => {
    vi.stubGlobal("window", { electronAPI: { notify: () => { throw new Error("no"); } } });
    notifySession({ tone: "approval", title: "t" });
    expect(toast.warning).toHaveBeenCalledTimes(1);

    vi.stubGlobal("window", { electronAPI: { notify: () => Promise.reject(new Error("no")) } });
    notifySession({ tone: "error", title: "t2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(toast.error).toHaveBeenCalledWith("t2", expect.anything());
  });
});
