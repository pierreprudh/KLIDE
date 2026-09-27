import { describe, expect, it } from "vitest";
import { wakeTurnMode } from "./wake";

describe("wakeTurnMode", () => {
  it("a_chat_thread_wakes_as_chat", () => {
    expect(wakeTurnMode("chat")).toBe("chat");
  });

  it("keeps every other Mode as it is", () => {
    expect(wakeTurnMode("plan")).toBe("plan");
    expect(wakeTurnMode("goal")).toBe("goal");
  });
});
