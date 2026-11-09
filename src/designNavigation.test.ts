import { describe, expect, it, vi } from "vitest";
import { openDesignMode, promoteDesignOpener, registerDesignOpener } from "./designNavigation";

describe("design navigation", () => {
  it("opens the most recently used conversation and falls back when it leaves", () => {
    const a = vi.fn(), b = vi.fn();
    const offA = registerDesignOpener(a);
    const offB = registerDesignOpener(b);
    openDesignMode();
    expect(b).toHaveBeenCalledTimes(1);
    promoteDesignOpener(a);
    openDesignMode();
    expect(a).toHaveBeenCalledTimes(1);
    offA();
    openDesignMode();
    expect(b).toHaveBeenCalledTimes(2);
    offB();
    expect(openDesignMode()).toBe(false);
  });
});
