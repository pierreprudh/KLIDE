// usage_snapshot / delegate_logout — how much of each subscription CLI's
// allowance is spent (src-tauri/src/usage.rs), and signing one out.
import { invoke } from "@tauri-apps/api/core";

export type UsageWindow = {
  /** "Session" (5 h), "Weekly", "Reserve". */
  label: string;
  /** 0–100. */
  percent: number;
  resetsAtMs: number | null;
  /** When the reading was taken, when it is not live (Codex: its last run). */
  seenAtMs: number | null;
};

export type ToolUsage = {
  provider: "claude-code" | "codex" | "opencode";
  plan: string | null;
  windows: UsageWindow[];
  spend: { costUsd: number; tokens: number; sinceMs: number } | null;
  error: string | null;
};

export function usageSnapshot(): Promise<ToolUsage[]> {
  return invoke<ToolUsage[]>("usage_snapshot");
}

export function delegateLogout(provider: string): Promise<void> {
  return invoke("delegate_logout", { provider });
}

/** "Resets 17:30" within a day, "Resets Mon 17:30" beyond. */
export function resetLabel(window: UsageWindow, now = Date.now()): string {
  if (window.resetsAtMs === null) {
    return window.seenAtMs !== null && window.percent === 0 ? "Reset since last run" : "";
  }
  if (window.resetsAtMs <= now) return "Resetting…";
  return `Resets ${clock(window.resetsAtMs, now)}`;
}

/** The same, short enough for the menu's column: "17:30", "Mon 17:30", "reset". */
export function resetShort(window: UsageWindow, now = Date.now()): string {
  if (window.resetsAtMs === null) {
    return window.seenAtMs !== null && window.percent === 0 ? "reset" : "";
  }
  if (window.resetsAtMs <= now) return "now";
  return clock(window.resetsAtMs, now);
}

function clock(ms: number, now: number): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return Math.abs(ms - now) < 86_400_000
    ? time
    : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** 4.0M, 812K, 90. */
export function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

/** The severity a bar is drawn in: calm, then warning at 70, danger at 90. */
export function usageTone(percent: number): "calm" | "warning" | "danger" {
  return percent >= 90 ? "danger" : percent >= 70 ? "warning" : "calm";
}
