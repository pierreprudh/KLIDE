import { useSyncExternalStore } from "react";

export type LlamaSetupMode = "klide" | "app";
const KEY = "klide.llamaSetupMode";
const EVENT = "klide:llama-setup-changed";
let current: LlamaSetupMode | undefined;
export function readLlamaSetupMode(): LlamaSetupMode {
  if (current) return current;
  try { return localStorage.getItem(KEY) === "app" ? "app" : "klide"; }
  catch { return "klide"; }
}
export function setLlamaSetupMode(mode: LlamaSetupMode) {
  current = mode;
  try { localStorage.setItem(KEY, mode); } catch { /* Session preference still works. */ }
  window.dispatchEvent(new Event(EVENT));
}
function subscribe(change: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) { current = undefined; change(); }
  };
  window.addEventListener(EVENT, change);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(EVENT, change);
    window.removeEventListener("storage", storage);
  };
}
export function useLlamaSetupMode() {
  return useSyncExternalStore(subscribe, readLlamaSetupMode, () => "klide" as const);
}
export function isSelectedLlamaProvider(id: string, mode: LlamaSetupMode) {
  return id !== (mode === "app" ? "llamacpp" : "llamaapp");
}
