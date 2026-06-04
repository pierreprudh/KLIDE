import { invoke } from "@tauri-apps/api/core";
import type { AgentMode } from "./types";

export type AgentToolCall = { id?: string; name: string; args: any };

// The Rust tool registry is the source of truth. The frontend fetches
// tool schemas over IPC so there is only one copy of each tool's name,
// description, and shape — no drift between TS and Rust schemas.

let cachedTools: Record<string, any[] | undefined> = {};

export async function toolsForMode(mode: AgentMode): Promise<any[] | undefined> {
    if (mode === "chat") return undefined;
    const key = mode;
    if (cachedTools[key]) return cachedTools[key];
    try {
        const tools = await invoke<any[]>("ai_list_tools", { mode });
        cachedTools[key] = tools.length > 0 ? tools : undefined;
        return cachedTools[key];
    } catch {
        return undefined;
    }
}

export function clearToolCache() {
    cachedTools = {};
}

export function parseToolCallsFromChunk(raw: any): AgentToolCall[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((tc): AgentToolCall | null => {
            const fn = tc.function ?? tc;
            const name = fn?.name;
            const id = typeof tc.id === "string" ? tc.id : undefined;
            let args = fn?.arguments;
            if (typeof args === "string") {
                try { args = JSON.parse(args); } catch { args = { _raw: args }; }
            }
            return name ? { id, name, args: args ?? {} } : null;
        })
        .filter((x): x is AgentToolCall => x !== null);
}
