import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { createListenerScope } from "../tauriEvents";
import { notify } from "../toast";
import { getKlideConvos } from "../klideConvos";
import { canOpenConversation, openConversation } from "../conversationNavigation";

/** App-owned: notifications still appear while a different conversation is open. */
export function ObserverNotifications() {
  useEffect(() => {
    const scope = createListenerScope();
    scope.add(listen<string>("agent-observer-finished", ({ payload: runId }) => {
      const conversation = getKlideConvos().find((c) => c.id === runId);
      notify(`Background observer updated ${conversation?.title || "its conversation"}.`, {
        tone: "info",
        action: canOpenConversation()
          ? { label: "Open", run: () => void openConversation(runId) }
          : undefined,
      });
    }));
    scope.add(listen<{ runId: string; message: string }>("agent-observer-error", ({ payload }) => {
      notify(payload.message, { tone: "error" });
    }));
    return scope.dispose;
  }, []);
  return null;
}
