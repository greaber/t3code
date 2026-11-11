import { describe, expect, it, vi } from "vite-plus/test";

import { createDeferredStorage, createMemoryStorage, isStorageQuotaError } from "./storage";

describe("createDeferredStorage", () => {
  it("reports a failed write and keeps the last saved value", () => {
    const base = createMemoryStorage();
    const onWriteError = vi.fn();
    const onWriteSuccess = vi.fn();
    const storage = createDeferredStorage<string>(base, (value) => value, 0, {
      onWriteError,
      onWriteSuccess,
    });
    storage.setItem("drafts", "first");
    storage.flush();
    expect(onWriteSuccess).toHaveBeenCalledOnce();

    const quota = new DOMException("full", "QuotaExceededError");
    {
      using _full = vi.spyOn(base, "setItem").mockImplementation(() => {
        throw quota;
      });
      storage.setItem("drafts", "second");
      expect(() => storage.flush()).not.toThrow();
    }
    expect(onWriteError).toHaveBeenCalledWith(quota);
    expect(isStorageQuotaError(onWriteError.mock.calls[0]?.[0])).toBe(true);
    expect(base.getItem("drafts")).toBe("first");
  });
});
