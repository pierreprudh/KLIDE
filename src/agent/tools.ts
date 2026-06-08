import { invoke } from "@tauri-apps/api/core";
import type { AgentMode } from "./types";

export type AgentToolCall = { id?: string; name: string; args: any };

// The Rust tool registry is the source of truth. The frontend fetches
// tool schemas over IPC so there is only one copy of each tool's name,
// description, and shape — no drift between TS and Rust schemas.

let cachedTools: Record<string, any[] | undefined> = {};
let cachedAllTools: any[] | undefined;

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

// The full set of tools a skill could ever allow — fetched from the
// Rust registry in "goal" mode (which returns every built-in tool,
// including the write tools). Used by the SkillsModal's "Tools & MCP"
// tab so the list stays in sync with the agent harness.
export async function listAllTools(): Promise<any[]> {
    if (cachedAllTools) return cachedAllTools;
    try {
        const tools = await invoke<any[]>("ai_list_tools", { mode: "goal" });
        cachedAllTools = tools;
        return tools;
    } catch {
        return [];
    }
}

export function clearToolCache() {
    cachedTools = {};
    cachedAllTools = undefined;
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
