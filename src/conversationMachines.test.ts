import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./testStorage";

async function fresh() {
  vi.resetModules();
  vi.stubGlobal("localStorage", memoryStorage());
  return import("./conversationMachines");
}

describe("where a conversation runs", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("keeps a conversation's machine, and this Mac is no entry", async () => {
    const m = await fresh();
    expect(m.conversationMachine("c1")).toBeNull();
    m.setConversationMachine("c1", "klide-box");
    expect(m.conversationMachine("c1")).toBe("klide-box");
    m.setConversationMachine("c1", null);
    expect(m.conversationMachine("c1")).toBeNull();
  });

  it("each project remembers the machine it last started on", async () => {
    const m = await fresh();
    m.setStartStageMachine("klide-box", "/src/app");
    m.setStartStageMachine(null, "/src/other");
    m.restoreStartStageMachine("/src/other");
    expect(m.startStageMachine()).toBeNull();
    m.restoreStartStageMachine("/src/app");
    expect(m.startStageMachine()).toBe("klide-box");
  });

  it("picking this Mac forgets the project's machine", async () => {
    const m = await fresh();
    m.setStartStageMachine("klide-box", "/src/app");
    m.setStartStageMachine(null, "/src/app");
    expect(m.rememberedStartMachine("/src/app")).toBeNull();
  });

  it("tells subscribers when the start stage changes", async () => {
    const m = await fresh();
    const seen: Array<string | null> = [];
    m.subscribeStartStageMachine(() => seen.push(m.startStageMachine()));
    m.setStartStageMachine("klide-box", "/src/app");
    m.restoreStartStageMachine("/src/none");
    expect(seen).toEqual(["klide-box", null]);
  });
});
