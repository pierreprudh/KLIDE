import { expect, it } from "vitest";
import { observerMessageIndex } from "./ConversationObservers";
import type { Msg } from "./types";

it("keeps a watcher with its original reply when later turns arrive", () => {
  const msgs = [
    { role: "tool", toolName: "run_command", content: "Watching `gh run watch 120` as `watch-1`." },
    { role: "assistant", content: "Watching the checks." },
    { role: "user", content: "Next task" },
    { role: "assistant", content: "Next answer" },
  ] as Msg[];
  expect(observerMessageIndex(msgs.slice(0, 2), "watch-1")).toBe(1);
  expect(observerMessageIndex(msgs, "watch-1")).toBe(1);
  expect(observerMessageIndex(msgs, "unknown")).toBeNull();
});
